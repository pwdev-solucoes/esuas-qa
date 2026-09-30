/**
 * E19 — Painel georreferenciado, leitura (#10994 · roadmap 07/E19, BR-014, AC-011).
 * Papel: P6 (`geo_panel_viewer`, lotada no CRAS Sul).
 *
 * 19.1 contexto do município, camadas (limites, setores, CRAS/CREAS, camada da demo), setores e bairros;
 *      as 3 unidades da massa no mapa, com coordenadas.
 * 19.2 busca por raio a partir de uma unidade (pontos das famílias) e dados da camada de heatmap da demo.
 * Pontos anônimos: nenhuma chave de dado pessoal (nome, CPF, NIS, nascimento, mãe, contato, endereço)
 * nos pontos devolvidos. Só leitura (GET e a busca POST, que não grava nada).
 * A navegação no browser e as capturas ficam com o relatório de evidências (plano 06).
 */
import { expect } from '@playwright/test';
import { dados, etapa } from '../lib/papeis.ts';
import { consultar } from '../lib/verificacoes-sql.ts';

/** Chaves proibidas em qualquer nível dos pontos (PII). */
const CHAVE_PII = /(cpf|nis|name|nome|birth|nascimento|mother|mae|phone|telefone|email|street|logradouro|address|endereco|number|numero|person|pessoa|member)/i;

function chavesPii(valor: unknown, caminho = ''): string[] {
  if (Array.isArray(valor)) return valor.flatMap((v, i) => (i < 50 ? chavesPii(v, caminho) : []));
  if (valor && typeof valor === 'object') {
    return Object.entries(valor as Record<string, unknown>).flatMap(([k, v]) => [...(CHAVE_PII.test(k) ? [`${caminho}${k}`] : []), ...chavesPii(v, `${caminho}${k}.`)]);
  }
  return [];
}

etapa('E19', 'Painel georreferenciado (leitura, P6)', 'P6', async (ctx) => {
  const p6 = await ctx.sessoes.entrar('P6');
  const contexto = dados<{ city: { ibge_code: string } }>((await p6.get('/api/client/geo-panel/context')).corpo);
  expect(contexto.city.ibge_code).toBe(ctx.elenco.organizacao.ibge);

  const camadas = dados<Array<{ code?: string; uuid?: string; kind: string; representation?: string }>>((await p6.get('/api/client/geo-panel/layers')).corpo);
  const codigos = camadas.map((c) => c.code ?? c.kind);
  expect(codigos).toEqual(expect.arrayContaining(['municipal-boundaries', 'census-sectors', 'social-units']));
  const demo = camadas.find((c) => c.uuid === ctx.chaves.obter('GEO_CAMADA_DEMO'));
  expect(demo, 'camada da demo publicada para a organização').toBeTruthy();

  const setores = (await p6.get<{ features: unknown[] }>('/api/client/geo-panel/census-sectors')).corpo.features.length;
  const bairros = (await p6.get<{ features: unknown[] }>('/api/client/geo-panel/neighborhoods')).corpo.features.length;
  const unidades = dados<Array<{ uuid: string; lat: number; lng: number }>>((await p6.get('/api/client/geo-panel/social-units')).corpo);
  const nossas = ['U-CN', 'U-CS', 'U-CE'].map((u) => unidades.find((x) => x.uuid === ctx.chaves.obter(`UNIT_${u}`)));
  ctx.registro.passo({ passo: '19.1 camadas', camadas: codigos, setores, bairros, unidades_no_mapa: nossas.filter(Boolean).length });
  expect(setores).toBeGreaterThan(0);
  expect(bairros).toBeGreaterThan(0);
  for (const u of nossas) {
    expect(u, 'unidade da massa no mapa').toBeTruthy();
    expect(Number.isFinite(u?.lat) && Number.isFinite(u?.lng)).toBe(true);
  }

  // 19.2 — pontos das famílias (busca por raio a partir de cada unidade) e heatmap da demo.
  const pontos: unknown[] = [];
  let total = 0;
  for (const u of ['U-CN', 'U-CS', 'U-CE']) {
    const r = dados<Record<string, unknown>>((await p6.post('/api/client/geo-panel/search', { origin_social_unit_uuid: ctx.chaves.obter(`UNIT_${u}`), radius_km: 20 })).corpo);
    const lista = (r.points ?? r.families ?? []) as unknown[];
    total = Math.max(total, Number(r.total ?? lista.length));
    pontos.push(...lista);
    ctx.registro.passo({ passo: `19.2 busca por raio (${u}, 20 km)`, chaves_resposta: Object.keys(r), total: r.total ?? lista.length });
  }
  const camadaDemo = dados<{ total: number; points: unknown[]; by_sector: unknown[] }>((await p6.get(`/api/client/geo-panel/layers/${ctx.chaves.obter('GEO_CAMADA_DEMO')}/data`)).corpo);
  ctx.registro.passo({ passo: '19.2 heatmap da camada da demo', total: camadaDemo.total, setores: camadaDemo.by_sector.length });
  if (camadaDemo.total === 0) {
    ctx.achado('E19: a camada de heatmap da demo ("famílias em extrema pobreza") fica vazia — o critério usa families.per_capita_income, que só a importação CadÚnico grava (mesma causa das divergências de perfil na E17).');
  }
  pontos.push(...camadaDemo.points);
  if (total === 0) {
    // Os pontos vêm de families.address_id (+ geometria). O client não tem endpoint que grave o endereço da
    // família (só a importação CadÚnico): comprovado no banco, a ausência vira achado RN14, não falha.
    const cnpj = ctx.elenco.organizacao.cnpj.replace(/\D/g, '');
    const comEndereco = Number(consultar(ctx.cfg, `SELECT count(address_id) FROM families WHERE tenant_id = (SELECT id FROM tenants WHERE cnpj = '${cnpj}')`)[0]?.[0]);
    ctx.registro.passo({ passo: '19.2 famílias da demo com endereço', com_endereco: comEndereco });
    expect(comEndereco, 'sem pontos no mapa apesar de famílias com endereço').toBe(0);
    ctx.achado('E19: nenhum ponto de família no mapa — o painel usa families.address_id com geometria, e o cadastro manual (client) não tem endpoint que grave o endereço da família (só a importação CadÚnico); coordenadas-familias.json fica sem uso. A anonimização dos pontos não pôde ser demonstrada com a massa.');
  }

  const pii = [...new Set(chavesPii(pontos))];
  ctx.registro.passo({ passo: 'BR-014 pontos anônimos', pontos_verificados: pontos.length, chaves_pii: pii });
  expect(pii, 'nenhum dado pessoal nos pontos do mapa').toEqual([]);
});
