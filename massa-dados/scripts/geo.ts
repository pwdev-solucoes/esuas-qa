/**
 * Cópia validada dos GeoJSON da massa (#10994 · BR-010, AC-008).
 *
 * Os arquivos são copiados BYTE A BYTE de `docs/geojson/` do meta-repo (sem reformatar) e
 * conferidos pela contagem de features: 102 municípios de AL, 41 bairros e 427 setores de
 * Arapiraca (IBGE CD2022). A origem só é lida quando se regeneram os insumos; a execução da
 * massa lê apenas as cópias em `insumos/geo/`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FeatureCollection } from './lib/geo.ts';
import { caminhoInsumo, RAIZ_MASSA } from './lib/json.ts';

/** `docs/geojson/` do meta-repo (qa/ é submódulo de esuas-all). */
export const ORIGEM_GEOJSON = resolve(RAIZ_MASSA, '..', '..', 'docs', 'geojson');

export interface ArquivoGeo {
  destino: string;
  origem: string;
  features: number;
}

export const ARQUIVOS_GEO: readonly ArquivoGeo[] = [
  { destino: 'geo/municipios-al.geojson', origem: 'geojs-27-mun.json', features: 102 },
  { destino: 'geo/bairros-arapiraca.geojson', origem: 'arapiraca_2700300_bairros_CD2022.geojson', features: 41 },
  { destino: 'geo/setores-arapiraca.geojson', origem: 'arapiraca_2700300_setores_CD2022.geojson', features: 427 },
];

export function lerGeo(destino: string): FeatureCollection {
  return JSON.parse(readFileSync(caminhoInsumo(destino), 'utf8')) as FeatureCollection;
}

function conferir(arquivo: ArquivoGeo): void {
  const colecao = lerGeo(arquivo.destino);
  if (colecao.type !== 'FeatureCollection' || colecao.features.length !== arquivo.features) {
    throw new Error(
      `${arquivo.destino}: esperado FeatureCollection com ${arquivo.features} features, veio ${colecao.features?.length}`,
    );
  }
}

/**
 * Copia (se a origem existir) e confere. Sem a origem (qa/ clonado fora do meta-repo), apenas
 * confere as cópias já versionadas.
 */
export function gerarGeo(): void {
  for (const arquivo of ARQUIVOS_GEO) {
    const origem = resolve(ORIGEM_GEOJSON, arquivo.origem);
    if (existsSync(origem)) {
      mkdirSync(caminhoInsumo('geo'), { recursive: true });
      copyFileSync(origem, caminhoInsumo(arquivo.destino));
    } else if (!existsSync(caminhoInsumo(arquivo.destino))) {
      throw new Error(`Origem ausente (${origem}) e cópia inexistente: ${arquivo.destino}`);
    }
    conferir(arquivo);
  }
}
