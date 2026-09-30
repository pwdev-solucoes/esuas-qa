/**
 * E12 — Acompanhamento familiar PAIF/PAEFI (#10994 · roadmap 06/E12, BR-004, BR-005, AC-001).
 * PAIF só em CRAS e PAEFI só em CREAS (a API barra o contrário). F-DUPLA em PAIF no CRAS Norte (P1) e
 * em PAEFI no CREAS (P4, duas lotações), meses sobrepostos (CA08). F-PERFIS-1..4 são novas famílias do
 * CRAS Norte em 2026-07 (CA06); F-READM é desligada (07-12) e readmitida (07-25) no mesmo mês.
 * Desligamentos (12.4) vão com a avaliação exigida no ato (`discharge`).
 */
import { expect } from '@playwright/test';
import { etapa } from '../lib/papeis.ts';
import { registrarTodos, registrosDoElenco } from '../lib/registros.ts';

etapa('E12', 'Acompanhamento PAIF/PAEFI, F-DUPLA, F-PERFIS, F-READM e desligamentos', 'P1–P4', async (ctx) => {
  const ex = await registrarTodos(ctx, 'follow_up', async (r, uuid, e) => {
    await e.desligar(r, uuid);
  });
  const r = ex.resumo().follow_up ?? { criados: 0, pulados: 0 };
  expect(r.criados + r.pulados).toBe(registrosDoElenco('follow_up').length);
});
