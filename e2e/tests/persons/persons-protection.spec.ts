import { test, expect } from '../../fixtures/auth';
import { uniqueSuffix } from '../../fixtures/test-data';
import { generateCpf } from '../../helpers/cpf';
import { PersonsListPage } from '../../pages/persons/PersonsListPage';
import { PersonFormPage } from '../../pages/persons/PersonFormPage';

type CreatePersonResponse = { data: { uuid: string; full_name: string; cpf: string } };
type PersonSearchResponse = { data: Array<{ uuid: string }>; empty: boolean };
type PersonDetailResponse = {
  data: { sex_id: number | null; sex: { code: string; name: string } | null };
};

/**
 * Proteção do cadastro (RN04 — sem exclusão) e sexo por referência (RN13).
 */
test.describe('Pessoas — proteção e referências (RN04/RN13)', () => {
  test('RN04 — não existe ação de exclusão na listagem nem na edição', async ({
    page,
    apiClient,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const person = await apiClient.post<CreatePersonResponse>('/persons', {
      full_name: `Sem Exclusao ${suffix}`,
      mother_name: `Mãe ${suffix}`,
      birth_date: '1985-03-12',
      cpf: generateCpf(),
    });

    // Listagem: nenhuma ação de exclusão.
    const list = new PersonsListPage(page);
    await list.goto();
    await list.expectNoDeleteAction();

    // Edição: a página de uma pessoa também não oferece exclusão.
    await page.goto(`/app/persons/${person.data.uuid}/editar`);
    await expect(page.locator('#pf-name')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: /excluir|remover|deletar|apagar/i }),
    ).toHaveCount(0);
  });

  test('RN13 — sexo selecionado por referência é vinculado ao registro', async ({
    page,
    apiClient,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();

    const form = new PersonFormPage(page);
    await form.goto();
    await form.fillRequired({
      fullName: `Com Sexo ${suffix}`,
      motherName: `Mãe ${suffix}`,
      birthDate: '1990-05-10',
      cpf,
    });
    await form.selectNacionalidade('Brasileiro(a)');
    await form.selectSexo('Feminino');
    await form.save();

    await page.waitForURL('**/app/persons', { timeout: 10_000 });

    // Confirma via API que a pessoa ficou vinculada ao sexo de referência (001).
    const search = await apiClient.get<PersonSearchResponse>(`/persons?cpf=${cpf}`);
    expect(search.data).toHaveLength(1);

    const detail = await apiClient.get<PersonDetailResponse>(`/persons/${search.data[0].uuid}`);
    expect(detail.data.sex_id).not.toBeNull();
    expect(detail.data.sex?.code).toBe('001');
  });
});
