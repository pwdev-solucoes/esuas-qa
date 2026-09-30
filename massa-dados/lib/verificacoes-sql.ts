/**
 * Consultas SOMENTE LEITURA ao banco da stack local (#10994 · spec §8, CA11, CA12, RN02b).
 *
 * Nenhuma escrita passa por aqui (RN14): `consultar()` recusa qualquer SQL que não seja uma única
 * instrução SELECT/WITH e roda num `BEGIN READ ONLY` via `docker exec` no container do banco listado
 * em `MASSA_DOCKER_CONTAINERS`. Usuário/base vêm de dentro do container (`POSTGRES_USER/DB`), sem ler
 * nem imprimir valores.
 */
import { PADRAO_BANCO } from './preflight.ts';
import { executorPadrao, type ConfigMassa, type Executor } from './config.ts';

/** Palavras que tornam a instrução não-leitura (checagem defensiva, além do READ ONLY). */
const PROIBIDAS = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|refresh|lock|set|reset)\b/i;

export class ConsultaRecusada extends Error {
  constructor(motivo: string) {
    super(`Consulta SQL recusada (somente leitura): ${motivo}`);
    this.name = 'ConsultaRecusada';
  }
}

/** Valida que `sql` é uma única instrução de leitura. Lança `ConsultaRecusada`. */
export function validarSomenteLeitura(sql: string): string {
  const limpo = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(limpo)) throw new ConsultaRecusada('só SELECT/WITH');
  if (limpo.includes(';')) throw new ConsultaRecusada('uma instrução por vez');
  const semLiterais = limpo.replace(/'(?:[^']|'')*'/g, "''");
  const achado = semLiterais.match(PROIBIDAS);
  if (achado) throw new ConsultaRecusada(`palavra não permitida "${achado[0]}"`);
  return limpo;
}

export function containerBanco(cfg: ConfigMassa): string {
  const banco = cfg.containers.find((c) => PADRAO_BANCO.test(c));
  if (!banco) throw new Error('Nenhum container de banco em MASSA_DOCKER_CONTAINERS (esperado nome com pgsql/postgres).');
  return banco;
}

/** Executa a consulta e devolve as linhas (colunas separadas por `|`). */
export function consultar(cfg: ConfigMassa, sql: string, executor: Executor = executorPadrao): string[][] {
  const instrucao = validarSomenteLeitura(sql);
  const script =
    'printf "%s\\n" "BEGIN READ ONLY;" "$1;" "ROLLBACK;" | ' +
    'psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -At -F "|"';
  const r = executor.programa('docker', ['exec', '-i', containerBanco(cfg), 'sh', '-c', script, 'sh', instrucao], { timeoutMs: 60_000 });
  if (r.codigo !== 0) throw new Error(`psql saiu com código ${r.codigo}: ${r.erro.slice(0, 300)}`);
  return r.saida
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && l !== 'BEGIN' && l !== 'ROLLBACK')
    .map((l) => l.split('|'));
}

/** Um único valor escalar (1ª coluna da 1ª linha). */
export function escalar(cfg: ConfigMassa, sql: string, executor?: Executor): string | null {
  return consultar(cfg, sql, executor)[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Verificações da spec §8 (parametrizadas pelo CNPJ da organização demo, nunca por id)
// ---------------------------------------------------------------------------------------------

const cnpj = (v: string) => `'${v.replace(/\D/g, '')}'`;

export const SQL = {
  /** CA11: CPFs das pessoas das famílias da demo (vazio = NULL); prefixo 98 e DV conferidos em TS. */
  cpfsDasFamilias: (cnpjDemo: string) =>
    `SELECT p.cpf FROM persons p JOIN family_members fm ON fm.person_id = p.id AND fm.deleted_at IS NULL ` +
    `JOIN families f ON f.id = fm.family_id JOIN tenants t ON t.id = f.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} ORDER BY p.id`,
  /** CA11: pessoas sem CPF gravadas como string vazia (esperado 0). */
  cpfVazio: (cnpjDemo: string) =>
    `SELECT count(*) FROM persons p JOIN family_members fm ON fm.person_id = p.id JOIN families f ON f.id = fm.family_id ` +
    `JOIN tenants t ON t.id = f.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} AND p.cpf = ''`,
  /** RN02b: e-mails de usuários vinculados à demo fora de @demo.sigsuas.local (esperado 0). */
  emailsForaDoDominio: (cnpjDemo: string) =>
    `SELECT count(DISTINCT u.id) FROM users u JOIN user_tenant_role utr ON utr.user_id = u.id AND utr.deleted_at IS NULL ` +
    `JOIN tenants t ON t.id = utr.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} AND u.email NOT LIKE '%@demo.sigsuas.local'`,
  /** CA12: famílias da demo com unidade de referência de OUTRO tenant (esperado 0). */
  familiasComUnidadeDeOutroTenant: (cnpjDemo: string) =>
    `SELECT count(*) FROM families f JOIN tenants t ON t.id = f.tenant_id JOIN social_units su ON su.id = f.social_unit_id ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND su.tenant_id <> f.tenant_id`,
  /** CA12: lotações da demo em unidade de outro tenant (esperado 0). */
  lotacoesEmOutroTenant: (cnpjDemo: string) =>
    `SELECT count(*) FROM social_tenant_professional_assignments a JOIN tenant_professionals tp ON tp.id = a.tenant_professional_id ` +
    `JOIN tenants t ON t.id = tp.tenant_id JOIN social_units su ON su.id = a.social_unit_id ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND su.tenant_id <> tp.tenant_id`,
};
