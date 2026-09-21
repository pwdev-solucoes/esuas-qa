import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence, captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-BENEF-01 — os seis tipos de benefício eventual do bloco 12 do
 * instrumento Prontuário SUAS, no Painel de Administração Global (`admin/`,
 * guard `manager`). Rota `/app/eventual-benefit-types`, permissão
 * `eventual-benefit-types.index`.
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que a regra de apuração — para qual dos quatro contadores do leiaute 15.6
 * cada tipo soma — e os dois campos condicionais (RN03/D04) **chegam aos
 * olhos do Administrador**, na LISTAGEM, sem abrir registro a registro. O
 * Pest já garante que o Resource devolve `remittance_counter_label` pronto e
 * que os dois condicionais são mutuamente exclusivos no backend; o que só o
 * navegador mostra é se a TELA renderiza essa matriz corretamente, item a
 * item — trocar o contador de um único tipo no cadastro global muda números
 * declarados ao TCE-AL **de todos os municípios**. Por isso o CA02 é
 * verificado com seis checagens na tela, não uma amostra.
 *
 * ## Massa (pré-condição)
 *
 * Os seis tipos vêm do `EventualBenefitTypeSeeder`, chamado pelo `E2ESeeder`
 * (usado por `scripts/start-stack.sh`). Massa ausente aqui **não vira
 * `skip`**: significa harness quebrado, e um caso pulado em silêncio contaria
 * a história errada.
 *
 * ## Estado
 *
 * Nada é criado, alterado nem apagado — todos os casos são de leitura (o
 * caso do CA08 abre e fecha o diálogo de exclusão sem confirmar).
 *
 * ## NÃO COBERTO — CA08 (recusa real da exclusão de item em uso)
 *
 * A trava de uso (`EventualBenefitTypeUsageService`) consulta a tabela
 * `family_eventual_benefits`, que a US-BENEF-02 já criou nesta branch — mas
 * o `E2ESeeder` **não** semeia nenhuma concessão nela. Ou seja: hoje, para
 * QUALQUER um dos seis tipos, `isInUse()` responde `false` e um `DELETE` de
 * verdade teria sucesso (204) — apagaria massa real do E2E, usada por outros
 * specs da fase (CA01/CA02/CA04/CA05/CA06 deste mesmo arquivo, entre
 * outros). Forçar a exclusão para "provar" o 422 é o caminho inverso: sem
 * uso real, ela não vai recusar — vai apagar.
 *
 * O que ESTE spec prova, honestamente, é o caminho que existe sem risco à
 * massa: a afordância de exclusão existe (RN05 não esconde o verbo, ao
 * contrário das listas FECHADAS como `capacitation-action-types`) e o
 * diálogo de confirmação abre com o código/nome corretos — sem clicar em
 * "Excluir" dentro dele, o que dispararia o `DELETE` real. O 422
 * `eventual_benefit_type_in_use` e a orientação de inativar (o texto que a
 * `DeleteEventualBenefitTypeDialog` mostra quando o backend recusa) estão
 * cobertos, de ponta a ponta, por
 * `api/tests/Feature/Api/Manager/EventualBenefitTypeTest.php` — o teste
 * `refuses to delete a type in use with 422 eventual_benefit_type_in_use,
 * guiding deactivation (CA08)` e o par que repete a asserção contra a tabela
 * real `family_eventual_benefits`.
 */
const SLUG = 'eventual-benefit-types';

/**
 * Dossiê de aceite alimentado por ESTE spec (skill `acceptance-evidence-report`).
 * Os prints saem em `e2e/reports/<slug>-acceptance/screenshots/` e só quando
 * `CAPTURE_EVIDENCE=1` — ver `helpers/evidence.ts`.
 */
const EVIDENCE_SLUG = 'us-benef-01-tipos-beneficio';

const ADMIN_BASE = process.env.E2E_BASE_URL;

/**
 * A matriz do `EventualBenefitTypeSeeder` — a fonte da verdade desta HU.
 * `counter` é um trecho estável do rótulo pronto do backend
 * (`remittance_counter_label`, ver `SiapBenefitCounter::label()`); os dois
 * condicionais e `requiresDescription` são o RN03/D04/D05 como dado do item.
 */
const TYPES = [
  {
    code: '1',
    name: 'Auxílio Natalidade',
    counter: /Auxílio natalidade/i,
    requiresBirthRegistration: true,
    requiresDeceasedCpf: false,
    requiresDescription: false,
  },
  {
    code: '2',
    name: 'Auxílio Funeral',
    counter: /Auxílio funeral/i,
    requiresBirthRegistration: false,
    requiresDeceasedCpf: true,
    requiresDescription: false,
  },
  {
    code: '3',
    name: 'Item ou kit específico para enfrentamento de situações de emergência ou calamidade pública',
    counter: /Outros benefícios/i,
    requiresBirthRegistration: false,
    requiresDeceasedCpf: false,
    requiresDescription: false,
  },
  {
    code: '4',
    name: 'Cesta Básica',
    counter: /Auxílio alimentação/i,
    requiresBirthRegistration: false,
    requiresDeceasedCpf: false,
    requiresDescription: false,
  },
  {
    code: '5',
    name: 'Aluguel social ou pagamento de aluguel',
    counter: /Outros benefícios/i,
    requiresBirthRegistration: false,
    requiresDeceasedCpf: false,
    requiresDescription: false,
  },
  {
    code: '6',
    name: 'Outros',
    counter: /Outros benefícios/i,
    requiresBirthRegistration: false,
    requiresDeceasedCpf: false,
    requiresDescription: true,
  },
] as const;

/** Tipo usado no vai-e-volta do diálogo de exclusão (CA08) — não é usado por nenhum outro caso. */
const DELETE_DIALOG_CODE = '5';

/** Promessa do próximo GET da listagem — encadeie ANTES da navegação que dispara. */
function waitForList(page: Page) {
  return page.waitForResponse(
    (res) => res.url().includes(`/api/${SLUG}`) && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

function rows(page: Page) {
  return page.locator('table tbody tr');
}

/** A linha do tipo pelo `code` — `ebt-row-<code>` é o `data-testid` estável da `<tr>`. */
function row(page: Page, code: string) {
  return page.getByTestId(`ebt-row-${code}`);
}

async function openRowMenu(page: Page, code: string): Promise<void> {
  await row(page, code).getByTestId('ebt-actions-trigger').click();
}

async function goToList(page: Page): Promise<void> {
  const listRequest = waitForList(page);
  await page.goto(`/app/${SLUG}`);
  await dismissPlatformUpdates(page);
  const response = await listRequest;
  expect(response.status(), `GET /api/${SLUG} retornou ${response.status()}`).toBe(200);
  await expect(page.getByRole('main')).toBeVisible();
}

test.describe('US-BENEF-01 · Tipos de Benefício Eventual (admin)', () => {
  test.skip(!ADMIN_BASE, 'Defina E2E_BASE_URL para rodar contra o admin.');

  // Evidência do estado FINAL de cada caso aprovado. Sem `CAPTURE_EVIDENCE=1`
  // o corpo retorna na primeira linha e a suíte roda exatamente como antes.
  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA01 — os seis tipos aparecem com os códigos 1 a 6 do instrumento, sem renumeração', async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await goToList(page);

    await expect(
      page.getByRole('heading', { name: /tipos de benefício eventual/i }),
    ).toBeVisible();

    await expect(page.getByTestId('ebt-table')).toBeVisible();

    // Exatamente seis — a lista não tem mais nem menos que o bloco 12.
    await expect(rows(page)).toHaveCount(6);

    for (const item of TYPES) {
      const line = row(page, item.code);
      await expect(line, `linha do código ${item.code} não encontrada`).toBeVisible();
      await expect(line.getByTestId('ebt-code-cell')).toHaveText(item.code);
      await expect(line.getByTestId('ebt-name-cell')).toHaveText(item.name);
    }

    // Nenhum código fora de '1'..'6': a lista não é renumerada nem estendida.
    for (const absent of ['0', '7', '8', '9', '10']) {
      await expect(
        row(page, absent),
        `código ${absent} NÃO deve existir — a lista tem exatamente seis itens`,
      ).toHaveCount(0);
    }

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'listagem-seis-tipos');

    expect(consoleErrors, `console errors em /${SLUG}: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('CA02 — a regra de apuração do leiaute 15.6 confere item a item na listagem', async ({
    page,
  }, testInfo) => {
    await goToList(page);

    // A asserção mais importante do spec: os SEIS contadores, um a um — não
    // uma amostra. Um atributo marcado por engano no painel global muda
    // números declarados ao TCE-AL de todos os municípios.
    for (const item of TYPES) {
      await expect(
        row(page, item.code).getByTestId('ebt-badge-counter'),
        `código ${item.code} · contador de apuração`,
      ).toHaveText(item.counter);
    }

    // Contagem por contador: natalidade e funeral aparecem uma vez cada
    // (códigos '1' e '2'); "Outros benefícios" aparece três vezes ('3','5','6');
    // "Auxílio alimentação" aparece uma vez (a inferência D10 do código '4').
    const counterTexts = await page.locator('[data-testid="ebt-badge-counter"]').allInnerTexts();
    expect(counterTexts.filter((t) => /Auxílio natalidade/i.test(t))).toHaveLength(1);
    expect(counterTexts.filter((t) => /Auxílio funeral/i.test(t))).toHaveLength(1);
    expect(counterTexts.filter((t) => /Auxílio alimentação/i.test(t))).toHaveLength(1);
    expect(counterTexts.filter((t) => /Outros benefícios/i.test(t))).toHaveLength(3);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'matriz-contadores');
  });

  test('CA04/CA05 — só o tipo 1 exige registro de nascimento, e só o tipo 2 exige o CPF do falecido', async ({
    page,
  }, testInfo) => {
    await goToList(page);

    for (const item of TYPES) {
      const line = row(page, item.code);

      await expect(
        line.getByTestId('ebt-badge-birth-registration'),
        `código ${item.code} · exige registro de nascimento`,
      ).toHaveCount(item.requiresBirthRegistration ? 1 : 0);

      await expect(
        line.getByTestId('ebt-badge-deceased-cpf'),
        `código ${item.code} · exige CPF do falecido`,
      ).toHaveCount(item.requiresDeceasedCpf ? 1 : 0);
    }

    // Cada condicional é EXCLUSIVO de um único tipo na tela inteira — não é
    // "o mais comum", é o ÚNICO.
    await expect(page.locator('[data-testid="ebt-badge-birth-registration"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="ebt-badge-deceased-cpf"]')).toHaveCount(1);

    // E o detalhe (edição) do tipo 1 mostra o toggle correspondente ligado,
    // com o irmão desligado — a mesma exclusividade mútua do backend (RN03).
    await openRowMenu(page, '1');
    await page.getByTestId('ebt-action-edit').click();

    await expect(page.getByTestId('ebt-birth-registration')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('ebt-deceased-cpf')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('ebt-code-readonly')).toHaveValue('1');
    await expect(page.getByTestId('ebt-code-readonly')).toHaveAttribute('readonly', /.*/);

    // O detalhe some ao fechar o Sheet: a evidência do toggle ligado tem de
    // sair AQUI, não no estado final do caso.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'detalhe-natalidade');

    await page.getByTestId('ebt-cancel').click();
    await expect(page.getByTestId('ebt-birth-registration')).toHaveCount(0);

    // E o do tipo 2: o CPF do falecido ligado, o registro de nascimento desligado.
    await openRowMenu(page, '2');
    await page.getByTestId('ebt-action-edit').click();

    await expect(page.getByTestId('ebt-deceased-cpf')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('ebt-birth-registration')).toHaveAttribute(
      'aria-checked',
      'false',
    );

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'detalhe-funeral');

    await page.getByTestId('ebt-cancel').click();
    await expect(page.getByTestId('ebt-deceased-cpf')).toHaveCount(0);
  });

  test('CA06 — os demais tipos não exigem campo adicional, e só o tipo 6 exige a observação', async ({
    page,
  }, testInfo) => {
    await goToList(page);

    for (const item of TYPES) {
      const line = row(page, item.code);

      await expect(
        line.getByTestId('ebt-badge-requires-description'),
        `código ${item.code} · exige descrição`,
      ).toHaveCount(item.requiresDescription ? 1 : 0);
    }

    // "Outros" (código '6') é o único tipo com QUALQUER campo condicional
    // ligado — nem registro de nascimento, nem CPF do falecido, só a descrição.
    const outros = row(page, '6');
    await expect(outros.getByTestId('ebt-badge-birth-registration')).toHaveCount(0);
    await expect(outros.getByTestId('ebt-badge-deceased-cpf')).toHaveCount(0);
    await expect(outros.getByTestId('ebt-badge-requires-description')).toHaveCount(1);

    // E os três tipos '3', '4', '5' não têm badge condicional nenhuma — nem
    // registro de nascimento, nem CPF do falecido, nem descrição.
    for (const code of ['3', '4', '5']) {
      const line = row(page, code);
      await expect(line.getByTestId('ebt-badge-birth-registration')).toHaveCount(0);
      await expect(line.getByTestId('ebt-badge-deceased-cpf')).toHaveCount(0);
      await expect(line.getByTestId('ebt-badge-requires-description')).toHaveCount(0);
    }

    // O selo de descrição é exclusivo do '6' na tela inteira.
    await expect(page.locator('[data-testid="ebt-badge-requires-description"]')).toHaveCount(1);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'tipo-outros-exige-descricao');
  });

  test('CA08 — a exclusão oferece a afordância e o diálogo de confirmação, sem apagar massa do E2E', async ({
    page,
  }, testInfo) => {
    await goToList(page);

    // A afordância de exclusão EXISTE (RN05 não é lista fechada como
    // `capacitation-action-types`: aqui o backend publica `store`/`destroy`
    // de verdade, só recusa quando há uso real).
    await openRowMenu(page, DELETE_DIALOG_CODE);
    await expect(page.getByTestId('ebt-action-delete')).toBeVisible();
    await page.getByTestId('ebt-action-delete').click();

    // O diálogo é a PRÓPRIA confirmação (não dispara o DELETE ainda): mostra
    // código e nome do item, para o Administrador conferir antes de agir.
    const dialog = page.getByTestId('ebt-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      TYPES.find((t) => t.code === DELETE_DIALOG_CODE)!.name,
    );
    await expect(dialog).toContainText(DELETE_DIALOG_CODE);
    // Ainda não houve recusa (nenhum DELETE foi disparado): o painel de
    // recusa/orientação de inativar não existe neste ponto.
    await expect(page.getByTestId('ebt-delete-refusal')).toHaveCount(0);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'dialogo-confirmacao-exclusao');

    // ⚠️ NÃO clicamos em "ebt-delete-confirm": ver o docblock do arquivo — a
    // massa do E2E não tem nenhuma concessão registrada em
    // `family_eventual_benefits`, então o DELETE real teria sucesso (204) e
    // apagaria um dos seis tipos usados pelos outros casos desta suíte. O
    // 422 `eventual_benefit_type_in_use` + a orientação de inativar são
    // exercitados de ponta a ponta por
    // `api/tests/Feature/Api/Manager/EventualBenefitTypeTest.php`.
    await page.getByTestId('ebt-delete-cancel').click();
    await expect(dialog).toHaveCount(0);

    // Nada foi apagado: os seis continuam lá.
    await expect(rows(page)).toHaveCount(6);
    await expect(row(page, DELETE_DIALOG_CODE)).toBeVisible();
  });
});
