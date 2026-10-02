/**
 * Mailpit — link de redefinição de senha e `definirSenha` (#10994 · RN-T7, BR-007).
 *
 * Os usuários da massa são criados pela API sem senha conhecida; a senha é definida pelo fluxo
 * REAL de redefinição: POST /api/{guard}/auth/forgot-password → e-mail no Mailpit →
 * POST /api/{guard}/auth/reset-password { token, email, password, password_confirmation }.
 * Reaproveita o padrão de `e2e/helpers/mailpit.ts` (busca `to:` + regex do link).
 */
import { request as playwrightRequest } from '@playwright/test';
import { logPadrao, registrarSegredos, sanitizar, type ConfigMassa, type Logger } from './config.ts';
import type { Guard } from './http.ts';

export interface MensagemMailpit {
  ID: string;
  Subject: string;
  Created: string;
  Text: string;
  HTML: string;
}

const PADRAO_LINK = /https?:\/\/[^\s"'<>]+\/auth\/reset-password\?[^\s"'<>]+/i;

/** Extrai o link de redefinição (com `&amp;` decodificado) do texto ou HTML do e-mail. */
export function extrairLinkRedefinicao(m: Pick<MensagemMailpit, 'Text' | 'HTML'>): string {
  for (const fonte of [m.Text, m.HTML]) {
    const achado = fonte?.match(PADRAO_LINK);
    if (achado) return achado[0].replace(/&amp;/g, '&');
  }
  throw new Error('E-mail sem link de /auth/reset-password.');
}

/** Token e e-mail do link (`?token=…&email=…`). */
export function lerLink(link: string): { token: string; email: string } {
  const url = new URL(link);
  const token = url.searchParams.get('token') ?? '';
  const email = url.searchParams.get('email') ?? '';
  if (!token || !email) throw new Error('Link de redefinição sem token ou e-mail.');
  return { token, email };
}

/**
 * Espera o e-mail de redefinição mais recente para `email` criado a partir de `desde` e
 * devolve o link. Só faz GET no Mailpit.
 */
export async function buscarLinkRedefinicao(
  mailpitUrl: string,
  email: string,
  o: { desde?: Date; timeoutMs?: number } = {},
): Promise<string> {
  const ctx = await playwrightRequest.newContext();
  const base = mailpitUrl.replace(/\/+$/, '');
  const limite = Date.now() + (o.timeoutMs ?? 30_000);
  const desde = o.desde?.getTime() ?? 0;
  try {
    while (Date.now() < limite) {
      const r = await ctx.get(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=10`);
      if (r.ok()) {
        const corpo = (await r.json()) as { messages?: Array<{ ID: string; Created: string }> };
        const candidata = (corpo.messages ?? []).find((m) => new Date(m.Created).getTime() >= desde - 1000);
        if (candidata) {
          const msg = await ctx.get(`${base}/api/v1/message/${candidata.ID}`);
          if (msg.ok()) {
            const mensagem = (await msg.json()) as MensagemMailpit;
            try {
              return extrairLinkRedefinicao(mensagem);
            } catch {
              /* e-mail de outro tipo para o mesmo destinatário: continua esperando */
            }
          }
        }
      }
      await new Promise((ok) => setTimeout(ok, 500));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(`Tempo esgotado aguardando o e-mail de redefinição para ${email} no Mailpit (${mailpitUrl}).`);
}

/** Define a senha de `email` pelo fluxo real de redefinição (sem tocar no banco). */
export async function definirSenha(
  cfg: ConfigMassa,
  alvo: { email: string; guard: Guard },
  senha: string,
  o: { log?: Logger; timeoutMs?: number } = {},
): Promise<void> {
  registrarSegredos([senha]);
  const log = o.log ?? logPadrao;
  const origem = alvo.guard === 'manager' ? cfg.adminUrl : cfg.clientUrl;
  const api = cfg.apiBase;
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: { Accept: 'application/json', Origin: origem, Referer: `${origem}/auth/forgot-password`, 'X-Requested-With': 'XMLHttpRequest' },
  });
  const xsrf = async (): Promise<Record<string, string>> => {
    const c = (await ctx.storageState()).cookies.find((k) => k.name === 'XSRF-TOKEN');
    return c ? { 'X-XSRF-TOKEN': decodeURIComponent(c.value) } : {};
  };
  try {
    await ctx.get(`${api}/sanctum/csrf-cookie`);
    const desde = new Date();
    const forgot = await ctx.post(`${api}/api/${alvo.guard}/auth/forgot-password`, { data: { email: alvo.email }, headers: await xsrf() });
    log(`  [mailpit] POST /api/${alvo.guard}/auth/forgot-password → ${forgot.status()}`);
    if (!forgot.ok()) throw new Error(`forgot-password → HTTP ${forgot.status()}: ${sanitizar(await forgot.text()).slice(0, 300)}`);

    const link = await buscarLinkRedefinicao(cfg.mailpitUrl, alvo.email, { desde, timeoutMs: o.timeoutMs });
    const { token, email } = lerLink(link);
    registrarSegredos([token]);
    const reset = await ctx.post(`${api}/api/${alvo.guard}/auth/reset-password`, {
      data: { token, email, password: senha, password_confirmation: senha },
      headers: await xsrf(),
    });
    log(`  [mailpit] POST /api/${alvo.guard}/auth/reset-password → ${reset.status()}`);
    if (!reset.ok()) throw new Error(`reset-password → HTTP ${reset.status()}: ${sanitizar(await reset.text()).slice(0, 300)}`);
  } finally {
    await ctx.dispose();
  }
}
