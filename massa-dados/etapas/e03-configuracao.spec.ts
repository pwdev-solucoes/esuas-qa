/**
 * E3 — Configuração da organização pelo Master (#10994 · roadmap 02/E3, BR-011).
 * Confere, pelo lado do tenant, o que o Painel Global preparou (cadastro, endereço oficial, CARDUG,
 * responsável, documentos legais) e completa o contato da organização em `tenant-settings`.
 */
import { expect } from '@playwright/test';
import { dados, etapa } from '../lib/papeis.ts';

etapa('E03', 'Configuração da organização pelo Master', 'M0', async (ctx) => {
  const master = await ctx.sessoes.entrar('M0');
  ctx.chaveAtual = 'ORG';
  // 3.1 cadastro
  await master.get('/api/client/tenant-settings');
  await master.put('/api/client/tenant-settings', { email: 'contato@demo.sigsuas.local', phone: '82980000000', timezone: 'America/Maceio' });
  // 3.2 endereço oficial
  const endereco = dados<Record<string, unknown> | null>((await master.get('/api/client/official-address')).corpo);
  expect(endereco, 'endereço oficial não chegou ao tenant').toBeTruthy();
  // 3.3 CARDUG
  const tce = dados<{ cardug_identifier?: string | null }>((await master.get('/api/client/tenant-tce-parameters')).corpo);
  expect(tce?.cardug_identifier, 'CARDUG ausente (E18 bloquearia a remessa)').toMatch(/^\d{6}$/);
  // 3.4 responsável
  const resp = dados<unknown[]>((await master.get('/api/client/tenant-responsibles')).corpo);
  expect(resp.length, 'responsável da organização ausente').toBeGreaterThan(0);
  // 3.5 documentos legais da organização
  const docs = dados<unknown[]>((await master.get('/api/client/legal-documents')).corpo);
  ctx.registro.passo({ passo: '3.1–3.5 conferidos', cardug: tce.cardug_identifier, responsaveis: resp.length, documentos_legais: docs.length });
  ctx.chaveAtual = null;
});
