/**
 * Conferência da massa populada por seed (#10994 · plano 10, BR-002, BR-003, AC-002, AC-003).
 *
 *   npm run massa:conferir -- --chaves=<arquivo> --evidencias | --sem-evidencias
 *
 * Validação híbrida: manual E1–E3 (na tela) → `php artisan massa-demo:popular --exportar-chaves=…`
 * (seed E4–E16) → esta conferência (E17–E20). Sequência (Node puro, nenhuma fixture antes da trava):
 *   preflight → arquivo de chaves → 2ª checagem de /api/environment → chaves no banco (SQL só leitura)
 *   → estado sintético (origem por etapa, modo `seed`) → `playwright test --project=massa-dados` só E17–E20.
 *
 * NUNCA faz reset, `MASSA_RESET_CMD`, cache clear, DNE nem escrita de negócio por conta própria: o CLI só
 * faz GET /api/environment e SELECT. As etapas E17–E20 são as mesmas do `npm run massa` (a E18 gera a
 * remessa SIAP sem envio, como na execução pela API).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exigirNaoProducao, RecusaAmbiente } from '../lib/ambiente.ts';
import { carregarConfig, executorPadrao, logPadrao, RAIZ_QA, type ConfigMassa, type Executor, type Logger } from '../lib/config.ts';
import {
  caminhoEstadoPadrao,
  estadoDeChaves,
  ETAPAS,
  ETAPAS_CONFERENCIA,
  lerArquivoChaves,
  lerEstado,
  marcarNaoExecutadas,
  salvarEstado,
  VARIAVEL_ESTADO,
  type ArquivoChavesSeed,
  type EstadoExecucao,
} from '../lib/execucao.ts';
import { VARIAVEL_RELATORIO } from '../lib/evidencia.ts';
import { lerElenco, lerInsumo, VARIAVEL_VIA_CLI, type Elenco } from '../lib/papeis.ts';
import { executarPreflight, formatarPreflight } from '../lib/preflight.ts';
import { chaveRegistro, registrosDoElenco } from '../lib/registros.ts';
import { criarPastaExecucao, PASTA_RELATORIOS } from '../lib/relatorio.ts';
import { consultar } from '../lib/verificacoes-sql.ts';
import { finalizarRelatorio, type OpcoesCli } from './massa.ts';

export interface OpcoesConferir {
  chaves: string | null;
  evidencias: boolean | null;
}

export function lerArgumentosConferir(argv: string[]): OpcoesConferir {
  const o: OpcoesConferir = { chaves: null, evidencias: null };
  for (const arg of argv) {
    if (arg.startsWith('--chaves=')) o.chaves = arg.slice('--chaves='.length).trim() || null;
    else if (arg === '--evidencias') o.evidencias = true;
    else if (arg === '--sem-evidencias') o.evidencias = false;
    else throw new Error(`Opção desconhecida: ${arg}. Use --chaves=<arquivo> e --evidencias | --sem-evidencias.`);
  }
  return o;
}

/** Nome da camada publicada no passo manual 1b.5 (o mesmo da `e01b-importacoes.spec.ts`). */
export const NOME_CAMADA_DEMO = 'Demonstração SigSUAS — famílias em extrema pobreza';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Chaves que a conferência exige no arquivo (organização, Master, unidades, entidades, equipe, pessoas, famílias e registros). */
export function chavesExigidas(elenco: Elenco, entidades: Array<{ chave: string }>, registros: Array<{ chave: string }>): string[] {
  return [
    'TENANT',
    `USER_${elenco.organizacao.master.chave}`,
    ...elenco.unidades.flatMap((u) => [`UNIT_${u.chave}`, `UNIT_ID_${u.chave}`]),
    ...entidades.map((e) => `ENT_${e.chave}`),
    ...elenco.profissionais.map((p) => `PROF_${p.chave}`),
    ...elenco.pessoas.map((p) => `PES_${p.chave}`),
    ...elenco.familias.map((f) => `FAM_${f.chave}`),
    ...registros.map((r) => chaveRegistro(r.chave)),
  ];
}

/** Lista de uuids das chaves com o prefixo, já validados (só uuid entra no SQL). */
function uuids(chaves: Record<string, string>, prefixo: RegExp): string[] {
  return Object.entries(chaves)
    .filter(([k]) => prefixo.test(k))
    .map(([, v]) => v);
}

/**
 * Confere no banco (SELECT dentro de BEGIN READ ONLY) que a organização, o Master e as chaves do seed
 * existem e pertencem à organização. Devolve os motivos de recusa (vazio = ok).
 */
export function conferirChavesNoBanco(cfg: ConfigMassa, chaves: Record<string, string>, executor: Executor = executorPadrao): string[] {
  const todos = [chaves.TENANT, chaves.USER_M0, ...uuids(chaves, /^(UNIT|ENT|PROF|FAM|PES)_(?!ID_)/)];
  const invalidos = todos.filter((u) => !u || !UUID.test(u));
  if (invalidos.length) return [`${invalidos.length} chave(s) sem uuid válido no arquivo`];
  const lista = (re: RegExp) => uuids(chaves, re).map((u) => `'${u}'`).join(',') || "''";
  const t = `(SELECT id FROM tenants WHERE uuid = '${chaves.TENANT}')`;
  const grupos: Array<[string, RegExp, string]> = [
    ['unidades (UNIT_)', /^UNIT_(?!ID_)/, `SELECT count(*) FROM social_units WHERE tenant_id = ${t} AND deleted_at IS NULL AND uuid IN (%s)`],
    ['entidades (ENT_)', /^ENT_/, `SELECT count(*) FROM social_entities WHERE tenant_id = ${t} AND deleted_at IS NULL AND uuid IN (%s)`],
    ['profissionais (PROF_)', /^PROF_/, `SELECT count(*) FROM tenant_professionals WHERE tenant_id = ${t} AND deleted_at IS NULL AND uuid IN (%s)`],
    ['famílias (FAM_)', /^FAM_/, `SELECT count(*) FROM families WHERE tenant_id = ${t} AND deleted_at IS NULL AND uuid IN (%s)`],
    ['pessoas (PES_)', /^PES_/, `SELECT count(*) FROM persons WHERE uuid IN (%s)`],
  ];
  const sql =
    `SELECT (SELECT count(*) FROM tenants WHERE uuid = '${chaves.TENANT}'), (SELECT count(*) FROM users WHERE uuid = '${chaves.USER_M0}' AND deleted_at IS NULL), ` +
    grupos.map(([, re, q]) => `(${q.replace('%s', lista(re))})`).join(', ');
  const linha = consultar(cfg, sql, executor)[0] ?? [];
  const motivos: string[] = [];
  if (linha[0] !== '1') motivos.push('a organização (TENANT) do arquivo de chaves não está no banco — o seed rodou nesta base?');
  if (linha[1] !== '1') motivos.push('o Master (USER_M0) do arquivo de chaves não está no banco');
  grupos.forEach(([nome, re], i) => {
    const esperado = uuids(chaves, re).length;
    const achado = Number(linha[i + 2] ?? -1);
    if (achado !== esperado) motivos.push(`${nome}: ${esperado} no arquivo × ${achado} no banco da organização`);
  });
  return motivos;
}

/** Uuid da camada da demo publicada no passo manual (1b.5), lido no banco. */
export function resolverCamadaDemo(cfg: ConfigMassa, executor: Executor = executorPadrao): string | null {
  const r = consultar(cfg, `SELECT uuid FROM geo_layers WHERE name = '${NOME_CAMADA_DEMO.replace(/'/g, "''")}' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, executor)[0]?.[0];
  return r && UUID.test(r) ? r : null;
}

/** Exceção documentada (planos 05/09): permissão avulsa sem rota no app, também não concedida pelo seed. */
export function avisosExcecoes(elenco: Elenco): Record<string, string[]> {
  const extras = elenco.profissionais.flatMap((p) => p.permissoes_extras.map((x) => `${p.chave}: permissão avulsa "${x}"`));
  if (!extras.length) return {};
  return {
    E06: [
      `ACHADO RN14: ${extras.join('; ')} não concedida — sem rota no app (o Master só atribui PAPÉIS) e o seed segue a mesma regra (exceção documentada nos planos 05 e 09); o profissional fica só com o papel.`,
    ],
  };
}

export interface DependenciasConferir {
  cfg?: ConfigMassa;
  executor?: Executor;
  fetchImpl?: typeof fetch;
  log?: Logger;
  pastaCache?: string;
  raizMassa?: string;
  caminhoEstado?: string;
  pastaRelatorios?: string;
  timeoutMs?: number;
  /** Roda uma etapa; devolve o código (padrão: `npx playwright test --project=massa-dados`). */
  rodarEtapa?: (arquivo: string, caminhoEstado: string) => number;
  /** Gera o relatório (padrão: `finalizarRelatorio` do CLI da massa). */
  finalizar?: (pasta: string, estado: EstadoExecucao, opcoes: OpcoesCli, codigo: number) => string;
}

function rodarEtapaPlaywright(arquivo: string, caminhoEstado: string): number {
  const { estado } = lerEstado(caminhoEstado);
  const r = spawnSync('npx', ['playwright', 'test', '--project=massa-dados', '--reporter=list', `massa-dados/etapas/${arquivo}`, '--global-timeout=0', `--timeout=${2 * 60 * 60_000}`], {
    cwd: RAIZ_QA,
    stdio: 'inherit',
    // `MASSA_VIA_CLI` = id da execução (guarda do plano 07): sem ele o project nem é registrado.
    env: { ...process.env, [VARIAVEL_ESTADO]: caminhoEstado, [VARIAVEL_VIA_CLI]: estado.id },
  });
  return typeof r.status === 'number' ? r.status : 1;
}

/** Executa a conferência; devolve o código de saída (0 = E17–E20 ok). */
export async function executarConferencia(opcoes: OpcoesConferir, deps: DependenciasConferir = {}): Promise<number> {
  const log = deps.log ?? logPadrao;
  if (!opcoes.chaves) {
    log('✖ Informe o arquivo de chaves do seed: --chaves=<arquivo> (docker cp <container>:/var/www/html/storage/app/massa-demo/chaves.json …).');
    return 2;
  }
  if (opcoes.evidencias === null) {
    log('✖ Informe --evidencias ou --sem-evidencias.');
    return 2;
  }
  const cfg = deps.cfg ?? carregarConfig();
  const executor = deps.executor ?? executorPadrao;

  // 1. Preflight (as mesmas checagens do `npm run massa`) -------------------------------------------
  const preflight = await executarPreflight(cfg, { executor, fetchImpl: deps.fetchImpl, pastaCache: deps.pastaCache, raizMassa: deps.raizMassa, timeoutMs: deps.timeoutMs });
  log(formatarPreflight(preflight));
  if (!preflight.apto || !preflight.ambiente?.ok) return 1;

  // 2. Arquivo de chaves -----------------------------------------------------------------------------
  const caminhoChaves = resolve(opcoes.chaves);
  if (!existsSync(caminhoChaves)) {
    log(`✖ Arquivo de chaves não encontrado: ${opcoes.chaves}`);
    return 2;
  }
  let arquivo: ArquivoChavesSeed;
  try {
    arquivo = lerArquivoChaves(readFileSync(caminhoChaves, 'utf8'));
  } catch (erro) {
    log(`✖ ${(erro as Error).message}`);
    return 2;
  }
  const elenco = lerElenco();
  if (arquivo.versao_elenco && arquivo.versao_elenco !== elenco.versao) {
    log(`✖ Conferência recusada: chaves do elenco ${arquivo.versao_elenco}, insumos do qa ${elenco.versao} — rode npm run massa:insumos:exportar-api e o seed de novo.`);
    return 1;
  }

  // 3. Trava de produção, 2ª checagem, imediatamente antes de qualquer etapa --------------------------
  let environment: string;
  try {
    environment = await exigirNaoProducao(cfg.apiBase, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  } catch (erro) {
    log(`✖ ${erro instanceof RecusaAmbiente ? erro.message : (erro as Error).message}`);
    return 1;
  }
  log(`✔ trava de produção (2ª checagem): /api/environment = "${environment}" (conferência, sem reset)`);

  // 4. Chaves no banco (SQL só leitura) ----------------------------------------------------------------
  const entidades = lerInsumo<{ entidades: Array<{ chave: string }> }>('entidades-ficticias.json').entidades;
  const faltando = chavesExigidas(elenco, entidades, registrosDoElenco()).filter((k) => !arquivo.chaves[k]);
  if (faltando.length) {
    log(`✖ Conferência recusada: ${faltando.length} chave(s) ausente(s) no arquivo (ex.: ${faltando.slice(0, 5).join(', ')}). O seed concluiu E04–E16?`);
    return 1;
  }
  try {
    const motivos = conferirChavesNoBanco(cfg, arquivo.chaves, executor);
    if (motivos.length) {
      log(`✖ Conferência recusada — chaves inexistentes no banco:\n  ${motivos.join('\n  ')}`);
      return 1;
    }
    if (!arquivo.chaves.GEO_CAMADA_DEMO) {
      const camada = resolverCamadaDemo(cfg, executor);
      if (!camada) {
        log(`✖ Conferência recusada: camada "${NOME_CAMADA_DEMO}" (passo manual 1b.5) não encontrada no banco.`);
        return 1;
      }
      arquivo = { ...arquivo, chaves: { ...arquivo.chaves, GEO_CAMADA_DEMO: camada } };
    }
  } catch (erro) {
    log(`✖ Conferência recusada: não foi possível conferir as chaves no banco (${(erro as Error).message}).`);
    return 1;
  }
  log(`✔ ${Object.keys(arquivo.chaves).length} chaves do seed conferidas no banco (organização, Master, unidades, entidades, equipe, pessoas e famílias).`);

  // 5. Estado sintético e relatório -----------------------------------------------------------------
  const estado = estadoDeChaves({ arquivo, arquivoNome: basename(caminhoChaves), apiBase: cfg.apiBase, evidencias: opcoes.evidencias, avisos: avisosExcecoes(elenco) });
  estado.preflight = { apto: preflight.apto, itens: preflight.itens, falhas: preflight.falhas, avisos: preflight.avisos, duracaoMs: preflight.duracaoMs };
  estado.ambiente.push({ momento: 'preflight', ok: true, environment: preflight.ambiente.environment, mensagem: preflight.ambiente.mensagem, em: new Date().toISOString() });
  estado.ambiente.push({ momento: 'antes_do_reset', ok: true, environment, mensagem: `conferência (sem reset): /api/environment = "${environment}"`, em: new Date().toISOString() });
  estado.etapas.unshift({ etapa: 'E00', status: 'ok', duracao: preflight.duracaoMs, papel: null, origem: 'conferencia', passos: [{ passo: 'preflight (massa:conferir)', apto: preflight.apto, falhas: preflight.falhas, avisos: preflight.avisos }], avisos: [] });
  const caminhoEstado = deps.caminhoEstado ?? caminhoEstadoPadrao(estado.id);
  salvarEstado(caminhoEstado, estado);
  log(`✔ Estado da conferência: ${caminhoEstado} (modo seed, ${estado.modalidade})`);

  let pasta: string | null = null;
  if (opcoes.evidencias) {
    pasta = criarPastaExecucao(deps.pastaRelatorios ?? PASTA_RELATORIOS);
    process.env[VARIAVEL_RELATORIO] = pasta;
    log(`✔ Relatório de evidências: ${pasta}`);
  } else delete process.env[VARIAVEL_RELATORIO];

  // 6. Só E17–E20 ----------------------------------------------------------------------------------
  const rodar = deps.rodarEtapa ?? rodarEtapaPlaywright;
  let codigo = 0;
  for (const id of ETAPAS_CONFERENCIA) {
    const def = ETAPAS.find((e) => e.id === id)!;
    log(`\n▶ ${def.id} — ${def.titulo} (conferência)`);
    const r = rodar(def.arquivo, caminhoEstado);
    if (r !== 0) {
      const atual = lerEstado(caminhoEstado).estado;
      if (!atual.etapas.some((e) => e.etapa === id)) atual.etapas.push({ etapa: id, status: 'falha', duracao: 0, papel: null, passos: [], avisos: [`playwright saiu com código ${r}`], origem: 'conferencia' });
      marcarNaoExecutadas(atual, ETAPAS_CONFERENCIA.slice(ETAPAS_CONFERENCIA.indexOf(id) + 1));
      salvarEstado(caminhoEstado, atual);
      log(`✖ ${id} falhou; etapas seguintes não executadas.`);
      codigo = 1;
      break;
    }
  }
  if (codigo === 0) log('\n✔ Conferência concluída (E17–E20).');
  const final = lerEstado(caminhoEstado).estado;
  if (pasta) {
    const opcoesRelatorio: OpcoesCli = { verificar: false, evidencias: true, confirmarApagamento: false, ate: null };
    try {
      log(`Relatório: ${(deps.finalizar ?? finalizarRelatorio)(pasta, final, opcoesRelatorio, codigo)}`);
    } catch (erro) {
      log(`✖ Relatório não gerado: ${(erro as Error).message}`);
      return codigo || 1;
    }
  }
  return codigo;
}

async function principal(): Promise<void> {
  let opcoes: OpcoesConferir;
  try {
    opcoes = lerArgumentosConferir(process.argv.slice(2));
  } catch (erro) {
    logPadrao(`✖ ${(erro as Error).message}`);
    process.exit(2);
  }
  try {
    process.exitCode = await executarConferencia(opcoes);
  } catch (erro) {
    logPadrao(`✖ Erro inesperado: ${(erro as Error).stack ?? erro}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void principal();
}
