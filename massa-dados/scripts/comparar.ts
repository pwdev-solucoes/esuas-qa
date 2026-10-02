/**
 * Comparador de duas execuções da massa (#10994 · plano 06, CA04, BR-010, RN-T4).
 *
 *   npm run massa:comparar -- <execução A> <execução B>
 *   npm run massa:comparar -- --modo=api-x-seed <execução pela API> <conferência do seed>   (plano 10)
 *
 * Cada argumento é uma pasta de execução (`relatorios/<AAAA-MM-DD_HHmm>`, ou `.cache/snapshots/<id>`
 * com `--sem-evidencias`) ou o próprio `snapshot.json`. A comparação é por CHAVE DE NEGÓCIO, depois
 * da mesma normalização do snapshot (sem `uuid`, `id`, `*_id`, timestamps técnicos nem `meta`), e
 * exige igualdade total, inclusive da apuração.
 *
 * Saída: 0 = idêntico; 1 = divergente (lista `{caminho, chave, A, B}`); 2 = uso/arquivo inválido.
 * Com `--modo=api-x-seed` (BR-005) as divergências são separadas em ESPERADAS (cenários só via seed,
 * com o lado seed igual ao `esperado.json` quando é apuração/pendência) e INESPERADAS; só as inesperadas
 * dão código 1. Grava `comparacao-api-x-seed.json` na pasta B e não mexe no Determinismo (CA04 é
 * entre duas execuções do mesmo modo).
 * Quando B é uma pasta com `index.html`, grava `determinismo.json` e atualiza a seção Determinismo do
 * índice de B (a pasta A não é tocada).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// ---------------------------------------------------------------------------------------------
// Modo api-x-seed (plano 10, BR-005)
// ---------------------------------------------------------------------------------------------

const PASTA_INSUMOS = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'insumos');

/** Insumos de que a classificação precisa (lidos do `qa`; injetáveis nos testes). */
export interface InsumosClassificacao {
  /** `mês|unidade|contador` → valor esperado. */
  contadores: Map<string, number>;
  /** `mês|kind|escopo|unidade` → valor esperado (pendência de situação atual vale para todo mês). */
  pendencias: Array<{ kind: string; scope: string; unidade: string | null; mes: string | null; valor: number }>;
  /** Chaves `PES_*` das pessoas das famílias F-SEM-REF. */
  pessoasSemRef: Set<string>;
}

export function lerInsumosClassificacao(pasta = PASTA_INSUMOS): InsumosClassificacao {
  const esperado = JSON.parse(readFileSync(resolve(pasta, 'esperado.json'), 'utf8')) as {
    contadores: Array<{ mes: string; unidade: string; contador: string; valor: number }>;
    pendencias: InsumosClassificacao['pendencias'];
  };
  const elenco = JSON.parse(readFileSync(resolve(pasta, 'elenco.json'), 'utf8')) as { pessoas: Array<{ chave: string; familia_chave: string | null }> };
  return {
    contadores: new Map(esperado.contadores.map((c) => [`${c.mes}|${c.unidade}|${c.contador}`, c.valor])),
    pendencias: esperado.pendencias,
    pessoasSemRef: new Set(elenco.pessoas.filter((p) => (p.familia_chave ?? '').startsWith('F-SEM-REF')).map((p) => `PES_${p.chave}`)),
  };
}

export const CENARIO_ENT2 = 'ENT-2 sem CNEAS';
export const CENARIO_SEM_REF = 'F-SEM-REF-1..3 sem unidade de referência';
export const CENARIO_PERFIS = 'perfis do 15.7 (renda per capita, PBF, trabalho infantil)';

const PERFIL_SO_SEED = /^new_families_profile\.profile_(extreme_poverty|bolsa_familia|child_labor)$/;
const PENDENCIA_SO_SEED: Record<string, string> = { entity_without_cneas: CENARIO_ENT2, family_without_reference_unit: CENARIO_SEM_REF };

/**
 * Cenário só via seed que explica a divergência (A = API, B = seed), ou `null` (inesperada).
 * Apuração e pendência só são esperadas quando o lado seed (B) bate com o `esperado.json`.
 */
export function cenarioSoViaSeed(d: DivergenciaSnapshot, ins: InsumosClassificacao): string | null {
  if (d.caminho === 'tabelas.entidades' && d.chave === 'ENT_ENT-2' && d.a === null) return CENARIO_ENT2;
  // Modo seed: a NumeroCNEAS da ENT-2 bloqueia a remessa — sem remessa (SIAP_REMESSA) no lado seed.
  if (/remess|siap/i.test(`${d.caminho} ${d.chave}`) && d.b === null) return CENARIO_ENT2;
  if (d.caminho === 'tabelas.familias' && d.chave.startsWith('FAM_F-SEM-REF-') && d.a === null) return CENARIO_SEM_REF;
  if (d.caminho === 'tabelas.integrantes' && d.chave.startsWith('FAM_F-SEM-REF-') && d.a === null) return CENARIO_SEM_REF;
  if (d.caminho === 'tabelas.pessoas' && ins.pessoasSemRef.has(d.chave) && d.a === null) return CENARIO_SEM_REF;
  if (d.caminho === 'apuracao') {
    const [, , contador = ''] = d.chave.split('|');
    if (!PERFIL_SO_SEED.test(contador)) return null;
    return ins.contadores.get(d.chave) === d.b ? CENARIO_PERFIS : null;
  }
  if (d.caminho === 'pendencias' || d.caminho === 'pendencias.count') {
    const [mes, kind = '', scope, unidade] = d.chave.split('|');
    const cenario = PENDENCIA_SO_SEED[kind];
    if (!cenario) return null;
    const b = typeof d.b === 'number' ? d.b : ((d.b as { count?: number } | null)?.count ?? 0);
    const esp = ins.pendencias.find((p) => p.kind === kind && p.scope === scope && (p.unidade ?? '-') === unidade && (p.mes === null || p.mes === mes));
    return esp && esp.valor === b ? cenario : null;
  }
  return null;
}

export function classificarApiXSeed(ds: DivergenciaSnapshot[], ins: InsumosClassificacao): { esperadas: Array<DivergenciaSnapshot & { cenario: string }>; inesperadas: DivergenciaSnapshot[] } {
  const esperadas: Array<DivergenciaSnapshot & { cenario: string }> = [];
  const inesperadas: DivergenciaSnapshot[] = [];
  for (const d of ds) {
    const cenario = cenarioSoViaSeed(d, ins);
    if (cenario) esperadas.push({ ...d, cenario });
    else inesperadas.push(d);
  }
  return { esperadas, inesperadas };
}

function comparacaoApiXSeed(a: unknown, b: unknown, alvos: [string, string], log: (l: string) => void, ins: InsumosClassificacao): number {
  const ds = compararSnapshots(a, b);
  const { esperadas, inesperadas } = classificarApiXSeed(ds, ins);
  const porCenario = new Map<string, number>();
  for (const e of esperadas) porCenario.set(e.cenario, (porCenario.get(e.cenario) ?? 0) + 1);
  log(`API × seed: ${ds.length} divergência(s) — ${esperadas.length} esperada(s) (cenários só via seed), ${inesperadas.length} inesperada(s).`);
  for (const [c, n] of porCenario) log(`  ✔ esperada · ${c}: ${n} item(ns)`);
  if (esperadas.length) log(formatar(esperadas, 60).replace(/✖/g, '·'));
  if (inesperadas.length) log(`✖ Inesperadas:\n${formatar(inesperadas)}`);
  else log('✔ Nenhuma divergência inesperada entre a execução pela API e a conferência do seed.');
  const pastaB = resolve(alvos[1]);
  if (statSync(pastaB).isDirectory()) {
    const r = { modo: 'api-x-seed', a: basename(resolve(alvos[0])), b: basename(pastaB), em: new Date().toISOString(), esperadas: esperadas.length, inesperadas: inesperadas.length, por_cenario: Object.fromEntries(porCenario), itens_esperados: esperadas.slice(0, 500), itens_inesperados: inesperadas.slice(0, 500) };
    writeFileSync(resolve(pastaB, 'comparacao-api-x-seed.json'), `${JSON.stringify(r, null, 2)}\n`, 'utf8');
    log(`  comparacao-api-x-seed.json gravado em ${r.b}.`);
  }
  return inesperadas.length ? 1 : 0;
}

/** Executa a comparação; devolve o código de saída. */
export function executarComparacao(args: string[], log: (l: string) => void = (l) => process.stdout.write(`${l}\n`), insumos?: InsumosClassificacao): number {
  const alvos = args.filter((a) => !a.startsWith('--'));
  const modos = args.filter((a) => a.startsWith('--'));
  const modo = modos.find((a) => a.startsWith('--modo='))?.slice('--modo='.length) ?? 'determinismo';
  if (modos.some((a) => !a.startsWith('--modo=')) || !['determinismo', 'api-x-seed'].includes(modo) || alvos.length !== 2) {
    log('Uso: npm run massa:comparar -- [--modo=api-x-seed] <execução A> <execução B>   (pasta da execução ou snapshot.json)');
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
  if (modo === 'api-x-seed') return comparacaoApiXSeed(a, b, [alvos[0]!, alvos[1]!], log, insumos ?? lerInsumosClassificacao());
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
