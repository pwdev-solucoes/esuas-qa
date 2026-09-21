import { expect, test } from '../../fixtures/auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * US-SCFV-01 (épico HU-PRONT-SCFV) — os dois domínios do bloco 16 do
 * instrumento Prontuário SUAS no Painel de Administração Global (`admin/`,
 * guard `manager`): os oito serviços/programas/projetos e os cinco locais de
 * realização.
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que **a regra que mora no DADO chega aos olhos do Administrador**. O Pest já
 * garante que a matriz está no banco e que a invariante é validada; o que só o
 * navegador mostra é se a tela **distingue visualmente** os três atributos de
 * contagem — e é essa distinção que impede o erro mais caro desta fase.
 *
 * O leiaute 15.8 conta três coisas de formas diferentes, e é o item que diz de
 * qual contador ele participa. Um atributo marcado por engano no painel global
 * muda números declarados ao TCE-AL **de todos os municípios**, e passa em
 * todas as validações do SIAP. Por isso os casos verificam a matriz item a
 * item na tela, e não apenas que a página abre.
 *
 * ## Massa (pré-condição)
 *
 * Os treze itens vêm do `ParticipationDomainsSeeder`, que passou a ser chamado
 * pelo `E2ESeeder` (usado por `scripts/start-stack.sh`) no mesmo lote deste
 * arquivo. Massa ausente aqui **não vira `skip`**: significa harness quebrado,
 * e um caso pulado em silêncio contaria a história errada.
 *
 * ## Estado
 *
 * Nada é criado, alterado nem apagado — todos os casos são de leitura.
 *
 * ## NÃO COBERTO — CA08 (exclusão de item em uso)
 *
 * O guard da RN07 conta uso em `family_member_participations`, tabela que só
 * nasce na **US-SCFV-02**. Hoje nenhum item está em uso, então a exclusão
 * *funcionaria* — e testá-la aqui apagaria massa da base. O guard está coberto
 * pela suíte de backend; o cenário de tela entra quando a US-SCFV-02 existir.
 */

const ADMIN_BASE = process.env.E2E_BASE_URL;

/** A matriz do §4.1 da spec — a fonte da verdade desta HU. */
const SERVICES = [
  { code: '1',   group: true,  scfv: true,  elderly: false, extension: false, description: false },
  { code: '2',   group: true,  scfv: true,  elderly: true,  extension: false, description: false },
  { code: '3',   group: true,  scfv: false, elderly: false, extension: false, description: false },
  { code: '4',   group: true,  scfv: false, elderly: false, extension: false, description: false },
  { code: '5',   group: false, scfv: false, elderly: false, extension: false, description: false },
  { code: '6',   group: false, scfv: false, elderly: false, extension: false, description: false },
  { code: '99',  group: false, scfv: false, elderly: false, extension: false, description: true  },
  { code: '900', group: true,  scfv: true,  elderly: false, extension: true,  description: false },
] as const;

const LOCATION_CODES = ['1', '2', '3', '4', '9'] as const;

test.describe('US-SCFV-01 — domínios de participação no Painel Global (admin)', () => {
  test.skip(!ADMIN_BASE, 'Defina E2E_BASE_URL para rodar contra o admin.');

  // A listagem em tabela só existe no desktop; abaixo de 768px vira cards.
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });

  test('(a) os oito serviços aparecem com os códigos do instrumento, e o salto 6 → 99 é preservado', async ({
    page,
  }) => {
    await page.goto('/app/participation-services');
    await page.waitForLoadState('networkidle');
    await dismissPlatformUpdates(page);

    await expect(page.getByTestId('ps-table')).toBeVisible();

    for (const { code } of SERVICES) {
      await expect(
        page.getByTestId(`ps-row-${code}`),
        `serviço de código ${code} presente`,
      ).toBeVisible();
    }

    // O salto é parte da regra: não existe 7 nem 8 entre o 6 e o 99.
    for (const absent of ['7', '8', '10']) {
      await expect(
        page.getByTestId(`ps-row-${absent}`),
        `código ${absent} NÃO deve existir — a lista não é renumerada`,
      ).toHaveCount(0);
    }

    await page.screenshot({ path: 'test-results/scfv01-a-oito-servicos.png', fullPage: true });
  });

  test('(b) o SCFV para adultos é distinguível como extensão posterior ao instrumento', async ({
    page,
  }) => {
    await page.goto('/app/participation-services');
    await page.waitForLoadState('networkidle');
    await dismissPlatformUpdates(page);

    // O selo existe no 900...
    await expect(
      page.getByTestId('ps-row-900').getByTestId('ps-badge-extension'),
      'o item criado por decisão do produto precisa ser identificável',
    ).toBeVisible();

    // ...e em NENHUM dos sete que vêm do MDS.
    for (const { code, extension } of SERVICES.filter((s) => !s.extension)) {
      await expect(
        page.getByTestId(`ps-row-${code}`).getByTestId('ps-badge-extension'),
        `código ${code} vem do instrumento e não pode ostentar selo de extensão`,
      ).toHaveCount(extension ? 1 : 0);
    }

    // É o único da lista inteira.
    await expect(page.locator('[data-testid="ps-badge-extension"]')).toHaveCount(1);

    await page.screenshot({ path: 'test-results/scfv01-b-selo-extensao.png', fullPage: true });
  });

  test('(c) a matriz dos três atributos de contagem confere item a item na tela', async ({
    page,
  }) => {
    await page.goto('/app/participation-services');
    await page.waitForLoadState('networkidle');
    await dismissPlatformUpdates(page);

    for (const item of SERVICES) {
      const row = page.getByTestId(`ps-row-${item.code}`);

      await expect(row.getByTestId('ps-badge-group'), `${item.code} · grupo`)
        .toHaveCount(item.group ? 1 : 0);
      await expect(row.getByTestId('ps-badge-scfv'), `${item.code} · SCFV`)
        .toHaveCount(item.scfv ? 1 : 0);
      await expect(row.getByTestId('ps-badge-scfv-elderly'), `${item.code} · SCFV idosos`)
        .toHaveCount(item.elderly ? 1 : 0);
      await expect(row.getByTestId('ps-badge-requires-description'), `${item.code} · descrição`)
        .toHaveCount(item.description ? 1 : 0);

      // Item sem nenhum contador diz isso explicitamente, em vez de ficar vazio.
      const noCounters = !item.group && !item.scfv && !item.elderly;
      await expect(row.getByTestId('ps-badge-no-counters'), `${item.code} · sem contadores`)
        .toHaveCount(noCounters ? 1 : 0);
    }

    // O contador de idosos é restrito pelo SERVIÇO: um só item pode alimentá-lo.
    await expect(
      page.locator('[data-testid="ps-badge-scfv-elderly"]'),
      'exatamente um item é SCFV para idosos',
    ).toHaveCount(1);

    // E os grupos do PAIF e do PAEFI são grupo SEM ser SCFV — é o que mantém os
    // quatro contadores de faixa etária fora deles.
    for (const code of ['3', '4']) {
      const row = page.getByTestId(`ps-row-${code}`);
      await expect(row.getByTestId('ps-badge-group')).toHaveCount(1);
      await expect(row.getByTestId('ps-badge-scfv')).toHaveCount(0);
    }

    await page.screenshot({ path: 'test-results/scfv01-c-matriz-atributos.png', fullPage: true });
  });

  test('(d) os cinco locais de realização, e só o primeiro é a própria unidade', async ({ page }) => {
    await page.goto('/app/participation-locations');
    await page.waitForLoadState('networkidle');
    await dismissPlatformUpdates(page);

    await expect(page.getByTestId('pl-table')).toBeVisible();

    for (const code of LOCATION_CODES) {
      await expect(page.getByTestId(`pl-row-${code}`), `local de código ${code}`).toBeVisible();
    }
    // O salto 4 → 9 também é do instrumento.
    for (const absent of ['5', '6', '7', '8']) {
      await expect(page.getByTestId(`pl-row-${absent}`)).toHaveCount(0);
    }

    // `is_own_unit` é o atributo que fará o registro exigir a identificação do
    // local (US-SCFV-02). O selo é renderizado em TODAS as linhas e diz a
    // CONSEQUÊNCIA, não só o estado — por isso a asserção é sobre o texto, e
    // não sobre a presença do elemento.
    await expect(
      page.getByTestId('pl-row-1').getByTestId('pl-badge-own-unit'),
      'o código 1 é a própria unidade',
    ).toContainText(/própria unidade/i);

    for (const code of ['2', '3', '4', '9']) {
      await expect(
        page.getByTestId(`pl-row-${code}`).getByTestId('pl-badge-own-unit'),
        `o código ${code} acontece fora e exigirá identificação do local`,
      ).toContainText(/exige identifica/i);
    }

    await page.screenshot({ path: 'test-results/scfv01-d-cinco-locais.png', fullPage: true });
  });
});
