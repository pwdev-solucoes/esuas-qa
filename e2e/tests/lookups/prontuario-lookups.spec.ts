import { expect, test } from '@playwright/test';
import { ReferenceLookupCrudPage } from '../../pages/lookups/ReferenceLookupCrudPage';

/**
 * HU #10620 (US-PRONT-04) — etapa 03.
 *
 * Manutenção, pelo Super Admin, dos dois lookups globais que alimentam a
 * composição familiar editável do prontuário:
 *
 *  - `member-unlink-reasons` — motivo exigido no desvínculo de integrante (CA02)
 *  - `civil-document-types`  — documentação civil a providenciar (CA05)
 *
 * Cobre os quatro fluxos exigidos pelo plano: listagem, criação, edição e
 * inativação em lote. Cada teste cria o próprio registro com um code único e o
 * remove no final, para não deixar resíduo na base de e2e.
 */
const LOOKUPS = [
  {
    slug: 'member-unlink-reasons',
    label: 'Motivos de Desvínculo',
    newButtonName: /novo motivo de desv[íi]nculo/i,
    fieldPrefix: 'mur',
  },
  {
    slug: 'civil-document-types',
    label: 'Tipos de Documento Civil',
    newButtonName: /novo tipo de documento civil/i,
    fieldPrefix: 'cdt',
  },
];

for (const lookup of LOOKUPS) {
  test.describe(`#10620 · ${lookup.label}`, () => {
    test(`listagem de ${lookup.label} carrega sem erro`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      const lookupPage = new ReferenceLookupCrudPage(page, lookup);
      await lookupPage.goto();
      await lookupPage.expectListLoaded();

      await expect(page.getByRole('heading', { name: lookup.label })).toBeVisible();
      expect(
        consoleErrors,
        `console errors em /${lookup.slug}: ${consoleErrors.join(' | ')}`,
      ).toEqual([]);
    });

    test(`criação, edição e inativação em lote de ${lookup.label}`, async ({ page }) => {
      const suffix = Date.now().toString().slice(-6);
      const code = `e2e_${suffix}`;
      const name = `E2E ${lookup.label} ${suffix}`;
      const renamed = `${name} (editado)`;

      const lookupPage = new ReferenceLookupCrudPage(page, lookup);
      await lookupPage.goto();

      // --- criação ---
      await lookupPage.create(code, name);
      await lookupPage.search(code);
      await expect(lookupPage.row(code)).toContainText(name);
      await expect(lookupPage.row(code)).toContainText(/ativo/i);

      // --- o code não é editável depois de criado ---
      await lookupPage.expectCodeReadOnlyOnEdit(code);

      // --- edição ---
      await lookupPage.rename(code, renamed);
      await expect(lookupPage.row(code)).toContainText(renamed);

      // --- inativação em lote ---
      await lookupPage.selectRow(code);
      await lookupPage.bulkDeactivate();
      await expect(lookupPage.row(code)).toContainText(/inativo/i);

      // --- limpeza ---
      await lookupPage.remove(code);
      await expect(lookupPage.row(code)).toHaveCount(0);
    });
  });
}

/**
 * HU #10619 (US-PRONT-03) — etapa 03.
 *
 * Os dois lookups globais do bloco de ingresso, com uma diferença que importa:
 * cada um carrega uma flag que é REGRA DE VALIDAÇÃO do prontuário do município —
 * `requires_referring_agency` (exige nome e contato do órgão encaminhador,
 * RN03/CA02/CA03) e `requires_beneficiary` (exige apontar o integrante
 * beneficiário, CA06). Mudá-la aqui muda o que o profissional é obrigado a
 * preencher no `client/`, sem deploy — por isso o teste de edição exercita a
 * flag, não só o nome.
 */
const RULE_LOOKUPS = [
  {
    slug: 'family-intake-forms',
    label: 'Formas de Ingresso',
    newButtonName: /nova forma de ingresso/i,
    fieldPrefix: 'fif',
    flagTestId: 'fif-flag',
    ruleOn: /exige órgão/i,
    ruleOff: /não exige/i,
  },
  {
    slug: 'social-programs',
    label: 'Programas Sociais',
    newButtonName: /novo programa social/i,
    fieldPrefix: 'spr',
    flagTestId: 'spr-flag',
    ruleOn: /exige integrante/i,
    ruleOff: /não exige/i,
  },
];

for (const lookup of RULE_LOOKUPS) {
  test.describe(`#10619 · ${lookup.label}`, () => {
    test(`listagem de ${lookup.label} carrega sem erro`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      const lookupPage = new ReferenceLookupCrudPage(page, lookup);
      await lookupPage.goto();
      await lookupPage.expectListLoaded();

      await expect(page.getByRole('heading', { name: lookup.label })).toBeVisible();
      expect(
        consoleErrors,
        `console errors em /${lookup.slug}: ${consoleErrors.join(' | ')}`,
      ).toEqual([]);
    });

    test(`criação, edição da flag de regra e inativação de ${lookup.label}`, async ({ page }) => {
      const suffix = Date.now().toString().slice(-6);
      const code = `e2e_${suffix}`;
      const name = `E2E ${lookup.label} ${suffix}`;
      const renamed = `${name} (editado)`;

      const lookupPage = new ReferenceLookupCrudPage(page, lookup);
      await lookupPage.goto();

      // --- criação com a flag de regra LIGADA ---
      await lookupPage.create(code, name, true);
      await lookupPage.search(code);
      await expect(lookupPage.row(code)).toContainText(name);
      await expect(lookupPage.row(code)).toContainText(lookup.ruleOn);
      expect(await lookupPage.readFlagOnEdit(code)).toBe(true);

      // --- o code não é editável depois de criado ---
      await lookupPage.expectCodeReadOnlyOnEdit(code);

      // --- edição do nome ---
      await lookupPage.rename(code, renamed);
      await expect(lookupPage.row(code)).toContainText(renamed);

      // --- edição da FLAG: desliga a regra e confere que a listagem reflete ---
      await lookupPage.setFlag(code, false);
      await expect(lookupPage.row(code)).toContainText(lookup.ruleOff);
      expect(await lookupPage.readFlagOnEdit(code)).toBe(false);

      // --- e volta a ligar: a regra é reversível pelo Super Admin ---
      await lookupPage.setFlag(code, true);
      await expect(lookupPage.row(code)).toContainText(lookup.ruleOn);

      // --- inativação em lote ---
      await lookupPage.selectRow(code);
      await lookupPage.bulkDeactivate();
      await expect(lookupPage.row(code)).toContainText(/inativo/i);

      // --- limpeza ---
      await lookupPage.remove(code);
      await expect(lookupPage.row(code)).toHaveCount(0);
    });
  });
}
