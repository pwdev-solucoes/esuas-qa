/**
 * Executor genérico de `elenco.registros[]` (#10994 · etapas E10–E16, BR-001, BR-011, BR-013).
 *
 * - Cada registro é feito pelo profissional do elenco (`registro.profissional`), que está lotado na
 *   unidade na data do fato: a API confere isso (`UnitAssignedOnDate`, `ProfessionalAssignedOnDate`).
 *   Nada de Master "por atalho": um 422 de elegibilidade sobe como falha (RN14).
 * - Lookups (tipos, códigos, serviços, locais, motivos de desligamento) são resolvidos pelo `code`
 *   nos endpoints `options` do próprio prontuário, com a sessão de quem registra.
 * - Integrantes: chave de pessoa do elenco → uuid da pessoa (E07) → `member_uuid` da composição (E08).
 * - Retomada: cada registro criado grava `REG_<chave>` no mapa de chaves do estado; um registro já
 *   gravado é pulado. Assim uma etapa interrompida pode ser reexecutada sem duplicar (dev).
 * - `warnings` da resposta (ex.: `remittance_regeneration`) viram aviso da etapa, nunca erro (BR-013).
 */
import { cpfSequencial } from '../scripts/lib/cpf.ts';
import type { ClientePapel } from './http.ts';
import { lerEstado } from './execucao.ts';
import { dados, lerInsumo, type ContextoEtapa } from './papeis.ts';

/** Valor de uma chave de negócio já gravada no estado, ou `undefined` (sem lançar). */
export function chaveOpcional(ctx: Pick<ContextoEtapa, 'caminho'>, chave: string): string | undefined {
  return lerEstado(ctx.caminho).estado.chaves[chave];
}

export type TipoRegistro = 'attendance' | 'referral' | 'follow_up' | 'participation' | 'eventual_benefit' | 'sheltering' | 'capacitation';

export interface RegistroElenco {
  chave: string;
  tipo: TipoRegistro;
  data_fato: string;
  familia_chave: string | null;
  unidade: string;
  profissional: string;
  payload: Record<string, unknown>;
}

/** Registros do elenco (todos ou de um tipo), em ordem de data do fato e chave. */
export function registrosDoElenco(tipo?: TipoRegistro): RegistroElenco[] {
  const { registros } = lerInsumo<{ registros: RegistroElenco[] }>('elenco.json');
  return registros
    .filter((r) => !tipo || r.tipo === tipo)
    .sort((a, b) => a.data_fato.localeCompare(b.data_fato) || a.chave.localeCompare(b.chave));
}

export const chaveRegistro = (chave: string): string => `REG_${chave}`;

const DESCRICAO_PADRAO = 'Registro de demonstração (massa fictícia).';

interface Lookup {
  uuid: string;
  code: string;
}

/** Item de lookup pelo `code` (lança com a lista de códigos disponíveis). */
function porCodigo<T extends Lookup>(itens: T[] | undefined, codigo: string, onde: string): T {
  const achado = (itens ?? []).find((i) => String(i.code) === codigo);
  if (!achado) throw new Error(`${onde}: código "${codigo}" indisponível (há: ${(itens ?? []).map((i) => i.code).join(', ') || 'nenhum'}).`);
  return achado;
}

export class ExecutorRegistros {
  private readonly membros = new Map<string, Map<string, string>>();
  private readonly opcoes = new Map<string, Record<string, unknown>>();
  readonly criadosPorTipo = new Map<TipoRegistro, number>();
  readonly puladosPorTipo = new Map<TipoRegistro, number>();

  constructor(private readonly ctx: ContextoEtapa) {}

  /** Sessão do profissional do registro. */
  sessao(r: RegistroElenco): Promise<ClientePapel> {
    return this.ctx.sessoes.entrar(r.profissional);
  }

  familia(chaveFamilia: string | null): string {
    if (!chaveFamilia) throw new Error('Registro sem família.');
    return this.ctx.chaves.obter(`FAM_${chaveFamilia}`);
  }

  unidade(chaveUnidade: string): string {
    return this.ctx.chaves.obter(`UNIT_${chaveUnidade}`);
  }

  profissional(codigo: string): string {
    return this.ctx.chaves.obter(`PROF_${codigo}`);
  }

  /** `member_uuid` do integrante (chave de pessoa do elenco) na composição da família. */
  async membro(cliente: ClientePapel, chaveFamilia: string, chavePessoa: string): Promise<string> {
    let mapa = this.membros.get(chaveFamilia);
    if (!mapa) {
      const corpo = dados<{ members: Array<{ member_uuid: string; person_uuid: string }> }>(
        (await cliente.get(`/api/client/families/${this.familia(chaveFamilia)}/members`)).corpo,
      );
      mapa = new Map(corpo.members.map((m) => [m.person_uuid, m.member_uuid]));
      this.membros.set(chaveFamilia, mapa);
    }
    const uuid = mapa.get(this.ctx.chaves.obter(`PES_${chavePessoa}`));
    if (!uuid) throw new Error(`${chavePessoa} não é integrante vigente de ${chaveFamilia}.`);
    return uuid;
  }

  /** `options` de um recurso do prontuário (cache por recurso + profissional + unidade). */
  private async opcoesDe(cliente: ClientePapel, recurso: string, r: RegistroElenco, query = ''): Promise<Record<string, unknown>> {
    const chave = `${recurso}|${r.profissional}|${r.unidade}|${query}`;
    const emCache = this.opcoes.get(chave);
    if (emCache) return emCache;
    const valor = dados<Record<string, unknown>>((await cliente.get(`/api/client/families/${this.familia(r.familia_chave)}/${recurso}/options${query}`)).corpo);
    this.opcoes.set(chave, valor);
    return valor;
  }

  private avisosDaResposta(r: RegistroElenco, corpo: unknown): void {
    const warnings = (corpo as { warnings?: unknown[] } | null)?.warnings;
    for (const w of Array.isArray(warnings) ? warnings : []) {
      const codigo = typeof w === 'object' && w !== null ? String((w as { code?: string; kind?: string }).code ?? (w as { kind?: string }).kind ?? 'aviso') : String(w);
      this.ctx.registro.aviso(`${r.chave}: aviso da API "${codigo}" (não é erro, BR-013)`);
    }
  }

  private contar(mapa: Map<TipoRegistro, number>, tipo: TipoRegistro): void {
    mapa.set(tipo, (mapa.get(tipo) ?? 0) + 1);
  }

  /** Cria o registro (ou pula, se já criado nesta execução). Devolve o uuid. */
  async registrar(r: RegistroElenco): Promise<{ uuid: string; novo: boolean }> {
    const existente = chaveOpcional(this.ctx, chaveRegistro(r.chave));
    if (existente) {
      this.contar(this.puladosPorTipo, r.tipo);
      return { uuid: existente, novo: false };
    }
    this.ctx.chaveAtual = r.chave;
    const cliente = await this.sessao(r);
    const { uri, corpo } = await this.montar(cliente, r);
    const resposta = await cliente.post(uri, corpo);
    this.avisosDaResposta(r, resposta.corpo);
    const criado = dados<{ uuid?: string; follow_up?: { uuid: string } }>(resposta.corpo);
    const uuid = criado.uuid ?? criado.follow_up?.uuid;
    if (!uuid) throw new Error(`${r.chave}: resposta sem uuid.`);
    this.ctx.chaves.definir(chaveRegistro(r.chave), uuid);
    this.contar(this.criadosPorTipo, r.tipo);
    this.ctx.registro.passo({ chave: r.chave, tipo: r.tipo, data_fato: r.data_fato, unidade: r.unidade, profissional: r.profissional, status: resposta.status });
    this.ctx.chaveAtual = null;
    return { uuid, novo: true };
  }

  private async montar(cliente: ClientePapel, r: RegistroElenco): Promise<{ uri: string; corpo: Record<string, unknown> }> {
    const p = r.payload;
    const unidade = this.unidade(r.unidade);
    switch (r.tipo) {
      case 'attendance': {
        const op = await this.opcoesDe(cliente, 'attendances', r);
        const tipo = porCodigo(op.types as Lookup[], String(p.tipo_codigo), `${r.chave} tipos de atendimento`);
        const pessoas = (p.pessoas as string[]) ?? [];
        const people: string[] = [];
        for (const chave of pessoas) people.push(await this.membro(cliente, r.familia_chave as string, chave));
        return {
          uri: `/api/client/families/${this.familia(r.familia_chave)}/attendances`,
          corpo: {
            attended_on: r.data_fato,
            social_unit_uuid: unidade,
            attendance_type_uuid: tipo.uuid,
            responsible_professional_uuid: this.profissional(r.profissional),
            description: String(p.descricao ?? DESCRICAO_PADRAO),
            people,
          },
        };
      }
      case 'referral': {
        const op = await this.opcoesDe(cliente, 'referrals', r, `?social_unit_uuid=${unidade}&referred_on=${r.data_fato}`);
        const codigo = porCodigo(op.codes as Lookup[], String(p.codigo), `${r.chave} códigos de encaminhamento`);
        const corpo: Record<string, unknown> = {
          referred_on: r.data_fato,
          social_unit_uuid: unidade,
          referral_code_uuid: codigo.uuid,
          objective: String(p.objetivo ?? DESCRICAO_PADRAO),
          responsible_professional_uuid: this.profissional(r.profissional),
        };
        if (p.integrante) corpo.family_member_uuid = await this.membro(cliente, r.familia_chave as string, String(p.integrante));
        if (p.destino_unidade) corpo.destination_social_unit_uuid = this.unidade(String(p.destino_unidade));
        else corpo.destination_organization = String(p.destino_orgao ?? 'Órgão de demonstração');
        return { uri: `/api/client/families/${this.familia(r.familia_chave)}/referrals`, corpo };
      }
      case 'follow_up': {
        const op = await this.opcoesDe(cliente, 'follow-ups', r, `?social_unit_uuid=${unidade}&admitted_on=${r.data_fato}`);
        const servico = porCodigo(op.services as Lookup[], String(p.servico), `${r.chave} serviços de acompanhamento`);
        return {
          uri: `/api/client/families/${this.familia(r.familia_chave)}/follow-ups`,
          corpo: { admitted_on: r.data_fato, social_unit_uuid: unidade, follow_up_service_uuid: servico.uuid },
        };
      }
      case 'participation': {
        const op = await this.opcoesDe(cliente, 'participations', r);
        const servico = porCodigo(op.services as Lookup[], String(p.servico_codigo), `${r.chave} serviços de participação`);
        const local = porCodigo(op.locations as Lookup[], String(p.local_codigo), `${r.chave} locais de participação`);
        const corpo: Record<string, unknown> = {
          family_member_uuid: await this.membro(cliente, r.familia_chave as string, String(p.integrante)),
          social_unit_uuid: unidade,
          participation_service_uuid: servico.uuid,
          participation_location_uuid: local.uuid,
          started_on: r.data_fato,
          ended_on: p.encerrada_em ?? null,
        };
        return { uri: `/api/client/families/${this.familia(r.familia_chave)}/participations`, corpo };
      }
      case 'eventual_benefit': {
        const op = await this.opcoesDe(cliente, 'eventual-benefits', r);
        const tipo = porCodigo(
          op.types as Array<Lookup & { requires_birth_registration: boolean; requires_deceased_cpf: boolean; requires_description: boolean }>,
          String(p.tipo_codigo),
          `${r.chave} tipos de benefício`,
        );
        const corpo: Record<string, unknown> = { granted_on: r.data_fato, social_unit_uuid: unidade, eventual_benefit_type_uuid: tipo.uuid };
        // Matriz condicional do tipo (§4.2): o elenco não traz os campos exigidos por Natalidade (1) e
        // Funeral (2); o executor os completa com valores fictícios determinísticos (faixa 98, sem PII).
        if (tipo.requires_birth_registration) corpo.birth_registration_number = String(p.registro_nascimento ?? `DEMO-NASC-${r.chave}`);
        if (tipo.requires_deceased_cpf) corpo.deceased_cpf = String(p.cpf_falecido ?? cpfSequencial(9_000_000 + Number(r.chave.replace(/\D/g, '').slice(-4))));
        if (p.observacao) corpo.notes = String(p.observacao);
        else if (tipo.requires_description) corpo.notes = 'Benefício de demonstração (massa fictícia).';
        return { uri: `/api/client/families/${this.familia(r.familia_chave)}/eventual-benefits`, corpo };
      }
      case 'sheltering':
        return {
          uri: `/api/client/families/${this.familia(r.familia_chave)}/shelterings`,
          corpo: {
            family_member_uuid: await this.membro(cliente, r.familia_chave as string, String(p.integrante)),
            started_on: r.data_fato,
            ended_on: p.encerrado_em ?? null,
            modality: String(p.modalidade),
            reason: 'Acolhimento de demonstração (massa fictícia).',
          },
        };
      case 'capacitation': {
        const tipo = await this.tipoCapacitacao(cliente, String(p.tipo_codigo));
        const corpo: Record<string, unknown> = {
          capacitation_action_type_uuid: tipo.uuid,
          title: String(p.titulo),
          participants: ((p.participantes as string[]) ?? []).map((c) => this.profissional(c)),
        };
        if (tipo.periodo) {
          corpo.started_on = r.data_fato;
          corpo.ended_on = p.encerrada_em ?? null;
        } else {
          corpo.occurred_on = r.data_fato;
        }
        return { uri: `/api/client/social-units/${unidade}/capacitation-actions`, corpo };
      }
      default:
        throw new Error(`Tipo de registro desconhecido: ${String((r as RegistroElenco).tipo)}`);
    }
  }

  /** Tipo de ação de capacitação pelo código (via `capacitation-tallies`, que lista os tipos ativos). */
  private async tipoCapacitacao(cliente: ClientePapel, codigo: string): Promise<{ uuid: string; periodo: boolean }> {
    const tallies = dados<Array<{ counters: Array<{ type_uuid: string; type_code: string; counting_mode: string }> }>>(
      (await cliente.get('/api/client/capacitation-tallies?exercise=2026&month=6')).corpo,
    );
    const tipo = tallies.flatMap((t) => t.counters).find((c) => c.type_code === codigo);
    if (!tipo) throw new Error(`Tipo de capacitação "${codigo}" indisponível.`);
    return { uuid: tipo.type_uuid, periodo: tipo.counting_mode === 'professional' };
  }

  /** Desligamento de um acompanhamento (com a avaliação que o acompanha, 12.4). */
  async desligar(r: RegistroElenco, followUpUuid: string): Promise<void> {
    const desl = r.payload.desligamento as { data: string; motivo_codigo: string } | null;
    if (!desl) return;
    const marca = `${chaveRegistro(r.chave)}_DESLIGAMENTO`;
    if (chaveOpcional(this.ctx, marca)) return;
    this.ctx.chaveAtual = r.chave;
    const cliente = await this.sessao(r);
    const base = `/api/client/families/${this.familia(r.familia_chave)}/follow-ups/${followUpUuid}`;
    const op = dados<{ exit_reasons: Lookup[] }>((await cliente.get(`${base}/evaluations/options?context=discharge&evaluated_on=${desl.data}`)).corpo);
    const motivo = porCodigo(op.exit_reasons, desl.motivo_codigo, `${r.chave} motivos de desligamento`);
    const resposta = await cliente.post(`${base}/discharge`, {
      discharged_on: desl.data,
      follow_up_exit_reason_uuid: motivo.uuid,
      offers_provided: 'yes',
      referrals_effective: 'not_applicable',
      family_recognizes_service: 'yes',
      outcome_classification: 'progress',
      achieved_results: 'Objetivos do plano de acompanhamento atingidos (massa fictícia).',
    });
    this.avisosDaResposta(r, resposta.corpo);
    this.ctx.chaves.definir(marca, desl.data);
    this.ctx.registro.passo({ chave: r.chave, passo: '12.4 desligamento com avaliação', data: desl.data, status: resposta.status });
    this.ctx.chaveAtual = null;
  }

  /** Desfecho de um encaminhamento (11.2). `awaiting_return`/null = sem desfecho: nada é enviado. */
  async desfecho(r: RegistroElenco, referralUuid: string): Promise<void> {
    const desfecho = r.payload.desfecho as string | null;
    if (!desfecho || desfecho === 'awaiting_return') return;
    const marca = `${chaveRegistro(r.chave)}_DESFECHO`;
    if (chaveOpcional(this.ctx, marca)) return;
    this.ctx.chaveAtual = r.chave;
    const cliente = await this.sessao(r);
    const resposta = await cliente.patch(`/api/client/families/${this.familia(r.familia_chave)}/referrals/${referralUuid}/outcome`, { outcome: desfecho });
    this.ctx.chaves.definir(marca, desfecho);
    this.ctx.registro.passo({ chave: r.chave, passo: '11.2 desfecho', desfecho, status: resposta.status });
    this.ctx.chaveAtual = null;
  }

  /** Resumo por tipo para o registro da etapa. */
  resumo(): Record<string, { criados: number; pulados: number }> {
    const tipos = new Set([...this.criadosPorTipo.keys(), ...this.puladosPorTipo.keys()]);
    return Object.fromEntries([...tipos].map((t) => [t, { criados: this.criadosPorTipo.get(t) ?? 0, pulados: this.puladosPorTipo.get(t) ?? 0 }]));
  }
}

/** Registra todos os registros de um tipo (BR-011: família sem unidade de referência não recebe registro). */
export async function registrarTodos(ctx: ContextoEtapa, tipo: TipoRegistro, depois?: (r: RegistroElenco, uuid: string, ex: ExecutorRegistros) => Promise<void>): Promise<ExecutorRegistros> {
  const ex = new ExecutorRegistros(ctx);
  const semUnidade = new Set(ctx.elenco.familias.filter((f) => !f.unidade_referencia).map((f) => f.chave));
  for (const r of registrosDoElenco(tipo)) {
    if (r.familia_chave && semUnidade.has(r.familia_chave)) throw new Error(`${r.chave}: o elenco tem registro para família sem unidade de referência (BR-011).`);
    const { uuid } = await ex.registrar(r);
    if (depois) await depois(r, uuid, ex);
  }
  ctx.registro.passo({ passo: `resumo ${tipo}`, ...ex.resumo()[tipo] });
  return ex;
}
