/**
 * E13 — Participação em serviços (#10994 · roadmap 06/E13, BR-006, AC-001).
 * SCFV por faixa etária (idade no último dia do mês), F-IDOSO (60+ no serviço 900, fora das faixas e
 * fora do SCFV de idosos → `elderly_outside_range`) e F-GRUPO em grupo PAIF (serviço 3:
 * `counts_as_group` sem `counts_as_scfv`). O efeito é conferido na E17.
 */
import { expect } from '@playwright/test';
import { etapa } from '../lib/papeis.ts';
import { registrarTodos, registrosDoElenco } from '../lib/registros.ts';

etapa('E13', 'Participações: SCFV por faixa, F-IDOSO e F-GRUPO', 'P1–P3', async (ctx) => {
  const ex = await registrarTodos(ctx, 'participation');
  const r = ex.resumo().participation ?? { criados: 0, pulados: 0 };
  expect(r.criados + r.pulados).toBe(registrosDoElenco('participation').length);
});
