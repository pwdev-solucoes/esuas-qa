/**
 * Calcula `insumos/esperado.json` SOBRE O ELENCO (#10994 · BR-008, RN13, AC-009).
 *
 * Nunca consulta o sistema (seria circular): reproduz, em TypeScript, as regras DOCUMENTADAS
 * dos services de apuração do `api/` (conferidas em 2026-09-29):
 *
 *  - `Attendance/AttendanceReportService` — total e contadores por `attendance_types.remittance_counter`
 *    (COUNT(*) de atendimentos); `without_identified_person`; contadores CadÚnico/BPC vindos de
 *    `referrals` (famílias distintas; BPC = pessoas distintas; desfecho ignorado).
 *  - `FollowUp/FollowUpReportService` — Q5 famílias distintas vigentes em qualquer dia do mês;
 *    Q6 novas famílias (admitted_on no mês; reingresso conta 1); Q7 os 8 perfis NÃO exclusivos,
 *    só sobre as novas famílias.
 *  - `Participation/ScfvReportService` — families_in_groups (counts_as_group, famílias distintas);
 *    faixas pela idade no ÚLTIMO dia do mês (counts_as_scfv, pessoas distintas); elderly só pelo
 *    serviço (counts_as_scfv_elderly); nota elderly_outside_range.
 *  - `EventualBenefit/EventualBenefitReportService` — conta CONCESSÕES (linhas).
 *  - `Capacitation/CapacitationTallyService` — data única: participação = participantes, evento =
 *    ações distintas; período: profissionais distintos com curso vigente no mês.
 *  - `Diagnosis/DiagnosisCompletenessService` — 15.10 (usuario_rede) e 15.11 (familia).
 *  - Pendências da 10994b (RN01–RN10) — `registration_pendencies`.
 *
 * Divergência no E17 (plano 05) é ACHADO: ou o elenco está errado, ou a regra mudou.
 */
import type { Elenco, Familia, Mes, Pessoa, Registro } from './elenco.ts';
import { idadeEm, MESES } from './elenco.ts';
import type { ArquivoEntidades } from './entidades.ts';
import { caminhoInsumo, escreverJson } from './lib/json.ts';
import type { ChaveUnidade } from './unidades.ts';

const UNIDADES_ORDEM: ChaveUnidade[] = ['U-CN', 'U-CS', 'U-CE'];

/** `attendance_types.code` → chave do contador (AttendanceTypeSeeder + COUNTER_KEYS). */
const CONTADOR_ATENDIMENTO: Record<string, string> = {
  '1': 'individualized_attendances',
  '7': 'home_visits',
  '3': 'non_continued_collective_participation',
};
/** `referral_codes.code` → contador (ReferralCodeSeeder + REFERRAL_COUNTER_KEYS). */
const CONTADOR_ENCAMINHAMENTO: Record<string, string> = {
  '07': 'cadunico_update',
  '08': 'cadunico_inclusion',
  '09': 'bpc_referrals',
};
/** `eventual_benefit_types.code` → contador (EventualBenefitTypeSeeder). */
const CONTADOR_BENEFICIO: Record<string, string> = {
  '1': 'birth_assistance',
  '2': 'funeral_assistance',
  '3': 'other_benefits',
  '4': 'food_assistance',
  '5': 'other_benefits',
  '6': 'other_benefits',
};
/** Atributos de contagem de `participation_services` (ParticipationDomainsSeeder). */
const SERVICOS_PARTICIPACAO: Record<string, { grupo: boolean; scfv: boolean; idoso: boolean }> = {
  '1': { grupo: true, scfv: true, idoso: false },
  '2': { grupo: true, scfv: true, idoso: true },
  '3': { grupo: true, scfv: false, idoso: false },
  '4': { grupo: true, scfv: false, idoso: false },
  '5': { grupo: false, scfv: false, idoso: false },
  '6': { grupo: false, scfv: false, idoso: false },
  '99': { grupo: false, scfv: false, idoso: false },
  '900': { grupo: true, scfv: true, idoso: false },
};
/** `capacitation_action_types` (CapacitationActionTypeSeeder): código → campo, modo de contagem e de data. */
const TIPOS_CAPACITACAO: Record<string, { campo: string; contagem: 'participation' | 'event' | 'professional'; data: 'single' | 'period' }> = {
  '001': { campo: 'QuantidadePalestras', contagem: 'participation', data: 'single' },
  '002': { campo: 'QuantidadeReunioes', contagem: 'participation', data: 'single' },
  '003': { campo: 'QuantidadeReunioesInternas', contagem: 'event', data: 'single' },
  '004': { campo: 'QuantidadeEventos', contagem: 'participation', data: 'single' },
  '005': { campo: 'QuantidadeCursos', contagem: 'professional', data: 'period' },
};
const FAIXAS: Array<[string, number, number]> = [
  ['children_0_6', 0, 6],
  ['preadolescents_7_14', 7, 14],
  ['adolescents_15_17', 15, 17],
  ['adults_18_59', 18, 59],
];
/** `config('geo_panel.extreme_poverty_per_capita')` — padrão 218.00. */
const LIMIAR_EXTREMA_POBREZA = 218;
const PERFIS = [
  'profile_extreme_poverty',
  'profile_bolsa_familia',
  'profile_child_labor',
  'profile_bpc',
  'profile_bf_noncompliance',
  'profile_school_dropout',
  'profile_teen_pregnancy',
  'profile_sheltering',
] as const;
const CAMPOS_USUARIO_REDE = ['ValorRenda', 'Alfabetizado', 'Escolaridade', 'DoencaGrave', 'NomeMae'] as const;
const CAMPOS_FAMILIA = ['TipoResidencia', 'DomicilioAreaRisco', 'DomicilioVulnerabilidade'] as const;

export interface LinhaEsperada {
  mes: Mes;
  unidade: ChaveUnidade;
  /** Caminho do valor na resposta (`counters.<chave>` implícito para os contadores do 15.6–15.8). */
  contador: string;
  valor: number;
}

export interface PendenciaEsperada {
  kind: string;
  scope: 'tenant' | 'unit';
  unidade: ChaveUnidade | null;
  /** Mês de referência para os kinds mensais; `null` = situação atual (independe do mês). */
  mes: Mes | null;
  valor: number;
}

export interface Esperado {
  versao_elenco: string;
  meses: Mes[];
  unidades: ChaveUnidade[];
  convencoes: string[];
  contadores: LinhaEsperada[];
  pendencias: PendenciaEsperada[];
}

function limitesDoMes(mes: Mes): [string, string] {
  const [a, m] = mes.split('-').map(Number) as [number, number];
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return [`${mes}-01`, `${mes}-${String(ultimo).padStart(2, '0')}`];
}

const noMes = (data: string, mes: Mes): boolean => data.slice(0, 7) === mes;
const vigente = (inicio: string, fim: string | null, primeiro: string, ultimo: string): boolean =>
  inicio <= ultimo && (fim === null || fim >= primeiro);

export function calcularEsperado(elenco: Elenco, entidades: ArquivoEntidades): Esperado {
  const pessoa = new Map<string, Pessoa>(elenco.pessoas.map((p) => [p.chave, p]));
  const familia = new Map<string, Familia>(elenco.familias.map((f) => [f.chave, f]));
  const membros = (fam: string): Pessoa[] => elenco.pessoas.filter((p) => p.familia_chave === fam);
  const deTipo = (tipo: Registro['tipo']): Registro[] => elenco.registros.filter((r) => r.tipo === tipo);
  const p = <T>(r: Registro, k: string): T => r.payload[k] as T;

  const contadores: LinhaEsperada[] = [];
  const pendencias: PendenciaEsperada[] = [];

  for (const mes of MESES) {
    const [primeiro, ultimo] = limitesDoMes(mes);
    for (const unidade of UNIDADES_ORDEM) {
      const linha = (contador: string, valor: number): void => {
        contadores.push({ mes, unidade, contador, valor });
      };

      // ── 15.6 atendimentos ───────────────────────────────────────────────────────
      const atds = deTipo('attendance').filter((r) => r.unidade === unidade && noMes(r.data_fato, mes));
      linha('total_attendances', atds.length);
      for (const chave of ['individualized_attendances', 'home_visits', 'non_continued_collective_participation']) {
        linha(chave, atds.filter((r) => CONTADOR_ATENDIMENTO[p<string>(r, 'tipo_codigo')] === chave).length);
      }

      // ── 15.6 encaminhamentos (distintos; desfecho ignorado) ─────────────────────
      const encs = deTipo('referral').filter((r) => r.unidade === unidade && noMes(r.data_fato, mes));
      for (const chave of ['cadunico_inclusion', 'cadunico_update', 'bpc_referrals']) {
        const ids = new Set<string>();
        for (const r of encs) {
          if (CONTADOR_ENCAMINHAMENTO[p<string>(r, 'codigo')] !== chave) continue;
          if (chave === 'bpc_referrals') {
            const integrante = p<string | null>(r, 'integrante');
            if (integrante !== null) ids.add(integrante);
          } else {
            ids.add(r.familia_chave as string);
          }
        }
        linha(chave, ids.size);
      }

      // ── 15.6/15.7 acompanhamento ────────────────────────────────────────────────
      const acps = deTipo('follow_up').filter((r) => r.unidade === unidade);
      const emAcomp = new Set<string>();
      const novas = new Set<string>();
      for (const r of acps) {
        const desl = p<{ data: string } | null>(r, 'desligamento');
        if (vigente(r.data_fato, desl?.data ?? null, primeiro, ultimo)) emAcomp.add(r.familia_chave as string);
        if (noMes(r.data_fato, mes)) novas.add(r.familia_chave as string);
      }
      linha('families_in_follow_up', emAcomp.size);
      linha('new_families', novas.size);

      // ── 15.8 participação ───────────────────────────────────────────────────────
      const prts = deTipo('participation').filter(
        (r) => r.unidade === unidade && vigente(r.data_fato, p<string | null>(r, 'encerrada_em'), primeiro, ultimo),
      );
      const svc = (r: Registro) => SERVICOS_PARTICIPACAO[p<string>(r, 'servico_codigo')] as { grupo: boolean; scfv: boolean; idoso: boolean };
      const famGrupos = new Set(prts.filter((r) => svc(r).grupo).map((r) => r.familia_chave as string));
      const idosos = new Set(prts.filter((r) => svc(r).idoso).map((r) => p<string>(r, 'integrante')));
      const faixas = new Map<string, Set<string>>(FAIXAS.map(([k]) => [k, new Set<string>()]));
      let foraDeFaixa = false;
      for (const r of prts.filter((x) => svc(x).scfv)) {
        const integrante = p<string>(r, 'integrante');
        const idade = idadeEm((pessoa.get(integrante) as Pessoa).nascimento, ultimo);
        const faixa = FAIXAS.find(([, min, max]) => idade !== null && idade >= min && idade <= max);
        if (faixa) faixas.get(faixa[0])?.add(integrante);
        else if (idade !== null && !idosos.has(integrante)) foraDeFaixa = true;
      }
      const comDeficiencia = new Set(
        prts.filter((r) => svc(r).grupo && (pessoa.get(p<string>(r, 'integrante')) as Pessoa).condicoes.deficiencia).map((r) => p<string>(r, 'integrante')),
      );
      linha('families_in_groups', famGrupos.size);
      for (const [k] of FAIXAS) linha(k, faixas.get(k)?.size ?? 0);
      linha('elderly', idosos.size);
      linha('people_with_disability', comDeficiencia.size);

      // ── 15.6 benefícios eventuais (concessões) ──────────────────────────────────
      const bens = deTipo('eventual_benefit').filter((r) => r.unidade === unidade && noMes(r.data_fato, mes));
      for (const chave of ['food_assistance', 'birth_assistance', 'funeral_assistance', 'other_benefits']) {
        linha(chave, bens.filter((r) => CONTADOR_BENEFICIO[p<string>(r, 'tipo_codigo')] === chave).length);
      }

      // ── chaves de 1º nível da unidade ───────────────────────────────────────────
      linha('without_identified_person', atds.filter((r) => p<string[]>(r, 'pessoas').length === 0).length);

      // 15.7 — os 8 perfis, só sobre as novas famílias da unidade (não exclusivos).
      const perfis: Record<(typeof PERFIS)[number], number> = Object.fromEntries(PERFIS.map((k) => [k, 0])) as Record<(typeof PERFIS)[number], number>;
      for (const chaveFam of novas) {
        const f = familia.get(chaveFam) as Familia;
        const ms = membros(chaveFam);
        if (f.renda_per_capita <= LIMIAR_EXTREMA_POBREZA) perfis.profile_extreme_poverty++;
        if (f.recebe_pbf) perfis.profile_bolsa_familia++;
        if (ms.some((m) => m.condicoes.trabalho_infantil)) perfis.profile_child_labor++;
        if (f.programas_sociais.some((s) => s.codigo.toLowerCase() === 'bpc')) perfis.profile_bpc++;
        // bf_noncompliance e teen_pregnancy: o elenco não registra descumprimento nem gestação → 0.
        const evasao = ms.some((m) => {
          const idade = idadeEm(m.nascimento, ultimo);
          return ['3', '4'].includes(m.condicoes.situacao_escolar ?? '') && idade !== null && idade >= 4 && idade <= 17;
        });
        if (evasao) perfis.profile_school_dropout++;
        const acolhida = deTipo('sheltering').some((r) => {
          if (r.familia_chave !== chaveFam) return false;
          if (!vigente(r.data_fato, p<string | null>(r, 'encerrado_em'), primeiro, ultimo)) return false;
          const idade = idadeEm((pessoa.get(p<string>(r, 'integrante')) as Pessoa).nascimento, ultimo);
          return idade !== null && idade < 18;
        });
        if (acolhida) perfis.profile_sheltering++;
      }
      for (const k of PERFIS) linha(`new_families_profile.${k}`, perfis[k]);
      linha('scfv_notes.elderly_outside_range', foraDeFaixa ? 1 : 0);

      // 15.10 — pessoas atendidas (attendance_people) com campo em falta.
      const atendidas = new Set(atds.flatMap((r) => p<string[]>(r, 'pessoas')));
      const faltaUR: Record<(typeof CAMPOS_USUARIO_REDE)[number], (x: Pessoa) => boolean> = {
        ValorRenda: () => false,
        Alfabetizado: () => false,
        Escolaridade: (x) => x.escolaridade === null,
        DoencaGrave: () => false,
        NomeMae: (x) => x.nome_mae.trim() === '',
      };
      let incompletasUR = 0;
      for (const chave of atendidas) {
        const x = pessoa.get(chave) as Pessoa;
        if (CAMPOS_USUARIO_REDE.some((c) => faltaUR[c](x))) incompletasUR++;
      }
      linha('analytic_layouts.usuario_rede.eligible', atendidas.size);
      linha('analytic_layouts.usuario_rede.incomplete', incompletasUR);
      for (const c of CAMPOS_USUARIO_REDE) {
        linha(`analytic_layouts.usuario_rede.missing_fields.${c}`, [...atendidas].filter((k) => faltaUR[c](pessoa.get(k) as Pessoa)).length);
      }

      // 15.11 — famílias atendidas sem condições habitacionais.
      const famAtendidas = new Set(atds.map((r) => r.familia_chave as string));
      const semHab = [...famAtendidas].filter((k) => (familia.get(k) as Familia).habitacao === null).length;
      linha('analytic_layouts.familia.eligible', famAtendidas.size);
      linha('analytic_layouts.familia.incomplete', semHab);
      for (const c of CAMPOS_FAMILIA) linha(`analytic_layouts.familia.missing_fields.${c}`, semHab);

      // 15.9 — capacitação (endpoint capacitation-tallies).
      const caps = deTipo('capacitation').filter((r) => r.unidade === unidade);
      const valores: Record<string, number> = {};
      let comRegistro = false;
      for (const r of caps) {
        const tipo = TIPOS_CAPACITACAO[p<string>(r, 'tipo_codigo')];
        if (!tipo) continue;
        const participantes = p<string[]>(r, 'participantes');
        if (tipo.data === 'single') {
          if (!noMes(r.data_fato, mes)) continue;
          comRegistro = true;
          const v = tipo.contagem === 'participation' ? participantes.length : tipo.contagem === 'event' ? 1 : 0;
          valores[tipo.campo] = (valores[tipo.campo] ?? 0) + v;
        } else {
          if (!vigente(r.data_fato, p<string | null>(r, 'encerrada_em'), primeiro, ultimo)) continue;
          comRegistro = true;
          valores[tipo.campo] = (valores[tipo.campo] ?? 0) + new Set(participantes).size;
        }
      }
      for (const tipo of Object.values(TIPOS_CAPACITACAO)) linha(`capacitation.${tipo.campo}`, valores[tipo.campo] ?? 0);
      linha('capacitation.has_no_records', comRegistro ? 0 : 1);

      // ── pendências mensais por unidade (10994b RN05/RN08/RN09) ───────────────────
      const semCpf = [...atendidas].filter((k) => (pessoa.get(k) as Pessoa).cpf === null).length;
      if (semCpf > 0) pendencias.push({ kind: 'attended_person_without_cpf', scope: 'unit', unidade, mes, valor: semCpf });
      const semEscolaridade = [...atendidas].filter((k) => (pessoa.get(k) as Pessoa).escolaridade === null).length;
      if (semEscolaridade > 0) pendencias.push({ kind: 'member_without_schooling', scope: 'unit', unidade, mes, valor: semEscolaridade });
    }
  }

  // ── pendências de situação atual (independem do mês) ─────────────────────────────
  const semUnidade = elenco.familias.filter((f) => f.unidade_referencia === null).length;
  if (semUnidade > 0) pendencias.push({ kind: 'family_without_reference_unit', scope: 'tenant', unidade: null, mes: null, valor: semUnidade });
  const semCneas = entidades.entidades.filter((e) => e.cneas === null || !/^\d{1,13}$/.test(e.cneas)).length;
  if (semCneas > 0) pendencias.push({ kind: 'entity_without_cneas', scope: 'tenant', unidade: null, mes: null, valor: semCneas });
  for (const unidade of UNIDADES_ORDEM) {
    const pendentes = elenco.familias.filter((f) => f.unidade_referencia === unidade && !f.especificidade_confirmada).length;
    if (pendentes > 0) pendencias.push({ kind: 'family_pending_specificity', scope: 'unit', unidade, mes: null, valor: pendentes });
  }

  return {
    versao_elenco: elenco.versao,
    meses: [...MESES],
    unidades: [...UNIDADES_ORDEM],
    convencoes: [
      'contador sem ponto = data.units[].counters.<contador>.value de GET /api/client/attendance-reports',
      'contador com ponto = caminho de 1º nível da unidade (new_families_profile.*, scfv_notes.*, analytic_layouts.*); booleanos valem 1/0',
      'analytic_layouts.*.missing_fields.<Campo>: a API omite campos com zero; ausente = 0',
      'capacitation.<CampoSIAP> e capacitation.has_no_records vêm de GET /api/client/capacitation-tallies (has_no_records 1/0)',
      'pendencias[].mes = null: situação atual (fila), independe do mês de referência (10994b RN05)',
      'pendências com contagem zero não são listadas (10994b RN07)',
    ],
    contadores,
    pendencias,
  };
}

export function gerarEsperado(elenco: Elenco, entidades: ArquivoEntidades): Esperado {
  const esperado = calcularEsperado(elenco, entidades);
  escreverJson(caminhoInsumo('esperado.json'), esperado);
  return esperado;
}
