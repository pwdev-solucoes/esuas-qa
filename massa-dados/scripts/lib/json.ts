/**
 * Escrita/leitura JSON estável para os insumos da massa (#10994 · RN-T4).
 *
 * Chaves de objeto em ordem alfabética (recursivo), arrays na ordem em que o gerador os
 * produziu (os geradores já ordenam de forma estável), indentação de 2 espaços e `\n` final.
 * Duas gerações do mesmo elenco produzem bytes idênticos.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz de `qa/massa-dados/`. */
export const RAIZ_MASSA = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Pasta dos insumos versionados. */
export const PASTA_INSUMOS = resolve(RAIZ_MASSA, 'insumos');

export function caminhoInsumo(relativo: string): string {
  return resolve(PASTA_INSUMOS, relativo);
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor !== null && typeof valor === 'object') {
    const obj = valor as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const chave of Object.keys(obj).sort()) {
      const v = obj[chave];
      if (v !== undefined) out[chave] = ordenar(v);
    }
    return out;
  }
  if (typeof valor === 'number' && !Number.isFinite(valor)) {
    throw new Error(`Número não finito no JSON: ${valor}`);
  }
  return valor;
}

/** Serialização estável (a mesma usada na escrita e na verificação). */
export function jsonEstavel(valor: unknown): string {
  return `${JSON.stringify(ordenar(valor), null, 2)}\n`;
}

export function escreverJson(caminho: string, valor: unknown): void {
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, jsonEstavel(valor), 'utf8');
}

export function lerJson<T>(caminho: string): T {
  return JSON.parse(readFileSync(caminho, 'utf8')) as T;
}

export function sha256Arquivo(caminho: string): string {
  return createHash('sha256').update(readFileSync(caminho)).digest('hex');
}
