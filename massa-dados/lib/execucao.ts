/**
 * Estado de uma execução da massa (#10994). O CLI grava o que fez fora do Playwright (preflight,
 * travas, reset, DNE) em um arquivo JSON; cada etapa (spec) lê, registra seus passos e grava de
 * volta. O plano 06 renderiza o relatório a partir deste estado.
 *
 * Nenhum segredo entra aqui: passos HTTP guardam só papel, método, URI e status.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PASTA_CACHE, sanitizar } from './config.ts';
import type { ResultadoPreflight } from './preflight.ts';
import type { PassoReset } from './reset.ts';
import type { ResultadoDne } from './dne.ts';

export type StatusEtapa = 'ok' | 'falha' | 'nao_executada';

/**
 * De onde veio o resultado da etapa: `api` (executor pela API), `manual` (passo feito na tela, E1–E3 da
 * validação híbrida), `seed` (`massa-demo:popular` no `api/`) ou `conferencia` (`massa:conferir`).
 * Ausente = `api` (estados anteriores ao plano 10).
 */
export type OrigemEtapa = 'api' | 'manual' | 'seed' | 'conferencia';

export interface EstadoEtapa {
  etapa: string;
  status: StatusEtapa;
  duracao: number;
  papel: string | null;
  passos: Array<Record<string, unknown>>;
  avisos: string[];
  origem?: OrigemEtapa;
}

export interface ChecagemAmbiente {
  momento: 'preflight' | 'antes_do_reset';
  ok: boolean;
  environment?: string;
  mensagem: string;
  em: string;
}

export interface EstadoExecucao {
  id: string;
  iniciadaEm: string;
  evidencias: boolean;
  ate: string | null;
  apiBase: string;
  preflight?: Pick<ResultadoPreflight, 'apto' | 'itens' | 'falhas' | 'avisos' | 'duracaoMs'>;
  ambiente: ChecagemAmbiente[];
  confirmacao?: 'flag' | 'digitado';
  reset?: PassoReset[];
  dne?: Omit<ResultadoDne, 'arquivo'> & { arquivo: string };
  etapas: EstadoEtapa[];
  /** chave de negócio → uuid (ex.: `U-CN` → uuid da unidade). */
  chaves: Record<string, string>;
  /**
   * Modo de conferência (plano 10): `seed` = base populada por `massa-demo:popular`, os cenários só via
   * seed são ESPERADOS presentes e as explicações RN14 da E17 deixam de valer. Ausente = `api`.
   */
  modo?: 'api' | 'seed';
  /** Texto da modalidade exibido no índice (ex.: `híbrida: manual E1–E3 · seed E4–E16 · conferência E17–E20`). */
  modalidade?: string;
  /** Cenários que só existem pela via seed (listados no índice). */
  somenteViaSeed?: string[];
}

/**
 * Ordem fixa das etapas (arquivo em `massa-dados/etapas/`). Planos 04–06 acrescentam E1…E20.
 * `filtro` seleciona uma parte de um arquivo (`playwright --grep`): E1 é dividida em E01 (1.1–1.5) e
 * E01c (1.6–1.9) em volta da E01b, e o Operacional de cadastro (6.0 = E06a) vem antes das unidades (BR-002).
 */
export interface DefinicaoEtapa {
  id: string;
  arquivo: string;
  titulo: string;
  filtro?: string;
}

export const ETAPAS: ReadonlyArray<DefinicaoEtapa> = [
  { id: 'E00', arquivo: 'e00-preflight.spec.ts', titulo: 'Preflight' },
  { id: 'E0', arquivo: 'e00-fundacoes.spec.ts', titulo: 'Fundações: aviso, trava, reset, DNE' },
  { id: 'E01', arquivo: 'e01-setup-global.spec.ts', titulo: 'Setup global: conferências e organização (1.1–1.5)', filtro: 'E01 — ' },
  { id: 'E01b', arquivo: 'e01b-importacoes.spec.ts', titulo: 'Importações geográficas: DNE, municípios, setores, bairros' },
  { id: 'E01c', arquivo: 'e01-setup-global.spec.ts', titulo: 'Setup global: endereço, CARDUG, Master, responsável (1.6–1.9)', filtro: 'E01c — ' },
  { id: 'E02', arquivo: 'e02-entrada-tenant.spec.ts', titulo: 'Entrada no tenant: senha, login, aceite legal' },
  { id: 'E03', arquivo: 'e03-configuracao.spec.ts', titulo: 'Configuração da organização pelo Master' },
  { id: 'E06a', arquivo: 'e06-profissionais.spec.ts', titulo: 'Operacional de cadastro P0 (6.0)', filtro: 'E06a — ' },
  { id: 'E04', arquivo: 'e04-unidades.spec.ts', titulo: 'Unidades: 2 CRAS + 1 CREAS' },
  { id: 'E05', arquivo: 'e05-entidades.spec.ts', titulo: 'Entidades socioassistenciais' },
  { id: 'E06', arquivo: 'e06-profissionais.spec.ts', titulo: 'Equipe P1–P7: perfis, add-ons, lotação, primeiro acesso (6.1–6.4)', filtro: 'E06 — ' },
  { id: 'E07', arquivo: 'e07-pessoas.spec.ts', titulo: 'Pessoas (faixa 98 e sem CPF)' },
  { id: 'E08', arquivo: 'e08-familias.spec.ts', titulo: 'Famílias, composição e prontuário' },
  { id: 'E09', arquivo: 'e09-diagnostico.spec.ts', titulo: 'Diagnóstico: condições habitacionais e do integrante' },
  { id: 'E10', arquivo: 'e10-atendimentos.spec.ts', titulo: 'Atendimentos (pessoas sem CPF) e zero declarado' },
  { id: 'E11', arquivo: 'e11-encaminhamentos.spec.ts', titulo: 'Encaminhamentos, desfechos e trânsito interno (CA09)' },
  { id: 'E12', arquivo: 'e12-acompanhamento.spec.ts', titulo: 'Acompanhamento PAIF/PAEFI e desligamentos' },
  { id: 'E13', arquivo: 'e13-participacoes.spec.ts', titulo: 'Participações: SCFV, F-IDOSO, F-GRUPO' },
  { id: 'E14', arquivo: 'e14-beneficios.spec.ts', titulo: 'Benefícios eventuais' },
  { id: 'E15', arquivo: 'e15-acolhimento.spec.ts', titulo: 'Acolhimento único (RN12)' },
  { id: 'E16', arquivo: 'e16-capacitacao.spec.ts', titulo: 'Capacitação CAP-1..3' },
  { id: 'E17', arquivo: 'e17-apuracao.spec.ts', titulo: 'Apuração × esperado e pendências de cadastro' },
  { id: 'E18', arquivo: 'e18-remessa.spec.ts', titulo: 'Conferência prévia e remessa SIAP (sem envio)' },
  { id: 'E19', arquivo: 'e19-painel-geo.spec.ts', titulo: 'Painel georreferenciado (leitura, P6)' },
  { id: 'E20', arquivo: 'e20-verificacao.spec.ts', titulo: 'Verificações finais (CA03, CA09, CA11, CA12, RN02b), snapshot e índice' },
];

/** Etapas até `ate` (inclusive), na ordem fixa. Lança se `ate` não existir. */
export function etapasAte(ate: string | null): typeof ETAPAS {
  if (!ate) return ETAPAS;
  const i = ETAPAS.findIndex((e) => e.id.toUpperCase() === ate.toUpperCase());
  if (i < 0) throw new Error(`--ate=${ate}: etapa desconhecida. Disponíveis: ${ETAPAS.map((e) => e.id).join(', ')}.`);
  return ETAPAS.slice(0, i + 1);
}

export const VARIAVEL_ESTADO = 'MASSA_EXECUCAO_ARQUIVO';

export function caminhoEstadoPadrao(id: string): string {
  return resolve(PASTA_CACHE, 'execucoes', `${id}.json`);
}

export function novaExecucao(o: { evidencias: boolean; ate: string | null; apiBase: string; agora?: Date }): EstadoExecucao {
  const agora = o.agora ?? new Date();
  const id = agora.toISOString().replace(/[:.]/g, '-');
  return { id, iniciadaEm: agora.toISOString(), evidencias: o.evidencias, ate: o.ate, apiBase: o.apiBase, ambiente: [], etapas: [], chaves: {} };
}

export function salvarEstado(caminho: string, estado: EstadoExecucao): void {
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, `${sanitizar(JSON.stringify(estado, null, 2))}\n`, 'utf8');
}

/** Lê o estado apontado por `MASSA_EXECUCAO_ARQUIVO` (definido pelo CLI). */
export function lerEstado(caminho = process.env[VARIAVEL_ESTADO]): { caminho: string; estado: EstadoExecucao } {
  if (!caminho || !existsSync(caminho)) {
    throw new Error(
      'Estado da execução ausente: as etapas da massa só rodam pelo CLI (`npm run massa`), que faz o preflight, a trava e o reset antes.',
    );
  }
  return { caminho, estado: JSON.parse(readFileSync(caminho, 'utf8')) as EstadoExecucao };
}

/** Registro de uma etapa em andamento. */
export class RegistroEtapa {
  private readonly inicio = Date.now();
  readonly passos: Array<Record<string, unknown>> = [];
  readonly avisos: string[] = [];

  constructor(
    readonly etapa: string,
    readonly papel: string | null = null,
  ) {}

  passo(p: Record<string, unknown>): void {
    this.passos.push(JSON.parse(sanitizar(JSON.stringify(p))) as Record<string, unknown>);
  }

  aviso(texto: string): void {
    this.avisos.push(sanitizar(texto));
  }

  concluir(status: Exclude<StatusEtapa, 'nao_executada'>): EstadoEtapa {
    return { etapa: this.etapa, status, duracao: Date.now() - this.inicio, papel: this.papel, passos: this.passos, avisos: this.avisos };
  }
}

/** Grava (ou substitui) o resultado de uma etapa no arquivo de estado. */
export function registrarEtapa(caminho: string, resultado: EstadoEtapa): void {
  const { estado } = lerEstado(caminho);
  // Na conferência híbrida (plano 10) as etapas que rodam agora são da conferência.
  if (estado.modo === 'seed' && !resultado.origem) resultado = { ...resultado, origem: 'conferencia' };
  estado.etapas = [...estado.etapas.filter((e) => e.etapa !== resultado.etapa), resultado];
  salvarEstado(caminho, estado);
}

/** Marca como `nao_executada` as etapas seguintes a uma falha (ou após `--ate`). */
export function marcarNaoExecutadas(estado: EstadoExecucao, ids: string[]): void {
  for (const id of ids) {
    if (!estado.etapas.some((e) => e.etapa === id)) {
      estado.etapas.push({ etapa: id, status: 'nao_executada', duracao: 0, papel: null, passos: [], avisos: [] });
    }
  }
}

/** Mapa chave de negócio → uuid, persistido no estado (comparação por chave, nunca por uuid). */
export class MapaChaves {
  constructor(private readonly caminho: string) {}

  definir(chave: string, uuid: string): void {
    const { estado } = lerEstado(this.caminho);
    estado.chaves[chave] = uuid;
    salvarEstado(this.caminho, estado);
  }

  obter(chave: string): string {
    const uuid = lerEstado(this.caminho).estado.chaves[chave];
    if (!uuid) throw new Error(`Chave de negócio "${chave}" ainda não resolvida (etapa anterior não a registrou).`);
    return uuid;
  }
}

// ---------------------------------------------------------------------------------------------
// Validação híbrida (plano 10): estado sintético a partir das chaves exportadas pelo seed
// ---------------------------------------------------------------------------------------------

export const MODALIDADE_HIBRIDA = 'híbrida: manual E1–E3 · seed E4–E16 · conferência E17–E20';

/** Etapas que a conferência roda de fato (só leitura de negócio, salvo a remessa sem envio da E18). */
export const ETAPAS_CONFERENCIA: ReadonlyArray<string> = ['E17', 'E18', 'E19', 'E20'];

/**
 * Cenários que só a via seed consegue gravar (a API recusa ou não tem endpoint). Mesma lista do
 * `SOMENTE_VIA_SEED` do `api/database/seeders/MassaDemo` (entidades + famílias).
 */
export const CENARIOS_SOMENTE_VIA_SEED: ReadonlyArray<string> = [
  'ENT-2 sem CNEAS (a API exige cneas_number no cadastro)',
  'F-SEM-REF-1..3 sem unidade de referência (o cadastro manual exige social_unit_id)',
  'families.receives_pbf/per_capita_income e family_members.child_labor dos perfis do 15.7 (campos do CadÚnico)',
  'endereço da família no DNE + geometria (coordenadas-familias.json, source massa-demo)',
];

/** Origem de cada etapa na modalidade híbrida (preflight e E17–E20 rodam na conferência). */
export function origemHibrida(id: string): OrigemEtapa {
  if (id === 'E00' || ETAPAS_CONFERENCIA.includes(id)) return 'conferencia';
  if (['E0', 'E01', 'E01b', 'E01c', 'E02', 'E03'].includes(id)) return 'manual';
  return 'seed';
}

/** Conteúdo do arquivo de chaves do seed (`storage/app/massa-demo/chaves.json`). */
export interface ArquivoChavesSeed {
  origem: 'seed';
  versao_elenco: string | null;
  chaves: Record<string, string>;
}

/**
 * Lê o arquivo de chaves com tolerância de formato (§6 do plano 10): `{origem, versao_elenco, chaves}`
 * (formato do `MassaDemoChaves::exportar`) ou um mapa plano. Recusa origem diferente de `seed` e
 * valores que não sejam texto.
 */
export function lerArquivoChaves(conteudo: string): ArquivoChavesSeed {
  let bruto: unknown;
  try {
    bruto = JSON.parse(conteudo);
  } catch {
    throw new Error('arquivo de chaves não é JSON válido.');
  }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new Error('arquivo de chaves deve ser um objeto JSON.');
  const obj = bruto as Record<string, unknown>;
  const temEnvelope = 'chaves' in obj && obj.chaves && typeof obj.chaves === 'object' && !Array.isArray(obj.chaves);
  if (temEnvelope && obj.origem !== undefined && obj.origem !== 'seed') throw new Error(`arquivo de chaves com origem "${String(obj.origem)}" (esperado "seed").`);
  const mapa = (temEnvelope ? obj.chaves : obj) as Record<string, unknown>;
  const chaves: Record<string, string> = {};
  for (const [k, v] of Object.entries(mapa)) {
    if (!temEnvelope && (k === 'origem' || k === 'versao_elenco')) continue;
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`chave "${k}" com valor inválido no arquivo de chaves.`);
    chaves[k] = String(v);
  }
  if (!Object.keys(chaves).length) throw new Error('arquivo de chaves vazio.');
  return { origem: 'seed', versao_elenco: typeof obj.versao_elenco === 'string' ? obj.versao_elenco : null, chaves };
}

/**
 * Estado sintético da conferência híbrida: E00–E16 marcadas `ok` com a origem (manual/seed) e um passo
 * que diz de onde vieram; E17–E20 ficam para a conferência. Nenhuma checagem de ambiente é inventada:
 * o CLI acrescenta as reais (preflight e 2ª trava).
 */
export function estadoDeChaves(o: {
  arquivo: ArquivoChavesSeed;
  arquivoNome: string;
  apiBase: string;
  evidencias: boolean;
  agora?: Date;
  /** Avisos por etapa (ex.: exceção documentada da permissão avulsa do P7 na E06). */
  avisos?: Record<string, string[]>;
}): EstadoExecucao {
  const estado = novaExecucao({ evidencias: o.evidencias, ate: null, apiBase: o.apiBase, agora: o.agora });
  estado.id = `conferencia-${estado.id}`;
  estado.modo = 'seed';
  estado.modalidade = MODALIDADE_HIBRIDA;
  estado.somenteViaSeed = [...CENARIOS_SOMENTE_VIA_SEED];
  estado.chaves = { ...o.arquivo.chaves };
  const descricao: Record<OrigemEtapa, string> = {
    manual: 'passo manual da validação híbrida (na tela, antes do seed); conferido aqui pelas chaves no banco',
    seed: `massa-demo:popular (api) — chaves de ${o.arquivoNome}${o.arquivo.versao_elenco ? `, elenco ${o.arquivo.versao_elenco}` : ''}`,
    conferencia: 'massa:conferir',
    api: 'executor pela API',
  };
  for (const def of ETAPAS) {
    const origem = origemHibrida(def.id);
    if (origem === 'conferencia') continue;
    estado.etapas.push({ etapa: def.id, status: 'ok', duracao: 0, papel: null, passos: [{ passo: `origem: ${origem}`, detalhe: descricao[origem] }], avisos: [...(o.avisos?.[def.id] ?? [])], origem });
  }
  return estado;
}
