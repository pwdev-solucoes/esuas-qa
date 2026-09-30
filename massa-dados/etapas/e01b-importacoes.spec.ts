/**
 * E01b — Importações geográficas (#10994 · roadmap 01b, BR-007). Papel: Administrador (manager).
 *
 * 1b.1 DNE: upload do ZIP (já conferido pelo CLI na E0) → processamento → sync, por polling.
 * 1b.2–1b.4 Camadas IBGE: municípios de AL, setores e bairros de Arapiraca (geo-layer-imports) →
 *   processamento → sync. O sync dos dois lados nacionais (município + setor) é o "gate de
 *   homologação" (RN03/CA44 da HU #9884) exigido para publicar camadas.
 * 1b.5 Publicação direcionada: uma camada do Construtor de Camadas publicada só para a organização demo.
 */
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { lerEstado } from '../lib/execucao.ts';
import type { ClientePapel } from '../lib/http.ts';
import { arquivo, CHAVE_TENANT, dados, enviarArquivo, etapa, PASTA_INSUMOS, type ContextoEtapa } from '../lib/papeis.ts';
import { aguardar } from '../lib/polling.ts';

interface Importacao {
  id: number;
  uuid?: string;
  status: string;
  sync_status?: string | null;
  sync_summary?: Record<string, unknown> | null;
  error_message?: string | null;
  sync_error?: string | null;
  [k: string]: unknown;
}

/** Espera o processamento (status) e depois o sync (sync_status) de uma importação. */
async function processarESincronizar(ctx: ContextoEtapa, admin: ClientePapel, recurso: string, id: number, rotulo: string): Promise<Importacao> {
  const ler = async () => dados<Importacao>((await admin.get(`/api/${recurso}/${id}`)).corpo);
  const inicio = Date.now();
  const processado = await aguardar(`${rotulo}: processamento`, ler, (v) =>
    v.status === 'completed' ? 'pronto' : v.status === 'failed' ? { falha: String(v.error_message ?? 'status failed') } : 'aguardando',
  );
  ctx.registro.passo({ chave: rotulo, passo: 'processado', status: processado.status, duracaoMs: Date.now() - inicio });
  await admin.post(`/api/${recurso}/${id}/sync`);
  const inicioSync = Date.now();
  const sincronizado = await aguardar(`${rotulo}: sincronização`, ler, (v) =>
    v.sync_status === 'synced' ? 'pronto' : v.sync_status === 'failed' ? { falha: String(v.sync_error ?? 'sync failed') } : 'aguardando',
  );
  ctx.registro.passo({ chave: rotulo, passo: 'sincronizado', sync_status: sincronizado.sync_status, sync_summary: sincronizado.sync_summary ?? null, duracaoMs: Date.now() - inicioSync });
  ctx.log(`  ✔ ${rotulo}: ${JSON.stringify(sincronizado.sync_summary ?? {})}`);
  return sincronizado;
}

etapa('E01b', 'Importações geográficas', 'admin', async (ctx) => {
  const admin = await ctx.sessoes.entrar('admin');
  const { estado } = lerEstado(ctx.caminho);
  const dne = estado.dne;
  expect(dne?.arquivo, 'DNE não registrado pela E0').toBeTruthy();

  // 1b.1 — DNE ------------------------------------------------------------------------------
  ctx.chaveAtual = 'DNE';
  const competencia = new Date().toISOString().slice(0, 7);
  const criado = dados<Importacao>((await enviarArquivo(admin, '/api/dne-imports', { file: arquivo(dne!.arquivo, 'application/zip'), competence: competencia })).corpo);
  ctx.chaves.definir('DNE_IMPORT', String(criado.uuid ?? criado.id));
  await processarESincronizar(ctx, admin, 'dne-imports', criado.id, 'DNE');

  // 1b.2–1b.4 — camadas IBGE (ordem: município antes de setor e bairro) ---------------------
  const camadas: Array<{ tipo: string; arquivo: string; chave: string }> = [
    { tipo: 'municipal_geometry', arquivo: 'geo/municipios-al.geojson', chave: 'GEO_MUNICIPIOS' },
    { tipo: 'census_sector', arquivo: 'geo/setores-arapiraca.geojson', chave: 'GEO_SETORES' },
    { tipo: 'neighborhood', arquivo: 'geo/bairros-arapiraca.geojson', chave: 'GEO_BAIRROS' },
  ];
  for (const c of camadas) {
    ctx.chaveAtual = c.chave;
    const imp = dados<Importacao>(
      (await enviarArquivo(admin, '/api/geo-layer-imports', { file: arquivo(resolve(PASTA_INSUMOS, c.arquivo), 'application/geo+json'), layer_type: c.tipo })).corpo,
    );
    ctx.chaves.definir(c.chave, String(imp.uuid ?? imp.id));
    await processarESincronizar(ctx, admin, 'geo-layer-imports', imp.id, c.chave);
  }

  // 1b.5 — publicação direcionada à organização demo ----------------------------------------
  ctx.chaveAtual = 'GEO_CAMADA_DEMO';
  const tenantUuid = ctx.chaves.obter(CHAVE_TENANT);
  const camada = dados<{ id: number; uuid: string }>(
    (
      await admin.post('/api/geo-layers', {
        name: 'Demonstração SigSUAS — famílias em extrema pobreza',
        description: 'Camada da massa fictícia (#10994), publicada só para a organização de demonstração.',
        representation: 'heatmap',
        criteria: { vulnerabilities: ['extreme_poverty'] },
      })
    ).corpo,
  );
  await admin.post(`/api/geo-layers/${camada.uuid ?? camada.id}/publish`, { audience: 'selected', tenant_uuids: [tenantUuid] });
  ctx.chaves.definir('GEO_CAMADA_DEMO', camada.uuid);
  ctx.chaveAtual = null;
});
