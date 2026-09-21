import { expect, test } from '@playwright/test';
import { LookupCrudPage } from '../../pages/lookups/LookupCrudPage';

/**
 * Smoke parametrizado: cada lookup carrega a listagem sem 500/403 e renderiza
 * tabela ou empty-state.
 *
 * Não cobre formulários específicos (cada lookup tem campos próprios) — isso fica
 * para uma onda posterior se houver demanda. O objetivo aqui é flagar quebra
 * de rota/permissão/contrato de API rapidamente.
 */
const LOOKUPS = [
  { slug: 'countries', label: 'Países' },
  { slug: 'states', label: 'Estados' },
  { slug: 'cities', label: 'Cidades' },
  { slug: 'location-types', label: 'Tipos de localização' },
  { slug: 'social-unit-types', label: 'Tipos de unidade' },
  { slug: 'social-unit-statuses', label: 'Status de unidade' },
  { slug: 'social-entity-statuses', label: 'Status de entidade' },
  { slug: 'suas-participation-types', label: 'Participações SUAS' },
  { slug: 'social-specificities', label: 'Especificidades' },
  // Lookups do CadÚnico (Sprint 8) — telas gold-standard no admin.
  { slug: 'race-colors', label: 'Cor/Raça' },
  { slug: 'education-levels', label: 'Graus de Instrução' },
  { slug: 'traditional-population-groups', label: 'Grupos Populacionais Tradicionais' },
  // Lookups do prontuário (HU #10620) — CRUD completo coberto em prontuario-lookups.spec.ts.
  { slug: 'member-unlink-reasons', label: 'Motivos de Desvínculo' },
  { slug: 'civil-document-types', label: 'Tipos de Documento Civil' },
  // Lookups do bloco de ingresso (HU #10619) — CRUD completo em prontuario-lookups.spec.ts.
  { slug: 'family-intake-forms', label: 'Formas de Ingresso' },
  { slug: 'social-programs', label: 'Programas Sociais' },
];

for (const lookup of LOOKUPS) {
  test(`lookup ${lookup.label} carrega sem erro`, async ({ page }) => {
    const lookupPage = new LookupCrudPage(page, lookup.slug);

    // Captura erros de console e navegação.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/${lookup.slug}`) && res.request().method() === 'GET',
      { timeout: 10_000 },
    );

    await lookupPage.goto();
    const response = await responsePromise;

    expect(response.status(), `GET /api/${lookup.slug} retornou ${response.status()}`).toBe(200);
    await lookupPage.expectListLoaded();
    expect(consoleErrors, `console errors em /${lookup.slug}: ${consoleErrors.join(' | ')}`).toEqual(
      [],
    );
  });
}
