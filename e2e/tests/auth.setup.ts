import { test as setup } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LoginPage } from '../pages/LoginPage';

const STORAGE_DIR = path.resolve(__dirname, '..', '.auth');
const SUPER_ADMIN_STATE = path.join(STORAGE_DIR, 'super-admin.json');
const API_CLIENT_STATE = path.join(STORAGE_DIR, 'api-client.json');

setup('autentica super admin (UI) e propaga cookies para o api-client', async ({ page }) => {
  const cpf = process.env.E2E_ADMIN_CPF;
  const password = process.env.E2E_ADMIN_PASSWORD;

  if (!cpf || !password) {
    throw new Error(
      'E2E_ADMIN_CPF e E2E_ADMIN_PASSWORD precisam estar em e2e/.env.e2e ou no ambiente CI',
    );
  }

  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  // 1) Login via UI — gera esuas-session + XSRF-TOKEN.
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login(cpf, password);

  // 2) Persiste o storageState do browser (cookies + localStorage) — usado pelos
  //    testes UI via project chromium.
  await page.context().storageState({ path: SUPER_ADMIN_STATE });

  // 3) Replica os mesmos cookies (esuas-session, XSRF-TOKEN) em formato compatível
  //    com APIRequestContext do Playwright. Economiza 1 login dedicado para o
  //    api-client — crítico para evitar throttle 6/min nas rotas /auth/*.
  const browserState = await page.context().storageState();
  const apiState = {
    cookies: browserState.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
    origins: [],
  };
  fs.writeFileSync(API_CLIENT_STATE, JSON.stringify(apiState, null, 2));
});
