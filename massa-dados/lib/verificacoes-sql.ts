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

/** Palavras que tornam a instrução não-leitura (checagem defensiva, além do READ ONLY); inclui `pg_*backend` (CR-008). */
const PROIBIDAS = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|refresh|lock|set|reset|pg_\w*backend)\b/i;

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
  /** CA11: CPFs das pessoas das famílias da demo (`<null>` = NULL; psql -A imprime NULL vazio); prefixo e DV em TS. */
  cpfsDasFamilias: (cnpjDemo: string) =>
    `SELECT coalesce(p.cpf, '<null>') FROM persons p JOIN family_members fm ON fm.person_id = p.id AND fm.deleted_at IS NULL ` +
    `JOIN families f ON f.id = fm.family_id JOIN tenants t ON t.id = f.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} ORDER BY p.id`,
  /** CA11: pessoas sem CPF gravadas como string vazia (esperado 0). */
  cpfVazio: (cnpjDemo: string) =>
    `SELECT count(*) FROM persons p JOIN family_members fm ON fm.person_id = p.id AND fm.deleted_at IS NULL JOIN families f ON f.id = fm.family_id ` +
    `JOIN tenants t ON t.id = f.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} AND p.cpf = ''`,
  /** RN02b: e-mails de usuários vinculados à demo fora de @demo.sigsuas.local (esperado 0). */
  emailsForaDoDominio: (cnpjDemo: string) =>
    `SELECT count(DISTINCT u.id) FROM users u JOIN user_tenant_role utr ON utr.user_id = u.id AND utr.deleted_at IS NULL ` +
    `JOIN tenants t ON t.id = utr.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} AND u.email NOT LIKE '%@demo.sigsuas.local'`,
  /** CA12: famílias da demo com unidade de referência de OUTRO tenant (esperado 0). */
  familiasComUnidadeDeOutroTenant: (cnpjDemo: string) =>
    `SELECT count(*) FROM families f JOIN tenants t ON t.id = f.tenant_id JOIN social_units su ON su.id = f.social_unit_id ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND su.tenant_id <> f.tenant_id`,
  /** CA01: unidades da demo sem geometria ativa no endereço (esperado 0). */
  unidadesSemGeometria: (cnpjDemo: string) =>
    `SELECT count(*) FROM social_units su JOIN tenants t ON t.id = su.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} AND su.deleted_at IS NULL ` +
    `AND NOT EXISTS (SELECT 1 FROM addresses_geometries g WHERE g.address_id = su.address_id AND g.is_active)`,
  /** E8: famílias com prontuário por unidade de referência (nome da unidade | total). */
  familiasPorUnidade: (cnpjDemo: string) =>
    `SELECT su.name, count(*) FROM families f JOIN tenants t ON t.id = f.tenant_id JOIN social_units su ON su.id = f.social_unit_id ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND f.deleted_at IS NULL GROUP BY su.name`,
  /** E8: `referenced_at` (data) das famílias com unidade. */
  datasDeReferencia: (cnpjDemo: string) =>
    `SELECT to_char(f.referenced_at, 'YYYY-MM-DD') FROM families f JOIN tenants t ON t.id = f.tenant_id ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND f.deleted_at IS NULL AND f.social_unit_id IS NOT NULL`,
  /** E8: integrantes ativos (inclui o responsável) nas famílias da demo. */
  totalDeIntegrantes: (cnpjDemo: string) =>
    `SELECT count(*) FROM family_members fm JOIN families f ON f.id = fm.family_id JOIN tenants t ON t.id = f.tenant_id ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND fm.deleted_at IS NULL AND f.deleted_at IS NULL`,
  /** E8/RN10: famílias da demo sem especificidade CONFIRMADA. */
  semEspecificidadeConfirmada: (cnpjDemo: string) =>
    `SELECT count(*) FROM families f JOIN tenants t ON t.id = f.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} AND f.deleted_at IS NULL ` +
    `AND NOT EXISTS (SELECT 1 FROM family_social_specificities s WHERE s.family_id = f.id AND s.deleted_at IS NULL AND s.confirmed_at IS NOT NULL)`,
  /** E9/RN10: uuid das famílias da demo sem condições habitacionais. */
  familiasSemHabitacao: (cnpjDemo: string) =>
    `SELECT f.uuid FROM families f JOIN tenants t ON t.id = f.tenant_id WHERE t.cnpj = ${cnpj(cnpjDemo)} AND f.deleted_at IS NULL ` +
    `AND NOT EXISTS (SELECT 1 FROM family_housing_conditions h WHERE h.family_id = f.id AND h.deleted_at IS NULL AND h.residence_type_id IS NOT NULL)`,
  /** E9/RN10: uuid das PESSOAS integrantes sem escolaridade (sem linha de condições ou nível nulo). */
  integrantesSemEscolaridade: (cnpjDemo: string) =>
    `SELECT p.uuid FROM family_members fm JOIN persons p ON p.id = fm.person_id JOIN families f ON f.id = fm.family_id ` +
    `JOIN tenants t ON t.id = f.tenant_id LEFT JOIN family_member_conditions c ON c.family_member_id = fm.id AND c.deleted_at IS NULL ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND fm.deleted_at IS NULL AND c.schooling_level_id IS NULL`,
  /** CA12: lotações da demo em unidade de outro tenant (esperado 0). */
  lotacoesEmOutroTenant: (cnpjDemo: string) =>
    `SELECT count(*) FROM social_tenant_professional_assignments a JOIN tenant_professionals tp ON tp.id = a.tenant_professional_id ` +
    `JOIN tenants t ON t.id = tp.tenant_id JOIN social_units su ON su.id = a.social_unit_id ` +
    `WHERE t.cnpj = ${cnpj(cnpjDemo)} AND su.tenant_id <> tp.tenant_id`,
};
