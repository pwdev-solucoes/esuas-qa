import type { Page, TestInfo } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Captura de EVIDÊNCIA de aceite a partir dos specs que já passam.
 *
 * Por que existe: o dossiê HTML/PDF de aceite (skill `acceptance-evidence-report`)
 * era montado dirigindo o app à mão com o `playwright-cli`. Print tirado à mão é
 * print de uma tela que ninguém asseverou — prova que a tela existiu, não que o
 * critério passou. Aqui a imagem sai do MESMO caso que verifica o critério: se a
 * asserção cai, não há imagem; se há imagem, o caso passou.
 *
 * **Desligado por padrão.** Sem `CAPTURE_EVIDENCE=1` no ambiente, toda função
 * abaixo retorna na primeira linha: nenhuma navegação, nenhuma espera, nenhum
 * arquivo escrito — o comportamento da suíte é o de antes.
 *
 * Uso:
 * ```ts
 * const EVIDENCE_SLUG = 'US-CAPAC-01-tipos-acao';
 *
 * test.afterEach(async ({ page }, testInfo) => {
 *   await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
 * });
 *
 * // …e, dentro de um caso, no instante que importa:
 * await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'dialogo-recusa');
 * ```
 */

/** Liga/desliga tudo. Qualquer valor diferente de `'1'` mantém a suíte intacta. */
export function evidenceEnabled(): boolean {
  return process.env.CAPTURE_EVIDENCE === '1';
}

/** `e2e/reports/<slug>-acceptance/screenshots/` (criado sob demanda). */
export function evidenceDir(slug: string): string {
  return path.resolve(__dirname, '..', 'reports', `${slug}-acceptance`, 'screenshots');
}

/**
 * Identificadores de critério citados no título do caso.
 *
 * Os títulos da suíte do épico começam pelos critérios que o caso cobre —
 * `"CA01 — …"`, `"CA02/CA03/CA04 — …"`, `"RN03/D09 — …"`. Quando o caso cobre
 * mais de um, **gera-se um arquivo por critério citado** (a mesma imagem,
 * nomeada para cada um): assim o dossiê referencia cada CA pelo seu próprio
 * arquivo, sem que o leitor precise saber que dois critérios dividem um print.
 */
export function criteriaFromTitle(title: string): string[] {
  const head = title.split('—')[0] ?? title;
  const ids = head.match(/\b(?:CA|RN|D)\d{2}\b/gi) ?? [];

  return [...new Set(ids.map((id) => id.toUpperCase()))];
}

/** `"CA01 — os cinco tipos do leiaute…"` → `"os-cinco-tipos-do-leiaute"`. */
export function slugifyTitle(title: string): string {
  const tail = title.includes('—') ? title.slice(title.indexOf('—') + 1) : title;

  return tail
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * Salva o print da página em `reports/<slug>-acceptance/screenshots/`, um
 * arquivo por critério citado no título. Devolve os caminhos **relativos ao
 * `output_dir`** do dossiê — é o formato que o `manifest.json` consome.
 *
 * `suffix` distingue o instante capturado dentro de um mesmo caso
 * (`ca06-…-dialogo-recusa.png` ao lado de `ca06-….png`).
 */
export async function captureEvidence(
  page: Page,
  testInfo: TestInfo,
  slug: string,
  suffix?: string,
  options?: { viewport?: { width: number; height: number } },
): Promise<string[]> {
  if (!evidenceEnabled()) return [];

  const dir = evidenceDir(slug);
  await fs.promises.mkdir(dir, { recursive: true });

  const criteria = criteriaFromTitle(testInfo.title);
  const base = slugifyTitle(testInfo.title);
  const tail = suffix ? `-${suffix}` : '';

  // Janela maior SÓ para a foto: a matriz da apuração tem cinco colunas de
  // leiaute e, em 1280×720, a quinta e as linhas de baixo ficam fora do print —
  // evidência cortada é evidência pela metade. O tamanho original é restaurado
  // logo em seguida, para que nada depois da foto veja outra viewport.
  const original = page.viewportSize();
  if (options?.viewport) {
    await page.setViewportSize(options.viewport);
    // O relayout do Vue acontece no tick seguinte ao resize.
    await page.waitForTimeout(400);
  }

  // Um único `screenshot()`; os demais critérios do mesmo título reaproveitam o
  // buffer — capturar N vezes daria N telas ligeiramente diferentes para o que é
  // um só instante.
  const buffer = await page.screenshot({ fullPage: true });

  if (options?.viewport && original) {
    await page.setViewportSize(original);
  }
  const written: string[] = [];

  for (const id of criteria.length > 0 ? criteria : ['sem-criterio']) {
    const file = `${id.toLowerCase()}-${base}${tail}.png`;
    await fs.promises.writeFile(path.join(dir, file), buffer);
    written.push(`screenshots/${file}`);
  }

  return written;
}

/**
 * Print do estado FINAL do caso, para o `afterEach`.
 *
 * Só fotografa caso **aprovado**: um caso que falhou ou foi pulado não tem
 * evidência a apresentar, e o print de uma falha dentro de um dossiê de aceite
 * contaria a história errada (o Playwright já guarda esse print em
 * `test-results/`, que é onde ele pertence).
 */
export async function captureFinalEvidence(
  page: Page,
  testInfo: TestInfo,
  slug: string,
): Promise<void> {
  if (!evidenceEnabled()) return;
  if (testInfo.status !== 'passed') return;
  if (page.isClosed()) return;

  // A evidência é subproduto: um print que não sai não pode reprovar um critério
  // que passou.
  await captureEvidence(page, testInfo, slug, undefined, {
    viewport: { width: 1680, height: 1200 },
  }).catch(() => undefined);
}
