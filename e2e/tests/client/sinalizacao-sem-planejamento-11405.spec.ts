import { expect, test } from '@playwright/test';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence } from '../../helpers/evidence';

/**
 * US-AJ-08 (HU #11405) — CA04: registrar o planejamento tira a linha da
 * relação de acompanhamentos que pedem atenção. Spec MANUAL (1 login, o do
 * storageState do `chromium-tenant`); o E2E-043 cobre CA01–CA03.
 *
 * Massa: `E2EPlanMilestoneSeeder` (api). O acompanhamento
 * `…11405a04` é semeado sem planejamento a CADA rodada do seeder; este spec
 * o ALTERA (registra o planejamento), então rode o seeder de novo para repetir.
 *
 * A evidência do CA04 é a AUSÊNCIA da linha. Asserções pela linha (uuid fixo),
 * nunca por contagem. Sem CPF, nome ou texto de planejamento em log.
 */

const UNIT_UUID = process.env.E2E_CLIENT_UNIT_UUID ?? '00000000-0000-4000-8000-0000000e0001';
const TARGET = '00000000-0000-4000-8000-000011405a04';
const EVIDENCE_SLUG = '11405-sinalizacao-sem-planejamento';

test('CA04 — registrar o planejamento tira a linha da relação', async ({ page }, testInfo) => {
  const relation = `/app/cadastros/acompanhamentos-atencao?reason=without_plan&social_unit=${UNIT_UUID}`;
  const row = page.getByTestId(`follow-up-attention-row-${TARGET}`);

  await page.goto(relation);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId('follow-ups-attention-filters')).toBeVisible();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('attention-plan-milestone')).toHaveText(/Marco de 30 dias/);
  await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'CA04-antes-linha-presente');

  // Abre o prontuário pela linha, na aba Acompanhamento.
  await row.click();
  await expect(page).toHaveURL(/\/app\/cadastros\/familias\//);
  await dismissPlatformUpdates(page);

  const action = page.getByTestId(`follow-up-plan-action-${TARGET}`);
  if (!(await action.isVisible().catch(() => false))) {
    const expand = page.getByTestId(`follow-up-expand-${TARGET}`);
    await expect(expand).toBeVisible();
    await expand.click();
  }
  await expect(action).toBeVisible();
  await action.click();

  const sheet = page.getByTestId('follow-up-plan-form-sheet');
  await expect(sheet).toBeVisible();
  await page.getByTestId('follow-up-plan-content').fill(`E2E11405-${Date.now()} planejamento registrado pelo teste`);
  const saved = page.waitForResponse(
    (res) => /\/follow-ups\/.+\/plan/.test(res.url()) && ['PUT', 'POST'].includes(res.request().method()),
  );
  await page.getByTestId('follow-up-plan-submit').click();
  expect([200, 201], 'registro do planejamento').toContain((await saved).status());
  await expect(sheet).toBeHidden();

  // Volta à relação filtrada: a evidência é a ausência da linha.
  await page.goto(relation);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId('follow-ups-attention-filters')).toBeVisible();
  await expect(page.getByTestId(`follow-up-attention-row-${TARGET}`)).toHaveCount(0);
  await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'CA04-sai-com-planejamento');
});
