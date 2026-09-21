import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CadunicoImportsPage } from '../../pages/client/CadunicoImportsPage';

/**
 * E2E da Importação do CadÚnico no frontend do TENANT (client) — Sprint 8.
 *
 * ⚠️ HARNESS: a stack E2E padrão (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client** (porta 5174), então é **opt-in via env** e
 * fica `skip` por padrão — espelha `tests/client/unit-professionals.spec.ts`.
 *
 * Pré-requisitos (ver plano `.claude/plans/...whimsical-floating-liskov.md` §T1–T4):
 *  - API no ar com `QUEUE_CONNECTION=sync` (jobs rodam inline → status determinístico);
 *  - client servido em `CLIENT_BASE_URL`;
 *  - `E2ESeeder` aplicado (tenant Ativo + MASTER com `cadunico-imports.*` + OPERADOR sem).
 *
 * Configurar em `e2e/.env.e2e`:
 *   CLIENT_BASE_URL, E2E_CLIENT_MASTER_CPF, E2E_CLIENT_MASTER_PASSWORD,
 *   E2E_CLIENT_OPERADOR_CPF, E2E_CLIENT_OPERADOR_PASSWORD (S4 — opcional).
 */

const BASE = process.env.CLIENT_BASE_URL;
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF;
const MASTER_PASS = process.env.E2E_CLIENT_MASTER_PASSWORD;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;

const configured = Boolean(BASE && MASTER_CPF && MASTER_PASS);

const FIXTURES = path.join(__dirname, '../../fixtures/cadunico');
const VALID_CSV = path.join(FIXTURES, 'cadunico-valido.csv');
const BAD_HEADER_CSV = path.join(FIXTURES, 'cadunico-cabecalho-invalido.csv');
const NOT_CSV = path.join(FIXTURES, 'cadunico-formato-invalido.pdf');
const OTHER_CITY_CSV = path.join(FIXTURES, 'cadunico-municipio-divergente.csv');

test.describe('Importação do CadÚnico (client, tenant-scoped)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_MASTER_CPF/PASSWORD em e2e/.env.e2e para rodar.',
  );

  test.use({ baseURL: BASE });

  test('S1 — MASTER importa um CSV válido e sincroniza as famílias', async ({ page }) => {
    const screen = new CadunicoImportsPage(page);
    await screen.login(MASTER_CPF!, MASTER_PASS!);
    await screen.goto();

    // Etapa 1: upload em dois passos (validar → confirmar).
    await screen.openUpload();
    await screen.selectFile(VALID_CSV);
    await screen.validate();
    await screen.expectValidated();
    await screen.confirm();

    await expect(page.getByText(/importação enviada/i)).toBeVisible();
    // Com a fila em modo sync, a Etapa 1 conclui de imediato; o polling reflete.
    await expect(page.getByText('Concluída', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    // Etapa 2: sincronização manual a partir do detalhe.
    await screen.openDetails('cadunico-valido.csv');
    await expect(screen.syncButton).toBeVisible();
    await screen.sync();

    await expect(page.getByText('Sincronizada', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    // Resumo consolidado (CA08): reabre o detalhe e confere o quadro de contadores.
    await screen.openDetails('cadunico-valido.csv');
    await expect(page.getByText(/resumo da sincronização/i)).toBeVisible();
    await expect(page.getByText(/novas famílias/i)).toBeVisible();
  });

  test('S2 — rejeita CSV com layout/cabeçalho divergente (CA02)', async ({ page }) => {
    const screen = new CadunicoImportsPage(page);
    await screen.login(MASTER_CPF!, MASTER_PASS!);
    await screen.goto();

    await screen.openUpload();
    await screen.selectFile(BAD_HEADER_CSV);
    await screen.validate();

    await screen.expectFileError(/layout|cabeçalho|colunas|cadúnico/i);
    // Não avança para a confirmação.
    await expect(screen.confirmButton).toHaveCount(0);
  });

  test('S3 — rejeita arquivo que não é CSV (CA02)', async ({ page }) => {
    const screen = new CadunicoImportsPage(page);
    await screen.login(MASTER_CPF!, MASTER_PASS!);
    await screen.goto();

    await screen.openUpload();
    await screen.selectFile(NOT_CSV);
    // O guard client-side rejeita antes mesmo de validar.
    await screen.expectFileError(/formato csv|\.csv|csv/i);
  });

  test('S3b — rejeita arquivo de outro município (RN01)', async ({ page }) => {
    const screen = new CadunicoImportsPage(page);
    await screen.login(MASTER_CPF!, MASTER_PASS!);
    await screen.goto();

    await screen.openUpload();
    await screen.selectFile(OTHER_CITY_CSV);
    await screen.validate();

    // O tenant E2E é de Fortaleza (IBGE 2304400); o arquivo é de São Paulo.
    await screen.expectFileError(/município|ibge|organização/i);
    await expect(screen.confirmButton).toHaveCount(0);
  });

  test('S4 — OPERADOR sem permissão não vê o módulo (CA03)', async ({ page }) => {
    test.skip(
      !(OPERADOR_CPF && OPERADOR_PASS),
      'Defina E2E_CLIENT_OPERADOR_CPF/PASSWORD para o teste de gating.',
    );

    const screen = new CadunicoImportsPage(page);
    await screen.login(OPERADOR_CPF!, OPERADOR_PASS!);

    // Item de menu ausente.
    await expect(screen.sidebarLink).toHaveCount(0);

    // Navegação direta não revela a tela (rota gated por cadunico-imports.index).
    await page.goto('/app/cadunico-imports');
    await expect(screen.newImportButton).toHaveCount(0);
  });

  // S5 (CA07/RN11 — botão desabilitado por concorrência) é difícil de observar com
  // a fila em modo `sync` (o lote conclui na hora). A regra já está coberta por Pest
  // (CadunicoImportControllerTest). Para um E2E real, semear um cadunico_imports com
  // status=processing antes de abrir a tela e asserir o botão "Nova importação"
  // desabilitado + o hint de organização.
  test.fixme('S5 — concorrência desabilita "Nova importação" (RN11)', async () => {
    // Requer um lote ativo (status=processing) pré-semeado; ver nota acima.
  });
});
