/**
 * Documentos fictícios com DV válido para a massa de dados (#10994 · RN06, RN02b).
 *
 * Port 1:1 de `api/app/Support/Cadunico/SyntheticDocument.php` (`cpf()`, `nis()`, `mod11()`),
 * mais o CNPJ (módulo 11 da Receita). Nenhuma aleatoriedade: todo documento nasce de uma
 * BASE informada, e a base da massa é uma SEQUÊNCIA (`cpfBaseSequencial`).
 */

/** Prefixo reservado para a massa: todo CPF/NIS/CNPJ da massa começa com "98". */
export const PREFIXO_MASSA = '98';

function digitos(base: string, tamanho: number, rotulo: string): number[] {
  if (!new RegExp(`^\\d{${tamanho}}$`).test(base)) {
    throw new Error(`Base do ${rotulo} deve ter ${tamanho} dígitos: "${base}".`);
  }
  return base.split('').map(Number);
}

/** `SyntheticDocument::mod11()` — DV módulo 11 do CPF, pesos decrescentes. */
function mod11(nums: number[], pesos: number[]): number {
  let soma = 0;
  pesos.forEach((peso, i) => {
    soma += (nums[i] ?? 0) * peso;
  });
  const dv = (soma * 10) % 11;
  return dv === 10 ? 0 : dv;
}

function faixa(inicio: number, fim: number): number[] {
  const out: number[] = [];
  for (let v = inicio; v >= fim; v--) out.push(v);
  return out;
}

/** `SyntheticDocument::cpf()` — 9 dígitos → CPF de 11 dígitos com DV válido. */
export function cpf(base9: string): string {
  const nums = digitos(base9, 9, 'CPF');
  const d1 = mod11(nums, faixa(10, 2));
  nums.push(d1);
  const d2 = mod11(nums, faixa(11, 2));
  nums.push(d2);
  return nums.join('');
}

/** `SyntheticDocument::nis()` — 10 dígitos → NIS/PIS de 11 dígitos com DV válido. */
export function nis(base10: string): string {
  const nums = digitos(base10, 10, 'NIS');
  const pesos = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  nums.forEach((d, i) => {
    soma += d * (pesos[i] as number);
  });
  let dv = 11 - (soma % 11);
  if (dv === 10 || dv === 11) dv = 0;
  return `${base10}${dv}`;
}

/** CNPJ: 12 dígitos (raiz + ordem) → CNPJ de 14 dígitos com DV válido (módulo 11). */
export function cnpj(base12: string): string {
  const nums = digitos(base12, 12, 'CNPJ');
  const dv = (pesos: number[]): number => {
    let soma = 0;
    pesos.forEach((peso, i) => {
      soma += (nums[i] as number) * peso;
    });
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  nums.push(dv([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  nums.push(dv([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  return nums.join('');
}

/** O CPF tem 11 dígitos, não é repetição de um dígito e os 2 DV conferem. */
export function cpfValido(valor: string): boolean {
  if (!/^\d{11}$/.test(valor) || /^(\d)\1{10}$/.test(valor)) return false;
  return cpf(valor.slice(0, 9)) === valor;
}

/** O CNPJ tem 14 dígitos, não é repetição e os 2 DV conferem. */
export function cnpjValido(valor: string): boolean {
  if (!/^\d{14}$/.test(valor) || /^(\d)\1{13}$/.test(valor)) return false;
  return cnpj(valor.slice(0, 12)) === valor;
}

/**
 * Base de 9 dígitos da massa para a posição `n` (1-based) da sequência do elenco:
 * 1 → "980000001", 2 → "980000002"… Nunca sorteio (RN06).
 */
export function cpfBaseSequencial(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 9_999_999) {
    throw new Error(`Posição fora da faixa reservada: ${n}`);
  }
  return `${PREFIXO_MASSA}${String(n).padStart(7, '0')}`;
}

/** CPF completo (com DV) da posição `n` da sequência. */
export function cpfSequencial(n: number): string {
  return cpf(cpfBaseSequencial(n));
}

/**
 * Faixas proibidas (BR-011): bases usadas por outras massas e CPFs fixos de seeders/usuários
 * de teste. A massa usa só a base 98, mas a checagem é explícita para o teste provar.
 */
export const BASES_PROIBIDAS = ['10', '11', '12'];
export const FAIXA_PRONTUARIO_E2E: readonly [string, string] = ['99000000130', '99000001374'];

export function cpfEmFaixaProibida(valor: string, fixos: readonly string[] = []): boolean {
  if (BASES_PROIBIDAS.some((b) => valor.startsWith(b))) return true;
  if (valor >= FAIXA_PRONTUARIO_E2E[0] && valor <= FAIXA_PRONTUARIO_E2E[1]) return true;
  return fixos.includes(valor);
}
