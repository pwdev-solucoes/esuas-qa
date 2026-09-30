/**
 * E17 — Apuração mensal × números esperados (#10994 · roadmap 07/E17, CA05–CA08, CA10, RN09, BR-010).
 * Papel: Master (vê todas as unidades, sem filtro).
 *
 * 17.0 pré-conferência (AC-001): registros gravados por tipo × mês × unidade (SQL somente leitura)
 *      iguais aos do elenco.
 * 17.1/17.2 apuração (`attendance-reports`) e capacitação (`capacitation-tallies`) de 2026-06/07/08.
 * 17.3 comparação de CADA contador de `esperado.json` e das pendências (`registration_pendencies`).
 *      Divergência sem explicação = falha. Divergência explicada por achado RN14 COMPROVADO (o produto
 *      recusou o cenário na E05/E08, ou não aceita o dado pela API — conferido no banco agora) fica
 *      listada como "✖ explicada" e vira achado; o esperado nunca é ajustado para passar.
 * Asserções nominais: CA06 (F-IDOSO, F-GRUPO, perfis), CA08 (F-DUPLA), RN09 (zero declarado), CA10
 * (pessoas atendidas sem CPF, conferidas também no banco) e 15.9 (capacitação).
 */
import { expect } from '@playwright/test';
import { lerEstado } from '../lib/execucao.ts';
import {
  classificar,
  compararContadores,
  compararPendencias,
  extrairApurado,
  formatarDivergencias,
  type Divergencia,
  type Esperado,
  type Explicacao,
  type PendenciaApi,
  type TallyUnidade,
  type UnidadeApuracao,
} from '../lib/esperado.ts';
import { dados, etapa, lerInsumo } from '../lib/papeis.ts';
import { registrosDoElenco, type RegistroElenco } from '../lib/registros.ts';
import { consultar } from '../lib/verificacoes-sql.ts';

const UNIDADES = ['U-CN', 'U-CS', 'U-CE'] as const;
const FAIXAS = ['children_0_6', 'preadolescents_7_14', 'adolescents_15_17', 'adults_18_59'];
/** Perfis do 15.7 que vêm de campos só gravados pela importação CadÚnico (StoreFamilyRequest os proíbe). */
const PERFIS_SO_CADUNICO: Record<string, string> = {
  profile_extreme_poverty: 'families.per_capita_income',
  profile_bolsa_familia: 'families.receives_pbf',
  profile_child_labor: 'family_members.child_labor',
};

/** Tabela, coluna de data e se tem unidade, por tipo de registro (pré-conferência). */
const TABELAS: Record<RegistroElenco['tipo'], { tabela: string; data: string; unidade: boolean; filtro?: string }> = {
  attendance: { tabela: 'attendances', data: 'attended_on', unidade: true, filtro: "x.status <> 'cancelled'" },
  referral: { tabela: 'referrals', data: 'referred_on', unidade: true },
  follow_up: { tabela: 'family_follow_ups', data: 'admitted_on', unidade: true },
  participation: { tabela: 'family_member_participations', data: 'started_on', unidade: true },
  eventual_benefit: { tabela: 'family_eventual_benefits', data: 'granted_on', unidade: true },
  sheltering: { tabela: 'family_shelterings', data: 'started_on', unidade: false },
  capacitation: { tabela: 'capacitation_actions', data: 'coalesce(x.occurred_on, x.started_on)', unidade: true },
};

etapa('E17', 'Apuração × esperado (3 meses × 3 unidades) e pendências de cadastro', 'M0', async (ctx) => {
  const esperado = lerInsumo<Esperado>('esperado.json');
  const cnpj = ctx.elenco.organizacao.cnpj.replace(/\D/g, '');
  const tenant = `(SELECT id FROM tenants WHERE cnpj = '${cnpj}')`;
  const idParaUnidade = new Map(UNIDADES.map((u) => [ctx.chaves.obter(`UNIT_ID_${u}`), u]));
  const unidadePorUuid = Object.fromEntries(UNIDADES.map((u) => [ctx.chaves.obter(`UNIT_${u}`), u]));
  const falhas: string[] = [];

  // ── 17.0 pré-conferência: tipo × mês × unidade (AC-001) ────────────────────────────
  const doElenco = new Map<string, number>();
  for (const r of registrosDoElenco()) {
    const k = `${r.tipo}|${r.data_fato.slice(0, 7)}|${TABELAS[r.tipo].unidade ? r.unidade : '-'}`;
    doElenco.set(k, (doElenco.get(k) ?? 0) + 1);
  }
  const gravados = new Map<string, number>();
  for (const [tipo, t] of Object.entries(TABELAS)) {
    const data = t.data.includes('(') ? t.data : `x.${t.data}`;
    const linhas = consultar(
      ctx.cfg,
      `SELECT to_char(${data}, 'YYYY-MM'), ${t.unidade ? 'x.social_unit_id' : "'-'"}, count(*) FROM ${t.tabela} x ` +
        `WHERE x.tenant_id = ${tenant} AND x.deleted_at IS NULL${t.filtro ? ` AND ${t.filtro}` : ''} GROUP BY 1, 2`,
    );
    for (const [mes, unidade, n] of linhas) {
      const u = unidade === '-' ? '-' : (idParaUnidade.get(unidade as string) ?? `id:${unidade}`);
      gravados.set(`${tipo}|${mes}|${u}`, Number(n));
    }
  }
  const preConferencia: string[] = [];
  for (const k of new Set([...doElenco.keys(), ...gravados.keys()])) {
    if ((doElenco.get(k) ?? 0) !== (gravados.get(k) ?? 0)) preConferencia.push(`${k}: elenco ${doElenco.get(k) ?? 0} × gravado ${gravados.get(k) ?? 0}`);
  }
  ctx.registro.passo({ passo: '17.0 pré-conferência tipo × mês × unidade', combinacoes: doElenco.size, divergencias: preConferencia });
  if (preConferencia.length) falhas.push(`pré-conferência: ${preConferencia.join('; ')}`);

  // ── 17.1/17.2 apuração dos 3 meses ──────────────────────────────────────────────────
  const master = await ctx.sessoes.entrar('M0');
  const apurado = new Map<string, number>();
  const pendencias: Record<string, PendenciaApi[]> = {};
  const brutos: Record<string, UnidadeApuracao[]> = {};
  const talliesPorMes: Record<string, TallyUnidade[]> = {};
  for (const mes of esperado.meses) {
    const [ano, m] = mes.split('-').map(Number) as [number, number];
    const rel = dados<{ units: UnidadeApuracao[]; scope: { is_master: boolean }; registration_pendencies?: PendenciaApi[] }>(
      (await master.get(`/api/client/attendance-reports?exercise=${ano}&reference_month=${m}`)).corpo,
    );
    expect(rel.scope.is_master, 'apuração vista pelo Master').toBe(true);
    expect(rel.registration_pendencies, 'bloco registration_pendencies (10994b) presente').toBeDefined();
    const tallies = dados<TallyUnidade[]>((await master.get(`/api/client/capacitation-tallies?exercise=${ano}&month=${m}`)).corpo);
    brutos[mes] = rel.units;
    talliesPorMes[mes] = tallies;
    pendencias[mes] = rel.registration_pendencies ?? [];
    for (const [k, v] of extrairApurado(mes, rel.units, tallies, unidadePorUuid)) apurado.set(k, v);
  }

  // ── 17.3 comparação ─────────────────────────────────────────────────────────────────
  const divergencias: Divergencia[] = compararContadores(esperado.contadores, apurado);
  for (const mes of esperado.meses) divergencias.push(...compararPendencias(mes, esperado.pendencias, pendencias[mes] ?? [], unidadePorUuid));

  // Explicações RN14 (só com a causa comprovada agora).
  const avisos = lerEstado(ctx.caminho).estado.etapas.flatMap((e) => e.avisos.map((a) => ({ etapa: e.etapa, a })));
  const recusadas = (etapaId: string, prefixo: string) => avisos.filter((x) => x.etapa === etapaId && x.a.startsWith('ACHADO RN14') && x.a.includes(prefixo)).length;
  const entidadesRecusadas = recusadas('E05', 'ENT-');
  const familiasRecusadas = recusadas('E08', 'F-SEM-REF');
  const naoNulos = Number(
    consultar(
      ctx.cfg,
      `SELECT (SELECT count(*) FROM families WHERE tenant_id = ${tenant} AND (per_capita_income IS NOT NULL OR receives_pbf IS NOT NULL)) + ` +
        `(SELECT count(*) FROM family_members WHERE tenant_id = ${tenant} AND child_labor)`,
    )[0]?.[0],
  );
  const explicacoes: Explicacao[] = [
    (d) =>
      d.contador === 'pendencia.entity_without_cneas' && entidadesRecusadas > 0 && (d.apurado ?? 0) === (d.esperado ?? 0) - entidadesRecusadas
        ? `E05 registrou ${entidadesRecusadas} entidade(s) sem CNEAS recusada(s) pela API (CNEAS obrigatório no cadastro)`
        : null,
    (d) =>
      d.contador === 'pendencia.family_without_reference_unit' && familiasRecusadas > 0 && (d.apurado ?? 0) === (d.esperado ?? 0) - familiasRecusadas
        ? `E08 registrou ${familiasRecusadas} família(s) sem unidade recusada(s) pela API (unidade obrigatória no cadastro manual)`
        : null,
    (d) => {
      const perfil = d.contador.replace('new_families_profile.', '');
      if (!d.contador.startsWith('new_families_profile.') || !PERFIS_SO_CADUNICO[perfil] || d.apurado !== 0 || naoNulos !== 0) return null;
      return `${PERFIS_SO_CADUNICO[perfil]} só é gravado pela importação CadÚnico (${perfil === 'profile_child_labor' ? 'nenhum endpoint do client grava trabalho infantil do integrante' : 'StoreFamilyRequest/intake proíbem renda e PBF'}) — no banco, 0 famílias/integrantes da demo com o dado`;
    },
  ];
  const { explicadas, bloqueantes } = classificar(divergencias, explicacoes);
  for (const texto of new Set(explicadas.map((d) => d.explicacao as string))) ctx.achado(`E17: ${texto}; divergências explicadas: ${explicadas.filter((d) => d.explicacao === texto).map((d) => `${d.mes} ${d.unidade ?? 'organização'} ${d.contador}`).join(', ')}`);
  ctx.log(`  E17 — ${esperado.contadores.length} contadores × 3 meses; explicadas (RN14):\n${formatarDivergencias(explicadas)}\n  não explicadas:\n${formatarDivergencias(bloqueantes)}`);
  ctx.registro.passo({
    passo: '17.3 esperado × apurado',
    contadores_comparados: esperado.contadores.length,
    pendencias_esperadas: esperado.pendencias.length,
    divergencias_explicadas: explicadas,
    divergencias_nao_explicadas: bloqueantes,
  });
  if (bloqueantes.length) falhas.push(`${bloqueantes.length} divergência(s) sem explicação:\n${formatarDivergencias(bloqueantes)}`);

  // ── asserções nominais ──────────────────────────────────────────────────────────────
  const v = (mes: string, u: string, c: string) => apurado.get(`${mes}|${u}|${c}`);
  const nominal = (ok: boolean, texto: string, dado: Record<string, unknown>) => {
    ctx.registro.passo({ passo: `nominal: ${texto}`, ok, ...dado });
    if (!ok) falhas.push(`${texto}: ${JSON.stringify(dado)}`);
  };
  // RN09 — zero declarado.
  const ce06 = brutos['2026-06']?.find((u) => unidadePorUuid[u.uuid] === 'U-CE')?.counters.total_attendances;
  nominal(ce06?.value === 0 && ce06?.available === true, 'RN09 U-CE/2026-06 zero declarado', { total_attendances: ce06 ?? null });
  // CA06 — F-IDOSO (U-CN, serviço 900 desde 06) e F-GRUPO (U-CS/07, grupo PAIF).
  for (const mes of esperado.meses) nominal(v(mes, 'U-CN', 'scfv_notes.elderly_outside_range') === 1, `CA06 F-IDOSO elderly_outside_range em U-CN/${mes}`, { valor: v(mes, 'U-CN', 'scfv_notes.elderly_outside_range') });
  const faixasCs07 = FAIXAS.map((f) => v('2026-07', 'U-CS', f) ?? -1);
  nominal((v('2026-07', 'U-CS', 'families_in_groups') ?? 0) >= 1 && faixasCs07.every((x) => x === 0), 'CA06 F-GRUPO em families_in_groups com zero nas 4 faixas (U-CS/2026-07)', {
    families_in_groups: v('2026-07', 'U-CS', 'families_in_groups'),
    faixas: faixasCs07,
  });
  // CA06 — soma dos perfis > novas famílias em U-CN/2026-07 (esperado sempre; apurado só sem perfis CadÚnico explicados).
  const somaPerfis = (fonte: (c: string) => number | undefined) =>
    esperado.contadores.filter((l) => l.mes === '2026-07' && l.unidade === 'U-CN' && l.contador.startsWith('new_families_profile.')).reduce((s, l) => s + (fonte(l.contador) ?? 0), 0);
  const perfisEsp = somaPerfis((c) => esperado.contadores.find((l) => l.mes === '2026-07' && l.unidade === 'U-CN' && l.contador === c)?.valor);
  const perfisAp = somaPerfis((c) => v('2026-07', 'U-CN', c));
  const novasAp = v('2026-07', 'U-CN', 'new_families') ?? 0;
  nominal(perfisEsp > novasAp, 'CA06 esperado: soma dos perfis > novas famílias (U-CN/2026-07)', { soma_perfis_esperada: perfisEsp, novas_familias: novasAp });
  if (perfisAp > novasAp) ctx.registro.passo({ passo: 'CA06 apurado: soma dos perfis > novas famílias', soma_perfis: perfisAp, novas_familias: novasAp });
  else if (explicadas.some((d) => d.mes === '2026-07' && d.unidade === 'U-CN' && d.contador.startsWith('new_families_profile.'))) {
    ctx.achado(`E17/CA06: no apurado a soma dos perfis (${perfisAp}) não passa as novas famílias (${novasAp}) em U-CN/2026-07 — os perfis de renda, PBF e trabalho infantil dependem da importação CadÚnico (ver divergências explicadas)`);
  } else falhas.push(`CA06 apurado: soma dos perfis ${perfisAp} ≤ novas famílias ${novasAp}`);
  // CA08 — F-DUPLA em acompanhamento no CRAS Norte e no CREAS nos mesmos meses (banco).
  const dupla = ctx.chaves.obter('FAM_F-DUPLA');
  for (const mes of ['2026-07', '2026-08']) {
    const unidades = consultar(
      ctx.cfg,
      `SELECT DISTINCT x.social_unit_id FROM family_follow_ups x JOIN families f ON f.id = x.family_id WHERE f.uuid = '${dupla}' AND x.deleted_at IS NULL ` +
        `AND x.admitted_on <= (date '${mes}-01' + interval '1 month' - interval '1 day') AND (x.discharged_on IS NULL OR x.discharged_on >= date '${mes}-01')`,
    ).map(([id]) => idParaUnidade.get(id as string) ?? id);
    nominal(
      unidades.includes('U-CN') && unidades.includes('U-CE') && (v(mes, 'U-CN', 'families_in_follow_up') ?? 0) >= 1 && (v(mes, 'U-CE', 'families_in_follow_up') ?? 0) >= 1,
      `CA08 F-DUPLA contada no CRAS Norte (PAIF) e no CREAS (PAEFI) em ${mes}`,
      { unidades_do_acompanhamento: unidades, cn: v(mes, 'U-CN', 'families_in_follow_up'), ce: v(mes, 'U-CE', 'families_in_follow_up') },
    );
  }
  // CA10 — pessoas atendidas sem CPF: apuração × banco, por mês × unidade.
  const semCpfBanco = new Map<string, number>();
  for (const [mes, unidade, n] of consultar(
    ctx.cfg,
    `SELECT to_char(a.attended_on, 'YYYY-MM'), a.social_unit_id, count(DISTINCT ap.person_id) FROM attendance_people ap JOIN attendances a ON a.id = ap.attendance_id ` +
      `JOIN persons p ON p.id = ap.person_id WHERE a.tenant_id = ${tenant} AND a.deleted_at IS NULL AND ap.deleted_at IS NULL AND a.status <> 'cancelled' AND p.cpf IS NULL GROUP BY 1, 2`,
  )) {
    semCpfBanco.set(`${mes}|${idParaUnidade.get(unidade as string)}`, Number(n));
  }
  for (const mes of esperado.meses) {
    for (const u of UNIDADES) {
      const ap = (pendencias[mes] ?? []).filter((p) => p.kind === 'attended_person_without_cpf' && unidadePorUuid[p.social_unit_uuid ?? ''] === u).reduce((s, p) => s + p.count, 0);
      const banco = semCpfBanco.get(`${mes}|${u}`) ?? 0;
      if (ap !== banco) nominal(false, `CA10 sem CPF ${mes} ${u}: apuração × banco`, { apuracao: ap, banco });
    }
  }
  nominal([...semCpfBanco.values()].some((n) => n > 0), 'CA10 há pessoas atendidas sem CPF (without_cpf)', { por_mes_unidade: Object.fromEntries(semCpfBanco) });
  // 15.9 — capacitação.
  nominal(v('2026-06', 'U-CN', 'capacitation.QuantidadeReunioesInternas') === 1, '15.9 CAP-1 reunião interna conta 1 ação (U-CN/06)', { valor: v('2026-06', 'U-CN', 'capacitation.QuantidadeReunioesInternas') });
  nominal(v('2026-07', 'U-CS', 'capacitation.QuantidadePalestras') === 2, '15.9 CAP-2 palestra conta 2 participantes (U-CS/07)', { valor: v('2026-07', 'U-CS', 'capacitation.QuantidadePalestras') });
  nominal(v('2026-07', 'U-CE', 'capacitation.QuantidadeCursos') === 2 && v('2026-08', 'U-CE', 'capacitation.QuantidadeCursos') === 2, '15.9 CAP-3 curso conta 2 profissionais em 07 e em 08 (U-CE)', {
    jul: v('2026-07', 'U-CE', 'capacitation.QuantidadeCursos'),
    ago: v('2026-08', 'U-CE', 'capacitation.QuantidadeCursos'),
  });

  if (falhas.length) throw new Error(`E17: ${falhas.length} falha(s):\n${falhas.join('\n')}`);
});
