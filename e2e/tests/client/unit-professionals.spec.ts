import { test, expect } from '@playwright/test';
import { UnitProfessionalsPage } from '../../pages/client/UnitProfessionalsPage';

/**
 * E2E da aba "Profissionais" da Unidade Socioassistencial no frontend do
 * TENANT (client) — HU #9697.
 *
 * ⚠️ HARNESS: o `scripts/start-stack.sh` atual sobe e serve apenas o **admin**
 * (Super Admin) em `vite preview`. Este spec exercita o **client**, que ainda
 * NÃO é servido pela stack E2E. Por isso ele é **opt-in via env** e fica
 * `skip` por padrão (não quebra o CI atual, focado no admin).
 *
 * Para rodar localmente (validado manualmente):
 *   1. API Sail no ar (migrate + db:seed --class=CboSeeder) com um cenário:
 *      um MASTER do tenant, a unidade operacional, profissionais municipais
 *      ativos (tenant_professionals) e CBOs ativas. Acertar
 *      SANCTUM_STATEFUL_DOMAINS/FRONTEND_URL_CLIENT para a porta do client.
 *   2. `cd client && npm run dev` (anotar a porta).
 *   3. Exportar as vars e rodar:
 *      CLIENT_BASE_URL=http://localhost:5174 \
 *      E2E_CLIENT_MASTER_CPF=... E2E_CLIENT_MASTER_PASSWORD=... \
 *      E2E_CLIENT_UNIT_UUID=... \
 *      npx playwright test tests/client/unit-professionals.spec.ts
 *
 * TODO (infra): estender start-stack.sh para servir o client + um
 * `auth.setup` de tenant (login + select-tenant + storageState) para tornar
 * este spec parte do CI.
 */

const BASE = process.env.CLIENT_BASE_URL;
const CPF = process.env.E2E_CLIENT_MASTER_CPF;
const PASS = process.env.E2E_CLIENT_MASTER_PASSWORD;
const UNIT = process.env.E2E_CLIENT_UNIT_UUID;
const CANDIDATE_SEARCH = process.env.E2E_CLIENT_CANDIDATE_SEARCH ?? 'Profissional';
const CANDIDATE_NAME = process.env.E2E_CLIENT_CANDIDATE_NAME ?? 'Profissional';

const configured = Boolean(BASE && CPF && PASS && UNIT);

test.describe('HU #9697 — aba Profissionais da unidade (client)', () => {
  test.skip(!configured, 'Defina CLIENT_BASE_URL + E2E_CLIENT_MASTER_CPF/PASSWORD + E2E_CLIENT_UNIT_UUID (client não servido pela stack admin).');

  test.use({ baseURL: BASE });

  test('MASTER vincula um profissional com CBO e a listagem mostra a linha (CA01/CA03)', async ({ page }) => {
    const screen = new UnitProfessionalsPage(page);
    await screen.login(CPF!, PASS!);
    await screen.openTab(UNIT!);

    await expect(screen.linkButton).toBeVisible(); // MASTER tem manage-assignments (RN12)

    await screen.linkProfessional({
      candidateSearch: CANDIDATE_SEARCH,
      candidateName: new RegExp(CANDIDATE_NAME, 'i'),
      cboMatch: /assistente social|advogado|psic|\d{4}-\d{2}/i,
    });

    await expect(page.getByText(/vinculado à unidade com sucesso/i)).toBeVisible();
    // A listagem expõe Nome / Matrícula / CBO / Período / Status (PII mascarada).
    await expect(page.getByText(new RegExp(CANDIDATE_NAME, 'i')).first()).toBeVisible();
    await expect(page.getByText(/—/)).toBeVisible(); // CBO `{code} — {name}`
  });

  test('período sobreposto na mesma unidade é rejeitado (CA02)', async ({ page }) => {
    const screen = new UnitProfessionalsPage(page);
    await screen.login(CPF!, PASS!);
    await screen.openTab(UNIT!);

    // Vincula o mesmo candidato duas vezes com período aberto sobreposto.
    const link = async () =>
      screen.linkProfessional({
        candidateSearch: CANDIDATE_SEARCH,
        candidateName: new RegExp(CANDIDATE_NAME, 'i'),
        cboMatch: /\d{4}-\d{2}|assistente social|advogado/i,
      });

    await link();
    await page.waitForTimeout(500);
    await link();

    await expect(
      page.getByText(/já possui um período de atuação ativo nesta unidade/i),
    ).toBeVisible();
  });
});
