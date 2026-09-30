/**
 * E1 — Setup global (#10994 · roadmap 01, BR-001, BR-011). Papel: Administrador (manager).
 *
 * Dividida em duas etapas em volta da E01b (BR-002):
 *   E01  (1.1–1.5): login + aceite legal do Administrador, conferência dos cadastros SUAS semeados, do
 *                   mapa CBO → perfil e dos documentos legais; criação da organização.
 *   E01c (1.6–1.9): endereço oficial em Arapiraca com logradouro do DNE, CARDUG, usuário Master com
 *                   papel `master` e responsável da organização (o responsável precisa ser um usuário
 *                   já vinculado à organização, por isso 1.9 vem antes de 1.8).
 */
import { expect } from '@playwright/test';
import { aceitarPendentes, CHAVE_TENANT, dados, etapa, listarTudo, resolverEnderecoDne } from '../lib/papeis.ts';

/** Cadastros SUAS semeados que a massa usa (1.2) — só GET; total > 0. */
const LOOKUPS: Array<[string, string]> = [
  ['tipos de atendimento', '/api/attendance-types'],
  ['códigos de encaminhamento', '/api/referral-codes'],
  ['tipos de benefício eventual', '/api/eventual-benefit-types'],
  ['serviços de acompanhamento', '/api/follow-up-services'],
  ['serviços de participação', '/api/participation-services'],
  ['especificidades sociais', '/api/social-specificities'],
  ['formas de ingresso', '/api/family-intake-forms'],
  ['CBO', '/api/cbos'],
  ['tipos de residência (diagnóstico)', '/api/residence-types'],
  ['níveis de escolaridade (diagnóstico)', '/api/schooling-levels'],
  ['situação escolar (diagnóstico)', '/api/school-situations'],
  ['tipos de deficiência (diagnóstico)', '/api/disability-types'],
  ['tipos de unidade', '/api/social-unit-types'],
  ['tipos de capacitação', '/api/capacitation-action-types'],
];

etapa('E01', 'Setup global: conferências e organização', 'admin', async (ctx) => {
  // 1.1 — login e aceite legal do Administrador (o gate também vale no Painel Global)
  const admin = await ctx.sessoes.entrar('admin');
  const aceitos = await aceitarPendentes(admin);
  ctx.registro.passo({ passo: '1.1 aceite legal do Administrador', documentos: aceitos.map((d) => d.title) });

  // 1.2 — conferência dos lookups semeados
  for (const [rotulo, uri] of LOOKUPS) {
    const { corpo } = await admin.get<{ data: unknown[]; meta?: { total?: number } }>(`${uri}?per_page=1`);
    const total = corpo.meta?.total ?? corpo.data?.length ?? 0;
    expect(total, `cadastro SUAS "${rotulo}" vazio — o DatabaseSeeder não rodou?`).toBeGreaterThan(0);
    ctx.registro.passo({ passo: '1.2 conferência', cadastro: rotulo, total });
  }

  // 1.3 — mapa CBO → perfil (sugestão de perfil em E06)
  const mapa = await listarTudo<{ cbo: { code: string } }>(admin, '/api/cbo-access-profiles');
  expect(mapa.length, 'mapa CBO → perfil vazio').toBeGreaterThan(0);
  for (const p of ctx.elenco.profissionais) {
    if (!mapa.some((m) => m.cbo?.code === p.cbo)) ctx.registro.aviso(`CBO ${p.cbo} (${p.chave}) sem linha no mapa CBO → perfil: a sugestão virá vazia.`);
  }
  ctx.registro.passo({ passo: '1.3 mapa CBO → perfil', total: mapa.length });

  // 1.4 — documentos legais globais vigentes
  const docs = dados<Array<{ title: string; is_active: boolean; current_version_id: number | null }>>((await admin.get('/api/legal-documents')).corpo);
  const vigentes = docs.filter((d) => d.is_active && d.current_version_id);
  expect(vigentes.length, 'nenhum documento legal global vigente').toBeGreaterThan(0);
  ctx.registro.passo({ passo: '1.4 documentos legais', vigentes: vigentes.map((d) => d.title) });

  // 1.5 — organização
  const org = ctx.elenco.organizacao;
  const status = dados<Array<{ id: number; code: string }>>((await admin.get('/api/tenant-statuses')).corpo).find((s) => s.code === '001');
  expect(status, 'status de tenant 001 (Ativo) não semeado').toBeTruthy();
  ctx.chaveAtual = 'ORG';
  const tenant = dados<{ id: number; uuid: string }>(
    (
      await admin.post('/api/tenants', {
        legal_name: org.razao_social,
        trade_name: 'Demonstração SigSUAS',
        cnpj: org.cnpj,
        email: 'contato@demo.sigsuas.local',
        phone: '82980000000',
        timezone: 'America/Maceio',
        status_id: status!.id,
      })
    ).corpo,
  );
  ctx.chaves.definir(CHAVE_TENANT, tenant.uuid);
  ctx.chaves.definir('TENANT_ID', String(tenant.id));
  ctx.chaveAtual = null;
});

etapa('E01c', 'Setup global: endereço, CARDUG, Master e responsável', 'admin', async (ctx) => {
  const admin = await ctx.sessoes.entrar('admin');
  const tenantUuid = ctx.chaves.obter(CHAVE_TENANT);
  const tenantId = Number(ctx.chaves.obter('TENANT_ID'));
  const org = ctx.elenco.organizacao;

  // 1.6 — endereço oficial em Arapiraca, logradouro do DNE importado na E01b
  ctx.chaveAtual = 'ORG';
  const endereco = await resolverEnderecoDne(admin, { ibge: org.ibge, uf: org.uf, bairro: 'Centro', numero: '1000' });
  await admin.put(`/api/tenants/${tenantUuid}/official-address`, {
    ...endereco.payload,
    complement: 'Sede da Secretaria (fictícia)',
    geometry: { latitude: -9.7521485, longitude: -36.6619307, source: 'massa-dados' },
  });
  ctx.registro.passo({ passo: '1.6 endereço oficial', cidade: org.ibge, bairro: endereco.payload.territorial_unit, dne: endereco.origem });

  // 1.7 — parâmetros TCE/AL (CARDUG de 6 dígitos, BR-011)
  await admin.put(`/api/tenants/${tenantUuid}/tce-parameters`, {
    cardug_identifier: '980001',
    managing_unit: 'Secretaria Municipal de Assistência Social (Demonstração)',
    managing_unit_cnpj: org.cnpj,
  });

  // 1.9 — usuário Master (papel `master`, guard client)
  ctx.chaveAtual = 'M0';
  const m = org.master;
  const user = dados<{ id: number; uuid: string }>(
    (await admin.post('/api/users', { full_name: m.nome, email: m.email, cpf: m.cpf, birth_date: '1980-03-15', type: 'client', tenant_id: tenantId })).corpo,
  );
  ctx.chaves.definir('USER_M0', user.uuid);
  const papeis = await listarTudo<{ id: number; name: string; guard_name: string }>(admin, '/api/roles');
  const master = papeis.find((r) => r.name === m.papel && r.guard_name === 'client');
  expect(master, `papel "${m.papel}" (client) não encontrado`).toBeTruthy();
  const vinculos = dados<Array<{ tenant?: { uuid?: string }; tenant_id?: number; role?: { name?: string } }>>((await admin.get(`/api/users/${user.uuid}/tenant-roles`)).corpo);
  const jaVinculado = vinculos.some((v) => (v.tenant_id === tenantId || v.tenant?.uuid === tenantUuid) && v.role?.name === m.papel);
  if (!jaVinculado) await admin.post(`/api/users/${user.uuid}/tenant-roles`, { tenant_id: tenantId, user_id: user.id, role_id: master!.id });
  ctx.chaves.definir('M0_CRIADO_EM', new Date().toISOString());

  // 1.8 — responsável da organização (o Master)
  ctx.chaveAtual = 'ORG';
  await admin.post(`/api/tenants/${tenantUuid}/responsibles`, { user_id: user.id, period_start: '2026-01-01', period_end: '2028-12-31' });
  ctx.chaveAtual = null;
});
