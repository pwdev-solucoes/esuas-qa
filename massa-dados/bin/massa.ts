/**
 * CLI da massa fictícia (#10994).
 *
 *   npm run massa:verificar                       → só o preflight (E00); não escreve nada
 *   npm run massa -- --sem-evidencias --confirmar-apagamento [--ate=E0]
 *
 * Sequência (fora do Playwright, Node puro — nenhuma fixture roda antes da trava):
 *   preflight → aviso de apagamento + confirmação → 2ª checagem de /api/environment →
 *   MASSA_RESET_CMD + queue:restart + cache clear → DNE em cache →
 *   `playwright test --project=massa-dados <etapa>` uma etapa por vez, parando na primeira falha.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exigirNaoProducao, RecusaAmbiente } from '../lib/ambiente.ts';
import { carregarConfig, executorPadrao, logPadrao, PASTA_CACHE, RAIZ_QA, type ConfigMassa, type Executor, type Logger } from '../lib/config.ts';
import { FalhaDne, obterDne } from '../lib/dne.ts';
import {
  caminhoEstadoPadrao,
  etapasAte,
  ETAPAS,
  marcarNaoExecutadas,
  novaExecucao,
  salvarEstado,
  lerEstado,
  VARIAVEL_ESTADO,
  type EstadoExecucao,
} from '../lib/execucao.ts';
import { executarPreflight, formatarPreflight } from '../lib/preflight.ts';
import { lerEvidencias, VARIAVEL_RELATORIO } from '../lib/evidencia.ts';
import { criarPastaExecucao, gerarRelatorio, PASTA_RELATORIOS, type ManifestExecucao, type ResultadoDeterminismo } from '../lib/relatorio.ts';
import type { Snapshot } from '../lib/snapshot.ts';
import { escalar } from '../lib/verificacoes-sql.ts';
import { ApagamentoNaoConfirmado, confirmarApagamento, executarReset, FalhaReset, perguntarNoTerminal, textoAviso } from '../lib/reset.ts';

export interface OpcoesCli {
  verificar: boolean;
  evidencias: boolean | null;
  confirmarApagamento: boolean;
  ate: string | null;
  /**
   * SÓ DESENVOLVIMENTO: retoma a execução salva mais recente a partir desta etapa, SEM reset nem DNE.
   * Exige que o estado salvo tenha todas as etapas anteriores `ok`, a mesma API e a organização ainda no
   * banco; preflight e trava de produção continuam. A prova final é sempre a execução completa.
   */
  aPartirDe?: string;
}

export function lerArgumentos(argv: string[]): OpcoesCli {
  const o: OpcoesCli = { verificar: false, evidencias: null, confirmarApagamento: false, ate: null };
  for (const arg of argv) {
    if (arg === '--verificar') o.verificar = true;
    else if (arg === '--evidencias') o.evidencias = true;
    else if (arg === '--sem-evidencias') o.evidencias = false;
    else if (arg === '--confirmar-apagamento') o.confirmarApagamento = true;
    else if (arg.startsWith('--ate=')) o.ate = arg.slice('--ate='.length).trim() || null;
    else if (arg.startsWith('--a-partir-de=')) o.aPartirDe = arg.slice('--a-partir-de='.length).trim() || undefined;
    else throw new Error(`Opção desconhecida: ${arg}. Use --evidencias | --sem-evidencias, --confirmar-apagamento, --ate=Exx, --a-partir-de=Exx (dev), --verificar.`);
  }
  return o;
}

export interface DependenciasFluxo {
  cfg?: ConfigMassa;
  executor?: Executor;
  fetchImpl?: typeof fetch;
  interativo?: boolean;
  perguntar?: (pergunta: string) => Promise<string>;
  log?: Logger;
  pastaCache?: string;
  raizMassa?: string;
  caminhoEstado?: string;
  /** Roda uma etapa; devolve o código de saída (padrão: `npx playwright test --project=massa-dados`). */
  rodarEtapa?: (arquivo: string, caminhoEstado: string, filtro?: string) => number;
  timeoutMs?: number;
  /** Base das pastas de relatório (padrão `massa-dados/relatorios`). */
  pastaRelatorios?: string;
}

function gitCurto(pasta: string): string | null {
  if (!existsSync(pasta)) return null;
  const r = spawnSync('git', ['-C', pasta, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const sujo = spawnSync('git', ['-C', pasta, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  return `${r.stdout.trim()}${sujo.stdout.trim() ? '+alterações locais' : ''}`;
}

/** Monta o `manifest.json` da execução (sem segredos: só versões, flags, ambiente e sha dos insumos). */
export function manifestExecucao(pasta: string, estado: EstadoExecucao, opcoes: OpcoesCli, codigo: number, raizMassa = resolve(RAIZ_QA, 'massa-dados')): ManifestExecucao {
  const manifestInsumos = resolve(raizMassa, 'insumos', 'manifest.json');
  const elenco = JSON.parse(readFileSync(resolve(raizMassa, 'insumos', 'elenco.json'), 'utf8')) as { versao: string };
  const ambiente = [...estado.ambiente].reverse().find((a) => a.ok)?.environment ?? null;
  const falhou = estado.etapas.some((e) => e.status === 'falha');
  return {
    execucao: estado.id,
    pasta: pasta.replace(`${RAIZ_QA}/`, ''),
    iniciada_em: estado.iniciadaEm,
    concluida_em: new Date().toISOString(),
    ambiente,
    api: { base: estado.apiBase, versao: gitCurto(resolve(RAIZ_QA, '..', 'api')) },
    qa: { versao: gitCurto(RAIZ_QA) },
    elenco: { versao: elenco.versao },
    insumos: { manifest_sha256: existsSync(manifestInsumos) ? createHash('sha256').update(readFileSync(manifestInsumos)).digest('hex') : null },
    dne: estado.dne ? { sha256: estado.dne.sha256 ?? null } : null,
    flags: {
      evidencias: true,
      'confirmar-apagamento': opcoes.confirmarApagamento,
      confirmacao: estado.confirmacao ?? null,
      ate: opcoes.ate,
      'a-partir-de': opcoes.aPartirDe ?? null,
    },
    resultado: codigo === 0 && !falhou ? 'concluída' : 'interrompida',
  };
}

/** Renderiza o relatório (páginas, índice e manifest) da pasta da execução. Devolve o caminho do índice. */
export function finalizarRelatorio(pasta: string, estado: EstadoExecucao, opcoes: OpcoesCli, codigo: number, raizMassa = resolve(RAIZ_QA, 'massa-dados')): string {
  const ler = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null);
  gerarRelatorio(pasta, {
    estado,
    evidencias: lerEvidencias(pasta),
    elenco: JSON.parse(readFileSync(resolve(raizMassa, 'insumos', 'elenco.json'), 'utf8')),
    esperado: JSON.parse(readFileSync(resolve(raizMassa, 'insumos', 'esperado.json'), 'utf8')),
    snapshot: ler<Snapshot>(resolve(pasta, 'snapshot.json')),
    manifest: manifestExecucao(pasta, estado, opcoes, codigo, raizMassa),
    determinismo: ler<ResultadoDeterminismo>(resolve(pasta, 'determinismo.json')),
  });
  return resolve(pasta, 'index.html');
}

/** Cria a pasta nova do relatório (`--evidencias`) e a expõe às etapas; sem evidências, garante que não há pasta ativa. */
function prepararRelatorio(opcoes: OpcoesCli, deps: DependenciasFluxo, log: Logger): string | null {
  if (!opcoes.evidencias) {
    delete process.env[VARIAVEL_RELATORIO];
    return null;
  }
  const pasta = criarPastaExecucao(deps.pastaRelatorios ?? PASTA_RELATORIOS);
  process.env[VARIAVEL_RELATORIO] = pasta;
  log(`✔ Relatório de evidências: ${pasta}`);
  return pasta;
}

function fecharRelatorio(pasta: string | null, estado: EstadoExecucao, opcoes: OpcoesCli, codigo: number, log: Logger): number {
  if (!pasta) return codigo;
  try {
    log(`Relatório: ${finalizarRelatorio(pasta, estado, opcoes, codigo)}`);
    return codigo;
  } catch (erro) {
    log(`✖ Relatório não gerado: ${(erro as Error).message}`);
    return codigo || 1;
  }
}

function rodarEtapaPlaywright(arquivo: string, caminhoEstado: string, filtro?: string): number {
  const argumentos = ['playwright', 'test', '--project=massa-dados', '--reporter=list', `massa-dados/etapas/${arquivo}`];
  if (filtro) argumentos.push(`--grep=${filtro}`);
  // A E01b espera o DNE nacional (~15 min de processamento + sync): sem teto global e com folga por
  // etapa (o timeout de cada job continua em `polling.ts`, MASSA_TIMEOUT_JOBS_MS).
  argumentos.push('--global-timeout=0', `--timeout=${2 * 60 * 60_000}`);
  const r = spawnSync('npx', argumentos, {
    cwd: RAIZ_QA,
    stdio: 'inherit',
    env: { ...process.env, [VARIAVEL_ESTADO]: caminhoEstado },
  });
  return typeof r.status === 'number' ? r.status : 1;
}

/**
 * Confere se o estado salvo permite retomar a partir de `aPartirDe` (dev): etapa conhecida e depois do
 * reset/DNE, mesma API, todas as etapas anteriores `ok` e a organização gravada. Devolve o motivo da
 * recusa ou `null`.
 */
export function validarRetomada(estado: EstadoExecucao | null, aPartirDe: string, apiBase: string): string | null {
  const i = ETAPAS.findIndex((e) => e.id.toUpperCase() === aPartirDe.toUpperCase());
  if (i < 0) return `--a-partir-de=${aPartirDe}: etapa desconhecida.`;
  if (i <= ETAPAS.findIndex((e) => e.id === 'E01b')) return `--a-partir-de=${aPartirDe}: só depois das importações (E01c em diante); antes disso rode a massa completa.`;
  if (!estado) return 'nenhuma execução salva para retomar.';
  if (estado.apiBase !== apiBase) return `a execução salva é de outra API (${estado.apiBase}).`;
  const faltando = ETAPAS.slice(0, i).filter((e) => estado.etapas.find((x) => x.etapa === e.id)?.status !== 'ok').map((e) => e.id);
  if (faltando.length) return `etapas anteriores não concluídas na execução salva: ${faltando.join(', ')}.`;
  if (!estado.chaves.TENANT) return 'a execução salva não registrou a organização (TENANT).';
  return null;
}

function ultimaExecucaoSalva(pastaCache?: string): { caminho: string; estado: EstadoExecucao } | null {
  const pasta = resolve(pastaCache ?? PASTA_CACHE, 'execucoes');
  if (!existsSync(pasta)) return null;
  const arquivos = readdirSync(pasta).filter((f) => f.endsWith('.json')).map((f) => resolve(pasta, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return arquivos[0] ? lerEstado(arquivos[0]) : null;
}

/** Executa o fluxo e devolve o código de saída do processo (0 = sucesso). */
export async function executarFluxo(opcoes: OpcoesCli, deps: DependenciasFluxo = {}): Promise<number> {
  const log = deps.log ?? logPadrao;
  const cfg = deps.cfg ?? carregarConfig();
  const executor = deps.executor ?? executorPadrao;
  const interativo = deps.interativo ?? Boolean(process.stdin.isTTY);
  const perguntar = deps.perguntar ?? perguntarNoTerminal;

  let ate: string | null = null;
  if (!opcoes.verificar) {
    try {
      ate = opcoes.ate ? (etapasAte(opcoes.ate).at(-1)?.id ?? null) : null;
    } catch (erro) {
      log(`✖ ${(erro as Error).message}`);
      return 2;
    }
    if (opcoes.evidencias === null) {
      if (!interativo) {
        log('✖ Em modo não interativo informe --evidencias ou --sem-evidencias.');
        return 2;
      }
      const resposta = (await perguntar('Gerar relatório de evidências? (s/N): ')).trim().toLowerCase();
      opcoes = { ...opcoes, evidencias: resposta === 's' || resposta === 'sim' };
    }
  }

  // 1. Preflight (1ª checagem do ambiente) -----------------------------------------------------
  const preflight = await executarPreflight(cfg, {
    executor,
    fetchImpl: deps.fetchImpl,
    pastaCache: deps.pastaCache,
    raizMassa: deps.raizMassa,
    timeoutMs: deps.timeoutMs,
  });
  log(formatarPreflight(preflight));
  if (opcoes.verificar) return preflight.apto ? 0 : 1;
  if (!preflight.apto || !preflight.ambiente?.ok) return 1;

  if (opcoes.aPartirDe) return retomar(opcoes, opcoes.aPartirDe, ate, cfg, deps, log);

  const estado: EstadoExecucao = novaExecucao({ evidencias: Boolean(opcoes.evidencias), ate, apiBase: cfg.apiBase });
  const caminhoEstado = deps.caminhoEstado ?? caminhoEstadoPadrao(estado.id);
  estado.preflight = { apto: preflight.apto, itens: preflight.itens, falhas: preflight.falhas, avisos: preflight.avisos, duracaoMs: preflight.duracaoMs };
  estado.ambiente.push({ momento: 'preflight', ok: true, environment: preflight.ambiente.environment, mensagem: preflight.ambiente.mensagem, em: new Date().toISOString() });
  let pastaRelatorio: string | null = null;
  const encerrar = (codigo: number): number => {
    salvarEstado(caminhoEstado, estado);
    log(`Estado da execução: ${caminhoEstado}`);
    return fecharRelatorio(pastaRelatorio, estado, opcoes, codigo, log);
  };

  // 2. Aviso de apagamento + confirmação (RN-T3) ------------------------------------------------
  log(textoAviso(cfg.apiBase, preflight.ambiente.environment, cfg.resetCmd));
  try {
    estado.confirmacao = await confirmarApagamento({
      environment: preflight.ambiente.environment,
      interativo,
      flagConfirmacao: opcoes.confirmarApagamento,
      perguntar,
    });
  } catch (erro) {
    if (erro instanceof ApagamentoNaoConfirmado) {
      log(`✖ ${erro.message}`);
      return encerrar(1);
    }
    throw erro;
  }

  // 3. Trava de produção, 2ª checagem, imediatamente antes do reset (RN-T1) ---------------------
  try {
    const environment = await exigirNaoProducao(cfg.apiBase, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
    estado.ambiente.push({ momento: 'antes_do_reset', ok: true, environment, mensagem: `/api/environment = "${environment}"`, em: new Date().toISOString() });
    log(`✔ trava de produção (2ª checagem): /api/environment = "${environment}"`);
  } catch (erro) {
    if (erro instanceof RecusaAmbiente) {
      estado.ambiente.push({ momento: 'antes_do_reset', ok: false, environment: erro.resultado.environment, mensagem: erro.message, em: new Date().toISOString() });
      log(`✖ ${erro.message}`);
      return encerrar(1);
    }
    throw erro;
  }

  // 4. Reset externo ----------------------------------------------------------------------------
  try {
    estado.reset = executarReset(cfg, { executor, log });
  } catch (erro) {
    if (erro instanceof FalhaReset) estado.reset = [erro.passo];
    log(`✖ Reset falhou: ${(erro as Error).message}`);
    return encerrar(1);
  }

  // 5. DNE ----------------------------------------------------------------------------------------
  try {
    const dne = await obterDne({ url: cfg.dneUrl, sha256: cfg.dneSha256 || undefined, pastaCache: deps.pastaCache, fetchImpl: deps.fetchImpl });
    estado.dne = { ...dne, arquivo: dne.arquivo };
    log(`✔ DNE: ${dne.bytes} bytes, sha256 ${dne.sha256}${dne.local ? ' (arquivo local)' : dne.doCache ? ' (cache)' : ' (baixado)'}`);
  } catch (erro) {
    log(`✖ ${erro instanceof FalhaDne ? erro.message : `DNE: ${(erro as Error).message}`}`);
    return encerrar(1);
  }
  salvarEstado(caminhoEstado, estado);
  pastaRelatorio = prepararRelatorio(opcoes, deps, log);

  // 6. Etapas (Playwright), uma por vez, parando na primeira falha -------------------------------
  const rodar = deps.rodarEtapa ?? rodarEtapaPlaywright;
  const selecionadas = etapasAte(ate);
  for (const [i, etapa] of selecionadas.entries()) {
    log(`\n▶ ${etapa.id} — ${etapa.titulo}`);
    const codigo = rodar(etapa.arquivo, caminhoEstado, etapa.filtro);
    if (codigo !== 0) {
      const atual = lerEstado(caminhoEstado).estado;
      if (!atual.etapas.some((e) => e.etapa === etapa.id)) {
        atual.etapas.push({ etapa: etapa.id, status: 'falha', duracao: 0, papel: null, passos: [], avisos: [`playwright saiu com código ${codigo}`] });
      }
      marcarNaoExecutadas(atual, ETAPAS.slice(ETAPAS.indexOf(selecionadas[i]) + 1).map((e) => e.id));
      Object.assign(estado, atual);
      log(`✖ ${etapa.id} falhou; etapas seguintes não executadas.`);
      return encerrar(1);
    }
  }
  const final = lerEstado(caminhoEstado).estado;
  marcarNaoExecutadas(final, ETAPAS.slice(selecionadas.length).map((e) => e.id));
  Object.assign(estado, final);
  log(`\n✔ Massa concluída até ${selecionadas.at(-1)?.id}.`);
  return encerrar(0);
}

/** Retomada de desenvolvimento: sem aviso, sem reset e sem DNE; 2ª trava de produção e banco conferidos. */
async function retomar(opcoes: OpcoesCli, aPartirDe: string, ate: string | null, cfg: ConfigMassa, deps: DependenciasFluxo, log: Logger): Promise<number> {
  const salva = deps.caminhoEstado ? lerEstado(deps.caminhoEstado) : ultimaExecucaoSalva(deps.pastaCache);
  const motivo = validarRetomada(salva?.estado ?? null, aPartirDe, cfg.apiBase);
  if (motivo || !salva) {
    log(`✖ Retomada recusada: ${motivo}`);
    return 1;
  }
  const { caminho, estado } = salva;
  try {
    const environment = await exigirNaoProducao(cfg.apiBase, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
    estado.ambiente.push({ momento: 'antes_do_reset', ok: true, environment, mensagem: `retomada a partir de ${aPartirDe}: /api/environment = "${environment}" (sem reset)`, em: new Date().toISOString() });
  } catch (erro) {
    log(`✖ ${(erro as Error).message}`);
    return 1;
  }
  const tenant = estado.chaves.TENANT;
  if (!/^[0-9a-f-]{36}$/i.test(tenant)) {
    log('✖ Retomada recusada: uuid da organização inválido no estado salvo.');
    return 1;
  }
  const noBanco = escalar(cfg, `SELECT count(*) FROM tenants WHERE uuid = '${tenant}'`, deps.executor ?? executorPadrao);
  if (noBanco !== '1') {
    log('✖ Retomada recusada: a organização da execução salva não está mais no banco (houve reset?). Rode a massa completa.');
    return 1;
  }
  log(`⚠ RETOMADA (dev): ${caminho} a partir de ${aPartirDe}, sem reset e sem DNE. A prova final é a execução completa.`);
  const inicio = ETAPAS.findIndex((e) => e.id.toUpperCase() === aPartirDe.toUpperCase());
  const selecionadas = etapasAte(ate).slice(inicio);
  estado.etapas = estado.etapas.filter((e) => ETAPAS.findIndex((x) => x.id === e.etapa) < inicio);
  estado.ate = ate;
  salvarEstado(caminho, estado);
  const pastaRelatorio = prepararRelatorio(opcoes, deps, log);
  const fechar = (codigo: number) => fecharRelatorio(pastaRelatorio, lerEstado(caminho).estado, opcoes, codigo, log);
  const rodar = deps.rodarEtapa ?? rodarEtapaPlaywright;
  for (const etapa of selecionadas) {
    log(`\n▶ ${etapa.id} — ${etapa.titulo}`);
    const codigo = rodar(etapa.arquivo, caminho, etapa.filtro);
    if (codigo !== 0) {
      const atual = lerEstado(caminho).estado;
      if (!atual.etapas.some((e) => e.etapa === etapa.id)) atual.etapas.push({ etapa: etapa.id, status: 'falha', duracao: 0, papel: null, passos: [], avisos: [`playwright saiu com código ${codigo}`] });
      marcarNaoExecutadas(atual, ETAPAS.slice(ETAPAS.indexOf(etapa) + 1).map((e) => e.id));
      salvarEstado(caminho, atual);
      log(`✖ ${etapa.id} falhou; etapas seguintes não executadas. Estado: ${caminho}`);
      return fechar(1);
    }
  }
  log(`\n✔ Retomada concluída até ${selecionadas.at(-1)?.id ?? aPartirDe}. Estado: ${caminho}`);
  return fechar(0);
}

async function principal(): Promise<void> {
  let opcoes: OpcoesCli;
  try {
    opcoes = lerArgumentos(process.argv.slice(2));
  } catch (erro) {
    logPadrao(`✖ ${(erro as Error).message}`);
    process.exit(2);
  }
  try {
    process.exitCode = await executarFluxo(opcoes);
  } catch (erro) {
    logPadrao(`✖ Erro inesperado: ${(erro as Error).stack ?? erro}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void principal();
}
