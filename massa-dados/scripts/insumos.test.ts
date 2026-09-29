/**
 * UNIT-002…UNIT-010 — insumos da massa (#10994 · AC-003…AC-011).
 *
 * Roda sem navegador nem API: `npm run massa:insumos:verificar`
 * (`playwright test -c massa-dados/scripts`). Lê os insumos VERSIONADOS e prova que eles são o
 * que os scripts geram, de forma determinística, com a composição e os cenários do elenco.md.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Elenco, Registro } from './elenco.ts';
import { idadeEm } from './elenco.ts';
import type { ArquivoEntidades } from './entidades.ts';
import type { Esperado } from './esperado.ts';
import { gerarInsumos } from './gerar.ts';
import { ARQUIVOS_GEO, ORIGEM_GEOJSON } from './geo.ts';
import { cnpjValido, cpfEmFaixaProibida, cpfSequencial, cpfValido } from './lib/cpf.ts';
import type { FeatureCollection } from './lib/geo.ts';
import { featureQueContem } from './lib/geo.ts';
import { caminhoInsumo, lerJson, PASTA_INSUMOS, RAIZ_MASSA, sha256Arquivo } from './lib/json.ts';
import type { Manifest } from './manifest.ts';
import { contar } from './manifest.ts';
import { carregarNomes, validarLista, validarNomeCompleto } from './nomes.ts';
import type { ArquivoUnidades } from './unidades.ts';

test.describe.configure({ mode: 'serial' });

const elenco = (): Elenco => lerJson<Elenco>(caminhoInsumo('elenco.json'));
const esperado = (): Esperado => lerJson<Esperado>(caminhoInsumo('esperado.json'));
const entidades = (): ArquivoEntidades => lerJson<ArquivoEntidades>(caminhoInsumo('entidades-ficticias.json'));
const unidades = (): ArquivoUnidades => lerJson<ArquivoUnidades>(caminhoInsumo('unidades-ficticias.json'));
const geo = (rel: string): FeatureCollection => lerJson<FeatureCollection>(caminhoInsumo(rel));

/** CPFs fixos de seeders e usuários de teste do api/ (BR-011), conferidos em 2026-09-29. */
const CPFS_FIXOS = [
  '11144477735', '11955554444', '11987651234', '12345678909', '15350946056', '15543849079',
  '16451834912', '21999990000', '22603551027', '27562945004', '38673056179', '44983702016',
  '48761649082', '49784125013', '50895236141', '52998224725', '62017490555', '73128501629',
  '84239612730', '85988887777', '85991112222', '85996663333', '95340723895',
];

function arquivos(pasta: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(pasta).sort()) {
    const completo = join(pasta, nome);
    if (statSync(completo).isDirectory()) out.push(...arquivos(completo));
    else out.push(completo);
  }
  return out;
}

function instantaneo(): Map<string, string> {
  return new Map(arquivos(PASTA_INSUMOS).map((a) => [relative(PASTA_INSUMOS, a), readFileSync(a, 'utf8')]));
}

test('UNIT-003 (AC-004) — duas gerações produzem bytes idênticos aos versionados; sem sorteio sem semente', () => {
  const versionado = instantaneo();
  gerarInsumos();
  const primeira = instantaneo();
  gerarInsumos();
  const segunda = instantaneo();
  expect([...primeira.keys()]).toEqual([...segunda.keys()]);
  for (const [arquivo, conteudo] of primeira) {
    expect(segunda.get(arquivo), `${arquivo} mudou entre duas gerações`).toBe(conteudo);
    expect(versionado.get(arquivo), `${arquivo} versionado difere do gerado — rode npm run massa:insumos`).toBe(conteudo);
  }
  for (const [arquivo, conteudo] of primeira) {
    // GeoJSON são cópias byte a byte da origem; só os JSON gerados seguem a escrita estável.
    if (arquivo.endsWith('.json')) expect(conteudo.endsWith('\n'), arquivo).toBe(true);
  }

  const proibidos = [new RegExp(['Math', 'random'].join('\\.')), new RegExp(['fak', 'er'].join(''), 'i')];
  for (const arq of arquivos(resolve(RAIZ_MASSA, 'scripts'))) {
    const texto = readFileSync(arq, 'utf8');
    for (const re of proibidos) expect(re.test(texto), `${relative(RAIZ_MASSA, arq)} contém ${re}`).toBe(false);
  }
});

test('UNIT-002 (AC-003) — CPFs: base 98, DV válido, únicos, em sequência, fora das faixas proibidas', () => {
  const e = elenco();
  const naOrdem = [e.organizacao.master.cpf, ...e.profissionais.map((p) => p.cpf), ...e.pessoas.map((p) => p.cpf)];
  const preenchidos = naOrdem.filter((c): c is string => c !== null);
  expect(new Set(preenchidos).size).toBe(preenchidos.length);
  preenchidos.forEach((cpf, i) => {
    expect(cpf.startsWith('98'), cpf).toBe(true);
    expect(cpfValido(cpf), cpf).toBe(true);
    expect(cpfEmFaixaProibida(cpf, CPFS_FIXOS), cpf).toBe(false);
    expect(cpf, `posição ${i + 1} da sequência`).toBe(cpfSequencial(i + 1));
  });
  const semCpf = e.pessoas.filter((p) => p.cpf === null);
  expect(semCpf.length).toBeGreaterThan(0);
  for (const p of semCpf) expect(p.cpf).toBeNull();
});

test('UNIT-004 (AC-005) — composição: 60 famílias (25/22/10/3), ~200 pessoas, ~9 sem CPF, 3 unidades, 2 entidades, P0–P7', () => {
  const e = elenco();
  const porUnidade = (u: string | null) => e.familias.filter((f) => f.unidade_referencia === u).length;
  expect(e.familias).toHaveLength(60);
  expect([porUnidade('U-CN'), porUnidade('U-CS'), porUnidade('U-CE'), porUnidade(null)]).toEqual([25, 22, 10, 3]);
  expect(e.pessoas.length).toBeGreaterThanOrEqual(190);
  expect(e.pessoas.length).toBeLessThanOrEqual(210);
  expect(e.pessoas.filter((p) => p.cpf === null).length).toBe(9);
  expect(e.unidades.map((u) => `${u.chave}:${u.tipo}`)).toEqual(['U-CN:CRAS', 'U-CS:CRAS', 'U-CE:CREAS']);
  const ents = entidades().entidades;
  expect(ents).toHaveLength(2);
  expect(ents.filter((x) => x.cneas === null).map((x) => x.chave)).toEqual(['ENT-2']);
  expect(e.profissionais.map((p) => p.chave)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);
  const prof = (k: string) => e.profissionais.find((p) => p.chave === k)!;
  expect(prof('P0').lotacoes).toEqual([]);
  expect(prof('P4').lotacoes.map((l) => l.unidade)).toEqual(['U-CN', 'U-CE']);
  expect(prof('P5').add_ons).toEqual([]);
  expect(prof('P6').add_ons).toEqual(['geo_panel_viewer']);
  expect(prof('P7').permissoes_extras).toEqual(['attendance-reports.view']);
  for (const k of ['P1', 'P2', 'P3', 'P4']) expect(prof(k).add_ons).toEqual(['family_viewer']);
  for (const p of e.profissionais) for (const l of p.lotacoes) expect(l.desde).toBe('2026-05-01');
});

test('UNIT-005 (AC-006) — famílias-cenário, CAP-1..3 e o zero declarado do CREAS em 2026-06', () => {
  const e = elenco();
  const esperados: Record<string, string> = {
    'F-IDOSO': 'CA06', 'F-GRUPO': 'CA06', 'F-PERFIS-1': 'CA06', 'F-PERFIS-2': 'CA06', 'F-PERFIS-3': 'CA06',
    'F-PERFIS-4': 'CA06', 'F-DUPLA': 'CA08', 'F-ENC': 'CA09', 'F-SEM-REF-1': 'RN10', 'F-SEM-REF-2': 'RN10',
    'F-SEM-REF-3': 'RN10', 'F-SEM-ESP-1': 'RN10', 'F-SEM-ESP-2': 'RN10', 'F-SEM-ESP-3': 'RN10',
    'F-SEM-ESP-4': 'RN10', 'F-SEM-CPF': 'CA10', 'F-ESCOL': 'RN10', 'F-HAB-1': 'RN08', 'F-HAB-2': 'RN08',
    'F-ACOLH': 'RN12', 'F-BENEF-2X': 'RN08', 'F-READM': 'RN08',
  };
  const fam = (k: string) => e.familias.find((f) => f.chave === k)!;
  for (const [chave, cenario] of Object.entries(esperados)) expect(fam(chave)?.cenario, chave).toBe(cenario);
  const regs = (filtro: (r: Registro) => boolean) => e.registros.filter(filtro);
  const val = (mes: string, unidade: string, contador: string) =>
    esperado().contadores.find((c) => c.mes === mes && c.unidade === unidade && c.contador === contador)!.valor;

  // F-IDOSO: 60+ no SCFV de adultos (900) → nota elderly_outside_range no CRAS Norte.
  const idoso = regs((r) => r.familia_chave === 'F-IDOSO' && r.tipo === 'participation' && r.payload.servico_codigo === '900')[0]!;
  const pessoaIdosa = e.pessoas.find((p) => p.chave === idoso.payload.integrante)!;
  expect(idadeEm(pessoaIdosa.nascimento, '2026-06-30')!).toBeGreaterThanOrEqual(60);
  for (const mes of ['2026-06', '2026-07', '2026-08']) expect(val(mes, 'U-CN', 'scfv_notes.elderly_outside_range')).toBe(1);
  // F-GRUPO: grupo PAIF (3) → families_in_groups sem faixas etárias no CRAS Sul em julho.
  expect(val('2026-07', 'U-CS', 'families_in_groups')).toBe(1);
  for (const f of ['children_0_6', 'preadolescents_7_14', 'adolescents_15_17', 'adults_18_59']) expect(val('2026-07', 'U-CS', f)).toBe(0);
  // F-PERFIS: soma dos perfis > novas famílias no CRAS Norte em julho.
  const perfis = esperado().contadores.filter((c) => c.mes === '2026-07' && c.unidade === 'U-CN' && c.contador.startsWith('new_families_profile.'));
  expect(perfis.reduce((s, c) => s + c.valor, 0)).toBeGreaterThan(val('2026-07', 'U-CN', 'new_families'));
  // F-DUPLA: PAIF no CRAS Norte e PAEFI no CREAS vigentes em julho.
  const dupla = regs((r) => r.familia_chave === 'F-DUPLA' && r.tipo === 'follow_up');
  expect(dupla.map((r) => `${r.unidade}:${r.payload.servico}`).sort()).toEqual(['U-CE:PAEFI', 'U-CN:PAIF']);
  // F-ENC: trânsito interno SEM desfecho com destino o CRAS Sul.
  const encF = regs((r) => r.familia_chave === 'F-ENC' && r.tipo === 'referral')[0]!;
  expect(encF.payload.destino_unidade).toBe('U-CS');
  expect(encF.payload.desfecho).toBe('awaiting_return');
  // F-READM: dois ingressos no mesmo mês, uma nova família.
  expect(regs((r) => r.familia_chave === 'F-READM' && r.tipo === 'follow_up' && r.data_fato.startsWith('2026-07'))).toHaveLength(2);
  // F-BENEF-2X: duas concessões no mesmo mês.
  expect(regs((r) => r.familia_chave === 'F-BENEF-2X' && r.tipo === 'eventual_benefit' && r.data_fato.startsWith('2026-07'))).toHaveLength(2);
  // F-ACOLH: acolhimento ÚNICO, de criança, em família com PAEFI ativo.
  const acolh = regs((r) => r.tipo === 'sheltering');
  expect(acolh).toHaveLength(1);
  expect(acolh[0]!.familia_chave).toBe('F-ACOLH');
  expect(idadeEm(e.pessoas.find((p) => p.chave === acolh[0]!.payload.integrante)!.nascimento, '2026-07-20')!).toBeLessThan(18);
  // F-SEM-REF: nenhum registro (a API recusaria com 422).
  expect(regs((r) => (r.familia_chave ?? '').startsWith('F-SEM-REF'))).toHaveLength(0);
  // F-SEM-CPF: integrantes sem CPF atendidos.
  const semCpfAtendidos = regs((r) => r.familia_chave === 'F-SEM-CPF' && r.tipo === 'attendance')
    .flatMap((r) => r.payload.pessoas as string[])
    .filter((k) => e.pessoas.find((p) => p.chave === k)!.cpf === null);
  expect(semCpfAtendidos.length).toBeGreaterThan(0);
  // F-ESCOL: integrante sem escolaridade atendido.
  expect(e.pessoas.filter((p) => p.escolaridade === null).map((p) => p.familia_chave)).toEqual(['F-ESCOL']);
  // F-HAB: sem condições habitacionais.
  expect(e.familias.filter((f) => f.habitacao === null).map((f) => f.chave)).toEqual(['F-HAB-1', 'F-HAB-2']);
  // Capacitação.
  const caps = regs((r) => r.tipo === 'capacitation');
  expect(caps.map((r) => `${r.chave}:${r.unidade}:${r.payload.tipo_codigo}`)).toEqual(['CAP-1:U-CN:003', 'CAP-2:U-CS:001', 'CAP-3:U-CE:005']);
  // Zero declarado: nenhum registro no CREAS em junho e todos os contadores zerados.
  expect(regs((r) => r.unidade === 'U-CE' && r.data_fato.startsWith('2026-06'))).toHaveLength(0);
  for (const c of esperado().contadores.filter((x) => x.mes === '2026-06' && x.unidade === 'U-CE')) {
    expect(c.valor, c.contador).toBe(c.contador === 'capacitation.has_no_records' ? 1 : 0);
  }
});

test('coerência cruzada do elenco (referências, lotação na data, datas, serviço × tipo de unidade)', () => {
  const e = elenco();
  const familias = new Map(e.familias.map((f) => [f.chave, f]));
  const pessoas = new Map(e.pessoas.map((p) => [p.chave, p]));
  const profs = new Map(e.profissionais.map((p) => [p.chave, p]));
  for (const p of e.pessoas) expect(familias.has(p.familia_chave), p.chave).toBe(true);
  for (const f of e.familias) expect(pessoas.get(f.responsavel)?.familia_chave).toBe(f.chave);
  const chaves = e.registros.map((r) => r.chave);
  expect(new Set(chaves).size).toBe(chaves.length);
  const lotado = (prof: string, unidade: string, data: string) =>
    profs.get(prof)!.lotacoes.some((l) => l.unidade === unidade && l.desde <= data);
  for (const r of e.registros) {
    expect(r.data_fato >= '2026-06-01' && r.data_fato <= '2026-08-31', r.chave).toBe(true);
    expect(lotado(r.profissional, r.unidade, r.data_fato), `${r.chave}: ${r.profissional} não lotado em ${r.unidade}`).toBe(true);
    if (r.familia_chave !== null) {
      expect(familias.get(r.familia_chave)?.unidade_referencia, r.chave).not.toBeNull();
    }
    for (const campo of ['integrante'] as const) {
      const k = r.payload[campo] as string | null | undefined;
      if (k) expect(pessoas.get(k)?.familia_chave, r.chave).toBe(r.familia_chave);
    }
    if (r.tipo === 'attendance') {
      for (const k of r.payload.pessoas as string[]) expect(pessoas.get(k)?.familia_chave, r.chave).toBe(r.familia_chave);
    }
    if (r.tipo === 'follow_up') expect(r.payload.servico).toBe(r.unidade === 'U-CE' ? 'PAEFI' : 'PAIF');
    if (r.tipo === 'capacitation') {
      for (const p of r.payload.participantes as string[]) expect(lotado(p, r.unidade, r.data_fato), `${r.chave}: ${p}`).toBe(true);
    }
  }
});

test('UNIT-006 (AC-007) — nomes só da lista fictícia, sem duplicata e sem bloqueio', () => {
  const lista = carregarNomes();
  expect(validarLista(lista)).toEqual([]);
  const e = elenco();
  const nomes = [e.organizacao.master.nome, ...e.profissionais.map((p) => p.nome), ...e.pessoas.map((p) => p.nome)];
  expect(new Set(nomes).size).toBe(nomes.length);
  for (const nome of [...nomes, ...e.pessoas.map((p) => p.nome_mae)]) {
    expect(validarNomeCompleto(nome, lista), nome).toEqual([]);
  }
});

test('UNIT-007 (AC-008) — GeoJSON 102/41/427 idênticos à origem; toda coordenada cai num setor de Arapiraca', () => {
  for (const arq of ARQUIVOS_GEO) {
    expect(geo(arq.destino).features, arq.destino).toHaveLength(arq.features);
    const origem = resolve(ORIGEM_GEOJSON, arq.origem);
    if (existsSync(origem)) expect(sha256Arquivo(caminhoInsumo(arq.destino))).toBe(sha256Arquivo(origem));
  }
  const setores = geo('geo/setores-arapiraca.geojson');
  const coords = lerJson<{ familias: Record<string, { latitude: number; longitude: number; setor: string }> }>(caminhoInsumo('coordenadas-familias.json'));
  expect(Object.keys(coords.familias).sort()).toEqual(elenco().familias.map((f) => f.chave).sort());
  const pontos = [...Object.values(coords.familias), ...unidades().unidades.map((u) => u.coordenada)];
  for (const c of pontos) {
    const setor = featureQueContem(c.longitude, c.latitude, setores);
    expect(setor, `${c.latitude},${c.longitude}`).not.toBeNull();
    expect(String(setor!.properties.id)).toBe(c.setor);
  }
});

test('UNIT-008 (AC-009) — esperado.json cobre 3 meses × 3 unidades e as 5 pendências da RN10', () => {
  const x = esperado();
  expect(x.versao_elenco).toBe(elenco().versao);
  const combos = new Set(x.contadores.map((c) => `${c.mes}|${c.unidade}`));
  expect([...combos].sort()).toEqual(
    ['2026-06', '2026-07', '2026-08'].flatMap((m) => ['U-CE', 'U-CN', 'U-CS'].map((u) => `${m}|${u}`)).sort(),
  );
  const porCombo = [...combos].map((k) => x.contadores.filter((c) => `${c.mes}|${c.unidade}` === k).map((c) => c.contador).join(','));
  expect(new Set(porCombo).size).toBe(1);
  for (const c of x.contadores) expect(Number.isInteger(c.valor) && c.valor >= 0).toBe(true);
  const kinds = new Set(x.pendencias.map((p) => p.kind));
  expect([...kinds].sort()).toEqual([
    'attended_person_without_cpf', 'entity_without_cneas', 'family_pending_specificity',
    'family_without_reference_unit', 'member_without_schooling',
  ]);
  const p = (kind: string, unidade: string | null = null) => x.pendencias.filter((y) => y.kind === kind && y.unidade === unidade);
  expect(p('family_without_reference_unit')[0]!.valor).toBe(3);
  expect(p('entity_without_cneas')[0]!.valor).toBe(1);
  expect(p('family_pending_specificity', 'U-CN')[0]!.valor + p('family_pending_specificity', 'U-CS')[0]!.valor).toBe(4);
  for (const y of x.pendencias) expect(y.valor).toBeGreaterThan(0);
});

test('UNIT-009 (AC-010) — manifest.json lista todos os insumos com sha256 e contagens corretas', () => {
  const m = lerJson<Manifest>(caminhoInsumo('manifest.json'));
  expect(m.versao_elenco).toBe(elenco().versao);
  const presentes = arquivos(PASTA_INSUMOS).map((a) => relative(PASTA_INSUMOS, a)).filter((a) => a !== 'manifest.json');
  expect(m.arquivos.map((a) => a.caminho)).toEqual(presentes);
  for (const a of m.arquivos) {
    expect(a.sha256, a.caminho).toBe(sha256Arquivo(caminhoInsumo(a.caminho)));
    expect(a.contagem, a.caminho).toBe(contar(a.caminho)[0]);
    expect(statSync(caminhoInsumo(a.caminho)).size, `${a.caminho} acima de 5 MB`).toBeLessThan(5 * 1024 * 1024);
  }
});

test('UNIT-010 (AC-011) — marcação RN02b: CNPJ base 98 com DV, e-mails @demo.sigsuas.local, nomes de unidade', () => {
  const e = elenco();
  expect(e.organizacao.razao_social).toBe('Município Demonstração SigSUAS');
  for (const cnpj of [e.organizacao.cnpj, ...entidades().entidades.map((x) => x.cnpj)]) {
    expect(cnpj.startsWith('98000000'), cnpj).toBe(true);
    expect(cnpjValido(cnpj), cnpj).toBe(true);
  }
  expect(e.organizacao.master.email).toBe('master.1@demo.sigsuas.local');
  e.profissionais.forEach((p, i) => expect(p.email).toBe(`operador.${i}@demo.sigsuas.local`));
  expect(unidades().unidades.map((u) => u.nome)).toEqual(['CRAS Demonstração Norte', 'CRAS Demonstração Sul', 'CREAS Demonstração']);
  for (const u of unidades().unidades) expect(u.codigo_mds).toMatch(/^270030098\d{4}$/);
});
