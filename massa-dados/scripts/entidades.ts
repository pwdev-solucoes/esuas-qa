/**
 * Gera `insumos/entidades-ficticias.json` (#10994 · RN02b, RN10, AC-011).
 *
 * Duas entidades: ENT-1 COM CNEAS (caso completo) e ENT-2 SEM CNEAS (pendência proposital
 * `entity_without_cneas`). CNPJ na base reservada 98.000.000/xxxx-xx com DV válido; a ordem
 * 0001 é da organização, 0002 e 0003 das entidades.
 */
import { cnpj } from './lib/cpf.ts';
import { caminhoInsumo, escreverJson } from './lib/json.ts';
import { IBGE_ARAPIRACA, VERSAO_INSUMOS } from './unidades.ts';

/** Raiz reservada do CNPJ da massa (8 dígitos). */
export const RAIZ_CNPJ_MASSA = '98000000';

export function cnpjMassa(ordem: number): string {
  return cnpj(`${RAIZ_CNPJ_MASSA}${String(ordem).padStart(4, '0')}`);
}

export interface EntidadeFicticia {
  chave: 'ENT-1' | 'ENT-2';
  nome: string;
  cnpj: string;
  /** Número CNEAS (até 13 dígitos) ou `null` — a pendência proposital. */
  cneas: string | null;
  municipio_ibge: string;
  exibe: string;
}

export interface ArquivoEntidades {
  versao: string;
  entidades: EntidadeFicticia[];
}

export function gerarEntidades(): ArquivoEntidades {
  const arquivo: ArquivoEntidades = {
    versao: VERSAO_INSUMOS,
    entidades: [
      {
        chave: 'ENT-1',
        nome: 'Associação Demonstração Amparo',
        cnpj: cnpjMassa(2),
        cneas: '9800000000001',
        municipio_ibge: IBGE_ARAPIRACA,
        exibe: 'caso completo',
      },
      {
        chave: 'ENT-2',
        nome: 'Instituto Demonstração Acolher',
        cnpj: cnpjMassa(3),
        cneas: null,
        municipio_ibge: IBGE_ARAPIRACA,
        exibe: 'pendência entity_without_cneas (conferência prévia e "Pendências de cadastro")',
      },
    ],
  };
  escreverJson(caminhoInsumo('entidades-ficticias.json'), arquivo);
  return arquivo;
}
