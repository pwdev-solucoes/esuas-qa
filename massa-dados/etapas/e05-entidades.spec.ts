/**
 * E5 — Entidades socioassistenciais (#10994 · roadmap 03/E5, CA07/RN10). Papel: Operacional P0.
 * ENT-1 com CNEAS; ENT-2 SEM CNEAS (pendência proposital). O cadastro exige `cneas_number`
 * (StoreSocialEntityRequest: required|digits:13): se a API recusar a ENT-2, isso é um ACHADO RN14 —
 * não se contorna (nada de CNEAS falso nem escrita fora da API) e a etapa segue.
 */
import { dados, etapa, idDoLookup, lerInsumo, resolverEnderecoDne, statusDaFalha, type EntidadeFicticia } from '../lib/papeis.ts';

etapa('E05', 'Entidades socioassistenciais', 'P0', async (ctx) => {
  const p0 = await ctx.sessoes.entrar('P0');
  const { entidades } = lerInsumo<{ entidades: EntidadeFicticia[] }>('entidades-ficticias.json');
  const org = ctx.elenco.organizacao;
  const ids = {
    status: await idDoLookup(p0, '/api/relationals/social-entity-statuses', '001'),
    zona: await idDoLookup(p0, '/api/relationals/location-types', '001'),
    participacao: await idDoLookup(p0, '/api/relationals/suas-participation-types', '002'),
    modalidade: await idDoLookup(p0, '/api/relationals/contract-modalities', '003'),
  };
  for (const [i, e] of entidades.entries()) {
    ctx.chaveAtual = e.chave;
    const endereco = await resolverEnderecoDne(p0, { ibge: e.municipio_ibge, uf: org.uf, municipio: org.municipio, bairro: 'Centro', numero: String(700 + i) });
    const corpo: Record<string, unknown> = {
      legal_name: e.nome,
      cnpj: e.cnpj,
      head_office_cnpj: e.cnpj,
      email: `${e.chave.toLowerCase()}@demo.sigsuas.local`,
      address: endereco.payload,
      foundation_date: '2010-03-01',
      social_entity_status_id: ids.status,
      location_type_id: ids.zona,
      suas_participation_type_id: ids.participacao,
      contract_modality_id: ids.modalidade,
      has_public_partnership: true,
      provides_emergency_benefits: false,
      executes_services: true,
      executed_services_description: 'Serviço de convivência (entidade fictícia da massa de demonstração).',
      has_active_service_agreement: true,
      contract_amount: 12000,
    };
    if (e.cneas) corpo.cneas_number = e.cneas;
    try {
      const ent = dados<{ uuid: string }>((await p0.post('/api/client/social-entities', corpo)).corpo);
      ctx.chaves.definir(`ENT_${e.chave}`, ent.uuid);
      ctx.registro.passo({ chave: e.chave, passo: '5.x entidade criada', com_cneas: Boolean(e.cneas) });
    } catch (erro) {
      if (e.cneas || statusDaFalha(erro) !== 422) throw erro;
      ctx.achado(`${e.chave} (${e.exibe}): a API exige CNEAS no cadastro de entidade (422, StoreSocialEntityRequest cneas_number required|digits:13); a pendência "entidade sem CNEAS" não pode ser criada pela API.`);
    }
  }
  ctx.chaveAtual = null;
});
