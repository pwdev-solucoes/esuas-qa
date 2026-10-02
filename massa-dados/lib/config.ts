/**
 * Configuração do executor da massa fictícia (#10994 · spec §10).
 *
 * Lê `massa-dados/.env` (gitignored) SEM nunca imprimir valores e expõe `sanitizar()`, usado por
 * todo log do executor para mascarar senha, token, cookie e `X-XSRF-TOKEN` (RN-T7).
 * Variáveis já definidas no processo vencem o arquivo (útil no CI).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

/** Raiz `qa/massa-dados/`. */
export const RAIZ_MASSA = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Raiz do repositório `qa/`. */
export const RAIZ_QA = resolve(RAIZ_MASSA, '..');
export const ARQUIVO_ENV = resolve(RAIZ_MASSA, '.env');
export const PASTA_CACHE = resolve(RAIZ_MASSA, '.cache');

export const OBRIGATORIAS = [
  'API_BASE',
  'ADMIN_URL',
  'CLIENT_URL',
  'MAILPIT_URL',
  'E2E_ADMIN_CPF',
  'E2E_ADMIN_PASSWORD',
  'MASSA_RESET_CMD',
  'MASSA_DOCKER_CONTAINERS',
  'MASSA_DNE_URL',
] as const;

export const OPCIONAIS = [
  'MASSA_DNE_SHA256',
  'MASSA_CACHE_CLEAR_CMD',
  'MASSA_QUEUE_RESTART_CMD',
  'MASSA_CADUNICO',
  'MASSA_SENHA_PADRAO',
] as const;

/** Variáveis cujo VALOR nunca pode aparecer em log, relatório ou mensagem. */
export const SECRETAS = ['E2E_ADMIN_PASSWORD', 'MASSA_SENHA_PADRAO'] as const;

export type ChaveConfig = (typeof OBRIGATORIAS)[number] | (typeof OPCIONAIS)[number];

export interface ConfigMassa {
  apiBase: string;
  adminUrl: string;
  clientUrl: string;
  mailpitUrl: string;
  adminCpf: string;
  adminSenha: string;
  resetCmd: string;
  cacheClearCmd: string;
  queueRestartCmd: string;
  containers: string[];
  dneUrl: string;
  dneSha256: string;
  cadunico: boolean;
  senhaPadrao: string;
  /** Obrigatórias ausentes ou vazias (nunca os valores). */
  faltando: string[];
  /** De onde veio a configuração (para a mensagem do preflight). */
  origem: string;
}

function semBarraFinal(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Carrega a configuração. `env` permite injetar valores nos testes; sem ele, lê o `.env` do
 * massa-dados e sobrepõe com `process.env`.
 */
export function carregarConfig(opcoes: { env?: Record<string, string | undefined>; arquivo?: string } = {}): ConfigMassa {
  let base: Record<string, string | undefined>;
  let origem: string;
  if (opcoes.env) {
    base = { ...opcoes.env };
    origem = 'injetada';
  } else {
    const arquivo = opcoes.arquivo ?? ARQUIVO_ENV;
    const doArquivo = existsSync(arquivo) ? dotenv.parse(readFileSync(arquivo)) : {};
    base = { ...doArquivo };
    for (const chave of [...OBRIGATORIAS, ...OPCIONAIS]) {
      const valor = process.env[chave];
      if (valor !== undefined && valor !== '') base[chave] = valor;
    }
    origem = existsSync(arquivo) ? 'massa-dados/.env' : 'variáveis do processo (massa-dados/.env ausente)';
  }
  const v = (chave: ChaveConfig): string => (base[chave] ?? '').trim();
  const faltando = OBRIGATORIAS.filter((chave) => v(chave) === '');

  const cfg: ConfigMassa = {
    apiBase: semBarraFinal(v('API_BASE')),
    adminUrl: semBarraFinal(v('ADMIN_URL')),
    clientUrl: semBarraFinal(v('CLIENT_URL')),
    mailpitUrl: semBarraFinal(v('MAILPIT_URL')),
    adminCpf: v('E2E_ADMIN_CPF').replace(/\D/g, ''),
    adminSenha: v('E2E_ADMIN_PASSWORD'),
    resetCmd: v('MASSA_RESET_CMD'),
    cacheClearCmd: v('MASSA_CACHE_CLEAR_CMD'),
    queueRestartCmd: v('MASSA_QUEUE_RESTART_CMD'),
    containers: v('MASSA_DOCKER_CONTAINERS')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    dneUrl: v('MASSA_DNE_URL'),
    dneSha256: v('MASSA_DNE_SHA256').toLowerCase(),
    cadunico: /^(1|true|sim|yes)$/i.test(v('MASSA_CADUNICO')),
    senhaPadrao: v('MASSA_SENHA_PADRAO'),
    faltando,
    origem,
  };
  registrarSegredos([cfg.adminSenha, cfg.senhaPadrao]);
  return cfg;
}

// ---------------------------------------------------------------------------------------------
// Sanitização de log (RN-T7)
// ---------------------------------------------------------------------------------------------

const segredosConhecidos = new Set<string>();

/** Registra valores que devem ser mascarados em qualquer saída (senhas, tokens obtidos em runtime). */
export function registrarSegredos(valores: Array<string | undefined | null>): void {
  for (const valor of valores) {
    if (valor && valor.length >= 4) {
      segredosConhecidos.add(valor);
      try {
        const codificado = encodeURIComponent(valor);
        if (codificado !== valor) segredosConhecidos.add(codificado);
      } catch {
        /* valor não codificável: segue só o literal */
      }
    }
  }
}

const MASCARA = '[redigido]';

const PADROES: Array<[RegExp, string]> = [
  // JSON: "password": "...", "password_confirmation", "token", "access_token", "current_password"
  [/("(?:[a-z_]*password[a-z_]*|[a-z_]*token[a-z_]*|secret)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${MASCARA}"`],
  // querystring / form: password=...&token=...
  [/\b((?:[a-z_]*password[a-z_]*|token|access_token)=)[^&\s"'<>]+/gi, `$1${MASCARA}`],
  // headers
  [/\b(x-xsrf-token|x-csrf-token|authorization|cookie|set-cookie)(\s*[:=]\s*)[^\n\r]+/gi, `$1$2${MASCARA}`],
  [/\bBearer\s+[A-Za-z0-9._|~+/=-]+/g, `Bearer ${MASCARA}`],
  // cookies de sessão/XSRF soltos
  [/\b(XSRF-TOKEN|[a-z0-9_-]*session)=[^;\s]+/gi, `$1=${MASCARA}`],
];

/** Mascara segredos conhecidos e padrões sensíveis. Use em TODA linha de log do executor. */
export function sanitizar(texto: string): string {
  let saida = texto;
  for (const segredo of segredosConhecidos) {
    saida = saida.split(segredo).join(MASCARA);
  }
  for (const [padrao, troca] of PADROES) {
    saida = saida.replace(padrao, troca);
  }
  return saida;
}

export type Logger = (linha: string) => void;

/** Logger padrão: sanitiza e escreve no stdout. */
export const logPadrao: Logger = (linha) => {
  process.stdout.write(`${sanitizar(linha)}\n`);
};

// ---------------------------------------------------------------------------------------------
// Execução de comandos externos (injetável nos testes)
// ---------------------------------------------------------------------------------------------

export interface ResultadoComando {
  codigo: number;
  saida: string;
  erro: string;
}

/**
 * Executor de comandos. `shell` recebe uma linha inteira (`MASSA_RESET_CMD`); `programa` recebe
 * binário + argumentos sem shell (checagens do preflight).
 */
export interface Executor {
  programa(binario: string, argumentos: string[], opcoes?: { timeoutMs?: number }): ResultadoComando;
  shell(linha: string, opcoes?: { timeoutMs?: number }): ResultadoComando;
}

function converter(r: ReturnType<typeof spawnSync>): ResultadoComando {
  return {
    codigo: typeof r.status === 'number' ? r.status : 1,
    saida: (r.stdout ?? '').toString(),
    erro: (r.stderr ?? '').toString() || (r.error ? String(r.error.message) : ''),
  };
}

export const executorPadrao: Executor = {
  programa(binario, argumentos, opcoes = {}) {
    return converter(spawnSync(binario, argumentos, { encoding: 'utf8', timeout: opcoes.timeoutMs ?? 60_000 }));
  },
  shell(linha, opcoes = {}) {
    return converter(
      spawnSync('/bin/sh', ['-c', linha], { encoding: 'utf8', timeout: opcoes.timeoutMs ?? 30 * 60_000, cwd: RAIZ_QA }),
    );
  },
};
