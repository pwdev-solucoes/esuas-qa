/**
 * Testes do plano 10 (#10994): exportador dos insumos para o api/ (UNIT-001), estado sintético das
 * chaves do seed, CLI `massa:conferir` (INT-001/INT-002), modo seed da E17 (UNIT-002), índice com a
 * modalidade híbrida (UNIT-003) e `massa:comparar --modo=api-x-seed`.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { chavesExigidas, executarConferencia, lerArgumentosConferir, NOME_CAMADA_DEMO } from '../bin/conferir.ts';
import { carregarConfig, sanitizar, type ConfigMassa, type Executor, type ResultadoComando } from './config.ts';
import { avaliarBloqueantesSeed, classificar, explicacoesDoModo, modoConferencia, type Divergencia, type Explicacao } from './esperado.ts';
import {
  CENARIOS_SOMENTE_VIA_SEED,
  estadoDeChaves,
  ETAPAS,
  lerArquivoChaves,
  lerEstado,
  MODALIDADE_HIBRIDA,
  origemHibrida,
  registrarEtapa,
  salvarEstado,
} from './execucao.ts';
import { lerElenco, lerInsumo } from './papeis.ts';
import { registrosDoElenco } from './registros.ts';
import { lerTemplates, renderizarIndice, type ManifestExecucao } from './relatorio.ts';
import { ARQUIVOS_API, DESTINO_PADRAO, executarExportacao, MANIFEST, ORIGEM_PADRAO } from '../scripts/exportar-api.ts';
import { CENARIO_ENT2, CENARIO_PERFIS, CENARIO_SEM_REF, classificarApiXSeed, executarComparacao, lerInsumosClassificacao, type DivergenciaSnapshot } from '../scripts/comparar.ts';

let pastaTemp: string;
test.beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'massa-conferencia-'));
});
test.afterEach(() => {
  rmSync(pastaTemp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// UNIT-001 — exportador dos insumos para o api/ (AC-001)
// ---------------------------------------------------------------------------------------------

test.describe('UNIT-001 (AC-001) — massa:insumos:exportar-api', () => {
  const copiarOrigem = (): string => {
    const origem = join(pastaTemp, 'origem');
    mkdirSync(origem);
    for (const f of [...ARQUIVOS_API, MANIFEST]) cpSync(resolve(ORIGEM_PADRAO, f), join(origem, f));
    return origem;
  };

  test('copia os 5 insumos + manifest derivado, confere sha e --verificar acusa divergência', () => {
    const origem = copiarOrigem();
    const destino = join(pastaTemp, 'api', 'massa-demo');
    mkdirSync(join(pastaTemp, 'api'));
    const log: string[] = [];
    expect(executarExportacao(['--verificar'], { origem, destino, log: (l) => log.push(l) }), 'cópia ausente diverge').toBe(1);
    expect(existsSync(destino), '--verificar não grava nada').toBe(false);

    expect(executarExportacao([], { origem, destino, log: (l) => log.push(l) })).toBe(0);
    for (const f of ARQUIVOS_API) expect(readFileSync(join(destino, f)).equals(readFileSync(join(origem, f)))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(destino, MANIFEST), 'utf8')) as { arquivos: Array<{ caminho: string; sha256: string }>; versao_elenco: string };
    expect(manifest.arquivos.map((a) => a.caminho)).toEqual([...ARQUIVOS_API]);
    for (const a of manifest.arquivos) expect(a.sha256).toBe(createHash('sha256').update(readFileSync(join(destino, a.caminho))).digest('hex'));
    expect(executarExportacao(['--verificar'], { origem, destino, log: () => undefined })).toBe(0);

    // cópia do api/ alterada → --verificar sai 1 e não corrige; sem a flag corrige
    writeFileSync(join(destino, 'esperado.json'), '{"adulterado":true}\n');
    const saida: string[] = [];
    expect(executarExportacao(['--verificar'], { origem, destino, log: (l) => saida.push(l) })).toBe(1);
    expect(saida.join('\n')).toMatch(/esperado\.json: diferente/);
    expect(readFileSync(join(destino, 'esperado.json'), 'utf8')).toContain('adulterado');
    expect(executarExportacao([], { origem, destino, log: () => undefined })).toBe(0);
    expect(executarExportacao(['--verificar'], { origem, destino, log: () => undefined })).toBe(0);
  });

  test('insumo do qa adulterado (sha ≠ manifest) é recusado sem gravar', () => {
    const origem = copiarOrigem();
    const destino = join(pastaTemp, 'api', 'massa-demo');
    mkdirSync(join(pastaTemp, 'api'));
    writeFileSync(join(origem, 'unidades-ficticias.json'), '{}\n');
    const log: string[] = [];
    expect(executarExportacao([], { origem, destino, log: (l) => log.push(l) })).toBe(2);
    expect(log.join('\n')).toMatch(/sha256 de unidades-ficticias\.json diverge/);
    expect(existsSync(destino)).toBe(false);
    expect(executarExportacao(['--forcar'], { origem, destino, log: () => undefined })).toBe(2);
  });

  test('a cópia versionada no api/ está sincronizada com o gerador', () => {
    test.skip(!existsSync(DESTINO_PADRAO), 'api/ não está ao lado do qa/');
    expect(executarExportacao(['--verificar'], { log: () => undefined })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Estado sintético a partir das chaves (AC-003)
// ---------------------------------------------------------------------------------------------

test.describe('Estado sintético das chaves do seed', () => {
  test('lê o formato do MassaDemoChaves (envelope) e o mapa plano; recusa origem diferente', () => {
    const envelope = lerArquivoChaves(JSON.stringify({ origem: 'seed', versao_elenco: '2026-09-29.1', chaves: { TENANT: 'a', TENANT_ID: 7 } }));
    expect(envelope).toEqual({ origem: 'seed', versao_elenco: '2026-09-29.1', chaves: { TENANT: 'a', TENANT_ID: '7' } });
    expect(lerArquivoChaves(JSON.stringify({ TENANT: 'a' })).chaves).toEqual({ TENANT: 'a' });
    expect(() => lerArquivoChaves(JSON.stringify({ origem: 'api', chaves: { TENANT: 'a' } }))).toThrow(/origem "api"/);
    expect(() => lerArquivoChaves('{x')).toThrow(/JSON válido/);
    expect(() => lerArquivoChaves(JSON.stringify({ origem: 'seed', chaves: {} }))).toThrow(/vazio/);
  });

  test('E00–E16 com origem manual/seed, E17–E20 livres para a conferência, modo seed', () => {
    const arquivo = lerArquivoChaves(JSON.stringify({ origem: 'seed', versao_elenco: 'v', chaves: { TENANT: 'x' } }));
    const estado = estadoDeChaves({ arquivo, arquivoNome: 'chaves.json', apiBase: 'http://api', evidencias: true, avisos: { E06: ['ACHADO RN14: P7'] } });
    expect(estado.modo).toBe('seed');
    expect(estado.modalidade).toBe(MODALIDADE_HIBRIDA);
    expect(estado.somenteViaSeed).toEqual([...CENARIOS_SOMENTE_VIA_SEED]);
    expect(estado.chaves.TENANT).toBe('x');
    expect(estado.ambiente).toEqual([]);
    const origem = Object.fromEntries(estado.etapas.map((e) => [e.etapa, e.origem]));
    expect(origem).toMatchObject({ E0: 'manual', E01: 'manual', E01b: 'manual', E01c: 'manual', E02: 'manual', E03: 'manual', E06a: 'seed', E04: 'seed', E16: 'seed' });
    for (const id of ['E00', 'E17', 'E18', 'E19', 'E20']) expect(origem[id]).toBeUndefined();
    expect(estado.etapas.every((e) => e.status === 'ok')).toBe(true);
    expect(estado.etapas.find((e) => e.etapa === 'E06')?.avisos).toEqual(['ACHADO RN14: P7']);
    expect(ETAPAS.map((e) => origemHibrida(e.id)).filter((o) => o === 'conferencia')).toHaveLength(5);

    const caminho = join(pastaTemp, 'estado.json');
    salvarEstado(caminho, estado);
    registrarEtapa(caminho, { etapa: 'E17', status: 'ok', duracao: 1, papel: 'M0', passos: [], avisos: [] });
    expect(lerEstado(caminho).estado.etapas.find((e) => e.etapa === 'E17')?.origem).toBe('conferencia');
  });
});

// ---------------------------------------------------------------------------------------------
// INT-001 / INT-002 — CLI massa:conferir (AC-002, AC-003)
// ---------------------------------------------------------------------------------------------

type Rota = (req: IncomingMessage, res: ServerResponse) => void;
const json =
  (status: number, corpo: unknown): Rota =>
  (_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(corpo));
  };

const DNE = Buffer.from('conteudo-dne-ficticio-para-teste');

async function subirStub(ambiente: string): Promise<{ url: string; chamadas: Array<{ metodo: string; caminho: string }>; fechar: () => Promise<void> }> {
  const chamadas: Array<{ metodo: string; caminho: string }> = [];
  const rotas: Record<string, Rota> = {
    'GET /api/environment': json(200, { environment: ambiente }),
    'GET /up': json(200, { status: 'up' }),
    'GET /mailpit/api/v1/info': json(200, { Version: 'stub' }),
  };
  const server: Server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      const caminho = (req.url ?? '/').split('?')[0]!;
      chamadas.push({ metodo: req.method ?? 'GET', caminho });
      if (caminho === '/dne.zip') {
        res.statusCode = 200;
        res.setHeader('content-length', String(DNE.length));
        res.end(req.method === 'HEAD' ? undefined : DNE);
        return;
      }
      const rota = rotas[`${req.method} ${caminho}`];
      if (rota) rota(req, res);
      else {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html');
        res.end('ok');
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chamadas,
    fechar: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function cfgStub(apiBase: string): ConfigMassa {
  return carregarConfig({
    env: {
      API_BASE: apiBase,
      ADMIN_URL: `${apiBase}/admin-front`,
      CLIENT_URL: `${apiBase}/client-front`,
      MAILPIT_URL: `${apiBase}/mailpit`,
      E2E_ADMIN_CPF: '98000000113',
      E2E_ADMIN_PASSWORD: 'SenhaStub#2026',
      MASSA_RESET_CMD: 'docker exec esuas-api php artisan migrate:fresh --seed --force',
      MASSA_CACHE_CLEAR_CMD: 'docker exec esuas-api php artisan cache:clear',
      MASSA_DOCKER_CONTAINERS: 'esuas-api,esuas-pgsql,esuas-queue,esuas-minio,esuas-mailpit',
      MASSA_DNE_URL: `${apiBase}/dne.zip`,
    },
  });
}

/** Arquivo de chaves completo (uuids fictícios) a partir do elenco real. */
function arquivoChaves(sem: string[] = []): { caminho: string; chaves: Record<string, string> } {
  const elenco = lerElenco();
  const entidades = lerInsumo<{ entidades: Array<{ chave: string }> }>('entidades-ficticias.json').entidades;
  const chaves: Record<string, string> = {};
  chavesExigidas(elenco, entidades, registrosDoElenco()).forEach((k, i) => {
    if (!sem.includes(k)) chaves[k] = k.startsWith('UNIT_ID_') ? String(i) : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  });
  const caminho = join(pastaTemp, 'chaves.json');
  writeFileSync(caminho, JSON.stringify({ origem: 'seed', versao_elenco: elenco.versao, chaves }));
  return { caminho, chaves };
}

/** Executor espião: stack saudável; o SQL da conferência responde com as contagens dadas. */
function espiao(contagens: (sql: string) => string) {
  const programas: string[] = [];
  const shells: string[] = [];
  const sqls: string[] = [];
  const ok = (saida = ''): ResultadoComando => ({ codigo: 0, saida, erro: '' });
  const executor: Executor = {
    programa(bin, args) {
      programas.push([bin, ...args].join(' '));
      if (bin === '/bin/sh') return ok('/usr/bin/docker');
      if (bin !== 'docker') return ok();
      if (args[0] === 'info') return ok('27.0.0');
      if (args[0] === 'inspect') return ok('running|healthy');
      if (args[0] === 'top') return ok('PID ARGS\n1 php artisan queue:work --tries=3');
      const sql = args.at(-1) ?? '';
      if (args[0] === 'exec' && /^SELECT/i.test(sql)) {
        sqls.push(sql);
        return ok(`BEGIN\n${contagens(sql)}\nROLLBACK\n`);
      }
      if (args[0] === 'exec') return ok('3.4 USE_GEOS=1');
      return ok();
    },
    shell(linha) {
      shells.push(linha);
      return ok();
    },
  };
  return { executor, programas, shells, sqls };
}

function contagensDoArquivo(chaves: Record<string, string>, ajuste: (n: number[]) => number[] = (n) => n): (sql: string) => string {
  const n = (re: RegExp) => Object.keys(chaves).filter((k) => re.test(k)).length;
  return (sql) => {
    if (sql.includes('FROM geo_layers')) return 'aaaaaaaa-0000-4000-8000-000000000001';
    return ajuste([1, 1, n(/^UNIT_(?!ID_)/), n(/^ENT_/), n(/^PROF_/), n(/^FAM_/), n(/^PES_/)]).join('|');
  };
}

test.describe('INT-001/INT-002 (AC-002, AC-003) — massa:conferir', () => {
  test('argumentos: --chaves e --evidencias obrigatórios; opção desconhecida recusa', async () => {
    expect(lerArgumentosConferir(['--chaves=x.json', '--evidencias'])).toEqual({ chaves: 'x.json', evidencias: true });
    expect(() => lerArgumentosConferir(['--confirmar-apagamento'])).toThrow(/desconhecida/);
    const log: string[] = [];
    expect(await executarConferencia({ chaves: null, evidencias: true }, { log: (l) => log.push(l) })).toBe(2);
    expect(await executarConferencia({ chaves: 'x', evidencias: null }, { log: (l) => log.push(l) })).toBe(2);
  });

  test('INT-001: só GET e SELECT; nenhum reset/shell; roda só E17–E20 com o estado do seed', async () => {
    const stub = await subirStub('local');
    const { caminho, chaves } = arquivoChaves();
    const esp = espiao(contagensDoArquivo(chaves));
    const etapas: string[] = [];
    const caminhoEstado = join(pastaTemp, 'estado.json');
    const logs: string[] = [];
    let relatorio: { pasta: string; codigo: number } | null = null;
    try {
      const codigo = await executarConferencia(
        { chaves: caminho, evidencias: true },
        {
          cfg: cfgStub(stub.url),
          executor: esp.executor,
          log: (l) => logs.push(sanitizar(l)),
          pastaCache: pastaTemp,
          caminhoEstado,
          pastaRelatorios: join(pastaTemp, 'relatorios'),
          timeoutMs: 1_000,
          rodarEtapa: (arquivo, estadoArq) => {
            etapas.push(arquivo);
            expect(estadoArq).toBe(caminhoEstado);
            return 0;
          },
          finalizar: (pasta, _estado, _o, c) => {
            relatorio = { pasta, codigo: c };
            return join(pasta, 'index.html');
          },
        },
      );
      expect(codigo, logs.join('\n')).toBe(0);
    } finally {
      await stub.fechar();
    }
    expect(etapas).toEqual(['e17-apuracao.spec.ts', 'e18-remessa.spec.ts', 'e19-painel-geo.spec.ts', 'e20-verificacao.spec.ts']);
    expect(esp.shells, 'nenhum MASSA_RESET_CMD / cache clear / comando de shell').toEqual([]);
    expect(stub.chamadas.filter((c) => !['GET', 'HEAD'].includes(c.metodo)), 'nenhum POST/PUT/PATCH/DELETE').toEqual([]);
    expect(stub.chamadas.filter((c) => c.caminho === '/api/environment').length, 'preflight + 2ª trava').toBeGreaterThanOrEqual(2);
    expect(esp.sqls.length).toBe(2);
    expect(esp.programas.some((p) => /artisan|migrate|db:seed|massa-demo/.test(p)), 'nenhum artisan').toBe(false);
    const { estado } = lerEstado(caminhoEstado);
    expect(estado.modo).toBe('seed');
    expect(estado.chaves.GEO_CAMADA_DEMO, 'camada do passo manual resolvida no banco').toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(estado.ambiente.map((a) => a.momento)).toEqual(['preflight', 'antes_do_reset']);
    expect(estado.etapas.find((e) => e.etapa === 'E00')?.origem).toBe('conferencia');
    expect(estado.etapas.find((e) => e.etapa === 'E06')?.avisos.join(' ')).toMatch(/P7: permissão avulsa "attendance-reports\.view"/);
    expect(relatorio).not.toBeNull();
    expect(esp.sqls[1]).toContain(NOME_CAMADA_DEMO);
  });

  test('INT-002: produção recusa no preflight, antes de qualquer SQL e etapa', async () => {
    const stub = await subirStub('production');
    const { caminho, chaves } = arquivoChaves();
    const esp = espiao(contagensDoArquivo(chaves));
    let rodou = false;
    try {
      const codigo = await executarConferencia(
        { chaves: caminho, evidencias: false },
        { cfg: cfgStub(stub.url), executor: esp.executor, log: () => undefined, pastaCache: pastaTemp, caminhoEstado: join(pastaTemp, 'e.json'), timeoutMs: 1_000, rodarEtapa: () => ((rodou = true), 0) },
      );
      expect(codigo).toBe(1);
    } finally {
      await stub.fechar();
    }
    expect(esp.sqls).toEqual([]);
    expect(rodou).toBe(false);
    expect(existsSync(join(pastaTemp, 'e.json'))).toBe(false);
  });

  test('INT-002: chaves inexistentes no banco ou ausentes no arquivo recusam sem rodar etapas', async () => {
    for (const [nome, prep] of [
      ['família ausente no banco', () => ({ ...arquivoChaves(), ajuste: (n: number[]) => n.map((v, i) => (i === 5 ? v - 1 : v)) })],
      ['organização ausente no banco', () => ({ ...arquivoChaves(), ajuste: (n: number[]) => [0, ...n.slice(1)] })],
      ['chave ausente no arquivo', () => ({ ...arquivoChaves(['FAM_F-ENC']), ajuste: (n: number[]) => n })],
    ] as const) {
      const stub = await subirStub('local');
      const { caminho, chaves, ajuste } = prep();
      const esp = espiao(contagensDoArquivo(chaves, ajuste));
      const logs: string[] = [];
      let rodou = false;
      try {
        const codigo = await executarConferencia(
          { chaves: caminho, evidencias: false },
          { cfg: cfgStub(stub.url), executor: esp.executor, log: (l) => logs.push(l), pastaCache: pastaTemp, caminhoEstado: join(pastaTemp, 'e.json'), timeoutMs: 1_000, rodarEtapa: () => ((rodou = true), 0) },
        );
        expect(codigo, nome).toBe(1);
      } finally {
        await stub.fechar();
      }
      expect(rodou, nome).toBe(false);
      expect(logs.join('\n'), nome).toMatch(/Conferência recusada/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// UNIT-002 — modo seed sem explicações RN14 (AC-004)
// ---------------------------------------------------------------------------------------------

test.describe('UNIT-002 (AC-004) — modo seed na E17', () => {
  const div: Divergencia = { mes: null, unidade: null, contador: 'pendencia.entity_without_cneas', esperado: 1, apurado: 0, motivo: 'diferente' };
  const explica: Explicacao = (d) => (d.contador === 'pendencia.entity_without_cneas' ? 'ENT-2 recusada pela API' : null);

  test('a mesma divergência é "explicada" no modo api e ✖ bloqueante no modo seed', () => {
    const api = classificar([div], explicacoesDoModo('api', [explica]));
    expect(api.explicadas).toHaveLength(1);
    expect(api.bloqueantes).toHaveLength(0);
    const seed = classificar([div], explicacoesDoModo('seed', [explica]));
    expect(seed.explicadas).toHaveLength(0);
    expect(seed.bloqueantes).toEqual([{ ...div, explicacao: null }]);
  });

  test('E18 modo seed: só a NumeroCNEAS da ENT-2 com can_generate=false passa (sem POST); bloqueante extra falha', () => {
    const ent2 = '4e21044e-7be1-51f2-951a-699c8fc1320a';
    const cneas = { kind: 'record_incomplete', field_name: 'NumeroCNEAS', subject_type: 'social_entity', subject_uuid: ent2 };
    expect(avaliarBloqueantesSeed([cneas], ent2, false)).toEqual([]);
    expect(avaliarBloqueantesSeed([cneas, { kind: 'record_incomplete', field_name: 'CEP', subject_type: 'social_unit', subject_uuid: 'u' }], ent2, false).join()).toMatch(/além da ENT-2: record_incomplete\/CEP\/social_unit/);
    expect(avaliarBloqueantesSeed([{ ...cneas, subject_uuid: 'outra-entidade' }], ent2, false).join()).toMatch(/não está entre as bloqueantes/);
    expect(avaliarBloqueantesSeed([], ent2, true)).toHaveLength(2);
    expect(avaliarBloqueantesSeed([cneas], ent2, true).join()).toMatch(/can_generate = true/);
    // a E18 do modo seed retorna antes do POST de siap-remittances (só a geração do modo API o faz)
    const fonte = readFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'etapas', 'e18-remessa.spec.ts'), 'utf8');
    const ramoSeed = fonte.slice(fonte.indexOf('if (modoSeed) {\n    const motivos'), fonte.indexOf('// 18.3 — geração'));
    expect(ramoSeed).toContain('return;');
    expect(ramoSeed).not.toMatch(/master\.post|siap-remittances`/);
  });

  test('modo vem do estado (ausente = api)', () => {
    expect(modoConferencia({})).toBe('api');
    expect(modoConferencia({ modo: 'api' })).toBe('api');
    expect(modoConferencia({ modo: 'seed' })).toBe('seed');
  });
});

// ---------------------------------------------------------------------------------------------
// UNIT-003 — índice com modalidade, origem por etapa e cenários só via seed (AC-007)
// ---------------------------------------------------------------------------------------------

test.describe('UNIT-003 (AC-007) — índice da conferência híbrida', () => {
  const manifest = (id: string): ManifestExecucao => ({
    execucao: id,
    pasta: 'x',
    iniciada_em: new Date().toISOString(),
    concluida_em: null,
    ambiente: 'local',
    api: { base: 'http://api', versao: null },
    qa: { versao: null },
    elenco: { versao: 'v' },
    insumos: { manifest_sha256: null },
    dne: null,
    flags: {},
    resultado: 'concluída',
  });
  const dados = (estado: ReturnType<typeof estadoDeChaves>) => ({
    estado,
    evidencias: {},
    elenco: lerInsumo<never>('elenco.json'),
    esperado: lerInsumo<never>('esperado.json'),
    snapshot: null,
    manifest: manifest(estado.id),
  });

  test('mostra a modalidade híbrida, a origem de cada etapa e os cenários só via seed', () => {
    const estado = estadoDeChaves({ arquivo: { origem: 'seed', versao_elenco: null, chaves: { TENANT: 'x' } }, arquivoNome: 'chaves.json', apiBase: 'http://api', evidencias: true });
    const html = renderizarIndice(lerTemplates().indice, dados(estado));
    expect(html).toContain(MODALIDADE_HIBRIDA.replace('·', '&middot;').replace(/&middot;/g, '·'));
    expect(html).toContain('<th>Origem</th>');
    expect(html).toMatch(/<td>E03<\/td><td>[^<]*<\/td><td>manual<\/td>/);
    expect(html).toMatch(/<td>E10<\/td><td>[^<]*<\/td><td>seed<\/td>/);
    expect(html).toMatch(/<td>E17<\/td><td>[^<]*<\/td><td>conferência<\/td>/);
    expect(html).toContain('Cenários só via seed');
    for (const c of CENARIOS_SOMENTE_VIA_SEED) expect(html).toContain(c.replace(/&/g, '&amp;').replace(/'/g, '&#39;'));
  });

  test('execução pela API: modalidade API e origem API, sem a lista do seed', () => {
    const estado = estadoDeChaves({ arquivo: { origem: 'seed', versao_elenco: null, chaves: { TENANT: 'x' } }, arquivoNome: 'c', apiBase: 'http://api', evidencias: true });
    delete estado.modo;
    delete estado.modalidade;
    delete estado.somenteViaSeed;
    estado.etapas = [];
    const html = renderizarIndice(lerTemplates().indice, dados(estado));
    expect(html).toContain('API: E1–E20 pelo executor da massa');
    expect(html).toMatch(/<td>E10<\/td><td>[^<]*<\/td><td>API<\/td>/);
    expect(html).not.toContain('Cenários só via seed');
  });
});

// ---------------------------------------------------------------------------------------------
// massa:comparar --modo=api-x-seed (AC-006)
// ---------------------------------------------------------------------------------------------

test.describe('massa:comparar --modo=api-x-seed (AC-006)', () => {
  const ins = lerInsumosClassificacao();
  const chavePerfil = [...ins.contadores.keys()].find((k) => k.endsWith('|new_families_profile.profile_bolsa_familia') && (ins.contadores.get(k) ?? 0) > 0)!;
  const valorPerfil = ins.contadores.get(chavePerfil)!;
  const pessoaSemRef = [...ins.pessoasSemRef][0]!;

  test('classifica por cenário só via seed; o resto é inesperado', () => {
    const ds: DivergenciaSnapshot[] = [
      { caminho: 'tabelas.entidades', chave: 'ENT_ENT-2', a: null, b: { chave: 'ENT_ENT-2' } },
      { caminho: 'tabelas.familias', chave: 'FAM_F-SEM-REF-1', a: null, b: {} },
      { caminho: 'tabelas.integrantes', chave: 'FAM_F-SEM-REF-1/PES_PES-028', a: null, b: {} },
      { caminho: 'tabelas.pessoas', chave: pessoaSemRef, a: null, b: {} },
      { caminho: 'apuracao', chave: chavePerfil, a: 0, b: valorPerfil },
      { caminho: 'pendencias', chave: '2026-07|family_without_reference_unit|tenant|-', a: null, b: { count: 3 } },
      { caminho: 'pendencias.count', chave: '2026-07|entity_without_cneas|tenant|-', a: 0, b: 1 },
      { caminho: 'tabelas.remessas', chave: 'SIAP_REMESSA', a: { status: 'completed' }, b: null },
      // inesperadas
      { caminho: 'apuracao', chave: chavePerfil, a: 0, b: valorPerfil + 1 },
      { caminho: 'apuracao', chave: '2026-07|U-CN|total_attendances', a: 10, b: 11 },
      { caminho: 'tabelas.familias', chave: 'FAM_F-ENC', a: { situacao: 'active' }, b: { situacao: 'inactive' } },
      { caminho: 'tabelas.entidades', chave: 'ENT_ENT-1', a: null, b: {} },
      { caminho: 'pendencias', chave: '2026-07|family_without_reference_unit|tenant|-', a: null, b: { count: 2 } },
    ];
    const { esperadas, inesperadas } = classificarApiXSeed(ds, ins);
    expect(esperadas.map((e) => e.cenario)).toEqual([CENARIO_ENT2, CENARIO_SEM_REF, CENARIO_SEM_REF, CENARIO_SEM_REF, CENARIO_PERFIS, CENARIO_SEM_REF, CENARIO_ENT2, CENARIO_ENT2]);
    expect(inesperadas).toHaveLength(5);
  });

  test('sai 0 só com divergências esperadas e 1 com inesperada; modo inválido = 2', () => {
    const base = { formato: 1, meta: { execucao: 'x', gerado_em: 'y' }, elenco: 'v', organizacao: { nome: 'Org' }, pendencias: [] };
    const a = { ...base, tabelas: { entidades: [{ chave: 'ENT_ENT-1', nome: 'E1' }] }, apuracao: { [chavePerfil]: 0 } };
    const b = { ...base, tabelas: { entidades: [{ chave: 'ENT_ENT-1', nome: 'E1' }, { chave: 'ENT_ENT-2', nome: 'E2' }] }, apuracao: { [chavePerfil]: valorPerfil } };
    const pa = join(pastaTemp, 'api');
    const pb = join(pastaTemp, 'seed');
    mkdirSync(pa);
    mkdirSync(pb);
    writeFileSync(join(pa, 'snapshot.json'), JSON.stringify(a));
    writeFileSync(join(pb, 'snapshot.json'), JSON.stringify(b));
    const log: string[] = [];
    expect(executarComparacao(['--modo=api-x-seed', pa, pb], (l) => log.push(l), ins)).toBe(0);
    expect(log.join('\n')).toMatch(/2 esperada\(s\).*0 inesperada/);
    const gravado = JSON.parse(readFileSync(join(pb, 'comparacao-api-x-seed.json'), 'utf8')) as { esperadas: number; inesperadas: number };
    expect(gravado).toMatchObject({ esperadas: 2, inesperadas: 0 });
    expect(existsSync(join(pb, 'determinismo.json')), 'não mexe no Determinismo').toBe(false);

    writeFileSync(join(pb, 'snapshot.json'), JSON.stringify({ ...b, organizacao: { nome: 'Outra' } }));
    expect(executarComparacao(['--modo=api-x-seed', pa, pb], () => undefined, ins)).toBe(1);
    expect(executarComparacao(['--modo=outro', pa, pb], () => undefined, ins)).toBe(2);
    expect(executarComparacao([pa, pb], () => undefined), 'modo padrão (determinismo) continua exigindo igualdade').toBe(1);
  });
});
