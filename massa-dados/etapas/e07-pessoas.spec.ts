/**
 * E7 — Pessoas (#10994 · roadmap 05/E7, CA11, RN06, RN07, BR-009). Papel: Operacional P0.
 * Para cada pessoa do elenco: checagem de duplicidade (7.1) e cadastro no repositório global (7.2),
 * com CPF da faixa 98 ou SEM CPF (campo omitido → gravado NULL). Pessoa é global e não excluível:
 * qualquer erro exige recriar a base (E0).
 */
import { expect } from '@playwright/test';
import { comRetentativa429, dados, etapa, idDoLookup } from '../lib/papeis.ts';

etapa('E07', 'Pessoas (faixa 98 e sem CPF)', 'P0', async (ctx) => {
  const p0 = await ctx.sessoes.entrar('P0');
  const sexos = new Map<string, number>();
  for (const codigo of new Set(ctx.elenco.pessoas.map((p) => p.sexo))) sexos.set(codigo, await idDoLookup(p0, '/api/relationals/sexes', codigo));
  let semCpf = 0;
  let duplicidades = 0;
  for (const p of ctx.elenco.pessoas) {
    ctx.chaveAtual = p.chave;
    if (p.cpf) expect(p.cpf.startsWith('98'), `${p.chave} fora da faixa 98`).toBe(true);
    const dup = dados<unknown[]>(
      (await comRetentativa429(ctx, () => p0.post('/api/client/persons/check-duplicates', { full_name: p.nome, birth_date: p.nascimento }))).corpo,
    );
    const semelhantes = Array.isArray(dup) ? dup.length : 0;
    if (semelhantes) duplicidades += 1;
    const corpo: Record<string, unknown> = { full_name: p.nome, birth_date: p.nascimento, mother_name: p.nome_mae, sex_id: sexos.get(p.sexo) };
    if (p.cpf) corpo.cpf = p.cpf;
    else semCpf += 1;
    if (semelhantes) corpo.duplicate_confirmed = true;
    const pessoa = dados<{ uuid: string }>((await comRetentativa429(ctx, () => p0.post('/api/client/persons', corpo))).corpo);
    ctx.chaves.definir(`PES_${p.chave}`, pessoa.uuid);
  }
  ctx.chaveAtual = null;
  ctx.registro.passo({ passo: '7.1/7.2 pessoas', total: ctx.elenco.pessoas.length, sem_cpf: semCpf, com_semelhantes: duplicidades });
});
