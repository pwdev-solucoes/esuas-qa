/**
 * Gera um CNPJ numérico válido (14 dígitos, sem máscara; filial 0001).
 *
 * Os dígitos verificadores seguem o algoritmo oficial (módulo 11). Cada chamada
 * devolve um CNPJ novo — não colide com o de organizações já cadastradas.
 */
export function generateCnpj(): string {
  const base = [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1];
  const d1 = calcDigit(base);
  const d2 = calcDigit([...base, d1]);

  return [...base, d1, d2].join('');
}

function calcDigit(digits: number[]): number {
  const weights = digits.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = digits.reduce((total, digit, index) => total + digit * weights[index], 0) % 11;

  return sum < 2 ? 0 : 11 - sum;
}
