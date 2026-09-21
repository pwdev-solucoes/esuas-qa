import { test, expect } from '../../fixtures/auth';
import { uniqueSuffix } from '../../fixtures/test-data';
import { generateCpf } from '../../helpers/cpf';
import { PersonsListPage } from '../../pages/persons/PersonsListPage';

type CreatePersonResponse = { data: { uuid: string; full_name: string; cpf: string } };

async function seedPerson(
  apiClient: { post: <T>(e: string, d: unknown) => Promise<T> },
  fields: { full_name: string; mother_name: string; birth_date: string; cpf: string },
): Promise<CreatePersonResponse['data']> {
  const res = await apiClient.post<CreatePersonResponse>('/persons', fields);

  return res.data;
}

/**
 * Busca no repositório global (#9595): exata por CPF, parcial por Nome com
 * desambiguação e estado vazio com atalho de inclusão (CA03/RN08).
 */
test.describe('Pessoas — busca (#9595)', () => {
  test('CA01 — busca exata por CPF retorna o registro único', async ({
    page,
    apiClient,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();
    const person = await seedPerson(apiClient, {
      full_name: `Busca CPF ${suffix}`,
      mother_name: `Mãe ${suffix}`,
      birth_date: '1985-03-12',
      cpf,
    });

    const list = new PersonsListPage(page);
    await list.goto();
    await list.searchByCpf(cpf);

    await expect(list.row(person.uuid)).toBeVisible({ timeout: 10_000 });
    await expect(list.rows()).toHaveCount(1);
  });

  test('CA02 — busca parcial por Nome lista com desambiguação', async ({
    page,
    apiClient,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const token = `Homonimo ${suffix}`;
    const a = await seedPerson(apiClient, {
      full_name: `${token} Silva`,
      mother_name: `Joana ${suffix}`,
      birth_date: '1985-03-12',
      cpf: generateCpf(),
    });
    const b = await seedPerson(apiClient, {
      full_name: `${token} Souza`,
      mother_name: `Antonia ${suffix}`,
      birth_date: '1990-07-21',
      cpf: generateCpf(),
    });

    const list = new PersonsListPage(page);
    await list.goto();
    await list.searchByName(token);

    await expect(list.row(a.uuid)).toBeVisible({ timeout: 10_000 });
    await expect(list.row(b.uuid)).toBeVisible();
    // RN05: a grade exibe o nome da mãe (coluna de desambiguação).
    await expect(list.row(a.uuid)).toContainText(`Joana ${suffix}`);
  });

  test('CA03 — busca sem correspondência mostra estado vazio com atalho de inclusão', async ({
    page,
  }) => {
    const list = new PersonsListPage(page);
    await list.goto();
    // CPF válido em formato porém inexistente na base.
    await list.searchByCpf('00000000000');

    await expect(list.emptyNoResults).toBeVisible({ timeout: 10_000 });
    await expect(list.emptyCreateShortcut).toBeVisible();

    await list.emptyCreateShortcut.click();
    await expect(page).toHaveURL(/\/app\/persons\/novo/);
  });
});
