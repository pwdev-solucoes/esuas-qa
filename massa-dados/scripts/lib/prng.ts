/**
 * PRNG determinístico (mulberry32) para a massa (#10994 · RN-T4).
 *
 * É a ÚNICA fonte de "aleatoriedade" dos geradores, e sempre com semente fixa: mesma semente,
 * mesma sequência, em qualquer máquina. O gerador aleatório nativo e bibliotecas de dados falsos
 * são proibidos nos scripts (o teste de insumos confere).
 */

export interface Prng {
  /** Próximo número em [0, 1). */
  next(): number;
  /** Inteiro em [min, max] (inclusivo). */
  int(min: number, max: number): number;
  /** Elemento da lista. */
  pick<T>(lista: readonly T[]): T;
}

/** Converte um texto em semente de 32 bits (FNV-1a), para sementes legíveis como "coordenadas-v1". */
export function sementeDeTexto(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(semente: number): Prng {
  let a = semente >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(lista: readonly T[]): T {
      if (lista.length === 0) throw new Error('pick() em lista vazia');
      return lista[Math.floor(next() * lista.length)] as T;
    },
  };
}
