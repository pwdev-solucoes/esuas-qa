/**
 * CLI da massa fictícia (#10994).
 *
 *   npm run massa:verificar                       → só o preflight (E00); não escreve nada
 *   npm run massa -- --sem-evidencias --confirmar-apagamento [--ate=E0]
 *
 * Sequência (fora do Playwright, Node puro — nenhuma fixture roda antes da trava):
 *   preflight → aviso de apagamento + confirmação → 2ª checagem de /api/environment →
 *   MASSA_RESET_CMD + queue:restart + cache clear → DNE em cache →
 *   `playwright test --project=massa-dados <etapa>` uma etapa por vez, parando na primeira falha.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exigirNaoProducao, RecusaAmbiente } from '../lib/ambiente.ts';
import { carregarConfig, executorPadrao, logPadrao, RAIZ_QA, type ConfigMassa, type Executor, type Logger } from '../lib/config.ts';
import { FalhaDne, obterDne } from '../lib/dne.ts';
import {
  caminhoEstadoPadrao,
  etapasAte,
  ETAPAS,
  marcarNaoExecutadas,
  novaExecucao,
  salvarEstado,
  lerEstado,
  VARIAVEL_ESTADO,
  type EstadoExecucao,
} from '../lib/execucao.ts';
import { executarPreflight, formatarPreflight } from '../lib/preflight.ts';
import { ApagamentoNaoConfirmado, confirmarApagamento, executarReset, FalhaReset, perguntarNoTerminal, textoAviso } from '../lib/reset.ts';

export interface OpcoesCli {
  verificar: boolean;
  evidencias: boolean | null;
  confirmarApagamento: boolean;
  ate: string | null;
}

export function lerArgumentos(argv: string[]): OpcoesCli {
  const o: OpcoesCli = { verificar: false, evidencias: null, confirmarApagamento: false, ate: null };
  for (const arg of argv) {
    if (arg === '--verificar') o.verificar = true;
    else if (arg === '--evidencias') o.evidencias = true;
    else if (arg === '--sem-evidencias') o.evidencias = false;
    else if (arg === '--confirmar-apagamento') o.confirmarApagamento = true;
    else if (arg.startsWith('--ate=')) o.ate = arg.slice('--ate='.length).trim() || null;
    else throw new Error(`Opção desconhecida: ${arg}. Use --evidencias | --sem-evidencias, --confirmar-apagamento, --ate=Exx, --verificar.`);
  }
  return o;
}

export interface DependenciasFluxo {
  cfg?: ConfigMassa;
  executor?: Executor;
  fetchImpl?: typeof fetch;
  interativo?: boolean;
  perguntar?: (pergunta: string) => Promise<string>;
  log?: Logger;
  pastaCache?: string;
  raizMassa?: string;
  caminhoEstado?: string;
  /** Roda uma etapa; devolve o código de saída (padrão: `npx playwright test --project=massa-dados`). */
  rodarEtapa?: (arquivo: string, caminhoEstado: string, filtro?: string) => number;
  timeoutMs?: number;
}

function rodarEtapaPlaywright(arquivo: string, caminhoEstado: string, filtro?: string): number {
  const argumentos = ['playwright', 'test', '--project=massa-dados', '--reporter=list', `massa-dados/etapas/${arquivo}`];
  if (filtro) argumentos.push(`--grep=${filtro}`);
  // A E01b espera o DNE nacional (~15 min de processamento + sync): sem teto global e com folga por
  // etapa (o timeout de cada job continua em `polling.ts`, MASSA_TIMEOUT_JOBS_MS).
  argumentos.push('--global-timeout=0', `--timeout=${2 * 60 * 60_000}`);
  const r = spawnSync('npx', argumentos, {
    cwd: RAIZ_QA,
    stdio: 'inherit',
    env: { ...process.env, [VARIAVEL_ESTADO]: caminhoEstado },
  });
  return typeof r.status === 'number' ? r.status : 1;
}

/** Executa o fluxo e devolve o código de saída do processo (0 = sucesso). */
export async function executarFluxo(opcoes: OpcoesCli, deps: DependenciasFluxo = {}): Promise<number> {
  const log = deps.log ?? logPadrao;
  const cfg = deps.cfg ?? carregarConfig();
  const executor = deps.executor ?? executorPadrao;
  const interativo = deps.interativo ?? Boolean(process.stdin.isTTY);
  const perguntar = deps.perguntar ?? perguntarNoTerminal;

  let ate: string | null = null;
  if (!opcoes.verificar) {
    try {
      ate = opcoes.ate ? (etapasAte(opcoes.ate).at(-1)?.id ?? null) : null;
    } catch (erro) {
      log(`✖ ${(erro as Error).message}`);
      return 2;
    }
    if (opcoes.evidencias === null) {
      if (!interativo) {
        log('✖ Em modo não interativo informe --evidencias ou --sem-evidencias.');
        return 2;
      }
      const resposta = (await perguntar('Gerar relatório de evidências? (s/N): ')).trim().toLowerCase();
      opcoes = { ...opcoes, evidencias: resposta === 's' || resposta === 'sim' };
    }
  }

  // 1. Preflight (1ª checagem do ambiente) -----------------------------------------------------
  const preflight = await executarPreflight(cfg, {
    executor,
    fetchImpl: deps.fetchImpl,
    pastaCache: deps.pastaCache,
    raizMassa: deps.raizMassa,
    timeoutMs: deps.timeoutMs,
  });
  log(formatarPreflight(preflight));
  if (opcoes.verificar) return preflight.apto ? 0 : 1;
  if (!preflight.apto || !preflight.ambiente?.ok) return 1;

  const estado: EstadoExecucao = novaExecucao({ evidencias: Boolean(opcoes.evidencias), ate, apiBase: cfg.apiBase });
  const caminhoEstado = deps.caminhoEstado ?? caminhoEstadoPadrao(estado.id);
  estado.preflight = { apto: preflight.apto, itens: preflight.itens, falhas: preflight.falhas, avisos: preflight.avisos, duracaoMs: preflight.duracaoMs };
  estado.ambiente.push({ momento: 'preflight', ok: true, environment: preflight.ambiente.environment, mensagem: preflight.ambiente.mensagem, em: new Date().toISOString() });
  const encerrar = (codigo: number): number => {
    salvarEstado(caminhoEstado, estado);
    log(`Estado da execução: ${caminhoEstado}`);
    return codigo;
  };

  // 2. Aviso de apagamento + confirmação (RN-T3) ------------------------------------------------
  log(textoAviso(cfg.apiBase, preflight.ambiente.environment, cfg.resetCmd));
  try {
    estado.confirmacao = await confirmarApagamento({
      environment: preflight.ambiente.environment,
      interativo,
      flagConfirmacao: opcoes.confirmarApagamento,
      perguntar,
    });
  } catch (erro) {
    if (erro instanceof ApagamentoNaoConfirmado) {
      log(`✖ ${erro.message}`);
      return encerrar(1);
    }
    throw erro;
  }

  // 3. Trava de produção, 2ª checagem, imediatamente antes do reset (RN-T1) ---------------------
  try {
    const environment = await exigirNaoProducao(cfg.apiBase, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
    estado.ambiente.push({ momento: 'antes_do_reset', ok: true, environment, mensagem: `/api/environment = "${environment}"`, em: new Date().toISOString() });
    log(`✔ trava de produção (2ª checagem): /api/environment = "${environment}"`);
  } catch (erro) {
    if (erro instanceof RecusaAmbiente) {
      estado.ambiente.push({ momento: 'antes_do_reset', ok: false, environment: erro.resultado.environment, mensagem: erro.message, em: new Date().toISOString() });
      log(`✖ ${erro.message}`);
      return encerrar(1);
    }
    throw erro;
  }

  // 4. Reset externo ----------------------------------------------------------------------------
  try {
    estado.reset = executarReset(cfg, { executor, log });
  } catch (erro) {
    if (erro instanceof FalhaReset) estado.reset = [erro.passo];
    log(`✖ Reset falhou: ${(erro as Error).message}`);
    return encerrar(1);
  }

  // 5. DNE ----------------------------------------------------------------------------------------
  try {
    const dne = await obterDne({ url: cfg.dneUrl, sha256: cfg.dneSha256 || undefined, pastaCache: deps.pastaCache, fetchImpl: deps.fetchImpl });
    estado.dne = { ...dne, arquivo: dne.arquivo };
    log(`✔ DNE: ${dne.bytes} bytes, sha256 ${dne.sha256}${dne.local ? ' (arquivo local)' : dne.doCache ? ' (cache)' : ' (baixado)'}`);
  } catch (erro) {
    log(`✖ ${erro instanceof FalhaDne ? erro.message : `DNE: ${(erro as Error).message}`}`);
    return encerrar(1);
  }
  salvarEstado(caminhoEstado, estado);

  // 6. Etapas (Playwright), uma por vez, parando na primeira falha -------------------------------
  const rodar = deps.rodarEtapa ?? rodarEtapaPlaywright;
  const selecionadas = etapasAte(ate);
  for (const [i, etapa] of selecionadas.entries()) {
    log(`\n▶ ${etapa.id} — ${etapa.titulo}`);
    const codigo = rodar(etapa.arquivo, caminhoEstado, etapa.filtro);
    if (codigo !== 0) {
      const atual = lerEstado(caminhoEstado).estado;
      if (!atual.etapas.some((e) => e.etapa === etapa.id)) {
        atual.etapas.push({ etapa: etapa.id, status: 'falha', duracao: 0, papel: null, passos: [], avisos: [`playwright saiu com código ${codigo}`] });
      }
      marcarNaoExecutadas(atual, ETAPAS.slice(ETAPAS.indexOf(selecionadas[i]) + 1).map((e) => e.id));
      Object.assign(estado, atual);
      log(`✖ ${etapa.id} falhou; etapas seguintes não executadas.`);
      return encerrar(1);
    }
  }
  const final = lerEstado(caminhoEstado).estado;
  marcarNaoExecutadas(final, ETAPAS.slice(selecionadas.length).map((e) => e.id));
  Object.assign(estado, final);
  log(`\n✔ Massa concluída até ${selecionadas.at(-1)?.id}.`);
  return encerrar(0);
}

async function principal(): Promise<void> {
  let opcoes: OpcoesCli;
  try {
    opcoes = lerArgumentos(process.argv.slice(2));
  } catch (erro) {
    logPadrao(`✖ ${(erro as Error).message}`);
    process.exit(2);
  }
  try {
    process.exitCode = await executarFluxo(opcoes);
  } catch (erro) {
    logPadrao(`✖ Erro inesperado: ${(erro as Error).stack ?? erro}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void principal();
}
