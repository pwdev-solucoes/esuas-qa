/**
 * Asserções pós-etapas E1–E9 (#10994 · AC-001…AC-011 do plano 04).
 *
 * Roda depois de `npm run massa -- --ate=E09`, com `MASSA_EXECUCAO_ARQUIVO` apontando o estado (o project
 * `massa-dados` só é registrado com essa variável ou com `MASSA_VIA_CLI`; sem ela, cai na execução mais recente): só GET na API e SELECT no banco (`verificacoes-sql.ts`). Não grava nada.
 * Cenário do elenco que a API recusou (achado RN14 registrado pela etapa) vira anotação, não falha;
 * sem o achado registrado, a ausência é falha.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { carregarConfig, PASTA_CACHE, type ConfigMassa } from '../lib/config.ts';
import { lerEstado, MapaChaves, VARIAVEL_ESTADO, type EstadoExecucao } from '../lib/execucao.ts';
import { dados, lerElenco, listarTudo, senhaMassa, Sessoes, type Elenco } from '../lib/papeis.ts';
import { cpfValido } from '../scripts/lib/cpf.ts';
import { consultar, escalar, SQL } from '../lib/verificacoes-sql.ts';

function caminhoEstado(): string {
  const doAmbiente = process.env[VARIAVEL_ESTADO];
  if (doAmbiente) return doAmbiente;
  const pasta = resolve(PASTA_CACHE, 'execucoes');
  const arquivos = existsSync(pasta) ? readdirSync(pasta).filter((a) => a.endsWith('.json')) : [];
  const recente = arquivos.map((a) => resolve(pasta, a)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!recente) throw new Error('Nenhuma execução da massa encontrada: rode `npm run massa -- --ate=E09` antes.');
  return recente;
}

// Nada de I/O no carregamento do módulo (CR-004): estado, config e elenco só no `beforeAll`.
let caminho: string;
let cfg: ConfigMassa;
let elenco: Elenco;
let estado: EstadoExecucao;
let chaves: MapaChaves;
let sessoes: Sessoes;
const achados = (): string[] => estado.etapas.flatMap((e) => e.avisos.filter((a) => a.startsWith('ACHADO RN14')));
const temAchado = (trecho: string) => achados().some((a) => a.includes(trecho));
const obterOuNull = (k: string): string | null => estado.chaves[k] ?? null;

test.describe('E1–E9 — asserções pós-etapas', () => {
  test.beforeAll(() => {
    caminho = caminhoEstado();
    cfg = carregarConfig();
    elenco = lerElenco();
    estado = lerEstado(caminho).estado;
    chaves = new MapaChaves(caminho);
    sessoes = new Sessoes(cfg, elenco, chaves, () => undefined);
  });
  test.afterAll(async () => {
    await sessoes?.encerrar();
  });

  test('AC-012: E00…E09 concluídas em ordem, sem etapa em falha', () => {
    const ordem = ['E00', 'E0', 'E01', 'E01b', 'E01c', 'E02', 'E03', 'E06a', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09'];
    expect(estado.etapas.map((e) => e.etapa).filter((id) => ordem.includes(id))).toEqual(ordem);
    for (const e of estado.etapas.filter((x) => ordem.includes(x.etapa))) expect(e.status, `${e.etapa}`).toBe('ok');
  });

  test('AC-001: organização, endereço oficial em Arapiraca, CARDUG e Master', async () => {
    const admin = await sessoes.entrar('admin');
    const uuid = chaves.obter('TENANT');
    const t = dados<{ legal_name: string; cnpj: string }>((await admin.get(`/api/tenants/by-uuid/${uuid}`)).corpo);
    expect(t.legal_name).toBe(elenco.organizacao.razao_social);
    expect(t.cnpj.replace(/\D/g, '')).toBe(elenco.organizacao.cnpj);
    expect(t.cnpj.replace(/\D/g, '').startsWith('98')).toBe(true);
    const end = JSON.stringify(dados((await admin.get(`/api/tenants/${uuid}/official-address`)).corpo));
    expect(end).toMatch(/Arapiraca|2700300/);
    const tce = dados<{ cardug_identifier: string }>((await admin.get(`/api/tenants/${uuid}/tce-parameters`)).corpo);
    expect(tce.cardug_identifier).toMatch(/^\d{6}$/);
    const vinculos = JSON.stringify(dados((await admin.get(`/api/users/${chaves.obter('USER_M0')}/tenant-roles`)).corpo));
    expect(vinculos).toContain(uuid);
    expect(vinculos).toContain('"master"');
  });

  test('AC-002: DNE e camadas IBGE sincronizados; camada publicada só para a demo', async () => {
    const admin = await sessoes.entrar('admin');
    const lista = await listarTudo<{ status: string; sync_status: string }>(admin, '/api/dne-imports');
    expect(lista.some((d) => d.status === 'completed' && d.sync_status === 'synced'), 'DNE concluído e sincronizado').toBe(true);
    const imps = await listarTudo<{ layer_type: string; status: string; sync_status: string; sync_summary: unknown }>(admin, '/api/geo-layer-imports');
    for (const tipo of ['municipal_geometry', 'census_sector', 'neighborhood']) {
      const imp = imps.find((i) => i.layer_type === tipo && i.sync_status === 'synced');
      expect(imp, `${tipo} sincronizado`).toBeTruthy();
      test.info().annotations.push({ type: `sync_summary ${tipo}`, description: JSON.stringify(imp?.sync_summary) });
    }
    expect(Number(escalar(cfg, "SELECT count(*) FROM city_geometries WHERE ibge_code LIKE '27%' AND deleted_at IS NULL"))).toBe(102);
    expect(Number(escalar(cfg, "SELECT count(*) FROM census_sectors WHERE ibge_code_municipio = '2700300' AND deleted_at IS NULL"))).toBe(427);
    expect(Number(escalar(cfg, "SELECT count(*) FROM territorial_unit_geometries g JOIN territorial_units u ON u.id = g.territorial_unit_id JOIN cities c ON c.id = u.city_id WHERE c.ibge_code = '2700300' AND g.deleted_at IS NULL"))).toBe(41);
    const camada = dados<{ status: string; audience: string; tenants?: Array<{ uuid: string }> }>((await admin.get(`/api/geo-layers/${chaves.obter('GEO_CAMADA_DEMO')}`)).corpo);
    expect(camada.status).toBe('published');
    expect(camada.audience).toBe('selected');
    expect(JSON.stringify(camada)).toContain(chaves.obter('TENANT'));
  });

  test('AC-003: Master e P0–P7 entram com a senha definida pelo Mailpit e sem aceite pendente; nada sensível no estado', async () => {
    for (const codigo of ['M0', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) {
      const c = await sessoes.entrar(codigo);
      expect(dados<unknown[]>((await c.get('/api/legal-acceptance/pending')).corpo), `${codigo} com aceite pendente`).toHaveLength(0);
      await sessoes.sair(codigo);
    }
    const bruto = readFileSync(caminho, 'utf8');
    expect(bruto.includes(senhaMassa(cfg)), 'senha dos usuários no estado').toBe(false);
    expect(bruto).not.toMatch(/"(password|token)"\s*:\s*"(?!\[redigido\])/i);
    expect(bruto).not.toMatch(/XSRF-TOKEN=|laravel_session=|Bearer [A-Za-z0-9]/);
  });

  test('AC-004/AC-005: unidades com MDS e geometria; lotações e papéis da equipe', async () => {
    const master = await sessoes.entrar('M0');
    const unidades = await listarTudo<{ uuid: string; name: string; mds_number: string }>(master, '/api/client/social-units');
    for (const u of elenco.unidades) {
      const achada = unidades.find((x) => x.uuid === chaves.obter(`UNIT_${u.chave}`));
      expect(achada?.name, u.chave).toBe(u.nome);
      expect(achada?.mds_number).toMatch(/^\d{13}$/);
    }
    expect(Number(escalar(cfg, SQL.unidadesSemGeometria(elenco.organizacao.cnpj)))).toBe(0);
    for (const p of elenco.profissionais) {
      const uuid = chaves.obter(`PROF_${p.chave}`);
      const lot = dados<Array<{ unit: { uuid: string }; period: { start_date: string; end_date: string | null }; is_active: boolean }>>(
        (await master.get(`/api/client/professionals/${uuid}/units`)).corpo,
      );
      const ativas = lot.filter((l) => l.is_active && !l.period.end_date);
      expect(ativas.length, `${p.chave} lotações`).toBe(p.lotacoes.length);
      for (const l of p.lotacoes) {
        const achada = ativas.find((a) => a.unit.uuid === chaves.obter(`UNIT_${l.unidade}`));
        expect(achada?.period.start_date, `${p.chave} em ${l.unidade} desde ${l.desde}`).toBe(l.desde);
      }
      const atuais = dados<{ current_roles: Array<{ name: string }> }>((await master.get(`/api/client/professionals/${uuid}/roles`)).corpo).current_roles;
      const papeis = JSON.stringify(atuais.map((r) => r.name));
      for (const addon of p.add_ons) expect(papeis, `${p.chave} com ${addon}`).toContain(`"${addon}"`);
      if (!p.add_ons.includes('family_viewer')) expect(papeis, `${p.chave} sem family_viewer`).not.toContain('"family_viewer"');
      for (const extra of p.permissoes_extras) {
        if (temAchado(extra)) test.info().annotations.push({ type: 'achado RN14', description: `${p.chave}: ${extra} sem rota de concessão` });
        else expect(papeis, `${p.chave} com ${extra}`).toContain(extra);
      }
    }
    const p5 = await sessoes.entrar('P5');
    expect(JSON.stringify(dados((await p5.get('/api/client/auth/me')).corpo))).not.toContain('families.view-details');
  });

  test('AC-006: ENT-1 com CNEAS; ENT-2 sem CNEAS (ou achado RN14)', async () => {
    const p0 = await sessoes.entrar('P0');
    const ents = await listarTudo<{ uuid: string; cneas_number: string | null; legal_name: string }>(p0, '/api/client/social-entities');
    const ent1 = ents.find((e) => e.uuid === obterOuNull('ENT_ENT-1'));
    expect(ent1?.cneas_number).toMatch(/^\d{13}$/);
    const ent2 = ents.find((e) => e.uuid === obterOuNull('ENT_ENT-2'));
    if (ent2) expect(ent2.cneas_number ?? null).toBeNull();
    else {
      expect(temAchado('ENT-2'), 'ENT-2 ausente sem achado RN14 registrado').toBe(true);
      test.info().annotations.push({ type: 'achado RN14', description: 'ENT-2 sem CNEAS recusada pela API' });
    }
  });

  test('AC-007 (CA11): CPFs da massa na faixa 98, DV válido, iguais ao elenco; sem CPF = NULL', () => {
    const familiasCriadas = new Set(elenco.familias.filter((f) => obterOuNull(`FAM_${f.chave}`)).map((f) => f.chave));
    const pessoas = elenco.pessoas.filter((p) => familiasCriadas.has(p.familia_chave));
    const cpfs = consultar(cfg, SQL.cpfsDasFamilias(elenco.organizacao.cnpj)).map((l) => l[0]);
    const preenchidos = cpfs.filter((c) => c !== '<null>');
    for (const c of preenchidos) {
      expect(c.startsWith('98'), c).toBe(true);
      expect(cpfValido(c), c).toBe(true);
    }
    expect(preenchidos.sort()).toEqual(pessoas.filter((p) => p.cpf).map((p) => p.cpf!).sort());
    expect(cpfs.length - preenchidos.length).toBe(pessoas.filter((p) => !p.cpf).length);
    expect(Number(escalar(cfg, SQL.cpfVazio(elenco.organizacao.cnpj)))).toBe(0);
  });

  test('AC-008: famílias, prontuário na unidade do elenco e filas de pendência', async () => {
    const p1 = await sessoes.entrar('P1');
    const comUnidade = elenco.familias.filter((f) => f.unidade_referencia);
    const semUnidade = elenco.familias.filter((f) => !f.unidade_referencia);
    for (const f of comUnidade) expect(obterOuNull(`FAM_${f.chave}`), f.chave).toBeTruthy();
    const linhas = consultar(cfg, SQL.familiasPorUnidade(elenco.organizacao.cnpj));
    const porUnidade = Object.fromEntries(linhas.map(([nome, total]) => [nome, Number(total)]));
    for (const u of elenco.unidades) expect(porUnidade[u.nome] ?? 0, u.nome).toBe(comUnidade.filter((f) => f.unidade_referencia === u.chave).length);
    const datas = consultar(cfg, SQL.datasDeReferencia(elenco.organizacao.cnpj)).map(([d]) => d).sort();
    expect(datas).toEqual(comUnidade.map((f) => f.referenciada_em!).sort());
    const membros = Number(escalar(cfg, SQL.totalDeIntegrantes(elenco.organizacao.cnpj)));
    expect(membros).toBe(elenco.pessoas.filter((p) => comUnidade.some((f) => f.chave === p.familia_chave)).length);
    const filaSem = dados<unknown[]>((await p1.get('/api/client/families/without-reference-unit')).corpo);
    const criadasSem = semUnidade.filter((f) => obterOuNull(`FAM_${f.chave}`));
    if (criadasSem.length === semUnidade.length) expect(filaSem.length).toBe(semUnidade.length);
    else {
      expect(temAchado('exige unidade de referência'), 'famílias sem unidade ausentes sem achado').toBe(true);
      test.info().annotations.push({ type: 'achado RN14', description: `fila "sem unidade" = ${filaSem.length} (esperado ${semUnidade.length})` });
    }
    const pendentes = dados<unknown[]>((await p1.get('/api/client/families/pending-specificity')).corpo);
    test.info().annotations.push({ type: 'fila especificidade pendente (P1)', description: String(pendentes.length) });
    const semEspec = Number(escalar(cfg, SQL.semEspecificidadeConfirmada(elenco.organizacao.cnpj)));
    expect(semEspec).toBe(comUnidade.filter((f) => !f.especificidade_confirmada).length);
  });

  test('AC-009: diagnóstico com as lacunas F-ESCOL e F-HAB-1..2', () => {
    const cnpj = elenco.organizacao.cnpj;
    const comUnidade = elenco.familias.filter((f) => f.unidade_referencia);
    const semHab = consultar(cfg, SQL.familiasSemHabitacao(cnpj)).map(([uuid]) => uuid).sort();
    const esperadoSemHab = comUnidade.filter((f) => !f.habitacao).map((f) => chaves.obter(`FAM_${f.chave}`)).sort();
    expect(semHab).toEqual(esperadoSemHab);
    const semEscolaridade = consultar(cfg, SQL.integrantesSemEscolaridade(cnpj)).map(([uuid]) => uuid).sort();
    const esperadoSemEsc = elenco.pessoas
      .filter((p) => !p.escolaridade && comUnidade.some((f) => f.chave === p.familia_chave))
      .map((p) => chaves.obter(`PES_${p.chave}`))
      .sort();
    expect(semEscolaridade).toEqual(esperadoSemEsc);
  });

  test('AC-011: RN02b (e-mails @demo.sigsuas.local) e isolamento (CA12)', () => {
    const cnpj = elenco.organizacao.cnpj;
    expect(Number(escalar(cfg, SQL.emailsForaDoDominio(cnpj)))).toBe(0);
    expect(Number(escalar(cfg, SQL.familiasComUnidadeDeOutroTenant(cnpj)))).toBe(0);
    expect(Number(escalar(cfg, SQL.lotacoesEmOutroTenant(cnpj)))).toBe(0);
  });
});
