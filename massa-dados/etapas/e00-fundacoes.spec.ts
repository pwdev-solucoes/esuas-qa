/**
 * E0 — Fundações (#10994 · RN-T1, RN-T3, BR-004, BR-005).
 * Aviso, trava dupla, reset e DNE são executados pelo CLI (Node puro, antes do Playwright); esta
 * etapa confere que tudo aconteceu na ordem certa e registra os metadados (sem segredos).
 */
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { AMBIENTES_PERMITIDOS } from '../lib/ambiente.ts';
import { lerEstado, RegistroEtapa, registrarEtapa } from '../lib/execucao.ts';

test.describe.serial('E0 — Fundações', () => {
  test('trava dupla, confirmação, reset e DNE executados pelo CLI', () => {
    const { caminho, estado } = lerEstado();
    const registro = new RegistroEtapa('E0');
    try {
      const [primeira, segunda] = estado.ambiente;
      expect(primeira?.momento).toBe('preflight');
      expect(segunda?.momento, 'faltou a 2ª checagem de /api/environment antes do reset').toBe('antes_do_reset');
      for (const c of [primeira, segunda]) {
        expect(c.ok).toBe(true);
        expect(AMBIENTES_PERMITIDOS as readonly string[]).toContain(c.environment);
        registro.passo({ checagem: c.momento, environment: c.environment, em: c.em });
      }
      expect(['flag', 'digitado']).toContain(estado.confirmacao);
      registro.passo({ confirmacao: estado.confirmacao });

      const passos = estado.reset ?? [];
      expect(passos.map((p) => p.nome).slice(0, 2)).toEqual(['reset', 'queue:restart']);
      for (const p of passos) {
        expect(p.codigo, `${p.nome} terminou com código ${p.codigo}`).toBe(0);
        registro.passo({ passo: p.nome, codigo: p.codigo, duracaoMs: p.duracaoMs, resumo: p.resumo });
      }
      if (!passos.some((p) => p.nome === 'cache:clear')) registro.aviso('MASSA_CACHE_CLEAR_CMD não definido: cache de rate-limit não foi limpo.');

      expect(estado.dne, 'o CLI não registrou o DNE').toBeDefined();
      expect(estado.dne?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(estado.dne?.arquivo ?? '')).toBe(true);
      registro.passo({ dne: { url: estado.dne?.url, bytes: estado.dne?.bytes, sha256: estado.dne?.sha256, doCache: estado.dne?.doCache } });
      registrarEtapa(caminho, registro.concluir('ok'));
    } catch (erro) {
      registrarEtapa(caminho, registro.concluir('falha'));
      throw erro;
    }
  });
});
