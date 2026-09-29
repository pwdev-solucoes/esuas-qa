/**
 * E0 — Aviso de apagamento, confirmação e reset externo (#10994 · RN-T3, BR-004).
 *
 * A base só é recriada por `MASSA_RESET_CMD` (nunca pela API — RN03 — nem por SQL do executor),
 * seguido de `queue:restart` (o worker precisa recarregar) e `MASSA_CACHE_CLEAR_CMD` (rate-limit).
 * Código de saída ≠ 0 em qualquer um aborta.
 */
import { createInterface } from 'node:readline/promises';
import { containerDoComando } from './preflight.ts';
import { executorPadrao, sanitizar, type ConfigMassa, type Executor, type Logger } from './config.ts';

export function textoAviso(apiBase: string, environment: string, resetCmd: string): string {
  const { container } = containerDoComando(resetCmd);
  return [
    '',
    '════════════════════════════════════════════════════════════════════════════',
    `ATENÇÃO: esta execução APAGA TODOS OS DADOS do ambiente ${apiBase} (${environment}).`,
    'A base será recriada do zero (migrate:fresh --seed) e povoada com a massa fictícia.',
    `Comando de reset: ${sanitizar(resetCmd)}${container ? `  (container-alvo: ${container})` : ''}`,
    '════════════════════════════════════════════════════════════════════════════',
    '',
  ].join('\n');
}

export class ApagamentoNaoConfirmado extends Error {
  constructor(motivo: string) {
    super(`Execução abortada: ${motivo}. Nada foi apagado.`);
    this.name = 'ApagamentoNaoConfirmado';
  }
}

export interface OpcoesConfirmacao {
  environment: string;
  /** stdin é um terminal interativo. */
  interativo: boolean;
  /** `--confirmar-apagamento` foi passado. */
  flagConfirmacao: boolean;
  /** Pergunta ao operador e devolve o texto digitado (injetável nos testes). */
  perguntar?: (pergunta: string) => Promise<string>;
}

export async function perguntarNoTerminal(pergunta: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(pergunta);
  } finally {
    rl.close();
  }
}

/**
 * RN-T3: não interativo exige `--confirmar-apagamento`; interativo sem a flag exige digitar o
 * nome exato do ambiente retornado por `/api/environment`. Lança `ApagamentoNaoConfirmado`.
 */
export async function confirmarApagamento(o: OpcoesConfirmacao): Promise<'flag' | 'digitado'> {
  if (o.flagConfirmacao) return 'flag';
  if (!o.interativo) {
    throw new ApagamentoNaoConfirmado('execução não interativa sem --confirmar-apagamento');
  }
  const perguntar = o.perguntar ?? perguntarNoTerminal;
  const digitado = (await perguntar(`Para confirmar, digite o nome do ambiente ("${o.environment}"): `)).trim();
  if (digitado !== o.environment) {
    throw new ApagamentoNaoConfirmado(`confirmação "${digitado}" diferente do ambiente "${o.environment}"`);
  }
  return 'digitado';
}

/** Deriva o `queue:restart` do comando de reset (`… artisan migrate:fresh …` → `… artisan queue:restart`). */
export function comandoQueueRestart(cfg: Pick<ConfigMassa, 'resetCmd' | 'queueRestartCmd'>): string | null {
  if (cfg.queueRestartCmd) return cfg.queueRestartCmd;
  const m = cfg.resetCmd.match(/^(.*\bartisan)\s+migrate:fresh\b/);
  return m ? `${m[1]} queue:restart` : null;
}

export interface PassoReset {
  nome: 'reset' | 'queue:restart' | 'cache:clear';
  comando: string;
  codigo: number;
  duracaoMs: number;
  resumo: string;
}

export class FalhaReset extends Error {
  constructor(readonly passo: PassoReset) {
    super(`Passo "${passo.nome}" terminou com código ${passo.codigo}: ${passo.resumo}`);
    this.name = 'FalhaReset';
  }
}

function resumir(texto: string, linhas = 6): string {
  return sanitizar(texto.trim().split(/\r?\n/).filter(Boolean).slice(-linhas).join(' | ')).slice(0, 600);
}

/** Executa reset → queue:restart → cache clear. Aborta (lança) no primeiro código ≠ 0. */
export function executarReset(cfg: ConfigMassa, deps: { executor?: Executor; log?: Logger } = {}): PassoReset[] {
  const executor = deps.executor ?? executorPadrao;
  const log = deps.log ?? (() => undefined);
  const queueRestart = comandoQueueRestart(cfg);
  if (!cfg.resetCmd) throw new Error('MASSA_RESET_CMD não definido.');
  if (!queueRestart) {
    throw new Error('Não foi possível derivar o queue:restart do MASSA_RESET_CMD; defina MASSA_QUEUE_RESTART_CMD.');
  }
  const plano: Array<[PassoReset['nome'], string]> = [
    ['reset', cfg.resetCmd],
    ['queue:restart', queueRestart],
  ];
  if (cfg.cacheClearCmd) plano.push(['cache:clear', cfg.cacheClearCmd]);

  const passos: PassoReset[] = [];
  for (const [nome, comando] of plano) {
    log(`→ ${nome}: ${sanitizar(comando)}`);
    const inicio = Date.now();
    const r = executor.shell(comando);
    const passo: PassoReset = { nome, comando: sanitizar(comando), codigo: r.codigo, duracaoMs: Date.now() - inicio, resumo: resumir(`${r.saida}\n${r.erro}`) };
    passos.push(passo);
    log(`  ${r.codigo === 0 ? '✔' : '✖'} ${nome} (código ${r.codigo}, ${Math.round(passo.duracaoMs / 1000)}s) ${passo.resumo}`);
    if (r.codigo !== 0) throw new FalhaReset(passo);
  }
  return passos;
}
