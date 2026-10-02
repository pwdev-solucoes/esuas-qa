/**
 * Espera de jobs assíncronos da API (#10994 · BR-007): importação DNE, camadas geográficas.
 *
 * `aguardar()` consulta `ler()` até `avaliar()` devolver `pronto` (ok) ou `falha` (erro), com
 * backoff exponencial limitado e timeout configurável (`MASSA_TIMEOUT_JOBS_MS`, padrão 30 min).
 * Só faz leitura: quem dispara o job é a etapa, pela API.
 */

export type Veredito = 'pronto' | 'aguardando' | { falha: string };

export interface OpcoesEspera {
  /** Tempo total máximo (ms). Padrão: `MASSA_TIMEOUT_JOBS_MS` ou 30 min. */
  timeoutMs?: number;
  /** Primeiro intervalo entre consultas (ms). Padrão 1 s. */
  intervaloInicialMs?: number;
  /** Teto do intervalo (ms). Padrão 10 s. */
  intervaloMaximoMs?: number;
  /** Fator do backoff. Padrão 1,5. */
  fator?: number;
  /** Chamado a cada consulta (para log de progresso). */
  aoConsultar?: (tentativa: number, decorridoMs: number) => void;
  /** Relógio/espera injetáveis (testes). */
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

export class TempoEsgotado extends Error {
  constructor(descricao: string, timeoutMs: number, ultimo: unknown) {
    super(`Tempo esgotado (${Math.round(timeoutMs / 1000)} s) aguardando ${descricao}. Último estado: ${JSON.stringify(ultimo)?.slice(0, 300)}`);
    this.name = 'TempoEsgotado';
  }
}

export class JobFalhou extends Error {
  constructor(descricao: string, motivo: string) {
    super(`${descricao} falhou: ${motivo}`);
    this.name = 'JobFalhou';
  }
}

export function timeoutPadrao(): number {
  const v = Number(process.env.MASSA_TIMEOUT_JOBS_MS);
  return Number.isFinite(v) && v > 0 ? v : 30 * 60_000;
}

const dormirPadrao = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Consulta até ficar pronto; lança `JobFalhou` ou `TempoEsgotado`. Devolve o último valor lido. */
export async function aguardar<T>(
  descricao: string,
  ler: () => Promise<T>,
  avaliar: (valor: T) => Veredito,
  o: OpcoesEspera = {},
): Promise<T> {
  const agora = o.agora ?? Date.now;
  const dormir = o.dormir ?? dormirPadrao;
  const timeout = o.timeoutMs ?? timeoutPadrao();
  const maximo = o.intervaloMaximoMs ?? 10_000;
  const fator = o.fator ?? 1.5;
  let intervalo = o.intervaloInicialMs ?? 1_000;
  const inicio = agora();
  let tentativa = 0;
  let ultimo: T | undefined;
  for (;;) {
    tentativa += 1;
    ultimo = await ler();
    o.aoConsultar?.(tentativa, agora() - inicio);
    const v = avaliar(ultimo);
    if (v === 'pronto') return ultimo;
    if (typeof v === 'object') throw new JobFalhou(descricao, v.falha);
    if (agora() - inicio + intervalo > timeout) throw new TempoEsgotado(descricao, timeout, ultimo);
    await dormir(intervalo);
    intervalo = Math.min(maximo, Math.round(intervalo * fator));
  }
}
