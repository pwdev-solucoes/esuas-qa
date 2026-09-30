/**
 * Comparador esperado × apurado (#10994 · E17, BR-010, AC-002, AC-005, AC-013).
 *
 * - `extrairApurado()` lê a resposta real de `GET attendance-reports` e `GET capacitation-tallies` e
 *   devolve os valores no formato das chaves do `esperado.json` (convenções no próprio arquivo).
 * - `compararContadores()` / `compararPendencias()` devolvem divergências estruturadas
 *   `{ mes, unidade, contador, esperado, apurado, motivo }`.
 * - `classificar()` separa divergências EXPLICADAS por um achado RN14 comprovado (o produto recusou o
 *   cenário ou não aceita o dado pela API) das demais. Uma divergência sem explicação falha a etapa;
 *   a explicada continua listada (✖ explicada) — nunca é escondida nem "ajustada" no esperado.
 */

export interface LinhaEsperada {
  mes: string;
  unidade: string;
  contador: string;
  valor: number;
}

export interface PendenciaEsperada {
  kind: string;
  scope: 'tenant' | 'unit';
  unidade: string | null;
  mes: string | null;
  valor: number;
}

export interface Esperado {
  versao_elenco: string;
  meses: string[];
  unidades: string[];
  convencoes: string[];
  contadores: LinhaEsperada[];
  pendencias: PendenciaEsperada[];
}

export interface Divergencia {
  mes: string | null;
  unidade: string | null;
  contador: string;
  esperado: number | null;
  apurado: number | null;
  motivo: 'diferente' | 'ausente' | 'extra';
}

export interface DivergenciaClassificada extends Divergencia {
  explicacao: string | null;
}

/** Chave única mês|unidade|contador. */
export const chaveApurado = (mes: string | null, unidade: string | null, contador: string): string => `${mes ?? '-'}|${unidade ?? '-'}|${contador}`;

interface ValorApi {
  value: number;
  available?: boolean;
}

export interface UnidadeApuracao {
  uuid: string;
  counters: Record<string, ValorApi>;
  without_identified_person?: number;
  new_families_profile?: Record<string, ValorApi>;
  scfv_notes?: Record<string, boolean>;
  analytic_layouts?: Record<string, { eligible: number; incomplete: number; missing_fields: Record<string, number> | [] }>;
}

export interface TallyUnidade {
  social_unit: { uuid: string };
  has_no_records: boolean;
  counters: Array<{ siap_field: string; value: number }>;
}

export interface PendenciaApi {
  kind: string;
  count: number;
  scope: 'tenant' | 'unit';
  social_unit_uuid: string | null;
  target_route?: string;
}

/**
 * Valores apurados de um mês, no formato das chaves do esperado. `unidadePorUuid` traduz uuid → chave
 * de negócio (U-CN…); unidades fora do mapa são ignoradas.
 */
export function extrairApurado(mes: string, unidades: UnidadeApuracao[], tallies: TallyUnidade[], unidadePorUuid: Record<string, string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of unidades) {
    const k = unidadePorUuid[u.uuid];
    if (!k) continue;
    const por = (contador: string, v: number) => m.set(chaveApurado(mes, k, contador), v);
    for (const [c, v] of Object.entries(u.counters ?? {})) por(c, v.value);
    if (typeof u.without_identified_person === 'number') por('without_identified_person', u.without_identified_person);
    for (const [c, v] of Object.entries(u.new_families_profile ?? {})) por(`new_families_profile.${c}`, v.value);
    for (const [c, v] of Object.entries(u.scfv_notes ?? {})) por(`scfv_notes.${c}`, v ? 1 : 0);
    for (const [leiaute, a] of Object.entries(u.analytic_layouts ?? {})) {
      por(`analytic_layouts.${leiaute}.eligible`, a.eligible);
      por(`analytic_layouts.${leiaute}.incomplete`, a.incomplete);
      for (const [campo, v] of Object.entries(Array.isArray(a.missing_fields) ? {} : a.missing_fields)) por(`analytic_layouts.${leiaute}.missing_fields.${campo}`, v);
    }
  }
  for (const t of tallies) {
    const k = unidadePorUuid[t.social_unit.uuid];
    if (!k) continue;
    m.set(chaveApurado(mes, k, 'capacitation.has_no_records'), t.has_no_records ? 1 : 0);
    for (const c of t.counters) m.set(chaveApurado(mes, k, `capacitation.${c.siap_field}`), c.value);
  }
  return m;
}

/** `missing_fields.*` ausente na API vale 0 (a API omite campos com zero). */
const ausenteValeZero = (contador: string): boolean => contador.includes('.missing_fields.');

/**
 * Compara cada linha esperada com o apurado. Chaves apuradas que o esperado não conhece viram
 * divergência `extra` (contador novo na API que a massa não cobre), exceto `missing_fields` com zero.
 */
export function compararContadores(esperado: LinhaEsperada[], apurado: Map<string, number>): Divergencia[] {
  const out: Divergencia[] = [];
  const conhecidas = new Set<string>();
  for (const l of esperado) {
    const k = chaveApurado(l.mes, l.unidade, l.contador);
    conhecidas.add(k);
    let v = apurado.get(k);
    if (v === undefined && ausenteValeZero(l.contador)) v = 0;
    if (v === undefined) out.push({ mes: l.mes, unidade: l.unidade, contador: l.contador, esperado: l.valor, apurado: null, motivo: 'ausente' });
    else if (v !== l.valor) out.push({ mes: l.mes, unidade: l.unidade, contador: l.contador, esperado: l.valor, apurado: v, motivo: 'diferente' });
  }
  const meses = new Set(esperado.map((l) => l.mes));
  for (const [k, v] of apurado) {
    if (conhecidas.has(k)) continue;
    const [mes, unidade, contador] = k.split('|') as [string, string, string];
    if (!meses.has(mes)) continue;
    if (ausenteValeZero(contador) && v === 0) continue;
    out.push({ mes, unidade, contador, esperado: null, apurado: v, motivo: 'extra' });
  }
  return out;
}

/**
 * Pendências de cadastro (10994b) de um mês, visão Master sem filtro. Kinds de situação atual
 * (`mes: null` no esperado) valem para todos os meses. Contagem zero = ausente do bloco (RN07).
 */
export function compararPendencias(mes: string, esperadas: PendenciaEsperada[], apuradas: PendenciaApi[], unidadePorUuid: Record<string, string>): Divergencia[] {
  const esp = new Map<string, number>();
  for (const p of esperadas.filter((x) => x.mes === null || x.mes === mes)) esp.set(chaveApurado(mes, p.unidade, `pendencia.${p.kind}`), p.valor);
  const ap = new Map<string, number>();
  for (const p of apuradas) {
    const unidade = p.scope === 'unit' ? (unidadePorUuid[p.social_unit_uuid ?? ''] ?? `?${p.social_unit_uuid}`) : null;
    const k = chaveApurado(mes, unidade, `pendencia.${p.kind}`);
    ap.set(k, (ap.get(k) ?? 0) + p.count);
  }
  const out: Divergencia[] = [];
  for (const k of new Set([...esp.keys(), ...ap.keys()])) {
    const [m, u, contador] = k.split('|') as [string, string, string];
    const e = esp.get(k) ?? null;
    const a = ap.get(k) ?? null;
    if (e === a) continue;
    out.push({ mes: m, unidade: u === '-' ? null : u, contador, esperado: e, apurado: a, motivo: e === null ? 'extra' : a === null ? 'ausente' : 'diferente' });
  }
  return out;
}

/** Regra de explicação: devolve o texto do achado RN14 que explica a divergência, ou null. */
export type Explicacao = (d: Divergencia) => string | null;

export function classificar(divergencias: Divergencia[], explicacoes: Explicacao[]): { explicadas: DivergenciaClassificada[]; bloqueantes: DivergenciaClassificada[] } {
  const explicadas: DivergenciaClassificada[] = [];
  const bloqueantes: DivergenciaClassificada[] = [];
  for (const d of divergencias) {
    const explicacao = explicacoes.map((f) => f(d)).find((x) => x) ?? null;
    (explicacao ? explicadas : bloqueantes).push({ ...d, explicacao });
  }
  return { explicadas, bloqueantes };
}

/** Tabela de texto (mês × unidade × contador) para o log e o estado. */
export function formatarDivergencias(ds: DivergenciaClassificada[]): string {
  if (!ds.length) return '(nenhuma)';
  return ds
    .map((d) => `✖ ${d.mes ?? '-'} ${d.unidade ?? 'organização'} ${d.contador}: esperado ${d.esperado ?? '—'} × apurado ${d.apurado ?? '—'} (${d.motivo})${d.explicacao ? ` — explicada: ${d.explicacao}` : ''}`)
    .join('\n');
}
