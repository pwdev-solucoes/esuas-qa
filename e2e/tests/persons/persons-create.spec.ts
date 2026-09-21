import { test, expect } from '../../fixtures/auth';
import { uniqueSuffix } from '../../fixtures/test-data';
import { generateCpf } from '../../helpers/cpf';
import { PersonsListPage } from '../../pages/persons/PersonsListPage';
import { PersonFormPage } from '../../pages/persons/PersonFormPage';

type PersonSearchResponse = {
  data: Array<{ uuid: string; full_name: string; cpf: string }>;
  empty: boolean;
};

/**
 * Cadastro individual de pessoa (#9585) — fluxos de sucesso e bloqueios.
 * A pessoa nasce SEM tenant (base global, RN01) e sem exclusão (RN04).
 */
test.describe('Pessoas — cadastro (#9585)', () => {
  test('CA01 — cadastra pessoa brasileira com sucesso e ela aparece na busca', async ({
    page,
    apiClient,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();
    const fullName = `Pessoa ${suffix}`;

    const form = new PersonFormPage(page);
    const list = new PersonsListPage(page);

    await form.goto();
    await form.fillRequired({
      fullName,
      motherName: `Mãe ${suffix}`,
      birthDate: '1990-05-10',
      cpf,
    });
    await form.selectNacionalidade('Brasileiro(a)');
    await form.save();

    // Salvou → redireciona para a listagem (router name 'persons').
    await page.waitForURL('**/app/persons', { timeout: 10_000 });

    // Sanity via API: pessoa criada (1 registro) com o CPF informado, sem tenant.
    const res = await apiClient.get<PersonSearchResponse>(`/persons?cpf=${cpf}`);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].full_name).toBe(fullName);

    // E aparece na busca por CPF na UI.
    await list.searchByCpf(cpf);
    await expect(list.row(res.data[0].uuid)).toBeVisible({ timeout: 10_000 });
  });

  test('CA02 — bloqueia salvamento com campos obrigatórios ausentes', async ({ page }) => {
    const form = new PersonFormPage(page);

    await form.goto();
    await form.save();

    // Continua na página de cadastro (não redirecionou) e exibe erros.
    await expect(page).toHaveURL(/\/app\/persons\/novo/);
    await expect(form.validationErrors().first()).toBeVisible({ timeout: 5_000 });
  });

  test('RN03 — bloqueia CPF com dígito verificador inválido', async ({ page }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const form = new PersonFormPage(page);

    await form.goto();
    await form.fillRequired({
      fullName: `Pessoa ${suffix}`,
      motherName: `Mãe ${suffix}`,
      birthDate: '1990-05-10',
      cpf: '12345678900', // DV inválido
    });
    await form.selectNacionalidade('Brasileiro(a)');
    await form.save();

    // Não salva — permanece no cadastro com erro de validação.
    await expect(page).toHaveURL(/\/app\/persons\/novo/);
    await expect(form.validationErrors().first()).toBeVisible({ timeout: 5_000 });
  });

  test('RN12 — pessoa brasileira não captura país de origem', async ({ page }) => {
    const form = new PersonFormPage(page);

    await form.goto();
    await form.selectNacionalidade('Brasileiro(a)');

    // Combobox de país de origem não deve aparecer para nacionalidade 001.
    await expect(form.foreignerCountry).toHaveCount(0);
  });
});
