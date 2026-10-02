/**
 * E15 — Acolhimento (#10994 · roadmap 06/E15, BR-007, RN12, AC-012).
 * Um único acolhimento: a criança de F-ACOLH, família em acompanhamento PAEFI ativo no CREAS (E12).
 * `family_shelterings` não tem unidade: a atribuição vem do acompanhamento ativo, por isso E15 vem
 * depois de E12. Cuidado de apresentação: caso sensível, volume mínimo.
 */
import { expect } from '@playwright/test';
import { dados, etapa } from '../lib/papeis.ts';
import { registrarTodos, registrosDoElenco } from '../lib/registros.ts';
import { consultar } from '../lib/verificacoes-sql.ts';

etapa('E15', 'Acolhimento único (RN12)', 'P3', async (ctx) => {
  const acolhimentos = registrosDoElenco('sheltering');
  expect(acolhimentos, 'o elenco tem exatamente um acolhimento (RN12)').toHaveLength(1);
  await registrarTodos(ctx, 'sheltering');

  // Verificação: a família lista um acolhimento, e a organização inteira tem exatamente um.
  const p3 = await ctx.sessoes.entrar('P3');
  const lista = dados<unknown[]>((await p3.get(`/api/client/families/${ctx.chaves.obter('FAM_F-ACOLH')}/shelterings`)).corpo);
  const cnpj = ctx.elenco.organizacao.cnpj.replace(/\D/g, '');
  const total = consultar(
    ctx.cfg,
    `SELECT count(*) FROM family_shelterings s JOIN tenants t ON t.id = s.tenant_id WHERE t.cnpj = '${cnpj}' AND s.deleted_at IS NULL`,
  )[0]?.[0];
  ctx.registro.passo({ passo: 'RN12 verificação', acolhimentos_da_familia: Array.isArray(lista) ? lista.length : null, acolhimentos_da_organizacao: Number(total) });
  expect(Array.isArray(lista) ? lista.length : 0).toBe(1);
  expect(Number(total)).toBe(1);
});
