/**
 * E00 — Preflight como etapa registrada (#10994 · RN-T2).
 * O preflight já rodou no CLI, antes de qualquer escrita; aqui só se confere e registra o resultado.
 * Rodar este project fora do `npm run massa` falha de propósito (sem estado da execução).
 */
import { expect, test } from '@playwright/test';
import { lerEstado, RegistroEtapa, registrarEtapa } from '../lib/execucao.ts';

test.describe.serial('E00 — Preflight', () => {
  test('preflight APTO registrado pelo CLI antes do aviso e do reset', () => {
    const { caminho, estado } = lerEstado();
    const registro = new RegistroEtapa('E00');
    try {
      expect(estado.preflight, 'o CLI não registrou o preflight').toBeDefined();
      expect(estado.preflight?.apto).toBe(true);
      expect(estado.preflight?.falhas).toBe(0);
      const primeira = estado.ambiente.find((a) => a.momento === 'preflight');
      expect(primeira?.ok).toBe(true);
      for (const item of estado.preflight?.itens ?? []) {
        registro.passo({ familia: item.familia, nome: item.nome, status: item.status, mensagem: item.mensagem });
        if (item.status === 'aviso') registro.aviso(`${item.nome}: ${item.mensagem}`);
      }
      registro.passo({ ambiente: primeira?.environment, momento: 'preflight' });
      registrarEtapa(caminho, registro.concluir('ok'));
    } catch (erro) {
      registrarEtapa(caminho, registro.concluir('falha'));
      throw erro;
    }
  });
});
