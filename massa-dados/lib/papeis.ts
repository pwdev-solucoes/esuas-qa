/**
 * Registro dos usuários da massa e moldura das etapas E1–E9 (#10994 · BR-001, BR-004, BR-005, BR-012).
 *
 * - `Sessoes`: código do elenco (`admin`, `M0`, `P0`…`P7`) → `ClientePapel` com login sob demanda,
 *   um contexto HTTP por usuário (sessão única) e `X-Tenant-UUID` da organização demo no guard client.
 * - `senhaMassa()`: senha dos usuários criados pela massa (Master, P0–P7), definida pelo fluxo real de
 *   redefinição (Mailpit). Vem de `MASSA_SENHA_PADRAO` ou é sorteada uma vez e guardada em
 *   `.cache/` (gitignored, 0600) para as etapas seguintes; nunca vai para log nem para o estado.
 * - `etapa()`: um `test` do Playwright que lê o estado da execução, registra os passos HTTP (papel,
 *   método, URI, status, chave de negócio) e grava `ok`/`falha` no estado. `MASSA_FALHAR_EM=<id>`
 *   injeta uma falha (teste de interrupção, AC-012).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { carregarConfig, logPadrao, PASTA_CACHE, RAIZ_MASSA, registrarSegredos, type ConfigMassa } from './config.ts';
import { lerEstado, MapaChaves, RegistroEtapa, registrarEtapa } from './execucao.ts';
import { ClientePapel, FalhaHttp, papelAdministrador, type Guard, type Papel, type PassoHttp } from './http.ts';
import { buscarLinkRedefinicao, definirSenha } from './mailpit.ts';

// ---------------------------------------------------------------------------------------------
// Insumos
// ---------------------------------------------------------------------------------------------

export interface ProfissionalElenco {
  chave: string;
  nome: string;
  cpf: string;
  email: string;
  cbo: string;
  papel: string;
  add_ons: string[];
  permissoes_extras: string[];
  lotacoes: Array<{ unidade: string; desde: string }>;
  finalidade: string;
}

export interface PessoaElenco {
  chave: string;
  nome: string;
  cpf: string | null;
  nascimento: string;
  nome_mae: string;
  sexo: string;
  escolaridade: string | null;
  parentesco: string;
  familia_chave: string;
  condicoes: {
    alfabetizado: boolean | null;
    deficiencia: boolean | null;
    doenca_grave: boolean | null;
    renda_propria: number | null;
    situacao_escolar: string | null;
    trabalho_infantil: boolean | null;
  };
}

export interface FamiliaElenco {
  chave: string;
  cenario: string;
  exibe: string;
  responsavel: string;
  unidade_referencia: string | null;
  referenciada_em: string | null;
  especificidade_codigo: string | null;
  especificidade_confirmada: boolean;
  habitacao: { tipo_residencia: string; area_risco: boolean; vulnerabilidade: boolean } | null;
  programas_sociais: Array<{ codigo: string; beneficiario: string }>;
  recebe_pbf: boolean;
  renda_per_capita: number;
}

export interface Elenco {
  versao: string;
  lotacoes_desde: string;
  organizacao: {
    razao_social: string;
    cnpj: string;
    ibge: string;
    municipio: string;
    uf: string;
    master: { chave: string; nome: string; cpf: string; email: string; papel: string };
  };
  unidades: Array<{ chave: string; nome: string; tipo: string }>;
  profissionais: ProfissionalElenco[];
  pessoas: PessoaElenco[];
  familias: FamiliaElenco[];
}

export interface UnidadeFicticia {
  chave: string;
  nome: string;
  tipo: string;
  tipo_codigo: string;
  codigo_mds: string;
  coordenada: { bairro: string; latitude: number; longitude: number; setor: string };
  endereco: { bairro: string; logradouro: string | null; municipio_ibge: string; numero: string };
}

export interface EntidadeFicticia {
  chave: string;
  nome: string;
  cnpj: string;
  cneas: string | null;
  municipio_ibge: string;
  exibe: string;
}

export const PASTA_INSUMOS = resolve(RAIZ_MASSA, 'insumos');

export function lerInsumo<T>(relativo: string): T {
  return JSON.parse(readFileSync(resolve(PASTA_INSUMOS, relativo), 'utf8')) as T;
}

export function lerElenco(): Elenco {
  return lerInsumo<Elenco>('elenco.json');
}

// ---------------------------------------------------------------------------------------------
// Senha dos usuários criados pela massa
// ---------------------------------------------------------------------------------------------

const ARQUIVO_SENHA = resolve(PASTA_CACHE, 'senha-usuarios-massa');

/** Senha dos usuários da massa: `MASSA_SENHA_PADRAO` ou sorteada e guardada em `.cache/` (0600). */
export function senhaMassa(cfg: ConfigMassa): string {
  let senha = cfg.senhaPadrao;
  if (!senha) {
    if (existsSync(ARQUIVO_SENHA)) senha = readFileSync(ARQUIVO_SENHA, 'utf8').trim();
    if (!senha) {
      // Letras, dígitos e símbolo: atende a política de senha forte do reset-password.
      senha = `Massa#${randomBytes(9).toString('base64url')}9a`;
      mkdirSync(PASTA_CACHE, { recursive: true });
      writeFileSync(ARQUIVO_SENHA, `${senha}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(ARQUIVO_SENHA, 0o600);
    }
  }
  registrarSegredos([senha]);
  return senha;
}

// ---------------------------------------------------------------------------------------------
// Sessões por papel
// ---------------------------------------------------------------------------------------------

export const CHAVE_TENANT = 'TENANT';

export interface UsuarioMassa {
  codigo: string;
  guard: Guard;
  cpf: string;
  email: string;
}

/** Usuários conhecidos pelo código do elenco (Master = `M0`, profissionais = `P0`…`P7`). */
export function usuariosDoElenco(e: Elenco): UsuarioMassa[] {
  const m = e.organizacao.master;
  return [
    { codigo: m.chave, guard: 'client', cpf: m.cpf, email: m.email },
    ...e.profissionais.map((p) => ({ codigo: p.chave, guard: 'client' as const, cpf: p.cpf, email: p.email })),
  ];
}

export class Sessoes {
  private readonly abertas = new Map<string, ClientePapel>();

  constructor(
    private readonly cfg: ConfigMassa,
    private readonly elenco: Elenco,
    private readonly chaves: MapaChaves,
    private readonly aoRegistrar: (passo: PassoHttp) => void,
  ) {}

  usuario(codigo: string): UsuarioMassa {
    const u = usuariosDoElenco(this.elenco).find((x) => x.codigo === codigo);
    if (!u) throw new Error(`Usuário "${codigo}" não existe no elenco.`);
    return u;
  }

  private papel(codigo: string): Papel {
    if (codigo === 'admin') return papelAdministrador(this.cfg);
    const u = this.usuario(codigo);
    return { nome: codigo, guard: 'client', cpf: u.cpf, senha: senhaMassa(this.cfg), tenantUuid: this.chaves.obter(CHAVE_TENANT) };
  }

  /** Cliente autenticado do papel (login na primeira chamada; reaproveita o contexto depois). */
  async entrar(codigo: string): Promise<ClientePapel> {
    const aberta = this.abertas.get(codigo);
    if (aberta) return aberta;
    const cliente = await ClientePapel.autenticar(this.cfg, this.papel(codigo), { aoRegistrar: this.aoRegistrar });
    this.abertas.set(codigo, cliente);
    return cliente;
  }

  /** Descarta a sessão do papel (ex.: para o add-on valer, BR-005, é preciso novo login). */
  async sair(codigo: string): Promise<void> {
    const c = this.abertas.get(codigo);
    this.abertas.delete(codigo);
    await c?.encerrar();
  }

  async encerrar(): Promise<void> {
    for (const c of this.abertas.values()) await c.encerrar();
    this.abertas.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Operações comuns
// ---------------------------------------------------------------------------------------------

type Multipart = Record<string, string | number | boolean | { name: string; mimeType: string; buffer: Buffer }>;

/**
 * Upload multipart pelo MESMO contexto autenticado do `ClientePapel` (cookie Sanctum + XSRF), com o
 * mesmo registro de passo. O `http.ts` só envia JSON; os membros privados são acessados por índice
 * para não duplicar a sessão.
 */
export async function enviarArquivo<T = unknown>(cliente: ClientePapel, uri: string, campos: Multipart): Promise<{ status: number; corpo: T }> {
  const interno = cliente as unknown as {
    ctx: APIRequestContext;
    apiBase: string;
    xsrf(): Promise<string | undefined>;
    registrar(metodo: string, uri: string, status: number, duracaoMs: number): void;
  };
  const token = await interno.xsrf();
  const headers: Record<string, string> = {};
  if (token) headers['X-XSRF-TOKEN'] = token;
  if (cliente.papel.tenantUuid) headers['X-Tenant-UUID'] = cliente.papel.tenantUuid;
  const inicio = Date.now();
  const r: APIResponse = await interno.ctx.fetch(`${interno.apiBase}${uri}`, { method: 'POST', headers, multipart: campos, timeout: 15 * 60_000 });
  interno.registrar('POST', uri, r.status(), Date.now() - inicio);
  const texto = await r.text();
  if (!r.ok()) throw new FalhaHttp({ papel: cliente.papel.nome, metodo: 'POST', uri, status: r.status(), duracaoMs: 0 }, texto);
  return { status: r.status(), corpo: (texto ? JSON.parse(texto) : null) as T };
}

export function arquivo(caminho: string, mimeType: string): { name: string; mimeType: string; buffer: Buffer } {
  return { name: basename(caminho), mimeType, buffer: readFileSync(caminho) };
}

/** Aceita todos os documentos legais pendentes do usuário (BR-006). Devolve os aceitos. */
export async function aceitarPendentes(cliente: ClientePapel): Promise<Array<{ document_id: number; title: string; version_number?: number }>> {
  const { corpo } = await cliente.get<{ data: Array<{ document_id: number; title: string; version_number?: number }> }>('/api/legal-acceptance/pending');
  for (const d of corpo.data) await cliente.post(`/api/legal-acceptance/${d.document_id}/accept`, { accepted: true });
  return corpo.data.map((d) => ({ document_id: d.document_id, title: d.title, version_number: d.version_number }));
}

/**
 * Primeiro acesso de um usuário criado pela API (A6/RN-T7): espera o e-mail de redefinição disparado
 * na criação, redefine a senha pelo fluxo real (forgot → Mailpit → reset) e faz login + aceite legal.
 */
export async function primeiroAcesso(ctx: ContextoEtapa, codigo: string, criadoEm: Date): Promise<ClientePapel> {
  const u = ctx.sessoes.usuario(codigo);
  // O e-mail de reset disparado na criação precisa ter saído da fila ANTES do forgot-password:
  // senão o token dele sobrescreve o novo e o link lido fica inválido.
  await buscarLinkRedefinicao(ctx.cfg.mailpitUrl, u.email, { desde: criadoEm, timeoutMs: 120_000 });
  await definirSenha(ctx.cfg, { email: u.email, guard: u.guard }, senhaMassa(ctx.cfg), { timeoutMs: 120_000 });
  ctx.registro.passo({ chave: codigo, passo: 'senha definida pelo link do Mailpit' });
  await ctx.sessoes.sair(codigo);
  const cliente = await ctx.sessoes.entrar(codigo);
  const aceitos = await aceitarPendentes(cliente);
  ctx.registro.passo({ chave: codigo, passo: 'aceite legal', documentos: aceitos.map((d) => `${d.title} v${d.version_number ?? '?'}`) });
  return cliente;
}

/** Id/uuid do `data` de uma resposta da API (`{ data: {...} }` ou o próprio objeto). */
export function dados<T = Record<string, unknown>>(corpo: unknown): T {
  const c = corpo as { data?: unknown };
  return (c && typeof c === 'object' && 'data' in c ? c.data : corpo) as T;
}

/** Lista paginada inteira (segue `meta.last_page`). `uri` pode já ter querystring. */
export async function listarTudo<T = Record<string, unknown>>(cliente: ClientePapel, uri: string, porPagina = 100): Promise<T[]> {
  const itens: T[] = [];
  const sep = uri.includes('?') ? '&' : '?';
  for (let pagina = 1; pagina < 1000; pagina += 1) {
    const { corpo } = await cliente.get<{ data: T[]; meta?: { last_page?: number } }>(`${uri}${sep}per_page=${porPagina}&page=${pagina}`);
    itens.push(...(corpo.data ?? []));
    if (!corpo.meta?.last_page || pagina >= corpo.meta.last_page) break;
  }
  return itens;
}

export interface EnderecoDne {
  payload: Record<string, unknown>;
  origem: string;
}

/** Endereço com logradouro do DNE (TODO: definido após explorar a carga). */
export async function resolverEnderecoDne(_cliente: ClientePapel, _o: { ibge: string; uf: string; bairro: string; numero: string }): Promise<EnderecoDne> {
  throw new Error('resolverEnderecoDne: não implementado');
}

// ---------------------------------------------------------------------------------------------
// Moldura das etapas
// ---------------------------------------------------------------------------------------------

export interface ContextoEtapa {
  cfg: ConfigMassa;
  caminho: string;
  elenco: Elenco;
  chaves: MapaChaves;
  registro: RegistroEtapa;
  sessoes: Sessoes;
  log: (linha: string) => void;
  /** Registra um achado RN14 (produto recusou um cenário do elenco) sem PII. */
  achado: (texto: string) => void;
  /** Chave de negócio corrente, anexada aos passos HTTP seguintes. */
  chaveAtual: string | null;
}

/**
 * Declara a etapa `id` como um teste serial. `corpo` recebe o contexto; qualquer exceção marca a
 * etapa como `falha` no estado (o CLI interrompe as seguintes).
 */
export function etapa(id: string, titulo: string, papel: string, corpo: (ctx: ContextoEtapa) => Promise<void>): void {
  test.describe.serial(`${id} — ${titulo}`, () => {
    test(`${id}: ${titulo}`, async () => {
      const { caminho } = lerEstado();
      const cfg = carregarConfig();
      const registro = new RegistroEtapa(id, papel);
      const chaves = new MapaChaves(caminho);
      const elenco = lerElenco();
      const ctx = {} as ContextoEtapa;
      const sessoes = new Sessoes(cfg, elenco, chaves, (p) => registro.passo({ ...p, ...(ctx.chaveAtual ? { chave: ctx.chaveAtual } : {}) }));
      Object.assign(ctx, {
        cfg,
        caminho,
        elenco,
        chaves,
        registro,
        sessoes,
        log: logPadrao,
        chaveAtual: null,
        achado: (texto: string) => {
          registro.aviso(`ACHADO RN14: ${texto}`);
          logPadrao(`  ⚠ ACHADO RN14: ${texto}`);
        },
      } satisfies ContextoEtapa);
      try {
        if ((process.env.MASSA_FALHAR_EM ?? '').toUpperCase() === id.toUpperCase()) {
          throw new Error(`falha injetada em ${id} (MASSA_FALHAR_EM)`);
        }
        await corpo(ctx);
        registrarEtapa(caminho, registro.concluir('ok'));
      } catch (erro) {
        registro.aviso(`falha: ${(erro as Error).message}`);
        registrarEtapa(caminho, registro.concluir('falha'));
        throw erro;
      } finally {
        await sessoes.encerrar();
      }
    });
  });
}
