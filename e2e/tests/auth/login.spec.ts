import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';

// Estes testes precisam começar deslogados — sobrescreve storageState do projeto.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login Super Admin', () => {
  test('login válido redireciona para /app', async ({ page }) => {
    const cpf = process.env.E2E_ADMIN_CPF!;
    const password = process.env.E2E_ADMIN_PASSWORD!;

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(cpf, password);

    await expect(page).toHaveURL(/\/app(\/|$)/);
  });

  test('credencial inválida exibe erro', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.fillCredentials('44983702016', 'senha-errada-de-proposito');
    await loginPage.submit();

    await loginPage.expectError();
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('CPF inválido bloqueia submit sem chamar API', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.fillCredentials('111.111.111-11', 'qualquer');
    await loginPage.submit();

    await loginPage.expectError(/cpf/i);
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('"lembrar-me" persiste CPF entre sessões', async ({ page, context }) => {
    const cpf = process.env.E2E_ADMIN_CPF!;
    const password = process.env.E2E_ADMIN_PASSWORD!;

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(cpf, password, { remember: true });

    // Abre uma nova aba logada e verifica que o CPF persistido aparece no input.
    await context.clearCookies();
    const newPage = await context.newPage();
    const fresh = new LoginPage(newPage);
    await fresh.goto();

    const cpfDigits = await fresh.cpfInput.inputValue();
    expect(cpfDigits.replace(/\D/g, '')).toBe(cpf.replace(/\D/g, ''));
  });
});
