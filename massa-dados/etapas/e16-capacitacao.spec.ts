/**
 * E16 — Capacitação e divulgação, 15.9 (#10994 · roadmap 06/E16, BR-008, AC-001).
 * CAP-1 reunião interna no CRAS Norte (06, conta a ação), CAP-2 palestra no CRAS Sul (07, conta os
 * participantes P2 e P6) e CAP-3 curso no CREAS atravessando 07→08 (conta P3 e P4 em cada mês).
 * Registrado pelo Operacional lotado na unidade (participantes precisam de lotação ativa nela).
 */
import { expect } from '@playwright/test';
import { etapa } from '../lib/papeis.ts';
import { registrarTodos, registrosDoElenco } from '../lib/registros.ts';

etapa('E16', 'Capacitação CAP-1..3', 'P1–P3', async (ctx) => {
  expect(registrosDoElenco('capacitation').map((r) => r.chave)).toEqual(['CAP-1', 'CAP-2', 'CAP-3']);
  const ex = await registrarTodos(ctx, 'capacitation');
  const r = ex.resumo().capacitation ?? { criados: 0, pulados: 0 };
  expect(r.criados + r.pulados).toBe(3);
});
