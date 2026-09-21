# Moldes de spec

Dois esqueletos, destilados dos arquivos canônicos. Copie a **forma**, nunca o conteúdo.

- Admin: `e2e/tests/lookups/capacitation-action-types.spec.ts` (351 linhas)
- Client: `e2e/tests/client/family-intake.spec.ts` (estrutura) + `e2e/tests/client/family-follow-up.spec.ts`
  (massa via API, serial, multi-perfil)

Tamanho saudável: 170–350 linhas. Passou muito disso, provavelmente há dois assuntos no mesmo arquivo.

## Cabeçalho (obrigatório nos dois)

```ts
/**
 * US-XXXX-NN (épico HU-...) — <assunto> no <Painel Global (admin) | Painel do Tenant (client)>.
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * <2 a 6 linhas. Diga a coisa concreta: que a TELA não oferece o que a regra proíbe; que a
 * recusa chega ao usuário com orientação, em vez de morrer num toast genérico; que o filtro
 * do select honra o vínculo. Se você não consegue escrever esta seção, o critério provavelmente
 * é de Pest.>
 *
 * ## Massa (pré-condição)
 *
 * <O que vem do seeder e o que este spec cria via API. Se algo só o seeder cria e ele não
 * chama, diga o comando exato e como o caso se comporta (skip ou falha com dica).>
 *
 * ⚠️ HARNESS: o project `<chromium | chromium-tenant>` já entrega `page` autenticado como
 * `<E2E_ADMIN_* | E2E_CLIENT_OPERADOR_*>`. Nenhum cenário aqui faz login — as rotas `/auth/*`
 * têm throttle de 6 req/min.
 *
 * ⚠️ ESTADO: <o que persiste entre execuções e como o spec continua re-executável.>
 */
```

## Molde — admin (`tests/<área>/<assunto>.spec.ts`)

```ts
import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/auth';
import type { ApiClient } from '../../fixtures/api-client';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureFinalEvidence } from '../../helpers/evidence';

const SLUG = '<recurso-da-api>';
/** Dossiê alimentado por este spec; prints só com CAPTURE_EVIDENCE=1. */
const EVIDENCE_SLUG = 'US-XXXX-NN-<assunto>';

/** A expectativa do instrumento, declarada como dado — muda o rótulo, muda a prova. */
const ESPERADO = [
  { code: '001', rotulo: /…/i },
] as const;

const SEED_HINT =
  `A massa de "${SLUG}" não está na base. Rode ` +
  `"php artisan db:seed --class=Database\\Seeders\\<XSeeder>" no container da API e repita.`;

/** Promessa do próximo GET da listagem — encadeie ANTES da ação que dispara. */
function waitForList(page: Page) {
  return page.waitForResponse(
    (res) => res.url().includes(`/api/${SLUG}`) && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

async function goToList(page: Page) {
  const list = waitForList(page);
  await page.goto(`/app/${SLUG}`);
  await list;
  await dismissPlatformUpdates(page);          // sem isto, getByRole cega no modal
}

test.describe('US-XXXX-NN · <assunto> (admin)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA01 — <o que a tela prova>', async ({ page, apiClient }) => {
    const codes = await seededCodes(apiClient);
    test.skip(codes.length !== ESPERADO.length, SEED_HINT);

    await goToList(page);

    await expect(page.locator('table tbody tr')).toHaveCount(ESPERADO.length);
    await expect(page.getByRole('button', { name: /^nov[oa]\b/i })).toHaveCount(0);  // afordância negada
  });
});
```

## Molde — client (`tests/client/<assunto>.spec.ts`)

```ts
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createTenantApiClient } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_WORK = process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID;
const UNIT_UUID = process.env.E2E_CLIENT_UNIT_UUID;
const configured = Boolean(BASE && FAMILY_WORK && UNIT_UUID);

let api: APIRequestContext;
let xsrf = '';

test.beforeAll(async () => {
  if (!configured) return;

  api = await createTenantApiClient();
  const state = await api.storageState();
  xsrf = decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  expect(xsrf, 'XSRF-TOKEN da sessão de tenant').not.toBe('');

  // Uuid gerado pelo seeder NUNCA se fixa — o estável é o `code`.
  const options = await api.get(`/api/client/families/${FAMILY_WORK}/<recurso>/options`);
  expect(options.status(), 'options do recurso').toBe(200);

  // Massa idempotente: 409 = já semeado por execução anterior.
  const created = await api.post(`/api/client/families/${FAMILY_WORK}/<recurso>`, {
    headers: { 'X-XSRF-TOKEN': xsrf },
    data: { /* … */ },
  });
  expect([201, 409]).toContain(created.status());
});

test.afterAll(async () => { await api?.dispose(); });

/** Abre o prontuário direto na aba (a aba é sincronizada com ?tab=). */
async function openTab(page: Page, uuid: string, tab: string) {
  await page.goto(`/app/cadastros/familias/${uuid}?tab=${tab}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId('<bloco>-block')).toBeVisible();
}

test.describe('US-XXXX-NN — <assunto> (client)', () => {
  test.skip(!configured, 'Defina CLIENT_BASE_URL + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_UNIT_UUID.');

  // Só quando o estado de um caso é pré-requisito do outro.
  test.describe.configure({ mode: 'serial' });

  // locale NÃO é cosmético: as mensagens 409/422 vêm do backend por Accept-Language.
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test('CA01 — <o que a tela prova>', async ({ page }) => {
    await openTab(page, FAMILY_WORK!, '<aba>');

    const saved = page.waitForResponse((r) =>
      r.url().includes('/<recurso>') && r.request().method() === 'POST');
    await page.getByTestId('<x>-submit').click();
    expect((await saved).status()).toBe(201);

    // Dupla prova: a tela mostra…
    await expect(page.getByTestId('<x>-row')).toContainText('…');
    // …e o dado persistiu.
    const list = await api.get(`/api/client/families/${FAMILY_WORK}/<recurso>`);
    expect((await list.json()).data).toHaveLength(1);
  });
});
```

## Multi-perfil (quando o CA exige outro usuário)

```ts
const other = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
await loginAsTenantUser(other, MASTER_CPF!, MASTER_PASSWORD!, { tenantUuid: TENANT_UUID });
await dismissPlatformUpdates(other);
// … e feche no fim: await other.close();
```

⚠️ O login de outro perfil **derruba a sessão herdada** do project. Semeie toda a massa que precisa da
sessão do operador **antes** de logar como Master, e lembre do throttle de 6 logins por minuto.
