/**
 * Gera `insumos/elenco.json` (#10994 · RN06, RN07, RN11, BR-001…BR-007, AC-003/AC-005/AC-006).
 *
 * O elenco é a fonte ÚNICA da massa: organização, Master, equipe P0–P7, 60 famílias, ~200
 * pessoas e todos os registros datados de 2026-06/07/08. Tudo aqui é DETERMINÍSTICO: nomes por
 * cursor sobre a lista curada, CPF por sequência na base 98, datas fixas. Nenhum sorteio.
 *
 * Os `payload` usam CHAVES DE NEGÓCIO (códigos de catálogo e chaves do elenco), nunca uuid:
 * o executor (planos 04/05) resolve as chaves nos uuids reais do ambiente.
 */
import { cpfSequencial } from './lib/cpf.ts';
import { caminhoInsumo, escreverJson } from './lib/json.ts';
import type { ListaNomes } from './nomes.ts';
import { validarNomeCompleto } from './nomes.ts';
import { cnpjMassa } from './entidades.ts';
import type { ChaveUnidade } from './unidades.ts';
import { IBGE_ARAPIRACA, UNIDADES, VERSAO_INSUMOS } from './unidades.ts';

// ─── Tipos ──────────────────────────────────────────────────────────────────────────────────

export type Mes = '2026-06' | '2026-07' | '2026-08';
export const MESES: readonly Mes[] = ['2026-06', '2026-07', '2026-08'];
export const LOTACOES_DESDE = '2026-05-01';
/**
 * Competência (`AAAA-MM`) enviada na importação do DNE da E01b (CR-003, RN-T4: nada relativo a "hoje").
 * É o mês do arquivo DNE usado pela massa (`qa/docs/baseceps.dat.zip`, base de junho/2026). Trocar o
 * arquivo do DNE exige atualizar este valor e regenerar os insumos (`npm run massa:insumos`).
 */
export const DNE_COMPETENCIA = '2026-06';
export const DOMINIO_EMAIL = 'demo.sigsuas.local';

export type Sexo = '001' | '002'; // SexCode: 001 feminino, 002 masculino
export type TipoRegistro =
  | 'attendance'
  | 'referral'
  | 'follow_up'
  | 'participation'
  | 'eventual_benefit'
  | 'sheltering'
  | 'capacitation';

export interface Pessoa {
  chave: string;
  cpf: string | null;
  nome: string;
  nome_mae: string;
  nascimento: string;
  sexo: Sexo;
  familia_chave: string;
  /** KinshipTypeCode (`responsible`, `spouse`, `child`, `grandchild`, `sibling`). */
  parentesco: string;
  /** `schooling_levels.code`; `null` = sem escolaridade (pendência proposital, só F-ESCOL). */
  escolaridade: string | null;
  /** Condições do integrante (`family_member_conditions`) usadas pela completude 15.10 e perfis 15.7. */
  condicoes: {
    alfabetizado: boolean;
    deficiencia: boolean;
    doenca_grave: boolean;
    renda_propria: number;
    /** `school_situations.code` (4–17 anos) ou `null`. */
    situacao_escolar: string | null;
    trabalho_infantil: boolean;
  };
}

export interface Familia {
  chave: string;
  unidade_referencia: ChaveUnidade | null;
  /** CA/RN que a família-cenário exibe; `null` = família de fundo. */
  cenario: string | null;
  exibe: string | null;
  especificidade_confirmada: boolean;
  /** `social_specificities.code` confirmado; `null` = pendente (F-SEM-ESP). */
  especificidade_codigo: string | null;
  referenciada_em: string | null;
  responsavel: string;
  renda_per_capita: number;
  recebe_pbf: boolean;
  programas_sociais: Array<{ codigo: string; beneficiario: string | null }>;
  /** Condições habitacionais (15.11); `null` = ausentes (F-HAB). */
  habitacao: { area_risco: boolean; tipo_residencia: string; vulnerabilidade: boolean } | null;
}

export interface Profissional {
  chave: string;
  nome: string;
  cpf: string;
  email: string;
  papel: 'operador';
  add_ons: string[];
  permissoes_extras: string[];
  /** CBO no formato do catálogo (`2516-05`). */
  cbo: string;
  lotacoes: Array<{ unidade: ChaveUnidade; desde: string }>;
  finalidade: string;
}

export interface Registro {
  chave: string;
  tipo: TipoRegistro;
  familia_chave: string | null;
  unidade: ChaveUnidade;
  profissional: string;
  data_fato: string;
  payload: Record<string, unknown>;
}

export interface Elenco {
  versao: string;
  meses_referencia: Mes[];
  lotacoes_desde: string;
  /** Competência fixa do DNE importado na E01b (CR-003). */
  dne: { competencia: string };
  organizacao: {
    razao_social: string;
    cnpj: string;
    ibge: string;
    municipio: string;
    uf: string;
    master: { chave: string; nome: string; cpf: string; email: string; papel: 'master' };
  };
  unidades: Array<{ chave: ChaveUnidade; nome: string; tipo: string }>;
  profissionais: Profissional[];
  familias: Familia[];
  pessoas: Pessoa[];
  registros: Registro[];
}

// ─── Nomes (cursor determinístico sobre a lista curada) ────────────────────────────────────

class AlocadorNomes {
  private fem = 0;
  private masc = 0;
  private meio = 0;
  private readonly usados = new Set<string>();

  constructor(private readonly lista: ListaNomes) {}

  proximo(sexo: Sexo, ultimo: string): string {
    const prenomes = sexo === '001' ? this.lista.prenomes_femininos : this.lista.prenomes_masculinos;
    for (let tentativa = 0; tentativa < 10_000; tentativa++) {
      const pre = prenomes[(sexo === '001' ? this.fem++ : this.masc++) % prenomes.length] as string;
      const meio = this.lista.sobrenomes[this.meio++ % this.lista.sobrenomes.length] as string;
      if (meio === ultimo) continue;
      const nome = `${pre} ${meio} ${ultimo}`;
      if (this.usados.has(nome)) continue;
      const erros = validarNomeCompleto(nome, this.lista);
      if (erros.length > 0) throw new Error(erros.join('; '));
      this.usados.add(nome);
      return nome;
    }
    throw new Error('Lista de nomes esgotada');
  }

  sobrenome(i: number): string {
    return this.lista.sobrenomes[i % this.lista.sobrenomes.length] as string;
  }
}

// ─── Especificação das famílias ──────────────────────────────────────────────────────────

interface MembroSpec {
  sexo: Sexo;
  parentesco: string;
  idade?: number;
  nascimento?: string;
  semCpf?: boolean;
  semEscolaridade?: boolean;
  situacaoEscolar?: string;
  trabalhoInfantil?: boolean;
}

interface FamiliaSpec {
  chave: string;
  unidade: ChaveUnidade | null;
  sobrenome: string;
  cenario: string | null;
  exibe: string | null;
  membros: MembroSpec[];
  rendaPerCapita?: number;
  pbf?: boolean;
  bpcBeneficiario?: number; // índice do membro
  semEspecificidade?: boolean;
  semHabitacao?: boolean;
}

const F: Sexo = '001';
const M: Sexo = '002';
const resp = (sexo: Sexo, idade: number): MembroSpec => ({ sexo, parentesco: 'responsible', idade });
const conj = (sexo: Sexo, idade: number): MembroSpec => ({ sexo, parentesco: 'spouse', idade });
const filho = (sexo: Sexo, idade: number, extra: Partial<MembroSpec> = {}): MembroSpec => ({
  sexo,
  parentesco: 'child',
  idade,
  ...extra,
});

/** Famílias-cenário, na ordem do `elenco.md`. */
function familiasCenario(): FamiliaSpec[] {
  return [
    {
      chave: 'F-IDOSO', unidade: 'U-CN', sobrenome: 'Amostra', cenario: 'CA06',
      exibe: 'Idoso de 60+ no SCFV de adultos, fora de todas as faixas (elderly_outside_range)',
      membros: [resp(M, 68), conj(F, 64), { sexo: M, parentesco: 'grandchild', idade: 10 }],
    },
    {
      chave: 'F-GRUPO', unidade: 'U-CS', sobrenome: 'Exemplar', cenario: 'CA06',
      exibe: 'Família em grupo PAIF: conta em families_in_groups com zero nas 4 faixas',
      membros: [resp(F, 34), conj(M, 36), filho(M, 8), filho(F, 5)],
    },
    {
      chave: 'F-PERFIS-1', unidade: 'U-CN', sobrenome: 'Modelo', cenario: 'CA06',
      exibe: 'Nova família de 07 com extrema pobreza + Bolsa Família + BPC',
      membros: [resp(F, 29), filho(M, 9), filho(F, 6), filho(M, 2)],
      rendaPerCapita: 150, pbf: true, bpcBeneficiario: 2,
    },
    {
      chave: 'F-PERFIS-2', unidade: 'U-CN', sobrenome: 'Modelo', cenario: 'CA06',
      exibe: 'Nova família de 07 com extrema pobreza + Bolsa Família + trabalho infantil',
      membros: [resp(F, 41), filho(M, 13, { trabalhoInfantil: true }), filho(F, 10)],
      rendaPerCapita: 100, pbf: true,
    },
    {
      chave: 'F-PERFIS-3', unidade: 'U-CN', sobrenome: 'Modelo', cenario: 'CA06',
      exibe: 'Nova família de 07 com extrema pobreza + Bolsa Família + evasão escolar',
      membros: [resp(F, 38), conj(M, 40), filho(M, 15, { situacaoEscolar: '3' }), filho(F, 7)],
      rendaPerCapita: 200, pbf: true,
    },
    {
      chave: 'F-PERFIS-4', unidade: 'U-CN', sobrenome: 'Modelo', cenario: 'CA06',
      exibe: 'Nova família de 07 só com Bolsa Família (bebê sem CPF)',
      membros: [resp(F, 23), filho(M, 0, { nascimento: '2026-01-20', semCpf: true })],
      rendaPerCapita: 400, pbf: true,
    },
    {
      chave: 'F-DUPLA', unidade: 'U-CN', sobrenome: 'Simulado', cenario: 'CA08',
      exibe: 'PAIF no CRAS Norte e PAEFI no CREAS no mesmo período: contada nas duas unidades',
      membros: [resp(F, 45), filho(M, 16), filho(F, 12), filho(M, 11)],
    },
    {
      chave: 'F-ENC', unidade: 'U-CN', sobrenome: 'Fictício', cenario: 'CA09',
      exibe: 'Encaminhamento de trânsito interno sem desfecho com destino o CRAS Sul: P2 abre o prontuário',
      membros: [resp(F, 31), filho(M, 7), filho(F, 4)],
    },
    {
      chave: 'F-SEM-REF-1', unidade: null, sobrenome: 'Protótipo', cenario: 'RN10',
      exibe: 'Sem unidade de referência (family_without_reference_unit)',
      membros: [resp(F, 27), filho(M, 6)],
    },
    {
      chave: 'F-SEM-REF-2', unidade: null, sobrenome: 'Protótipo', cenario: 'RN10',
      exibe: 'Sem unidade de referência (family_without_reference_unit)',
      membros: [resp(M, 44), conj(F, 42), filho(F, 15)],
    },
    {
      chave: 'F-SEM-REF-3', unidade: null, sobrenome: 'Protótipo', cenario: 'RN10',
      exibe: 'Sem unidade de referência (family_without_reference_unit)',
      membros: [resp(F, 58), filho(M, 20)],
    },
    {
      chave: 'F-SEM-ESP-1', unidade: 'U-CN', sobrenome: 'Ilustrativo', cenario: 'RN10',
      exibe: 'Sem especificidade confirmada (family_pending_specificity)',
      membros: [resp(F, 36), conj(M, 38), filho(F, 10)], semEspecificidade: true,
    },
    {
      chave: 'F-SEM-ESP-2', unidade: 'U-CN', sobrenome: 'Ilustrativo', cenario: 'RN10',
      exibe: 'Sem especificidade confirmada (family_pending_specificity)',
      membros: [resp(M, 50), filho(F, 17)], semEspecificidade: true,
    },
    {
      chave: 'F-SEM-ESP-3', unidade: 'U-CS', sobrenome: 'Ilustrativo', cenario: 'RN10',
      exibe: 'Sem especificidade confirmada (family_pending_specificity)',
      membros: [resp(F, 30), conj(M, 32), filho(M, 9), filho(F, 3)], semEspecificidade: true,
    },
    {
      chave: 'F-SEM-ESP-4', unidade: 'U-CS', sobrenome: 'Ilustrativo', cenario: 'RN10',
      exibe: 'Sem especificidade confirmada (family_pending_specificity)',
      membros: [resp(F, 26), filho(M, 8), filho(M, 6)], semEspecificidade: true,
    },
    {
      chave: 'F-SEM-CPF', unidade: 'U-CS', sobrenome: 'Hipotético', cenario: 'CA10',
      exibe: 'Integrantes sem CPF atendidos no mês (attended_person_without_cpf)',
      membros: [
        resp(F, 27),
        { sexo: M, parentesco: 'sibling', idade: 24, semCpf: true },
        filho(F, 5, { semCpf: true }),
        filho(M, 3, { semCpf: true }),
      ],
    },
    {
      chave: 'F-ESCOL', unidade: 'U-CN', sobrenome: 'Referência', cenario: 'RN10',
      exibe: 'Integrante atendido sem escolaridade (member_without_schooling / 15.10)',
      membros: [resp(M, 52), conj(F, 49), filho(M, 19, { semEscolaridade: true })],
    },
    {
      chave: 'F-HAB-1', unidade: 'U-CS', sobrenome: 'Padrão', cenario: 'RN08',
      exibe: 'Atendida sem condições habitacionais (15.11)',
      membros: [resp(F, 39), filho(M, 14), filho(F, 11)], semHabitacao: true,
    },
    {
      chave: 'F-HAB-2', unidade: 'U-CS', sobrenome: 'Padrão', cenario: 'RN08',
      exibe: 'Atendida sem condições habitacionais (15.11)',
      membros: [resp(M, 61), conj(F, 59)], semHabitacao: true,
    },
    {
      chave: 'F-ACOLH', unidade: 'U-CE', sobrenome: 'Cenário', cenario: 'RN12',
      exibe: 'Acolhimento de criança (caso único e sensível) em família com PAEFI ativo',
      membros: [resp(F, 33), filho(F, 9), filho(M, 12), filho(M, 14)],
    },
    {
      chave: 'F-BENEF-2X', unidade: 'U-CS', sobrenome: 'Ensaio', cenario: 'RN08',
      exibe: 'Duas concessões de benefício eventual no mesmo mês (conta concessões, não famílias)',
      membros: [resp(F, 35), conj(M, 37), filho(F, 10), filho(M, 6)],
    },
    {
      chave: 'F-READM', unidade: 'U-CN', sobrenome: 'Rascunho', cenario: 'RN08',
      exibe: 'Desligada e readmitida no mesmo mês: conta 1 nova família',
      membros: [resp(F, 42), filho(M, 18), filho(F, 13)],
    },
  ];
}

/** Tamanhos das famílias de fundo (ciclo de 10), escolhidos para somar ~200 pessoas. */
const TAMANHOS_FUNDO = [4, 3, 4, 2, 5, 3, 4, 3, 4, 3];
const IDADES_FILHOS = [14, 9, 6, 11, 3, 16, 8, 12, 5, 1, 10, 7];
/** Famílias de fundo com bebê SEM CPF (completam ~9 pessoas sem CPF). */
const FUNDO_COM_BEBE = new Set([3, 11, 19, 27, 35]);

export function unidadeDoFundo(b: number): ChaveUnidade {
  if (b <= 14) return 'U-CN';
  if (b <= 29) return 'U-CS';
  return 'U-CE';
}

export const chaveFundo = (b: number): string => `FAM-${String(b).padStart(3, '0')}`;

function familiasFundo(alocador: AlocadorNomes): FamiliaSpec[] {
  const out: FamiliaSpec[] = [];
  for (let b = 1; b <= 38; b++) {
    const tamanho = TAMANHOS_FUNDO[(b - 1) % TAMANHOS_FUNDO.length] as number;
    const sexoResp: Sexo = b % 2 === 1 ? F : M;
    const idadeResp = 24 + ((b * 7) % 33);
    const membros: MembroSpec[] = [resp(sexoResp, idadeResp)];
    if (tamanho >= 3) {
      membros.push(conj(sexoResp === F ? M : F, idadeResp + ((b % 5) - 2)));
    }
    let k = 0;
    while (membros.length < tamanho) {
      const ultimo = membros.length === tamanho - 1;
      const sexo: Sexo = (b + k) % 2 === 0 ? F : M;
      if (ultimo && FUNDO_COM_BEBE.has(b)) {
        const dia = String(10 + (b % 15)).padStart(2, '0');
        membros.push(filho(sexo, 0, { nascimento: `2026-02-${dia}`, semCpf: true }));
      } else if (b === 2 && k === 0) {
        // Faz 7 anos em 15/07: faixa 0–6 em junho e 7–14 em julho/agosto (idade no último dia).
        membros.push(filho(sexo, 6, { nascimento: '2019-07-15' }));
      } else {
        const idade = Math.min(IDADES_FILHOS[(b + k * 5) % IDADES_FILHOS.length] as number, idadeResp - 18);
        membros.push(filho(sexo, idade));
      }
      k++;
    }
    out.push({
      chave: chaveFundo(b),
      unidade: unidadeDoFundo(b),
      sobrenome: alocador.sobrenome(b * 7),
      cenario: null,
      exibe: null,
      membros,
      rendaPerCapita: 250 + ((b * 53) % 700),
      pbf: b % 3 === 0,
    });
  }
  return out;
}

// ─── Pessoas ─────────────────────────────────────────────────────────────────────────────

/** Nascimento com aniversário entre set–dez: a idade fica constante de junho a agosto. */
function nascimentoPorIdade(idade: number, semente: number): string {
  const ano = 2026 - idade - 1;
  const mes = 9 + (semente % 4);
  const dia = 1 + ((semente * 7) % 28);
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Idade em anos completos na data de referência (mesmo cálculo de `ageOn()` dos services). */
export function idadeEm(nascimento: string, referencia: string): number | null {
  const [an, mn, dn] = nascimento.split('-').map(Number) as [number, number, number];
  const [ar, mr, dr] = referencia.split('-').map(Number) as [number, number, number];
  if (nascimento > referencia) return null;
  let idade = ar - an;
  if (mr < mn || (mr === mn && dr < dn)) idade--;
  return idade;
}

function escolaridadePorIdade(idade: number, semente: number): string {
  if (idade < 7) return '1';
  if (idade <= 17) return '3';
  return ['3', '4', '5', '3', '4'][semente % 5] as string;
}

// ─── Montagem ────────────────────────────────────────────────────────────────────────────

export function montarElenco(lista: ListaNomes): Elenco {
  const alocador = new AlocadorNomes(lista);
  let seqCpf = 0;
  const proximoCpf = (): string => cpfSequencial(++seqCpf);

  // Ordem do elenco (e da sequência de CPF): Master, P0–P7, pessoas por família.
  const master = {
    chave: 'M0',
    nome: alocador.proximo(F, 'Exemplar'),
    cpf: proximoCpf(),
    email: `master.1@${DOMINIO_EMAIL}`,
    papel: 'master' as const,
  };

  const equipe: Array<Omit<Profissional, 'nome' | 'cpf' | 'email' | 'papel'> & { sexo: Sexo }> = [
    { chave: 'P0', sexo: M, add_ons: [], permissoes_extras: [], cbo: '4110-10', lotacoes: [], finalidade: 'Cadastro de unidades, entidades e pessoas (sem lotação)' },
    { chave: 'P1', sexo: F, add_ons: ['family_viewer'], permissoes_extras: [], cbo: '2516-05', lotacoes: [{ unidade: 'U-CN', desde: LOTACOES_DESDE }], finalidade: 'Técnico PAIF do CRAS Norte' },
    { chave: 'P2', sexo: F, add_ons: ['family_viewer'], permissoes_extras: [], cbo: '2516-05', lotacoes: [{ unidade: 'U-CS', desde: LOTACOES_DESDE }], finalidade: 'Técnico PAIF do CRAS Sul; destino do trânsito interno (CA09)' },
    { chave: 'P3', sexo: M, add_ons: ['family_viewer'], permissoes_extras: [], cbo: '2515-30', lotacoes: [{ unidade: 'U-CE', desde: LOTACOES_DESDE }], finalidade: 'Técnico PAEFI do CREAS' },
    { chave: 'P4', sexo: F, add_ons: ['family_viewer'], permissoes_extras: [], cbo: '2516-05', lotacoes: [{ unidade: 'U-CN', desde: LOTACOES_DESDE }, { unidade: 'U-CE', desde: LOTACOES_DESDE }], finalidade: 'Profissional com duas lotações (CRAS Norte + CREAS)' },
    { chave: 'P5', sexo: M, add_ons: [], permissoes_extras: [], cbo: '2515-30', lotacoes: [{ unidade: 'U-CN', desde: LOTACOES_DESDE }], finalidade: 'Sem family_viewer: demonstra o bloqueio do prontuário' },
    { chave: 'P6', sexo: F, add_ons: ['geo_panel_viewer'], permissoes_extras: [], cbo: '5153-05', lotacoes: [{ unidade: 'U-CS', desde: LOTACOES_DESDE }], finalidade: 'Painel georreferenciado (E19)' },
    { chave: 'P7', sexo: M, add_ons: [], permissoes_extras: ['attendance-reports.view'], cbo: '1311-20', lotacoes: [{ unidade: 'U-CN', desde: LOTACOES_DESDE }], finalidade: 'Apuração vista por quem não é Master' },
  ];
  const profissionais: Profissional[] = equipe.map(({ sexo, ...p }, i) => ({
    ...p,
    nome: alocador.proximo(sexo, alocador.sobrenome(i * 5 + 3)),
    cpf: proximoCpf(),
    email: `operador.${i}@${DOMINIO_EMAIL}`,
    papel: 'operador',
  }));

  const specs = [...familiasCenario(), ...familiasFundo(alocador)];
  const familias: Familia[] = [];
  const pessoas: Pessoa[] = [];
  let seqPessoa = 0;

  specs.forEach((spec, fi) => {
    const chaves: string[] = [];
    const nomes: string[] = [];
    // Mãe dos filhos: a mulher adulta da família (responsável ou cônjuge).
    const idxMae = spec.membros.findIndex((m) => m.sexo === F && (m.parentesco === 'responsible' || m.parentesco === 'spouse'));
    const membrosNomeados = spec.membros.map((m) => alocador.proximo(m.sexo, spec.sobrenome));

    spec.membros.forEach((m, mi) => {
      const semente = fi * 13 + mi * 7;
      const nascimento = m.nascimento ?? nascimentoPorIdade(m.idade as number, semente);
      const idade = idadeEm(nascimento, '2026-08-31') as number;
      const chave = `PES-${String(++seqPessoa).padStart(3, '0')}`;
      const nome = membrosNomeados[mi] as string;
      const nomeMae =
        m.parentesco === 'child' && idxMae >= 0 && idxMae !== mi
          ? (membrosNomeados[idxMae] as string)
          : alocador.proximo(F, alocador.sobrenome(semente + 1));
      chaves.push(chave);
      nomes.push(nome);
      pessoas.push({
        chave,
        cpf: m.semCpf ? null : proximoCpf(),
        nome,
        nome_mae: nomeMae,
        nascimento,
        sexo: m.sexo,
        familia_chave: spec.chave,
        parentesco: m.parentesco,
        escolaridade: m.semEscolaridade ? null : escolaridadePorIdade(idade, semente),
        condicoes: {
          alfabetizado: idade >= 7,
          deficiencia: false,
          doenca_grave: false,
          renda_propria: m.parentesco === 'responsible' ? ([0, 600, 1200, 300][semente % 4] as number) : 0,
          situacao_escolar: m.situacaoEscolar ?? (idade >= 4 && idade <= 17 ? '1' : null),
          trabalho_infantil: m.trabalhoInfantil ?? false,
        },
      });
    });

    familias.push({
      chave: spec.chave,
      unidade_referencia: spec.unidade,
      cenario: spec.cenario,
      exibe: spec.exibe,
      especificidade_confirmada: !spec.semEspecificidade,
      especificidade_codigo: spec.semEspecificidade ? null : '019',
      referenciada_em: spec.unidade === null ? null : `2026-05-${String(2 + (fi % 25)).padStart(2, '0')}`,
      responsavel: chaves[0] as string,
      renda_per_capita: spec.rendaPerCapita ?? 400,
      recebe_pbf: spec.pbf ?? false,
      programas_sociais:
        spec.bpcBeneficiario === undefined
          ? []
          : [{ codigo: 'bpc', beneficiario: chaves[spec.bpcBeneficiario] as string }],
      habitacao: spec.semHabitacao
        ? null
        : { area_risco: false, tipo_residencia: fi % 3 === 0 ? '2' : '1', vulnerabilidade: false },
    });
  });

  const registros = montarRegistros(familias, pessoas);

  return {
    versao: VERSAO_INSUMOS,
    meses_referencia: [...MESES],
    lotacoes_desde: LOTACOES_DESDE,
    dne: { competencia: DNE_COMPETENCIA },
    organizacao: {
      razao_social: 'Município Demonstração SigSUAS',
      cnpj: cnpjMassa(1),
      ibge: IBGE_ARAPIRACA,
      municipio: 'Arapiraca',
      uf: 'AL',
      master,
    },
    unidades: UNIDADES.map((u) => ({ chave: u.chave, nome: u.nome, tipo: u.tipo })),
    profissionais,
    familias,
    pessoas,
    registros,
  };
}

// ─── Registros ───────────────────────────────────────────────────────────────────────────

type RegistroSemChave = Omit<Registro, 'chave'> & { chave?: string };

const PREFIXO: Record<TipoRegistro, string> = {
  attendance: 'ATD',
  referral: 'ENC',
  follow_up: 'ACP',
  participation: 'PRT',
  eventual_benefit: 'BEN',
  sheltering: 'ACO',
  capacitation: 'CAP',
};
const ORDEM_TIPO: TipoRegistro[] = [
  'follow_up',
  'attendance',
  'referral',
  'participation',
  'eventual_benefit',
  'sheltering',
  'capacitation',
];

/** Técnico que registra na unidade (P4 cobre o CREAS para F-DUPLA). */
function tecnico(unidade: ChaveUnidade, familia: string, i: number): string {
  if (unidade === 'U-CS') return 'P2';
  if (unidade === 'U-CE') return familia === 'F-DUPLA' ? 'P4' : 'P3';
  return i % 2 === 0 ? 'P1' : 'P4';
}

const dia = (mes: Mes, d: number): string => `${mes}-${String(d).padStart(2, '0')}`;

/** Tipos de atendimento em rodízio (códigos do catálogo global de 8 tipos). */
const RODIZIO_TIPOS = ['1', '7', '1', '3', '2', '1', '4', '6', '9', '7'];

function montarRegistros(familias: Familia[], pessoas: Pessoa[]): Registro[] {
  const membros = (fam: string): Pessoa[] => pessoas.filter((p) => p.familia_chave === fam);
  const membro = (fam: string, i: number): string => {
    const p = membros(fam)[i];
    if (!p) throw new Error(`Membro ${i} inexistente em ${fam}`);
    return p.chave;
  };
  const out: RegistroSemChave[] = [];
  const add = (r: RegistroSemChave): void => {
    out.push(r);
  };

  // ── E10 · Atendimentos ─────────────────────────────────────────────────────────────
  const comUnidade = familias.filter((f) => f.unidade_referencia !== null);
  const indiceNaUnidade = new Map<string, number>();
  for (const u of ['U-CN', 'U-CS', 'U-CE'] as ChaveUnidade[]) {
    comUnidade.filter((f) => f.unidade_referencia === u).forEach((f, i) => indiceNaUnidade.set(f.chave, i));
  }
  const todosSempre = new Set(['F-SEM-CPF', 'F-ESCOL']);
  comUnidade.forEach((fam, fi) => {
    const u = fam.unidade_referencia as ChaveUnidade;
    const i = indiceNaUnidade.get(fam.chave) as number;
    const fundo = fam.cenario === null;
    MESES.forEach((mes, mi) => {
      if (u === 'U-CE' && mes === '2026-06') return; // zero declarado do CREAS em junho (RN09/A3)
      if (fundo && mes === '2026-06' && i % 4 === 3) return;
      if (fundo && mes === '2026-08' && i % 5 === 4) return;
      const tipo = RODIZIO_TIPOS[(fi * 3 + mi) % RODIZIO_TIPOS.length] as string;
      const lista = membros(fam.chave);
      let atendidos: string[];
      if (todosSempre.has(fam.chave) || tipo === '7') atendidos = lista.map((p) => p.chave);
      else if ((tipo === '2' || tipo === '3') && lista.length > 1) atendidos = [lista[0]!.chave, lista[lista.length - 1]!.chave];
      else atendidos = [lista[0]!.chave];
      add({
        tipo: 'attendance',
        familia_chave: fam.chave,
        unidade: u,
        profissional: tecnico(u, fam.chave, i),
        data_fato: dia(mes, 2 + ((i * 5 + mi * 11) % 26)),
        payload: { tipo_codigo: tipo, pessoas: atendidos, descricao: 'Atendimento de demonstração (massa fictícia).' },
      });
    });
  });
  // F-DUPLA também é atendida no CREAS (P4) em julho e agosto.
  for (const [mes, d] of [['2026-07', 16], ['2026-08', 18]] as Array<[Mes, number]>) {
    add({
      tipo: 'attendance', familia_chave: 'F-DUPLA', unidade: 'U-CE', profissional: 'P4', data_fato: dia(mes, d),
      payload: { tipo_codigo: '1', pessoas: [membro('F-DUPLA', 0)], descricao: 'Atendimento PAEFI de demonstração (massa fictícia).' },
    });
  }

  // ── E11 · Encaminhamentos ──────────────────────────────────────────────────────────
  const orgao: Record<string, string> = {
    '07': 'Setor do Cadastro Único (demonstração)',
    '08': 'Setor do Cadastro Único (demonstração)',
    '09': 'Agência do INSS (demonstração)',
  };
  const enc = (familia: string, unidade: ChaveUnidade, data: string, codigo: string, extra: Record<string, unknown> = {}): void => {
    add({
      tipo: 'referral', familia_chave: familia, unidade, profissional: tecnico(unidade, familia, 0), data_fato: data,
      payload: {
        codigo, integrante: null, destino_orgao: orgao[codigo] ?? null, destino_unidade: null,
        objetivo: 'Encaminhamento de demonstração (massa fictícia).', desfecho: null, ...extra,
      },
    });
  };
  enc(chaveFundo(4), 'U-CN', '2026-06-08', '08', { desfecho: 'attended' });
  enc(chaveFundo(5), 'U-CN', '2026-06-15', '08');
  enc(chaveFundo(6), 'U-CN', '2026-06-22', '07', { desfecho: 'attended' });
  enc(chaveFundo(17), 'U-CS', '2026-06-10', '08');
  enc(chaveFundo(18), 'U-CS', '2026-06-24', '09', { integrante: membro(chaveFundo(18), 0) });
  enc(chaveFundo(7), 'U-CN', '2026-07-06', '07');
  enc(chaveFundo(7), 'U-CN', '2026-07-20', '07'); // mesma família: conta 1 (famílias distintas)
  enc('F-IDOSO', 'U-CN', '2026-07-09', '09', { integrante: membro('F-IDOSO', 0) });
  enc(chaveFundo(19), 'U-CS', '2026-07-08', '07');
  enc(chaveFundo(20), 'U-CS', '2026-07-17', '07');
  enc(chaveFundo(32), 'U-CE', '2026-07-22', '09', { integrante: membro(chaveFundo(32), 0) });
  enc(chaveFundo(8), 'U-CN', '2026-08-05', '07');
  enc(chaveFundo(21), 'U-CS', '2026-08-11', '08');
  enc(chaveFundo(33), 'U-CE', '2026-08-19', '07');
  // CA09 — trânsito interno SEM desfecho com destino o CRAS Sul. O catálogo só tem trânsito
  // interno CRAS↔CREAS (13: CRAS→CREAS; 14: CREAS→CRAS), então o registro sai do CREAS pela P4
  // (lotada no CRAS Norte e no CREAS), com o código 14. TODO(E11): confirmar no ambiente.
  add({
    tipo: 'referral', familia_chave: 'F-ENC', unidade: 'U-CE', profissional: 'P4', data_fato: '2026-07-10',
    payload: {
      codigo: '14', integrante: null, destino_orgao: null, destino_unidade: 'U-CS',
      objetivo: 'Trânsito interno de demonstração (massa fictícia).', desfecho: 'awaiting_return',
    },
  });

  // ── E12 · Acompanhamento (PAIF só em CRAS, PAEFI só em CREAS) ─────────────────────
  const acp = (familia: string, unidade: ChaveUnidade, admitido: string, desligamento: { data: string; motivo_codigo: string } | null = null, profissional?: string): void => {
    add({
      tipo: 'follow_up', familia_chave: familia, unidade, profissional: profissional ?? tecnico(unidade, familia, 0), data_fato: admitido,
      payload: { servico: unidade === 'U-CE' ? 'PAEFI' : 'PAIF', desligamento },
    });
  };
  acp(chaveFundo(1), 'U-CN', '2026-06-04', { data: '2026-08-10', motivo_codigo: '1' });
  acp(chaveFundo(2), 'U-CN', '2026-06-11', { data: '2026-06-25', motivo_codigo: '1' });
  acp('F-DUPLA', 'U-CN', '2026-06-09');
  acp('F-IDOSO', 'U-CN', '2026-06-16');
  acp('F-PERFIS-1', 'U-CN', '2026-07-02');
  acp('F-PERFIS-2', 'U-CN', '2026-07-07');
  acp('F-PERFIS-3', 'U-CN', '2026-07-14');
  acp('F-PERFIS-4', 'U-CN', '2026-07-21');
  acp('F-READM', 'U-CN', '2026-07-03', { data: '2026-07-12', motivo_codigo: '1' });
  acp('F-READM', 'U-CN', '2026-07-25');
  acp(chaveFundo(3), 'U-CN', '2026-08-06');
  acp('F-BENEF-2X', 'U-CS', '2026-06-08');
  acp(chaveFundo(15), 'U-CS', '2026-06-18');
  acp('F-SEM-CPF', 'U-CS', '2026-07-09');
  acp(chaveFundo(16), 'U-CS', '2026-08-12');
  acp('F-ACOLH', 'U-CE', '2026-07-02');
  acp('F-DUPLA', 'U-CE', '2026-07-08', null, 'P4');
  acp(chaveFundo(30), 'U-CE', '2026-07-15');
  acp(chaveFundo(31), 'U-CE', '2026-08-05');

  // ── E13 · Participação (serviços do catálogo; local 1 = na própria unidade) ────────
  const prt = (familia: string, idx: number, unidade: ChaveUnidade, servico: string, inicio: string, fim: string | null = null): void => {
    add({
      tipo: 'participation', familia_chave: familia, unidade, profissional: tecnico(unidade, familia, 0), data_fato: inicio,
      payload: { integrante: membro(familia, idx), servico_codigo: servico, local_codigo: '1', encerrada_em: fim },
    });
  };
  prt('F-IDOSO', 0, 'U-CN', '900', '2026-06-03'); // 68 anos no SCFV de adultos → fora de faixa (CA06)
  prt('F-IDOSO', 1, 'U-CN', '2', '2026-06-03'); // 64 anos no SCFV de idosos → elderly
  prt(chaveFundo(2), 2, 'U-CN', '1', '2026-06-10'); // faz 7 anos em 15/07
  prt('F-DUPLA', 2, 'U-CN', '1', '2026-06-12');
  prt('F-DUPLA', 3, 'U-CN', '1', '2026-06-12'); // 2 integrantes, 1 família em grupos
  prt('F-DUPLA', 1, 'U-CN', '1', '2026-07-01', '2026-08-15');
  prt('F-ENC', 0, 'U-CN', '900', '2026-07-05', '2026-07-30');
  prt('F-PERFIS-1', 3, 'U-CN', '1', '2026-08-05');
  prt(chaveFundo(15), 2, 'U-CS', '1', '2026-06-05', '2026-06-28');
  prt('F-GRUPO', 0, 'U-CS', '3', '2026-07-01', '2026-07-31'); // grupo PAIF: famílias em grupos, zero nas faixas
  prt('F-GRUPO', 2, 'U-CS', '3', '2026-07-01', '2026-07-31');
  prt('F-BENEF-2X', 3, 'U-CS', '1', '2026-08-04');
  prt('F-ACOLH', 0, 'U-CE', '4', '2026-08-06'); // grupo PAEFI

  // ── E14 · Benefícios eventuais (conta concessões) ──────────────────────────────────
  const ben = (familia: string, unidade: ChaveUnidade, data: string, tipoCodigo: string, observacao: string | null = null): void => {
    add({
      tipo: 'eventual_benefit', familia_chave: familia, unidade, profissional: tecnico(unidade, familia, 0), data_fato: data,
      payload: { tipo_codigo: tipoCodigo, observacao, registro_nascimento: null, cpf_falecido: null },
    });
  };
  ben(chaveFundo(9), 'U-CN', '2026-06-05', '4');
  ben(chaveFundo(10), 'U-CN', '2026-06-19', '4');
  ben(chaveFundo(11), 'U-CN', '2026-06-26', '1');
  ben(chaveFundo(22), 'U-CS', '2026-06-17', '3');
  ben(chaveFundo(12), 'U-CN', '2026-07-11', '2');
  ben(chaveFundo(13), 'U-CN', '2026-07-23', '5');
  ben('F-BENEF-2X', 'U-CS', '2026-07-08', '4');
  ben('F-BENEF-2X', 'U-CS', '2026-07-22', '4');
  ben('F-PERFIS-2', 'U-CN', '2026-08-07', '4');
  ben(chaveFundo(23), 'U-CS', '2026-08-14', '6', 'Benefício de demonstração classificado como Outros (massa fictícia).');

  // ── E15 · Acolhimento (caso único, RN12) ───────────────────────────────────────────
  add({
    tipo: 'sheltering', familia_chave: 'F-ACOLH', unidade: 'U-CE', profissional: 'P3', data_fato: '2026-07-20',
    payload: { integrante: membro('F-ACOLH', 1), modalidade: 'institutional', encerrado_em: null },
  });

  // ── E16 · Capacitação (15.9) ───────────────────────────────────────────────────────
  add({
    chave: 'CAP-1', tipo: 'capacitation', familia_chave: null, unidade: 'U-CN', profissional: 'P1', data_fato: '2026-06-17',
    payload: { tipo_codigo: '003', titulo: 'Reunião de equipe (demonstração)', participantes: [], encerrada_em: null },
  });
  add({
    chave: 'CAP-2', tipo: 'capacitation', familia_chave: null, unidade: 'U-CS', profissional: 'P2', data_fato: '2026-07-14',
    payload: { tipo_codigo: '001', titulo: 'Palestra à comunidade (demonstração)', participantes: ['P2', 'P6'], encerrada_em: null },
  });
  add({
    chave: 'CAP-3', tipo: 'capacitation', familia_chave: null, unidade: 'U-CE', profissional: 'P3', data_fato: '2026-07-15',
    payload: { tipo_codigo: '005', titulo: 'Curso de atualização (demonstração)', participantes: ['P3', 'P4'], encerrada_em: '2026-08-20' },
  });

  // Ordem estável: data do fato → tipo → família → unidade → ordem de criação.
  const indexados = out.map((r, i) => ({ r, i }));
  indexados.sort((a, b) => {
    const chaves: Array<[string | number, string | number]> = [
      [a.r.data_fato, b.r.data_fato],
      [ORDEM_TIPO.indexOf(a.r.tipo), ORDEM_TIPO.indexOf(b.r.tipo)],
      [a.r.familia_chave ?? '', b.r.familia_chave ?? ''],
      [a.r.unidade, b.r.unidade],
      [a.i, b.i],
    ];
    for (const [x, y] of chaves) {
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
  const contadores = new Map<string, number>();
  return indexados.map(({ r }) => {
    if (r.chave) return r as Registro;
    const mes = r.data_fato.slice(0, 7);
    const base = `${PREFIXO[r.tipo]}-${mes}`;
    const n = (contadores.get(base) ?? 0) + 1;
    contadores.set(base, n);
    return { ...r, chave: `${base}-${String(n).padStart(4, '0')}` };
  });
}

export function gerarElenco(lista: ListaNomes): Elenco {
  const elenco = montarElenco(lista);
  escreverJson(caminhoInsumo('elenco.json'), elenco);
  return elenco;
}
