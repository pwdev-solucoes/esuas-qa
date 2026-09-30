/**
 * UNIT do comparador de execuções (#10994 · plano 06): UNIT-004 idêntico (ignora uuid/id/timestamps
 * e ordem), UNIT-005 divergências `{caminho, chave, a, b}` com saída ≠ 0.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { compararSnapshots, executarComparacao } from './comparar.ts';

function snapshot(o: { uuid?: string; id?: number; total?: number; nome?: string; semFamilia?: boolean; pendencia?: number; reverso?: boolean } = {}) {
  const familias = [
    { chave: 'FAM_F-ENC', uuid: o.uuid ?? 'aaa', unidade: 'UNIT_U-CN', referenciada_em: '2026-05-10', integrantes: 3, created_at: '2026-09-30T10:00:00Z' },
    ...(o.semFamilia ? [] : [{ chave: 'FAM_F-DUPLA', id: o.id ?? 1, unidade: 'UNIT_U-CN', referenciada_em: '2026-06-01', integrantes: 4, updated_at: 'x' }]),
  ];
  return {
    formato: 1,
    meta: { execucao: o.uuid ?? 'exec-1', gerado_em: new Date().toISOString() },
    elenco: '2026-09-29.1',
    organizacao: { nome: o.nome ?? 'Município Demonstração SigSUAS', cnpj: '98000000000196', tenant_id: o.id ?? 3 },
    tabelas: {
      familias: o.reverso ? [...familias].reverse() : familias,
      registros_attendance: [{ chave: 'REG_ATD-2026-06-0001', data: '2026-06-02', unidade: 'UNIT_U-CS', social_unit_id: o.id ?? 7, deleted_at: null }],
    },
    apuracao: { '2026-07|U-CN|total_attendances': o.total ?? 20, '2026-07|U-CN|new_families': 5 },
    pendencias: [{ mes: '2026-07', kind: 'family_pending_specificity', scope: 'unit', unidade: 'U-CN', count: o.pendencia ?? 2 }],
  };
}

function gravar(pasta: string, conteudo: unknown): string {
  mkdirSync(pasta, { recursive: true });
  writeFileSync(join(pasta, 'snapshot.json'), JSON.stringify(conteudo));
  return pasta;
}

test.describe('UNIT-004 — execuções idênticas', () => {
  test('uuid, id, *_id, timestamps, meta e ordem diferentes → idêntico', () => {
    expect(compararSnapshots(snapshot(), snapshot({ uuid: 'bbb', id: 99, reverso: true }))).toEqual([]);
  });

  test('CLI sai 0 e atualiza o índice da execução B', () => {
    const base = mkdtempSync(join(tmpdir(), 'massa-comparar-'));
    const a = gravar(join(base, 'A'), snapshot());
    const b = gravar(join(base, 'B'), snapshot({ uuid: 'ccc', id: 5 }));
    writeFileSync(join(b, 'index.html'), '<section><!--determinismo-->aguarda<!--/determinismo--></section>');
    const log: string[] = [];
    expect(executarComparacao([a, b], (l) => log.push(l))).toBe(0);
    expect(log.join('\n')).toContain('idênticas');
    expect(readFileSync(join(b, 'index.html'), 'utf8')).toContain('IDÊNTICO');
    expect(JSON.parse(readFileSync(join(b, 'determinismo.json'), 'utf8')).identico).toBe(true);
  });
});

test.describe('UNIT-005 — divergências listadas por chave de negócio', () => {
  test('registro diferente, registro ausente, contador e pendência diferentes', () => {
    const ds = compararSnapshots(snapshot(), snapshot({ total: 21, semFamilia: true, pendencia: 3, nome: 'Outro nome' }));
    expect(ds).toEqual(
      expect.arrayContaining([
        { caminho: 'apuracao', chave: '2026-07|U-CN|total_attendances', a: 20, b: 21 },
        expect.objectContaining({ caminho: 'tabelas.familias', chave: 'FAM_F-DUPLA', b: null }),
        expect.objectContaining({ caminho: 'pendencias.count', chave: '2026-07|family_pending_specificity|unit|U-CN', a: 2, b: 3 }),
        { caminho: 'organizacao', chave: 'nome', a: 'Município Demonstração SigSUAS', b: 'Outro nome' },
      ]),
    );
    expect(ds).toHaveLength(4);
  });

  test('CLI sai 1 com a lista; 2 sem argumentos ou sem snapshot', () => {
    const base = mkdtempSync(join(tmpdir(), 'massa-comparar-'));
    const a = gravar(join(base, 'A'), snapshot());
    const b = gravar(join(base, 'B'), snapshot({ total: 7 }));
    const log: string[] = [];
    expect(executarComparacao([a, b], (l) => log.push(l))).toBe(1);
    expect(log.join('\n')).toContain('apuracao · 2026-07|U-CN|total_attendances: A=20 · B=7');
    expect(executarComparacao([a], () => undefined)).toBe(2);
    mkdirSync(join(base, 'vazia'));
    expect(executarComparacao([a, join(base, 'vazia')], () => undefined)).toBe(2);
  });
});
