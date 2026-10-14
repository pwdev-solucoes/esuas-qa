import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  createTenantApiClient,
  loginAsTenantUser,
} from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureFinalEvidence } from "../../helpers/evidence";

/**
 * US-EVOL-02 (HU #11209) — plano 03: acompanhamentos que pedem atenção, no
 * frontend do TENANT (`client/`). Spec MANUAL: o cenário declarativo E2E-009
 * cobre relação, filtro, linha → card e Master; aqui ficam o que ele não
 * expressa.
 *
 * ## O que prova (Operacional com add-on, lotado no CRAS Centro)
 *
 *  - CA05: a relação sem planejamento vem do mais antigo para o mais novo
 *    (200, 90, 35 dias de espera na massa);
 *  - CA03: o aviso "sem planejamento" da apuração do mês corrente é igual ao
 *    total da relação filtrada pelo motivo e pela unidade (P6: a apuração é do
 *    MASTER; o Operacional não a abre, então esta parte roda como Master,
 *    na unidade "E2E CRAS Centro" e com `?social_unit=` na relação);
 *  - CA06: registrar o planejamento (API) tira a linha da relação e baixa a
 *    contagem da apuração em 1 (lida pelo Master). Planejamento não se apaga: o spec NÃO desfaz.
 *
 * ## Massa e re-execução
 *
 * `E2EFollowUpAttentionSeeder` (api). A cada execução o spec resolve a linha
 * sem planejamento MAIS RECENTE que ainda exista; sem nenhuma, pula o caso.
 * Para restaurar o estado, rode o seeder de novo (ele não recria planejamento
 * apagado, mas o `firstOrNew` por família + unidade e as datas relativas
 * ajustam a massa; planejamentos já registrados seguem registrados).
 *
 * ⚠️ Este spec ALTERA a massa: rode DEPOIS do E2E-009/E2E-010.
 *
 * Nunca registra nem imprime CPF, nome ou texto de planejamento em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const UNIT_UUID =
  process.env.E2E_CLIENT_UNIT_UUID ?? "00000000-0000-4000-8000-0000000e0001";

const EVIDENCE_SLUG = "us-evol-02-acompanhamentos-atencao";

type AttentionRow = {
  uuid: string;
  family: { uuid: string };
  waiting_days: number;
};

const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? "";
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? "";

let api: APIRequestContext;
let xsrf = "";
let masterPage: Page;

async function listWithoutPlan(): Promise<{
  rows: AttentionRow[];
  total: number;
}> {
  const response = await api.get(
    `/api/client/follow-ups/attention?reason=without_plan&social_unit_uuid=${UNIT_UUID}&per_page=50`,
  );
  expect(response.status(), "relação de acompanhamentos com atenção").toBe(200);
  const body = await response.json();
  return {
    rows: (body.data ?? []) as AttentionRow[],
    total: Number(body.meta?.total ?? 0),
  };
}

async function openRelation(page: Page, query: string): Promise<void> {
  await page.goto(`/app/cadastros/acompanhamentos-atencao?${query}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("follow-ups-attention-filters")).toBeVisible();
}

/** Número do aviso "sem planejamento" da unidade, na apuração do mês corrente. */
async function withoutPlanCountOnReport(page: Page): Promise<number> {
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/attendance-reports") &&
      res.request().method() === "GET",
    { timeout: 15_000 },
  );
  await page.goto("/app/prestacao-contas/apuracao-atendimentos");
  await dismissPlatformUpdates(page);
  expect((await responsePromise).status(), "apuração").toBe(200);

  const counter = page.getByTestId(
    `follow-ups-without-plan-count-${UNIT_UUID}`,
  );
  if ((await counter.count()) === 0) return 0; // o aviso some quando a contagem é zero
  await expect(counter).toBeVisible();
  const text = (await counter.innerText()).replace(/\D/g, "");
  return Number(text);
}

test.beforeAll(async () => {
  if (!BASE) return;
  api = await createTenantApiClient();
  const state = await api.storageState();
  xsrf = decodeURIComponent(
    state.cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
  );
  expect(xsrf, "XSRF-TOKEN da sessão de tenant").not.toBe("");
});

test.beforeAll(async ({ browser }) => {
  if (!BASE) return;
  expect(
    MASTER_CPF && MASTER_PASSWORD,
    "E2E_CLIENT_MASTER_CPF/PASSWORD no ambiente",
  ).toBeTruthy();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 900 },
  });
  masterPage = await context.newPage();
  await loginAsTenantUser(masterPage, MASTER_CPF, MASTER_PASSWORD);
});

test.afterAll(async () => {
  await masterPage?.context().close();
  await api?.dispose();
});

test.describe("US-EVOL-02 — acompanhamentos que pedem atenção (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE, locale: "pt-BR" });

  test.afterEach(async ({ page }, testInfo) => {
    // CA03/CA06 rodam como Master (P6): a evidência final vem da página dele.
    await captureFinalEvidence(
      testInfo.title.startsWith("CA05") ? page : masterPage,
      testInfo,
      EVIDENCE_SLUG,
    );
  });

  test("CA05 — sem planejamento: do mais antigo para o mais novo", async ({
    page,
  }) => {
    await openRelation(page, `reason=without_plan&social_unit=${UNIT_UUID}`);

    const waiting = page.getByTestId("attention-waiting");
    await expect(waiting.first()).toBeVisible();
    const days = (await waiting.allInnerTexts()).map((text) =>
      Number(text.replace(/\D/g, "")),
    );

    expect(
      days.length,
      "linhas sem planejamento na massa",
    ).toBeGreaterThanOrEqual(1);
    expect(
      [...days].sort((a, b) => b - a),
      "ordem decrescente de espera",
    ).toEqual(days);

    // A massa original traz 200, 90 e 35 dias: quem ainda existir segue essa ordem.
    const seeded = days.filter((value) => [200, 90, 35].includes(value));
    expect([...seeded].sort((a, b) => b - a)).toEqual(seeded);

    await page.screenshot({ path: "test-results/evol02-ca05-ordem.png" });
  });

  test("CA03 — a contagem da apuração é igual ao total da relação filtrada", async () => {
    const { total } = await listWithoutPlan();
    expect(
      total,
      "a massa precisa ter acompanhamento sem planejamento",
    ).toBeGreaterThan(0);

    const reported = await withoutPlanCountOnReport(masterPage);
    expect(reported, "aviso da apuração = total da relação").toBe(total);

    await openRelation(
      masterPage,
      `reason=without_plan&social_unit=${UNIT_UUID}`,
    );
    await expect(
      masterPage.locator('[data-testid^="follow-up-attention-row-"]'),
    ).toHaveCount(total);
    await masterPage.screenshot({
      path: "test-results/evol02-ca03-coincide.png",
    });
  });

  test("CA06 — registrar o planejamento tira a linha e baixa a contagem em 1", async () => {
    const before = await listWithoutPlan();
    test.skip(
      before.rows.length === 0,
      "Não há mais acompanhamento sem planejamento na massa; rode o E2EFollowUpAttentionSeeder.",
    );

    // A mais nova (menor espera) que ainda exista.
    const target = before.rows[before.rows.length - 1];
    const countBefore = await withoutPlanCountOnReport(masterPage);
    expect(countBefore).toBe(before.total);

    const saved = await api.put(
      `/api/client/families/${target.family.uuid}/follow-ups/${target.uuid}/plan`,
      {
        headers: { "X-XSRF-TOKEN": xsrf },
        data: {
          content: `E2E11209-${Date.now()} planejamento registrado pelo teste`,
        },
      },
    );
    expect([200, 201], "registro do planejamento").toContain(saved.status());

    await openRelation(
      masterPage,
      `reason=without_plan&social_unit=${UNIT_UUID}`,
    );
    await expect(
      masterPage.getByTestId(`follow-up-attention-row-${target.uuid}`),
    ).toHaveCount(0);
    await masterPage.screenshot({
      path: "test-results/evol02-ca06-linha-saiu.png",
    });

    const countAfter = await withoutPlanCountOnReport(masterPage);
    expect(countAfter, "a contagem da apuração baixou 1").toBe(countBefore - 1);
    // Sem desfazer: planejamento não se apaga.
  });
});
