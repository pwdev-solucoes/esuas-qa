/**
 * Trava de produção (#10994 · RN-T1 / CA02 / CA02b) — fail-closed com allowlist.
 *
 * `GET {API_BASE}/api/environment` só libera a execução quando o valor está em
 * `local`, `testing` ou `staging` (CR-001 da revisão do plano 01). Qualquer outra coisa recusa:
 * `production`/`prod`, valor não reconhecido (`prd`, `live`, …), timeout, rede, status ≠ 200,
 * JSON inválido ou chave ausente. A consulta é sempre GET e nunca autentica.
 */

export const AMBIENTES_PERMITIDOS = ['local', 'testing', 'staging'] as const;
export type AmbientePermitido = (typeof AMBIENTES_PERMITIDOS)[number];

export type MotivoRecusa = 'producao' | 'nao_reconhecido' | 'falha';

export type ResultadoAmbiente =
  | { ok: true; environment: AmbientePermitido; status: number; mensagem: string }
  | { ok: false; motivo: MotivoRecusa; environment?: string; status?: number; mensagem: string };

export const MENSAGEM_PRODUCAO =
  'Geração recusada: o ambiente-alvo se identifica como "production". Nenhum registro foi criado.';

export function mensagemFalha(detalhe: string): string {
  return `Geração recusada: não foi possível identificar o ambiente-alvo (${detalhe}). Nenhum registro foi criado.`;
}

export function mensagemNaoReconhecido(valor: string): string {
  return (
    `Geração recusada: o ambiente-alvo se identifica como "${valor}", fora da lista permitida ` +
    `(${AMBIENTES_PERMITIDOS.join(', ')}). Nenhum registro foi criado.`
  );
}

export interface OpcoesAmbiente {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Consulta o ambiente e classifica a resposta. Nunca lança: falha vira `{ ok: false }`. */
export async function consultarAmbiente(apiBase: string, opcoes: OpcoesAmbiente = {}): Promise<ResultadoAmbiente> {
  const fetchImpl = opcoes.fetchImpl ?? fetch;
  const url = `${apiBase.replace(/\/+$/, '')}/api/environment`;
  let resposta: Response;
  try {
    resposta = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(opcoes.timeoutMs ?? 10_000),
    });
  } catch (erro) {
    const nome = (erro as Error)?.name;
    const detalhe = nome === 'TimeoutError' || nome === 'AbortError' ? 'tempo esgotado' : `erro de rede: ${(erro as Error)?.message ?? erro}`;
    return { ok: false, motivo: 'falha', mensagem: mensagemFalha(`${detalhe} em ${url}`) };
  }

  const status = resposta.status;
  if (status !== 200) {
    return { ok: false, motivo: 'falha', status, mensagem: mensagemFalha(`HTTP ${status} em ${url}`) };
  }

  let corpo: unknown;
  try {
    corpo = JSON.parse(await resposta.text());
  } catch {
    return { ok: false, motivo: 'falha', status, mensagem: mensagemFalha('resposta não é JSON válido') };
  }

  const bruto = corpo !== null && typeof corpo === 'object' ? (corpo as Record<string, unknown>).environment : undefined;
  if (typeof bruto !== 'string' || bruto.trim() === '') {
    return { ok: false, motivo: 'falha', status, mensagem: mensagemFalha('chave "environment" ausente ou vazia') };
  }

  const valor = bruto.trim().toLowerCase();
  if (valor === 'production' || valor === 'prod') {
    return { ok: false, motivo: 'producao', environment: valor, status, mensagem: MENSAGEM_PRODUCAO };
  }
  if (!(AMBIENTES_PERMITIDOS as readonly string[]).includes(valor)) {
    return { ok: false, motivo: 'nao_reconhecido', environment: valor, status, mensagem: mensagemNaoReconhecido(valor) };
  }
  return { ok: true, environment: valor as AmbientePermitido, status, mensagem: `/api/environment = "${valor}"` };
}

export class RecusaAmbiente extends Error {
  constructor(readonly resultado: Extract<ResultadoAmbiente, { ok: false }>) {
    super(resultado.mensagem);
    this.name = 'RecusaAmbiente';
  }
}

/** Exige ambiente permitido; lança `RecusaAmbiente` em qualquer outro caso. */
export async function exigirNaoProducao(apiBase: string, opcoes: OpcoesAmbiente = {}): Promise<AmbientePermitido> {
  const resultado = await consultarAmbiente(apiBase, opcoes);
  if (!resultado.ok) throw new RecusaAmbiente(resultado);
  return resultado.environment;
}
