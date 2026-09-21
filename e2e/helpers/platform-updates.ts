import type { Page } from '@playwright/test';

/**
 * Dispensa o modal "Novidades da versão" (platform updates), que abre alguns
 * segundos DEPOIS da navegação, em qualquer tela do admin ou do client.
 *
 * Por que isto existe: o modal é um dialog do Reka UI, e enquanto ele está
 * aberto o conteúdo de fundo recebe `aria-hidden`. Consultas pela árvore de
 * acessibilidade — `getByRole('main')`, `getByRole('table')`, qualquer
 * `getByRole` do conteúdo — deixam de encontrar o elemento, embora ele siga
 * no DOM. O `LookupCrudPage.goto()` assevera exatamente `getByRole('main')`.
 *
 * Os specs que passam hoje passam por CORRIDA: asseveram antes de o modal
 * abrir. Quem faz uma chamada de API antes de navegar (ou qualquer coisa que
 * gaste alguns segundos) perde a corrida e falha com "element(s) not found"
 * numa tela que, no navegador, está perfeita.
 *
 * "Confirmar leitura" grava em `platform_version_reads` e não reabre; é o
 * fechamento estável para uma suíte. Idempotente: sem modal, não faz nada.
 */
export async function dismissPlatformUpdates(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog').filter({ hasText: /novidades da vers|hist[óo]rico de vers/i }).first();

  // O modal abre alguns segundos APÓS a navegação: checar sem esperar não o
  // encontraria, e ele abriria no meio das asserções seguintes. A espera é
  // curta e só é paga de fato na primeira vez — "Confirmar leitura" grava em
  // `platform_version_reads` e o modal não reabre para o usuário.
  await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);

  if (!(await dialog.isVisible().catch(() => false))) return;

  const confirm = dialog.getByRole('button', { name: /confirmar leitura/i });
  const later = dialog.getByRole('button', { name: /^depois$/i });

  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  } else if (await later.isVisible().catch(() => false)) {
    await later.click();
  }

  await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}
