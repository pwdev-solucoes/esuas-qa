/**
 * E18 — Conferência prévia e geração da remessa SIAP (#10994 · roadmap 07/E18, BR-012, BR-013, RN-T8, P6).
 * Papel: Master (confere e gera).
 *
 * 18.1 conferência prévia do mês de referência (2026-08): registra as pendências apontadas.
 *      Esperada: `record_incomplete`/`NumeroCNEAS` de ENT-2 — ENT-2 não existe (achado RN14 da E05),
 *      então a ausência só é aceita com esse achado registrado.
 * 18.1b pendências bloqueantes de CADASTRO da própria massa (CEP de unidade/entidade, matrícula
 *      numérica do profissional) são resolvidas pelo caminho do técnico: edição do endereço (CEP do
 *      logradouro no DNE, confirmado pela busca de CEP da API) e da matrícula. Cada correção é
 *      registrada como achado; qualquer outra pendência bloqueante falha a etapa.
 * 18.2 nova conferência → `can_generate`.
 * 18.3/18.4 geração (fila) e download do arquivo (nome e tamanho). Os leiautes 15.6–15.11 são
 *      `HeaderOnlyLayout`: os números se conferem na apuração (E17).
 * Modo `seed` (plano 10, `massa:conferir`; advice opção A): a ENT-2 sem CNEAS EXISTE e sua NumeroCNEAS é
 *      bloqueante. 18.1 exige essa pendência (pela chave ENT_ENT-2), 18.1b corrige CEP/matrícula como no
 *      modo API, 18.2 exige que ela seja a ÚNICA bloqueante com `can_generate=false`, e 18.3/18.4 NÃO
 *      geram nem baixam a remessa (achado para o PO: pendência proposital × CNEAS bloqueante).
 * ⛔ A remessa gerada NÃO sai daqui para o TCE-AL: esta etapa não tem nenhuma chamada nesse sentido.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import type { ClientePapel } from '../lib/http.ts';
import { dados, etapa } from '../lib/papeis.ts';
import { aguardar } from '../lib/polling.ts';
import { lerEstado } from '../lib/execucao.ts';
import { avaliarBloqueantesSeed } from '../lib/esperado.ts';
import { consultar } from '../lib/verificacoes-sql.ts';

const EXERCICIO = 2026;
const MES = 8;

interface Pendencia {
  scope: string;
  kind: string;
  field_name: string | null;
  subject_type: string | null;
  subject_uuid: string | null;
  blocks_entire_remittance?: boolean;
}

interface PreCheck {
  blocking: { can_generate: boolean; pendencies: Pendencia[] };
  layouts: Array<{ name: string; outcome: string; pendencies: Pendencia[] }>;
  summary: Record<string, number>;
}

const resumo = (p: Pendencia) => `${p.kind}/${p.field_name ?? '-'}/${p.subject_type ?? '-'}`;

async function preCheck(master: ClientePapel): Promise<PreCheck> {
  return dados<PreCheck>((await master.get(`/api/client/siap-remittances/pre-check?exercise=${EXERCICIO}&reference_month=${MES}`)).corpo);
}

/** Download binário pelo mesmo contexto autenticado (o `ClientePapel` só lê JSON). */
async function baixar(cliente: ClientePapel, uri: string): Promise<{ status: number; bytes: number; nome: string | null }> {
  const interno = cliente as unknown as { ctx: APIRequestContext; apiBase: string; registrar(m: string, u: string, s: number, d: number): void };
  const inicio = Date.now();
  const headers: Record<string, string> = {};
  if (cliente.papel.tenantUuid) headers['X-Tenant-UUID'] = cliente.papel.tenantUuid;
  const r = await interno.ctx.fetch(`${interno.apiBase}${uri}`, { method: 'GET', headers });
  interno.registrar('GET', uri, r.status(), Date.now() - inicio);
  const corpo = await r.body();
  const disp = r.headers()['content-disposition'] ?? '';
  const nome = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp)?.[1] ?? null;
  return { status: r.status(), bytes: corpo.length, nome: nome ? decodeURIComponent(nome) : null };
}

etapa('E18', 'Conferência prévia e remessa SIAP (sem transmissão ao TCE-AL)', 'M0', async (ctx) => {
  const master = await ctx.sessoes.entrar('M0');

  // 18.1 — conferência prévia.
  const antes = await preCheck(master);
  const bloqueantes = antes.blocking.pendencies;
  const todas = [...bloqueantes, ...antes.layouts.flatMap((l) => l.pendencies ?? [])];
  ctx.registro.passo({ passo: '18.1 conferência prévia', can_generate: antes.blocking.can_generate, bloqueantes: bloqueantes.map(resumo), resumo: antes.summary });

  // Esperado: NumeroCNEAS de ENT-2.
  const cneas = todas.filter((p) => p.field_name === 'NumeroCNEAS');
  const modoSeed = lerEstado(ctx.caminho).estado.modo === 'seed';
  const ent2 = modoSeed ? ctx.chaves.obter('ENT_ENT-2') : null;
  if (modoSeed && !cneas.some((p) => p.subject_uuid === ent2)) throw new Error('E18 (modo seed): a conferência prévia não apontou NumeroCNEAS da ENT-2 (pendência proposital do CA07).');
  const ent2Recusada = lerEstado(ctx.caminho).estado.etapas.some((e) => e.etapa === 'E05' && e.avisos.some((a) => a.startsWith('ACHADO RN14') && a.includes('ENT-2')));
  if (cneas.length) ctx.registro.passo({ passo: '18.1 NumeroCNEAS apontado', itens: cneas.map(resumo) });
  else if (ent2Recusada) ctx.achado('E18: a conferência prévia não aponta NumeroCNEAS porque ENT-2 (sem CNEAS) foi recusada pela API na E05 — a pendência proposital não existe na massa.');
  else throw new Error('E18: a conferência prévia não apontou NumeroCNEAS e não há achado RN14 da E05 que explique.');

  // 18.1b — pendências bloqueantes de cadastro da própria massa.
  const corrigiveis = (p: Pendencia) =>
    p.kind === 'record_incomplete' &&
    ((p.field_name === 'CEP' && (p.subject_type === 'social_unit' || p.subject_type === 'social_entity')) || p.field_name === 'Matricula');
  const inesperadas = bloqueantes.filter((p) => !corrigiveis(p) && (modoSeed ? !(p.field_name === 'NumeroCNEAS' && p.subject_uuid === ent2) : p.field_name !== 'NumeroCNEAS'));
  expect(inesperadas.map(resumo), 'nenhuma pendência bloqueante inesperada na conferência prévia').toEqual([]);

  const corrigidos: string[] = [];
  for (const p of bloqueantes.filter((x) => x.field_name === 'CEP')) {
    const recurso = p.subject_type === 'social_unit' ? 'social-units' : 'social-entities';
    const alvo = dados<{ address: { id: number; uuid: string; street_id: number | null; postal_code: string | null } | null }>((await master.get(`/api/client/${recurso}/${p.subject_uuid}`)).corpo);
    const end = alvo.address;
    if (!end?.street_id) throw new Error(`E18: ${recurso} sem endereço com logradouro do DNE; CEP não pode ser resolvido.`);
    // CEP do logradouro no DNE importado (dado público de referência, leitura) confirmado pela busca de CEP da API.
    const cep = consultar(ctx.cfg, `SELECT cep FROM postal_codes WHERE street_id = ${Number(end.street_id)} AND is_active AND deleted_at IS NULL ORDER BY cep LIMIT 1`)[0]?.[0];
    if (!cep) throw new Error(`E18: logradouro ${end.street_id} sem CEP no DNE.`);
    const achado = dados<{ id: number; street?: { id: number } } | null>((await master.get(`/api/relationals/postal-codes?filter[cep]=${cep}`)).corpo);
    expect(achado?.street?.id, 'busca de CEP da API devolve o mesmo logradouro').toBe(end.street_id);
    await master.put(`/api/client/addresses/${end.uuid}`, { postal_code: cep, postal_code_id: achado?.id });
    corrigidos.push(`${p.subject_type}: CEP do logradouro (DNE)`);
  }
  if (bloqueantes.some((x) => x.field_name === 'Matricula')) {
    for (const prof of ctx.elenco.profissionais) {
      const matricula = `98${prof.cpf.slice(2, 9)}${prof.chave.replace(/\D/g, '')}`;
      await master.put(`/api/client/professionals/${ctx.chaves.obter(`PROF_${prof.chave}`)}`, { registration_number: matricula });
    }
    corrigidos.push('profissionais P0–P7: matrícula numérica (a E06 grava "DEMO-Pn", que não tem dígitos)');
  }
  if (corrigidos.length) {
    ctx.achado(`E18: pendências bloqueantes de cadastro da massa corrigidas pela API antes da remessa — ${corrigidos.join('; ')}. Sugestão (plano 06): gravar CEP e matrícula numérica já na E04–E06.`);
  }

  // 18.2 — nova conferência.
  const depois = await preCheck(master);
  ctx.registro.passo({ passo: '18.2 conferência prévia após correções', can_generate: depois.blocking.can_generate, bloqueantes: depois.blocking.pendencies.map(resumo), resumo: depois.summary });
  if (modoSeed) {
    const motivos = avaliarBloqueantesSeed(depois.blocking.pendencies, ent2!, depois.blocking.can_generate);
    if (motivos.length) throw new Error(`E18 (modo seed): ${motivos.join('; ')}`);
    ctx.registro.passo({
      passo: '18.3/18.4 remessa não gerável no modo seed: pendência proposital CNEAS da ENT-2 é bloqueante (CA07 × RN-T8)',
      can_generate: false,
      bloqueante_unica: 'record_incomplete/NumeroCNEAS/social_entity (ENT_ENT-2)',
      gerada: false,
    });
    ctx.achado(
      'E18 (modo seed): a pendência proposital do CA07 (ENT-2 sem CNEAS) é BLOQUEANTE na conferência prévia — com ela presente a remessa SIAP não pode ser gerada (can_generate=false). Decisão do PO: pendência proposital × CNEAS bloqueante. A remessa gerada e não enviada fica provada pela execução pela API.',
    );
    return;
  }
  expect(depois.blocking.pendencies.map(resumo), 'sem pendência bloqueante após as correções').toEqual([]);
  expect(depois.blocking.can_generate).toBe(true);

  // 18.3 — geração (fila) e espera.
  const criada = await master.post(`/api/client/siap-remittances`, { exercise: EXERCICIO, reference_month: MES });
  const remessa = dados<{ uuid: string; status: string }>(criada.corpo);
  for (const w of ((criada.corpo as { warnings?: unknown[] }).warnings ?? [])) ctx.registro.aviso(`E18: aviso da API na geração (não é erro): ${JSON.stringify(w)}`);
  const pronta = await aguardar(
    'remessa SIAP',
    async () => dados<{ status: string; file_name?: string | null; file_size?: number | null }>((await master.get(`/api/client/siap-remittances/${remessa.uuid}`)).corpo),
    (r) => (r.status === 'completed' ? 'pronto' : r.status === 'failed' ? { falha: 'status failed' } : 'aguardando'),
    { timeoutMs: 10 * 60_000 },
  );
  ctx.chaves.definir('SIAP_REMESSA', remessa.uuid);

  // 18.4 — download.
  const arquivo = await baixar(master, `/api/client/siap-remittances/${remessa.uuid}/download`);
  ctx.registro.passo({ passo: '18.3/18.4 remessa gerada e baixada (sem transmissão)', status: pronta.status, http: arquivo.status, arquivo: arquivo.nome, bytes: arquivo.bytes });
  expect(arquivo.status).toBe(200);
  expect(arquivo.bytes).toBeGreaterThan(0);
});
