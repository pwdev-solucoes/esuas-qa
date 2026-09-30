/**
 * Comparador de duas execuções da massa (#10994 · plano 06, CA04, BR-010, RN-T4).
 *
 *   npm run massa:comparar -- <execução A> <execução B>
 *
 * Cada argumento é uma pasta de execução (`relatorios/<AAAA-MM-DD_HHmm>`, ou `.cache/snapshots/<id>`
 * com `--sem-evidencias`) ou o próprio `snapshot.json`. A comparação é por CHAVE DE NEGÓCIO, depois
 * da mesma normalização do snapshot (sem `uuid`, `id`, `*_id`, timestamps técnicos nem `meta`), e
 * exige igualdade total, inclusive da apuração.
 *
 * Saída: 0 = idêntico; 1 = divergente (lista `{caminho, chave, A, B}`); 2 = uso/arquivo inválido.
 * Quando B é uma pasta com `index.html`, grava `determinismo.json` e atualiza a seção Determinismo do
 * índice de B (a pasta A não é tocada).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atualizarDeterminismo, type ResultadoDeterminismo } from '../lib/relatorio.ts';
import { normalizar, TOPO_IGNORADO } from '../lib/snapshot.ts';

export interface DivergenciaSnapshot {
  /** Tabela ou contador (`tabelas.familias`, `apuracao`, `pendencias`, `organizacao.nome`…). */
  caminho: string;
  /** Chave de negócio do item (`FAM_F-ENC`, `2026-07|U-CN|total_attendances`…). */
  chave: string;
  a: unknown;
  b: unknown;
}

type Obj = Record<string, unknown>;
const ehObjeto = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const ehListaComChave = (v: unknown): v is Obj[] => Array.isArray(v) && v.every((i) => ehObjeto(i) && 'chave' in i);
const ehPrimitivo = (v: unknown) => v === null || typeof v !== 'object';
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diff(a: unknown, b: unknown, caminho: string, chave: string, saida: DivergenciaSnapshot[]): void {
  if (igual(a, b)) return;
  if (ehListaComChave(a) && ehListaComChave(b)) {
    const ma = new Map(a.map((i) => [String(i.chave), i]));
    const mb = new Map(b.map((i) => [String(i.chave), i]));
    for (const k of [...new Set([...ma.keys(), ...mb.keys()])].sort()) {
      const ia = ma.get(k);
      const ib = mb.get(k);
      if (!ia || !ib) saida.push({ caminho, chave: k, a: ia ?? null, b: ib ?? null });
      else diff(ia, ib, caminho, k, saida);
    }
    return;
  }
  if (ehObjeto(a) && ehObjeto(b)) {
    // Mapa plano (ex.: apuração `mês|unidade|contador` → valor): cada chave é a chave de negócio.
    const plano = Object.values(a).every(ehPrimitivo) && Object.values(b).every(ehPrimitivo) && !chave;
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (plano) {
        if (!igual(a[k], b[k])) saida.push({ caminho, chave: k, a: a[k] ?? null, b: b[k] ?? null });
      } else diff(a[k], b[k], chave ? `${caminho}.${k}` : caminho ? `${caminho}.${k}` : k, chave, saida);
    }
    return;
  }
  saida.push({ caminho, chave: chave || '-', a: a ?? null, b: b ?? null });
}

/** Compara dois snapshots por chave de negócio (normalizados antes). Lista vazia = idênticos. */
export function compararSnapshots(a: unknown, b: unknown): DivergenciaSnapshot[] {
  const na = normalizar(a) as Obj;
  const nb = normalizar(b) as Obj;
  const saida: DivergenciaSnapshot[] = [];
  for (const k of [...new Set([...Object.keys(na ?? {}), ...Object.keys(nb ?? {})])].sort()) {
    if (TOPO_IGNORADO.has(k)) continue;
    const va = na?.[k];
    const vb = nb?.[k];
    if (k === 'tabelas' && ehObjeto(va) && ehObjeto(vb)) {
      for (const t of [...new Set([...Object.keys(va), ...Object.keys(vb)])].sort()) diff(va[t] ?? [], vb[t] ?? [], `tabelas.${t}`, '', saida);
    } else if (Array.isArray(va) && Array.isArray(vb) && !ehListaComChave(va)) {
      // Pendências: chave = mês|kind|escopo|unidade.
      const chaveDe = (p: unknown) => (ehObjeto(p) ? [p.mes, p.kind, p.scope, p.unidade].map((x) => x ?? '-').join('|') : JSON.stringify(p));
      diff(
        va.map((p) => ({ ...(ehObjeto(p) ? p : { valor: p }), chave: chaveDe(p) })),
        vb.map((p) => ({ ...(ehObjeto(p) ? p : { valor: p }), chave: chaveDe(p) })),
        k,
        '',
        saida,
      );
    } else diff(va, vb, k, '', saida);
  }
  return saida;
}

/** Resolve pasta ou arquivo para o `snapshot.json`. */
export function caminhoSnapshot(alvo: string): string {
  const p = resolve(alvo);
  if (!existsSync(p)) throw new Error(`não encontrado: ${alvo}`);
  const arquivo = statSync(p).isDirectory() ? resolve(p, 'snapshot.json') : p;
  if (!existsSync(arquivo)) throw new Error(`sem snapshot.json em ${alvo} (a E20 concluiu nessa execução?)`);
  return arquivo;
}

export function formatar(ds: DivergenciaSnapshot[], limite = 200): string {
  const linhas = ds.slice(0, limite).map((d) => `  ✖ ${d.caminho} · ${d.chave}: A=${JSON.stringify(d.a)} · B=${JSON.stringify(d.b)}`);
  if (ds.length > limite) linhas.push(`  … e mais ${ds.length - limite}`);
  return linhas.join('\n');
}

/** Executa a comparação; devolve o código de saída. */
export function executarComparacao(args: string[], log: (l: string) => void = (l) => process.stdout.write(`${l}\n`)): number {
  const alvos = args.filter((a) => !a.startsWith('--'));
  if (alvos.length !== 2) {
    log('Uso: npm run massa:comparar -- <execução A> <execução B>   (pasta da execução ou snapshot.json)');
    return 2;
  }
  let a: unknown;
  let b: unknown;
  let arqB: string;
  try {
    a = JSON.parse(readFileSync(caminhoSnapshot(alvos[0]!), 'utf8'));
    arqB = caminhoSnapshot(alvos[1]!);
    b = JSON.parse(readFileSync(arqB, 'utf8'));
  } catch (erro) {
    log(`✖ ${(erro as Error).message}`);
    return 2;
  }
  const ds = compararSnapshots(a, b);
  const tabelas = Object.keys(((normalizar(a) as Obj).tabelas as Obj) ?? {}).length;
  const contadores = Object.keys(((normalizar(a) as Obj).apuracao as Obj) ?? {}).length;
  if (ds.length === 0) log(`✔ Execuções idênticas por chave de negócio (${tabelas} tabelas, ${contadores} valores de apuração; uuid/id/timestamps ignorados).`);
  else log(`✖ Execuções divergentes em ${ds.length} item(ns):\n${formatar(ds)}`);

  const pastaB = resolve(alvos[1]!);
  if (statSync(pastaB).isDirectory() && existsSync(resolve(pastaB, 'index.html'))) {
    const r: ResultadoDeterminismo = { a: basename(resolve(alvos[0]!)), b: basename(pastaB), identico: ds.length === 0, divergencias: ds.length, em: new Date().toISOString() };
    writeFileSync(resolve(pastaB, 'determinismo.json'), `${JSON.stringify({ ...r, itens: ds.slice(0, 500) }, null, 2)}\n`, 'utf8');
    const indice = resolve(pastaB, 'index.html');
    writeFileSync(indice, atualizarDeterminismo(readFileSync(indice, 'utf8'), r), 'utf8');
    log(`  índice de ${r.b} atualizado (Determinismo) e determinismo.json gravado.`);
  }
  return ds.length === 0 ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = executarComparacao(process.argv.slice(2));
}
