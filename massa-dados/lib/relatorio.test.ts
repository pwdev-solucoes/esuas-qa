/**
 * UNIT do relatório de evidências (#10994 · plano 06): UNIT-001 pasta nova sem sobrescrever e páginas
 * de todas as etapas, UNIT-002 sem evidências nada é gravado, UNIT-003 ausência de segredos e escape,
 * UNIT-006 etapa com falha → índice gerado com ✖ e as seguintes "não executada".
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { registrarSegredos } from './config.ts';
import { Evidencia, pastaRelatorioAtiva } from './evidencia.ts';
import { ETAPAS, type EstadoExecucao } from './execucao.ts';
import type { Esperado } from './esperado.ts';
import {
  arquivoEtapa,
  atualizarDeterminismo,
  avaliarCa,
  CAS,
  criarPastaExecucao,
  escaparHtml,
  gerarRelatorio,
  lerTemplates,
  nomePastaExecucao,
  renderizarIndice,
  verificarSemSegredos,
  type DadosRelatorio,
  type ElencoRelatorio,
} from './relatorio.ts';
import type { Snapshot } from './snapshot.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'massa-relatorio-'));

function estado(etapas: EstadoExecucao['etapas']): EstadoExecucao {
  return { id: '2026-09-30T12-00-00-000Z', iniciadaEm: '2026-09-30T12:00:00.000Z', evidencias: true, ate: null, apiBase: 'http://localhost', ambiente: [], etapas, chaves: {} };
}

const ok = (etapa: string, extra: Partial<EstadoExecucao['etapas'][number]> = {}) => ({ etapa, status: 'ok' as const, duracao: 1500, papel: 'P1', passos: [], avisos: [], ...extra });

const ELENCO: ElencoRelatorio = {
  versao: '2026-09-29.1',
  organizacao: { razao_social: 'Município Demonstração SigSUAS', cnpj: '98000000000196', ibge: '2700300', municipio: 'Arapiraca', uf: 'AL', master: { chave: 'M0', nome: 'Master Fictício' } },
  unidades: [{ chave: 'U-CN', nome: 'CRAS Demonstração Norte', tipo: 'CRAS' }],
  profissionais: [{ chave: 'P1', nome: 'Pessoa Fictícia', papel: 'operador', add_ons: ['family_viewer'], permissoes_extras: [], lotacoes: [{ unidade: 'U-CN', desde: '2026-05-01' }], finalidade: 'teste' }],
  pessoas: [{ cpf: '98000000105' }, { cpf: null }],
  familias: [
    { chave: 'F-IDOSO', cenario: 'F-IDOSO', exibe: 'Idoso no SCFV de adultos', unidade_referencia: 'U-CN' },
    { chave: 'F-SEM-REF-1', cenario: 'F-SEM-REF', exibe: 'Sem unidade', unidade_referencia: null },
  ],
  registros: [{ tipo: 'attendance' }],
};

const ESPERADO: Esperado = {
  versao_elenco: '2026-09-29.1',
  meses: ['2026-07'],
  unidades: ['U-CN'],
  convencoes: [],
  contadores: [
    { mes: '2026-07', unidade: 'U-CN', contador: 'total_attendances', valor: 3 },
    { mes: '2026-07', unidade: 'U-CN', contador: 'new_families', valor: 2 },
  ],
  pendencias: [{ kind: 'entity_without_cneas', scope: 'tenant', unidade: null, mes: null, valor: 1 }],
};

const SNAPSHOT: Snapshot = {
  formato: 1,
  meta: { execucao: 'x', gerado_em: '2026-09-30T12:00:00Z' },
  elenco: '2026-09-29.1',
  organizacao: {},
  tabelas: {},
  apuracao: { '2026-07|U-CN|total_attendances': 3, '2026-07|U-CN|new_families': 5 },
  pendencias: [],
};

function dadosRelatorio(e: EstadoExecucao, snapshot: Snapshot | null = SNAPSHOT): DadosRelatorio {
  return {
    estado: e,
    evidencias: {},
    elenco: ELENCO,
    esperado: ESPERADO,
    snapshot,
    manifest: {
      execucao: e.id,
      pasta: 'x',
      iniciada_em: e.iniciadaEm,
      concluida_em: null,
      ambiente: 'local',
      api: { base: 'http://localhost', versao: 'abc1234' },
      qa: { versao: 'def5678' },
      elenco: { versao: '2026-09-29.1' },
      insumos: { manifest_sha256: null },
      dne: null,
      flags: { evidencias: true },
      resultado: 'ok',
    },
  };
}

test.describe('UNIT-001 — pasta datada nova, sem sobrescrever (RN-T5)', () => {
  test('mesma data/hora gera -2 e mantém o conteúdo da primeira', () => {
    const base = tmp();
    const agora = new Date(2026, 8, 30, 14, 5);
    const a = criarPastaExecucao(base, agora);
    expect(a.endsWith('2026-09-30_1405')).toBe(true);
    writeFileSync(join(a, 'index.html'), 'ORIGINAL');
    const b = criarPastaExecucao(base, agora);
    const c = criarPastaExecucao(base, agora);
    expect(b.endsWith('2026-09-30_1405-2')).toBe(true);
    expect(c.endsWith('2026-09-30_1405-3')).toBe(true);
    expect(readFileSync(join(a, 'index.html'), 'utf8')).toBe('ORIGINAL');
    for (const p of [a, b, c]) expect(existsSync(join(p, 'screens')) && existsSync(join(p, 'dados'))).toBe(true);
    expect(nomePastaExecucao(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02_0304');
  });

  test('gera index.html, manifest.json e uma página por etapa (etapa-00 … etapa-20)', () => {
    const pasta = criarPastaExecucao(tmp());
    const arquivos = gerarRelatorio(pasta, dadosRelatorio(estado(ETAPAS.map((d) => ok(d.id)))));
    const gerados = readdirSync(pasta);
    for (const f of ['index.html', 'manifest.json', 'etapa-00.html', 'etapa-00b.html', 'etapa-01b.html', 'etapa-06a.html', 'etapa-19.html', 'etapa-20.html']) expect(gerados).toContain(f);
    expect(arquivos).toHaveLength(ETAPAS.length + 2);
    expect(new Set(ETAPAS.map((d) => arquivoEtapa(d.id))).size).toBe(ETAPAS.length);
    const indice = readFileSync(join(pasta, 'index.html'), 'utf8');
    for (const secao of ['id="execucao"', 'id="etapas"', 'id="criterios"', 'id="composicao"', 'id="cenarios"', 'id="pendencias"', 'id="esperado"', 'id="achados"', 'id="determinismo"']) expect(indice).toContain(secao);
    for (const ca of ['CA01', 'CA04', 'CA09', 'CA11', 'CA12', 'CA13']) expect(indice).toContain(`<td>${ca}</td>`);
    expect(indice).toContain('2 → 5'); // esperado → apurado diferente é exibido
    expect(indice).toContain('A8');
  });
});

test.describe('UNIT-002 — sem evidências nada vai para o disco', () => {
  test('sem MASSA_RELATORIO_DIR a evidência é só memória', async () => {
    expect(pastaRelatorioAtiva({})).toBeNull();
    const ev = new Evidencia('E10', null);
    ev.contagem('atendimentos', 3, 3);
    expect(ev.ativa).toBe(false);
    expect(ev.salvar()).toBeNull();
    expect(await ev.print({ cfg: {} as never, cpf: '98000000105', senha: 'x', rota: '/app', nome: 'n', legenda: 'l' })).toBeNull();
  });

  test('com pasta ativa grava dados/<etapa>.json sanitizado', () => {
    const pasta = criarPastaExecucao(tmp());
    const ev = new Evidencia('E10', pasta);
    ev.contagem('atendimentos', 147, 147);
    ev.nota('password=abc123 não pode sair');
    const arq = ev.salvar()!;
    const texto = readFileSync(arq, 'utf8');
    expect(texto).toContain('"ok": true');
    expect(texto).not.toContain('abc123');
  });
});

test.describe('UNIT-003 — sem segredos e com escape (RN-T7)', () => {
  test('segredo registrado, JSON de senha, cookie e XSRF não saem no HTML', () => {
    registrarSegredos(['Segredo#Massa-42']);
    const e = estado([
      ok('E02', {
        passos: [
          { papel: 'M0', metodo: 'POST', uri: '/api/client/auth/login', status: 200, chave: 'M0' },
          { passo: 'teste', corpo: '{"password": "Segredo#Massa-42", "token": "tok-999"}', header: 'X-XSRF-TOKEN: abc.def', cookie: 'laravel_session=zzz999' },
        ],
        avisos: ['<script>alert(1)</script> Segredo#Massa-42'],
      }),
    ]);
    const pasta = criarPastaExecucao(tmp());
    gerarRelatorio(pasta, dadosRelatorio(e));
    for (const f of readdirSync(pasta).filter((x) => /\.(html|json)$/.test(x))) {
      const t = readFileSync(join(pasta, f), 'utf8');
      expect(t, f).not.toContain('Segredo#Massa-42');
      expect(t, f).not.toContain('tok-999');
      expect(t, f).not.toContain('zzz999');
      expect(t, f).not.toMatch(/X-XSRF-TOKEN: abc/);
      expect(t, f).not.toContain('<script>alert(1)</script>');
    }
    expect(readFileSync(join(pasta, 'etapa-02.html'), 'utf8')).toContain('&lt;script&gt;');
  });

  test('verificarSemSegredos recusa valor sensível e aceita rótulo neutro', () => {
    expect(() => verificarSemSegredos('{"password": "abc"}')).toThrow();
    expect(() => verificarSemSegredos('Cookie laravel_session=abc123')).toThrow();
    expect(() => verificarSemSegredos('Authorization Bearer abcdefghijk123')).toThrow();
    expect(() => verificarSemSegredos('senha definida pelo link do Mailpit · /api/client/auth/reset-password → 200')).not.toThrow();
    expect(escaparHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

test.describe('UNIT-006 — interrupção: índice gerado com ✖ e "não executada"', () => {
  test('falha na E10 marca a etapa e as seguintes', () => {
    const idx = ETAPAS.findIndex((d) => d.id === 'E10');
    const etapas = [
      ...ETAPAS.slice(0, idx).map((d) => ok(d.id)),
      { etapa: 'E10', status: 'falha' as const, duracao: 900, papel: 'P1–P4', passos: [], avisos: ['falha: HTTP 500'] },
      ...ETAPAS.slice(idx + 1).map((d) => ({ etapa: d.id, status: 'nao_executada' as const, duracao: 0, papel: null, passos: [], avisos: [] })),
    ];
    const pasta = criarPastaExecucao(tmp());
    gerarRelatorio(pasta, dadosRelatorio(estado(etapas), null));
    const indice = readFileSync(join(pasta, 'index.html'), 'utf8');
    expect(indice).toContain('✖ FALHOU');
    expect(indice).toContain('NÃO EXECUTADA');
    expect(indice).toContain('INTERROMPIDA');
    expect(readFileSync(join(pasta, 'etapa-20.html'), 'utf8')).toContain('NÃO EXECUTADA');
    expect(avaliarCa(CAS.find((c) => c.id === 'CA12')!, estado(etapas)).texto).toBe('NÃO EXECUTADA');
    expect(avaliarCa(CAS.find((c) => c.id === 'CA10')!, estado(etapas)).texto).toBe('FALHOU');
  });

  test('achado RN14 torna o CA parcial; determinismo atualiza o índice', () => {
    const e = estado(ETAPAS.map((d) => ok(d.id, d.id === 'E05' ? { avisos: ['ACHADO RN14: ENT-2 (sem CNEAS) recusada'] } : {})));
    expect(avaliarCa(CAS.find((c) => c.id === 'CA07')!, e).texto).toBe('PARCIAL (RN14)');
    expect(avaliarCa(CAS.find((c) => c.id === 'CA04')!, e).texto).toBe('AGUARDA COMPARAÇÃO');
    expect(avaliarCa(CAS.find((c) => c.id === 'CA04')!, e, { a: 'A', b: 'B', identico: true, divergencias: 0, em: 'x' }).texto).toBe('ATENDIDO');
    const html = atualizarDeterminismo('<p><!--determinismo-->velho<!--/determinismo--></p>', { a: 'exec-A', b: 'exec-B', identico: true, divergencias: 0, em: 'agora' });
    expect(html).toContain('IDÊNTICO');
    expect(html).not.toContain('velho');
  });

  test('massa:comparar também atualiza a linha CA04 da matriz do índice', () => {
    const e = estado(ETAPAS.map((d) => ok(d.id)));
    const indice = renderizarIndice(lerTemplates().indice, { ...dadosRelatorio(e), determinismo: null });
    expect(indice).toContain('AGUARDA COMPARAÇÃO');
    const ok1 = atualizarDeterminismo(indice, { a: 'exec-A', b: 'exec-B', identico: true, divergencias: 0, em: 'agora' });
    expect(ok1).not.toContain('AGUARDA COMPARAÇÃO');
    expect(ok1).toContain('idêntico a exec-A');
    const div = atualizarDeterminismo(indice, { a: 'exec-A', b: 'exec-B', identico: false, divergencias: 3, em: 'agora' });
    expect(div).toContain('DIVERGENTE');
    expect(div).toContain('3 divergência(s) contra exec-A');
  });
});
