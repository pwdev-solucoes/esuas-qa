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
import { request as playwrightRequest, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { carregarConfig, logPadrao, PASTA_CACHE, RAIZ_MASSA, registrarSegredos, type ConfigMassa } from './config.ts';
import { lerEstado, MapaChaves, RegistroEtapa, registrarEtapa, type EstadoExecucao } from './execucao.ts';
import { ClientePapel, FalhaHttp, papelAdministrador, type Guard, type Papel, type PassoHttp } from './http.ts';
import { buscarLinkRedefinicao, definirSenha, lerLink } from './mailpit.ts';
import { limparRateLimit } from './reset.ts';

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
  /** Competência fixa (`AAAA-MM`) do DNE importado na E01b (CR-003). */
  dne: { competencia: string };
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

/** POST reset-password com o token/e-mail do link recebido; `false` se a API recusar (token vencido). */
export async function redefinirPeloLink(cfg: ConfigMassa, guard: Guard, link: string, senha: string): Promise<boolean> {
  registrarSegredos([senha]);
  const { token, email } = lerLink(link);
  registrarSegredos([token]);
  const origem = guard === 'manager' ? cfg.adminUrl : cfg.clientUrl;
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: { Accept: 'application/json', Origin: origem, Referer: `${origem}/auth/reset-password`, 'X-Requested-With': 'XMLHttpRequest' },
  });
  try {
    await ctx.get(`${cfg.apiBase}/sanctum/csrf-cookie`);
    for (let tentativa = 1; ; tentativa += 1) {
      const c = (await ctx.storageState()).cookies.find((k) => k.name === 'XSRF-TOKEN');
      const r = await ctx.post(`${cfg.apiBase}/api/${guard}/auth/reset-password`, {
        data: { token, email, password: senha, password_confirmation: senha },
        headers: c ? { 'X-XSRF-TOKEN': decodeURIComponent(c.value) } : {},
      });
      logPadrao(`  [mailpit] POST /api/${guard}/auth/reset-password (link do e-mail) → ${r.status()}`);
      // Throttle por IP: limpa o cache de rate-limit e repete (o token segue válido).
      if (r.status() === 429 && tentativa < 4 && limparRateLimit(cfg, { log: logPadrao })) continue;
      return r.ok();
    }
  } finally {
    await ctx.dispose();
  }
}

/**
 * Primeiro acesso de um usuário criado pela API (A6/RN-T7): lê no Mailpit o e-mail de redefinição
 * disparado na criação, define a senha pelo link (fallback: forgot → Mailpit → reset) e faz login + aceite legal.
 */
export async function primeiroAcesso(ctx: ContextoEtapa, codigo: string, criadoEm: Date): Promise<ClientePapel> {
  const u = ctx.sessoes.usuario(codigo);
  // Caminho do usuário real (A6): a criação dispara boas-vindas + redefinição; a senha é definida pelo
  // link DESSE e-mail. Pedir outro link logo em seguida cai no throttle do broker de senha (1/min por
  // usuário, respondido como sucesso), então o forgot-password só entra se o link da criação falhar.
  let link: string;
  try {
    link = await buscarLinkRedefinicao(ctx.cfg.mailpitUrl, u.email, { desde: criadoEm, timeoutMs: 120_000 });
  } catch (erro) {
    throw new Error(
      `${(erro as Error).message} A API precisa entregar e-mail no Mailpit (mailer smtp → Mailpit); com o mailer "log" o link de senha só vai para o log e o primeiro acesso é impossível pelo fluxo real (RN-T7).`,
    );
  }
  if (!(await redefinirPeloLink(ctx.cfg, u.guard, link, senhaMassa(ctx.cfg)))) {
    ctx.registro.aviso(`${codigo}: link do e-mail de criação recusado; pedindo novo link (forgot-password).`);
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        await definirSenha(ctx.cfg, { email: u.email, guard: u.guard }, senhaMassa(ctx.cfg), { timeoutMs: 120_000 });
        break;
      } catch (erro) {
        if (!/HTTP 429/.test((erro as Error).message) || tentativa >= 4) throw erro;
        ctx.log(`  ⚠ ${codigo}: 429 na redefinição de senha; limpando o cache de rate-limit (tentativa ${tentativa + 1}/4)`);
        if (!limparRateLimit(ctx.cfg, { log: ctx.log })) await new Promise((ok) => setTimeout(ok, 60_000));
      }
    }
  }
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
  /** Campos do bloco de endereço (StoreAddressRequest / official-address). */
  payload: {
    street_type: string;
    street: string;
    number: string;
    territorial_unit: string;
    territorial_unit_type: string;
    city_id: number;
    territorial_unit_id: number;
    street_id: number;
  };
  /** Descrição curta da origem no DNE (sem PII: logradouros são públicos). */
  origem: string;
}

const cacheEnderecos = new Map<string, EnderecoDne>();

/**
 * Endereço com logradouro REAL do DNE importado na E01b: UF → município (IBGE) → bairro (unidade
 * territorial) → primeiro logradouro do bairro em ordem alfabética (determinístico). Só GET em
 * `/api/relationals/*` (valem para os guards manager e client).
 */
export async function resolverEnderecoDne(
  cliente: ClientePapel,
  o: { ibge: string; uf: string; municipio: string; bairro: string; numero: string },
): Promise<EnderecoDne> {
  const chave = `${o.ibge}|${o.bairro}`;
  const emCache = cacheEnderecos.get(chave);
  if (emCache) return { ...emCache, payload: { ...emCache.payload, number: o.numero } };
  const q = encodeURIComponent;
  const estados = dados<Array<{ id: number; uf: string }>>((await cliente.get(`/api/relationals/states?filter[search]=${q(o.uf === 'AL' ? 'Alagoas' : o.uf)}`)).corpo);
  const estado = estados.find((e) => e.uf === o.uf);
  if (!estado) throw new Error(`UF ${o.uf} não encontrada em relationals/states.`);
  const cidades = dados<Array<{ id: number; ibge_code: string }>>(
    (await cliente.get(`/api/relationals/cities?filter[state_id]=${estado.id}&filter[search]=${q(o.municipio)}`)).corpo,
  );
  const cidade = cidades.find((c) => c.ibge_code === o.ibge);
  if (!cidade) throw new Error(`Município IBGE ${o.ibge} não encontrado.`);
  const unidades = dados<Array<{ id: number; name: string; type: string | null }>>(
    (await cliente.get(`/api/relationals/territorial-units?filter[city_id]=${cidade.id}&filter[search]=${q(o.bairro)}`)).corpo,
  );
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const unidade = unidades.find((u) => norm(u.name) === norm(o.bairro)) ?? unidades[0];
  if (!unidade) throw new Error(`Bairro "${o.bairro}" (${o.ibge}) sem unidade territorial no DNE — a E01b importou o DNE?`);
  const ruas = dados<Array<{ id: number; name: string; street_type: string | null }>>(
    (await cliente.get(`/api/relationals/streets?filter[territorial_unit_id]=${unidade.id}`)).corpo,
  );
  const rua = [...ruas].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id - b.id)[0];
  if (!rua) throw new Error(`Bairro "${unidade.name}" sem logradouro no DNE.`);
  const r: EnderecoDne = {
    payload: {
      street_type: rua.street_type ?? 'Rua',
      street: rua.name,
      number: o.numero,
      territorial_unit: unidade.name,
      territorial_unit_type: unidade.type ?? 'Bairro',
      city_id: cidade.id,
      territorial_unit_id: unidade.id,
      street_id: rua.id,
    },
    origem: `DNE: ${rua.street_type ?? ''} ${rua.name} / ${unidade.name}`.trim(),
  };
  cacheEnderecos.set(chave, r);
  return r;
}


/** Status HTTP de uma `FalhaHttp` (ou `null` para outros erros). */
export function statusDaFalha(erro: unknown): number | null {
  return erro instanceof FalhaHttp ? erro.passo.status : null;
}

/**
 * Repete `fn` em 429 (rate-limit de rotas com throttle, ex.: cadastro de pessoa), limpando o cache de
 * rate-limit (`limparRateLimit`: cache clear + worker religado) entre as tentativas. Outros erros sobem na hora.
 */
export async function comRetentativa429<T>(ctx: ContextoEtapa, fn: () => Promise<T>, tentativas = 4): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (erro) {
      if (statusDaFalha(erro) !== 429 || i >= tentativas) throw erro;
      ctx.log(`  ⚠ 429: limpando o cache de rate-limit (tentativa ${i + 1}/${tentativas})`);
      if (!limparRateLimit(ctx.cfg, { log: ctx.log })) await new Promise((ok) => setTimeout(ok, 60_000));
    }
  }
}

/** Resolve id de lookup pelo `code` (ou `name`) numa listagem `relationals`/índice. */
export async function idDoLookup(cliente: ClientePapel, uri: string, valor: string, campo: 'code' | 'name' = 'code'): Promise<number> {
  const itens = await listarTudo<Record<string, unknown>>(cliente, uri);
  const achado = itens.find((i) => String(i[campo]) === valor);
  if (!achado) throw new Error(`Lookup ${uri}: ${campo}="${valor}" não encontrado.`);
  return Number(achado.id);
}

/** Uuid de lookup pelo `code` (lookups do diagnóstico expõem só uuid). */
export async function uuidDoLookup(cliente: ClientePapel, uri: string, codigo: string): Promise<string> {
  const itens = await listarTudo<{ uuid: string; code: string }>(cliente, uri);
  const achado = itens.find((i) => String(i.code) === codigo);
  if (!achado) throw new Error(`Lookup ${uri}: code="${codigo}" não encontrado.`);
  return achado.uuid;
}

/** Id do CBO pelo código (`2516-05`). */
export async function idDoCbo(cliente: ClientePapel, codigo: string): Promise<number> {
  const { corpo } = await cliente.get<{ data: Array<{ id: number; code: string }> }>(`/api/relationals/cbos?filter[search]=${encodeURIComponent(codigo)}`);
  const achado = (corpo.data ?? []).find((c) => c.code === codigo);
  if (achado) return achado.id;
  return idDoLookup(cliente, '/api/relationals/cbos', codigo);
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

/** Variável com que o CLI marca a execução (`MASSA_VIA_CLI=<id da execução>`) ao chamar o Playwright. */
export const VARIAVEL_VIA_CLI = 'MASSA_VIA_CLI';

/**
 * Defesa em profundidade da trava de produção (CR-002, RN-T1): uma etapa só escreve quando foi chamada
 * pelo CLI desta execução (`MASSA_VIA_CLI` = `estado.id`), contra a MESMA API do estado e com a 2ª
 * checagem de `/api/environment` (`antes_do_reset`) registrada como ok. Devolve o motivo da recusa ou `null`.
 */
export function motivoRecusaEtapa(estado: EstadoExecucao, apiBase: string, viaCli: string | undefined = process.env[VARIAVEL_VIA_CLI]): string | null {
  const rodeCli = 'Rode pelo `npm run massa` (preflight, trava de produção e reset antes das etapas).';
  if (!viaCli) return `etapa chamada fora do CLI (${VARIAVEL_VIA_CLI} ausente). ${rodeCli}`;
  if (viaCli !== estado.id) return `${VARIAVEL_VIA_CLI} não corresponde à execução do estado (${estado.id}). ${rodeCli}`;
  if (estado.apiBase !== apiBase) return `o estado é de outra API (${estado.apiBase}); a configuração aponta ${apiBase}. ${rodeCli}`;
  const checagem = [...(estado.ambiente ?? [])].reverse().find((a) => a.momento === 'antes_do_reset');
  if (!checagem?.ok) return `o estado não registra a 2ª checagem de /api/environment (antes_do_reset) com sucesso. ${rodeCli}`;
  return null;
}

export class EtapaRecusada extends Error {
  constructor(id: string, motivo: string) {
    super(`${id} recusada antes de qualquer requisição: ${motivo}`);
    this.name = 'EtapaRecusada';
  }
}

/**
 * Executa o corpo da etapa `id` (moldura de `etapa()`, exportada para os testes). A guarda
 * `motivoRecusaEtapa` roda ANTES de qualquer login ou requisição; recusada, nada é gravado no estado.
 */
export async function executarEtapa(
  id: string,
  papel: string,
  corpo: (ctx: ContextoEtapa) => Promise<void>,
  o: { caminho?: string; cfg?: ConfigMassa; viaCli?: string } = {},
): Promise<void> {
  const { caminho, estado } = lerEstado(o.caminho);
  const cfg = o.cfg ?? carregarConfig();
  const motivo = motivoRecusaEtapa(estado, cfg.apiBase, 'viaCli' in o ? o.viaCli : process.env[VARIAVEL_VIA_CLI]);
  if (motivo) throw new EtapaRecusada(id, motivo);
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
}

/**
 * Declara a etapa `id` como um teste serial. `corpo` recebe o contexto; qualquer exceção marca a
 * etapa como `falha` no estado (o CLI interrompe as seguintes). Fora do CLI a etapa é recusada antes
 * de qualquer escrita (CR-002).
 */
export function etapa(id: string, titulo: string, papel: string, corpo: (ctx: ContextoEtapa) => Promise<void>): void {
  test.describe.serial(`${id} — ${titulo}`, () => {
    test(`${id}: ${titulo}`, async () => {
      await executarEtapa(id, papel, corpo);
    });
  });
}
