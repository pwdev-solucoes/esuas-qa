/**
 * E2 — Entrada no Painel do Tenant (#10994 · roadmap 02, BR-004, BR-006). Papel: Master (client).
 *
 * 2.1 senha pelo link do e-mail (forgot-password → Mailpit → reset-password, A6);
 * 2.2 login por CPF; 2.3 organização demo entre os vínculos (`/auth/tenants`) → `X-Tenant-UUID`;
 * 2.4 aceite dos documentos legais vigentes (sem ele todo `/api/client/*` responde 403).
 */
import { expect } from '@playwright/test';
import { CHAVE_TENANT, dados, etapa, primeiroAcesso } from '../lib/papeis.ts';

etapa('E02', 'Entrada no tenant: senha, login, aceite legal', 'M0', async (ctx) => {
  ctx.chaveAtual = 'M0';
  const master = await primeiroAcesso(ctx, 'M0', new Date(ctx.chaves.obter('M0_CRIADO_EM')));
  const tenants = dados<Array<{ uuid: string }>>((await master.get('/api/client/auth/tenants')).corpo);
  expect(tenants.map((t) => t.uuid), 'organização demo fora dos vínculos do Master').toContain(ctx.chaves.obter(CHAVE_TENANT));
  const pendentes = dados<unknown[]>((await master.get('/api/legal-acceptance/pending')).corpo);
  expect(pendentes, 'aceite legal do Master incompleto').toHaveLength(0);
  const me = dados<{ roles?: unknown }>((await master.get('/api/client/auth/me')).corpo);
  ctx.registro.passo({ chave: 'M0', passo: '2.4 /auth/me após aceite', papeis: JSON.stringify(me.roles ?? null).slice(0, 200) });
  ctx.chaveAtual = null;
});
