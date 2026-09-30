/**
 * Coleta de evidências por etapa (#10994 · plano 06, BR-002, BR-003, RN-T5, RN-T7).
 *
 * - Só grava quando o CLI roda com `--evidencias`: o CLI cria a pasta datada da execução e a passa às
 *   etapas em `MASSA_RELATORIO_DIR`. Sem a variável, `Evidencia` só acumula em memória (no-op no disco).
 * - Cada etapa grava `dados/<etapa>.json` com contagens conferidas, notas e prints (nome + legenda
 *   estáveis, reaproveitados no manual). Os passos HTTP e os avisos continuam no estado da execução.
 * - Prints são tirados aqui, com um navegador próprio e o login real da tela (CPF + senha da massa),
 *   e NUNCA pelo screenshot automático do Playwright. A tela de login não é capturada: o print sai só
 *   depois da navegação para a rota-alvo. Se o print falhar, fica uma nota — a etapa não falha por isso.
 * - Tudo passa por `sanitizar()` antes de ir para o disco (senha, token, cookie, XSRF).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { executorPadrao, registrarSegredos, sanitizar, type ConfigMassa } from './config.ts';

export const VARIAVEL_RELATORIO = 'MASSA_RELATORIO_DIR';

export interface PrintEvidencia {
  /** Caminho relativo à pasta da execução (`screens/<nome>.png`). */
  arquivo: string;
  legenda: string;
  /** Âncora estável na página da etapa (ex.: `ca09`). */
  ancora: string;
  ca?: string;
}

export interface ContagemEvidencia {
  item: string;
  esperado: number | string | null;
  obtido: number | string | null;
  ok: boolean;
}

export interface EvidenciaEtapa {
  etapa: string;
  prints: PrintEvidencia[];
  contagens: ContagemEvidencia[];
  notas: string[];
}

/** Pasta da execução corrente (definida pelo CLI com `--evidencias`) ou `null`. */
export function pastaRelatorioAtiva(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[VARIAVEL_RELATORIO];
  return v && v.trim() ? v : null;
}

/** Nome estável de arquivo para um id de etapa (`E10` → `e10`, `E01b` → `e01b`). */
export const baseEtapa = (id: string): string => id.toLowerCase();

export function caminhoDadosEtapa(pasta: string, etapa: string): string {
  return resolve(pasta, 'dados', `${baseEtapa(etapa)}.json`);
}

/** Lê todas as evidências gravadas numa pasta de execução (etapa → evidência). */
export function lerEvidencias(pasta: string): Record<string, EvidenciaEtapa> {
  const dir = resolve(pasta, 'dados');
  if (!existsSync(dir)) return {};
  const saida: Record<string, EvidenciaEtapa> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const e = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as EvidenciaEtapa;
    saida[e.etapa] = e;
  }
  return saida;
}

/** Nome de print seguro e estável (`e10-01-prontuario-f-sem-cpf`). */
export function nomePrint(nome: string): string {
  const n = nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!n) throw new Error('nome de print vazio');
  return n;
}

export interface OpcoesPrint {
  cfg: ConfigMassa;
  /** CPF do usuário que abre a tela (login real, guard client). */
  cpf: string;
  senha: string;
  /** Rota do client, relativa (`/app/...`). */
  rota: string;
  /** Nome estável do arquivo, sem extensão. */
  nome: string;
  legenda: string;
  ca?: string;
  /** Texto que precisa aparecer na tela antes do print (opcional). */
  esperarTexto?: string | RegExp;
}

export class Evidencia {
  private readonly dados: EvidenciaEtapa;

  constructor(
    readonly etapa: string,
    private readonly pasta: string | null = pastaRelatorioAtiva(),
  ) {
    const existente = this.pasta && existsSync(caminhoDadosEtapa(this.pasta, etapa)) ? (JSON.parse(readFileSync(caminhoDadosEtapa(this.pasta, etapa), 'utf8')) as EvidenciaEtapa) : null;
    this.dados = existente ?? { etapa, prints: [], contagens: [], notas: [] };
  }

  /** `true` quando a execução grava relatório (`--evidencias`). */
  get ativa(): boolean {
    return this.pasta !== null;
  }

  get conteudo(): EvidenciaEtapa {
    return this.dados;
  }

  /** Contagem conferida (esperado × obtido). Substitui uma contagem anterior com o mesmo item. */
  contagem(item: string, esperado: number | string | null, obtido: number | string | null): ContagemEvidencia {
    const c: ContagemEvidencia = { item: sanitizar(item), esperado, obtido, ok: String(esperado) === String(obtido) };
    this.dados.contagens = [...this.dados.contagens.filter((x) => x.item !== c.item), c];
    return c;
  }

  nota(texto: string): void {
    this.dados.notas.push(sanitizar(texto));
  }

  /**
   * Abre a rota do client com o login real do usuário e salva `screens/<nome>.png`. Sem `--evidencias`
   * não faz nada. Falha no print vira nota (sem senha), nunca falha da etapa.
   * Atenção: o login pela tela encerra a sessão da API do mesmo usuário (sessão única) — chame no fim.
   */
  async print(o: OpcoesPrint): Promise<PrintEvidencia | null> {
    if (!this.pasta) return null;
    registrarSegredos([o.senha]);
    const nome = nomePrint(o.nome);
    const arquivo = `screens/${nome}.png`;
    mkdirSync(resolve(this.pasta, 'screens'), { recursive: true });
    const navegador = await chromium.launch();
    try {
      const pagina = await navegador.newPage({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
      // Login pela tela; em throttle (429) limpa o cache de rate-limit e tenta de novo, como o `http.ts`.
      for (let tentativa = 1; ; tentativa += 1) {
        await pagina.goto(`${o.cfg.clientUrl}/auth/login`, { waitUntil: 'networkidle' });
        await pagina.locator('#cpf').fill(o.cpf);
        await pagina.locator('#password').fill(o.senha);
        await pagina.locator('button[type="submit"]').click();
        try {
          await pagina.waitForURL(/\/(app|auth\/select-tenant|legal-acceptance)/, { timeout: 20_000 });
          break;
        } catch (erro) {
          if (tentativa >= 3) throw erro;
          if (o.cfg.cacheClearCmd) executorPadrao.shell(o.cfg.cacheClearCmd);
        }
      }
      if (/select-tenant/.test(pagina.url())) {
        await pagina.getByRole('button').filter({ hasText: /Demonstração SigSUAS/i }).first().click();
        await pagina.waitForURL(/\/app/, { timeout: 60_000 });
      }
      await pagina.goto(`${o.cfg.clientUrl}${o.rota}`, { waitUntil: 'networkidle' });
      if (o.esperarTexto) await pagina.getByText(o.esperarTexto).first().waitFor({ timeout: 30_000 });
      await pagina.waitForTimeout(800);
      await pagina.screenshot({ path: resolve(this.pasta, arquivo), fullPage: false });
      const p: PrintEvidencia = { arquivo, legenda: sanitizar(o.legenda), ancora: nome, ...(o.ca ? { ca: o.ca } : {}) };
      this.dados.prints = [...this.dados.prints.filter((x) => x.arquivo !== arquivo), p];
      return p;
    } catch (erro) {
      this.nota(`print "${nome}" não capturado: ${sanitizar((erro as Error).message).split('\n')[0]}`);
      return null;
    } finally {
      await navegador.close();
    }
  }

  /** Grava `dados/<etapa>.json` (sanitizado). Sem `--evidencias` não grava nada. */
  salvar(): string | null {
    if (!this.pasta) return null;
    const destino = caminhoDadosEtapa(this.pasta, this.etapa);
    mkdirSync(resolve(this.pasta, 'dados'), { recursive: true });
    writeFileSync(destino, `${sanitizar(JSON.stringify(this.dados, null, 2))}\n`, 'utf8');
    return destino;
  }
}
