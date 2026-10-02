/**
 * E10 — Atendimentos (#10994 · roadmap 06/E10, BR-001, BR-002, BR-009, AC-001, AC-007).
 * Cada atendimento do elenco é registrado pelo profissional lotado na unidade na data do fato
 * (P1–P4), com os integrantes atendidos — inclusive pessoas SEM CPF (F-SEM-CPF, CA10).
 * Zero declarado (RN09): o CREAS (U-CE) não tem nenhum registro em 2026-06; a etapa só confere que o
 * elenco não traz nada ali (o valor 0 com `available:true` é conferido na E17).
 * Atividade coletiva em lote (`attendances/batch`): o elenco não tem atendimento sem pessoa
 * identificada (esperado `without_identified_person` = 0), e o lote proíbe `people`; por isso a
 * etapa não usa o lote — ver plan.done.md (desvio documentado).
 */
import { expect } from '@playwright/test';
import { Evidencia } from '../lib/evidencia.ts';
import { etapa, senhaMassa } from '../lib/papeis.ts';
import { registrarTodos, registrosDoElenco } from '../lib/registros.ts';
import { consultar } from '../lib/verificacoes-sql.ts';

etapa('E10', 'Atendimentos (com pessoas sem CPF) e zero declarado', 'P1–P4', async (ctx) => {
  const atendimentos = registrosDoElenco('attendance');
  expect(atendimentos.filter((r) => r.unidade === 'U-CE' && r.data_fato.startsWith('2026-06')), 'U-CE/2026-06 sem atendimento (zero declarado, RN09)').toHaveLength(0);
  const ex = await registrarTodos(ctx, 'attendance');
  const r = ex.resumo().attendance ?? { criados: 0, pulados: 0 };
  expect(r.criados + r.pulados).toBe(atendimentos.length);
  ctx.log(`  E10: ${r.criados} atendimentos criados, ${r.pulados} já existentes`);

  // Evidência (padrão do plano 06, repetido nas etapas instrumentadas): contagens conferidas + print
  // com nome e legenda estáveis. Sem --evidencias nada vai para o disco.
  const ev = new Evidencia('E10');
  ev.contagem('Atendimentos do elenco registrados (criados + já existentes)', atendimentos.length, r.criados + r.pulados);
  const cnpj = ctx.elenco.organizacao.cnpj.replace(/\D/g, '');
  const gravados = consultar(
    ctx.cfg,
    `SELECT count(DISTINCT a.id) FILTER (WHERE true), count(DISTINCT a.id) FILTER (WHERE p.cpf IS NULL) FROM attendances a LEFT JOIN attendance_people ap ON ap.attendance_id = a.id AND ap.deleted_at IS NULL ` +
      `LEFT JOIN persons p ON p.id = ap.person_id WHERE a.tenant_id = (SELECT id FROM tenants WHERE cnpj = '${cnpj}') AND a.deleted_at IS NULL AND a.status <> 'cancelled'`,
  )[0] ?? [];
  ev.contagem('Atendimentos gravados no banco (SQL)', atendimentos.length, Number(gravados[0]));
  const semCpf = new Set(ctx.elenco.pessoas.filter((p) => !p.cpf).map((p) => p.chave));
  const comPessoaSemCpf = atendimentos.filter((a) => ((a.payload.pessoas as string[] | undefined) ?? []).some((p) => semCpf.has(p))).length;
  ev.contagem('Atendimentos com pessoa sem CPF (CA10): elenco × banco', comPessoaSemCpf, Number(gravados[1]));
  ev.contagem('U-CE · 2026-06 sem atendimento (zero declarado, RN09)', 0, atendimentos.filter((a) => a.unidade === 'U-CE' && a.data_fato.startsWith('2026-06')).length);
  await ev.print({
    cfg: ctx.cfg,
    cpf: ctx.elenco.profissionais.find((p) => p.chave === 'P2')!.cpf,
    senha: senhaMassa(ctx.cfg),
    rota: `/app/cadastros/familias/${ctx.chaves.obter('FAM_F-SEM-CPF')}`,
    nome: 'e10-01-prontuario-f-sem-cpf',
    legenda: 'Prontuário de F-SEM-CPF (CRAS Sul) aberto por P2: família com integrantes sem CPF atendidos no mês (CA10).',
    ca: 'CA10',
  });
  ev.salvar();
});
