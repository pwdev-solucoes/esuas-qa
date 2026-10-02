/**
 * Validação da lista curada `insumos/nomes-ficticios.json` (#10994 · RN07, AC-007).
 *
 * Este script NÃO gera nomes: a lista é curada à mão. Ele confere a lista (sem duplicatas,
 * nenhum termo de bloqueio) e oferece `validarNomeCompleto()` para o elenco conferir cada nome
 * composto "Prenome + Sobrenome fictício + Sobrenome fictício".
 */
import { caminhoInsumo, lerJson } from './lib/json.ts';

export interface ListaNomes {
  versao: string;
  observacao: string;
  prenomes_femininos: string[];
  prenomes_masculinos: string[];
  sobrenomes: string[];
  bloqueio: { nomes_completos: string[]; termos: string[] };
}

export const ARQUIVO_NOMES = 'nomes-ficticios.json';

export function carregarNomes(): ListaNomes {
  return lerJson<ListaNomes>(caminhoInsumo(ARQUIVO_NOMES));
}

/** Minúsculas e sem acento, para comparar "Getúlio" com "getulio". */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function duplicatas(lista: string[]): string[] {
  const vistos = new Set<string>();
  const dup = new Set<string>();
  for (const item of lista) {
    const n = normalizar(item);
    if (vistos.has(n)) dup.add(item);
    vistos.add(n);
  }
  return [...dup].sort();
}

/** Erros da lista curada; vazio = lista válida. */
export function validarLista(lista: ListaNomes): string[] {
  const erros: string[] = [];
  const todos = [...lista.prenomes_femininos, ...lista.prenomes_masculinos, ...lista.sobrenomes];
  for (const d of duplicatas(todos)) erros.push(`duplicado na lista: ${d}`);
  const termos = new Set(lista.bloqueio.termos.map(normalizar));
  for (const item of todos) {
    if (termos.has(normalizar(item))) erros.push(`item na lista de bloqueio: ${item}`);
    if (!/^\p{Lu}[\p{L}]+$/u.test(item)) erros.push(`formato inválido (uma palavra capitalizada): ${item}`);
  }
  if (lista.sobrenomes.length < 10) erros.push('menos de 10 sobrenomes fictícios');
  return erros;
}

/**
 * Erros de um nome completo da massa; vazio = nome válido. Regras: exatamente 3 palavras;
 * prenome da lista; os dois sobrenomes da lista fictícia; nenhum termo de bloqueio; não é
 * nome completo bloqueado.
 */
export function validarNomeCompleto(nome: string, lista: ListaNomes): string[] {
  const erros: string[] = [];
  const partes = nome.split(' ');
  const prenomes = new Set([...lista.prenomes_femininos, ...lista.prenomes_masculinos]);
  const sobrenomes = new Set(lista.sobrenomes);
  if (partes.length !== 3) erros.push(`"${nome}": esperado Prenome + 2 sobrenomes`);
  const [pre, s1, s2] = partes;
  if (pre === undefined || !prenomes.has(pre)) erros.push(`"${nome}": prenome fora da lista`);
  if (s1 === undefined || !sobrenomes.has(s1)) erros.push(`"${nome}": 1º sobrenome fora da lista`);
  if (s2 === undefined || !sobrenomes.has(s2)) erros.push(`"${nome}": 2º sobrenome fora da lista`);
  const termos = new Set(lista.bloqueio.termos.map(normalizar));
  for (const p of partes) {
    if (termos.has(normalizar(p))) erros.push(`"${nome}": contém termo bloqueado "${p}"`);
  }
  const completos = new Set(lista.bloqueio.nomes_completos.map(normalizar));
  if (completos.has(normalizar(nome))) erros.push(`"${nome}": nome completo bloqueado`);
  return erros;
}

/** Valida a lista e aborta com código ≠ 0 se houver erro. */
export function verificarNomes(): ListaNomes {
  const lista = carregarNomes();
  const erros = validarLista(lista);
  if (erros.length > 0) {
    throw new Error(`nomes-ficticios.json inválido:\n - ${erros.join('\n - ')}`);
  }
  return lista;
}
