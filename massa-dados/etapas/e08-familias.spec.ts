/**
 * E8 — Famílias, composição e prontuário (#10994 · roadmap 05/E8, CA01, CA07, RN10, BR-010).
 * Papel: Operacional lotado na unidade de referência com `family_viewer` (P1 CRAS Norte, P2 CRAS Sul,
 * P3 CREAS). A criação já abre o prontuário na unidade com `referenced_at` retroativo do elenco;
 * depois composição (8.2), ingresso (8.4), programas sociais e especificidade (8.5, confirmada só
 * quando o elenco manda). As 3 famílias SEM unidade de referência: o cadastro manual exige
 * `social_unit_id` (StoreFamilyRequest herda OpenFamilyRecordRequest) — se a API recusar, ACHADO RN14.
 */
import type { ClientePapel } from '../lib/http.ts';
import { dados, etapa, idDoLookup, listarTudo, statusDaFalha, type FamiliaElenco } from '../lib/papeis.ts';

const RESPONSAVEL_POR_UNIDADE: Record<string, string> = { 'U-CN': 'P1', 'U-CS': 'P2', 'U-CE': 'P3' };

etapa('E08', 'Famílias, composição e prontuário', 'P1–P3', async (ctx) => {
  const sessao = (f: FamiliaElenco): Promise<ClientePapel> => ctx.sessoes.entrar(RESPONSAVEL_POR_UNIDADE[f.unidade_referencia ?? 'U-CN']);
  const p1 = await ctx.sessoes.entrar('P1');
  const parentescos = new Map<string, number>();
  for (const k of await listarTudo<{ id: number; code: string }>(p1, '/api/relationals/kinship-types')) parentescos.set(k.code, k.id);
  const especificidades = new Map<string, number>();
  for (const e of await listarTudo<{ id: number; code: string }>(p1, '/api/relationals/social-specificities')) especificidades.set(e.code, e.id);
  const ingressoId = await idDoLookup(p1, '/api/family-intake-forms', '01');

  let criadas = 0;
  for (const f of ctx.elenco.familias) {
    ctx.chaveAtual = f.chave;
    const op = await sessao(f);
    const responsavel = ctx.chaves.obter(`PES_${f.responsavel}`);
    const corpo: Record<string, unknown> = { responsible_person_uuid: responsavel, domicile_situation: undefined };
    delete corpo.domicile_situation;
    if (f.unidade_referencia) {
      corpo.social_unit_id = Number(ctx.chaves.obter(`UNIT_ID_${f.unidade_referencia}`));
      corpo.referenced_at = f.referenciada_em;
    }
    let familia: { uuid: string };
    try {
      familia = dados<{ uuid: string }>((await op.post('/api/client/families', corpo)).corpo);
    } catch (erro) {
      if (f.unidade_referencia || statusDaFalha(erro) !== 422) throw erro;
      ctx.achado(`${f.chave} (${f.exibe}): o cadastro manual de família exige unidade de referência (422 em POST families sem social_unit_id); família sem unidade só nasce pela importação CadÚnico.`);
      continue;
    }
    criadas += 1;
    ctx.chaves.definir(`FAM_${f.chave}`, familia.uuid);
    const base = `/api/client/families/${familia.uuid}`;

    // 8.2 composição
    for (const p of ctx.elenco.pessoas.filter((x) => x.familia_chave === f.chave && x.chave !== f.responsavel)) {
      const kin = parentescos.get(p.parentesco);
      if (!kin) throw new Error(`Parentesco "${p.parentesco}" sem lookup.`);
      await op.post(`${base}/members`, { person_uuid: ctx.chaves.obter(`PES_${p.chave}`), kinship_type_id: kin });
    }
    // 8.4 ingresso + programas sociais
    await op.post(`${base}/intake`, { intake_form_id: ingressoId, reason: 'Demanda espontânea (massa fictícia de demonstração).' });
    if (f.programas_sociais.length) {
      // O formulário expõe os programas disponíveis e o `family_member_id` de cada integrante.
      const form = dados<{ available_programs: Array<{ id: number; code: string }>; members: Array<{ family_member_id: number; person_uuid: string }> }>(
        (await op.get(`${base}/social-programs`)).corpo,
      );
      const programs = f.programas_sociais.map((pr) => {
        const programa = form.available_programs.find((a) => a.code === pr.codigo);
        const membro = form.members.find((m) => m.person_uuid === ctx.chaves.obter(`PES_${pr.beneficiario}`));
        if (!programa || !membro) throw new Error(`${f.chave}: programa "${pr.codigo}" ou beneficiário ${pr.beneficiario} indisponível no formulário.`);
        return { social_program_id: programa.id, family_member_id: membro.family_member_id };
      });
      await op.put(`${base}/social-programs`, { programs });
    }
    // 8.5 especificidade (confirmada só quando o elenco manda)
    if (f.especificidade_codigo) {
      const id = especificidades.get(f.especificidade_codigo);
      if (!id) throw new Error(`Especificidade ${f.especificidade_codigo} sem lookup.`);
      const itens = dados<Array<{ uuid: string; confirmed_at?: string | null }>>(
        (await op.put(`${base}/social-specificities`, { items: [{ social_specificity_id: id, is_primary: true }] })).corpo,
      );
      if (f.especificidade_confirmada) {
        for (const it of Array.isArray(itens) ? itens : []) if (!it.confirmed_at) await op.put(`${base}/social-specificities/${it.uuid}/confirm`);
      }
    }
  }
  ctx.chaveAtual = null;
  // 8.6 filas de pendência
  const p = await ctx.sessoes.entrar('P1');
  const semUnidade = dados<unknown[]>((await p.get('/api/client/families/without-reference-unit')).corpo);
  const pendentes = dados<unknown[]>((await p.get('/api/client/families/pending-specificity')).corpo);
  ctx.registro.passo({ passo: '8.6 filas', familias_criadas: criadas, sem_unidade: Array.isArray(semUnidade) ? semUnidade.length : null, especificidade_pendente: Array.isArray(pendentes) ? pendentes.length : null });
});
