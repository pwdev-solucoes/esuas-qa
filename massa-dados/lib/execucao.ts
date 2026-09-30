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

export interface EstadoEtapa {
  etapa: string;
  status: StatusEtapa;
  duracao: number;
  papel: string | null;
  passos: Array<Record<string, unknown>>;
  avisos: string[];
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
