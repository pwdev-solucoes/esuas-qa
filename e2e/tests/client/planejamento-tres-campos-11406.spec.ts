import { expect, test, type Page } from "@playwright/test";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-09 (HU #11406) — CA02, CA04 e CA05 do planejamento em três campos.
 * Spec MANUAL (1 login: o do storageState do `chromium-tenant`, operador do
 * CRAS Centro); o E2E-044 cobre CA01 e CA03 e a ausência da ação ao não técnico.
 *
 * Massa: `E2EFollowUpPlanFieldsSeeder` (api). Este spec ALTERA f02 (registra) e
 * f03 (corrige as Ações); rode o seeder de novo para repetir. O f04 (legado) é
 * aberto no Sheet de correção e fechado SEM salvar: a massa continua legado.
 *
 * "Outubro" é a data fixa da massa (05/10/2026); "novembro" é a data da execução.
 * Asserções pelos uuids fixos e pelo texto marcado da execução, nunca por contagem.
 * Sem CPF nem texto de planejamento em log.
 */

const EVIDENCE_SLUG = "11406-planejamento-tres-campos";
const RUN = `E2E11406-${Date.now()}`;

const FAMILY_ONE_FIELD = "00000000-0000-4000-8000-000011406004";
const FOLLOW_UP_ONE_FIELD = "00000000-0000-4000-8000-000011406f02";
const FAMILY_OCTOBER = "00000000-0000-4000-8000-000011406002";
const FOLLOW_UP_OCTOBER = "00000000-0000-4000-8000-000011406f03";
const FAMILY_LEGACY = "00000000-0000-4000-8000-000011406003";
const FOLLOW_UP_LEGACY = "00000000-0000-4000-8000-000011406f04";

async function openFollowUp(
  page: Page,
  familyUuid: string,
  followUpUuid: string,
): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=acompanhamento`);
  await dismissPlatformUpdates(page);

  const section = page.getByTestId(`follow-up-plan-${followUpUuid}`);
  if (!(await section.isVisible().catch(() => false))) {
    const expand = page.getByTestId(`follow-up-expand-${followUpUuid}`);
    await expect(expand).toBeVisible();
    await expand.click();
  }
  await expect(section).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("CA02 — registrar só Objetivos mostra só esse campo no card", async ({
  page,
}, testInfo) => {
  await openFollowUp(page, FAMILY_ONE_FIELD, FOLLOW_UP_ONE_FIELD);
  await page
    .getByTestId(`follow-up-plan-action-${FOLLOW_UP_ONE_FIELD}`)
    .click();

  const sheet = page.getByTestId("follow-up-plan-form-sheet");
  await expect(sheet).toBeVisible();
  await page
    .getByTestId("follow-up-plan-objectives")
    .fill(`${RUN} objetivos registrados pelo teste`);

  const saved = page.waitForResponse(
    (res) =>
      /\/follow-ups\/.+\/plan/.test(res.url()) &&
      ["PUT", "POST"].includes(res.request().method()),
  );
  await page.getByTestId("follow-up-plan-submit").click();
  expect([200, 201], "registro do planejamento").toContain(
    (await saved).status(),
  );
  await expect(sheet).toBeHidden();

  await expect(
    page.getByTestId(`follow-up-plan-objectives-text-${FOLLOW_UP_ONE_FIELD}`),
  ).toContainText(RUN);
  await expect(
    page.getByTestId(`follow-up-plan-actions-text-${FOLLOW_UP_ONE_FIELD}`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`follow-up-plan-strategies-text-${FOLLOW_UP_ONE_FIELD}`),
  ).toHaveCount(0);
  await captureEvidence(page, testInfo, EVIDENCE_SLUG, "um-campo");
});

test("CA04 — corrigir as Ações guarda a versão de outubro e mostra quem corrigiu", async ({
  page,
}, testInfo) => {
  await openFollowUp(page, FAMILY_OCTOBER, FOLLOW_UP_OCTOBER);
  await expect(
    page.getByTestId(`follow-up-plan-revisions-${FOLLOW_UP_OCTOBER}`),
  ).toHaveCount(0);

  await page.getByTestId(`follow-up-plan-action-${FOLLOW_UP_OCTOBER}`).click();
  const sheet = page.getByTestId("follow-up-plan-form-sheet");
  await expect(sheet).toBeVisible();
  await expect(
    page.getByTestId("follow-up-plan-revision-notice"),
  ).toBeVisible();
  await page
    .getByTestId("follow-up-plan-actions")
    .fill(`${RUN} ações corrigidas pelo teste`);

  const saved = page.waitForResponse(
    (res) =>
      /\/follow-ups\/.+\/plan/.test(res.url()) &&
      ["PUT", "POST"].includes(res.request().method()),
  );
  await page.getByTestId("follow-up-plan-submit").click();
  expect([200, 201], "correção do planejamento").toContain(
    (await saved).status(),
  );
  await expect(sheet).toBeHidden();

  await expect(
    page.getByTestId(`follow-up-plan-actions-text-${FOLLOW_UP_OCTOBER}`),
  ).toContainText(RUN);
  await expect(
    page.getByTestId(`follow-up-plan-revised-${FOLLOW_UP_OCTOBER}`),
  ).toContainText(/Corrigido por/);

  const toggle = page.getByTestId(
    `follow-up-plan-revisions-${FOLLOW_UP_OCTOBER}`,
  );
  await expect(toggle).toContainText("Versões anteriores (1)");
  await toggle.click();

  const dialog = page.getByTestId("revision-history-dialog");
  await expect(dialog).toBeVisible();
  const item = dialog.getByTestId("revision-history-item").first();
  await expect(item).toBeVisible();
  await expect(item).toContainText("05/10/2026");
  await expect(item.getByTestId("revision-history-objectives")).toContainText(
    "Fortalecer vínculos familiares",
  );
  await expect(item.getByTestId("revision-history-actions")).toContainText(
    "Visitas domiciliares quinzenais",
  );
  await expect(item.getByTestId("revision-history-strategies")).toContainText(
    "Articulação com a rede",
  );
  await expect(item.getByTestId("revision-history-author")).toBeVisible();
  await expect(item.getByTestId("revision-history-superseded")).toBeVisible();
  await captureEvidence(page, testInfo, EVIDENCE_SLUG, "versao-de-outubro");
});

test("CA05 — planejamento antigo aparece inteiro e a correção abre com os três campos vazios", async ({
  page,
}, testInfo) => {
  await openFollowUp(page, FAMILY_LEGACY, FOLLOW_UP_LEGACY);

  const legacy = page.getByTestId(
    `follow-up-plan-legacy-text-${FOLLOW_UP_LEGACY}`,
  );
  await expect(legacy).toContainText("Planejamento antigo em texto livre");
  await expect(legacy).toContainText("Segundo parágrafo");
  await expect(legacy).toContainText("Terceiro parágrafo");
  await expect(
    page
      .getByTestId(`follow-up-plan-body`)
      .getByText("Planejamento registrado antes da divisão em campos"),
  ).toBeVisible();
  await captureEvidence(page, testInfo, EVIDENCE_SLUG, "planejamento-antigo");

  await page.getByTestId(`follow-up-plan-action-${FOLLOW_UP_LEGACY}`).click();
  const sheet = page.getByTestId("follow-up-plan-form-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("follow-up-plan-legacy")).toContainText(
    "Terceiro parágrafo",
  );
  for (const key of ["objectives", "actions", "strategies"]) {
    await expect(page.getByTestId(`follow-up-plan-${key}`)).toHaveValue("");
  }
  await captureEvidence(page, testInfo, EVIDENCE_SLUG, "corrigir-legado");

  // Fecha SEM salvar: a massa continua legado.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(legacy).toBeVisible();
});
