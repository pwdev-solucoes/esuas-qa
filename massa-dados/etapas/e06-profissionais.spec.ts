/**
 * E6 — Profissionais, CBO, perfis e lotação (#10994 · roadmap 04, BR-001, BR-005, BR-008).
 * Papel: Master (`professionals.*` é exclusivo dele). Duas etapas no mesmo arquivo (BR-002):
 *   E06a (6.0): P0, Operacional de cadastro SEM lotação, criado antes das unidades; primeiro acesso.
 *   E06  (6.1–6.4): P1–P7 com CBO e sugestão de perfil, add-ons, lotação desde 2026-05-01 e primeiro
 *                   acesso de cada um (senha pelo Mailpit + aceite legal).
 */
import { expect } from '@playwright/test';
import type { ClientePapel } from '../lib/http.ts';
import {
  CHAVE_TENANT,
  dados,
  etapa,
  idDoCbo,
  listarTudo,
  primeiroAcesso,
  resolverEnderecoDne,
  type ContextoEtapa,
  type ProfissionalElenco,
} from '../lib/papeis.ts';

async function papeisDoTenant(master: ClientePapel): Promise<Map<string, number>> {
  const lista = await listarTudo<{ id: number; name: string }>(master, '/api/client/roles');
  return new Map(lista.map((r) => [r.name, r.id]));
}

/** Cria o profissional (Master) e devolve o uuid + o instante da criação (para o e-mail de senha). */
async function criarProfissional(ctx: ContextoEtapa, master: ClientePapel, p: ProfissionalElenco, indice: number): Promise<{ uuid: string; criadoEm: Date }> {
  ctx.chaveAtual = p.chave;
  const org = ctx.elenco.organizacao;
  const endereco = await resolverEnderecoDne(master, { ibge: org.ibge, uf: org.uf, municipio: org.municipio, bairro: 'Centro', numero: String(500 + indice) });
  const address = dados<{ id: number }>((await master.post('/api/client/addresses', endereco.payload)).corpo);
  const cboId = await idDoCbo(master, p.cbo);
  const sugestao = dados<unknown>((await master.get(`/api/client/professionals/role-suggestion?cbo_id=${cboId}`)).corpo);
  ctx.registro.passo({ chave: p.chave, passo: '6.1 sugestão de perfil pelo CBO', cbo: p.cbo, sugestao: JSON.stringify(sugestao).slice(0, 300) });
  const criadoEm = new Date();
  const prof = dados<{ uuid: string; id: number }>(
    (
      await master.post('/api/client/professionals', {
        cpf: p.cpf,
        full_name: p.nome,
        birth_date: `198${indice}-0${(indice % 9) + 1}-15`,
        email: p.email,
        phone: `8298000010${indice}`,
        address_id: address.id,
        registration_number: `DEMO-${p.chave}`,
        role: p.papel,
        cbo_id: cboId,
      })
    ).corpo,
  );
  ctx.chaves.definir(`PROF_${p.chave}`, prof.uuid);
  return { uuid: prof.uuid, criadoEm };
}

etapa('E06a', 'Operacional de cadastro P0 (6.0)', 'M0', async (ctx) => {
  const master = await ctx.sessoes.entrar('M0');
  const p0 = ctx.elenco.profissionais.find((p) => p.chave === 'P0')!;
  expect(p0.lotacoes, 'P0 não deve ter lotação').toHaveLength(0);
  const { criadoEm } = await criarProfissional(ctx, master, p0, 0);
  await primeiroAcesso(ctx, 'P0', criadoEm);
  ctx.chaveAtual = null;
});

etapa('E06', 'Equipe P1–P7: perfis, add-ons, lotação e primeiro acesso', 'M0', async (ctx) => {
  const master = await ctx.sessoes.entrar('M0');
  const papeis = await papeisDoTenant(master);
  const equipe = ctx.elenco.profissionais.filter((p) => p.chave !== 'P0');
  const criados: Array<{ p: ProfissionalElenco; criadoEm: Date }> = [];
  for (const [i, p] of equipe.entries()) {
    const { uuid, criadoEm } = await criarProfissional(ctx, master, p, i + 1);
    criados.push({ p, criadoEm });
    // 6.2 add-ons (papéis) — o grant de permissão avulsa não tem rota na API (achado RN14)
    if (p.add_ons.length) {
      const ids = [p.papel, ...p.add_ons].map((nome) => {
        const id = papeis.get(nome);
        if (!id) throw new Error(`Papel "${nome}" não existe no tenant.`);
        return id;
      });
      await master.put(`/api/client/professionals/${uuid}/roles`, { role_ids: ids });
    }
    for (const extra of p.permissoes_extras) {
      ctx.achado(
        `${p.chave}: permissão avulsa "${extra}" sem caminho pela API — o Master só atribui PAPÉIS (PUT professionals/{id}/roles) e nenhum papel do tenant além do master concede "${extra}". ${p.chave} fica só com "${p.papel}".`,
      );
    }
    // 6.3 lotação desde 2026-05-01
    const cboId = await idDoCbo(master, p.cbo);
    for (const l of p.lotacoes) {
      await master.post(`/api/client/professionals/${uuid}/units`, { social_unit_id: Number(ctx.chaves.obter(`UNIT_ID_${l.unidade}`)), cbo_id: cboId, start_date: l.desde });
      ctx.registro.passo({ chave: p.chave, passo: '6.3 lotação', unidade: l.unidade, desde: l.desde });
    }
  }
  // 6.4 primeiro acesso (senha pelo e-mail + aceite legal); o login novo já recalcula os add-ons
  for (const { p, criadoEm } of criados) await primeiroAcesso(ctx, p.chave, criadoEm);
  expect(ctx.chaves.obter(CHAVE_TENANT)).toBeTruthy();
  ctx.chaveAtual = null;
});
