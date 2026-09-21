import { expect, test, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * E2E do fluxo de BALCAO da HU #10660 / US-PRONT-06 (CA01 a CA08, CA11) no
 * frontend do TENANT (client): localizar a pessoa, entender qual dos tres
 * resultados se tem em maos, confirmar identidade para vincular quem vem de
 * fora e cadastrar quem o repositorio nao conhece.
 *
 * ⚠️ HARNESS: a stack E2E padrao (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client**, entao e **opt-in via env** e fica `skip`
 * por padrao — mesmo molde de `tests/client/family-access-by-unit.spec.ts`.
 *
 * ## O que ele prova (e que nenhum teste de backend prova)
 *
 * Que a TELA nao vaza o que a API escondeu. O backend ja garante que a
 * resposta do CA02 traz apenas existencia; o que so o navegador mostra e se
 * o HTML RENDERIZADO acrescentou algo — nome em `title`, dado em `data-*`,
 * payload em bloco escondido. Por isso a assercao central deste spec e sobre
 * o HTML da pagina, nao sobre o texto visivel.
 *
 * ## Massa necessaria
 *
 * O `E2EProntuarioSeeder` (HUs #10617/#10618) ja monta tenant, tres unidades,
 * tres operadores e tres familias — este spec REUSA o operador e a familia do
 * CRAS Centro. Mas o cenario da #10660 exige pessoas que aquele seeder nao
 * cria (ele semeia responsaveis SEM CPF e sem `family_members`), entao os
 * envs abaixo sao NOVOS e precisam de massa propria:
 *
 *  | env                                  | o que precisa ser                            | CA        |
 *  |--------------------------------------|----------------------------------------------|-----------|
 *  | E2E_CLIENT_PERSON_LOCAL_CPF          | pessoa integrante ATIVA de familia do CRAS   | CA01      |
 *  |                                      | Centro (aparece na pesquisa de hoje)         |           |
 *  | E2E_CLIENT_PERSON_OUTSIDE_CPF        | pessoa existente em `persons` SEM vinculo    | CA02/CA03 |
 *  |                                      | com nenhuma familia deste municipio          | CA04/CA07 |
 *  | E2E_CLIENT_PERSON_OUTSIDE_FULL_NAME  | nome REAL dessa pessoa de fora — usado APENAS| CA02      |
 *  |                                      | para provar que NAO aparece na tela           |           |
 *  | E2E_CLIENT_PERSON_OUTSIDE_BIRTH_DATE | nascimento correto dela (YYYY-MM-DD)         | CA03      |
 *  | E2E_CLIENT_PERSON_UNKNOWN_CPF        | CPF valido que NAO existe no repositorio     | CA05–CA08 |
 *  | E2E_CLIENT_FAMILY_IN_UNIT_CODE       | Codigo Familiar da familia do CRAS Centro    | CA03      |
 *  |                                      | (default `9900000001`, do seeder)            |           |
 *
 * O operador precisa do add-on LGPD `family_viewer` para VINCULAR (a acao e
 * sobre o prontuario) — o `E2E_CLIENT_OPERADOR_*` do seeder ja o tem.
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:5174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   E2E_CLIENT_PERSON_LOCAL_CPF=... E2E_CLIENT_PERSON_OUTSIDE_CPF=... \
 *   E2E_CLIENT_PERSON_OUTSIDE_BIRTH_DATE=... E2E_CLIENT_PERSON_UNKNOWN_CPF=... \
 *   npx playwright test tests/client/person-counter-registration.spec.ts
 */

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;

const LOCAL_CPF = process.env.E2E_CLIENT_PERSON_LOCAL_CPF;
const OUTSIDE_CPF = process.env.E2E_CLIENT_PERSON_OUTSIDE_CPF;
const OUTSIDE_NAME = process.env.E2E_CLIENT_PERSON_OUTSIDE_FULL_NAME;
const OUTSIDE_BIRTH = process.env.E2E_CLIENT_PERSON_OUTSIDE_BIRTH_DATE;
const UNKNOWN_CPF = process.env.E2E_CLIENT_PERSON_UNKNOWN_CPF;
const FAMILY_CODE = process.env.E2E_CLIENT_FAMILY_IN_UNIT_CODE ?? '9900000001';

const configured = Boolean(BASE && OPERADOR_CPF && OPERADOR_PASS);

/** Login por CPF + senha; seleciona o primeiro tenant quando solicitado. */
async function login(page: Page, cpf: string, password: string): Promise<void> {
  // Zera a sessão herdada do project `chromium-tenant` (storageState do
  // operador): sem isso o guard `redirectIfAuthenticated` desvia
  // /auth/login para /app e o formulário nunca aparece.
  await resetTenantSession(page);
  await page.locator('input#cpf, input[name="cpf"]').first().fill(cpf);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');

  if (page.url().includes('select-tenant')) {
    await page
      .getByRole('button', { name: /entrar|continuar|acessar|confirmar/i })
      .first()
      .click()
      .catch(() => {});
    await page.waitForLoadState('networkidle');
  }
}

async function searchByCpf(page: Page, cpf: string): Promise<void> {
  await page.goto('/app/cadastros/pesquisa-pessoas');
  await page.waitForLoadState('networkidle');
  await page.locator('#person-search-cpf').fill(cpf);
  await page.getByRole('button', { name: /pesquisar/i }).click();
  await page.waitForLoadState('networkidle');
}

test.describe('HU #10660 — balcao: localizar e cadastrar pessoa (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD no arquivo de env do e2e (o client nao e servido pela stack admin).',
  );

  test.use({ baseURL: BASE });

  test('CA01 — pessoa do municipio: o resultado de hoje, sem nenhum estado novo', async ({
    page,
  }) => {
    test.skip(!LOCAL_CPF, 'Defina E2E_CLIENT_PERSON_LOCAL_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, LOCAL_CPF!);

    // A tabela de triagem continua sendo a resposta — o payload do CA01 nao muda.
    await expect(page.locator('table')).toBeVisible();
    await expect(page.getByRole('button', { name: /visualizar família/i }).first()).toBeVisible();

    // Nenhum dos cartoes da #10660 aparece quando a pessoa e do municipio.
    await expect(page.getByTestId('global-person-exists')).toHaveCount(0);
    await expect(page.getByTestId('global-person-absent')).toHaveCount(0);
  });

  test('CA02 — existe fora do municipio: so a existencia, e NADA no DOM', async ({ page }) => {
    test.skip(!OUTSIDE_CPF, 'Defina E2E_CLIENT_PERSON_OUTSIDE_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, OUTSIDE_CPF!);

    const cartao = page.getByTestId('global-person-exists');
    await expect(cartao).toBeVisible();
    await expect(cartao).toContainText(/já está cadastrada na plataforma/i);
    await expect(page.getByTestId('global-person-link')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);

    // ⚠️ O CRITERIO desta HU no front: a assercao e sobre o HTML RENDERIZADO
    // da pagina inteira, nao sobre o texto visivel. Dado escondido em `title`,
    // `data-*` ou em no com display:none continua sendo vazamento.
    const html = await page.content();

    if (OUTSIDE_NAME) {
      expect(html).not.toContain(OUTSIDE_NAME);
    }
    if (OUTSIDE_BIRTH) {
      const [ano, mes, dia] = OUTSIDE_BIRTH.split('-');
      expect(html).not.toContain(OUTSIDE_BIRTH);
      expect(html).not.toContain(`${dia}/${mes}/${ano}`);
    }

    // Nem rotulo de dado que a RN02 proibe: se o rotulo existe, o valor veio junto.
    const textoCartao = (await cartao.innerText()).replace(/\s+/g, ' ');
    expect(textoCartao).not.toMatch(/nome da mãe|data de nascimento|endereço|município de origem/i);

    // O `person_ref` e token opaco: nao vai para a URL nem para a tela.
    expect(page.url()).not.toMatch(/person_ref|ref=/i);
    expect(html).not.toMatch(/person_ref/i);

    await page.screenshot({ path: 'test-results/10660-ca02-existe-fora.png', fullPage: true });
  });

  test('CA04 — confirmacao que nao confere: recusa generica, sem entregar pista', async ({
    page,
  }) => {
    test.skip(!OUTSIDE_CPF, 'Defina E2E_CLIENT_PERSON_OUTSIDE_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, OUTSIDE_CPF!);

    await page.getByTestId('global-person-link').click();
    await expect(page.getByTestId('confirm-identity-dialog')).toBeVisible();

    await page.locator('#confirm-family-code').fill(FAMILY_CODE);
    await page.getByTestId('confirm-locate-family').click();
    await expect(page.getByTestId('confirm-family-found')).toBeVisible();

    // Data deliberadamente errada.
    await page.getByTestId('confirm-value').fill('1900-01-01');
    await page.getByTestId('confirm-identity-submit').click();

    const erro = page.getByTestId('confirm-identity-error');
    await expect(erro).toBeVisible();
    await expect(erro).toContainText(/não confere/i);

    // A recusa nao pode virar oraculo: nem o valor correto, nem qual campo.
    const html = await page.content();
    if (OUTSIDE_BIRTH) {
      const [ano, mes, dia] = OUTSIDE_BIRTH.split('-');
      expect(html).not.toContain(OUTSIDE_BIRTH);
      expect(html).not.toContain(`${dia}/${mes}/${ano}`);
    }
    if (OUTSIDE_NAME) {
      expect(html).not.toContain(OUTSIDE_NAME);
    }

    await page.screenshot({ path: 'test-results/10660-ca04-nao-confere.png', fullPage: true });
  });

  test('CA03 — confirmacao correta vincula e so entao os dados aparecem', async ({ page }) => {
    test.skip(
      !(OUTSIDE_CPF && OUTSIDE_BIRTH),
      'Defina E2E_CLIENT_PERSON_OUTSIDE_CPF + E2E_CLIENT_PERSON_OUTSIDE_BIRTH_DATE.',
    );

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, OUTSIDE_CPF!);

    await page.getByTestId('global-person-link').click();
    await page.locator('#confirm-family-code').fill(FAMILY_CODE);
    await page.getByTestId('confirm-locate-family').click();
    await expect(page.getByTestId('confirm-family-found')).toBeVisible();

    await page.getByTestId('confirm-value').fill(OUTSIDE_BIRTH!);
    await page.getByTestId('confirm-identity-submit').click();
    await page.waitForLoadState('networkidle');

    // Vinculada, a pessoa passa a ser do municipio: a busca a traz pelo
    // caminho normal (CA01) — e ai sim com os dados visiveis.
    await expect(page.getByTestId('confirm-identity-dialog')).toHaveCount(0);
    await expect(page.locator('table')).toBeVisible();
    await expect(page.getByTestId('global-person-exists')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/10660-ca03-vinculada.png', fullPage: true });
  });

  test('CA05/CA06 — cadastro: nome da mae obrigatorio, CPF opcional', async ({ page }) => {
    test.skip(!UNKNOWN_CPF, 'Defina E2E_CLIENT_PERSON_UNKNOWN_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, UNKNOWN_CPF!);

    await expect(page.getByTestId('global-person-absent')).toBeVisible();
    await page.getByTestId('global-person-create').click();

    const form = page.getByTestId('person-create-form');
    await expect(form).toBeVisible();

    // O CPF pesquisado chega preenchido, e o campo NAO e obrigatorio: o
    // checkbox "Pessoa nao tem CPF" e o caminho de quem nao tem documento.
    await expect(page.getByTestId('without-cpf')).toBeVisible();

    await page.locator('#create-full-name').fill('E2E Pessoa Balcao');
    await page.locator('#create-birth-date').fill('1990-06-10');
    await page.getByTestId('create-sex-trigger').click();
    await page.getByRole('option').first().click();

    // CA06: salvar sem o nome da mae nao grava, e a tela diz POR QUE o dado
    // e exigido (prestacao de contas ao TCE-AL).
    await page.getByTestId('create-submit').click();
    const erroMae = page.getByTestId('mother-name-error');
    await expect(erroMae).toBeVisible();
    await expect(erroMae).toContainText(/TCE-AL/i);

    await page.screenshot({ path: 'test-results/10660-ca06-nome-mae.png', fullPage: true });

    // CA05: com o nome da mae, grava.
    await page.locator('#create-mother-name').fill('E2E Mae do Balcao');
    await page.getByTestId('create-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('person-create-form')).toHaveCount(0);
  });

  test('CA08 — sem CPF: semelhantes apresentados e confirmacao NUNCA pre-marcada', async ({
    page,
  }) => {
    test.skip(!UNKNOWN_CPF, 'Defina E2E_CLIENT_PERSON_UNKNOWN_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, UNKNOWN_CPF!);
    await page.getByTestId('global-person-create').click();

    // "Pessoa nao tem CPF" e declaracao explicita, nao campo esquecido.
    await page.getByTestId('without-cpf').click();
    await expect(page.locator('#create-cpf')).toBeDisabled();

    // Mesmo nome e nascimento da pessoa cadastrada no teste anterior —
    // e o que dispara a busca de semelhantes.
    await page.locator('#create-full-name').fill('E2E Pessoa Balcao');
    await page.locator('#create-birth-date').fill('1990-06-10');
    await page.locator('#create-mother-name').fill('E2E Mae do Balcao');
    await page.getByTestId('create-sex-trigger').click();
    await page.getByRole('option').first().click();
    await page.getByTestId('create-submit').click();
    await page.waitForLoadState('networkidle');

    const alerta = page.getByTestId('similar-persons-alert');
    await expect(alerta).toBeVisible();
    // A UNICA excecao a RN02 em toda a HU: nome + nascimento dos semelhantes.
    await expect(alerta).toContainText('E2E Pessoa Balcao');

    // Consentimento consciente: nasce DESMARCADO e bloqueia a gravacao.
    await expect(page.getByTestId('duplicate-confirmed')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    await expect(page.getByTestId('create-submit')).toBeDisabled();

    await page.screenshot({ path: 'test-results/10660-ca08-duplicidade.png', fullPage: true });

    // So depois da marcacao explicita a pessoa e criada, marcada como sem CPF.
    await page.getByTestId('duplicate-confirmed').click();
    await expect(page.getByTestId('create-submit')).toBeEnabled();
    await page.getByTestId('create-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('person-create-form')).toHaveCount(0);
  });

  test('CA07 — CPF ja cadastrado nao vira erro seco: leva a confirmacao de identidade', async ({
    page,
  }) => {
    test.skip(
      !(UNKNOWN_CPF && OUTSIDE_CPF),
      'Defina E2E_CLIENT_PERSON_UNKNOWN_CPF + E2E_CLIENT_PERSON_OUTSIDE_CPF.',
    );

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, UNKNOWN_CPF!);
    await page.getByTestId('global-person-create').click();

    // CPF de pessoa que JA existe no repositorio global.
    await page.locator('#create-cpf').fill(OUTSIDE_CPF!);
    await page.locator('#create-full-name').fill('E2E Homonimo');
    await page.locator('#create-birth-date').fill('1975-02-20');
    await page.locator('#create-mother-name').fill('E2E Mae Homonima');
    await page.getByTestId('create-sex-trigger').click();
    await page.getByRole('option').first().click();
    await page.getByTestId('create-submit').click();
    await page.waitForLoadState('networkidle');

    // O 409 vira CAMINHO: o dialogo de confirmacao de identidade abre...
    await expect(page.getByTestId('confirm-identity-dialog')).toBeVisible();
    // ...e continua sem revelar quem e a pessoa existente (RN02).
    const html = await page.content();
    if (OUTSIDE_NAME) {
      expect(html).not.toContain(OUTSIDE_NAME);
    }

    await page.screenshot({ path: 'test-results/10660-ca07-cpf-existente.png', fullPage: true });
  });

  test('CA11 — o fluxo de balcao nao oferece exclusao de pessoa em lugar nenhum', async ({
    page,
  }) => {
    test.skip(!UNKNOWN_CPF, 'Defina E2E_CLIENT_PERSON_UNKNOWN_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await searchByCpf(page, UNKNOWN_CPF!);
    await page.getByTestId('global-person-create').click();

    await expect(page.getByTestId('person-create-form')).toBeVisible();
    await expect(page.getByRole('button', { name: /excluir|remover/i })).toHaveCount(0);
  });
});
