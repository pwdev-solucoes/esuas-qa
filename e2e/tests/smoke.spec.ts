import { expect, test } from '@playwright/test';

test('login page carrega', async ({ page }) => {
  await page.goto('/auth/login');
  await expect(page).toHaveTitle(/e-?SUAS/i);
});

test('API health check responde', async ({ request }) => {
  const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:8080';
  const response = await request.get(`${apiBase}/up`);
  expect(response.ok()).toBeTruthy();
});
