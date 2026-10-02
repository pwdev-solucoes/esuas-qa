/**
 * E20 — Verificações finais, snapshot e índice (#10994 · roadmap 08/E20, plano 06).
 *
 * 20.1 CA11  CPFs das pessoas (famílias da demo) e dos usuários da demo: base 98, DV válido, iguais aos do
 *            elenco (banco, SQL somente leitura; profissionais também pela API).
 * 20.2 CA12  isolamento nos dois sentidos: P1 → família, unidade e entidade de OUTRA organização = 404;
 *            usuário da outra organização → família, unidade e entidade da demo = 404. O seed só cria
 *            organizações com Master e sem unidade, entidade ou família; por isso a etapa cria a
 *            "Organização Controle SigSUAS" pelo fluxo real (Administrador → Master → Operacional, API e
 *            e-mail do Mailpit), com uma unidade, uma entidade e uma família. Idempotente por chave.
 * 20.3 CA03  nenhuma rota, menu ou permissão de gerar massa: routers e sidebar-menu do admin e do client
 *            (só literais, sem comentários), `php artisan route:list --json` e `permissions` (SQL).
 * 20.4 CA09  reconferência: P2 abre F-ENC e o desfecho continua vazio.
 * 20.5 RN02b organização, CNPJ, e-mails e CPFs identificáveis.
 * 20.6       snapshot.json por chave de negócio + apuração completa (CA04, comparado por `massa:comparar`).
 * Com `--evidencias`: prévia do índice com as seções do CA13 conferidas, e o print do CA09.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { finalizarRelatorio } from '../bin/massa.ts';
import { executorPadrao, PASTA_CACHE, RAIZ_QA } from '../lib/config.ts';
import type { Esperado } from '../lib/esperado.ts';
import { Evidencia, pastaRelatorioAtiva } from '../lib/evidencia.ts';
import { lerEstado } from '../lib/execucao.ts';
import { ClientePapel, type Papel } from '../lib/http.ts';
import { buscarLinkRedefinicao } from '../lib/mailpit.ts';
import {
  aceitarPendentes,
  comRetentativa429,
  dados,
  etapa,
  idDoCbo,
  idDoLookup,
  lerInsumo,
  listarTudo,
  redefinirPeloLink,
  resolverEnderecoDne,
  senhaMassa,
  statusDaFalha,
  type ContextoEtapa,
} from '../lib/papeis.ts';
import { coletarSnapshot } from '../lib/snapshot.ts';
import { consultar, escalar, SQL } from '../lib/verificacoes-sql.ts';
import { cnpj as gerarCnpj, cpfSequencial, cpfValido } from '../scripts/lib/cpf.ts';

// ── Organização Controle (CA12) — fora da sequência do elenco e das faixas de benefício ────────
const CTRL = {
  cnpj: gerarCnpj('980000000900'),
  nome: 'Organização Controle SigSUAS',
  master: { cpf: cpfSequencial(8_000_001), email: 'master@controle.sigsuas.local', nome: 'Master Controle Fictício' },
  operador: { cpf: cpfSequencial(8_000_002), email: 'operador@controle.sigsuas.local', nome: 'Operador Controle Fictício' },
  pessoa: { cpf: cpfSequencial(8_000_003), nome: 'Responsável Controle Fictício', nascimento: '1985-04-10', mae: 'Mãe Controle Fictícia' },
  unidade: { mds: '2700300980900', nome: 'CRAS Controle SigSUAS' },
  entidade: { cnpj: gerarCnpj('980000000901'), cneas: '9800000009001', nome: 'Entidade Controle SigSUAS' },
};

/** Termos proibidos (CA03): ação de gerar massa pelo sistema. */
const TERMO_CA03 = /\b(massa|seed|seeder|seeders|gerar[- ]dados|demo)\b/i;

/** Status HTTP de um GET (sem lançar em 4xx). */
async function statusGet(cliente: ClientePapel, uri: string): Promise<number> {
  return (await respostaGet(cliente, uri)).status;
}

/** Status e corpo (sanitizado, truncado) de um GET, sem lançar em 4xx. */
async function respostaGet(cliente: ClientePapel, uri: string): Promise<{ status: number; corpo: string }> {
  try {
    const r = await cliente.get(uri);
    return { status: r.status, corpo: JSON.stringify(r.corpo) };
  } catch (erro) {
    const s = statusDaFalha(erro);
    if (s === null) throw erro;
    return { status: s, corpo: (erro as Error).message };
  }
}

/**
 * CA12: 404 é o esperado. 403 também nega o acesso (nenhum dado volta), mas revela que o uuid existe —
 * vira achado (CA12 parcial), nunca é escondido. Qualquer outra resposta (200!) é falha.
 */
function avaliarIsolamento(r: { status: number; corpo: string }, nomesProibidos: string[]): { negado: boolean; vazou: boolean } {
  const vazou = nomesProibidos.some((n) => r.corpo.includes(n));
  return { negado: (r.status === 404 || r.status === 403) && !vazou, vazou };
}

const q1 = (ctx: ContextoEtapa, sql: string) => escalar(ctx.cfg, sql);

/** Autentica um usuário da organização Controle (guard client), registrando os passos na etapa. */
async function entrarControle(ctx: ContextoEtapa, nome: string, cpf: string, tenantUuid: string): Promise<ClientePapel> {
  const papel: Papel = { nome, guard: 'client', cpf, senha: senhaMassa(ctx.cfg), tenantUuid };
  return comRetentativa429(ctx, () => ClientePapel.autenticar(ctx.cfg, papel, { aoRegistrar: (p) => ctx.registro.passo({ ...p, chave: nome }) }));
}

/** Define a senha pelo link do e-mail de criação (A6/RN-T7), igual ao primeiro acesso da massa. */
async function senhaPeloEmail(ctx: ContextoEtapa, email: string, desde: Date): Promise<void> {
  const link = await buscarLinkRedefinicao(ctx.cfg.mailpitUrl, email, { desde, timeoutMs: 120_000 });
  const ok = await redefinirPeloLink(ctx.cfg, 'client', link, senhaMassa(ctx.cfg));
  expect(ok, `senha de ${email} definida pelo link do e-mail`).toBe(true);
}

interface Controle {
  tenantUuid: string;
  unidade: string;
  entidade: string;
  familia: string;
  operador: ClientePapel;
  criada: boolean;
}

/** Garante a Organização Controle com unidade, entidade e família (fluxo real, idempotente). */
async function organizacaoControle(ctx: ContextoEtapa): Promise<Controle> {
  const org = ctx.elenco.organizacao;
  const admin = await ctx.sessoes.entrar('admin');
  const tenantDe = () => consultar(ctx.cfg, `SELECT id, uuid FROM tenants WHERE cnpj = '${CTRL.cnpj}'`)[0];
  let criada = false;
  let t = tenantDe();
  if (!t) {
    criada = true;
    const status = dados<Array<{ id: number; code: string }>>((await admin.get('/api/tenant-statuses')).corpo).find((s) => s.code === '001');
    await admin.post('/api/tenants', { legal_name: CTRL.nome, trade_name: 'Controle SigSUAS', cnpj: CTRL.cnpj, email: 'contato@controle.sigsuas.local', phone: '82980009000', timezone: 'America/Maceio', status_id: status!.id });
    t = tenantDe();
    const endereco = await resolverEnderecoDne(admin, { ibge: org.ibge, uf: org.uf, municipio: org.municipio, bairro: 'Centro', numero: '9000' });
    await admin.put(`/api/tenants/${t![1]}/official-address`, { ...endereco.payload, geometry: { latitude: -9.7521485, longitude: -36.6619307, source: 'massa-dados' } });
  }
  const [tenantId, tenantUuid] = t! as [string, string];
  ctx.registro.passo({ passo: '20.2 organização Controle', criada, cnpj: CTRL.cnpj });

  // Master
  if (q1(ctx, `SELECT count(*) FROM users WHERE cpf = '${CTRL.master.cpf}'`) === '0') {
    const desde = new Date();
    const user = dados<{ id: number; uuid: string }>(
      (await admin.post('/api/users', { full_name: CTRL.master.nome, email: CTRL.master.email, cpf: CTRL.master.cpf, birth_date: '1979-02-11', type: 'client', tenant_id: Number(tenantId) })).corpo,
    );
    const master = (await listarTudo<{ id: number; name: string; guard_name: string }>(admin, '/api/roles')).find((r) => r.name === 'master' && r.guard_name === 'client');
    const vinculos = dados<Array<{ tenant_id?: number; role?: { name?: string } }>>((await admin.get(`/api/users/${user.uuid}/tenant-roles`)).corpo);
    if (!vinculos.some((v) => v.tenant_id === Number(tenantId) && v.role?.name === 'master')) await admin.post(`/api/users/${user.uuid}/tenant-roles`, { tenant_id: Number(tenantId), user_id: user.id, role_id: master!.id });
    await senhaPeloEmail(ctx, CTRL.master.email, desde);
  }
  const master = await entrarControle(ctx, 'CTRL-M0', CTRL.master.cpf, tenantUuid);
  await aceitarPendentes(master);

  // Operacional (primeiro sem lotação: cadastra unidade, entidade e pessoa, como o P0 da demo)
  const cboOperador = ctx.elenco.profissionais.find((p) => p.chave === 'P1')!.cbo;
  const cboId = await idDoCbo(master, cboOperador);
  let profUuid = q1(ctx, `SELECT tp.uuid FROM tenant_professionals tp JOIN users u ON u.id = tp.user_id WHERE u.cpf = '${CTRL.operador.cpf}' AND tp.tenant_id = ${tenantId}`);
  if (!profUuid) {
    const endereco = await resolverEnderecoDne(master, { ibge: org.ibge, uf: org.uf, municipio: org.municipio, bairro: 'Centro', numero: '9001' });
    const address = dados<{ id: number }>((await master.post('/api/client/addresses', endereco.payload)).corpo);
    const desde = new Date();
    profUuid = dados<{ uuid: string }>(
      (
        await master.post('/api/client/professionals', {
          cpf: CTRL.operador.cpf,
          full_name: CTRL.operador.nome,
          birth_date: '1988-06-20',
          email: CTRL.operador.email,
          phone: '82980009001',
          address_id: address.id,
          registration_number: '9809001',
          role: 'operador',
          cbo_id: cboId,
        })
      ).corpo,
    ).uuid;
    await senhaPeloEmail(ctx, CTRL.operador.email, desde);
  }
  let operador = await entrarControle(ctx, 'CTRL-OP', CTRL.operador.cpf, tenantUuid);
  await aceitarPendentes(operador);

  // Unidade
  let unidade = q1(ctx, `SELECT uuid FROM social_units WHERE mds_number = '${CTRL.unidade.mds}' AND tenant_id = ${tenantId}`);
  if (!unidade) {
    const endereco = await resolverEnderecoDne(operador, { ibge: org.ibge, uf: org.uf, municipio: org.municipio, bairro: 'Centro', numero: '9002' });
    const address = dados<{ id: number }>((await operador.post('/api/client/addresses', { ...endereco.payload, geometry: { latitude: -9.7525, longitude: -36.662, source: 'massa-dados' } })).corpo);
    unidade = dados<{ uuid: string }>(
      (
        await operador.post('/api/client/social-units', {
          mds_number: CTRL.unidade.mds,
          name: CTRL.unidade.nome,
          type_id: await idDoLookup(operador, '/api/relationals/social-unit-types', 'Centro de Referência de Assistência Social', 'name'),
          status_id: await idDoLookup(operador, '/api/relationals/social-unit-statuses', '001'),
          location_type_id: await idDoLookup(operador, '/api/relationals/location-types', '001'),
          email: 'cras@controle.sigsuas.local',
          phone: '82980009002',
          address_id: address.id,
          activity_start_date: '2020-01-01',
        })
      ).corpo,
    ).uuid;
  }
  const unidadeId = q1(ctx, `SELECT id FROM social_units WHERE uuid = '${unidade}'`);

  // Entidade
  let entidade = q1(ctx, `SELECT uuid FROM social_entities WHERE cnpj = '${CTRL.entidade.cnpj}' AND tenant_id = ${tenantId}`);
  if (!entidade) {
    const endereco = await resolverEnderecoDne(operador, { ibge: org.ibge, uf: org.uf, municipio: org.municipio, bairro: 'Centro', numero: '9003' });
    entidade = dados<{ uuid: string }>(
      (
        await operador.post('/api/client/social-entities', {
          legal_name: CTRL.entidade.nome,
          cnpj: CTRL.entidade.cnpj,
          head_office_cnpj: CTRL.entidade.cnpj,
          cneas_number: CTRL.entidade.cneas,
          email: 'entidade@controle.sigsuas.local',
          address: endereco.payload,
          foundation_date: '2012-05-01',
          social_entity_status_id: await idDoLookup(operador, '/api/relationals/social-entity-statuses', '001'),
          location_type_id: await idDoLookup(operador, '/api/relationals/location-types', '001'),
          suas_participation_type_id: await idDoLookup(operador, '/api/relationals/suas-participation-types', '002'),
          contract_modality_id: await idDoLookup(operador, '/api/relationals/contract-modalities', '003'),
          has_public_partnership: true,
          provides_emergency_benefits: false,
          executes_services: true,
          executed_services_description: 'Entidade fictícia de controle do isolamento (CA12).',
          has_active_service_agreement: true,
          contract_amount: 1000,
        })
      ).corpo,
    ).uuid;
  }

  // Pessoa (repositório global) e família na unidade de controle: lotação + family_viewer antes.
  let pessoa = q1(ctx, `SELECT uuid FROM persons WHERE cpf = '${CTRL.pessoa.cpf}'`);
  if (!pessoa) {
    const sexo = await idDoLookup(operador, '/api/relationals/sexes', '001');
    pessoa = dados<{ uuid: string }>(
      (await comRetentativa429(ctx, () => operador.post('/api/client/persons', { full_name: CTRL.pessoa.nome, birth_date: CTRL.pessoa.nascimento, mother_name: CTRL.pessoa.mae, sex_id: sexo, cpf: CTRL.pessoa.cpf }))).corpo,
    ).uuid;
  }
  let familia = q1(ctx, `SELECT f.uuid FROM families f JOIN persons p ON p.id = f.responsible_person_id WHERE p.cpf = '${CTRL.pessoa.cpf}' AND f.tenant_id = ${tenantId} AND f.deleted_at IS NULL`);
  if (!familia) {
    const lotado = q1(ctx, `SELECT count(*) FROM social_tenant_professional_assignments a JOIN tenant_professionals tp ON tp.id = a.tenant_professional_id WHERE tp.uuid = '${profUuid}'`);
    if (lotado === '0') await master.post(`/api/client/professionals/${profUuid}/units`, { social_unit_id: Number(unidadeId), cbo_id: cboId, start_date: '2026-05-01' });
    const papeis = new Map((await listarTudo<{ id: number; name: string }>(master, '/api/client/roles')).map((r) => [r.name, r.id]));
    await master.put(`/api/client/professionals/${profUuid}/roles`, { role_ids: [papeis.get('operador'), papeis.get('family_viewer')] });
    await operador.encerrar();
    operador = await entrarControle(ctx, 'CTRL-OP', CTRL.operador.cpf, tenantUuid);
    familia = dados<{ uuid: string }>((await operador.post('/api/client/families', { responsible_person_uuid: pessoa, social_unit_id: Number(unidadeId), referenced_at: '2026-06-01' })).corpo).uuid;
  }
  await master.encerrar();
  ctx.registro.passo({ passo: '20.2 dados da organização Controle', unidade: CTRL.unidade.mds, entidade: CTRL.entidade.cnpj, familia_criada: Boolean(familia) });
  return { tenantUuid, unidade: unidade!, entidade: entidade!, familia: familia!, operador, criada };
}

/** Literais de string de um arquivo TS, sem comentários. */
export function literais(fonte: string): string[] {
  const semComentario = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return [...semComentario.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0].slice(1, -1));
}

etapa('E20', 'Verificações finais, snapshot e índice', 'M0, P1, P2, P4, admin', async (ctx) => {
  const falhas: string[] = [];
  const ev = new Evidencia('E20');
  const verificar = (ok: boolean, texto: string, dado: Record<string, unknown> = {}) => {
    ctx.registro.passo({ passo: texto, ok, ...dado });
    if (!ok) falhas.push(`${texto}: ${JSON.stringify(dado)}`);
  };
  const org = ctx.elenco.organizacao;
  const cnpj = org.cnpj.replace(/\D/g, '');
  const T = `(SELECT id FROM tenants WHERE cnpj = '${cnpj}')`;
  const esperado = lerInsumo<Esperado>('esperado.json');

  // ── 20.1 CA11 ─────────────────────────────────────────────────────────────────────────
  const familiasCriadas = new Set(ctx.elenco.familias.filter((f) => lerEstado(ctx.caminho).estado.chaves[`FAM_${f.chave}`]).map((f) => f.chave));
  const pessoasEsperadas = ctx.elenco.pessoas.filter((p) => familiasCriadas.has(p.familia_chave));
  const cpfsPessoas = consultar(ctx.cfg, SQL.cpfsDasFamilias(cnpj)).map((r) => r[0] as string);
  const comCpf = cpfsPessoas.filter((c) => c !== '<null>');
  const semCpf = cpfsPessoas.length - comCpf.length;
  const cpfsElencoPessoas = new Set(pessoasEsperadas.filter((p) => p.cpf).map((p) => p.cpf as string));
  const cpfsUsuarios = consultar(ctx.cfg, `SELECT DISTINCT u.cpf FROM users u JOIN user_tenant_role utr ON utr.user_id = u.id AND utr.deleted_at IS NULL WHERE utr.tenant_id = ${T} ORDER BY 1`).map((r) => r[0] as string);
  const cpfsElencoUsuarios = new Set([org.master.cpf, ...ctx.elenco.profissionais.map((p) => p.cpf)]);
  const todos = [...comCpf, ...cpfsUsuarios];
  const invalidos = todos.filter((c) => !c.startsWith('98') || !cpfValido(c));
  const foraDoElencoP = comCpf.filter((c) => !cpfsElencoPessoas.has(c));
  const faltandoP = [...cpfsElencoPessoas].filter((c) => !comCpf.includes(c));
  const foraDoElencoU = cpfsUsuarios.filter((c) => !cpfsElencoUsuarios.has(c));
  const faltandoU = [...cpfsElencoUsuarios].filter((c) => !cpfsUsuarios.includes(c));
  const vazios = Number(escalar(ctx.cfg, SQL.cpfVazio(cnpj)));
  const semCpfEsperado = pessoasEsperadas.filter((p) => !p.cpf).length;
  verificar(invalidos.length === 0, 'CA11 todos os CPFs (pessoas e usuários da demo) na base 98 com DV válido', { verificados: todos.length, invalidos: invalidos.length });
  verificar(foraDoElencoP.length === 0 && faltandoP.length === 0, 'CA11 CPFs das pessoas = CPFs do elenco (famílias criadas)', { banco: comCpf.length, elenco: cpfsElencoPessoas.size, fora_do_elenco: foraDoElencoP.length, faltando: faltandoP.length });
  verificar(foraDoElencoU.length === 0 && faltandoU.length === 0, 'CA11 CPFs dos usuários = Master + P0–P7 do elenco', { banco: cpfsUsuarios.length, elenco: cpfsElencoUsuarios.size });
  verificar(semCpf === semCpfEsperado && vazios === 0, 'CA11 pessoas sem CPF gravadas como NULL (nunca string vazia)', { sem_cpf: semCpf, esperado: semCpfEsperado, string_vazia: vazios });
  ev.contagem('CA11 · CPFs de pessoas conferidos (base 98, DV, elenco)', cpfsElencoPessoas.size, comCpf.length);
  ev.contagem('CA11 · CPFs de usuários da demo', cpfsElencoUsuarios.size, cpfsUsuarios.length);
  ev.contagem('CA11 · CPFs fora da base 98 ou com DV inválido', 0, invalidos.length);
  ev.contagem('CA11 · pessoas sem CPF (NULL)', semCpfEsperado, semCpf);
  if (ctx.elenco.familias.length > familiasCriadas.size) {
    ev.nota(`CA11: ${ctx.elenco.familias.length - familiasCriadas.size} família(s) do elenco não existem no banco (F-SEM-REF, recusa RN14 da E08); os CPFs das pessoas delas não entram na conferência das famílias.`);
  }
  // API: a lista de profissionais do Master tem os 8 profissionais do elenco.
  const master = await ctx.sessoes.entrar('M0');
  const profsApi = await listarTudo<Record<string, unknown>>(master, '/api/client/professionals');
  // A listagem mascara o CPF (`***.***.NNN-DD`, LGPD): confere os 5 últimos dígitos com o elenco.
  const cpfsApi = profsApi.map((p) => String(p.cpf ?? (p.user as Record<string, unknown> | undefined)?.cpf ?? '').replace(/\D/g, '')).filter(Boolean);
  const sufixosElenco = ctx.elenco.profissionais.map((p) => p.cpf.slice(-5)).sort();
  const sufixosApi = cpfsApi.map((c) => c.slice(-5)).sort();
  verificar(profsApi.length === ctx.elenco.profissionais.length, 'CA11 profissionais pela API (Master) = P0–P7', { api: profsApi.length, elenco: ctx.elenco.profissionais.length });
  verificar(JSON.stringify(sufixosApi) === JSON.stringify(sufixosElenco), 'CA11 CPFs (mascarados) da listagem de profissionais batem com a sequência do elenco', { comparados: sufixosApi.length, mascarado: cpfsApi.every((c) => c.length < 11) });

  // ── 20.5 RN02b ────────────────────────────────────────────────────────────────────────
  const [nomeOrg, cnpjOrg] = consultar(ctx.cfg, `SELECT legal_name, cnpj FROM tenants WHERE cnpj = '${cnpj}'`)[0] ?? [];
  const emailsFora = Number(escalar(ctx.cfg, SQL.emailsForaDoDominio(cnpj)));
  verificar(nomeOrg === org.razao_social && String(cnpjOrg).startsWith('98'), 'RN02b organização "Município Demonstração SigSUAS" com CNPJ da base 98', { nome: nomeOrg, cnpj: cnpjOrg });
  verificar(emailsFora === 0, 'RN02b e-mails dos usuários da demo em @demo.sigsuas.local', { fora_do_dominio: emailsFora });

  // ── 20.4 CA09 (reconferência) ─────────────────────────────────────────────────────────
  const fEnc = ctx.chaves.obter('FAM_F-ENC');
  const refUuid = ctx.chaves.obter('REG_ENC-2026-07-0004');
  const p2 = await ctx.sessoes.entrar('P2');
  const abreP2 = await statusGet(p2, `/api/client/families/${fEnc}/details`);
  const p4 = await ctx.sessoes.entrar('P4');
  const refs = dados<Array<Record<string, unknown>>>((await p4.get(`/api/client/families/${fEnc}/referrals?per_page=100`)).corpo);
  const ref = refs.find((r) => r.uuid === refUuid);
  const desfecho = ref?.outcome as { value?: string } | string | null | undefined;
  const desfechoValor = typeof desfecho === 'object' && desfecho !== null ? (desfecho.value ?? null) : (desfecho ?? null);
  const outcomeBanco = escalar(ctx.cfg, `SELECT coalesce(outcome, '<null>') FROM referrals WHERE uuid = '${refUuid}'`);
  verificar(abreP2 === 200, 'CA09 P2 (só CRAS Sul) abre o prontuário de F-ENC', { status: abreP2 });
  verificar(Boolean(ref) && [null, 'awaiting_return'].includes(desfechoValor) && ['<null>', 'awaiting_return'].includes(String(outcomeBanco)), 'CA09 desfecho do encaminhamento de F-ENC continua vazio', {
    listado: Boolean(ref),
    desfecho_api: desfechoValor,
    desfecho_banco: outcomeBanco,
  });
  ev.contagem('CA09 · P2 abre F-ENC (HTTP)', 200, abreP2);

  // ── 20.2 CA12 ─────────────────────────────────────────────────────────────────────────
  const ctrl = await organizacaoControle(ctx);
  ev.nota(`CA12: o seed (DatabaseSeeder) cria organizações só com Master, sem unidade, entidade ou família; a E20 ${ctrl.criada ? 'criou' : 'reaproveitou'} a "${CTRL.nome}" pelo fluxo real (Administrador → Master → Operacional), com uma unidade, uma entidade e uma família.`);
  const p1 = await ctx.sessoes.entrar('P1');
  const alvosCtrl: Array<[string, string]> = [
    ['família', `/api/client/families/${ctrl.familia}/details`],
    ['unidade', `/api/client/social-units/${ctrl.unidade}`],
    ['entidade', `/api/client/social-entities/${ctrl.entidade}`],
  ];
  const com403: string[] = [];
  const nomesCtrl = [CTRL.unidade.nome, CTRL.entidade.nome, CTRL.pessoa.nome, CTRL.nome];
  for (const [rotulo, uri] of alvosCtrl) {
    const r = await respostaGet(p1, uri);
    const a = avaliarIsolamento(r, nomesCtrl);
    verificar(a.negado, `CA12 P1 (demo) lê ${rotulo} da Organização Controle → acesso negado sem dado (esperado 404)`, { status: r.status, vazou_dado: a.vazou });
    if (r.status === 403) com403.push(`P1 → ${rotulo} da outra organização`);
    ev.contagem(`CA12 · P1 → ${rotulo} da outra organização (HTTP)`, 404, r.status);
  }
  // Controle de sanidade: o próprio operador da Controle lê os dados dele (200) — o 404 não é rota inexistente.
  for (const [rotulo, uri] of alvosCtrl) {
    const s = await statusGet(ctrl.operador, uri);
    verificar(s === 200, `CA12 controle: operador da Controle lê a própria ${rotulo} → 200`, { status: s });
  }
  const alvosDemo: Array<[string, string]> = [
    ['família', `/api/client/families/${ctx.chaves.obter('FAM_F-ENC')}/details`],
    ['unidade', `/api/client/social-units/${ctx.chaves.obter('UNIT_U-CN')}`],
    ['entidade', `/api/client/social-entities/${ctx.chaves.obter('ENT_ENT-1')}`],
  ];
  const nomesDemo = ['CRAS Demonstração Norte', ctx.elenco.organizacao.razao_social, 'Associação Demonstração Amparo'];
  for (const [rotulo, uri] of alvosDemo) {
    const r = await respostaGet(ctrl.operador, uri);
    const a = avaliarIsolamento(r, nomesDemo);
    verificar(a.negado, `CA12 operador da Controle lê ${rotulo} da demo → acesso negado sem dado (esperado 404)`, { status: r.status, vazou_dado: a.vazou });
    if (r.status === 403) com403.push(`outra organização → ${rotulo} da demo`);
    ev.contagem(`CA12 · outra organização → ${rotulo} da demo (HTTP)`, 404, r.status);
  }
  if (com403.length) {
    ctx.achado(
      `E20/CA12: ${com403.join('; ')} respondem 403 e não 404. O acesso é negado e nenhum dado da outra organização volta, mas a resposta revela que o uuid existe; o CA12 pede 404. A família responde 404 nos dois sentidos. Causa provável: a policy de unidade/entidade (user->tenants contém o tenant do modelo) decide antes do escopo de tenant — decisão do produto, não contornada.`,
    );
  }
  await ctrl.operador.encerrar();
  verificar(Number(escalar(ctx.cfg, SQL.familiasComUnidadeDeOutroTenant(cnpj))) === 0, 'CA12 famílias da demo com unidade de outra organização = 0 (SQL)');
  verificar(Number(escalar(ctx.cfg, SQL.lotacoesEmOutroTenant(cnpj))) === 0, 'CA12 lotações da demo em unidade de outra organização = 0 (SQL)');

  // ── 20.3 CA03 ─────────────────────────────────────────────────────────────────────────
  const raizMeta = resolve(RAIZ_QA, '..');
  const arquivosFront = ['admin/src/router/index.ts', 'client/src/router/index.ts', 'admin/src/components/app/sidebar-menu.ts', 'client/src/components/app/sidebar-menu.ts'];
  const ocorrenciasFront: string[] = [];
  for (const rel of arquivosFront) {
    const caminho = resolve(raizMeta, rel);
    if (!existsSync(caminho)) {
      verificar(false, `CA03 arquivo do front disponível para a varredura: ${rel}`);
      continue;
    }
    const achados = literais(readFileSync(caminho, 'utf8')).filter((l) => TERMO_CA03.test(l));
    ocorrenciasFront.push(...achados.map((a) => `${rel}: "${a}"`));
    ctx.registro.passo({ passo: `CA03 varredura ${rel}`, literais_com_termo: achados.length });
  }
  verificar(ocorrenciasFront.length === 0, 'CA03 menus e rotas do admin e do client sem ação de gerar massa', { ocorrencias: ocorrenciasFront });
  const containerApi = /docker\s+exec\s+(?:-\S+\s+)*([\w.-]+)/.exec(ctx.cfg.cacheClearCmd)?.[1];
  expect(containerApi, 'container da API derivado de MASSA_CACHE_CLEAR_CMD').toBeTruthy();
  const rl = executorPadrao.programa('docker', ['exec', containerApi!, 'php', 'artisan', 'route:list', '--json'], { timeoutMs: 180_000 });
  expect(rl.codigo, 'php artisan route:list --json').toBe(0);
  const rotas = JSON.parse(rl.saida.slice(rl.saida.indexOf('['))) as Array<{ method: string; uri: string; name: string | null; action: string }>;
  const rotasComTermo = rotas.filter((r) => TERMO_CA03.test(r.uri.replace(/[/_{}-]/g, ' ')) || TERMO_CA03.test(r.name ?? '') || /massa|seeder|gerardados|demodata/i.test(r.action.replace(/\W/g, '')));
  const ambiente = rotas.filter((r) => r.uri === 'api/environment');
  verificar(rotasComTermo.length === 0, 'CA03 route:list sem rota de gerar massa', { rotas: rotas.length, com_termo: rotasComTermo.map((r) => `${r.method} ${r.uri}`) });
  verificar(ambiente.length === 1 && /^GET/.test(ambiente[0]!.method), 'CA03 GET /api/environment é a rota da trava (só informa; nenhum outro verbo)', { rotas: ambiente.map((r) => `${r.method} ${r.uri}`) });
  const permissoes = consultar(ctx.cfg, `SELECT name FROM permissions WHERE name ~* '(massa|seed|gerar-dados|demo)' ORDER BY name`).map((r) => r[0]);
  verificar(permissoes.length === 0, 'CA03 nenhuma permissão de gerar massa (tabela permissions)', { permissoes });
  ev.contagem('CA03 · rotas da API com termo de gerar massa', 0, rotasComTermo.length);
  ev.contagem('CA03 · literais de menu/rota do admin e do client com o termo', 0, ocorrenciasFront.length);
  ev.contagem('CA03 · permissões com o termo', 0, permissoes.length);
  ev.nota('CA03: as únicas mudanças no produto ligadas à massa são GET /api/environment (informativa, sem autenticação) e o bloco "Pendências de cadastro" da apuração (10994b, somente leitura).');

  // ── 20.6 snapshot ─────────────────────────────────────────────────────────────────────
  const snapshot = await coletarSnapshot(ctx, esperado.meses);
  const pasta = pastaRelatorioAtiva();
  const { estado } = lerEstado(ctx.caminho);
  const destino = pasta ? resolve(pasta, 'snapshot.json') : resolve(PASTA_CACHE, 'snapshots', estado.id, 'snapshot.json');
  mkdirSync(resolve(destino, '..'), { recursive: true });
  writeFileSync(destino, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const totais = Object.fromEntries(Object.entries(snapshot.tabelas).map(([k, v]) => [k, v.length]));
  ctx.registro.passo({ passo: '20.6 snapshot', arquivo: destino.replace(`${RAIZ_QA}/`, ''), tabelas: totais, valores_apuracao: Object.keys(snapshot.apuracao).length, pendencias: snapshot.pendencias.length });
  verificar(Object.keys(snapshot.apuracao).length > 0 && (totais.familias ?? 0) > 0, 'snapshot com famílias e apuração', { familias: totais.familias, apuracao: Object.keys(snapshot.apuracao).length });
  for (const [t, n] of Object.entries(totais)) ev.contagem(`snapshot · ${t}`, null, n);

  // ── CA13: prévia do índice (a versão final é gerada pelo CLI depois da E20) + print do CA09 ──
  if (pasta) {
    await ev.print({
      cfg: ctx.cfg,
      cpf: ctx.elenco.profissionais.find((p) => p.chave === 'P2')!.cpf,
      senha: senhaMassa(ctx.cfg),
      rota: `/app/cadastros/familias/${fEnc}`,
      nome: 'e20-01-ca09-p2-abre-f-enc',
      legenda: 'P2 (lotada só no CRAS Sul) abre o prontuário de F-ENC pelo encaminhamento de trânsito interno sem desfecho.',
      ca: 'CA09',
    });
    ev.salvar();
    const indice = readFileSync(finalizarRelatorio(pasta, lerEstado(ctx.caminho).estado, { verificar: false, evidencias: true, confirmarApagamento: true, ate: null }, 0), 'utf8');
    const secoes: Array<[string, string]> = [
      ['composição', 'CRAS Demonstração Norte'],
      ['famílias-cenário', 'F-ENC'],
      ['cenários que parecem erro', 'Zero declarado'],
      ['pendências propositais', 'entity_without_cneas'],
      ['esperado por mês × unidade', 'total_attendances'],
      ['matriz CA01–CA13', 'CA13'],
      ['achados A1–A8', 'A8'],
    ];
    const ausentes = secoes.filter(([, marca]) => !indice.includes(marca)).map(([s]) => s);
    verificar(ausentes.length === 0, 'CA13 índice com composição, cenários, pendências propositais, esperado por mês × unidade, CAs e achados', { ausentes });
  } else {
    ev.nota('Execução sem --evidencias: snapshot gravado em .cache/snapshots; índice e prints não gerados (RN-T5).');
  }
  ev.salvar();

  if (falhas.length) throw new Error(`E20: ${falhas.length} verificação(ões) falharam:\n${falhas.join('\n')}`);
});
