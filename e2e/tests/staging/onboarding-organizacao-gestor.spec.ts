import { test, expect, type Page } from '@playwright/test';
import { generateCnpj } from '../../helpers/cnpj';
import { generateCpf, maskCpf } from '../../helpers/cpf';
import { MailgwInbox } from '../../helpers/mailgw';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * Onboarding completo no STAGING: o Super Admin cadastra uma organização e um
 * gestor (Master) para ela; o gestor recebe os e-mails, define a senha, aceita
 * a Política de Privacidade e o Termo de Uso e entra no painel do tenant.
 *
 * Cada execução gera CPF, CNPJ, nomes e caixas de e-mail novos — nada colide com
 * execuções anteriores. O que é criado no staging NÃO é apagado (não há exclusão
 * de organização pela interface): os nomes levam o prefixo STG_DATA_PREFIX para
 * serem localizados e limpos depois.
 *
 * Configuração: `.env.staging` (modelo em `.env.staging.example`).
 * Rodar: `cd e2e && npm run e2e:staging`.
 */

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Variável ${name} não definida — veja .env.staging.example`);

  return value;
};

const ADMIN_URL = process.env.STG_ADMIN_URL ?? '';
const CLIENT_URL = process.env.STG_CLIENT_URL ?? '';
const MAIL_TIMEOUT = Number(process.env.STG_MAIL_TIMEOUT_MS ?? 120_000);

test.skip(!ADMIN_URL || !CLIENT_URL, 'STG_ADMIN_URL/STG_CLIENT_URL não configuradas (.env.staging)');

/** O staging derruba a sessão do admin em poucos minutos: refaz o login se cair. */
async function loginAdmin(page: Page): Promise<void> {
  await page.goto(`${ADMIN_URL}/auth/login`, { waitUntil: 'commit' });
  await page.getByRole('textbox', { name: 'CPF' }).fill(env('STG_ADMIN_CPF'));
  await page.getByRole('textbox', { name: 'Senha' }).fill(env('STG_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Acessar Sistema' }).click();
  await page.waitForURL('**/app**');
}

async function gotoAdmin(page: Page, path: string): Promise<void> {
  await page.goto(`${ADMIN_URL}${path}`, { waitUntil: 'commit' });
  const onLogin = await page
    .waitForURL('**/auth/login**', { timeout: 6_000 })
    .then(() => true)
    .catch(() => false);

  if (onLogin) {
    await loginAdmin(page);
    await page.goto(`${ADMIN_URL}${path}`, { waitUntil: 'commit' });
  }
}

test.describe('Staging — onboarding de organização e gestor', () => {
  let orgInbox: MailgwInbox;
  let managerInbox: MailgwInbox;

  test.beforeAll(async () => {
    orgInbox = await MailgwInbox.create('org');
    managerInbox = await MailgwInbox.create('gestor');
  });

  test.afterAll(async () => {
    await orgInbox?.dispose();
    await managerInbox?.dispose();
  });

  test('cadastra organização e gestor, define a senha, aceita os termos e entra no painel', async ({
    page,
    browser,
  }) => {
    const stamp = Date.now();
    const prefix = process.env.STG_DATA_PREFIX ?? 'E2E';
    const orgName = `${prefix} Org Teste ${stamp}`;
    const managerName = `${prefix} Gestor Teste ${stamp}`;
    const cpf = generateCpf();
    const cnpj = generateCnpj();
    const password = process.env.STG_MANAGER_PASSWORD ?? `Senha@E2E#${String(stamp).slice(-6)}`;

    let userUuid = '';

    await test.step('Super Admin entra no painel global', async () => {
      await loginAdmin(page);
      await expect(page).toHaveURL(/\/app/);
    });

    await test.step('Cadastra a organização', async () => {
      await gotoAdmin(page, '/app/tenants');
      await page.getByRole('button', { name: 'Nova Organização' }).click();

      const dialog = page.getByRole('dialog', { name: 'Nova Organização' });
      await dialog.getByRole('textbox', { name: 'Razão social *' }).fill(orgName);
      await dialog.getByRole('textbox', { name: 'CNPJ *' }).fill(cnpj);
      await dialog.getByRole('textbox', { name: 'E-mail *' }).fill(orgInbox.address);
      // O Status é obrigatório e começa vazio: sem escolher, o "Salvar" não envia.
      await dialog.getByRole('combobox', { name: 'Status *' }).click();
      await page.getByRole('option', { name: 'Ativo', exact: true }).click();
      await dialog.getByRole('button', { name: 'Salvar' }).click();

      await expect(page.getByText('Organização cadastrada com sucesso.')).toBeVisible();
      await expect(dialog).toBeHidden();
    });

    await test.step('Cadastra o gestor (CPF novo entra na Base Global)', async () => {
      await gotoAdmin(page, '/app/usuarios-organizacoes');
      await page.getByRole('button', { name: 'Novo Usuário' }).click();

      const dialog = page.getByRole('dialog', { name: 'Novo Usuário de Organização' });
      await dialog.getByRole('textbox', { name: 'CPF (login) *' }).fill(cpf);
      // CPF desconhecido: o formulário libera nome e nascimento para "inclusão automática".
      await expect(dialog.getByText(/CPF não encontrado na Base Global/)).toBeVisible();
      await dialog.getByRole('textbox', { name: 'Nome completo *' }).fill(managerName);
      // É um <input type="date">: o valor vai em ISO, não em dd/mm/aaaa.
      await dialog.getByRole('textbox', { name: 'Data de nascimento *' }).fill('1985-01-01');
      await dialog.getByRole('textbox', { name: 'E-mail *' }).fill(managerInbox.address);

      const created = page.waitForResponse(
        (res) => res.request().method() === 'POST' && /\/api\/users$/.test(res.url()),
      );
      await dialog.getByRole('button', { name: 'Salvar' }).click();
      const response = await created;
      expect(response.ok(), `POST /api/users respondeu ${response.status()}`).toBe(true);

      const body = (await response.json()) as { data?: { uuid?: string }; uuid?: string };
      userUuid = body.data?.uuid ?? body.uuid ?? '';
      expect(userUuid, 'a resposta de criação deve trazer o uuid do usuário').not.toBe('');
      await expect(dialog).toBeHidden();
    });

    await test.step('Vincula o gestor à organização com o perfil Master', async () => {
      // Vai direto ao detalhe pelo uuid: a busca da lista tem corrida (a listagem
      // inicial, sem filtro, pode chegar depois e sobrescrever o resultado filtrado).
      await gotoAdmin(page, `/app/usuarios/${userUuid}`);
      await page.getByRole('button', { name: 'Vínculos', exact: true }).click();
      await page.getByRole('button', { name: 'Adicionar vínculo' }).click();

      const dialog = page.getByRole('dialog', { name: 'Adicionar vínculo' });
      await dialog.getByRole('button', { name: 'Selecione a organização...' }).click();
      await page.getByPlaceholder(/buscar|pesquis/i).last().fill(orgName);
      await page.getByRole('option', { name: new RegExp(orgName) }).click();
      await dialog.getByRole('combobox', { name: 'Perfil *' }).click();
      await page.getByRole('option', { name: 'Master', exact: true }).click();
      await dialog.getByRole('button', { name: 'Adicionar', exact: true }).click();

      await expect(dialog).toBeHidden();
      await expect(page.getByText(orgName)).toBeVisible();
      await expect(page.getByText('1 perfil')).toBeVisible();
    });

    let setPasswordUrl = '';

    await test.step('Recebe os e-mails de boas-vindas e de definição de senha', async () => {
      const welcome = await managerInbox.waitForMessage({ subject: /bem-vindo/i, timeoutMs: MAIL_TIMEOUT });
      expect(welcome.from.address).toContain('@');

      const setup = await managerInbox.waitForMessage({ subject: /defina sua senha/i, timeoutMs: MAIL_TIMEOUT });
      setPasswordUrl = MailgwInbox.extractUrl(setup, 'reset-password');
      expect(setPasswordUrl).toContain('token=');
    });

    // Contexto separado: admin e client usam a mesma API e as sessões não devem se misturar.
    const clientContext = await browser.newContext();
    const client = await clientContext.newPage();

    try {
      await test.step('Gestor define a senha pelo link do e-mail', async () => {
        await client.goto(setPasswordUrl, { waitUntil: 'commit' });
        const fields = client.locator('input[type="password"]');
        await fields.first().waitFor();
        for (let i = 0; i < (await fields.count()); i++) await fields.nth(i).fill(password);
        await client.locator('button[type="submit"]').click();

        await expect(client.getByText(/Senha redefinida com sucesso/)).toBeVisible();
        await expect(client).toHaveURL(/\/auth\/login/);
      });

      await test.step('Gestor entra no painel do tenant e aceita os termos', async () => {
        await client.getByRole('textbox', { name: 'CPF' }).fill(maskCpf(cpf));
        await client.getByRole('textbox', { name: 'Senha' }).fill(password);
        await client.getByRole('button', { name: 'Acessar Sistema' }).click();

        await client.waitForURL(/legal-acceptance/);
        await expect(client.getByText(`Organização · ${orgName}`).first()).toBeVisible();

        // Política de Privacidade → Termo de Uso → "Aceite registrado" → painel.
        for (let screen = 0; screen < 4 && /legal-acceptance/.test(client.url()); screen++) {
          const enter = client.getByRole('button', { name: /^Entrar no/ });
          if (await enter.isVisible().catch(() => false)) {
            await enter.click();
          } else {
            // O aceite só libera ao ler o documento até o fim. Em janela pequena o texto é
            // rolável e aparece o botão "Role até o final…", que o próprio app usa para
            // levar o documento ao fim; em janela grande o botão nem existe.
            const scrollHint = client.getByRole('button', { name: /Role até o final/ });
            if (await scrollHint.isVisible().catch(() => false)) {
              await scrollHint.click();
              await expect(scrollHint).toBeHidden();
            }
            // Checkbox customizado (label sem role): o botão só habilita depois dele.
            await client.getByText(/Li e aceito/).click();
            const accept = client.getByRole('button', { name: /^Aceitar e/ });
            await expect(accept).toBeEnabled();
            await accept.click();
          }
          await client.waitForTimeout(1_500);
        }

        await expect(client).toHaveURL(/\/app/);
        await dismissPlatformUpdates(client);
        await expect(client).not.toHaveURL(/legal-acceptance|auth\/login/);
      });
    } finally {
      await clientContext.close();
    }
  });
});
