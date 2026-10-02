/**
 * E9 — Diagnóstico (#10994 · roadmap 05/E9, RN10). Papel: o mesmo Operacional lotado da E08.
 * 9.1 condições habitacionais (exceto F-HAB-1..2, `habitacao: null` no elenco);
 * 9.2 condições de cada integrante (escolaridade nula só onde o elenco manda — F-ESCOL).
 */
import { dados, etapa, uuidDoLookup } from '../lib/papeis.ts';

const RESPONSAVEL_POR_UNIDADE: Record<string, string> = { 'U-CN': 'P1', 'U-CS': 'P2', 'U-CE': 'P3' };

etapa('E09', 'Diagnóstico: condições habitacionais e do integrante', 'P1–P3', async (ctx) => {
  const p1 = await ctx.sessoes.entrar('P1');
  const cache = new Map<string, string>();
  const lookup = async (uri: string, codigo: string) => {
    const k = `${uri}|${codigo}`;
    if (!cache.has(k)) cache.set(k, await uuidDoLookup(p1, uri, codigo));
    return cache.get(k)!;
  };
  const estado = ctx.chaves;
  let habitacoes = 0;
  let condicoes = 0;
  for (const f of ctx.elenco.familias.filter((x) => x.unidade_referencia)) {
    ctx.chaveAtual = f.chave;
    let uuid: string;
    try {
      uuid = estado.obter(`FAM_${f.chave}`);
    } catch {
      continue;
    }
    const op = await ctx.sessoes.entrar(RESPONSAVEL_POR_UNIDADE[f.unidade_referencia!]);
    const base = `/api/client/families/${uuid}`;
    if (f.habitacao) {
      await op.put(`${base}/housing-conditions`, {
        residence_type_uuid: await lookup('/api/residence-types', f.habitacao.tipo_residencia),
        in_risk_area: f.habitacao.area_risco,
        domicile_vulnerability: f.habitacao.vulnerabilidade,
      });
      habitacoes += 1;
    }
    const membros = dados<{ members: Array<{ member_uuid: string; person_uuid: string }> }>((await op.get(`${base}/members`)).corpo).members;
    for (const p of ctx.elenco.pessoas.filter((x) => x.familia_chave === f.chave)) {
      const pessoaUuid = estado.obter(`PES_${p.chave}`);
      const m = membros.find((x) => x.person_uuid === pessoaUuid);
      if (!m) throw new Error(`${p.chave} não está na composição de ${f.chave}.`);
      await op.put(`${base}/members/${m.member_uuid}/conditions`, {
        own_income: p.condicoes.renda_propria,
        is_literate: p.condicoes.alfabetizado,
        has_serious_illness: p.condicoes.doenca_grave,
        schooling_level_uuid: p.escolaridade ? await lookup('/api/schooling-levels', p.escolaridade) : null,
        school_situation_uuid: p.condicoes.situacao_escolar ? await lookup('/api/school-situations', p.condicoes.situacao_escolar) : null,
      });
      condicoes += 1;
    }
  }
  ctx.chaveAtual = null;
  ctx.registro.passo({ passo: '9.1/9.2 diagnóstico', habitacoes, condicoes_de_integrantes: condicoes });
});
