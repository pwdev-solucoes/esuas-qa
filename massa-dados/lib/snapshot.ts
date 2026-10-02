/**
 * Snapshot da massa por CHAVE DE NEGÓCIO (#10994 · plano 06, CA04, RN-T4, BR-010).
 *
 * - `normalizar()`: remove campos técnicos (`id`, `uuid`, `*_id`, `*_uuid`, `created_at`, `updated_at`,
 *   `deleted_at`), ordena as chaves dos objetos e as listas (por `chave` quando houver). É a mesma
 *   normalização usada pelo comparador, então duas execuções só diferem por dado de negócio.
 * - `coletarSnapshot()`: lê a organização demo no banco (SQL somente leitura, `verificacoes-sql.ts`)
 *   traduzindo cada uuid para a chave de negócio registrada pelas etapas (`FAM_F-ENC`, `REG_ATD-…`,
 *   `PES_PES-001`, `UNIT_U-CN`…), mais a apuração completa dos 3 meses pela API (Master), no mesmo
 *   formato do `esperado.json`. Sem senha, token, cookie, uuid, id nem timestamp técnico.
 */
import type { ContextoEtapa } from './papeis.ts';
import { dados } from './papeis.ts';
import { lerEstado } from './execucao.ts';
import { extrairApurado, type PendenciaApi, type TallyUnidade, type UnidadeApuracao } from './esperado.ts';
import { consultar } from './verificacoes-sql.ts';

export interface PendenciaSnapshot {
  mes: string;
  kind: string;
  scope: string;
  unidade: string | null;
  count: number;
}

export interface Snapshot {
  formato: 1;
  /** Informativo; ignorado na comparação. */
  meta: { execucao: string; gerado_em: string };
  elenco: string;
  organizacao: Record<string, unknown>;
  tabelas: Record<string, Array<Record<string, unknown>>>;
  /** `mês|unidade|contador` → valor (formato do esperado.json). */
  apuracao: Record<string, number>;
  pendencias: PendenciaSnapshot[];
}

/** Campo técnico (nunca comparado). */
export const CAMPO_TECNICO = /^(id|uuid|created_at|updated_at|deleted_at)$|_id$|_uuid$/;

/** Chaves de topo ignoradas na comparação. */
export const TOPO_IGNORADO = new Set(['meta']);

function estavel(v: unknown): string {
  return JSON.stringify(v);
}

/** Remove campos técnicos, ordena chaves e listas. Não altera a entrada. */
export function normalizar<T = unknown>(valor: T): T {
  const n = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const itens = v.map(n);
      const comChave = itens.every((i) => i && typeof i === 'object' && !Array.isArray(i) && 'chave' in (i as Record<string, unknown>));
      return comChave
        ? [...itens].sort((a, b) => String((a as { chave: unknown }).chave).localeCompare(String((b as { chave: unknown }).chave)))
        : [...itens].sort((a, b) => estavel(a).localeCompare(estavel(b)));
    }
    if (v && typeof v === 'object') {
      const saida: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (CAMPO_TECNICO.test(k) && !/[|.]/.test(k)) continue;
        saida[k] = n((v as Record<string, unknown>)[k]);
      }
      return saida;
    }
    return v;
  };
  return n(valor) as T;
}

/** Mapa uuid → chave de negócio a partir das chaves registradas no estado (só valores com cara de uuid). */
export function inverterChaves(chaves: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(chaves)) if (/^[0-9a-f-]{36}$/i.test(v) && !m.has(v)) m.set(v, k);
  return m;
}

/** Tabelas de registro mensal: coluna de data, unidade e colunas extras de negócio. */
export const TABELAS_REGISTRO: Record<string, { tabela: string; data: string; unidade: boolean; familia: boolean; extras: string[] }> = {
  attendance: { tabela: 'attendances', data: 'attended_on', unidade: true, familia: true, extras: ['status'] },
  referral: { tabela: 'referrals', data: 'referred_on', unidade: true, familia: true, extras: ['status', 'outcome'] },
  follow_up: { tabela: 'family_follow_ups', data: 'admitted_on', unidade: true, familia: true, extras: ['status', "to_char(x.discharged_on, 'YYYY-MM-DD')"] },
  participation: { tabela: 'family_member_participations', data: 'started_on', unidade: true, familia: true, extras: ['status', "to_char(x.ended_on, 'YYYY-MM-DD')"] },
  eventual_benefit: { tabela: 'family_eventual_benefits', data: 'granted_on', unidade: true, familia: true, extras: ['status'] },
  sheltering: { tabela: 'family_shelterings', data: 'started_on', unidade: false, familia: true, extras: ['status'] },
  capacitation: { tabela: 'capacitation_actions', data: 'coalesce(x.occurred_on, x.started_on)', unidade: true, familia: false, extras: ['status', 'title'] },
};

const UNIDADES = ['U-CN', 'U-CS', 'U-CE'] as const;

/** Monta o snapshot da organização demo (SQL somente leitura + apuração pela API como Master). */
export async function coletarSnapshot(ctx: ContextoEtapa, meses: string[]): Promise<Snapshot> {
  const { estado } = lerEstado(ctx.caminho);
  const inv = inverterChaves(estado.chaves);
  const chave = (uuid: string, alternativa: string) => (uuid && inv.get(uuid)) || alternativa;
  const cnpj = ctx.elenco.organizacao.cnpj.replace(/\D/g, '');
  const T = `(SELECT id FROM tenants WHERE cnpj = '${cnpj}')`;
  const q = (sql: string) => consultar(ctx.cfg, sql);
  const tabelas: Snapshot['tabelas'] = {};

  const [org] = q(`SELECT legal_name, coalesce(trade_name, ''), cnpj, coalesce(email, ''), timezone FROM tenants WHERE cnpj = '${cnpj}'`);
  const organizacao = { nome: org?.[0], nome_fantasia: org?.[1], cnpj: org?.[2], email: org?.[3], fuso: org?.[4] };

  tabelas.unidades = q(
    `SELECT su.uuid, su.mds_number, su.name, t.name, coalesce(su.email, '') FROM social_units su JOIN social_unit_types t ON t.id = su.type_id WHERE su.tenant_id = ${T} AND su.deleted_at IS NULL`,
  ).map(([uuid, mds, nome, tipo, email]) => ({ chave: chave(uuid, `mds:${mds}`), mds, nome, tipo, email }));

  tabelas.entidades = q(`SELECT uuid, cnpj, legal_name, coalesce(cneas_number, '') FROM social_entities WHERE tenant_id = ${T} AND deleted_at IS NULL`).map(
    ([uuid, c, nome, cneas]) => ({ chave: chave(uuid, `cnpj:${c}`), cnpj: c, nome, cneas }),
  );

  tabelas.usuarios = q(
    `SELECT u.cpf, u.email, u.full_name, string_agg(r.name, ',' ORDER BY r.name) FROM users u JOIN user_tenant_role utr ON utr.user_id = u.id AND utr.deleted_at IS NULL ` +
      `JOIN roles r ON r.id = utr.role_id WHERE utr.tenant_id = ${T} AND u.deleted_at IS NULL GROUP BY u.cpf, u.email, u.full_name`,
  ).map(([cpf, email, nome, papeis]) => ({ chave: `cpf:${cpf}`, cpf, email, nome, papeis }));

  tabelas.profissionais = q(
    `SELECT u.cpf, coalesce(tp.registration_number, ''), coalesce(tp.status, ''), coalesce(c.code, '') FROM tenant_professionals tp JOIN users u ON u.id = tp.user_id ` +
      `LEFT JOIN cbos c ON c.id = tp.cbo_id WHERE tp.tenant_id = ${T} AND tp.deleted_at IS NULL`,
  ).map(([cpf, matricula, status, cbo]) => ({ chave: `cpf:${cpf}`, matricula, status, cbo }));

  tabelas.lotacoes = q(
    `SELECT u.cpf, su.uuid, to_char(a.start_date, 'YYYY-MM-DD'), coalesce(to_char(a.end_date, 'YYYY-MM-DD'), ''), coalesce(c.code, '') FROM social_tenant_professional_assignments a ` +
      `JOIN tenant_professionals tp ON tp.id = a.tenant_professional_id JOIN users u ON u.id = tp.user_id JOIN social_units su ON su.id = a.social_unit_id ` +
      `LEFT JOIN cbos c ON c.id = a.cbo_id WHERE a.tenant_id = ${T}`,
  ).map(([cpf, unidade, desde, ate, cbo]) => ({ chave: `cpf:${cpf}@${chave(unidade, 'unidade?')}@${desde}`, desde, ate, cbo }));

  tabelas.pessoas = q(
    `SELECT DISTINCT p.uuid, coalesce(p.cpf, ''), p.full_name, to_char(p.birth_date, 'YYYY-MM-DD'), coalesce(p.mother_name, '') FROM persons p ` +
      `JOIN family_members fm ON fm.person_id = p.id WHERE fm.tenant_id = ${T}`,
  ).map(([uuid, cpf, nome, nascimento, mae]) => ({ chave: chave(uuid, cpf ? `cpf:${cpf}` : `pessoa:${nome}|${nascimento}`), cpf, nome, nascimento, mae }));

  tabelas.familias = q(
    `SELECT f.uuid, coalesce(su.uuid::text, ''), coalesce(to_char(f.referenced_at, 'YYYY-MM-DD'), ''), rp.uuid, ` +
      `(SELECT count(*) FROM family_members m WHERE m.family_id = f.id AND m.deleted_at IS NULL), ` +
      `(SELECT count(*) FROM family_social_specificities s WHERE s.family_id = f.id AND s.deleted_at IS NULL), ` +
      `(SELECT count(*) FROM family_social_specificities s WHERE s.family_id = f.id AND s.deleted_at IS NULL AND s.confirmed_at IS NOT NULL), ` +
      `coalesce(st.code, '') FROM families f LEFT JOIN social_units su ON su.id = f.social_unit_id LEFT JOIN persons rp ON rp.id = f.responsible_person_id ` +
      `LEFT JOIN family_statuses st ON st.id = f.status_id WHERE f.tenant_id = ${T} AND f.deleted_at IS NULL`,
  ).map(([uuid, unidade, referenciada, resp, integrantes, esp, espConf, status]) => ({
    chave: chave(uuid, `familia-resp:${chave(resp, resp)}`),
    unidade: unidade ? chave(unidade, 'unidade?') : null,
    referenciada_em: referenciada || null,
    responsavel: chave(resp, 'pessoa?'),
    integrantes: Number(integrantes),
    especificidades: Number(esp),
    especificidades_confirmadas: Number(espConf),
    situacao: status,
  }));

  tabelas.integrantes = q(
    `SELECT f.uuid, p.uuid, coalesce(k.code, ''), fm.is_responsible, fm.deleted_at IS NULL FROM family_members fm JOIN families f ON f.id = fm.family_id ` +
      `JOIN persons p ON p.id = fm.person_id LEFT JOIN kinship_types k ON k.id = fm.kinship_type_id WHERE fm.tenant_id = ${T}`,
  ).map(([fam, pes, parentesco, resp, ativo]) => ({ chave: `${chave(fam, 'familia?')}/${chave(pes, 'pessoa?')}`, parentesco, responsavel: resp === 't', ativo: ativo === 't' }));

  for (const [tipo, t] of Object.entries(TABELAS_REGISTRO)) {
    const data = t.data.includes('(') ? t.data : `x.${t.data}`;
    const extras = t.extras.map((c) => (c.includes('(') ? `coalesce(${c}, '')` : `coalesce(x.${c}::text, '')`));
    const linhas = q(
      `SELECT x.uuid, to_char(${data}, 'YYYY-MM-DD'), ${t.unidade ? "coalesce(su.uuid::text, '')" : "''"}, ${t.familia ? "coalesce(f.uuid::text, '')" : "''"}${extras.length ? `, ${extras.join(', ')}` : ''} ` +
        `FROM ${t.tabela} x ${t.unidade ? 'LEFT JOIN social_units su ON su.id = x.social_unit_id ' : ''}${t.familia ? 'LEFT JOIN families f ON f.id = x.family_id ' : ''}` +
        `WHERE x.tenant_id = ${T} AND x.deleted_at IS NULL`,
    );
    tabelas[`registros_${tipo}`] = linhas.map(([uuid, data_fato, unidade, familia, ...resto]) => ({
      chave: chave(uuid, `sem-chave:${data_fato}|${unidade ? chave(unidade, '?') : '-'}|${familia ? chave(familia, '?') : '-'}`),
      data: data_fato,
      unidade: unidade ? chave(unidade, 'unidade?') : null,
      familia: familia ? chave(familia, 'familia?') : null,
      ...Object.fromEntries(t.extras.map((c, i) => [c.replace(/^to_char\(x\.(\w+).*$/, '$1'), resto[i] ?? ''])),
    }));
  }

  // Apuração completa (Master, sem filtro de unidade) + capacitação + pendências.
  const unidadePorUuid = Object.fromEntries(UNIDADES.map((u) => [ctx.chaves.obter(`UNIT_${u}`), u]));
  const master = await ctx.sessoes.entrar('M0');
  const apuracao: Record<string, number> = {};
  const pendencias: PendenciaSnapshot[] = [];
  for (const mes of meses) {
    const [ano, m] = mes.split('-').map(Number) as [number, number];
    const rel = dados<{ units: UnidadeApuracao[]; registration_pendencies?: PendenciaApi[] }>((await master.get(`/api/client/attendance-reports?exercise=${ano}&reference_month=${m}`)).corpo);
    const tallies = dados<TallyUnidade[]>((await master.get(`/api/client/capacitation-tallies?exercise=${ano}&month=${m}`)).corpo);
    for (const [k, v] of extrairApurado(mes, rel.units, tallies, unidadePorUuid)) apuracao[k] = v;
    for (const p of rel.registration_pendencies ?? []) {
      pendencias.push({ mes, kind: p.kind, scope: p.scope, unidade: p.social_unit_uuid ? (unidadePorUuid[p.social_unit_uuid] ?? 'outra?') : null, count: p.count });
    }
  }

  return {
    formato: 1,
    meta: { execucao: estado.id, gerado_em: new Date().toISOString() },
    elenco: ctx.elenco.versao,
    organizacao,
    tabelas: normalizar(tabelas),
    apuracao: normalizar(apuracao),
    pendencias: normalizar(pendencias),
  };
}
