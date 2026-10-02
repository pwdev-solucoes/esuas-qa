/**
 * UNIT do comparador esperado × apurado (#10994 · plano 05, AC-013).
 */
import { expect, test } from '@playwright/test';
import { classificar, compararContadores, compararPendencias, extrairApurado, formatarDivergencias, type LinhaEsperada, type UnidadeApuracao } from './esperado.ts';

const MAPA = { 'uuid-cn': 'U-CN', 'uuid-ce': 'U-CE' };

function unidade(uuid: string, total: number, extra: Partial<UnidadeApuracao> = {}): UnidadeApuracao {
  return {
    uuid,
    counters: { total_attendances: { value: total, available: true } },
    without_identified_person: 0,
    new_families_profile: { profile_bpc: { value: 1, available: true } },
    scfv_notes: { elderly_outside_range: true },
    analytic_layouts: { usuario_rede: { eligible: 3, incomplete: 1, missing_fields: { Escolaridade: 1 } }, familia: { eligible: 2, incomplete: 0, missing_fields: [] } },
    ...extra,
  };
}

const esperadoBase = (total: number): LinhaEsperada[] => [
  { mes: '2026-06', unidade: 'U-CN', contador: 'total_attendances', valor: total },
  { mes: '2026-06', unidade: 'U-CN', contador: 'without_identified_person', valor: 0 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'new_families_profile.profile_bpc', valor: 1 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'scfv_notes.elderly_outside_range', valor: 1 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'analytic_layouts.usuario_rede.eligible', valor: 3 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'analytic_layouts.usuario_rede.incomplete', valor: 1 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'analytic_layouts.usuario_rede.missing_fields.Escolaridade', valor: 1 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'analytic_layouts.usuario_rede.missing_fields.NomeMae', valor: 0 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'analytic_layouts.familia.eligible', valor: 2 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'analytic_layouts.familia.incomplete', valor: 0 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'capacitation.QuantidadeCursos', valor: 2 },
  { mes: '2026-06', unidade: 'U-CN', contador: 'capacitation.has_no_records', valor: 0 },
];

const tallies = [{ social_unit: { uuid: 'uuid-cn' }, has_no_records: false, counters: [{ siap_field: 'QuantidadeCursos', value: 2 }] }];

test.describe('UNIT-001 comparador esperado × apurado', () => {
  test('igual: nenhuma divergência (missing_fields ausente vale 0)', () => {
    const ap = extrairApurado('2026-06', [unidade('uuid-cn', 21)], tallies, MAPA);
    expect(compararContadores(esperadoBase(21), ap)).toEqual([]);
  });

  test('divergente: item estruturado {mes, unidade, contador, esperado, apurado}', () => {
    const ap = extrairApurado('2026-06', [unidade('uuid-cn', 20)], tallies, MAPA);
    expect(compararContadores(esperadoBase(21), ap)).toEqual([
      { mes: '2026-06', unidade: 'U-CN', contador: 'total_attendances', esperado: 21, apurado: 20, motivo: 'diferente' },
    ]);
  });

  test('contador ausente na API vira divergência "ausente"', () => {
    const ap = extrairApurado('2026-06', [unidade('uuid-cn', 21, { counters: {} })], tallies, MAPA);
    const ds = compararContadores(esperadoBase(21), ap);
    expect(ds).toEqual([{ mes: '2026-06', unidade: 'U-CN', contador: 'total_attendances', esperado: 21, apurado: null, motivo: 'ausente' }]);
  });

  test('chave extra da API (contador que o esperado não cobre) vira divergência "extra"', () => {
    const u = unidade('uuid-cn', 21);
    u.counters.novo_contador = { value: 4, available: true };
    const ds = compararContadores(esperadoBase(21), extrairApurado('2026-06', [u], tallies, MAPA));
    expect(ds).toEqual([{ mes: '2026-06', unidade: 'U-CN', contador: 'novo_contador', esperado: null, apurado: 4, motivo: 'extra' }]);
  });

  test('pendências: situação atual vale em todo mês; zero = ausente; unidade por uuid', () => {
    const esperadas = [
      { kind: 'family_pending_specificity', scope: 'unit' as const, unidade: 'U-CN', mes: null, valor: 2 },
      { kind: 'attended_person_without_cpf', scope: 'unit' as const, unidade: 'U-CN', mes: '2026-06', valor: 1 },
      { kind: 'entity_without_cneas', scope: 'tenant' as const, unidade: null, mes: null, valor: 1 },
    ];
    const apuradas = [
      { kind: 'family_pending_specificity', count: 2, scope: 'unit' as const, social_unit_uuid: 'uuid-cn' },
      { kind: 'attended_person_without_cpf', count: 1, scope: 'unit' as const, social_unit_uuid: 'uuid-cn' },
    ];
    expect(compararPendencias('2026-06', esperadas, apuradas, MAPA)).toEqual([
      { mes: '2026-06', unidade: null, contador: 'pendencia.entity_without_cneas', esperado: 1, apurado: null, motivo: 'ausente' },
    ]);
    // Em julho o kind mensal não é esperado: a apuração que o traz gera "extra".
    expect(compararPendencias('2026-07', esperadas, apuradas, MAPA).map((d) => [d.contador, d.motivo])).toEqual([
      ['pendencia.entity_without_cneas', 'ausente'],
      ['pendencia.attended_person_without_cpf', 'extra'],
    ]);
  });

  test('classificar: só a divergência com achado RN14 comprovado é explicada; as demais falham', () => {
    const ds = compararContadores(esperadoBase(21), extrairApurado('2026-06', [unidade('uuid-cn', 20, { scfv_notes: { elderly_outside_range: false } })], tallies, MAPA));
    const { explicadas, bloqueantes } = classificar(ds, [(d) => (d.contador.startsWith('scfv_notes.') ? 'achado X' : null)]);
    expect(explicadas.map((d) => d.contador)).toEqual(['scfv_notes.elderly_outside_range']);
    expect(bloqueantes.map((d) => d.contador)).toEqual(['total_attendances']);
    expect(formatarDivergencias(bloqueantes)).toContain('esperado 21 × apurado 20');
  });
});
