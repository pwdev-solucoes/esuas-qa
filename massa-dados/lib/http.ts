/**
 * Cliente HTTP por papel (#10994 · BR-006, RN-T7).
 *
 * Um `APIRequestContext` isolado por usuário, fluxo Sanctum stateful 100% cookie:
 *   GET /sanctum/csrf-cookie → `X-XSRF-TOKEN` + `Origin` do front do guard →
 *   POST /api/{manager|client}/auth/login { cpf, password }.
 * Ao receber 429 no login, roda `MASSA_CACHE_CLEAR_CMD` uma vez e tenta de novo.
 * O log só registra papel, método, URI e status — nunca senha, token, cookie ou XSRF.
 */
import { request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { executorPadrao, logPadrao, registrarSegredos, sanitizar, type ConfigMassa, type Executor, type Logger } from './config.ts';

export type Guard = 'manager' | 'client';

export interface Papel {
  /** Nome curto do papel no log (ex.: `admin`, `P1`, `M0`). */
  nome: string;
  guard: Guard;
  cpf: string;
  senha: string;
  /** `X-Tenant-UUID` enviado em toda requisição (guard client, após selecionar o tenant). */
  tenantUuid?: string;
}

export interface PassoHttp {
  papel: string;
  metodo: string;
  uri: string;
  status: number;
  duracaoMs: number;
}

export class FalhaHttp extends Error {
  constructor(
    readonly passo: PassoHttp,
    corpo: string,
  ) {
    super(`${passo.papel} ${passo.metodo} ${passo.uri} → HTTP ${passo.status}: ${sanitizar(corpo).slice(0, 500)}`);
    this.name = 'FalhaHttp';
  }
}

export interface OpcoesCliente {
  log?: Logger;
  executor?: Executor;
  /** Recebe cada requisição feita (para a evidência da etapa). */
  aoRegistrar?: (passo: PassoHttp) => void;
}

type Dados = Record<string, unknown> | unknown[] | undefined;

export class ClientePapel {
  private constructor(
    private readonly ctx: APIRequestContext,
    readonly papel: Papel,
    private readonly o: Required<Pick<OpcoesCliente, 'log'>> & OpcoesCliente,
    private readonly apiBase: string,
  ) {}

  /** Origem do front correspondente ao guard (Sanctum stateful exige `Origin` conhecido). */
  static origem(cfg: ConfigMassa, guard: Guard): string {
    return guard === 'manager' ? cfg.adminUrl : cfg.clientUrl;
  }

  static async autenticar(cfg: ConfigMassa, papel: Papel, opcoes: OpcoesCliente = {}): Promise<ClientePapel> {
    registrarSegredos([papel.senha]);
    const origem = ClientePapel.origem(cfg, papel.guard);
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: {
        Accept: 'application/json',
        Origin: origem,
        Referer: `${origem}/auth/login`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const cliente = new ClientePapel(ctx, papel, { log: logPadrao, ...opcoes }, cfg.apiBase);
    try {
      await cliente.login(cfg);
    } catch (erro) {
      await ctx.dispose();
      throw erro;
    }
    return cliente;
  }

  private async login(cfg: ConfigMassa): Promise<void> {
    const csrf = await this.ctx.get(`${this.apiBase}/sanctum/csrf-cookie`);
    this.registrar('GET', '/sanctum/csrf-cookie', csrf.status(), 0);
    if (csrf.status() >= 400) throw new FalhaHttp(this.ultimo('GET', '/sanctum/csrf-cookie', csrf.status()), await csrf.text());

    const uri = `/api/${this.papel.guard}/auth/login`;
    const corpo = { cpf: this.papel.cpf, password: this.papel.senha };
    let r = await this.enviar('POST', uri, corpo);
    if (r.status() === 429 && cfg.cacheClearCmd) {
      this.o.log(`  ⚠ ${this.papel.nome}: 429 no login, rodando MASSA_CACHE_CLEAR_CMD e tentando de novo`);
      (this.o.executor ?? executorPadrao).shell(cfg.cacheClearCmd);
      r = await this.enviar('POST', uri, corpo);
    }
    if (!r.ok()) throw new FalhaHttp(this.ultimo('POST', uri, r.status()), await r.text());
  }

  private async xsrf(): Promise<string | undefined> {
    const estado = await this.ctx.storageState();
    const valor = estado.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value;
    return valor ? decodeURIComponent(valor) : undefined;
  }

  private registrar(metodo: string, uri: string, status: number, duracaoMs: number): void {
    const passo: PassoHttp = { papel: this.papel.nome, metodo, uri: sanitizar(uri), status, duracaoMs };
    this.o.aoRegistrar?.(passo);
    this.o.log(`  [${passo.papel}] ${metodo} ${passo.uri} → ${status}`);
  }

  private ultimo(metodo: string, uri: string, status: number): PassoHttp {
    return { papel: this.papel.nome, metodo, uri: sanitizar(uri), status, duracaoMs: 0 };
  }

  private async enviar(metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', uri: string, dados?: Dados): Promise<APIResponse> {
    const headers: Record<string, string> = {};
    if (this.papel.tenantUuid) headers['X-Tenant-UUID'] = this.papel.tenantUuid;
    if (metodo !== 'GET') {
      const token = await this.xsrf();
      if (token) headers['X-XSRF-TOKEN'] = token;
    }
    const inicio = Date.now();
    const r = await this.ctx.fetch(`${this.apiBase}${uri}`, { method: metodo, headers, data: dados });
    this.registrar(metodo, uri, r.status(), Date.now() - inicio);
    return r;
  }

  /** URI relativa à raiz da API (ex.: `/api/manager/tenants`). Lança `FalhaHttp` se status ≥ 400. */
  async requisitar<T = unknown>(metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', uri: string, dados?: Dados): Promise<{ status: number; corpo: T }> {
    const r = await this.enviar(metodo, uri, dados);
    const texto = await r.text();
    if (!r.ok()) throw new FalhaHttp(this.ultimo(metodo, uri, r.status()), texto);
    return { status: r.status(), corpo: (texto ? JSON.parse(texto) : null) as T };
  }

  get<T = unknown>(uri: string) {
    return this.requisitar<T>('GET', uri);
  }
  post<T = unknown>(uri: string, dados?: Dados) {
    return this.requisitar<T>('POST', uri, dados);
  }
  put<T = unknown>(uri: string, dados?: Dados) {
    return this.requisitar<T>('PUT', uri, dados);
  }
  patch<T = unknown>(uri: string, dados?: Dados) {
    return this.requisitar<T>('PATCH', uri, dados);
  }
  delete<T = unknown>(uri: string) {
    return this.requisitar<T>('DELETE', uri);
  }

  /** Muda o tenant ativo (após o SelectTenant do guard client). */
  usarTenant(uuid: string): void {
    this.papel.tenantUuid = uuid;
  }

  async encerrar(): Promise<void> {
    await this.ctx.dispose();
  }
}

/** Administrador semeado (`E2E_ADMIN_CPF`/`E2E_ADMIN_PASSWORD`, guard manager). */
export function papelAdministrador(cfg: ConfigMassa): Papel {
  return { nome: 'admin', guard: 'manager', cpf: cfg.adminCpf, senha: cfg.adminSenha };
}
