/**
 * E00 — Preflight (#10994 · RN-T2, roadmap 00a-preflight.md).
 *
 * Roda TODAS as checagens (sem parar na primeira falha) e devolve itens ✔/✖/⚠ com instrução
 * acionável. Não escreve NADA: só leitura de arquivos, `GET`/`HEAD` e comandos de inspeção
 * (`docker info|inspect|top`, `psql SELECT`). O `MASSA_RESET_CMD` nunca é executado aqui.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { consultarAmbiente, type ResultadoAmbiente } from './ambiente.ts';
import { PASTA_CACHE, RAIZ_MASSA, RAIZ_QA, executorPadrao, type ConfigMassa, type Executor } from './config.ts';
import { cpfValido, cpfEmFaixaProibida } from '../scripts/lib/cpf.ts';
import { featureQueContem, type FeatureCollection } from '../scripts/lib/geo.ts';

export type StatusItem = 'ok' | 'falha' | 'aviso';
export type Familia = 'insumos' | 'dne' | 'docker' | 'servicos' | 'config' | 'ferramental';

export interface ItemPreflight {
  familia: Familia;
  nome: string;
  status: StatusItem;
  mensagem: string;
}

export interface ResultadoPreflight {
  apto: boolean;
  itens: ItemPreflight[];
  ambiente?: ResultadoAmbiente;
  falhas: number;
  avisos: number;
  iniciadoEm: string;
  duracaoMs: number;
}

export interface DependenciasPreflight {
  executor?: Executor;
  fetchImpl?: typeof fetch;
  raizMassa?: string;
  raizQa?: string;
  pastaCache?: string;
  timeoutMs?: number;
}

/** Containers com papel especial, reconhecidos pelo nome. */
export const PADRAO_FILA = /queue|worker|fila/i;
export const PADRAO_BANCO = /pgsql|postgres|postgis|(^|[-_])db([-_]|$)/i;
export const PADRAO_MINIO = /minio|s3/i;
/** Portas em que o front é Sanctum-stateful (memória do projeto). */
export const PORTAS_STATEFUL = ['5173', '5174', '5175'];

/**
 * Extrai o container-alvo de um comando `docker exec [flags] <container> …` ou
 * `docker compose exec [flags] <serviço> …`. Retorna `null` para `sail` e afins.
 */
export function containerDoComando(linha: string): { binario: string; container: string | null } {
  const tokens = linha.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) ?? [];
  const binario = tokens[0] ?? '';
  const iExec = tokens.indexOf('exec');
  if (!/(^|\/)docker$/.test(binario) || iExec < 0) return { binario, container: null };
  const comValor = new Set(['-u', '--user', '-w', '--workdir', '-e', '--env', '--env-file']);
  for (let i = iExec + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (comValor.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    return { binario, container: t };
  }
  return { binario, container: null };
}

function sha256DeArquivo(caminho: string): Promise<string> {
  return new Promise((ok, falha) => {
    const hash = createHash('sha256');
    createReadStream(caminho)
      .on('data', (p) => hash.update(p))
      .on('end', () => ok(hash.digest('hex')))
      .on('error', falha);
  });
}

function comparaVersao(atual: string, minima: string): number {
  const a = atual.replace(/^v/, '').split('.').map(Number);
  const b = minima.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function humano(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------------------------

export async function executarPreflight(cfg: ConfigMassa, deps: DependenciasPreflight = {}): Promise<ResultadoPreflight> {
  const inicio = Date.now();
  const executor = deps.executor ?? executorPadrao;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const raizMassa = deps.raizMassa ?? RAIZ_MASSA;
  const raizQa = deps.raizQa ?? RAIZ_QA;
  const pastaCache = deps.pastaCache ?? PASTA_CACHE;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const itens: ItemPreflight[] = [];
  const add = (familia: Familia, nome: string, status: StatusItem, mensagem: string): void => {
    itens.push({ familia, nome, status, mensagem });
  };

  /** Só GET/HEAD — o preflight nunca escreve. */
  const requisitar = async (url: string, metodo: 'GET' | 'HEAD'): Promise<{ status: number; headers: Headers } | { erro: string }> => {
    try {
      const r = await fetchImpl(url, { method: metodo, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      await r.arrayBuffer().catch(() => undefined);
      return { status: r.status, headers: r.headers };
    } catch (erro) {
      const nome = (erro as Error)?.name;
      return { erro: nome === 'TimeoutError' || nome === 'AbortError' ? 'tempo esgotado' : (erro as Error)?.message ?? String(erro) };
    }
  };

  // 5. Configuração (primeiro: as demais famílias dependem dela) -------------------------------
  if (cfg.faltando.length === 0) {
    add('config', '.env', 'ok', `variáveis obrigatórias presentes (${cfg.origem})`);
  } else {
    add(
      'config',
      '.env',
      'falha',
      `faltam ${cfg.faltando.join(', ')} em ${cfg.origem}. Copie massa-dados/.env.example para massa-dados/.env e preencha.`,
    );
  }
  let containerReset: string | null = null;
  if (cfg.resetCmd) {
    const { binario, container } = containerDoComando(cfg.resetCmd);
    containerReset = container;
    const existe = executor.programa('/bin/sh', ['-c', `command -v ${JSON.stringify(binario)}`]).codigo === 0;
    if (!existe) {
      add('config', 'MASSA_RESET_CMD', 'falha', `binário "${binario}" do MASSA_RESET_CMD não encontrado no PATH.`);
    } else if (container && !cfg.containers.includes(container)) {
      add(
        'config',
        'MASSA_RESET_CMD',
        'falha',
        `o reset aponta para o container "${container}", que não está em MASSA_DOCKER_CONTAINERS. Confira o alvo (o Pest apaga esuas_e2e).`,
      );
    } else {
      add('config', 'MASSA_RESET_CMD', 'ok', `executável (${binario}${container ? ` → ${container}` : ''}); não executado no preflight`);
    }
  }
  if (!cfg.cacheClearCmd) {
    add('config', 'MASSA_CACHE_CLEAR_CMD', 'aviso', 'não definido: logins seguidos podem cair no rate-limit (429).');
  }

  // 1. Insumos ---------------------------------------------------------------------------------
  const pastaInsumos = resolve(raizMassa, 'insumos');
  const caminhoManifest = resolve(pastaInsumos, 'manifest.json');
  type Manifest = { arquivos: Array<{ caminho: string; sha256: string; contagem: number }> };
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(caminhoManifest, 'utf8')) as Manifest;
  } catch {
    add('insumos', 'manifest', 'falha', 'insumos/manifest.json ausente ou inválido. Rode `npm run massa:insumos`.');
  }
  const json: Record<string, unknown> = {};
  if (manifest) {
    const faltas: string[] = [];
    const divergentes: string[] = [];
    const invalidos: string[] = [];
    for (const arq of manifest.arquivos) {
      const caminho = resolve(pastaInsumos, arq.caminho);
      if (!existsSync(caminho)) {
        faltas.push(arq.caminho);
        continue;
      }
      const conteudo = readFileSync(caminho);
      if (createHash('sha256').update(conteudo).digest('hex') !== arq.sha256) divergentes.push(arq.caminho);
      if (/\.(geo)?json$/.test(arq.caminho)) {
        try {
          json[arq.caminho] = JSON.parse(conteudo.toString('utf8'));
        } catch (erro) {
          invalidos.push(`${arq.caminho} (${(erro as Error).message})`);
        }
      }
    }
    if (faltas.length) add('insumos', 'presença', 'falha', `faltam ${faltas.map((f) => `insumos/${f}`).join(', ')}. Rode \`npm run massa:insumos\`.`);
    if (divergentes.length) add('insumos', 'integridade', 'falha', `checksum divergente em ${divergentes.join(', ')}. Regenere ou restaure do git.`);
    if (invalidos.length) add('insumos', 'formato', 'falha', `JSON/GeoJSON inválido: ${invalidos.join('; ')}`);
    if (!faltas.length && !divergentes.length && !invalidos.length) {
      add('insumos', 'arquivos', 'ok', `${manifest.arquivos.length} arquivos, checksums ok`);
    }
  }

  const geo = (nome: string): FeatureCollection | null => {
    const g = json[`geo/${nome}.geojson`] as FeatureCollection | undefined;
    return g && (g as unknown as { type?: string }).type === 'FeatureCollection' && Array.isArray(g.features) ? g : null;
  };
  const municipios = geo('municipios-al');
  const bairros = geo('bairros-arapiraca');
  const setores = geo('setores-arapiraca');
  if (manifest) {
    const semGeom = [municipios, bairros, setores].some((g) => g?.features.some((f) => !f.geometry || !Array.isArray(f.geometry.coordinates)));
    if (!municipios || !bairros || !setores || semGeom) {
      add('insumos', 'geo', 'falha', 'GeoJSON inválido: esperado FeatureCollection com geometry em municipios-al, bairros-arapiraca e setores-arapiraca.');
    } else if (municipios.features.length !== 102 || bairros.features.length === 0 || setores.features.length === 0) {
      add('insumos', 'geo', 'falha', `contagens geo fora do esperado: ${municipios.features.length} municípios (102), ${bairros.features.length} bairros, ${setores.features.length} setores.`);
    } else {
      add('insumos', 'geo', 'ok', `${municipios.features.length} municípios · ${bairros.features.length} bairros · ${setores.features.length} setores (Arapiraca)`);
    }
  }

  type Pessoa = { chave: string; cpf: string | null };
  type Elenco = {
    familias: Array<{ chave: string; unidade_referencia: string | null }>;
    pessoas: Pessoa[];
    organizacao?: { master?: { cpf?: string } };
    profissionais?: Array<{ cpf?: string }>;
  };
  type Unidades = { unidades: Array<{ chave: string; tipo: string; coordenada?: { latitude: number; longitude: number } }> };
  const elenco = json['elenco.json'] as Elenco | undefined;
  const unidades = json['unidades-ficticias.json'] as Unidades | undefined;
  if (elenco && unidades) {
    const problemas: string[] = [];
    const nFam = elenco.familias?.length ?? 0;
    const nPes = elenco.pessoas?.length ?? 0;
    const semCpf = elenco.pessoas.filter((p) => p.cpf === null).length;
    if (nFam < 55) problemas.push(`elenco com ${nFam} famílias; esperado ≥ 55`);
    if (nPes < 180) problemas.push(`elenco com ${nPes} pessoas; esperado ≈ 200`);
    const cras = unidades.unidades.filter((u) => u.tipo === 'CRAS').length;
    const creas = unidades.unidades.filter((u) => u.tipo === 'CREAS').length;
    if (cras !== 2 || creas !== 1) problemas.push(`unidades: ${cras} CRAS e ${creas} CREAS; esperado 2 + 1`);
    const todosCpfs = [
      elenco.organizacao?.master?.cpf,
      ...(elenco.profissionais ?? []).map((p) => p.cpf),
      ...elenco.pessoas.map((p) => p.cpf),
    ].filter((c): c is string => typeof c === 'string');
    const vistos = new Set<string>();
    for (const c of todosCpfs) {
      if (!c.startsWith('98') || !cpfValido(c) || cpfEmFaixaProibida(c)) problemas.push(`CPF fora da faixa 98 ou com DV inválido: ${c}`);
      if (vistos.has(c)) problemas.push(`CPF duplicado: ${c}`);
      vistos.add(c);
    }
    const semMarcacao = elenco.pessoas.filter((p) => p.cpf === undefined);
    if (semMarcacao.length) problemas.push(`${semMarcacao.length} pessoa(s) sem o campo cpf (use null para "sem CPF")`);
    const chavesUnidades = new Set(unidades.unidades.map((u) => u.chave));
    for (const f of elenco.familias) {
      if (f.unidade_referencia !== null && !chavesUnidades.has(f.unidade_referencia)) {
        problemas.push(`família ${f.chave} referencia unidade inexistente ${f.unidade_referencia}`);
      }
    }
    if (problemas.length) add('insumos', 'elenco', 'falha', problemas.slice(0, 5).join('; ') + (problemas.length > 5 ? ` (+${problemas.length - 5})` : ''));
    else add('insumos', 'elenco', 'ok', `${nFam} famílias, ${nPes} pessoas (${semCpf} sem CPF), CPFs na base 98`);

    type Coordenadas = { familias: Record<string, { latitude: number; longitude: number }> };
    const coord = json['coordenadas-familias.json'] as Coordenadas | undefined;
    if (setores && coord) {
      const fora: string[] = [];
      for (const [chave, p] of Object.entries(coord.familias)) {
        if (!featureQueContem(p.longitude, p.latitude, setores)) fora.push(`família ${chave}`);
      }
      for (const u of unidades.unidades) {
        if (!u.coordenada || !featureQueContem(u.coordenada.longitude, u.coordenada.latitude, setores)) fora.push(`unidade ${u.chave}`);
      }
      if (fora.length) add('insumos', 'coerência geográfica', 'falha', `ponto fora dos setores de Arapiraca: ${fora.slice(0, 5).join(', ')}`);
      else add('insumos', 'coerência geográfica', 'ok', `${Object.keys(coord.familias).length} famílias + ${unidades.unidades.length} unidades dentro dos setores`);
    }
  }
  const esperado = json['esperado.json'] as { contadores?: Array<{ mes: string; unidade: string }> } | undefined;
  if (esperado?.contadores) {
    const faltas: string[] = [];
    for (const mes of ['2026-06', '2026-07', '2026-08']) {
      for (const u of ['U-CN', 'U-CS', 'U-CE']) {
        if (!esperado.contadores.some((c) => c.mes === mes && c.unidade === u)) faltas.push(`${mes}/${u}`);
      }
    }
    if (faltas.length) add('insumos', 'esperado', 'falha', `esperado.json sem ${faltas.join(', ')}. Rode \`npm run massa:insumos\`.`);
    else add('insumos', 'esperado', 'ok', '3 meses × 3 unidades cobertos');
  }

  // 2. DNE -------------------------------------------------------------------------------------
  if (!cfg.dneUrl) {
    add('dne', 'MASSA_DNE_URL', 'falha', 'MASSA_DNE_URL não definida em massa-dados/.env (URL pública do ZIP do DNE).');
  } else {
    if (cfg.dneSha256 && !/^[a-f0-9]{64}$/.test(cfg.dneSha256)) {
      add('dne', 'MASSA_DNE_SHA256', 'falha', 'MASSA_DNE_SHA256 não é um sha256 hexadecimal de 64 caracteres.');
    }
    const cache = cfg.dneSha256 ? resolve(pastaCache, 'dne', `${cfg.dneSha256}.zip`) : null;
    let emCache = false;
    if (cache && existsSync(cache)) {
      emCache = (await sha256DeArquivo(cache)) === cfg.dneSha256;
    }
    const r = await requisitar(cfg.dneUrl, 'HEAD');
    if ('erro' in r || r.status !== 200) {
      const motivo = 'erro' in r ? r.erro : `HTTP ${r.status}`;
      add('dne', 'acesso', emCache ? 'aviso' : 'falha', `HEAD ${cfg.dneUrl} falhou (${motivo}).${emCache ? ' O cache local confere e será usado.' : ' Confira a URL.'}`);
    } else {
      const tamanho = Number(r.headers.get('content-length') ?? '0');
      if (!(tamanho > 0)) {
        add('dne', 'acesso', 'falha', `HEAD ${cfg.dneUrl} sem Content-Length > 0.`);
      } else {
        add('dne', 'acesso', 'ok', `${cfg.dneUrl} (${humano(tamanho)}) acessível${emCache ? '; cache confere, download será pulado' : ''}`);
        try {
          const fs = statfsSync(existsSync(pastaCache) ? pastaCache : raizMassa);
          const livre = Number(fs.bavail) * Number(fs.bsize);
          if (livre < 3 * tamanho) add('dne', 'disco', 'aviso', `${humano(livre)} livres (recomendado ≥ ${humano(3 * tamanho)}).`);
          else add('dne', 'disco', 'ok', `${humano(livre)} livres`);
        } catch {
          add('dne', 'disco', 'aviso', 'não foi possível medir o espaço livre.');
        }
      }
    }
  }

  // 3. Docker ----------------------------------------------------------------------------------
  const info = executor.programa('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
  if (info.codigo !== 0) {
    add('docker', 'daemon', 'falha', 'o daemon do Docker não responde. Inicie o Docker (Docker Desktop / `systemctl start docker`).');
  } else {
    add('docker', 'daemon', 'ok', `Docker ${info.saida.trim()}`);
    const estados: Record<string, { status: string; health: string }> = {};
    const problemas: string[] = [];
    for (const nome of cfg.containers) {
      const r = executor.programa('docker', ['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', nome]);
      if (r.codigo !== 0) {
        problemas.push(`${nome} não existe (confira MASSA_DOCKER_CONTAINERS)`);
        continue;
      }
      const [status, health] = r.saida.trim().split('|');
      estados[nome] = { status, health: health ?? '' };
      if (status !== 'running') problemas.push(`${nome} está "${status}": rode \`docker start ${nome}\``);
      else if (health && health !== 'healthy') problemas.push(`${nome} está running mas "${health}": aguarde ou veja \`docker logs ${nome}\``);
    }
    if (cfg.containers.length === 0) {
      add('docker', 'containers', 'falha', 'MASSA_DOCKER_CONTAINERS vazio.');
    } else if (problemas.length) {
      add('docker', 'containers', 'falha', problemas.join('; '));
    } else {
      add('docker', 'containers', 'ok', `${cfg.containers.join(', ')} (running${Object.values(estados).some((e) => e.health) ? '/healthy' : ''})`);
    }

    // Worker de fila (CA-T1): sem ele DNE, geo-imports e e-mails não processam.
    const fila = cfg.containers.find((c) => PADRAO_FILA.test(c));
    if (!fila) {
      add('docker', 'worker de fila', 'falha', 'nenhum container de fila (nome com "queue"/"worker") em MASSA_DOCKER_CONTAINERS. Inclua o container do `queue:work`.');
    } else if (!estados[fila]) {
      add('docker', 'worker de fila', 'falha', `container de fila "${fila}" não existe. Suba a stack (\`./vendor/bin/sail up -d\`) ou corrija MASSA_DOCKER_CONTAINERS.`);
    } else if (estados[fila]?.status !== 'running') {
      add('docker', 'worker de fila', 'falha', `worker de fila parado: rode \`docker start ${fila}\` (sem ele DNE, geo-imports e e-mails não processam).`);
    } else {
      const top = executor.programa('docker', ['top', fila, '-o', 'pid,args']);
      if (top.codigo === 0 && !/queue:(work|listen)|horizon/.test(top.saida)) {
        add('docker', 'worker de fila', 'falha', `${fila} está running mas sem processo \`queue:work\`. Rode \`docker restart ${fila}\`.`);
      } else {
        add('docker', 'worker de fila', 'ok', `${fila} com queue:work ativo`);
      }
    }

    const banco = cfg.containers.find((c) => PADRAO_BANCO.test(c));
    if (!banco) {
      add('docker', 'PostGIS', 'aviso', 'nenhum container de banco (nome com "pgsql"/"postgres") na lista; PostGIS não conferido.');
    } else if (estados[banco]?.status === 'running') {
      const r = executor.programa('docker', [
        'exec',
        banco,
        'sh',
        '-c',
        'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -tAc "SELECT postgis_version()"',
      ]);
      if (r.codigo === 0 && r.saida.trim()) add('docker', 'PostGIS', 'ok', `PostGIS ${r.saida.trim().split(/\s+/)[0]} em ${banco}`);
      else add('docker', 'PostGIS', 'falha', `SELECT postgis_version() falhou em ${banco}. Confira a extensão PostGIS.`);
    }

    const minio = cfg.containers.find((c) => PADRAO_MINIO.test(c));
    if (!minio) add('docker', 'MinIO/S3', 'aviso', 'nenhum container MinIO na lista; o storage S3 não foi conferido.');
    else if (estados[minio]?.status === 'running') add('docker', 'MinIO/S3', 'ok', `${minio} running (bucket conferido no upload do DNE, E1b)`);

    if (containerReset && estados[containerReset]?.status !== 'running' && cfg.containers.includes(containerReset)) {
      add('docker', 'alvo do reset', 'falha', `o container do MASSA_RESET_CMD (${containerReset}) não está running.`);
    }
  }

  // 4. Serviços HTTP ---------------------------------------------------------------------------
  let ambiente: ResultadoAmbiente | undefined;
  if (cfg.apiBase) {
    const up = await requisitar(`${cfg.apiBase}/up`, 'GET');
    if ('erro' in up || up.status !== 200) {
      add('servicos', 'api', 'falha', `GET ${cfg.apiBase}/up → ${'erro' in up ? up.erro : `HTTP ${up.status}`}. Suba a API (docker start / sail up).`);
    } else {
      add('servicos', 'api', 'ok', `${cfg.apiBase}/up = 200`);
    }
    ambiente = await consultarAmbiente(cfg.apiBase, { fetchImpl, timeoutMs });
    add('servicos', 'ambiente', ambiente.ok ? 'ok' : 'falha', ambiente.ok ? `api: /api/environment = "${ambiente.environment}"` : ambiente.mensagem);
  }
  const fronts: Array<[string, string]> = [
    ['admin', cfg.adminUrl],
    ['client', cfg.clientUrl],
  ];
  for (const [nome, url] of fronts) {
    if (!url) continue;
    const r = await requisitar(url, 'GET');
    if ('erro' in r || r.status !== 200) {
      add('servicos', nome, 'falha', `GET ${url} → ${'erro' in r ? r.erro : `HTTP ${r.status}`}. Rode \`npm run dev\` em ${nome}/.`);
    } else {
      const porta = new URL(url).port;
      if (!PORTAS_STATEFUL.includes(porta)) add('servicos', nome, 'aviso', `${url} responde, mas a porta ${porta || '(padrão)'} pode não ser Sanctum-stateful (use 5173/5174/5175).`);
      else add('servicos', nome, 'ok', `${nome} :${porta}`);
    }
  }
  if (cfg.mailpitUrl) {
    const r = await requisitar(`${cfg.mailpitUrl}/api/v1/info`, 'GET');
    if ('erro' in r || r.status !== 200) add('servicos', 'mailpit', 'falha', `GET ${cfg.mailpitUrl}/api/v1/info → ${'erro' in r ? r.erro : `HTTP ${r.status}`}. Suba o Mailpit.`);
    else add('servicos', 'mailpit', 'ok', `mailpit ${cfg.mailpitUrl}`);
  }

  // 6. Ferramental -----------------------------------------------------------------------------
  const nvmrc = resolve(raizQa, '.nvmrc');
  const minima = existsSync(nvmrc) ? readFileSync(nvmrc, 'utf8').trim() : '20';
  if (comparaVersao(process.versions.node, minima) < 0) add('ferramental', 'node', 'falha', `Node ${process.versions.node} < ${minima} (.nvmrc). Rode \`nvm use\`.`);
  else add('ferramental', 'node', 'ok', `node ${process.versions.node}`);
  const pkgPw = resolve(raizQa, 'node_modules', '@playwright', 'test', 'package.json');
  if (!existsSync(pkgPw)) {
    add('ferramental', 'node_modules', 'falha', 'node_modules ausente. Rode `npm ci` (ou `npm install`) em qa/.');
  } else {
    const instalada = (JSON.parse(readFileSync(pkgPw, 'utf8')) as { version: string }).version;
    const faixa = (JSON.parse(readFileSync(resolve(raizQa, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> }).devDependencies?.['@playwright/test'] ?? '';
    const baseFaixa = faixa.replace(/^[\^~>=]+/, '');
    const maiorIgual = baseFaixa.split('.')[0] === instalada.split('.')[0] && comparaVersao(instalada, baseFaixa) >= 0;
    add('ferramental', 'playwright', maiorIgual ? 'ok' : 'aviso', maiorIgual ? `playwright ${instalada}` : `playwright ${instalada} fora da faixa ${faixa} do package.json.`);
    try {
      const requerer = createRequire(resolve(raizQa, 'package.json'));
      const { chromium } = requerer('@playwright/test') as { chromium: { executablePath(): string } };
      const exe = chromium.executablePath();
      if (existsSync(exe)) add('ferramental', 'chromium', 'ok', 'chromium instalado');
      else add('ferramental', 'chromium', 'aviso', 'chromium do Playwright não instalado: rode `npx playwright install chromium` (necessário para os prints de evidência).');
    } catch {
      add('ferramental', 'chromium', 'aviso', 'não foi possível localizar o chromium do Playwright.');
    }
  }

  const falhas = itens.filter((i) => i.status === 'falha').length;
  const avisos = itens.filter((i) => i.status === 'aviso').length;
  return { apto: falhas === 0, itens, ambiente, falhas, avisos, iniciadoEm: new Date(inicio).toISOString(), duracaoMs: Date.now() - inicio };
}

const SIMBOLO: Record<StatusItem, string> = { ok: '✔', falha: '✖', aviso: '⚠' };

export function formatarPreflight(r: ResultadoPreflight): string {
  const linhas = ['Preflight — massa de dados (#10994)'];
  for (const i of r.itens) linhas.push(` ${SIMBOLO[i.status]} ${i.familia} · ${i.nome}: ${i.mensagem}`);
  linhas.push(
    r.apto
      ? `Resultado: APTO${r.avisos ? ` (${r.avisos} aviso${r.avisos > 1 ? 's' : ''})` : ''}`
      : `Resultado: INAPTO (${r.falhas} falha${r.falhas > 1 ? 's' : ''}${r.avisos ? `, ${r.avisos} aviso${r.avisos > 1 ? 's' : ''}` : ''}). Nada foi apagado nem escrito.`,
  );
  return linhas.join('\n');
}
