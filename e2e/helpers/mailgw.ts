import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';

/**
 * Provedores compatíveis (a API do Mail.gw é a do Mail.tm, só muda a URL base).
 * `STG_MAILBOX_URL` força um; sem ele tenta o Mail.tm e, se estiver fora, o Mail.gw.
 */
const MAILBOX_PROVIDERS = ['https://api.mail.tm', 'https://api.mail.gw'];

export interface MailgwMessage {
  id: string;
  from: { name: string; address: string };
  to: Array<{ name: string; address: string }>;
  subject: string;
  text: string;
  html: string[];
}

/**
 * Caixa de e-mail descartável via Mail.tm / Mail.gw (https://docs.mail.tm, https://docs.mail.gw).
 *
 * Alternativa ao Mailpit para ambientes em que o backend envia e-mail de verdade
 * (staging/HML): o Mailpit só enxerga o que o SMTP do QA captura. Limite dos serviços:
 * 8 requisições por segundo por IP — o polling abaixo respeita isso.
 */
export class MailgwInbox {
  private constructor(
    private readonly api: APIRequestContext,
    readonly address: string,
    readonly password: string,
    private readonly accountId: string,
    private token: string,
  ) {}

  /** Cria a conta (`<prefixo>-<timestamp>@<domínio ativo>`) e já obtém o token. */
  static async create(prefix = 'e2e', baseURL?: string): Promise<MailgwInbox> {
    const candidates = baseURL ? [baseURL] : process.env.STG_MAILBOX_URL ? [process.env.STG_MAILBOX_URL] : MAILBOX_PROVIDERS;
    const failures: string[] = [];

    for (const url of candidates) {
      try {
        return await MailgwInbox.createAt(prefix, url);
      } catch (error) {
        failures.push(`${url}: ${(error as Error).message}`);
      }
    }

    throw new Error(`Nenhum provedor de caixa descartável respondeu — ${failures.join(' | ')}`);
  }

  private static async createAt(prefix: string, baseURL: string): Promise<MailgwInbox> {
    const api = await playwrightRequest.newContext({ baseURL });

    try {
      const domains = await api.get('/domains');
      if (!domains.ok()) throw new Error(`/domains respondeu ${domains.status()}`);
      const list = (
        (await domains.json()) as { 'hydra:member': Array<{ domain: string; isActive: boolean }> }
      )['hydra:member'].filter((d) => d.isActive);
      if (list.length === 0) throw new Error('nenhum domínio ativo');

      const address = `${prefix}-${Date.now()}${Math.floor(Math.random() * 1000)}@${list[0].domain}`;
      const password = `Mg!${Date.now()}${Math.random().toString(36).slice(2)}`;

      const account = await api.post('/accounts', { data: { address, password } });
      if (!account.ok()) throw new Error(`/accounts respondeu ${account.status()}`);
      const { id } = (await account.json()) as { id: string };

      const token = await api.post('/token', { data: { address, password } });
      if (!token.ok()) throw new Error(`/token respondeu ${token.status()}`);

      return new MailgwInbox(api, address, password, id, ((await token.json()) as { token: string }).token);
    } catch (error) {
      await api.dispose();
      throw error;
    }
  }

  private auth() {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Polling até chegar mensagem (opcionalmente filtrada pelo assunto). */
  async waitForMessage(opts: { subject?: RegExp; timeoutMs?: number } = {}): Promise<MailgwMessage> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const res = await this.api.get('/messages', { headers: this.auth() });
      if (res.ok()) {
        const body = (await res.json()) as { 'hydra:member': Array<{ id: string; subject: string }> };
        const hit = body['hydra:member'].find((m) => !opts.subject || opts.subject.test(m.subject));
        if (hit) {
          const full = await this.api.get(`/messages/${hit.id}`, { headers: this.auth() });
          return (await full.json()) as MailgwMessage;
        }
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }

    throw new Error(`Timeout aguardando e-mail para ${this.address} no Mail.gw`);
  }

  /** Assuntos de tudo que já chegou (útil para diagnosticar "o e-mail não veio"). */
  async subjects(): Promise<string[]> {
    const res = await this.api.get('/messages', { headers: this.auth() });
    if (!res.ok()) return [];

    return ((await res.json()) as { 'hydra:member': Array<{ subject: string }> })['hydra:member'].map((m) => m.subject);
  }

  /** Primeira URL do corpo cujo caminho contém `pathPart` (ex.: `reset-password`, `setup-password`). */
  static extractUrl(message: MailgwMessage, pathPart: string): string {
    const pattern = new RegExp(`https?://[^\\s"'<>]+${pathPart}[^\\s"'<>]*`, 'i');
    for (const source of [message.text, ...(message.html ?? [])]) {
      const match = source?.match(pattern);
      if (match) return match[0].replace(/&amp;/g, '&');
    }
    throw new Error(`Não encontrei URL com "${pathPart}" no e-mail do Mail.gw`);
  }

  /** Apaga a conta descartável (não há como restaurar). */
  async dispose(): Promise<void> {
    await this.api.delete(`/accounts/${this.accountId}`, { headers: this.auth() }).catch(() => undefined);
    await this.api.dispose();
  }
}
