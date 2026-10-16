import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { createTenantApiClient } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence } from '../../helpers/evidence';

/**
 * US-DIAG2-06 (HU #11235) — escolaridade pela série do instrumento, no frontend
 * do TENANT (`client/`). Spec MANUAL. O cenário declarativo E2E-021 cobre o CA01
 * (série 23 → "Ensino médio", somente leitura e gravado) e o CA03 (série 31 +
 * Mestrado → "Mestrado"). Aqui ficam:
 *
 *  - CA02: série 15 + "Alfabetizado: Sim" → "Alfabetizado" (sem a alfabetização,
 *    "Depende da alfabetização");
 *  - CA04: com a sugestão do CadÚnico ("Ensino médio") em Pedro, a série 19 passa
 *    o nível para "Fundamental" e a sugestão deixa de ser oferecida (dois prints);
 *  - CA05: o nível "Ensino médio" da F6 (Caio) aparece como "Nível registrado sem
 *    série", com a série "Não informada";
 *  - CA06: série 99 → "Sem correspondência — ficará pendente na conferência". A
 *    contagem em `missing_fields.Escolaridade` é provada no Pest
 *    (`SchoolGradeCompletenessTest`).
 *
 * ## Massa (E2ESchoolGradeSeeder, api)
 * Família …000001123501 "E2E Lima Escolaridade" no CRAS Centro: Ana (sem dado),
 * Pedro (grau '5' do CadÚnico → sugestão) e Caio (retrato migrado, nível '4'
 * `manual`, sem série).
 *
 * ## Reinício
 * No `beforeAll`, a spec registra pela API (mesma rota do drawer) um retrato de
 * reinício com `taken_on` = hoje: Ana e Pedro com tudo `null`; Caio com o nível já
 * gravado (aceito pelo D06(b)). Nada é apagado; a série de retratos só cresce, por
 * isso nenhuma asserção conta retratos. Sessão herdada do `chromium-tenant`.
 * Nenhuma credencial, CPF ou nome real é gravado aqui.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY = process.env.E2E_CLIENT_FAMILY_SCHOOL_UUID ?? '00000000-0000-4000-8000-000001123501';
const M1 = '00000000-0000-4000-8000-000001123511';
const M2 = '00000000-0000-4000-8000-000001123512';
const M3 = '00000000-0000-4000-8000-000001123513';
const UNIT_UUID = process.env.E2E_CLIENT_UNIT_UUID ?? '00000000-0000-4000-8000-0000000e0001';
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';
const EVIDENCE_SLUG = '11235-escolaridade-pela-serie';

let api: APIRequestContext;

test.use({ baseURL: BASE, locale: 'pt-BR', viewport: { width: 1440, height: 1600 } });
test.describe.configure({ mode: 'serial' });

function conditionsUrl(member: string): string {
  const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
  return `${apiBase}/api/client/families/${FAMILY}/members/${member}/conditions`;
}

async function xsrfHeaders(): Promise<Record<string, string>> {
  const state = await api.storageState();
  const token = decodeURIComponent(
    state.cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value ?? '',
  );
  expect(token, 'XSRF-TOKEN da sessão do operador').not.toBe('');

  return { 'X-XSRF-TOKEN': token, 'X-Tenant-UUID': TENANT_UUID };
}

test.beforeAll(async () => {
  if (!BASE) return;
  api = await createTenantApiClient();
  const headers = await xsrfHeaders();
  const today = new Date().toISOString().slice(0, 10);

  // Nível já gravado do Caio (F6) — preservado pelo D06(b).
  const current = await api.get(conditionsUrl(M3), { headers });
  expect(current.status(), 'GET das condições do Caio').toBe(200);
  const body = await current.json();
  const root = body.data ?? body;
  const level = root.blocks?.education_conditions?.values?.schooling_level?.uuid ?? null;
  expect(level, 'nível da F6 do Caio').not.toBeNull();

  const blank = {
    is_literate: null,
    school_grade_uuid: null,
    academic_title_uuid: null,
    schooling_level_uuid: null,
    school_situation_uuid: null,
  };
  const reset: Array<[string, Record<string, unknown>]> = [
    [M1, blank],
    [M2, blank],
    [M3, { ...blank, schooling_level_uuid: level }],
  ];

  for (const [member, education] of reset) {
    const res = await api.put(conditionsUrl(member), {
      headers,
      data: {
        mode: 'update',
        taken_on: today,
        social_unit_uuid: UNIT_UUID,
        education_conditions: education,
      },
    });
    const text = await res.text();
    // 422 `conditions_unchanged`: o integrante já está no estado de reinício.
    const unchanged = res.status() === 422 && text.includes('conditions_unchanged');
    expect(res.status() === 200 || unchanged, `retrato de reinício de ${member}: ${text}`).toBe(true);
  }
});

test.afterAll(async () => {
  await api?.dispose();
});

async function openDrawer(page: Page, name: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=composicao`);
  await dismissPlatformUpdates(page);
  const button = page.locator(
    `tr[data-testid^="member-row-"]:has-text("${name}") [data-testid^="member-conditions-"]`,
  );
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  await expect(page.getByTestId('member-conditions-drawer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('member-school-grade')).toBeVisible({ timeout: 15_000 });
}

async function pickGrade(page: Page, name: RegExp): Promise<void> {
  await page.getByTestId('member-school-grade').click();
  await page.getByRole('option', { name }).first().click();
}

test.describe('US-DIAG2-06 — escolaridade pela série (client)', () => {
  test.skip(!BASE, 'Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.');

  test('CA02 — a série 15 depende da alfabetização: com "Sim", o nível é Alfabetizado', async ({
    page,
  }, testInfo) => {
    await openDrawer(page, 'Lima Ana');
    await pickGrade(page, /5º ano do ensino fundamental/);

    const level = page.getByTestId('member-derived-level');
    await expect(page.getByTestId('member-derived-level-depends')).toBeVisible();

    await page.getByTestId('member-is-literate-yes').click();
    await expect(level).toContainText('Alfabetizado');
    await expect(level.locator('input, select, textarea')).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'alfabetizado');
  });

  test('CA06 — a série 99 não tem correspondência: o nível fica pendente na conferência', async ({
    page,
  }, testInfo) => {
    await openDrawer(page, 'Lima Ana');
    await pickGrade(page, /Outros/);

    await expect(page.getByTestId('member-derived-level-no-match')).toContainText(
      'Sem correspondência — ficará pendente na conferência',
    );
    await expect(page.getByTestId('member-derived-level-name')).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'sem-correspondencia');
  });

  test('CA04 — a série prevalece sobre a sugestão do CadÚnico: Fundamental no lugar de Ensino médio', async ({
    page,
  }, testInfo) => {
    await openDrawer(page, 'Lima Pedro');

    const suggestion = page.getByTestId('member-schooling-suggestion');
    await expect(suggestion).toContainText('Ensino médio');
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'antes-sugestao');

    await pickGrade(page, /9º ano do ensino fundamental/);
    await expect(page.getByTestId('member-derived-level')).toContainText('Fundamental');

    await page.getByTestId('member-conditions-save').click();
    await page.getByTestId('snapshot-kind-update').click();
    await page.getByTestId('member-conditions-unit').click();
    await page.getByRole('option', { name: UNIT_NAME }).click();
    const saved = page.waitForResponse(
      (res) => res.url().includes('/conditions') && res.request().method() === 'PUT',
    );
    await page.getByTestId('member-conditions-confirm-update').click();
    expect((await saved).status(), 'PUT das condições do Pedro').toBe(200);

    await expect(page.getByTestId('member-schooling-source')).toContainText(
      'Derivada da série informada',
    );
    await expect(page.getByTestId('member-derived-level-name')).toHaveText('Fundamental');
    await expect(suggestion).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'depois-serie');
  });

  test('CA05 — o nível da F6 é preservado: "Nível registrado sem série" e série não informada', async ({
    page,
  }, testInfo) => {
    await openDrawer(page, 'Lima Caio');

    await expect(page.getByTestId('member-level-without-grade')).toContainText(
      'Nível registrado sem série: Ensino médio',
    );
    await expect(page.getByTestId('member-school-grade')).toContainText('Não informada');
    await expect(page.getByTestId('member-derived-level')).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'nivel-f6');
  });
});
