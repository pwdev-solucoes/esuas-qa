/**
 * E4 — Unidades: 2 CRAS + 1 CREAS (#10994 · roadmap 03, CA01). Papel: Operacional P0, sem lotação (A5).
 * Cada unidade ganha um endereço com logradouro do DNE (bairro do insumo) e o ponto no mapa
 * (geometria do insumo, dentro do setor declarado) e é criada com o número MDS de 13 dígitos.
 */
import { expect } from '@playwright/test';
import { dados, etapa, idDoLookup, lerInsumo, resolverEnderecoDne, type UnidadeFicticia } from '../lib/papeis.ts';

const NOME_TIPO: Record<string, string> = {
  CRAS: 'Centro de Referência de Assistência Social',
  CREAS: 'Centro de Referência Especializado de Assistência Social',
};

etapa('E04', 'Unidades: 2 CRAS + 1 CREAS', 'P0', async (ctx) => {
  const p0 = await ctx.sessoes.entrar('P0');
  const { unidades } = lerInsumo<{ unidades: UnidadeFicticia[] }>('unidades-ficticias.json');
  expect(unidades).toHaveLength(3);
  const org = ctx.elenco.organizacao;
  const statusId = await idDoLookup(p0, '/api/relationals/social-unit-statuses', '001');
  const zonaId = await idDoLookup(p0, '/api/relationals/location-types', '001');
  for (const u of unidades) {
    ctx.chaveAtual = u.chave;
    const tipoId = await idDoLookup(p0, '/api/relationals/social-unit-types', NOME_TIPO[u.tipo], 'name');
    const endereco = await resolverEnderecoDne(p0, { ibge: u.endereco.municipio_ibge, uf: org.uf, municipio: org.municipio, bairro: u.endereco.bairro, numero: u.endereco.numero });
    const address = dados<{ id: number }>(
      (
        await p0.post('/api/client/addresses', {
          ...endereco.payload,
          geometry: { latitude: u.coordenada.latitude, longitude: u.coordenada.longitude, source: 'massa-dados' },
        })
      ).corpo,
    );
    const unidade = dados<{ id: number; uuid: string }>(
      (
        await p0.post('/api/client/social-units', {
          mds_number: u.codigo_mds,
          name: u.nome,
          type_id: tipoId,
          status_id: statusId,
          location_type_id: zonaId,
          email: `${u.chave.toLowerCase()}@demo.sigsuas.local`,
          phone: '8298000020' + unidades.indexOf(u),
          address_id: address.id,
          activity_start_date: '2020-01-01',
        })
      ).corpo,
    );
    ctx.chaves.definir(`UNIT_${u.chave}`, unidade.uuid);
    ctx.chaves.definir(`UNIT_ID_${u.chave}`, String(unidade.id));
    ctx.registro.passo({ chave: u.chave, passo: '4.1/4.2 unidade com endereço DNE e geometria', mds: u.codigo_mds, endereco: endereco.origem, setor: u.coordenada.setor });
  }
  ctx.chaveAtual = null;
});
