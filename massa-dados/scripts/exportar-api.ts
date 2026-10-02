/**
 * Exportador dos insumos da massa para o `api/` (#10994 · plano 10, BR-001, AC-001).
 *
 *   npm run massa:insumos:exportar-api                 → copia e mostra o que mudou
 *   npm run massa:insumos:exportar-api -- --verificar  → só compara (código 1 se a cópia divergir)
 *
 * Os insumos vivem nos dois repositórios por decisão do usuário (2026-10-01): o `qa` gera, o `api/`
 * consome no seeder `massa-demo:popular`. Este exportador é a ÚNICA via de atualização da cópia em
 * `api/database/data/massa-demo/`:
 *  1. confere o sha256 de cada insumo do `qa` contra `insumos/manifest.json` (insumo adulterado = recusa);
 *  2. monta o `manifest.json` da cópia (subconjunto do manifest do `qa`, os 5 arquivos que o seeder lê);
 *  3. compara byte a byte com o `api/` e, sem `--verificar`, grava os arquivos diferentes.
 *
 * Saída: 0 = sincronizada (ou sincronizada agora); 1 = divergente com `--verificar`; 2 = uso/insumo inválido.
 * Nada é commitado: o commit no `api/` é manual e descrito no `plan.done.md`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ_MASSA = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const ORIGEM_PADRAO = resolve(RAIZ_MASSA, 'insumos');
export const DESTINO_PADRAO = resolve(RAIZ_MASSA, '..', '..', 'api', 'database', 'data', 'massa-demo');

/** Insumos que o seeder do `api/` consome (o manifest da cópia lista exatamente estes). */
export const ARQUIVOS_API = ['coordenadas-familias.json', 'elenco.json', 'entidades-ficticias.json', 'esperado.json', 'unidades-ficticias.json'] as const;
export const MANIFEST = 'manifest.json';
export const ORIGEM_MANIFEST_API = 'qa/massa-dados/insumos (cópia versionada; sincronização automática no plano 10)';

interface ItemManifest {
  caminho: string;
  contagem: number;
  sha256: string;
  unidade_contagem: string;
}

export class InsumoInvalido extends Error {}

const sha256 = (conteudo: Buffer | string) => createHash('sha256').update(conteudo).digest('hex');

/**
 * Lê o manifest do `qa`, confere o sha256 dos 5 insumos e devolve o conteúdo de cada arquivo da cópia
 * (os 5 insumos + o `manifest.json` derivado), já no formato byte a byte que vai para o `api/`.
 */
export function montarCopia(origem = ORIGEM_PADRAO): Map<string, Buffer> {
  const caminhoManifest = resolve(origem, MANIFEST);
  if (!existsSync(caminhoManifest)) throw new InsumoInvalido(`manifest do qa ausente: ${caminhoManifest}`);
  const manifest = JSON.parse(readFileSync(caminhoManifest, 'utf8')) as { versao_elenco: string; arquivos: ItemManifest[] };
  const copia = new Map<string, Buffer>();
  const itens: ItemManifest[] = [];
  for (const nome of ARQUIVOS_API) {
    const item = manifest.arquivos.find((a) => a.caminho === nome);
    if (!item) throw new InsumoInvalido(`${nome} fora do manifest do qa — rode npm run massa:insumos.`);
    const caminho = resolve(origem, nome);
    if (!existsSync(caminho)) throw new InsumoInvalido(`insumo ausente: ${nome}`);
    const conteudo = readFileSync(caminho);
    if (sha256(conteudo) !== item.sha256) throw new InsumoInvalido(`sha256 de ${nome} diverge do manifest do qa (insumo adulterado ou manifest desatualizado — rode npm run massa:insumos).`);
    copia.set(nome, conteudo);
    itens.push({ caminho: item.caminho, contagem: item.contagem, sha256: item.sha256, unidade_contagem: item.unidade_contagem });
  }
  itens.sort((a, b) => a.caminho.localeCompare(b.caminho));
  const manifestApi = { arquivos: itens, origem: ORIGEM_MANIFEST_API, versao_elenco: manifest.versao_elenco };
  copia.set(MANIFEST, Buffer.from(`${JSON.stringify(manifestApi, null, 2)}\n`, 'utf8'));
  return copia;
}

export type SituacaoArquivo = 'igual' | 'diferente' | 'ausente';

/** Compara a cópia montada com o que está no `api/`. */
export function compararCopia(copia: Map<string, Buffer>, destino = DESTINO_PADRAO): Array<{ arquivo: string; situacao: SituacaoArquivo; antes: string | null; depois: string }> {
  return [...copia].map(([arquivo, conteudo]) => {
    const caminho = resolve(destino, arquivo);
    if (!existsSync(caminho)) return { arquivo, situacao: 'ausente' as const, antes: null, depois: sha256(conteudo) };
    const atual = readFileSync(caminho);
    return { arquivo, situacao: atual.equals(conteudo) ? ('igual' as const) : ('diferente' as const), antes: sha256(atual), depois: sha256(conteudo) };
  });
}

/** Diff unificado curto (até 40 linhas) entre o arquivo do `api/` e o novo conteúdo, quando `diff` existe. */
function diffCurto(atual: string, conteudo: Buffer): string {
  const r = spawnSync('diff', ['-u', atual, '-'], { input: conteudo, encoding: 'utf8' });
  if (r.error || typeof r.stdout !== 'string') return '';
  const linhas = r.stdout.split('\n');
  return linhas.slice(0, 40).join('\n') + (linhas.length > 40 ? `\n… (+${linhas.length - 40} linhas)` : '');
}

export function executarExportacao(
  args: string[],
  o: { origem?: string; destino?: string; log?: (linha: string) => void } = {},
): number {
  const log = o.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const desconhecidas = args.filter((a) => a !== '--verificar');
  if (desconhecidas.length) {
    log(`✖ Opção desconhecida: ${desconhecidas.join(' ')}. Uso: npm run massa:insumos:exportar-api [-- --verificar]`);
    return 2;
  }
  const verificar = args.includes('--verificar');
  const destino = o.destino ?? DESTINO_PADRAO;
  let copia: Map<string, Buffer>;
  try {
    copia = montarCopia(o.origem ?? ORIGEM_PADRAO);
  } catch (erro) {
    log(`✖ ${(erro as Error).message}`);
    return 2;
  }
  if (!existsSync(resolve(destino, '..'))) {
    log(`✖ Destino inexistente: ${destino} (o api/ está ao lado do qa/?).`);
    return 2;
  }
  const situacao = compararCopia(copia, destino);
  const divergentes = situacao.filter((s) => s.situacao !== 'igual');
  for (const s of situacao) log(`${s.situacao === 'igual' ? '✔' : '✖'} ${s.arquivo}: ${s.situacao}${s.situacao === 'igual' ? '' : ` (api ${s.antes?.slice(0, 12) ?? '—'} → qa ${s.depois.slice(0, 12)})`}`);
  if (!divergentes.length) {
    log(`✔ Cópia do api/ sincronizada com os insumos do qa (${situacao.length} arquivos, sha256 conferido).`);
    return 0;
  }
  if (verificar) {
    log(`✖ Cópia do api/ diverge em ${divergentes.length} arquivo(s): rode npm run massa:insumos:exportar-api e commite no api/.`);
    return 1;
  }
  mkdirSync(destino, { recursive: true });
  for (const s of divergentes) {
    const caminho = resolve(destino, s.arquivo);
    const conteudo = copia.get(s.arquivo)!;
    if (s.situacao === 'diferente') {
      const d = diffCurto(caminho, conteudo);
      if (d) log(d);
    }
    writeFileSync(caminho, conteudo);
  }
  log(`✔ ${divergentes.length} arquivo(s) gravado(s) em ${destino}. Commite a cópia no api/ (nada foi commitado).`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = executarExportacao(process.argv.slice(2));
}
