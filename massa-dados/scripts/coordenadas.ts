/**
 * Gera `insumos/coordenadas-familias.json` (#10994 · BR-004, BR-009, AC-008).
 *
 * Um ponto por família, sorteado com SEMENTE FIXA (mulberry32) dentro de um bairro de Arapiraca
 * e de um setor censitário, no molde de `e2e/fixtures/cadunico/massa-dados/massa-geo-coords-arapiraca-32.json`
 * (`tenant_ibge`, `latitude`, `longitude`). Famílias do CRAS Norte ficam na metade norte dos
 * bairros, as do CRAS Sul na metade sul; CREAS e famílias sem unidade, em qualquer bairro.
 */
import type { Elenco } from './elenco.ts';
import { caminhoInsumo, escreverJson } from './lib/json.ts';
import { mulberry32, sementeDeTexto } from './lib/prng.ts';
import { lerGeo } from './geo.ts';
import type { Coordenada } from './unidades.ts';
import { bairrosNorteSul, IBGE_ARAPIRACA, pontoNoBairro, VERSAO_INSUMOS } from './unidades.ts';

export const SEMENTE_COORDENADAS = 'coordenadas-familias-v1';

export interface ArquivoCoordenadas {
  versao: string;
  semente: string;
  familias: Record<string, Coordenada & { tenant_ibge: string }>;
}

export function gerarCoordenadas(elenco: Elenco): ArquivoCoordenadas {
  const bairros = bairrosNorteSul(lerGeo('geo/bairros-arapiraca.geojson'));
  const setores = lerGeo('geo/setores-arapiraca.geojson');
  const metade = Math.ceil(bairros.length / 2);
  const norte = bairros.slice(0, metade);
  const sul = bairros.slice(metade);
  const prng = mulberry32(sementeDeTexto(SEMENTE_COORDENADAS));

  const familias: ArquivoCoordenadas['familias'] = {};
  for (const f of elenco.familias) {
    const pool = f.unidade_referencia === 'U-CN' ? norte : f.unidade_referencia === 'U-CS' ? sul : bairros;
    const bairro = prng.pick(pool);
    familias[f.chave] = { tenant_ibge: IBGE_ARAPIRACA, ...pontoNoBairro(prng, bairro, setores) };
  }
  const arquivo: ArquivoCoordenadas = { versao: VERSAO_INSUMOS, semente: SEMENTE_COORDENADAS, familias };
  escreverJson(caminhoInsumo('coordenadas-familias.json'), arquivo);
  return arquivo;
}
