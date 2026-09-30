/**
 * E14 — Benefícios eventuais (#10994 · roadmap 06/E14, BR-007, AC-001).
 * Concessões nos 3 meses, de tipos variados; F-BENEF-2X com duas concessões no mesmo mês (conta
 * concessões, não famílias). Campos condicionais do tipo (Natalidade/Funeral) recebem valores
 * fictícios determinísticos no executor (o elenco os deixa nulos).
 */
import { expect } from '@playwright/test';
import { etapa } from '../lib/papeis.ts';
import { registrarTodos, registrosDoElenco } from '../lib/registros.ts';

etapa('E14', 'Benefícios eventuais (F-BENEF-2X)', 'P1–P3', async (ctx) => {
  const todos = registrosDoElenco('eventual_benefit');
  const porMes = new Map<string, number>();
  for (const r of todos.filter((x) => x.familia_chave === 'F-BENEF-2X')) porMes.set(r.data_fato.slice(0, 7), (porMes.get(r.data_fato.slice(0, 7)) ?? 0) + 1);
  expect(Math.max(0, ...porMes.values()), 'F-BENEF-2X com duas concessões num mesmo mês').toBeGreaterThanOrEqual(2);
  const ex = await registrarTodos(ctx, 'eventual_benefit');
  const r = ex.resumo().eventual_benefit ?? { criados: 0, pulados: 0 };
  expect(r.criados + r.pulados).toBe(todos.length);
});
