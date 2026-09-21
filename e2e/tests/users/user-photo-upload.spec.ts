import { expect } from '@playwright/test';
import { test } from '../../fixtures/auth';
import { uniqueSuffix } from '../../fixtures/test-data';
import { generateCpf, maskCpf } from '../../helpers/cpf';
import { avatarFixturePath, oversizeImageBuffer } from '../../helpers/upload';
import { UserFormSheet } from '../../pages/users/UserFormSheet';

test.describe('Upload de foto do usuário', () => {
  test('cria Manager com foto e a foto aparece no payload do GET /api/users', async ({
    page,
    apiClient,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();
    const fullName = `Foto Manager ${suffix}`;

    await page.goto('/app/usuarios');
    await page.getByRole('button', { name: /novo usuário/i }).click();

    const form = new UserFormSheet(page);
    await expect(form.sheet).toBeVisible();
    await form.fillBasic({
      fullName,
      email: `${suffix}@e2e.local`,
      cpf: maskCpf(cpf),
    });

    // Seleciona o avatar e confirma que o preview apareceu antes do submit.
    await form.setAvatar(avatarFixturePath());

    // Capta a resposta do upload de foto (dispara DEPOIS do POST /users).
    const uploadResponse = page.waitForResponse(
      (res) => /\/api\/users\/\d+\/photo$/.test(res.url()) && res.request().method() === 'POST',
      { timeout: 15_000 },
    );

    await form.save();
    const photoRes = await uploadResponse;

    expect(photoRes.status()).toBe(200);
    const body = (await photoRes.json()) as { data: { photo_url: string | null; id: number } };
    expect(body.data.photo_url).not.toBeNull();
    expect(body.data.photo_url).toMatch(/avatars\//);

    // Sanity: o GET na API retorna o user com photo_url populado.
    const detail = await apiClient.get<{ data: { photo_url: string | null } }>(
      `/users/${body.data.id}`,
    );
    expect(detail.data.photo_url).not.toBeNull();
  });

  test('upload com arquivo > 2MB é rejeitado (422) e exibe erro no campo "foto"', async ({
    page,
  }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();

    await page.goto('/app/usuarios');
    await page.getByRole('button', { name: /novo usuário/i }).click();

    const form = new UserFormSheet(page);
    await form.fillBasic({
      fullName: `Oversize ${suffix}`,
      email: `${suffix}@e2e.local`,
      cpf: maskCpf(cpf),
    });

    const oversize = oversizeImageBuffer();
    await form.setAvatarFromBuffer(oversize.name, oversize.mimeType, oversize.buffer);

    // O store do user vai criar com sucesso; o upload subsequente cai em 422.
    // Verifica que a chamada de upload retornou 422 (o user foi criado mas a foto
    // não — comportamento atual do useUsers.create).
    const uploadResponse = page.waitForResponse(
      (res) => /\/api\/users\/\d+\/photo$/.test(res.url()) && res.request().method() === 'POST',
      { timeout: 15_000 },
    );

    await form.save();
    const photoRes = await uploadResponse;

    expect(photoRes.status()).toBe(422);
    const body = (await photoRes.json()) as { errors?: { photo?: string[] } };
    expect(body.errors?.photo).toBeDefined();
  });

  test('edita user existente e troca a foto — endpoint retorna 200 + nova URL', async ({
    page,
    apiClient,
  }, testInfo) => {
    // Cria um user direto via API para isolar o teste de edição.
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const cpf = generateCpf();
    const created = await apiClient.post<{ data: { id: number; photo_url: string | null } }>(
      '/users',
      {
        full_name: `Edit Photo ${suffix}`,
        email: `${suffix}@e2e.local`,
        cpf,
        type: 'manager',
        role: 'admin',
      },
    );
    expect(created.data.photo_url).toBeNull();

    await page.goto('/app/usuarios');

    // Busca pelo nome via search input — garante que o user recém-criado
    // aparece independente da página atual da listagem (debounce ~350ms).
    await page.getByPlaceholder(/buscar por nome/i).fill(`Edit Photo ${suffix}`);
    const row = page.locator('tr', { hasText: `Edit Photo ${suffix}` });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('button[aria-label="Mais ações"]').first().click();
    // Dropdown Teleport to body com overlay invisível que pode detachar o item
    // entre resolve→click — force:true ignora a checagem de stability.
    await page.getByText('Editar', { exact: true }).click({ force: true, timeout: 5_000 });

    const form = new UserFormSheet(page);
    await expect(form.sheet).toBeVisible();

    const uploadResponse = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/users/${created.data.id}/photo`) &&
        res.request().method() === 'POST',
      { timeout: 15_000 },
    );

    await form.setAvatar(avatarFixturePath());
    await form.save();
    const photoRes = await uploadResponse;

    expect(photoRes.status()).toBe(200);
    const body = (await photoRes.json()) as { data: { photo_url: string | null } };
    expect(body.data.photo_url).not.toBeNull();
  });
});
