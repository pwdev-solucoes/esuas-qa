/**
 * Gera `insumos/manifest.json` (#10994 · RN-T6, AC-010).
 *
 * Lista TODOS os insumos (exceto o próprio manifesto) com sha256 e uma contagem significativa
 * (features, famílias, linhas…). O preflight do plano 03 recalcula os sha256 e compara.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { caminhoInsumo, escreverJson, lerJson, PASTA_INSUMOS, sha256Arquivo } from './lib/json.ts';

export const ARQUIVO_MANIFEST = 'manifest.json';

export interface ItemManifest {
  caminho: string;
  sha256: string;
  contagem: number;
  unidade_contagem: string;
}

export interface Manifest {
  versao_elenco: string;
  arquivos: ItemManifest[];
}

function listar(pasta: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(pasta).sort()) {
    const completo = join(pasta, nome);
    if (statSync(completo).isDirectory()) out.push(...listar(completo));
    else out.push(completo);
  }
  return out;
}

/** Contagem significativa por arquivo (e a unidade dela). */
export function contar(caminhoRelativo: string): [number, string] {
  const dados = lerJson<Record<string, unknown>>(caminhoInsumo(caminhoRelativo));
  const tamanho = (v: unknown): number => (Array.isArray(v) ? v.length : Object.keys(v as object).length);
  if (caminhoRelativo.endsWith('.geojson')) return [tamanho(dados.features), 'features'];
  switch (caminhoRelativo) {
    case 'elenco.json':
      return [tamanho(dados.familias), 'familias'];
    case 'unidades-ficticias.json':
      return [tamanho(dados.unidades), 'unidades'];
    case 'entidades-ficticias.json':
      return [tamanho(dados.entidades), 'entidades'];
    case 'coordenadas-familias.json':
      return [tamanho(dados.familias), 'familias'];
    case 'esperado.json':
      return [tamanho(dados.contadores), 'contadores'];
    case 'nomes-ficticios.json':
      return [
        tamanho(dados.prenomes_femininos) + tamanho(dados.prenomes_masculinos) + tamanho(dados.sobrenomes),
        'nomes',
      ];
    default:
      throw new Error(`Insumo sem regra de contagem no manifest: ${caminhoRelativo}`);
  }
}

export function montarManifest(versaoElenco: string): Manifest {
  const arquivos = listar(PASTA_INSUMOS)
    .map((completo) => relative(PASTA_INSUMOS, completo).split('\\').join('/'))
    .filter((rel) => rel !== ARQUIVO_MANIFEST)
    .map((rel): ItemManifest => {
      const [contagem, unidade] = contar(rel);
      return { caminho: rel, sha256: sha256Arquivo(caminhoInsumo(rel)), contagem, unidade_contagem: unidade };
    });
  return { versao_elenco: versaoElenco, arquivos };
}

export function gerarManifest(versaoElenco: string): Manifest {
  const manifest = montarManifest(versaoElenco);
  escreverJson(caminhoInsumo(ARQUIVO_MANIFEST), manifest);
  return manifest;
}
