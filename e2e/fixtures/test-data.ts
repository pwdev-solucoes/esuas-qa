import { generateCpf } from '../helpers/cpf';

/**
 * Sufixo único por worker para evitar colisão de dados entre suites paralelas
 * sem precisar truncar o banco entre testes.
 */
export function uniqueSuffix(workerIndex: number): string {
  return `e2e-${Date.now()}-w${workerIndex}-${Math.floor(Math.random() * 1000)}`;
}

export interface NewTenantPayload {
  name: string;
  document: string;
  email: string;
}

export function makeTenant(workerIndex: number): NewTenantPayload {
  const suffix = uniqueSuffix(workerIndex);

  return {
    name: `Tenant ${suffix}`,
    document: generateCpf(),
    email: `${suffix}@e2e.local`,
  };
}

export interface NewUserPayload {
  cpf: string;
  full_name: string;
  email: string;
  password: string;
}

export function makeUser(workerIndex: number): NewUserPayload {
  const suffix = uniqueSuffix(workerIndex);

  return {
    cpf: generateCpf(),
    full_name: `Usuário ${suffix}`,
    email: `${suffix}@e2e.local`,
    password: 'Senha@E2E#2026',
  };
}
