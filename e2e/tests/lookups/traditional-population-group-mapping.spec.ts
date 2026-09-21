import { expect, test } from '@playwright/test';

/**
 * HU #10621 (US-PRONT-05) — etapa 02 (admin).
 *
 * O MAPA `traditional_population_groups.social_specificity_id` → Tabela 38.
 *
 * Por que este fluxo merece E2E: o campo nao e decorativo. Ele alimenta a
 * `DeriveFamilySpecificitiesAction` na importacao do CadUnico — mapear errado
 * (ou deixar de desmapear) vira uma afirmacao automatica errada no prontuario
 * de familias reais. Por isso os tres momentos sao cobertos aqui: a listagem
 * mostra a AUSENCIA de mapeamento, o mapeamento e feito e aparece na listagem,
 * e o DESMAPEAMENTO volta o registro ao estado "Nao mapeado".
 *
 * Nao usa o `ReferenceLookupCrudPage` de proposito: aquele POM assume `code`
 * readonly na edicao (HU #10620/#10619), o que nao vale neste cadastro.
 */
const SLUG = 'traditional-population-groups';

function waitForList(page: import('@playwright/test').Page) {
  return page.waitForResponse(
    (res) => res.url().includes(`/api/${SLUG}`) && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

test.describe('#10621 · Mapa Grupo Populacional → Especificidade social (Tabela 38)', () => {
  test('mapeia, ve na listagem e desmapeia um grupo populacional', async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    const code = `e2e${suffix}`;
    const name = `E2E Grupo Populacional ${suffix}`;

    const rows = page.locator('table tbody tr');
    const row = () => rows.filter({ hasText: code });
    const mappingCell = () => row().getByTestId('tpg-social-specificity');
    const combobox = page.getByTestId('tpg-specificity-combobox');

    const firstList = waitForList(page);
    await page.goto(`/app/${SLUG}`);
    expect((await firstList).status()).toBe(200);

    // --- criacao SEM mapeamento: o campo e opcional ---
    await page.getByRole('button', { name: /novo grupo populacional/i }).click();
    await expect(combobox).toBeVisible();
    // O texto de apoio precisa dizer, na tela, o que o campo provoca.
    await expect(
      page.getByText(/deriva[çc][ãa]o autom[áa]tica.*cad[ÚU]nico/i).first(),
    ).toBeVisible();
    await page.locator('#tut-code').fill(code);
    await page.locator('#tut-name').fill(name);
    let list = waitForList(page);
    await page.getByRole('button', { name: /^salvar$/i }).click();
    await list;

    list = waitForList(page);
    await page.getByPlaceholder(/buscar/i).first().fill(code);
    await list;

    await expect(row()).toContainText(name);
    // A ausencia de mapeamento e visivel na listagem — nao e preciso abrir o registro.
    await expect(mappingCell()).toContainText(/n[ãa]o mapeado/i);

    // --- mapeia para uma especificidade da Tabela 38 ---
    await row().getByRole('button', { name: /mais ações/i }).click();
    await page.getByRole('menuitem', { name: /^editar$/i }).click();
    await combobox.getByRole('button').first().click();
    const option = combobox.getByRole('option').first();
    const optionLabel = ((await option.textContent()) ?? '').trim();
    expect(optionLabel.length).toBeGreaterThan(0);
    await option.click();
    await expect(combobox).toContainText(optionLabel);
    list = waitForList(page);
    await page.getByRole('button', { name: /^salvar$/i }).click();
    await list;

    // O mapa aparece na LISTAGEM (o ponto da tela: ver o mapa inteiro de uma vez).
    await expect(mappingCell()).toContainText(optionLabel);

    // --- desmapeia: voltar a nulo tem de funcionar ---
    await row().getByRole('button', { name: /mais ações/i }).click();
    await page.getByRole('menuitem', { name: /^editar$/i }).click();
    await expect(combobox).toContainText(optionLabel);
    await combobox.locator('svg.lucide-x').click();
    list = waitForList(page);
    await page.getByRole('button', { name: /^salvar$/i }).click();
    await list;

    await expect(mappingCell()).toContainText(/n[ãa]o mapeado/i);

    // --- limpeza: nao deixa residuo na base de e2e ---
    await row().getByRole('button', { name: /mais ações/i }).click();
    await page.getByRole('menuitem', { name: /^excluir$/i }).click();
    list = waitForList(page);
    await page.getByRole('button', { name: /^excluir$/i }).last().click();
    await list;
    await expect(row()).toHaveCount(0);
  });
});
