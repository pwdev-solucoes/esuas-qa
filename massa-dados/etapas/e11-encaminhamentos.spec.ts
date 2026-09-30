/**
 * E11 — Encaminhamentos (#10994 · roadmap 06/E11, BR-003, CA09, AC-001, AC-009).
 * - 11.1 encaminhamentos CadÚnico (07/08) e BPC (09, com integrante), pelo profissional lotado;
 * - 11.2 desfecho `attended` onde o elenco manda (contra-referência: o elenco não traz nenhuma);
 * - 11.3 F-ENC (CA09): trânsito interno código 14 do CREAS (P4) para o CRAS Sul, com a unidade de
 *   destino definida já na criação (a API exige `destination_social_unit_uuid` para 13/14) e SEM
 *   desfecho (fica `awaiting_return`; o acesso pelo encaminhamento é vivo e sumiria com um desfecho);
 * - 11.4 fila `referrals/pending`.
 * Prova do CA09: P2 (lotada só no CRAS Sul) NÃO abre o prontuário de F-ENC antes do encaminhamento e
 * ABRE depois; P5 (sem `family_viewer`) não abre prontuário nenhum (403/404: a API não revela a
 * existência do prontuário a quem não tem acesso).
 */
import { expect } from '@playwright/test';
import { dados, etapa, statusDaFalha } from '../lib/papeis.ts';
import { chaveOpcional, chaveRegistro, registrarTodos } from '../lib/registros.ts';
import type { ClientePapel } from '../lib/http.ts';

const CHAVE_F_ENC = 'ENC-2026-07-0004';
/** Acesso negado ao prontuário: a API responde 404 (não revela a existência) ou 403. */
const NEGADO = [403, 404];

async function statusAbrir(cliente: ClientePapel, familiaUuid: string): Promise<number> {
  try {
    return (await cliente.get(`/api/client/families/${familiaUuid}`)).status;
  } catch (erro) {
    const s = statusDaFalha(erro);
    if (s === null) throw erro;
    return s;
  }
}

etapa('E11', 'Encaminhamentos, desfechos e trânsito interno sem desfecho (CA09)', 'P1–P4', async (ctx) => {
  const fEnc = ctx.chaves.obter('FAM_F-ENC');
  const p2 = await ctx.sessoes.entrar('P2');
  if (!chaveOpcional(ctx, chaveRegistro(CHAVE_F_ENC))) {
    const antes = await statusAbrir(p2, fEnc);
    ctx.registro.passo({ passo: 'CA09 antes: P2 abre F-ENC?', status: antes });
    expect(NEGADO, 'P2 (só CRAS Sul) não abre F-ENC antes do encaminhamento').toContain(antes);
  }

  await registrarTodos(ctx, 'referral', async (r, uuid, ex) => {
    await ex.desfecho(r, uuid);
  });

  // 11.3 — F-ENC: código 14, destino CRAS Sul, sem desfecho.
  const refUuid = ctx.chaves.obter(chaveRegistro(CHAVE_F_ENC));
  const p4 = await ctx.sessoes.entrar('P4');
  const lista = dados<Array<Record<string, unknown>>>((await p4.get(`/api/client/families/${fEnc}/referrals?per_page=100`)).corpo);
  const ref = lista.find((x) => x.uuid === refUuid) as Record<string, unknown> | undefined;
  expect(ref, 'encaminhamento de F-ENC listado').toBeTruthy();
  const codigo = (ref?.referral_code as { code?: string } | undefined)?.code ?? ref?.referral_code_code;
  const destino = (ref?.destination_social_unit as { uuid?: string } | undefined)?.uuid ?? ref?.destination_social_unit_uuid;
  const desfecho = (ref?.outcome as { value?: string } | string | null | undefined) ?? null;
  const desfechoValor = typeof desfecho === 'object' && desfecho !== null ? desfecho.value : desfecho;
  ctx.registro.passo({ passo: '11.3 F-ENC', codigo, destino_e_cras_sul: destino === ctx.chaves.obter('UNIT_U-CS'), desfecho: desfechoValor ?? null });
  expect(codigo).toBe('14');
  expect(destino).toBe(ctx.chaves.obter('UNIT_U-CS'));
  expect([null, 'awaiting_return']).toContain(desfechoValor ?? null);

  // CA09 — acesso pelo encaminhamento (vivo).
  const depois = await statusAbrir(p2, fEnc);
  ctx.registro.passo({ passo: 'CA09 depois: P2 abre F-ENC?', status: depois });
  expect(depois, 'P2 abre F-ENC pelo encaminhamento recebido').toBe(200);
  const p5 = await ctx.sessoes.entrar('P5');
  for (const chave of ['FAM_F-ENC', 'FAM_F-DUPLA', 'FAM_FAM-001']) {
    const s = await statusAbrir(p5, ctx.chaves.obter(chave));
    ctx.registro.passo({ passo: 'CA09: P5 (sem family_viewer) abre prontuário?', chave, status: s });
    expect(NEGADO, `P5 não abre ${chave}`).toContain(s);
  }

  // 11.4 — fila de encaminhamentos pendentes (P2, destino).
  const pendentes = (await p2.get<{ data: unknown[]; meta?: { total?: number } }>('/api/client/referrals/pending')).corpo;
  ctx.registro.passo({ passo: '11.4 referrals/pending (P2)', itens: pendentes.meta?.total ?? pendentes.data?.length ?? null });
});
