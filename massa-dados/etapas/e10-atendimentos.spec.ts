/**
 * E10 — Atendimentos (#10994 · roadmap 06/E10, BR-001, BR-002, BR-009, AC-001, AC-007).
 * Cada atendimento do elenco é registrado pelo profissional lotado na unidade na data do fato
 * (P1–P4), com os integrantes atendidos — inclusive pessoas SEM CPF (F-SEM-CPF, CA10).
 * Zero declarado (RN09): o CREAS (U-CE) não tem nenhum registro em 2026-06; a etapa só confere que o
 * elenco não traz nada ali (o valor 0 com `available:true` é conferido na E17).
 * Atividade coletiva em lote (`attendances/batch`): o elenco não tem atendimento sem pessoa
 * identificada (esperado `without_identified_person` = 0), e o lote proíbe `people`; por isso a
 * etapa não usa o lote — ver plan.done.md (desvio documentado).
 */
import { expect } from '@playwright/test';
import { etapa } from '../lib/papeis.ts';
import { registrarTodos, registrosDoElenco } from '../lib/registros.ts';

etapa('E10', 'Atendimentos (com pessoas sem CPF) e zero declarado', 'P1–P4', async (ctx) => {
  const atendimentos = registrosDoElenco('attendance');
  expect(atendimentos.filter((r) => r.unidade === 'U-CE' && r.data_fato.startsWith('2026-06')), 'U-CE/2026-06 sem atendimento (zero declarado, RN09)').toHaveLength(0);
  const ex = await registrarTodos(ctx, 'attendance');
  const r = ex.resumo().attendance ?? { criados: 0, pulados: 0 };
  expect(r.criados + r.pulados).toBe(atendimentos.length);
  ctx.log(`  E10: ${r.criados} atendimentos criados, ${r.pulados} já existentes`);
});
