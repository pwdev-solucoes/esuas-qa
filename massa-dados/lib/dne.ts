/**
 * DNE em cache (#10994 · BR-005). Baixa `MASSA_DNE_URL` para `massa-dados/.cache/dne/<sha>.zip`,
 * confere `MASSA_DNE_SHA256` quando definido e reaproveita o cache quando o sha bate.
 * Sem sha esperado, reaproveita o último download da MESMA URL se o arquivo ainda confere com o
 * sha registrado em `ultimo.json`. O upload no sistema acontece em E1b (fora deste plano).
 *
 * `MASSA_DNE_URL` também aceita um ARQUIVO LOCAL: caminho absoluto, caminho relativo à raiz do
 * `qa/` ou URL `file://`. Nesse caso nada é baixado nem copiado: o arquivo é usado onde está,
 * depois de conferido (existe, tem tamanho > 0 e, se `MASSA_DNE_SHA256` estiver definido, o sha bate).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PASTA_CACHE, RAIZ_QA } from './config.ts';

export interface ResultadoDne {
  arquivo: string;
  sha256: string;
  bytes: number;
  doCache: boolean;
  url: string;
  /** `true` quando `MASSA_DNE_URL` aponta para um arquivo local (nada foi baixado). */
  local?: boolean;
}

export class FalhaDne extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FalhaDne';
  }
}

export function sha256Arquivo(caminho: string): Promise<string> {
  return new Promise((ok, falha) => {
    const hash = createHash('sha256');
    createReadStream(caminho)
      .on('data', (p) => hash.update(p))
      .on('end', () => ok(hash.digest('hex')))
      .on('error', falha);
  });
}

/**
 * Caminho absoluto do DNE quando `MASSA_DNE_URL` é local; `null` quando é URL http(s).
 * Caminho relativo é resolvido a partir da raiz do `qa/` (não do diretório corrente).
 */
export function caminhoLocalDne(url: string, raiz: string = RAIZ_QA): string | null {
  const valor = url.trim();
  if (/^https?:\/\//i.test(valor)) return null;
  if (/^file:\/\//i.test(valor)) return fileURLToPath(valor);
  return isAbsolute(valor) ? valor : resolve(raiz, valor);
}

async function dneLocal(url: string, caminho: string, esperado: string): Promise<ResultadoDne> {
  if (!existsSync(caminho) || !statSync(caminho).isFile()) {
    throw new FalhaDne(`Arquivo do DNE não encontrado: ${caminho} (MASSA_DNE_URL).`);
  }
  const bytes = statSync(caminho).size;
  if (bytes === 0) throw new FalhaDne(`Arquivo do DNE vazio: ${caminho} (MASSA_DNE_URL).`);
  const sha = await sha256Arquivo(caminho);
  if (esperado && sha !== esperado) {
    throw new FalhaDne(`sha256 do DNE divergente: arquivo local ${sha}, esperado ${esperado} (MASSA_DNE_SHA256).`);
  }
  return { arquivo: caminho, sha256: sha, bytes, doCache: false, url, local: true };
}

export async function obterDne(o: {
  url: string;
  sha256?: string;
  pastaCache?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ResultadoDne> {
  const esperado = (o.sha256 ?? '').toLowerCase();
  const local = caminhoLocalDne(o.url);
  if (local) return dneLocal(o.url, local, esperado);

  const pasta = resolve(o.pastaCache ?? PASTA_CACHE, 'dne');
  mkdirSync(pasta, { recursive: true });
  const registro = resolve(pasta, 'ultimo.json');

  if (esperado) {
    const cache = resolve(pasta, `${esperado}.zip`);
    if (existsSync(cache) && (await sha256Arquivo(cache)) === esperado) {
      return { arquivo: cache, sha256: esperado, bytes: statSync(cache).size, doCache: true, url: o.url };
    }
  } else if (existsSync(registro)) {
    try {
      const ultimo = JSON.parse(readFileSync(registro, 'utf8')) as { url: string; sha256: string };
      const cache = resolve(pasta, `${ultimo.sha256}.zip`);
      if (ultimo.url === o.url && existsSync(cache) && (await sha256Arquivo(cache)) === ultimo.sha256) {
        return { arquivo: cache, sha256: ultimo.sha256, bytes: statSync(cache).size, doCache: true, url: o.url };
      }
    } catch {
      /* registro corrompido: baixa de novo */
    }
  }

  const temporario = resolve(pasta, `download-${process.pid}.part`);
  const resposta = await (o.fetchImpl ?? fetch)(o.url, { signal: AbortSignal.timeout(o.timeoutMs ?? 30 * 60_000) }).catch((erro: Error) => {
    throw new FalhaDne(`Falha ao baixar o DNE de ${o.url}: ${erro.message}`);
  });
  if (resposta.status !== 200 || !resposta.body) {
    throw new FalhaDne(`Falha ao baixar o DNE de ${o.url}: HTTP ${resposta.status}`);
  }
  const hash = createHash('sha256');
  const corpo = Readable.fromWeb(resposta.body as import('node:stream/web').ReadableStream);
  corpo.on('data', (p: Buffer) => hash.update(p));
  try {
    await pipeline(corpo, createWriteStream(temporario));
  } catch (erro) {
    rmSync(temporario, { force: true });
    throw new FalhaDne(`Download do DNE interrompido: ${(erro as Error).message}`);
  }
  const sha = hash.digest('hex');
  if (esperado && sha !== esperado) {
    rmSync(temporario, { force: true });
    throw new FalhaDne(`sha256 do DNE divergente: baixado ${sha}, esperado ${esperado} (MASSA_DNE_SHA256). Arquivo descartado.`);
  }
  const final = resolve(pasta, `${sha}.zip`);
  renameSync(temporario, final);
  writeFileSync(registro, `${JSON.stringify({ url: o.url, sha256: sha, bytes: statSync(final).size }, null, 2)}\n`);
  return { arquivo: final, sha256: sha, bytes: statSync(final).size, doCache: false, url: o.url };
}
