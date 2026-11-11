import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-16 (HU #11551) — evolução obrigatória e desligamento só pela unidade que acompanha.
 * Spec MANUAL de 3 logins (throttle `6,1`), ordem fixa e serial:
 *  1. técnico do CRAS Centro: CA05 (Desligar ausente no PAEFI, presente no PAIF), CA03 (família sem
 *     acompanhamento: o campo de evolução NÃO existe — a evidência é a ausência), CA04/CA04b
 *     (atividade coletiva sem e com evolução);
 *  2. técnico do E2E CREAS: CA07 (Desligar ausente no PAIF) + 403 `discharge_unit_not_conducting`
 *     pela API; com CAPTURE_EVIDENCE=1 também os prints de CA02, CA01 e CA06 (mesmo fluxo do E2E-057);
 *  3. Master sem lotação técnica: Desligar ausente (herdado da US-AJ-13 RN01; pendência P1 do PO).
 * O E2E-057 (CA01, CA02, CA06) roda SEPARADO, antes, com 65 s de intervalo.
 *
 * Massa: E2EEvolutionDischargeSeeder (api; fictícia). Repor antes de rodar:
 * `db:seed --class='Database\Seeders\E2EEvolutionDischargeSeeder'` + `cache:clear`.
 * Nunca imprime CPF, nome ou texto de atendimento/evolução em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const EVIDENCE_SLUG = "11551-evolucao-obrigatoria-desligamento";
const CAPTURING = process.env.CAPTURE_EVIDENCE === "1";

const FAMILY_PAEFI = "00000000-0000-4000-8000-000011551001";
const FAMILY_ACOMPANHADA = "00000000-0000-4000-8000-000011551002";
const FAMILY_SEM_A = "00000000-0000-4000-8000-000011551003";

const CRAS_UNIT = "E2E CRAS Centro";
const CREAS_UNIT = "E2E CREAS";

const OPERADOR = {
  cpf: process.env.E2E_CLIENT_OPERADOR_CPF ?? "",
  password: process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "",
};
const CREAS_OPERADOR = {
  cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "",
  password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "",
};
const MASTER = {
  cpf: process.env.E2E_CLIENT_MASTER_CPF ?? "",
  password: process.env.E2E_CLIENT_MASTER_PASSWORD ?? "",
};

async function login(page: Page, who: { cpf: string; password: string }) {
  await loginAsTenantUser(page, who.cpf, who.password, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(page);
}

async function openTab(page: Page, family: string, tab: string) {
  await page.goto(`/app/cadastros/familias/${family}?tab=${tab}`);
  await dismissPlatformUpdates(page);
}

/** Abre a aba Acompanhamento e espera as linhas (PAEFI + PAIF) carregarem. */
async function openFollowUps(page: Page) {
  await openTab(page, FAMILY_PAEFI, "acompanhamento");
  await expect(
    page.locator('[data-testid^="follow-up-card-"]').first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid^="follow-up-card-"]')).toHaveCount(2);
}

function card(page: Page, service: "PAEFI" | "PAIF") {
  return page
    .locator('[data-testid^="follow-up-card-"]')
    .filter({ hasText: service });
}

function dischargeButton(page: Page, service: "PAEFI" | "PAIF") {
  return card(page, service).locator(
    '[data-testid^="follow-up-discharge-"]:not([data-testid^="follow-up-discharge-info-"])',
  );
}

async function openAttendanceSheet(page: Page, family: string, unit: string) {
  await openTab(page, family, "atendimentos");
  await page.getByTestId("attendance-register-action").click();
  await page.waitForTimeout(1000);
  await page.getByTestId("attendance-form-unit").click();
  await page.getByRole("option", { name: unit }).click();
  await page.waitForTimeout(1500);
  await page.getByTestId("attendance-form-type").click();
  await page.locator('[role="option"]').first().click();
  await page
    .getByTestId("attendance-form-description")
    .fill("Atendimento fictício do E2E da HU 11551.");
  // HU #11403: a pessoa atendida é obrigatória (CRAS e CREAS).
  await page.locator('[data-testid^="attendance-person-"]').first().click();
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-16 #11551 — evolução obrigatória e desligamento pela unidade", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  let page: Page;

  test.afterAll(async () => {
    await page?.close();
  });

  // ── 1º login: técnico do CRAS Centro ───────────────────────────────────────
  test("CA05 — o técnico do CRAS não desliga o PAEFI do CREAS, mas desliga o PAIF do CRAS", async ({
    browser,
  }, testInfo) => {
    page = await browser.newPage({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1600 },
    });
    await login(page, OPERADOR);
    await openFollowUps(page);

    await expect(card(page, "PAEFI")).toHaveCount(1);
    await expect(card(page, "PAIF")).toHaveCount(1);
    await expect(dischargeButton(page, "PAEFI")).toHaveCount(0);
    await expect(dischargeButton(page, "PAIF")).toHaveCount(1);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA03 — família sem acompanhamento registra o atendimento sem o campo de evolução", async ({}, testInfo) => {
    await openAttendanceSheet(page, FAMILY_SEM_A, CRAS_UNIT);

    // A evidência é a AUSÊNCIA do campo (e do bloco obrigatório).
    await expect(page.getByTestId("attendance-form-submit")).toBeVisible();
    await expect(page.getByTestId("attendance-form-evolution")).toHaveCount(0);
    await expect(page.getByTestId("attendance-form-evolution-block")).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);

    await page.getByTestId("attendance-form-submit").click();
    await expect(page.getByTestId("attendance-form-submit")).toBeHidden({
      timeout: 15_000,
    });
  });

  test("CA04 — atividade coletiva sem evolução da família acompanhada é recusada, apontando a família", async ({}, testInfo) => {
    await page.goto("/app/atividades-coletivas/nova");
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("collective-activity-form")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("collective-activity-unit").click();
    await page.getByRole("option", { name: CRAS_UNIT }).click();
    await page.getByTestId("collective-activity-type").click();
    await page.locator('[role="option"]').first().click();
    await page
      .getByTestId("collective-activity-description")
      .fill("Atividade coletiva fictícia do E2E da HU 11551.");

    await page.getByTestId("collective-activity-search-name").fill("E2E 11551");
    await page.getByTestId("collective-activity-search-submit").click();
    await expect(
      page.getByTestId("collective-activity-search-results"),
    ).toBeVisible({ timeout: 15_000 });
    for (const n of ["2", "3", "4"]) {
      await page
        .locator(
          `li:has-text("E2E 11551 Responsável ${n}") [data-testid="collective-activity-add-participant"]`,
        )
        .click();
    }

    await page.getByTestId("collective-activity-submit").click();

    // Recusa: nada é salvo e o erro aponta a família ACOMPANHADA (…002), só ela.
    const block = page.locator(
      `[data-testid="collective-activity-evolution-block"][data-family-uuid="${FAMILY_ACOMPANHADA}"]`,
    );
    await expect(
      block.or(page.getByTestId("collective-activity-missing-evolutions")),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("collective-activity-summary")).toHaveCount(0);
    await expect(
      page.locator(
        '[data-testid="collective-activity-evolution-block"]:not([data-family-uuid="' +
          FAMILY_ACOMPANHADA +
          '"])',
      ),
    ).toHaveCount(0);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA04b — com a evolução da família acompanhada a atividade é salva e gera 3 atendimentos e 1 evolução", async ({}, testInfo) => {
    const block = page.locator(
      `[data-testid="collective-activity-evolution-block"][data-family-uuid="${FAMILY_ACOMPANHADA}"]`,
    );
    await expect(block).toBeVisible();
    await block
      .getByTestId("collective-activity-evolution")
      .fill("Evolução fictícia da família na atividade coletiva (E2E 11551).");
    await page.getByTestId("collective-activity-submit").click();

    await expect(page.getByTestId("collective-activity-summary")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("collective-activity-summary")).toContainText(
      "3 atendimento(s) gerado(s)",
    );
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);

    // Conferência pela API (mesma sessão): 3 atendimentos coletivos e 1 evolução na família acompanhada.
    const counts = await page.evaluate(
      async ({ api, tenant, families }) => {
        // O client autentica por cookie de sessão (Sanctum stateful), não por Bearer.
        const xsrf = decodeURIComponent(
          document.cookie.split("; ").find((c) => c.startsWith("XSRF-TOKEN="))?.split("=")[1] ?? "",
        );
        const headers = {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": xsrf,
          "X-Tenant-UUID": tenant,
        };
        const get = async (path: string) => {
          const res = await fetch(`${api}/api/client${path}`, { headers, credentials: "include" });
          return { status: res.status, body: await res.json().catch(() => ({})) };
        };
        let attendances = 0;
        const statuses: number[] = [];
        for (const uuid of families) {
          const r = await get(`/families/${uuid}/attendances?per_page=50`);
          const rows = (r.body.data ?? []) as Array<{ collective_activity: unknown }>;
          statuses.push(r.status);
          attendances += rows.filter((x) => x.collective_activity != null).length;
        }
        const fu = await get(`/families/${families[0]}/follow-ups`);
        const followUps = (fu.body.data ?? []) as Array<{ uuid: string }>;
        let evolutions = 0;
        for (const f of followUps) {
          const ev = await get(`/families/${families[0]}/follow-ups/${f.uuid}/evolutions`);
          evolutions += ((ev.body.data ?? []) as unknown[]).length;
        }
        return { attendances, evolutions, statuses };
      },
      {
        api: API,
        tenant: TENANT_UUID,
        families: [
          FAMILY_ACOMPANHADA,
          FAMILY_SEM_A,
          "00000000-0000-4000-8000-000011551004",
        ],
      },
    );
    expect(counts.statuses, "status da API").toEqual([200, 200, 200]);
    expect(counts.attendances, "atendimentos coletivos gerados").toBe(3);
    expect(counts.evolutions, "evolução da família acompanhada").toBe(1);
  });

  // ── 2º login: técnico do E2E CREAS ─────────────────────────────────────────
  test("CA07 — o técnico do CREAS não desliga o PAIF do CRAS e a API recusa (403)", async ({}, testInfo) => {
    await login(page, CREAS_OPERADOR);
    await openFollowUps(page);

    await expect(dischargeButton(page, "PAIF")).toHaveCount(0);
    await expect(dischargeButton(page, "PAEFI")).toHaveCount(1);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);

    // RN08: a prova vale em qualquer caminho — o POST direto também é recusado.
    const result = await page.evaluate(
      async ({ api, tenant, family }) => {
        const xsrf = decodeURIComponent(
          document.cookie.split("; ").find((c) => c.startsWith("XSRF-TOKEN="))?.split("=")[1] ?? "",
        );
        const headers = {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": xsrf,
          "X-Tenant-UUID": tenant,
        };
        const list = await fetch(`${api}/api/client/families/${family}/follow-ups`, { headers, credentials: "include" });
        const items = ((await list.json()).data ?? []) as Array<{
          uuid: string;
          service?: { short_name?: string };
        }>;
        const paif = items.find((i) => i.service?.short_name === "PAIF");
        if (!paif) return { found: false, status: 0, code: "" };
        const opts = await fetch(
          `${api}/api/client/families/${family}/follow-ups/${paif.uuid}/evaluations/options`,
          { headers, credentials: "include" },
        );
        const reasons = ((await opts.json()).data?.exit_reasons ?? []) as Array<{ uuid: string }>;
        const res = await fetch(
          `${api}/api/client/families/${family}/follow-ups/${paif.uuid}/discharge`,
          {
            method: "POST",
            headers,
            credentials: "include",
            body: JSON.stringify({
              discharged_on: new Date().toISOString().slice(0, 10),
              follow_up_exit_reason_uuid: reasons[0]?.uuid,
              offers_provided: "yes",
              referrals_effective: "not_applicable",
              family_recognizes_service: "yes",
              outcome_classification: "progress",
              achieved_results: "Tentativa fictícia do E2E da HU 11551.",
            }),
          },
        );
        const body = await res.json().catch(() => ({}));
        return {
          found: true,
          status: res.status,
          code: String(body?.code ?? body?.error ?? body?.errors?.code ?? JSON.stringify(body)),
        };
      },
      { api: API, tenant: TENANT_UUID, family: FAMILY_PAEFI },
    );
    expect(result.found, "PAIF listado para o técnico do CREAS").toBe(true);
    expect(result.status).toBe(403);
    expect(result.code).toContain("discharge_unit_not_conducting");
  });

  test("CA02/CA01/CA06 (prints) — o CREAS recusa sem evolução, salva com evolução e desliga o PAEFI", async ({}, testInfo) => {
    test.skip(!CAPTURING, "Prints de CA01/CA02/CA06: só com CAPTURE_EVIDENCE=1 (o E2E-057 já prova os três).");

    await openAttendanceSheet(page, FAMILY_PAEFI, CREAS_UNIT);
    await page.getByTestId("attendance-form-submit").click();
    await expect(
      page.locator('[data-testid="attendance-form-evolution-block"] [role="alert"]'),
    ).toBeVisible({ timeout: 10_000 });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "ca02");

    // Formulário LIMPO (sem o erro residual do CA02): recarrega a aba e reabre o registro.
    await openAttendanceSheet(page, FAMILY_PAEFI, CREAS_UNIT);
    await expect(
      page.locator('[data-testid="attendance-form-evolution-block"] [role="alert"]'),
    ).toHaveCount(0);
    await page
      .getByTestId("attendance-form-evolution")
      .fill("Evolução fictícia: a família retomou o contato com a escola.");
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "ca01");
    await page.getByTestId("attendance-form-submit").click();
    await expect(page.getByTestId("attendance-form-submit")).toBeHidden({
      timeout: 15_000,
    });

    await openFollowUps(page);
    await dischargeButton(page, "PAEFI").click();
    await page.getByTestId("discharge-form-exit-reason").click();
    await page.locator('[role="option"]').first().click();
    await page.getByTestId("discharge-form-answer-offers_provided-yes").check();
    await page
      .getByTestId("discharge-form-answer-referrals_effective-not_applicable")
      .check();
    await page.getByTestId("discharge-form-answer-family_recognizes_service-yes").check();
    await page.getByTestId("discharge-form-answer-outcome_classification-progress").check();
    await page
      .getByTestId("discharge-form-achieved-results")
      .fill("Resultados fictícios do E2E da HU 11551.");
    await page.getByTestId("discharge-form-submit").click();
    await expect(
      page.locator('[data-testid^="follow-up-correct-discharge-"]').first(),
    ).toBeVisible({ timeout: 15_000 });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "ca06");
  });

  // ── 3º login: Master sem lotação técnica ───────────────────────────────────
  test("D12 — o Master sem lotação técnica não vê Desligar em nenhuma linha (herdado da US-AJ-13 RN01)", async ({}, testInfo) => {
    await login(page, MASTER);
    await openTab(page, FAMILY_PAEFI, "acompanhamento");
    await expect(
      page.locator('[data-testid^="follow-up-card-"]').first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator(
        '[data-testid^="follow-up-discharge-"]:not([data-testid^="follow-up-discharge-info-"])',
      ),
    ).toHaveCount(0);

    // Registro do comportamento herdado — sem regra nova (pendência P1 do PO).
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "master");
  });
});
