/**
 * Geometria mínima para validar e sortear coordenadas da massa (#10994 · BR-009).
 *
 * Point-in-polygon por ray casting sobre GeoJSON (Polygon/MultiPolygon, com buracos).
 * Coordenadas GeoJSON são [longitude, latitude].
 */

export type Posicao = [number, number];
type Anel = Posicao[];
type Poligono = Anel[];

export interface Geometria {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: Poligono | Poligono[];
}

export interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: Geometria;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

export interface Caixa {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function poligonos(geo: Geometria): Poligono[] {
  return geo.type === 'Polygon' ? [geo.coordinates as Poligono] : (geo.coordinates as Poligono[]);
}

function dentroDoAnel(lon: number, lat: number, anel: Anel): boolean {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i] as Posicao;
    const [xj, yj] = anel[j] as Posicao;
    const cruza = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (cruza) dentro = !dentro;
  }
  return dentro;
}

/** O ponto (lon, lat) está dentro da geometria (fora dos buracos)? */
export function pontoNaGeometria(lon: number, lat: number, geo: Geometria): boolean {
  for (const poli of poligonos(geo)) {
    const [externo, ...buracos] = poli;
    if (!externo || !dentroDoAnel(lon, lat, externo)) continue;
    if (buracos.some((b) => dentroDoAnel(lon, lat, b))) continue;
    return true;
  }
  return false;
}

export function caixaDaGeometria(geo: Geometria): Caixa {
  const caixa: Caixa = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const poli of poligonos(geo)) {
    for (const [lon, lat] of poli[0] ?? []) {
      caixa.minLon = Math.min(caixa.minLon, lon);
      caixa.maxLon = Math.max(caixa.maxLon, lon);
      caixa.minLat = Math.min(caixa.minLat, lat);
      caixa.maxLat = Math.max(caixa.maxLat, lat);
    }
  }
  return caixa;
}

/** Primeira feature (na ordem do arquivo) que contém o ponto, ou `null`. */
export function featureQueContem(lon: number, lat: number, colecao: FeatureCollection): Feature | null {
  for (const f of colecao.features) {
    if (pontoNaGeometria(lon, lat, f.geometry)) return f;
  }
  return null;
}

/** Arredonda para 7 casas (≈ 1 cm), como no molde `massa-geo-coords-arapiraca-32.json`. */
export function arredondar(valor: number): number {
  return Math.round(valor * 1e7) / 1e7;
}
