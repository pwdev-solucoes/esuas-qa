/**
 * Gera um CPF válido (apenas dígitos, sem máscara).
 *
 * Útil para criar usuários únicos por worker E2E sem colidir com seeds.
 * O algoritmo segue a regra de verificação oficial da Receita Federal.
 */
export function generateCpf(): string {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));

  const d1 = calcDigit([...base], 10);
  const d2 = calcDigit([...base, d1], 11);

  return [...base, d1, d2].join('');
}

/**
 * Aplica máscara visual (000.000.000-00) — útil para preencher inputs.
 */
export function maskCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, '').padStart(11, '0').slice(0, 11);

  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

function calcDigit(digits: number[], factor: number): number {
  let sum = 0;
  for (const digit of digits) {
    sum += digit * factor--;
  }
  const remainder = (sum * 10) % 11;

  return remainder === 10 ? 0 : remainder;
}
