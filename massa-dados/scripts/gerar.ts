/**
 * `npm run massa:insumos` — regenera TODOS os insumos da massa, na ordem fixa (#10994 · RN-T4/RN-T6):
 *
 *   1. nomes      valida a lista curada (não gera)
 *   2. geo        copia e confere os GeoJSON
 *   3. unidades   2 CRAS + 1 CREAS com coordenada (semente fixa)
 *   4. entidades  ENT-1 (com CNEAS) e ENT-2 (sem)
 *   5. elenco     organização, equipe, famílias, pessoas, registros
 *   6. coordenadas um ponto por família (semente fixa)
 *   7. esperado   números esperados calculados sobre o elenco
 *   8. manifest   sha256 + contagens de tudo acima
 *
 * Rodar duas vezes produz arquivos byte-idênticos (provado por `massa:insumos:verificar`).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gerarCoordenadas } from './coordenadas.ts';
import { gerarElenco } from './elenco.ts';
import { gerarEntidades } from './entidades.ts';
import { gerarEsperado } from './esperado.ts';
import { gerarGeo } from './geo.ts';
import { gerarManifest } from './manifest.ts';
import { verificarNomes } from './nomes.ts';
import { gerarUnidades } from './unidades.ts';

export function gerarInsumos(): void {
  const lista = verificarNomes();
  gerarGeo();
  gerarUnidades();
  const entidades = gerarEntidades();
  const elenco = gerarElenco(lista);
  gerarCoordenadas(elenco);
  gerarEsperado(elenco, entidades);
  const manifest = gerarManifest(elenco.versao);
  const pessoas = elenco.pessoas.length;
  const semCpf = elenco.pessoas.filter((p) => p.cpf === null).length;
  console.log(
    `Insumos gerados: ${manifest.arquivos.length} arquivos · ${elenco.familias.length} famílias · ` +
      `${pessoas} pessoas (${semCpf} sem CPF) · ${elenco.registros.length} registros`,
  );
}

const executadoDireto = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (executadoDireto) {
  try {
    gerarInsumos();
  } catch (erro) {
    console.error(erro instanceof Error ? erro.message : erro);
    process.exit(1);
  }
}
