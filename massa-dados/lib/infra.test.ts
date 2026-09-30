/**
 * INT-001…INT-011 — infraestrutura do executor da massa (#10994 · plano 03).
 *
 * Tudo com servidores HTTP stub locais e executor de comandos espião: nenhum teste toca a stack
 * real, exceto INT-009/INT-011, que só rodam com `MASSA_INT_REAL=1` e credenciais no ambiente.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { executarFluxo, lerArgumentos, type OpcoesCli } from '../bin/massa.ts';
import { consultarAmbiente, exigirNaoProducao, MENSAGEM_PRODUCAO, RecusaAmbiente } from './ambiente.ts';
import { carregarConfig, executorPadrao, sanitizar, type ConfigMassa, type Executor, type ResultadoComando } from './config.ts';
import { caminhoLocalDne, FalhaDne, obterDne } from './dne.ts';
import { lerEstado } from './execucao.ts';
import { ClientePapel } from './http.ts';
import { definirSenha, extrairLinkRedefinicao, lerLink } from './mailpit.ts';
import { containerDoComando, executarPreflight } from './preflight.ts';
import { ApagamentoNaoConfirmado, comandoQueueRestart, confirmarApagamento, executarReset, FalhaReset } from './reset.ts';

// ---------------------------------------------------------------------------------------------
// Utilitários de stub
// ---------------------------------------------------------------------------------------------

type Rota = (req: IncomingMessage, res: ServerResponse, corpo: string) => void;

interface Stub {
  url: string;
  chamadas: Array<{ metodo: string; caminho: string }>;
  rotas: Map<string, Rota>;
  fechar(): Promise<void>;
}

async function subirStub(rotas: Record<string, Rota> = {}): Promise<Stub> {
  const mapa = new Map(Object.entries(rotas));
  const chamadas: Stub['chamadas'] = [];
  const server: Server = createServer((req, res) => {
    let corpo = '';
    req.on('data', (p) => (corpo += p));
    req.on('end', () => {
      const caminho = (req.url ?? '/').split('?')[0];
      chamadas.push({ metodo: req.method ?? 'GET', caminho });
      const rota = mapa.get(`${req.method} ${caminho}`) ?? mapa.get(`* ${caminho}`);
      if (rota) rota(req, res, corpo);
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
    rotas: mapa,
    fechar: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const json =
  (status: number, corpo: unknown): Rota =>
  (_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
  };

/** Executor espião: registra tudo; `docker` responde como uma stack saudável, salvo sobrescrita. */
function executorEspiao(sobrescrever: (bin: string, args: string[]) => ResultadoComando | undefined = () => undefined) {
  const programas: string[] = [];
  const shells: string[] = [];
  const ok = (saida = ''): ResultadoComando => ({ codigo: 0, saida, erro: '' });
  const executor: Executor = {
    programa(bin, args) {
      programas.push([bin, ...args].join(' '));
      const s = sobrescrever(bin, args);
      if (s) return s;
      if (bin === '/bin/sh') return ok('/usr/bin/docker');
      if (bin !== 'docker') return ok();
      if (args[0] === 'info') return ok('27.0.0');
      if (args[0] === 'inspect') return ok('running|healthy');
      if (args[0] === 'top') return ok('PID ARGS\n1 php artisan queue:work --tries=3');
      if (args[0] === 'exec') return ok('3.4 USE_GEOS=1');
      return ok();
    },
    shell(linha) {
      shells.push(linha);
      return ok();
    },
  };
  return { executor, programas, shells };
}

function carregarConfigStub(apiBase: string): ConfigMassa {
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

const DNE = Buffer.from('conteudo-dne-ficticio-para-teste');
const SHA_DNE = createHash('sha256').update(DNE).digest('hex');

/** Rotas de uma stack saudável (ambiente parametrizável). */
function rotasSaudaveis(ambiente: () => Rota): Record<string, Rota> {
  return {
    'GET /api/environment': (req, res, c) => ambiente()(req, res, c),
    'GET /up': json(200, { status: 'up' }),
    'GET /mailpit/api/v1/info': json(200, { Version: 'stub' }),
    '* /dne.zip': (req, res) => {
      res.statusCode = 200;
      res.setHeader('content-length', String(DNE.length));
      res.end(req.method === 'HEAD' ? undefined : DNE);
    },
  };
}

const METODOS_LEITURA = new Set(['GET', 'HEAD']);
const OPCOES_EXECUCAO: OpcoesCli = { verificar: false, evidencias: false, confirmarApagamento: true, ate: null };

let pastaTemp: string;
test.beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'massa-infra-'));
});
test.afterEach(() => {
  rmSync(pastaTemp, { recursive: true, force: true });
});

function depsFluxo(stub: Stub, espiao: ReturnType<typeof executorEspiao>, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      cfg: carregarConfigStub(stub.url),
      executor: espiao.executor,
      interativo: false,
      log: (l: string) => logs.push(sanitizar(l)),
      pastaCache: pastaTemp,
      caminhoEstado: join(pastaTemp, 'estado.json'),
      rodarEtapa: () => 0,
      timeoutMs: 1_000,
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------------------------

test.describe('INT-002/003 (AC-002, AC-003) — trava de produção fail-closed', () => {
  for (const valor of ['production', 'prod', 'PRODUCTION']) {
    test(`recusa "${valor}" com a mensagem do CA02`, async () => {
      const stub = await subirStub({ 'GET /api/environment': json(200, { environment: valor }) });
      try {
        const r = await consultarAmbiente(stub.url);
        expect(r.ok).toBe(false);
        expect(r.mensagem).toBe(MENSAGEM_PRODUCAO);
        await expect(exigirNaoProducao(stub.url)).rejects.toBeInstanceOf(RecusaAmbiente);
      } finally {
        await stub.fechar();
      }
    });
  }

  const variantes: Array<[string, Rota | null, RegExp]> = [
    ['timeout', () => undefined /* nunca responde */, /tempo esgotado/],
    ['HTTP 500', json(500, { message: 'erro' }), /HTTP 500/],
    ['JSON inválido', json(200, '{environment: local'), /não é JSON válido/],
    ['sem a chave environment', json(200, { env: 'local' }), /ausente/],
    ['valor fora da allowlist "prd"', json(200, { environment: 'prd' }), /"prd", fora da lista permitida/],
    ['valor fora da allowlist "live"', json(200, { environment: 'live' }), /"live", fora da lista permitida/],
    ['rede indisponível', null, /erro de rede/],
  ];
  for (const [nome, rota, padrao] of variantes) {
    test(`CA02b — ${nome} → recusa`, async () => {
      const stub = await subirStub(rota ? { 'GET /api/environment': rota } : {});
      const base = rota ? stub.url : 'http://127.0.0.1:9';
      try {
        const r = await consultarAmbiente(base, { timeoutMs: 400 });
        expect(r.ok).toBe(false);
        expect(r.mensagem).toMatch(/^Geração recusada: /);
        expect(r.mensagem).toMatch(padrao);
        expect(r.mensagem).toMatch(/Nenhum registro foi criado\.$/);
      } finally {
        await stub.fechar();
      }
    });
  }

  for (const valor of ['local', 'testing', 'staging']) {
    test(`libera "${valor}" (allowlist)`, async () => {
      const stub = await subirStub({ 'GET /api/environment': json(200, { environment: valor }) });
      try {
        await expect(exigirNaoProducao(stub.url)).resolves.toBe(valor);
      } finally {
        await stub.fechar();
      }
    });
  }

  test('CA02 no fluxo: "production" aborta antes do aviso, do reset e de qualquer escrita', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'production' })));
    const espiao = executorEspiao();
    const { deps, logs } = depsFluxo(stub, espiao);
    try {
      const codigo = await executarFluxo(OPCOES_EXECUCAO, deps);
      expect(codigo).not.toBe(0);
      expect(espiao.shells).toEqual([]);
      expect(stub.chamadas.every((c) => METODOS_LEITURA.has(c.metodo))).toBe(true);
      expect(logs.join('\n')).toContain(MENSAGEM_PRODUCAO);
      expect(logs.join('\n')).not.toContain('ATENÇÃO: esta execução APAGA');
    } finally {
      await stub.fechar();
    }
  });
});

test.describe('INT-004 (AC-004) — a trava roda duas vezes', () => {
  test('1ª checagem "local", 2ª "production" → aborta antes do reset', async () => {
    let n = 0;
    const stub = await subirStub(rotasSaudaveis(() => (n++ === 0 ? json(200, { environment: 'local' }) : json(200, { environment: 'production' }))));
    const espiao = executorEspiao();
    const { deps, logs } = depsFluxo(stub, espiao);
    try {
      const codigo = await executarFluxo(OPCOES_EXECUCAO, deps);
      expect(codigo).toBe(1);
      expect(stub.chamadas.filter((c) => c.caminho === '/api/environment')).toHaveLength(2);
      expect(espiao.shells).toEqual([]);
      expect(logs.join('\n')).toContain('ATENÇÃO: esta execução APAGA');
      expect(logs.join('\n')).toContain(MENSAGEM_PRODUCAO);
      const { estado } = lerEstado(deps.caminhoEstado);
      expect(estado.ambiente.map((a) => [a.momento, a.ok])).toEqual([
        ['preflight', true],
        ['antes_do_reset', false],
      ]);
      expect(estado.reset).toBeUndefined();
    } finally {
      await stub.fechar();
    }
  });

  test('2ª checagem com falha de rede também aborta', async () => {
    let n = 0;
    const stub = await subirStub(
      rotasSaudaveis(() =>
        n++ === 0
          ? json(200, { environment: 'local' })
          : (_q, res) => {
              res.destroy();
            },
      ),
    );
    const espiao = executorEspiao();
    const { deps } = depsFluxo(stub, espiao);
    try {
      expect(await executarFluxo(OPCOES_EXECUCAO, deps)).toBe(1);
      expect(espiao.shells).toEqual([]);
    } finally {
      await stub.fechar();
    }
  });

  test('caminho feliz: 2 checagens → reset, queue:restart, cache:clear → DNE → etapas', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    const espiao = executorEspiao();
    const etapas: string[] = [];
    const { deps } = depsFluxo(stub, espiao, {
      rodarEtapa: (arquivo: string) => {
        etapas.push(arquivo);
        return 0;
      },
    });
    try {
      expect(await executarFluxo({ ...OPCOES_EXECUCAO, ate: 'E00' }, deps)).toBe(0);
      expect(espiao.shells).toEqual([
        'docker exec esuas-api php artisan migrate:fresh --seed --force',
        'docker exec esuas-api php artisan queue:restart',
        'docker exec esuas-api php artisan cache:clear',
      ]);
      expect(etapas).toEqual(['e00-preflight.spec.ts']);
      const { estado } = lerEstado(deps.caminhoEstado);
      expect(estado.dne?.sha256).toBe(SHA_DNE);
      expect(estado.etapas.find((e) => e.etapa === 'E0')?.status).toBe('nao_executada');
      expect(stub.chamadas.filter((c) => c.caminho === '/api/environment')).toHaveLength(2);
    } finally {
      await stub.fechar();
    }
  });
});

test.describe('INT-001/005 (AC-001, AC-005) — preflight só lê e bloqueia antes do aviso', () => {
  test('preflight: só GET/HEAD, nenhum comando de shell, reset nunca executado', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    const espiao = executorEspiao();
    try {
      const r = await executarPreflight(carregarConfigStub(stub.url), { executor: espiao.executor, pastaCache: pastaTemp, timeoutMs: 1_000 });
      expect(stub.chamadas.length).toBeGreaterThan(0);
      expect(stub.chamadas.filter((c) => !METODOS_LEITURA.has(c.metodo))).toEqual([]);
      expect(espiao.shells).toEqual([]);
      expect(espiao.programas.some((p) => p.includes('migrate:fresh'))).toBe(false);
      for (const familia of ['insumos', 'dne', 'docker', 'servicos', 'config', 'ferramental']) {
        expect(r.itens.some((i) => i.familia === familia), `família ${familia}`).toBe(true);
      }
      expect(r.itens.every((i) => i.mensagem.length > 0)).toBe(true);
    } finally {
      await stub.fechar();
    }
  });

  test('--verificar: nenhuma escrita, código 0 quando APTO e sem reset', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    const espiao = executorEspiao();
    const { deps, logs } = depsFluxo(stub, espiao);
    try {
      const codigo = await executarFluxo(lerArgumentos(['--verificar']), deps);
      const falhas = logs.filter((l) => l.includes('✖'));
      expect(falhas, falhas.join('\n')).toEqual([]);
      expect(codigo).toBe(0);
      expect(espiao.shells).toEqual([]);
      expect(stub.chamadas.every((c) => METODOS_LEITURA.has(c.metodo))).toBe(true);
    } finally {
      await stub.fechar();
    }
  });

  test('CA-T1: worker de fila parado → ✖ com `docker start`, termina antes do aviso e sem reset', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    const espiao = executorEspiao((bin, args) =>
      bin === 'docker' && args[0] === 'inspect' && args.at(-1) === 'esuas-queue' ? { codigo: 0, saida: 'exited|', erro: '' } : undefined,
    );
    const perguntas: string[] = [];
    const { deps, logs } = depsFluxo(stub, espiao, { interativo: true, perguntar: async (p: string) => (perguntas.push(p), 'local') });
    try {
      const codigo = await executarFluxo({ ...OPCOES_EXECUCAO, confirmarApagamento: false }, deps);
      expect(codigo).toBe(1);
      const saida = logs.join('\n');
      expect(saida).toMatch(/✖ docker · worker de fila: worker de fila parado: rode `docker start esuas-queue`/);
      expect(saida).toContain('Resultado: INAPTO');
      expect(saida).not.toContain('ATENÇÃO: esta execução APAGA');
      expect(perguntas).toEqual([]);
      expect(espiao.shells).toEqual([]);
    } finally {
      await stub.fechar();
    }
  });

  test('reset apontando para container fora da lista → ✖ (proteção do banco errado)', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    const cfg = { ...carregarConfigStub(stub.url), resetCmd: 'docker exec -u sail outro-api php artisan migrate:fresh --seed' };
    try {
      const r = await executarPreflight(cfg, { executor: executorEspiao().executor, pastaCache: pastaTemp, timeoutMs: 1_000 });
      expect(r.apto).toBe(false);
      expect(r.itens.find((i) => i.nome === 'MASSA_RESET_CMD')?.mensagem).toContain('"outro-api"');
      expect(containerDoComando('docker exec -u sail outro-api php').container).toBe('outro-api');
    } finally {
      await stub.fechar();
    }
  });
});

test.describe('INT-006 (AC-006) — confirmação do apagamento (RN-T3)', () => {
  test('sem TTY e sem --confirmar-apagamento → aborta', async () => {
    await expect(confirmarApagamento({ environment: 'local', interativo: false, flagConfirmacao: false })).rejects.toBeInstanceOf(ApagamentoNaoConfirmado);
  });
  test('com TTY, texto diferente do ambiente → aborta', async () => {
    await expect(
      confirmarApagamento({ environment: 'local', interativo: true, flagConfirmacao: false, perguntar: async () => 'sim' }),
    ).rejects.toThrow(/diferente do ambiente "local"/);
  });
  test('com TTY, texto igual ao ambiente → prossegue', async () => {
    await expect(confirmarApagamento({ environment: 'local', interativo: true, flagConfirmacao: false, perguntar: async () => ' local ' })).resolves.toBe('digitado');
  });
  test('com a flag → prossegue sem perguntar', async () => {
    await expect(confirmarApagamento({ environment: 'staging', interativo: false, flagConfirmacao: true })).resolves.toBe('flag');
  });
  test('fluxo sem TTY e sem a flag: aborta após o aviso, antes da 2ª trava e do reset', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    const espiao = executorEspiao();
    const { deps } = depsFluxo(stub, espiao);
    try {
      expect(await executarFluxo({ ...OPCOES_EXECUCAO, confirmarApagamento: false }, deps)).toBe(1);
      expect(stub.chamadas.filter((c) => c.caminho === '/api/environment')).toHaveLength(1);
      expect(espiao.shells).toEqual([]);
    } finally {
      await stub.fechar();
    }
  });
  test('sem TTY e sem --evidencias/--sem-evidencias → código 2 antes de tudo', async () => {
    const stub = await subirStub();
    const espiao = executorEspiao();
    const { deps } = depsFluxo(stub, espiao);
    try {
      expect(await executarFluxo({ ...OPCOES_EXECUCAO, evidencias: null }, deps)).toBe(2);
      expect(stub.chamadas).toEqual([]);
    } finally {
      await stub.fechar();
    }
  });
});

test.describe('INT-007 (AC-007) — reset externo', () => {
  const base = (reset: string, cache = 'true', fila = 'true'): ConfigMassa => ({
    ...carregarConfigStub('http://127.0.0.1:9'),
    resetCmd: reset,
    cacheClearCmd: cache,
    queueRestartCmd: fila,
  });
  test('executa reset, queue:restart e cache clear (comandos reais `true`)', () => {
    const passos = executarReset(base('true'), { executor: executorPadrao });
    expect(passos.map((p) => [p.nome, p.codigo])).toEqual([
      ['reset', 0],
      ['queue:restart', 0],
      ['cache:clear', 0],
    ]);
  });
  test('código ≠ 0 no reset aborta antes do queue:restart', () => {
    let erro: unknown;
    try {
      executarReset(base('false'), { executor: executorPadrao });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(FalhaReset);
    expect((erro as FalhaReset).passo.nome).toBe('reset');
  });
  test('código ≠ 0 no cache clear também aborta', () => {
    expect(() => executarReset(base('true', 'false'), { executor: executorPadrao })).toThrow(/cache:clear/);
  });
  test('queue:restart derivado do comando de reset', () => {
    expect(comandoQueueRestart({ resetCmd: './vendor/bin/sail artisan migrate:fresh --seed', queueRestartCmd: '' })).toBe('./vendor/bin/sail artisan queue:restart');
  });
});

test.describe('INT-008 (AC-008) — DNE em cache por sha256', () => {
  test('baixa, confere o sha, reaproveita o cache e aborta em sha divergente', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    try {
      const url = `${stub.url}/dne.zip`;
      const a = await obterDne({ url, sha256: SHA_DNE, pastaCache: pastaTemp });
      expect(a).toMatchObject({ sha256: SHA_DNE, bytes: DNE.length, doCache: false });
      const b = await obterDne({ url, sha256: SHA_DNE, pastaCache: pastaTemp });
      expect(b.doCache).toBe(true);
      expect(stub.chamadas.filter((c) => c.caminho === '/dne.zip')).toHaveLength(1);

      // sem MASSA_DNE_SHA256: reaproveita o último download da MESMA URL se o arquivo confere
      expect((await obterDne({ url, pastaCache: pastaTemp })).doCache).toBe(true);
      expect(stub.chamadas.filter((c) => c.caminho === '/dne.zip')).toHaveLength(1);

      await expect(obterDne({ url, sha256: 'a'.repeat(64), pastaCache: pastaTemp })).rejects.toBeInstanceOf(FalhaDne);
      await expect(obterDne({ url: `${stub.url}/nao-existe`, sha256: 'b'.repeat(64), pastaCache: pastaTemp, fetchImpl: async () => new Response('x', { status: 404 }) })).rejects.toThrow(/HTTP 404/);

      writeFileSync(join(pastaTemp, 'dne', `${SHA_DNE}.zip`), 'corrompido');
      const refeito = await obterDne({ url, sha256: SHA_DNE, pastaCache: pastaTemp });
      expect(refeito.doCache).toBe(false);
    } finally {
      await stub.fechar();
    }
  });
});

test.describe('INT-008b (AC-008) — DNE em arquivo local', () => {
  test('caminhoLocalDne: http(s) é remoto; absoluto, relativo ao qa/ e file:// são locais', () => {
    expect(caminhoLocalDne('https://exemplo.test/dne.zip')).toBeNull();
    expect(caminhoLocalDne('HTTP://exemplo.test/dne.zip')).toBeNull();
    expect(caminhoLocalDne('/tmp/dne.zip')).toBe('/tmp/dne.zip');
    expect(caminhoLocalDne('docs/dne.zip', '/raiz/qa')).toBe('/raiz/qa/docs/dne.zip');
    expect(caminhoLocalDne('file:///tmp/dne.zip')).toBe('/tmp/dne.zip');
  });

  test('usa o arquivo onde está, sem baixar nem copiar, e confere o sha quando definido', async () => {
    const arquivo = join(pastaTemp, 'baseceps.zip');
    writeFileSync(arquivo, DNE);
    const cache = join(pastaTemp, 'cache');
    let baixou = false;
    const fetchImpl = (async () => {
      baixou = true;
      return new Response('x');
    }) as typeof fetch;

    const r = await obterDne({ url: arquivo, sha256: SHA_DNE, pastaCache: cache, fetchImpl });
    expect(r).toMatchObject({ arquivo, sha256: SHA_DNE, bytes: DNE.length, doCache: false, local: true });
    expect((await obterDne({ url: `file://${arquivo}`, pastaCache: cache, fetchImpl })).sha256).toBe(SHA_DNE);
    expect(baixou).toBe(false);
    expect(existsSync(cache)).toBe(false);

    await expect(obterDne({ url: arquivo, sha256: 'c'.repeat(64), pastaCache: cache })).rejects.toThrow(/divergente/);
    await expect(obterDne({ url: join(pastaTemp, 'nao-existe.zip'), pastaCache: cache })).rejects.toThrow(/não encontrado/);
    writeFileSync(join(pastaTemp, 'vazio.zip'), '');
    await expect(obterDne({ url: join(pastaTemp, 'vazio.zip'), pastaCache: cache })).rejects.toThrow(/vazio/);
  });

  test('preflight: arquivo local presente é ✔ sem HEAD; ausente é ✖ com instrução', async () => {
    const stub = await subirStub(rotasSaudaveis(() => json(200, { environment: 'local' })));
    try {
      const arquivo = join(pastaTemp, 'baseceps.zip');
      writeFileSync(arquivo, DNE);
      const cfg = { ...carregarConfigStub(stub.url), dneUrl: arquivo };
      const ok = await executarPreflight(cfg, { executor: executorEspiao().executor, pastaCache: pastaTemp, timeoutMs: 1_000 });
      expect(ok.itens.find((i) => i.familia === 'dne' && i.nome === 'acesso')).toMatchObject({ status: 'ok' });
      expect(stub.chamadas.some((c) => c.caminho === '/dne.zip')).toBe(false);

      const falta = await executarPreflight({ ...cfg, dneUrl: join(pastaTemp, 'nao-existe.zip') }, { executor: executorEspiao().executor, pastaCache: pastaTemp, timeoutMs: 1_000 });
      expect(falta.itens.find((i) => i.familia === 'dne' && i.nome === 'acesso')).toMatchObject({ status: 'falha' });
    } finally {
      await stub.fechar();
    }
  });
});

test.describe('INT-009/010/011 (AC-009, AC-010, AC-011) — HTTP por papel e sanitização', () => {
  /** Stub Sanctum: csrf-cookie → XSRF-TOKEN; login exige X-XSRF-TOKEN + Origin; /me exige sessão. */
  function rotasSanctum(origemEsperada: string, senha: string): { rotas: Record<string, Rota>; logins: () => number } {
    let logins = 0;
    const xsrf = 'xsrf%3Dvalor-secreto-do-cookie';
    const sessao = 'sessao-secreta-abc123';
    const autenticado = (req: IncomingMessage) => (req.headers.cookie ?? '').includes(`esuas-session=${sessao}`);
    return {
      logins: () => logins,
      rotas: {
        'GET /sanctum/csrf-cookie': (_req, res) => {
          res.statusCode = 204;
          res.setHeader('set-cookie', [`XSRF-TOKEN=${xsrf}; Path=/`, 'esuas-session=anonima; Path=/; HttpOnly']);
          res.end();
        },
        'POST /api/manager/auth/login': (req, res, corpo) => {
          logins++;
          const dados = JSON.parse(corpo || '{}') as { cpf?: string; password?: string };
          if (req.headers['x-xsrf-token'] !== decodeURIComponent(xsrf) || req.headers.origin !== origemEsperada) return json(419, { message: 'CSRF token mismatch.' })(req, res, corpo);
          if (dados.password !== senha) return json(422, { message: 'Credenciais inválidas', password: dados.password })(req, res, corpo);
          res.statusCode = 200;
          res.setHeader('set-cookie', [`esuas-session=${sessao}; Path=/; HttpOnly`]);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ user: { name: 'Admin Stub' }, token: 'token-secreto-xyz' }));
        },
        'GET /api/manager/auth/me': (req, res, corpo) => (autenticado(req) ? json(200, { data: { name: 'Admin Stub' } }) : json(401, { message: 'Unauthenticated.' }))(req, res, corpo),
      },
    };
  }

  test('autentica no guard manager (csrf-cookie → XSRF + Origin → login) e faz GET autenticado; log sem segredos', async () => {
    const senha = 'SenhaMuitoSecreta#1';
    const stub = await subirStub();
    const cfg: ConfigMassa = { ...carregarConfigStub(stub.url), adminUrl: `${stub.url}/admin-front` };
    for (const [k, v] of Object.entries(rotasSanctum(cfg.adminUrl, senha).rotas)) stub.rotas.set(k, v);
    const logs: string[] = [];
    try {
      const cliente = await ClientePapel.autenticar(cfg, { nome: 'admin', guard: 'manager', cpf: '98000000113', senha }, { log: (l) => logs.push(l) });
      const me = await cliente.get<{ data: { name: string } }>('/api/manager/auth/me');
      expect(me.corpo.data.name).toBe('Admin Stub');
      await cliente.encerrar();
      expect(stub.chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual([
        'GET /sanctum/csrf-cookie',
        'POST /api/manager/auth/login',
        'GET /api/manager/auth/me',
      ]);
      const saida = logs.join('\n');
      for (const segredo of [senha, 'valor-secreto-do-cookie', 'sessao-secreta-abc123', 'token-secreto-xyz', 'X-XSRF-TOKEN']) {
        expect(saida).not.toContain(segredo);
      }
    } finally {
      await stub.fechar();
    }
  });

  test('falha de login não vaza a senha na mensagem de erro', async () => {
    const senhaErrada = 'SenhaErradaSecreta#9';
    const stub = await subirStub();
    const cfg: ConfigMassa = { ...carregarConfigStub(stub.url), adminUrl: `${stub.url}/admin-front` };
    const r = rotasSanctum(cfg.adminUrl, 'outra-senha-qualquer');
    for (const [k, v] of Object.entries(r.rotas)) stub.rotas.set(k, v);
    try {
      let mensagem = '';
      try {
        await ClientePapel.autenticar(cfg, { nome: 'P1', guard: 'manager', cpf: '98000000202', senha: senhaErrada }, { log: () => undefined });
      } catch (e) {
        mensagem = (e as Error).message;
      }
      expect(mensagem).toMatch(/HTTP 422/);
      expect(mensagem).not.toContain(senhaErrada);
    } finally {
      await stub.fechar();
    }
  });

  test('sanitizar() mascara senha, token, cookie e XSRF', () => {
    const texto = [
      '{"password":"abc12345","password_confirmation":"abc12345","token":"t0k3n","cpf":"98000000113"}',
      'X-XSRF-TOKEN: eyJpdiI6IjEyMyJ9',
      'Cookie: esuas-session=abc; XSRF-TOKEN=def',
      'Authorization: Bearer 1|abcdef',
      'https://x/auth/reset-password?token=segredo123&email=a%40b.c',
    ].join('\n');
    const limpo = sanitizar(texto);
    for (const segredo of ['abc12345', 't0k3n', 'eyJpdiI6IjEyMyJ9', 'esuas-session=abc', 'def', '1|abcdef', 'segredo123']) {
      expect(limpo).not.toContain(segredo);
    }
    expect(limpo).toContain('98000000113');
  });

  test('link de redefinição: extrai de HTML com &amp; e lê token/e-mail', () => {
    const link = extrairLinkRedefinicao({ Text: '', HTML: '<a href="http://localhost:5174/auth/reset-password?token=abc&amp;email=p1%40demo.sigsuas.local">x</a>' });
    expect(lerLink(link)).toEqual({ token: 'abc', email: 'p1@demo.sigsuas.local' });
  });

  test('definirSenha: forgot-password → Mailpit → reset-password (stub)', async () => {
    const stub = await subirStub();
    const cfg: ConfigMassa = { ...carregarConfigStub(stub.url), clientUrl: `${stub.url}/client-front`, mailpitUrl: `${stub.url}/mailpit` };
    let recebido: Record<string, string> = {};
    stub.rotas.set('GET /sanctum/csrf-cookie', (_q, res) => {
      res.statusCode = 204;
      res.setHeader('set-cookie', 'XSRF-TOKEN=abc; Path=/');
      res.end();
    });
    stub.rotas.set('POST /api/client/auth/forgot-password', json(200, { message: 'ok' }));
    stub.rotas.set('GET /mailpit/api/v1/search', json(200, { messages: [{ ID: 'm1', Created: new Date(Date.now() + 2000).toISOString() }] }));
    stub.rotas.set('GET /mailpit/api/v1/message/m1', json(200, { ID: 'm1', Subject: 'Redefinir', Created: '', Text: `${cfg.clientUrl}/auth/reset-password?token=tok-9&email=p1%40demo.sigsuas.local`, HTML: '' }));
    stub.rotas.set('POST /api/client/auth/reset-password', (req, res, corpo) => {
      recebido = JSON.parse(corpo) as Record<string, string>;
      json(req.headers['x-xsrf-token'] === 'abc' ? 200 : 419, { message: 'ok' })(req, res, corpo);
    });
    const logs: string[] = [];
    try {
      await definirSenha(cfg, { email: 'p1@demo.sigsuas.local', guard: 'client' }, 'NovaSenha#2026', { log: (l) => logs.push(l), timeoutMs: 3_000 });
      expect(recebido).toEqual({ token: 'tok-9', email: 'p1@demo.sigsuas.local', password: 'NovaSenha#2026', password_confirmation: 'NovaSenha#2026' });
      expect(logs.join('\n')).not.toContain('NovaSenha#2026');
      expect(logs.join('\n')).not.toContain('tok-9');
    } finally {
      await stub.fechar();
    }
  });

  // --- Contra a stack local real (opt-in) ---------------------------------------------------
  const real = process.env.MASSA_INT_REAL === '1';
  test('REAL — Administrador autentica no guard manager e faz GET /api/manager/auth/me', async () => {
    const cfg = carregarConfig();
    test.skip(!real || !cfg.adminCpf || !cfg.adminSenha, 'defina MASSA_INT_REAL=1 e E2E_ADMIN_CPF/E2E_ADMIN_PASSWORD');
    const logs: string[] = [];
    const cliente = await ClientePapel.autenticar(cfg, { nome: 'admin', guard: 'manager', cpf: cfg.adminCpf, senha: cfg.adminSenha }, { log: (l) => logs.push(l) });
    try {
      const me = await cliente.get<{ data?: { cpf?: string } }>('/api/manager/auth/me');
      expect(me.status).toBe(200);
      expect(logs.join('\n')).not.toContain(cfg.adminSenha);
    } finally {
      await cliente.encerrar();
    }
  });
});

test('lerArgumentos: flags válidas e opção desconhecida', () => {
  expect(lerArgumentos(['--sem-evidencias', '--confirmar-apagamento', '--ate=E0'])).toEqual({ verificar: false, evidencias: false, confirmarApagamento: true, ate: 'E0' });
  expect(() => lerArgumentos(['--forcar'])).toThrow(/Opção desconhecida/);
});

