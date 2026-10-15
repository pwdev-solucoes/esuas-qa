import { test, expect } from '@playwright/test';
import { MailgwInbox } from '../../helpers/mailgw';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Mail.gw — caixa descartável', () => {
  test('cria a conta, autentica e lista a caixa vazia', async () => {
    const inbox = await MailgwInbox.create('e2e-smoke');
    try {
      expect(inbox.address).toMatch(/^e2e-smoke-\d+@.+\..+$/);
      await expect(inbox.waitForMessage({ timeoutMs: 4_000 })).rejects.toThrow(/Timeout/);
    } finally {
      await inbox.dispose();
    }
  });
});
