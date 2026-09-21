import { test, expect } from '../../fixtures/auth';
import { uniqueSuffix } from '../../fixtures/test-data';
import { generateCpf } from '../../helpers/cpf';
import { PersonFormPage } from '../../pages/persons/PersonFormPage';

type CreatePersonResponse = { data: { uuid: string; full_name: string; cpf: string } };

/**
 * Validação de duplicidade de CPF (#9594) e regra condicional de país de
 * origem para estrangeiro (RN12).
 */
test.describe('Pessoas — duplicidade e estrangeiro (#9594/RN12)', () => {
  test('CA01/#9594 — bloqueia cadastro com CPF já existente', async ({
    page,
    apiClient,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();

    // Pré-condição: pessoa já existe na base global com este CPF.
    await apiClient.post<CreatePersonResponse>('/persons', {
      full_name: `Existente ${suffix}`,
      mother_name: `Mãe ${suffix}`,
      birth_date: '1985-03-12',
      cpf,
    });

    const form = new PersonFormPage(page);
    await form.goto();
    await form.fullName.fill(`Duplicada ${suffix}`);
    await form.motherName.fill(`Mãe ${suffix}`);
    await form.birthDate.fill('1990-05-10');
    await form.typeCpf(cpf);

    // Alerta de duplicidade em tempo de preenchimento (RN07) — aguarda o debounce
    // (400ms) + a resposta do check-cpf + o render do aviso.
    await expect(form.cpfDuplicateWarning).toBeVisible({ timeout: 10_000 });

    await form.selectNacionalidade('Brasileiro(a)');
    await form.save();

    // Continuação bloqueada: permanece no cadastro com o alerta visível.
    await expect(page).toHaveURL(/\/app\/persons\/novo/);
    await expect(form.cpfDuplicateWarning).toBeVisible();
  });

  test('RN12 — estrangeiro exige país de origem', async ({ page }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();

    const form = new PersonFormPage(page);
    await form.goto();
    await form.fillRequired({
      fullName: `Estrangeiro ${suffix}`,
      motherName: `Mãe ${suffix}`,
      birthDate: '1979-09-02',
      cpf,
    });

    // Nacionalidade 003 → campo de país de origem aparece e é obrigatório.
    await form.selectNacionalidade('Estrangeiro(a)');
    await expect(form.foreignerCountry).toBeVisible();

    await form.save();

    // Sem país informado → não salva, permanece no cadastro com erro.
    await expect(page).toHaveURL(/\/app\/persons\/novo/);
    await expect(form.validationErrors().first()).toBeVisible({ timeout: 5_000 });
  });
});
