/**
 * Gera `insumos/unidades-ficticias.json` (#10994 · RN02b, BR-009, AC-008/AC-011).
 *
 * 2 CRAS + 1 CREAS com nomes padronizados, código MDS de 13 dígitos marcado (IBGE + "98" +
 * ordem), tipo pelo código de `SocialUnitTypeCode` e coordenada sorteada com SEMENTE FIXA dentro
 * de um bairro de Arapiraca e de um setor censitário. O logradouro exato sai do DNE importado em
 * E1b (não versionado), por isso fica nulo aqui e é resolvido pelo executor em E4.
 */
import type { Feature, FeatureCollection } from './lib/geo.ts';
import { arredondar, caixaDaGeometria, featureQueContem, pontoNaGeometria } from './lib/geo.ts';
import { caminhoInsumo, escreverJson } from './lib/json.ts';
import type { Prng } from './lib/prng.ts';
import { mulberry32, sementeDeTexto } from './lib/prng.ts';
import { lerGeo } from './geo.ts';

export const IBGE_ARAPIRACA = '2700300';
export const VERSAO_INSUMOS = '2026-09-29.1';

export type ChaveUnidade = 'U-CN' | 'U-CS' | 'U-CE';

export interface UnidadeBase {
  chave: ChaveUnidade;
  nome: string;
  tipo: 'CRAS' | 'CREAS';
  /** `social_unit_types.code` (SocialUnitTypeCode): 001 CRAS, 002 CREAS. */
  tipo_codigo: '001' | '002';
  /** Código MDS de 13 dígitos: IBGE (7) + "98" (marcação) + ordem (4). */
  codigo_mds: string;
}

export const UNIDADES: readonly UnidadeBase[] = [
  { chave: 'U-CN', nome: 'CRAS Demonstração Norte', tipo: 'CRAS', tipo_codigo: '001', codigo_mds: `${IBGE_ARAPIRACA}980001` },
  { chave: 'U-CS', nome: 'CRAS Demonstração Sul', tipo: 'CRAS', tipo_codigo: '001', codigo_mds: `${IBGE_ARAPIRACA}980002` },
  { chave: 'U-CE', nome: 'CREAS Demonstração', tipo: 'CREAS', tipo_codigo: '002', codigo_mds: `${IBGE_ARAPIRACA}980003` },
];

export interface Coordenada {
  latitude: number;
  longitude: number;
  /** `id` do setor censitário (CD2022) que contém o ponto. */
  setor: string;
  /** Nome do bairro (CD2022) que contém o ponto. */
  bairro: string;
}

/** Centro da caixa do bairro — só para ordenar norte → sul de forma estável. */
function latitudeCentral(f: Feature): number {
  const c = caixaDaGeometria(f.geometry);
  return (c.minLat + c.maxLat) / 2;
}

/** Bairros ordenados do norte para o sul (empate pelo código IBGE). */
export function bairrosNorteSul(bairros: FeatureCollection): Feature[] {
  return [...bairros.features].sort((a, b) => {
    const d = latitudeCentral(b) - latitudeCentral(a);
    return d !== 0 ? d : String(a.properties.code).localeCompare(String(b.properties.code));
  });
}

/**
 * Sorteia (com o PRNG recebido) um ponto dentro do bairro E de algum setor. O ponto já sai
 * arredondado a 7 casas e é reconferido depois do arredondamento.
 */
export function pontoNoBairro(prng: Prng, bairro: Feature, setores: FeatureCollection): Coordenada {
  const caixa = caixaDaGeometria(bairro.geometry);
  for (let tentativa = 0; tentativa < 5000; tentativa++) {
    const lon = arredondar(caixa.minLon + prng.next() * (caixa.maxLon - caixa.minLon));
    const lat = arredondar(caixa.minLat + prng.next() * (caixa.maxLat - caixa.minLat));
    if (!pontoNaGeometria(lon, lat, bairro.geometry)) continue;
    const setor = featureQueContem(lon, lat, setores);
    if (setor === null) continue;
    return { latitude: lat, longitude: lon, setor: String(setor.properties.id), bairro: String(bairro.properties.name) };
  }
  throw new Error(`Não foi possível sortear ponto no bairro ${String(bairro.properties.name)}`);
}

export interface UnidadeFicticia extends UnidadeBase {
  endereco: {
    municipio_ibge: string;
    bairro: string;
    logradouro: null;
    numero: string;
    observacao: string;
  };
  coordenada: Coordenada;
}

export interface ArquivoUnidades {
  versao: string;
  semente: string;
  unidades: UnidadeFicticia[];
}

export const SEMENTE_UNIDADES = 'unidades-v1';

export function gerarUnidades(): ArquivoUnidades {
  const bairros = lerGeo('geo/bairros-arapiraca.geojson');
  const setores = lerGeo('geo/setores-arapiraca.geojson');
  const ordenados = bairrosNorteSul(bairros);
  const centro = bairros.features.find((f) => f.properties.name === 'Centro');
  if (!centro) throw new Error('Bairro "Centro" ausente em bairros-arapiraca.geojson');
  const bairroDa: Record<ChaveUnidade, Feature> = {
    'U-CN': ordenados[0] as Feature,
    'U-CS': ordenados[ordenados.length - 1] as Feature,
    'U-CE': centro,
  };
  const prng = mulberry32(sementeDeTexto(SEMENTE_UNIDADES));
  const unidades = UNIDADES.map((u, i): UnidadeFicticia => {
    const coordenada = pontoNoBairro(prng, bairroDa[u.chave], setores);
    return {
      ...u,
      endereco: {
        municipio_ibge: IBGE_ARAPIRACA,
        bairro: coordenada.bairro,
        logradouro: null,
        numero: String(100 * (i + 1)),
        observacao: 'Logradouro resolvido em E4 a partir do DNE importado em E1b (primeiro logradouro do bairro).',
      },
      coordenada,
    };
  });
  const arquivo: ArquivoUnidades = { versao: VERSAO_INSUMOS, semente: SEMENTE_UNIDADES, unidades };
  escreverJson(caminhoInsumo('unidades-ficticias.json'), arquivo);
  return arquivo;
}
