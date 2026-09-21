import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';

const DEFAULT_MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

export interface MailpitMessageSummary {
  ID: string;
  To: Array<{ Address: string; Name: string }>;
  Subject: string;
  Created: string;
}

export interface MailpitMessage {
  ID: string;
  To: Array<{ Address: string; Name: string }>;
  Subject: string;
  Text: string;
  HTML: string;
  Created: string;
}

/**
 * Cliente HTTP para a API do Mailpit (não usa Axios para evitar dependência extra).
 *
 * API ref: https://mailpit.axllent.org/docs/api-v1/
 */
export class MailpitClient {
  private constructor(
    private readonly api: APIRequestContext,
    private readonly baseURL: string,
  ) {}

  static async create(baseURL = DEFAULT_MAILPIT_URL): Promise<MailpitClient> {
    const api = await playwrightRequest.newContext({ baseURL });

    return new MailpitClient(api, baseURL);
  }

  async dispose(): Promise<void> {
    await this.api.dispose();
  }

  /**
   * Limpa a caixa de entrada do Mailpit. Útil em beforeEach para isolar testes.
   */
  async clear(): Promise<void> {
    await this.api.delete('/api/v1/messages');
  }

  /**
   * Polling até receber um email para o destinatário. Lança se não chegar no timeout.
   */
  async waitForMessageTo(email: string, timeoutMs = 15_000): Promise<MailpitMessage> {
    const start = Date.now();
    const query = encodeURIComponent(`to:${email}`);

    while (Date.now() - start < timeoutMs) {
      const res = await this.api.get(`/api/v1/search?query=${query}&limit=1`);
      if (res.ok()) {
        const body = (await res.json()) as { messages: MailpitMessageSummary[] };
        if (body.messages && body.messages.length > 0) {
          return this.getMessage(body.messages[0].ID);
        }
      }
      await sleep(500);
    }

    throw new Error(`Timeout aguardando email para ${email} no Mailpit (${this.baseURL})`);
  }

  async getMessage(id: string): Promise<MailpitMessage> {
    const res = await this.api.get(`/api/v1/message/${id}`);
    if (!res.ok()) {
      throw new Error(`Mailpit: mensagem ${id} não encontrada (${res.status()})`);
    }

    return res.json() as Promise<MailpitMessage>;
  }

  /**
   * Extrai a primeira URL `auth/reset-password` do corpo do email.
   * Retorna a URL completa (com token e email decoded).
   */
  static extractResetUrl(message: MailpitMessage): string {
    const sources = [message.Text, message.HTML];
    const pattern = /https?:\/\/[^\s"'<>]+\/auth\/reset-password\?[^\s"'<>]+/i;

    for (const source of sources) {
      const match = source?.match(pattern);
      if (match) {
        return match[0].replace(/&amp;/g, '&');
      }
    }

    throw new Error('Não encontrei URL de reset-password no email do Mailpit');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
