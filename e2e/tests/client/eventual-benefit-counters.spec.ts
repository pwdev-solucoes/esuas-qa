import { expect, test, type Page } from '@playwright/test';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence } from '../../helpers/evidence';
import { loginAsTenantUser, TENANT_UUID } from '../../fixtures/tenant-auth';

/**
 * US-BENEF-03 (épico HU #10711, fase F5) — os QUATRO últimos contadores do
 * leiaute 15.6 na Apuração de Atendimentos: auxílio alimentação, auxílio
 * natalidade, auxílio funeral e outros benefícios, derivados das concessões
 * de benefício eventual (`family_eventual_benefits`). Com esta fase o
 * leiaute 15.6 FECHA — `eventual_benefits` sai de `unavailable_counters`.
 *
 * ⚠️ SESSÃO: a apuração é gated pela permissão RESTRITA
 * `attendance-reports.view` (`api/routes/api/client.php`), que o Operacional
 * do `chromium-tenant` (herdado via `.auth/tenant.json`) NÃO tem — só o
 * Master a possui por padrão (`MASTER_RESTRICTED_GRANTS`). Por isso este
 * spec NÃO usa a `page` herdada: abre UMA sessão própria de Master no
 * `beforeAll`, do mesmo molde do bloco "US-ACOMP-05"/"US-SCFV-03" em
 * `family-follow-up.spec.ts` — um único login para o arquivo inteiro, nunca
 * caso a caso (throttle `6,1` das rotas `/auth/*`).
 *
 * ## O que este spec prova, e que a suíte de backend não prova
 *
 * Que os QUATRO números chegam à tela ACOMPANHADOS da natureza que os torna
 * comparáveis (ou não) aos vizinhos do MESMO leiaute 15.6. O leiaute 15.6
 * mistura três naturezas de contagem diferentes:
 *
 *   - `cadunico_inclusion`/`cadunico_update` somam FAMÍLIAS distintas;
 *   - `bpc_referrals` soma PESSOAS distintas;
 *   - os QUATRO de benefício eventual (`food_assistance`, `birth_assistance`,
 *     `funeral_assistance`, `other_benefits`) somam CONCESSÕES (linhas).
 *
 * Um gestor que leia sete números soltos e some tudo — ou compare o auxílio
 * alimentação com as famílias encaminhadas ao CadÚnico — está comparando
 * coisas que não são a mesma coisa. É isso que o CA03 exige visível na tela,
 * e é o núcleo deste spec.
 *
 * E prova a AUSÊNCIA que a HU exige (CA09): o leiaute 15.6 fechou, então não
 * pode sobrar painel de "contadores indisponíveis" nesta tela — nem para o
 * benefício eventual, nem, por tabela, o `data-testid="unavailable-counters"`
 * inteiro deixa de existir no DOM (o `E2ESeeder` já tem as fases F1-F5
 * completas: nada mais depende de fase futura).
 *
 * ## Massa
 *
 * O `E2EProntuarioSeeder` NÃO cria nenhuma linha em
 * `family_eventual_benefits` diretamente — mas a base do E2E é PERSISTENTE e
 * compartilhada com outros specs do mesmo épico (que registram concessões de
 * verdade PELO PRONTUÁRIO, fora daqui): rodando esta suíte contra uma base já
 * exercitada, a "E2E CRAS Centro" pode legitimamente trazer concessões
 * reais (ex.: auxílio alimentação > 0) acumuladas de execuções anteriores.
 * Por isso NENHUMA asserção deste spec fixa um valor exato — CA01 exige só
 * que o contador esteja ACESO (`available: true`, número, nunca travessão),
 * o que vale tanto para 0 quanto para um valor real. A "E2E CRAS Sem MDS"
 * (`UNIT_SEM_MDS`) é a unidade reservada ao CA10: nenhum spec deste épico
 * registra benefício eventual nela, e o caso se defende com `test.skip` (like
 * `capacitation-tallies.spec.ts`) se algum dia ela vier suja.
 * A aritmética exata das concessões e a distinção entre as três naturezas NO
 * SERVIÇO (Model/DB) são cobertas pelos 144 testes de
 * `AttendanceReportEventualBenefitTest` e `EventualBenefitReportServiceTest`
 * (`api/tests/Feature/Client/`) — o que só o navegador prova é que o número,
 * seja ele qual for, chega à TELA rotulado com a natureza certa (CA03).
 *
 * CA03 e CA09, em contraste, são plenamente verificáveis pela UI e não
 * dependem de a base ter concessão nenhuma — são rótulo/estrutura da tela.
 *
 * Sem PII: a apuração é agregada por unidade — nenhum nome, CPF ou NIS de
 * cidadão passa por aqui (RN10/RN12 do épico).
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:4174 E2E_API_BASE_URL=http://localhost:8090 \
 *   E2E_CLIENT_MASTER_CPF=... E2E_CLIENT_MASTER_PASSWORD=... \
 *   npx playwright test tests/client/eventual-benefit-counters.spec.ts
 */

/**
 * Dossiê de aceite alimentado por ESTE spec (skill `acceptance-evidence-report`).
 * Prints em `e2e/reports/<slug>-acceptance/screenshots/`, só com
 * `CAPTURE_EVIDENCE=1` — ver `helpers/evidence.ts`.
 */
const EVIDENCE_SLUG = 'us-benef-03-contadores-beneficio';

const BASE = process.env.CLIENT_BASE_URL ?? 'http://localhost:4174';
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF;
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD;

/** "E2E CRAS Centro" — ativa, com MDS (`E2EProntuarioSeeder::UNIT_CENTRO_UUID`). */
const UNIT_CENTRO = process.env.E2E_CLIENT_UNIT_UUID ?? '00000000-0000-4000-8000-0000000e0001';

/** "E2E CRAS Sem MDS" — ativa, sem MDS (`E2EProntuarioSeeder::UNIT_SEM_MDS_UUID`). */
const UNIT_SEM_MDS =
  process.env.E2E_CLIENT_CAPACITATION_UNIT_EMPTY_UUID ?? '00000000-0000-4000-8000-0000000e0003';

const configured = Boolean(BASE && MASTER_CPF && MASTER_PASSWORD);

/** Os quatro últimos contadores do leiaute 15.6 (F5 — `EVENTUAL_BENEFIT_COUNTER_KEYS`). */
const EVENTUAL_BENEFIT_COUNTER_KEYS = [
  'food_assistance',
  'birth_assistance',
  'funeral_assistance',
  'other_benefits',
] as const;

interface AttendanceReportUnavailableCounter {
  key: string;
}

interface AttendanceReportBody {
  data: {
    units: Array<{ uuid: string; name: string }>;
    unavailable_counters: AttendanceReportUnavailableCounter[];
  };
}

/** Sessão do MASTER — a única forma de abrir a apuração (`attendance-reports.view`). */
let page: Page;

/** Próxima leitura da apuração — encadeie ANTES da navegação que a dispara. */
function waitForAttendanceReport(p: Page) {
  return p.waitForResponse(
    (res) => res.url().includes('/attendance-reports') && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

/**
 * Abre a apuração (período corrente — o padrão da tela) e devolve o payload
 * da PRIMEIRA leitura, para as asserções que precisam do dado bruto (CA09).
 */
async function openApuracao(p: Page): Promise<AttendanceReportBody> {
  const responsePromise = waitForAttendanceReport(p);
  await p.goto('/app/prestacao-contas/apuracao-atendimentos');
  await dismissPlatformUpdates(p);
  const response = await responsePromise;
  expect(response.status(), 'GET /client/attendance-reports não respondeu 200').toBe(200);

  const body = (await response.json()) as AttendanceReportBody;
  await expect(p.getByTestId('eventual-benefit-counters')).toBeVisible();

  return body;
}

/**
 * ⚠️ Achado de layout (não é bug desta HU, é do shell do `client/`): a área
 * de conteúdo é um `<main>` com `overflow-y: auto` e ALTURA FIXA — é ELE que
 * rola, não `<body>`/`<html>`. `page.screenshot({ fullPage: true })` mede o
 * scroll do documento, então numa tela tão longa quanto esta (tabela +
 * acompanhamento + SCFV + benefício eventual) ele devolve só o que já estava
 * dentro do viewport, cortando exatamente a seção que cada caso aqui precisa
 * provar. `helpers/evidence.ts::captureEvidence` aceita `viewport` por causa
 * deste tipo de tela — mas o tamanho fixo que ele e o `captureFinalEvidence`
 * usam (1680×1200) ainda não é alto o bastante para ESTA página. Por isso
 * este spec mede a altura REAL do `<main>` a cada chamada e dimensiona o
 * viewport para caber tudo de uma vez, em vez de usar `captureFinalEvidence`
 * (que sobrescreveria a imagem certa pela cortada no `afterEach`).
 */
async function fullMainViewport(p: Page): Promise<{ width: number; height: number }> {
  const height = await p.evaluate(() => {
    const main = document.querySelector('main');
    return Math.max(main?.scrollHeight ?? 0, window.innerHeight);
  });

  return { width: 1680, height: Math.min(height + 80, 8000) };
}

test.describe('US-BENEF-03 — contadores de benefício eventual na apuração (client)', () => {
  test.skip(
    !configured,
    'Defina E2E_CLIENT_MASTER_CPF/PASSWORD no arquivo de env do e2e — a apuração exige ' +
      'attendance-reports.view, que só o Master carrega por padrão.',
  );

  test.use({ baseURL: BASE });

  test.beforeAll(async ({ browser }) => {
    // Sessão PRÓPRIA, sem herdar o storageState do Operacional — o guard
    // `resetTenantSession()` dentro de `loginAsTenantUser` cuida disso.
    page = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
    await loginAsTenantUser(page, MASTER_CPF!, MASTER_PASSWORD!, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // ⚠️ Este arquivo NÃO usa `captureFinalEvidence` (ver `fullMainViewport`
  // acima): o viewport fixo que ele aplica no `afterEach` não é alto o
  // bastante para esta tela e sobrescreveria, com um print cortado, a
  // evidência correta que cada caso já capturou explicitamente no corpo.

  test('CA01 — os quatro contadores de benefício eventual aparecem ACESOS na apuração, por unidade', async ({}, testInfo) => {
    await openApuracao(page);

    const section = page.getByTestId('eventual-benefit-counters');
    await expect(section).toBeVisible();

    // A unidade entrou na seção (não caiu no aviso de "ainda não trouxe os
    // contadores desta fase") — prova de que a F5 está ATIVA no payload.
    await expect(page.getByTestId(`eventual-benefit-missing-${UNIT_CENTRO}`)).toHaveCount(0);
    await expect(page.getByTestId(`eventual-benefit-group-${UNIT_CENTRO}`)).toBeVisible();

    // Os QUATRO cartões, cada um com NÚMERO — nunca travessão (travessão é a
    // marca do indisponível, e o leiaute 15.6 fechou nesta fase).
    for (const key of EVENTUAL_BENEFIT_COUNTER_KEYS) {
      const value = page.getByTestId(`eventual-benefit-value-${key}-${UNIT_CENTRO}`);
      await expect(value, `contador ${key} deveria estar aceso (número, não travessão)`).toHaveText(
        /^\d+$/,
      );
    }

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, undefined, {
      viewport: await fullMainViewport(page),
    });
  });

  test('CA03 — as TRÊS naturezas de contagem do leiaute 15.6 ficam declaradas lado a lado na mesma tela', async ({}, testInfo) => {
    await openApuracao(page);

    // Natureza 1 — os QUATRO de benefício eventual somam CONCESSÕES.
    const eventualBenefitNature = page.getByTestId(`eventual-benefit-nature-${UNIT_CENTRO}`);
    await expect(eventualBenefitNature).toBeVisible();
    await expect(eventualBenefitNature).toContainText(/concess/i);

    const groupDescription = page
      .getByTestId(`eventual-benefit-group-${UNIT_CENTRO}`)
      .locator('p')
      .first();
    await expect(groupDescription).toContainText(/concess/i);
    // A própria tela avisa para NÃO somar com as outras duas naturezas — é o
    // que impede a leitura errada que este CA existe para evitar.
    await expect(groupDescription).toContainText(/cad[uú]nico/i);
    await expect(groupDescription).toContainText(/bpc/i);

    // Natureza 2 — CadÚnico (inclusão/atualização) soma FAMÍLIAS distintas.
    const cadunicoInclusionNature = page.getByTestId('counter-nature-cadunico_inclusion');
    const cadunicoUpdateNature = page.getByTestId('counter-nature-cadunico_update');
    await expect(cadunicoInclusionNature).toBeVisible();
    await expect(cadunicoUpdateNature).toBeVisible();
    await expect(cadunicoInclusionNature).toContainText(/fam[ií]lias distintas/i);
    await expect(cadunicoUpdateNature).toContainText(/fam[ií]lias distintas/i);

    // Natureza 3 — BPC soma PESSOAS distintas — a natureza OPOSTA à do CadÚnico.
    const bpcNature = page.getByTestId('counter-nature-bpc_referrals');
    await expect(bpcNature).toBeVisible();
    await expect(bpcNature).toContainText(/pessoas distintas/i);

    // As três, juntas, na MESMA captura — é a imagem que prova o CA03: o
    // gestor não precisa navegar para ver as três naturezas do leiaute 15.6.
    // O viewport cobre o `<main>` INTEIRO (ver `fullMainViewport`) para que a
    // natureza da tabela (topo) e a do card de benefício eventual (mais
    // abaixo) apareçam na MESMA imagem, sem depender de posição de rolagem.
    const viewport = await fullMainViewport(page);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, undefined, { viewport });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'tres-naturezas-lado-a-lado', { viewport });
  });

  test('CA09 — o leiaute 15.6 fechou: não existe mais painel de contadores indisponíveis na tela', async ({}, testInfo) => {
    const body = await openApuracao(page);

    // O DADO: o backend não declara mais `eventual_benefits` (nem nenhum
    // outro contador do leiaute 15.6) como indisponível.
    const unavailableKeys = body.data.unavailable_counters.map((counter) => counter.key);
    expect(
      unavailableKeys,
      'o backend ainda declara "eventual_benefits" como indisponível — a F5 não fechou o leiaute',
    ).not.toContain('eventual_benefits');
    expect(
      body.data.unavailable_counters,
      'o leiaute 15.6 deveria estar inteiramente coberto pelas fases já entregues (F1-F5)',
    ).toEqual([]);

    // A TELA: o painel inteiro deixa de existir no DOM — não fica presente e
    // vazio, ele SOME (`v-if="counters.length > 0"` no `UnavailableCountersPanel`).
    await expect(page.getByTestId('unavailable-counters')).toHaveCount(0);
    await expect(page.getByTestId('unavailable-eventual_benefits')).toHaveCount(0);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, undefined, {
      viewport: await fullMainViewport(page),
    });
  });

  test('CA10 — unidade sem concessão no período mostra os quatro contadores em zero declarado, com a explicação', async ({}, testInfo) => {
    await openApuracao(page);

    // A massa do E2E não tem NENHUMA concessão de benefício eventual — toda
    // unidade está em zero declarado. Verificado aqui na "E2E CRAS Sem MDS"
    // (unidade DIFERENTE da do CA01), para não repetir a mesma leitura.
    const badge = page.getByTestId(`eventual-benefit-zero-declared-${UNIT_SEM_MDS}`);
    await expect(badge, 'selo de zero declarado ausente — a unidade tem concessão na massa?').toBeVisible();
    await expect(badge).toContainText(/zero declarado/i);

    // A explicação viaja no `title` do selo (RN02 do épico): zero declarado
    // não é "não sabemos" — é "apuramos e deu zero".
    await expect(badge).toHaveAttribute('title', /zero declarado/i);
    await expect(badge).toHaveAttribute('title', /n[ãa]o registrou|registr/i);

    // E os quatro contadores, de fato, em 0 — não travessão (indisponível).
    for (const key of EVENTUAL_BENEFIT_COUNTER_KEYS) {
      const value = page.getByTestId(`eventual-benefit-value-${key}-${UNIT_SEM_MDS}`);
      await expect(value, `contador ${key} deveria estar zerado (declarado), não travessão`).toHaveText(
        '0',
      );
    }

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, undefined, {
      viewport: await fullMainViewport(page),
    });
  });
});
