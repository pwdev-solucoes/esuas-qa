import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

/**
 * ADAPTADO PARA qa/ STANDALONE:
 *   - Carrega qa/.env.qa (não e2e/.env.e2e)
 *   - Docker compose aponta para qa/docker-compose.qa.yml (não meta-repo staging)
 */
const qaDir = path.resolve(__dirname, '..');
const envPath = path.join(qaDir, '.env.qa');
dotenv.config({ path: envPath });

/**
 * Comando default (stack E2E dedicada): limpa o cache via os containers do
 * docker-compose.qa.yml (não docker-compose-staging.yml, que é do meta-repo).
 * Sobrescrevível por env quando rodando contra outra stack (ex.: Sail dev →
 * E2E_CACHE_CLEAR_CMD no .env.qa).
 */
const DEFAULT_CACHE_CLEAR_CMD =
  'docker compose -f ../../docker-compose.qa.yml -f docker-compose-e2e.yml exec -T app php artisan cache:clear';

/**
 * Global setup: limpa o rate-limiter cache do Laravel antes de cada run.
 *
 * Por que: as rotas de auth têm `throttle:6,1` (6 req/min) hardcoded em
 * api/routes/api.php. Em iteração local rodando a suíte várias vezes em
 * sequência, o cache de rate limit se acumula entre runs e quebra o setup
 * (HTTP 429). Limpar o cache zera o contador a cada execução.
 *
 * O comando é configurável via `E2E_CACHE_CLEAR_CMD` para funcionar tanto na
 * stack E2E dedicada (default abaixo) quanto contra a stack de dev (Sail).
 * Em CI (fresh stack a cada run), é no-op efetivo, mas garante consistência.
 *
 * ADAPTAÇÃO qa/:
 *   - Path default aponta para qa/docker-compose.qa.yml
 *   - cwd é __dirname (qa/e2e/), então os paths começam com ../../ para subir a qa/
 */
async function globalSetup(): Promise<void> {
  const cmd = process.env.E2E_CACHE_CLEAR_CMD ?? DEFAULT_CACHE_CLEAR_CMD;
  try {
    execSync(cmd, { stdio: 'pipe', cwd: __dirname });
    console.log('[globalSetup] Rate-limiter cache do Laravel zerado.');
  } catch (err) {
    console.warn('[globalSetup] cache:clear falhou (stack offline?). Continuando.', err);
  }
}

export default globalSetup;
