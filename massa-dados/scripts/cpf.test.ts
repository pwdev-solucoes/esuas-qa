/**
 * UNIT-001 (AC-002) e parte do AC-011 — DV de CPF/NIS/CNPJ iguais ao `SyntheticDocument`.
 *
 * Os vetores de CPF/NIS foram obtidos executando o PRÓPRIO
 * `api/app/Support/Cadunico/SyntheticDocument.php` via `php -r` em 2026-09-29
 * (sem Laravel: a classe é pura). Os CNPJ usam o algoritmo público da Receita.
 */
import { expect, test } from '@playwright/test';
import {
  cnpj,
  cnpjValido,
  cpf,
  cpfBaseSequencial,
  cpfEmFaixaProibida,
  cpfSequencial,
  cpfValido,
  nis,
} from './lib/cpf.ts';

// base9 → saída de SyntheticDocument::cpf(base9)
const VETORES_CPF: Array<[string, string]> = [
  ['980000001', '98000000113'],
  ['980000002', '98000000202'],
  ['980000010', '98000001004'],
  ['980000123', '98000012391'],
  ['100000001', '10000000108'],
  ['123456789', '12345678909'],
  ['111444777', '11144477735'],
];

// base10 → saída de SyntheticDocument::nis(base10)
const VETORES_NIS: Array<[string, string]> = [
  ['9800000001', '98000000010'],
  ['9800000002', '98000000028'],
  ['1200000001', '12000000012'],
  ['1234567890', '12345678900'],
];

test.describe('lib/cpf — port do SyntheticDocument', () => {
  test('cpf() produz os mesmos DV do SyntheticDocument::cpf()', () => {
    for (const [base, esperado] of VETORES_CPF) {
      expect(cpf(base), base).toBe(esperado);
    }
  });

  test('nis() produz os mesmos DV do SyntheticDocument::nis()', () => {
    for (const [base, esperado] of VETORES_NIS) {
      expect(nis(base), base).toBe(esperado);
    }
  });

  test('base inválida é recusada como no PHP', () => {
    expect(() => cpf('12345678')).toThrow();
    expect(() => nis('123')).toThrow();
  });

  test('sequência 98: base = "98" + 7 dígitos, em ordem, nunca sorteio', () => {
    expect(cpfBaseSequencial(1)).toBe('980000001');
    expect(cpfBaseSequencial(2)).toBe('980000002');
    expect(cpfBaseSequencial(215)).toBe('980000215');
    expect(cpfSequencial(1)).toBe('98000000113');
    for (let n = 1; n <= 300; n++) {
      const valor = cpfSequencial(n);
      expect(valor.startsWith('98')).toBe(true);
      expect(cpfValido(valor)).toBe(true);
      expect(cpfEmFaixaProibida(valor)).toBe(false);
    }
  });

  test('cpfValido() rejeita DV errado e repetições', () => {
    expect(cpfValido('98000000113')).toBe(true);
    expect(cpfValido('98000000114')).toBe(false);
    expect(cpfValido('11111111111')).toBe(false);
  });

  test('faixas proibidas (BR-011) são reconhecidas', () => {
    expect(cpfEmFaixaProibida('10000000108')).toBe(true);
    expect(cpfEmFaixaProibida('11144477735')).toBe(true);
    expect(cpfEmFaixaProibida('12345678909')).toBe(true);
    expect(cpfEmFaixaProibida('99000000130')).toBe(true);
    expect(cpfEmFaixaProibida('99000001374')).toBe(true);
    expect(cpfEmFaixaProibida('99000001375')).toBe(false);
    expect(cpfEmFaixaProibida('44983702016', ['44983702016'])).toBe(true);
  });
});

test.describe('lib/cpf — CNPJ (RN02b)', () => {
  test('cnpj() calcula DV válidos para CNPJ públicos de referência', () => {
    // CNPJ de exemplo amplamente usado em documentação (Receita/validadores).
    expect(cnpj('112223330001')).toBe('11222333000181');
    expect(cnpjValido('11222333000181')).toBe(true);
    expect(cnpjValido('11222333000182')).toBe(false);
  });

  test('CNPJ da massa na base 98.000.000 com DV', () => {
    const org = cnpj('980000000001');
    expect(org.startsWith('98000000')).toBe(true);
    expect(cnpjValido(org)).toBe(true);
  });
});
