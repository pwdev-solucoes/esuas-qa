import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/auth';
import type { ApiClient } from '../../fixtures/api-client';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence, captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-CAPAC-01 (épico HU-UNID-CAPAC) — cadastro global dos cinco tipos de ação
 * de capacitação e divulgação do leiaute 15.9 do SIAP, no Painel Global
 * (`admin/`, guard `manager`).
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que a TELA não oferece o que a regra proíbe. O Pest já garante que a API não
 * publica `store` e que o `DELETE` sempre responde 422; o que só o navegador
 * mostra é se a interface mesmo assim exibe um botão "Novo" ou um item
 * "Excluir" no menu — afordância que promete o que o sistema recusa. Por isso
 * as asserções centrais aqui são NEGATIVAS (`toHaveCount(0)`), e a recusa da
 * exclusão é verificada nos dois planos ao mesmo tempo: o status HTTP do
 * `DELETE` (422 + `error_code`) e o texto que a tela mostra em cima dele.
 *
 * E prova, também, que os três atributos que diferenciam um tipo do outro —
 * forma de contagem (CA02), obrigatoriedade no leiaute (CA03) e natureza
 * temporal (CA04) — estão visíveis na LISTAGEM, sem precisar abrir registro a
 * registro. É a "regra do número" que vai para a remessa do TCE-AL.
 *
 * ## Massa (pré-condição)
 *
 * A lista é FECHADA (D01/RN01): o backend **não expõe `store`**, então este
 * spec **não tem como criar a própria massa** — diferente dos specs irmãos de
 * lookup. Os cinco tipos vêm do `CapacitationActionTypeSeeder`, que hoje é
 * chamado pelo `DatabaseSeeder` e pelo `LocalDevSeeder`, mas **NÃO** pelo
 * `E2ESeeder` usado por `scripts/start-stack.sh`.
 *
 * Enquanto essa pendência de harness não for resolvida (chamar o seeder no
 * `E2ESeeder`, ou rodar `php artisan db:seed --class=CapacitationActionTypeSeeder`
 * depois do `stack:up`), cada caso aqui fica `skip` com a mensagem que diz o
 * comando — em vez de vermelho por falta de dado, que contaria a história
 * errada.
 *
 * Nada é criado nem apagado: os testes só editam status (inativar/reativar) e
 * devolvem o registro ao estado original no mesmo caso, para não deixar
 * resíduo na base de e2e.
 */
const SLUG = 'capacitation-action-types';

/**
 * Dossiê de aceite alimentado por ESTE spec (skill `acceptance-evidence-report`).
 * Os prints saem em `e2e/reports/<slug>-acceptance/screenshots/` e só quando
 * `CAPTURE_EVIDENCE=1` — ver `helpers/evidence.ts`.
 */
const EVIDENCE_SLUG = 'US-CAPAC-01-tipos-acao';

/**
 * Os cinco campos do XML `CapacitacaoDivulgacao`, na ordem do leiaute
 * (US-CAPAC-01 §6.3). Os rótulos são os do `admin/src/locales/pt-br/
 * capacitation-action-types.json` — mudou o rótulo, muda a prova.
 */
const LEIAUTE = [
  {
    code: '001',
    siapField: 'QuantidadePalestras',
    counting: /participações de profissionais/i,
    dateMode: /data única/i,
    layout: /obrigatório no leiaute/i,
  },
  {
    code: '002',
    siapField: 'QuantidadeReunioes',
    counting: /participações de profissionais/i,
    dateMode: /data única/i,
    layout: /opcional no leiaute/i,
  },
  {
    code: '003',
    siapField: 'QuantidadeReunioesInternas',
    counting: /eventos realizados/i,
    dateMode: /data única/i,
    layout: /opcional no leiaute/i,
  },
  {
    code: '004',
    siapField: 'QuantidadeEventos',
    counting: /participações de profissionais/i,
    dateMode: /data única/i,
    layout: /obrigatório no leiaute/i,
  },
  {
    code: '005',
    siapField: 'QuantidadeCursos',
    counting: /profissionais envolvidos/i,
    dateMode: /período/i,
    layout: /obrigatório no leiaute/i,
  },
] as const;

/**
 * Tipo escolhido para o vai-e-volta de inativação: NÃO é usado pelos specs do
 * client (que exercitam 001, 003 e 005). Se este caso morrer no meio, o
 * resíduo não derruba a suíte irmã.
 */
const TOGGLE_CODE = '002';

const SEED_HINT =
  `Os cinco tipos do leiaute 15.9 não estão na base. O E2ESeeder ainda não chama o ` +
  `CapacitationActionTypeSeeder — rode ` +
  `"php artisan db:seed --class=Database\\Seeders\\CapacitationActionTypeSeeder" na stack ` +
  `(ou inclua-o no E2ESeeder) e rode a suíte de novo.`;

/** Promessa do próximo GET da listagem — encadeie ANTES da ação que dispara. */
function waitForList(page: Page) {
  return page.waitForResponse(
    (res) =>
      res.url().includes(`/api/${SLUG}`) && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

function rows(page: Page) {
  return page.locator('table tbody tr');
}

/** A linha do tipo pelo `code` — o `data-code` da `<tr>` é a chave estável. */
function row(page: Page, code: string) {
  return page.locator(`table tbody tr[data-code="${code}"]`);
}

async function openRowMenu(page: Page, code: string): Promise<void> {
  await row(page, code).getByRole('button', { name: /mais ações/i }).click();
}

/**
 * Pré-condição de massa. Devolve os `code` semeados; vazio quando o cadastro
 * não está semeado (ou a rota não existe naquela stack).
 */
async function seededCodes(apiClient: ApiClient): Promise<string[]> {
  try {
    const res = await apiClient.get<{ data: Array<{ code: string }> }>(
      `/${SLUG}?per_page=100&sort=sort_order`,
    );

    return (res.data ?? []).map((item) => item.code);
  } catch {
    return [];
  }
}

async function goToList(page: Page): Promise<void> {
  const listRequest = waitForList(page);
  await page.goto(`/app/${SLUG}`);
  await dismissPlatformUpdates(page);
  const response = await listRequest;
  expect(response.status(), `GET /api/${SLUG} retornou ${response.status()}`).toBe(200);
  await expect(page.getByRole('main')).toBeVisible();
}

test.describe('US-CAPAC-01 · Tipos de Ação de Capacitação e Divulgação (admin)', () => {
  // Evidência do estado FINAL de cada caso aprovado. Sem `CAPTURE_EVIDENCE=1` o
  // corpo retorna na primeira linha e a suíte roda exatamente como antes.
  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA01 — os cinco tipos do leiaute aparecem na ordem do XML, sem porta de criação', async ({
    page,
    apiClient,
  }) => {
    const codes = await seededCodes(apiClient);
    test.skip(codes.length !== 5, SEED_HINT);

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await goToList(page);

    await expect(
      page.getByRole('heading', { name: /tipos de ação de capacitação e divulgação/i }),
    ).toBeVisible();

    // Exatamente cinco, na ordem do `sort_order` = ordem dos campos no XML.
    await expect(rows(page)).toHaveCount(5);

    const renderedCodes = await rows(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-code')),
    );
    expect(renderedCodes).toEqual(LEIAUTE.map((item) => item.code));

    const renderedFields = await rows(page)
      .locator('[data-testid="siap-field"]')
      .allInnerTexts();
    expect(renderedFields.map((text) => text.trim())).toEqual(
      LEIAUTE.map((item) => item.siapField),
    );

    // D01/RN01 — a tela DIZ que a lista é fechada e não oferece criação.
    await expect(page.getByTestId('closed-list-notice')).toContainText(
      /n[ãa]o podem ser criados nem exclu[íi]dos/i,
    );
    await expect(page.getByTestId('closed-list-notice')).toContainText(/inativad/i);
    await expect(page.getByRole('button', { name: /^nov[oa]\b/i })).toHaveCount(0);

    expect(
      consoleErrors,
      `console errors em /${SLUG}: ${consoleErrors.join(' | ')}`,
    ).toEqual([]);
  });

  test('CA02/CA03/CA04 — cada tipo mostra forma de contagem, natureza temporal e obrigatoriedade', async ({
    page,
    apiClient,
  }, testInfo) => {
    const codes = await seededCodes(apiClient);
    test.skip(codes.length !== 5, SEED_HINT);

    await goToList(page);

    // A "regra do número" é legível na LISTAGEM — sem abrir registro a registro.
    for (const item of LEIAUTE) {
      const line = row(page, item.code);
      await expect(line.getByTestId('counting-mode-badge')).toHaveText(item.counting);
      await expect(line.getByTestId('date-mode-badge')).toHaveText(item.dateMode);
      await expect(line.getByTestId('layout-requirement-badge')).toHaveText(item.layout);
    }

    // E o detalhe (edição) repete os mesmos três atributos, agora editáveis —
    // menos `code` e `sort_order`, que são a chave estável e a ordem do XML.
    await openRowMenu(page, '005');
    await page.getByRole('menuitem', { name: /^editar$/i }).click();

    await expect(page.locator('[aria-label="Forma de contagem"]')).toContainText(
      /profissionais envolvidos/i,
    );
    await expect(page.locator('[aria-label="Natureza temporal"]')).toContainText(/período/i);
    await expect(page.locator('[aria-label="Campo do leiaute (XML)"]')).toContainText(
      'QuantidadeCursos',
    );
    await expect(page.getByLabel('Obrigatório no leiaute')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // O detalhe some ao fechar o diálogo: a evidência dos três atributos
    // editáveis tem de sair AQUI, não no estado final do caso.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'detalhe-tipo-005');

    await expect(page.locator('#cat-code')).toHaveValue('005');
    await expect(page.locator('#cat-code')).toHaveAttribute('readonly', /.*/);
    await expect(page.locator('#cat-sort-order')).toHaveValue('5');
    await expect(page.locator('#cat-sort-order')).toHaveAttribute('readonly', /.*/);

    await page.getByRole('button', { name: /^cancelar$/i }).click();
  });

  test('CA06 — a exclusão é recusada com explicação que orienta inativar', async ({
    page,
    apiClient,
  }, testInfo) => {
    const codes = await seededCodes(apiClient);
    test.skip(codes.length !== 5, SEED_HINT);

    await goToList(page);

    // O menu não oferece o verbo que o sistema recusa: não existe "Excluir".
    await openRowMenu(page, '003');
    await expect(page.getByRole('menuitem', { name: /^excluir$/i })).toHaveCount(0);

    const deleteRequest = page.waitForResponse(
      (res) => res.url().includes(`/api/${SLUG}/`) && res.request().method() === 'DELETE',
      { timeout: 15_000 },
    );
    await page.getByRole('menuitem', { name: /por que n[ãa]o posso excluir/i }).click();

    // D05 — o `DELETE` existe e SEMPRE recusa, com o motivo declarado.
    const response = await deleteRequest;
    expect(response.status(), 'DELETE de tipo do leiaute nunca pode ser aceito').toBe(422);
    const body = (await response.json()) as { error_code?: string; message?: string };
    expect([
      'capacitation_action_type_in_use',
      'capacitation_action_type_layout_bound',
    ]).toContain(body.error_code);

    // E a tela mostra a explicação AUTORITATIVA do servidor, que aponta a
    // inativação como caminho legítimo.
    await expect(page.getByText(/este tipo n[ãa]o pode ser exclu[íi]do/i)).toBeVisible();
    // Regex bilíngue de propósito: o `SetLocale` da API resolve o idioma pelo
    // `Accept-Language` do navegador (o Chromium do Playwright manda en-US) e
    // NENHUM dos frontends envia `X-Locale`. Logo a UI fica em pt-BR e a
    // mensagem da API vem em inglês — inconsistência de plataforma, anterior a
    // esta HU e comum a todos os módulos. O que este caso prova é o
    // COMPORTAMENTO (recusa + orientação de inativar), não a tradução; travar o
    // idioma aqui esconderia o problema real dentro de um teste vermelho.
    await expect(page.getByTestId('deletion-reason')).toContainText(
      /pode ser inativado|can be deactivated/i,
    );

    // O diálogo da recusa é a evidência do CA06 — ele fecha no clique seguinte.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'dialogo-recusa');

    await page.getByRole('button', { name: /^entendi$/i }).click();

    // Nada foi apagado: os cinco continuam lá.
    await expect(rows(page)).toHaveCount(5);
    await expect(row(page, '003')).toBeVisible();
  });

  test('CA07 — inativar e reativar em massa, sem tirar o tipo do leiaute', async ({
    page,
    apiClient,
  }, testInfo) => {
    const codes = await seededCodes(apiClient);
    test.skip(codes.length !== 5, SEED_HINT);

    await goToList(page);

    const line = row(page, TOGGLE_CODE);
    // Badge de status pelo NOME EXATO: "Inativo" contém "ativo", e um regex
    // frouxo passaria nos dois estados.
    const statusBadge = (label: RegExp) => line.getByRole('button', { name: label });

    await expect(statusBadge(/^ativo$/i)).toBeVisible();

    // --- inativação em lote ---
    await line.getByRole('checkbox').first().click();
    let listRequest = waitForList(page);
    await page.getByRole('button', { name: /^inativar$/i }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: /^inativar$/i }).click();
    await listRequest;

    await expect(statusBadge(/^inativo$/i)).toBeVisible();
    // D06 — inativar não retira o campo do leiaute: a linha continua na lista.
    await expect(rows(page)).toHaveCount(5);
    await expect(line.getByTestId('siap-field')).toHaveText(
      LEIAUTE.find((item) => item.code === TOGGLE_CODE)!.siapField,
    );

    // O caso REVERTE a inativação para não deixar resíduo — o print do tipo
    // inativo (ainda no leiaute) precisa ser tirado antes da reativação.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'tipo-inativado');

    // --- reativação em lote (devolve a base ao estado original) ---
    await line.getByRole('checkbox').first().click();
    listRequest = waitForList(page);
    await page.getByRole('button', { name: /^ativar$/i }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: /^ativar$/i }).click();
    await listRequest;

    await expect(statusBadge(/^ativo$/i)).toBeVisible();
  });
});
