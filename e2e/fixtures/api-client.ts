import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import * as path from 'node:path';

const API_CLIENT_STATE = path.resolve(__dirname, '..', '.auth', 'api-client.json');

/**
 * Cliente HTTP autenticado para semear/limpar dados via API durante testes E2E.
 *
 * Reaproveita o storageState (cookies Sanctum esuas-session + XSRF-TOKEN) gerado
 * pelo `tests/auth.setup.ts` — evita re-login a cada teste e estourar o throttle
 * de 6 requests/min nas rotas de auth.
 */
export class ApiClient {
  private constructor(private readonly api: APIRequestContext) {}

  static async createAuthenticated(): Promise<ApiClient> {
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
    const frontendOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:4173';

    const api = await playwrightRequest.newContext({
      baseURL: apiBase,
      storageState: API_CLIENT_STATE,
      extraHTTPHeaders: {
        Accept: 'application/json',
        Origin: frontendOrigin,
        Referer: `${frontendOrigin}/auth/login`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    return new ApiClient(api);
  }

  async dispose(): Promise<void> {
    await this.api.dispose();
  }

  async post<T = unknown>(endpoint: string, data?: unknown): Promise<T> {
    const xsrf = await this.getXsrf();
    const res = await this.api.post(`/api${endpoint}`, {
      data,
      headers: { 'X-XSRF-TOKEN': xsrf },
    });
    if (!res.ok()) {
      throw new Error(`POST ${endpoint} falhou: ${res.status()} — ${await res.text()}`);
    }

    return res.json() as Promise<T>;
  }

  async get<T = unknown>(endpoint: string): Promise<T> {
    const res = await this.api.get(`/api${endpoint}`);
    if (!res.ok()) {
      throw new Error(`GET ${endpoint} falhou: ${res.status()} — ${await res.text()}`);
    }

    return res.json() as Promise<T>;
  }

  async delete(endpoint: string): Promise<void> {
    const xsrf = await this.getXsrf();
    const res = await this.api.delete(`/api${endpoint}`, {
      headers: { 'X-XSRF-TOKEN': xsrf },
    });
    if (!res.ok() && res.status() !== 204) {
      throw new Error(`DELETE ${endpoint} falhou: ${res.status()} — ${await res.text()}`);
    }
  }

  private async getXsrf(): Promise<string> {
    const state = await this.api.storageState();
    const xsrf = state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value;
    if (!xsrf) throw new Error('XSRF-TOKEN ausente no contexto autenticado');

    return decodeURIComponent(xsrf);
  }
}
