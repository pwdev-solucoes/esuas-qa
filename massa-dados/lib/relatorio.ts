/**
 * Relatório de evidências da massa (#10994 · plano 06, RN-T5, RN-T7, BR-001, BR-004, BR-005, CA13).
 *
 * - `criarPastaExecucao()`: `relatorios/<AAAA-MM-DD_HHmm>/` (hora local), com sufixo `-2`, `-3`… se já
 *   existir — nunca reaproveita nem sobrescreve uma pasta anterior.
 * - `gerarRelatorio()`: uma `etapa-XX.html` por etapa de `ETAPAS` (inclusive as não executadas) e o
 *   `index.html` (cabeçalho, etapas, matriz CA, determinismo, composição, cenários, pendências
 *   propositais, esperado × apurado por mês e unidade, achados). Tudo com escape HTML.
 * - Saída passa por `sanitizar()` e por `verificarSemSegredos()` antes de ir para o disco.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RAIZ_MASSA, sanitizar } from './config.ts';
import type { EvidenciaEtapa } from './evidencia.ts';
import { ETAPAS, type DefinicaoEtapa, type EstadoEtapa, type EstadoExecucao } from './execucao.ts';
import type { Esperado } from './esperado.ts';
import type { Snapshot } from './snapshot.ts';

export const PASTA_RELATORIOS = resolve(RAIZ_MASSA, 'relatorios');
const PASTA_TEMPLATES = resolve(RAIZ_MASSA, 'relatorio');

// ---------------------------------------------------------------------------------------------
// Pasta da execução
// ---------------------------------------------------------------------------------------------

const dois = (n: number) => String(n).padStart(2, '0');

/** `AAAA-MM-DD_HHmm` na hora local. */
export function nomePastaExecucao(agora: Date): string {
  return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}_${dois(agora.getHours())}${dois(agora.getMinutes())}`;
}

/** Cria a pasta nova da execução (com `screens/` e `dados/`). Nunca reaproveita uma existente. */
export function criarPastaExecucao(base = PASTA_RELATORIOS, agora = new Date()): string {
  mkdirSync(base, { recursive: true });
  const nome = nomePastaExecucao(agora);
  for (let n = 1; n < 1000; n += 1) {
    const pasta = resolve(base, n === 1 ? nome : `${nome}-${n}`);
    if (existsSync(pasta)) continue;
    mkdirSync(pasta); // não recursivo: falha se outra execução criou no mesmo instante
    mkdirSync(resolve(pasta, 'screens'));
    mkdirSync(resolve(pasta, 'dados'));
    return pasta;
  }
  throw new Error(`Não foi possível criar pasta nova de relatório em ${base}.`);
}

/** Página da etapa: `E0` → `etapa-00b.html` (molde), `E10` → `etapa-10.html`, `E01b` → `etapa-01b.html`. */
export function arquivoEtapa(id: string): string {
  if (id === 'E0') return 'etapa-00b.html';
  return `etapa-${id.slice(1).toLowerCase()}.html`;
}

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------

export function escaparHtml(valor: unknown): string {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `{{x}}` recebe texto escapado; `{{{x}}}` recebe HTML já montado. Placeholder sem valor → vazio. */
export function preencher(template: string, valores: Record<string, unknown>): string {
  return template
    .replace(/\{\{\{\s*([a-z_]+)\s*\}\}\}/gi, (_, k: string) => String(valores[k] ?? ''))
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => escaparHtml(valores[k] ?? ''));
}

const h = escaparHtml;

function tabela(cabecalho: string[], linhas: string[][], classe = ''): string {
  if (!linhas.length) return '<p>—</p>';
  return (
    `<div class="table-scroll"><table${classe ? ` class="${classe}"` : ''}><thead><tr>${cabecalho.map((c) => `<th>${h(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${linhas.map((l) => `<tr>${l.join('')}</tr>`).join('\n')}</tbody></table></div>`
  );
}

const td = (v: unknown, classe = '') => `<td${classe ? ` class="${classe}"` : ''}>${h(v)}</td>`;
const tdHtml = (v: string, classe = '') => `<td${classe ? ` class="${classe}"` : ''}>${v}</td>`;

export type SeloStatus = 'ok' | 'fail' | 'warn' | 'skip';
export const selo = (tipo: SeloStatus, texto: string) => `<span class="st ${tipo}">${h(texto)}</span>`;

function duracao(ms: number): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${dois(s % 60)}s` : `${s}s`;
}

const ehAchado = (a: string) => a.startsWith('ACHADO RN14');

/** Status de uma etapa para o índice (✔ / ⚠ / ✖ / não executada). */
export function statusEtapa(e: EstadoEtapa | undefined): { tipo: SeloStatus; texto: string } {
  if (!e || e.status === 'nao_executada') return { tipo: 'skip', texto: 'NÃO EXECUTADA' };
  if (e.status === 'falha') return { tipo: 'fail', texto: '✖ FALHOU' };
  if (e.avisos.some(ehAchado)) return { tipo: 'warn', texto: '⚠ OK COM ACHADOS' };
  return { tipo: 'ok', texto: '✔ OK' };
}

// ---------------------------------------------------------------------------------------------
// Critérios de aceite (matriz CA × resultado)
// ---------------------------------------------------------------------------------------------

export interface DefinicaoCa {
  id: string;
  titulo: string;
  etapas: string[];
  /** Achados RN14 (nas etapas do CA) que tornam o CA parcial. */
  parcial?: RegExp;
  nota?: string;
}

export const CAS: DefinicaoCa[] = [
  {
    id: 'CA01',
    titulo: 'Município de demonstração gerado',
    etapas: ['E01', 'E01b', 'E01c', 'E02', 'E03', 'E06a', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E16'],
    parcial: /ENT-2|F-SEM-REF|permissão avulsa/,
  },
  { id: 'CA02', titulo: 'Geração bloqueada em produção', etapas: ['E00', 'E0'], nota: 'Trava dupla registrada nesta execução (ambiente local). A recusa com /api/environment = production foi provada no plano 03 (INT-002 e API real em production, sem registro criado).' },
  { id: 'CA02b', titulo: 'Falha ao identificar o ambiente', etapas: ['E00', 'E0'], nota: 'Mesma trava; recusa por timeout/erro provada no plano 03 (INT-003 e API fora do ar).' },
  { id: 'CA03', titulo: 'Não existe caminho pelo sistema', etapas: ['E20'] },
  { id: 'CA04', titulo: 'Mesma semente, mesmo resultado', etapas: ['E20'], nota: 'Exige duas execuções: npm run massa:comparar -- <A> <B> (resultado na seção Determinismo).' },
  { id: 'CA05', titulo: 'Números conferíveis à mão', etapas: ['E17'], parcial: /new_families_profile|perfis/ },
  { id: 'CA06', titulo: 'Casos que parecem erro estão presentes', etapas: ['E13', 'E17'], parcial: /CA06|new_families_profile/ },
  { id: 'CA07', titulo: 'Pendências propositais presentes', etapas: ['E05', 'E08', 'E17'], parcial: /CNEAS|F-SEM-REF|sem unidade/ },
  { id: 'CA08', titulo: 'Família acompanhada por duas unidades', etapas: ['E12', 'E17'] },
  { id: 'CA09', titulo: 'Encaminhamento sem desfecho concedendo acesso', etapas: ['E11', 'E20'] },
  { id: 'CA10', titulo: 'Pessoas atendidas sem CPF', etapas: ['E07', 'E10', 'E17'] },
  { id: 'CA11', titulo: 'Nenhum CPF de pessoa real', etapas: ['E07', 'E20'] },
  { id: 'CA12', titulo: 'Isolamento preservado', etapas: ['E20'], parcial: /CA12/ },
  { id: 'CA13', titulo: 'Documentação da massa', etapas: ['E20'] },
  { id: 'CA-T1', titulo: 'Preflight bloqueia antes de apagar', etapas: ['E00'], nota: 'Worker parado → ✖ no preflight: provado no plano 03 (INT-005 e docker stop real).' },
];

export interface ResultadoDeterminismo {
  a: string;
  b: string;
  identico: boolean;
  divergencias: number;
  em: string;
}

export function avaliarCa(ca: DefinicaoCa, estado: EstadoExecucao, determinismo?: ResultadoDeterminismo | null): { tipo: SeloStatus; texto: string; motivo: string } {
  const etapas = ca.etapas.map((id) => estado.etapas.find((e) => e.etapa === id));
  if (etapas.some((e) => e?.status === 'falha')) return { tipo: 'fail', texto: 'FALHOU', motivo: `etapa com falha: ${ca.etapas.filter((_, i) => etapas[i]?.status === 'falha').join(', ')}` };
  if (etapas.some((e) => !e || e.status === 'nao_executada')) return { tipo: 'skip', texto: 'NÃO EXECUTADA', motivo: `etapas não executadas: ${ca.etapas.filter((_, i) => !etapas[i] || etapas[i]?.status === 'nao_executada').join(', ')}` };
  if (ca.id === 'CA04') {
    if (!determinismo) return { tipo: 'warn', texto: 'AGUARDA COMPARAÇÃO', motivo: 'snapshot gravado; rode massa:comparar com outra execução' };
    return determinismo.identico
      ? { tipo: 'ok', texto: 'ATENDIDO', motivo: `idêntico a ${determinismo.a}` }
      : { tipo: 'fail', texto: 'DIVERGENTE', motivo: `${determinismo.divergencias} divergência(s) contra ${determinismo.a}` };
  }
  const achados = ca.parcial ? etapas.flatMap((e) => (e?.avisos ?? []).filter((a) => ehAchado(a) && ca.parcial!.test(a))) : [];
  if (achados.length) return { tipo: 'warn', texto: 'PARCIAL (RN14)', motivo: `${achados.length} achado(s) RN14 — ver Achados` };
  return { tipo: 'ok', texto: 'ATENDIDO', motivo: ca.nota ?? '' };
}

// ---------------------------------------------------------------------------------------------
// Conteúdo fixo (roadmap 08 e README do roadmap)
// ---------------------------------------------------------------------------------------------

export const CENARIOS_QUE_PARECEM_ERRO: Array<[string, string]> = [
  ['F-IDOSO no SCFV de adultos', 'Idoso de 60+ em serviço de adultos: gera "elderly_outside_range" e não incrementa nenhuma faixa etária (RN09).'],
  ['F-GRUPO em grupo PAIF', 'Família conta em "families_in_groups" com zero nas quatro faixas: a faixa é da pessoa no SCFV, não do grupo PAIF.'],
  ['Soma dos perfis > novas famílias', 'Uma família nova pode ter vários perfis (15.7), por isso a soma passa o total. Na massa manual, os perfis de renda, Bolsa Família e trabalho infantil só existem pela importação CadÚnico (achado RN14 da E17).'],
  ['F-DUPLA em duas unidades', 'Em PAIF no CRAS Norte e em PAEFI no CREAS no mesmo mês: é contada nas duas (CA08).'],
  ['F-ENC sem desfecho', 'Trânsito interno do CREAS (P4, código 14 — o catálogo só tem 13/14 CRAS↔CREAS) para o CRAS Sul, sem desfecho: P2, lotada só no CRAS Sul, abre o prontuário (CA09).'],
  ['Zero declarado', 'CREAS em 2026-06 sem nenhum registro: total_attendances = {value: 0, available: true} (RN09, decisão A3).'],
];

export const ONDE_APARECE: Record<string, string> = {
  family_without_reference_unit: 'Apuração › Pendências de cadastro (Organização) e fila "Famílias sem unidade de referência"',
  family_pending_specificity: 'Apuração › Pendências de cadastro (unidade) e fila "Especificidade pendente"',
  attended_person_without_cpf: 'Apuração › Pendências de cadastro (unidade × mês) e flag without_cpf das pessoas atendidas (A2)',
  member_without_schooling: 'Apuração › Pendências de cadastro e completude 15.10',
  entity_without_cneas: 'Apuração › Pendências de cadastro (Organização) e conferência prévia da remessa (NumeroCNEAS)',
};

export const ACHADOS_ROADMAP: Array<[string, string, string]> = [
  ['A1', 'CA07/RN10: as pendências de família eram filas próprias, fora da conferência prévia.', 'PO (2026-09-29): a apuração ganha a seção "Pendências de cadastro" (HU 10994b); a conferência prévia continua com a de CNEAS.'],
  ['A2', 'CA10: a completude 15.10 não verifica CPF.', 'PO: CA10 conferido pela flag without_cpf das pessoas atendidas no mês.'],
  ['A3', 'RN09: "contador indisponível" não é mais reproduzível.', 'PO: sai da RN09; fica só o zero declarado.'],
  ['A4', 'Leiautes 15.6–15.11 da remessa ainda são HeaderOnlyLayout.', 'Constatação técnica: os números se conferem na apuração (E17).'],
  ['A5', 'O Master é só leitura em unidades, entidades e pessoas.', 'Constatação técnica: o executor usa o Operacional por etapa.'],
  ['A6', 'ProfessionalService::create gera senha aleatória.', 'Constatação técnica: senha definida pelo link do e-mail (Mailpit).'],
  ['A7', 'Organização fictícia, mas camadas IBGE exigem município real.', 'PO: nome fictício + base geográfica Arapiraca/AL (2700300).'],
  ['A8', 'O qa/ não era submódulo registrado.', 'Constatação técnica: convertido em submódulo no plano 02.'],
];

export const DECISOES_PENDENTES: string[] = [
  'Decisão do PO pendente (10994b): a fila "especificidade pendente" também lista famílias SEM unidade, mas a apuração conta essas famílias só como "sem unidade de referência" (a mesma família não conta em duas linhas). Confirmar a leitura esperada.',
];

// ---------------------------------------------------------------------------------------------
// Tipos de entrada (insumos lidos soltos: o relatório só exibe)
// ---------------------------------------------------------------------------------------------

export interface ElencoRelatorio {
  versao: string;
  organizacao: { razao_social: string; cnpj: string; ibge: string; municipio: string; uf: string; master: { chave: string; nome: string } };
  unidades: Array<{ chave: string; nome: string; tipo: string }>;
  profissionais: Array<{ chave: string; nome: string; papel: string; add_ons: string[]; permissoes_extras: string[]; lotacoes: Array<{ unidade: string; desde: string }>; finalidade: string }>;
  pessoas: Array<{ cpf: string | null }>;
  familias: Array<{ chave: string; cenario: string; exibe: string; unidade_referencia: string | null }>;
  registros?: Array<{ tipo: string }>;
}

export interface ManifestExecucao {
  execucao: string;
  pasta: string;
  iniciada_em: string;
  concluida_em: string | null;
  ambiente: string | null;
  api: { base: string; versao: string | null };
  qa: { versao: string | null };
  elenco: { versao: string };
  insumos: { manifest_sha256: string | null };
  dne: { sha256: string | null } | null;
  flags: Record<string, unknown>;
  resultado: string;
}

export interface DadosRelatorio {
  estado: EstadoExecucao;
  evidencias: Record<string, EvidenciaEtapa>;
  elenco: ElencoRelatorio;
  esperado: Esperado;
  snapshot: Snapshot | null;
  manifest: ManifestExecucao;
  determinismo?: ResultadoDeterminismo | null;
}

// ---------------------------------------------------------------------------------------------
// Página de etapa
// ---------------------------------------------------------------------------------------------

function casDaEtapa(id: string): string {
  return CAS.filter((c) => c.etapas.includes(id)).map((c) => c.id).join(', ') || '—';
}

/** Valor curto e legível de um campo de passo. */
function valorCurto(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

export function renderizarEtapa(tpl: string, def: DefinicaoEtapa, e: EstadoEtapa | undefined, ev: EvidenciaEtapa | undefined, execucaoId: string): string {
  const st = statusEtapa(e);
  const passos = e?.passos ?? [];
  const http = passos.filter((p) => typeof p.metodo === 'string' && typeof p.uri === 'string');
  const outros = passos.filter((p) => !(typeof p.metodo === 'string' && typeof p.uri === 'string'));
  const requisicoes = tabela(
    ['#', 'Papel', 'Método', 'URI', 'HTTP', 'Chave de negócio'],
    http.map((p, i) => [td(i + 1, 'num'), td(p.papel), tdHtml(`<code>${h(p.metodo)}</code>`), tdHtml(`<code>${h(p.uri)}</code>`), td(p.status, 'num'), td(p.chave ?? '')]),
  );
  const passosHtml = tabela(
    ['#', 'Passo', 'Dados'],
    outros.map((p, i) => {
      const { passo, ...resto } = p;
      return [td(i + 1, 'num'), td(passo ?? ''), tdHtml(Object.entries(resto).map(([k, v]) => `<b>${h(k)}</b>: <code>${h(valorCurto(v))}</code>`).join('<br>'))];
    }),
  );
  const prints = ev?.prints.length
    ? ev.prints
        .map((p) => `<figure id="${h(p.ancora)}"><img src="${h(p.arquivo)}" alt="${h(p.legenda)}"><figcaption>${p.ca ? `${h(p.ca)} — ` : ''}${h(p.legenda)}</figcaption></figure>`)
        .join('\n')
    : '<p>Sem print nesta etapa (a evidência é o registro das requisições e das conferências).</p>';
  const contagens = tabela(
    ['Item', 'Esperado', 'Obtido', ''],
    (ev?.contagens ?? []).map((c) => [td(c.item), td(c.esperado ?? '—', 'num'), td(c.obtido ?? '—', 'num'), tdHtml(c.ok ? selo('ok', '=') : selo('fail', '≠'))]),
  );
  const avisos = [...(e?.avisos ?? []), ...(ev?.notas ?? []).map((n) => `nota: ${n}`)];
  const avisosHtml = avisos.length
    ? `<ul class="lista">${avisos.map((a) => `<li>${ehAchado(a) ? selo('warn', 'RN14') + ' ' : ''}${h(a)}</li>`).join('')}</ul>`
    : `<p>${e ? 'Nenhum aviso.' : 'Etapa não executada nesta execução.'}</p>`;
  return preencher(tpl, {
    titulo_pagina: `${def.id} — ${def.titulo}`,
    codigo: def.id,
    titulo: def.titulo,
    status_html: selo(st.tipo, st.texto),
    papel: e?.papel ?? '—',
    cas: casDaEtapa(def.id),
    duracao: duracao(e?.duracao ?? 0),
    execucao_id: execucaoId,
    requisicoes,
    passos: passosHtml,
    prints,
    contagens,
    avisos: avisosHtml,
  });
}

// ---------------------------------------------------------------------------------------------
// Índice
// ---------------------------------------------------------------------------------------------

function blocoDeterminismo(d: ResultadoDeterminismo | null | undefined): string {
  if (!d) return '<p>Snapshot gravado em <code>snapshot.json</code>. Determinismo: <b>aguarda comparação</b> — <code>npm run massa:comparar -- &lt;outra execução&gt; &lt;esta execução&gt;</code>.</p>';
  return `<p>Determinismo: ${d.identico ? selo('ok', 'IDÊNTICO') : selo('fail', `DIVERGENTE EM ${d.divergencias} ITEM(NS)`)} — comparado com <code>${h(d.a)}</code> em ${h(d.em)} (por chave de negócio, sem uuid/id/timestamps, incluindo a apuração).</p>`;
}

export function blocoDeterminismoHtml(d: ResultadoDeterminismo): string {
  return blocoDeterminismo(d);
}

function explicadasDaE17(estado: EstadoExecucao): Array<{ mes: string | null; unidade: string | null; contador: string; explicacao?: string }> {
  const e17 = estado.etapas.find((e) => e.etapa === 'E17');
  const p = e17?.passos.find((x) => x.passo === '17.3 esperado × apurado');
  return (p?.divergencias_explicadas as Array<{ mes: string | null; unidade: string | null; contador: string; explicacao?: string }>) ?? [];
}

export function renderizarIndice(tpl: string, d: DadosRelatorio): string {
  const { estado, elenco, esperado, snapshot, manifest } = d;
  const org = elenco.organizacao;
  const falhou = estado.etapas.some((e) => e.status === 'falha');
  const concluidas = estado.etapas.filter((e) => e.status === 'ok').length;

  const meta = `<div class="meta">
    <div><b>Data</b>${h(new Date(estado.iniciadaEm).toLocaleString('pt-BR'))}</div>
    <div><b>Ambiente (/api/environment)</b>${h(manifest.ambiente ?? '—')}</div>
    <div><b>API</b>${h(manifest.api.base)} · ${h(manifest.api.versao ?? 'versão desconhecida')}</div>
    <div><b>qa</b>${h(manifest.qa.versao ?? '—')}</div>
    <div><b>Elenco (semente)</b>${h(elenco.versao)}</div>
    <div><b>Meses de referência</b>${h(esperado.meses.join(' · '))}</div>
    <div><b>Flags</b>${h(Object.entries(manifest.flags).filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(' ') || '—')}</div>
    <div><b>Resultado</b>${falhou ? selo('fail', 'INTERROMPIDA') : selo('ok', `${concluidas} ETAPAS OK`)}</div>
  </div>`;

  const etapas = tabela(
    ['#', 'Etapa', 'Papel', 'Status', 'Duração', 'Evidência'],
    ETAPAS.map((def) => {
      const e = estado.etapas.find((x) => x.etapa === def.id);
      const st = statusEtapa(e);
      return [td(def.id), td(def.titulo), td(e?.papel ?? '—'), tdHtml(selo(st.tipo, st.texto)), td(duracao(e?.duracao ?? 0), 'num'), tdHtml(`<a href="${arquivoEtapa(def.id)}">abrir</a>`)];
    }),
  );

  const cas = tabela(
    ['CA', 'Critério', 'Resultado', 'Observação', 'Onde'],
    CAS.map((ca) => {
      const r = avaliarCa(ca, estado, d.determinismo);
      return [td(ca.id), td(ca.titulo), tdHtml(selo(r.tipo, r.texto)), td(r.motivo || ca.nota || ''), tdHtml(ca.etapas.slice(-3).map((id) => `<a href="${arquivoEtapa(id)}">${h(id)}</a>`).join(' · '))];
    }),
  );

  // Composição (CA13)
  const familiasPorUnidade = (u: string | null) => elenco.familias.filter((f) => f.unidade_referencia === u).length;
  const registrosPorTipo = new Map<string, number>();
  for (const r of elenco.registros ?? []) registrosPorTipo.set(r.tipo, (registrosPorTipo.get(r.tipo) ?? 0) + 1);
  const composicao =
    `<div class="meta"><div><b>Organização</b>${h(org.razao_social)}</div><div><b>CNPJ (base 98)</b>${h(org.cnpj)}</div><div><b>Município de apoio</b>${h(`${org.municipio}/${org.uf} (${org.ibge})`)}</div>` +
    `<div><b>Famílias</b>${elenco.familias.length}</div><div><b>Pessoas</b>${elenco.pessoas.length} (${elenco.pessoas.filter((p) => !p.cpf).length} sem CPF)</div>` +
    `<div><b>Registros</b>${h([...registrosPorTipo].map(([t, n]) => `${t} ${n}`).join(' · ') || '—')}</div></div>` +
    `<h3>Unidades</h3>${tabela(['Código', 'Nome', 'Tipo', 'Famílias de referência'], [
      ...elenco.unidades.map((u) => [td(u.chave), td(u.nome), td(u.tipo), td(familiasPorUnidade(u.chave), 'num')]),
      [td('—'), td('(sem unidade de referência)'), td('—'), td(familiasPorUnidade(null), 'num')],
    ])}` +
    `<h3>Equipe</h3>${tabela(['Código', 'Nome', 'Papel', 'Add-ons', 'Lotações', 'Finalidade'], [
      [td(org.master.chave), td(org.master.nome), td('master'), td('—'), td('—'), td('Master da organização')],
      ...elenco.profissionais.map((p) => [
        td(p.chave),
        td(p.nome),
        td(p.papel),
        td([...p.add_ons, ...p.permissoes_extras.map((x) => `${x} (permissão avulsa)`)].join(', ') || '—'),
        td(p.lotacoes.map((l) => `${l.unidade} desde ${l.desde}`).join('; ') || 'sem lotação'),
        td(p.finalidade),
      ]),
    ])}`;

  const cenarios =
    tabela(
      ['Família', 'Cenário', 'Unidade', 'O que exibe'],
      elenco.familias.filter((f) => f.cenario && f.cenario !== 'fundo').map((f) => [td(f.chave), td(f.cenario), td(f.unidade_referencia ?? '—'), td(f.exibe)]),
    ) +
    `<h3>Cenários que parecem erro</h3>${tabela(['Cenário', 'Explicação da regra'], CENARIOS_QUE_PARECEM_ERRO.map(([c, e]) => [td(c), td(e)]))}`;

  // Pendências propositais × apurado (snapshot)
  const apuradoPend = (kind: string, unidade: string | null, mes: string | null): number | null => {
    if (!snapshot) return null;
    const m = mes ?? esperado.meses.at(-1)!;
    return snapshot.pendencias.filter((p) => p.kind === kind && p.mes === m && (p.unidade ?? null) === unidade).reduce((s, p) => s + p.count, 0);
  };
  const pendencias = tabela(
    ['Pendência', 'Escopo', 'Unidade', 'Mês', 'Esperado', 'Apurado', '', 'Onde aparece no sistema'],
    esperado.pendencias.map((p) => {
      const ap = apuradoPend(p.kind, p.unidade, p.mes);
      return [
        td(p.kind),
        td(p.scope),
        td(p.unidade ?? 'Organização'),
        td(p.mes ?? 'situação atual'),
        td(p.valor, 'num'),
        td(ap ?? '—', 'num'),
        tdHtml(ap === null ? selo('skip', 'sem snapshot') : ap === p.valor ? selo('ok', '=') : selo('warn', '≠ (ver achados)')),
        td(ONDE_APARECE[p.kind] ?? ''),
      ];
    }),
  );

  // Esperado × apurado por mês × unidade
  const explicadas = explicadasDaE17(estado);
  const colunas = esperado.meses.flatMap((m) => esperado.unidades.map((u) => ({ m, u })));
  const contadores = [...new Set(esperado.contadores.map((c) => c.contador))];
  const valorEsperado = new Map(esperado.contadores.map((c) => [`${c.mes}|${c.unidade}|${c.contador}`, c.valor]));
  let iguais = 0;
  let diferentes = 0;
  let explicadasN = 0;
  const linhas = contadores.map((c) => [
    td(c),
    ...colunas.map(({ m, u }) => {
      const k = `${m}|${u}|${c}`;
      const esp = valorEsperado.get(k);
      if (esp === undefined) return td('—', 'num');
      const ap = snapshot ? (snapshot.apuracao[k] ?? (c.includes('.missing_fields.') ? 0 : undefined)) : undefined;
      if (ap === undefined) return td(snapshot ? `${esp} → ausente` : esp, snapshot ? 'num dif' : 'num');
      if (ap === esp) {
        iguais += 1;
        return td(esp, 'num');
      }
      const exp = explicadas.some((x) => x.mes === m && x.unidade === u && x.contador === c);
      if (exp) explicadasN += 1;
      else diferentes += 1;
      return td(`${esp} → ${ap}`, `num ${exp ? 'exp' : 'dif'}`);
    }),
  ]);
  const esperadoHtml =
    `<p>${snapshot ? `${iguais} valores iguais · ${explicadasN} divergências explicadas por achado RN14 (amarelo) · ${diferentes} divergências sem explicação (vermelho). Célula "esperado → apurado" quando difere.` : 'Sem snapshot nesta execução (E20 não concluída): a tabela mostra só o esperado.'}</p>` +
    `<details open><summary>Tabela completa (${contadores.length} contadores × ${colunas.length} mês/unidade)</summary>` +
    tabela(['Contador', ...colunas.map(({ m, u }) => `${m.slice(5)}/${u}`)], linhas, 'grid9') +
    '</details>';

  // Achados
  const rn14 = estado.etapas.flatMap((e) => e.avisos.filter(ehAchado).map((a) => [td(e.etapa), td(a.replace(/^ACHADO RN14:\s*/, ''))]));
  const outrosAvisos = estado.etapas.flatMap((e) => e.avisos.filter((a) => !ehAchado(a)).map((a) => [td(e.etapa), td(a)]));
  const achados =
    `<h3>Achados A1–A8 (roadmap) e decisões do PO</h3>${tabela(['#', 'Achado', 'Decisão / encaminhamento'], ACHADOS_ROADMAP.map(([a, t, dcs]) => [td(a), td(t), td(dcs)]))}` +
    `<h3>Achados RN14 desta execução (o produto recusa ou não aceita o dado)</h3>${rn14.length ? tabela(['Etapa', 'Achado'], rn14) : '<p>Nenhum.</p>'}` +
    `<h3>Decisões pendentes</h3><ul class="lista">${DECISOES_PENDENTES.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` +
    `<h3>Outros avisos e divergências novas</h3>${outrosAvisos.length ? tabela(['Etapa', 'Aviso'], outrosAvisos) : '<p>Nenhum.</p>'}`;

  return preencher(tpl, {
    titulo_pagina: `Massa de dados — execução ${estado.id}`,
    execucao_id: estado.id,
    organizacao: org.razao_social,
    meta,
    etapas,
    cas,
    determinismo: blocoDeterminismo(d.determinismo),
    composicao,
    cenarios,
    pendencias,
    esperado: esperadoHtml,
    achados,
  });
}

// ---------------------------------------------------------------------------------------------
// Segurança e escrita
// ---------------------------------------------------------------------------------------------

/** Padrões que NÃO podem aparecer num relatório (valores de segredo, não rótulos). */
const PADROES_SEGREDO: RegExp[] = [
  /"(?:[a-z_]*password[a-z_]*|[a-z_]*token[a-z_]*)"\s*:\s*"(?!\[redigido\])[^"]+"/i,
  /\b(?:XSRF-TOKEN|laravel_session|[a-z0-9_-]*_session)=(?!\[redigido\])[^;\s&<]+/i,
  /\bBearer\s+(?!\[redigido\])[A-Za-z0-9._~+/=-]{8,}/,
  /\bx-xsrf-token\s*[:=]\s*(?!\[redigido\])\S+/i,
];

export class SegredoNoRelatorio extends Error {}

export function verificarSemSegredos(texto: string, onde = 'relatório'): void {
  for (const p of PADROES_SEGREDO) {
    const m = texto.match(p);
    if (m) throw new SegredoNoRelatorio(`${onde}: padrão sensível encontrado (${p.source.slice(0, 30)}…); relatório não gravado.`);
  }
}

function gravar(caminho: string, conteudo: string): void {
  const limpo = sanitizar(conteudo);
  verificarSemSegredos(limpo, caminho);
  writeFileSync(caminho, limpo, 'utf8');
}

export function lerTemplates(pasta = PASTA_TEMPLATES): { etapa: string; indice: string } {
  return { etapa: readFileSync(resolve(pasta, 'etapa.html.tpl'), 'utf8'), indice: readFileSync(resolve(pasta, 'index.html.tpl'), 'utf8') };
}

/** Aplica `sanitizar()` em cada texto de uma estrutura (antes do escape HTML, que esconderia o padrão). */
export function sanitizarProfundo<T>(valor: T): T {
  const s = (v: unknown): unknown => {
    if (typeof v === 'string') return sanitizar(v);
    if (Array.isArray(v)) return v.map(s);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, s(x)]));
    return v;
  };
  return s(valor) as T;
}

/** Grava `etapa-XX.html` de TODAS as etapas, `index.html` e `manifest.json` na pasta. Devolve os arquivos. */
export function gerarRelatorio(pasta: string, entrada: DadosRelatorio, templates = lerTemplates()): string[] {
  const d: DadosRelatorio = { ...entrada, estado: sanitizarProfundo(entrada.estado), evidencias: sanitizarProfundo(entrada.evidencias) };
  const arquivos: string[] = [];
  for (const def of ETAPAS) {
    const nome = arquivoEtapa(def.id);
    gravar(resolve(pasta, nome), renderizarEtapa(templates.etapa, def, d.estado.etapas.find((e) => e.etapa === def.id), d.evidencias[def.id], d.estado.id));
    arquivos.push(nome);
  }
  gravar(resolve(pasta, 'index.html'), renderizarIndice(templates.indice, d));
  arquivos.push('index.html');
  gravar(resolve(pasta, 'manifest.json'), `${JSON.stringify(d.manifest, null, 2)}\n`);
  arquivos.push('manifest.json');
  return arquivos;
}

/** Substitui o bloco de determinismo de um `index.html` já gerado (usado por `massa:comparar`). */
export function atualizarDeterminismo(indexHtml: string, d: ResultadoDeterminismo): string {
  const novo = `<!--determinismo-->${blocoDeterminismo(d)}<!--/determinismo-->`;
  return indexHtml.replace(/<!--determinismo-->[\s\S]*?<!--\/determinismo-->/, novo);
}
