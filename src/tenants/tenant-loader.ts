import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { z } from 'zod';
import { env } from '../config/env';
import {
  CompanySchema,
  DepartmentsSchema,
  PersonalitySchema,
  RoutingSchema,
  WorkflowsSchema,
  type TenantConfig,
  type ValidationIssue,
} from './config-schema';

export class TenantNotFoundError extends Error {
  constructor(public readonly tenantId: string) {
    super(`No existe onboarding para el tenant "${tenantId}" en ${env.ONBOARDING_DIR}`);
    this.name = 'TenantNotFoundError';
  }
}

export class TenantConfigError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly issues: ValidationIssue[],
  ) {
    const body = issues.map((i) => `  [${i.severity}] ${i.file} ${i.path}: ${i.message}`).join('\n');
    super(`Configuración inválida para "${tenantId}":\n${body}`);
    this.name = 'TenantConfigError';
  }
}

export function tenantDir(tenantId: string): string {
  return path.join(env.ONBOARDING_DIR, tenantId);
}

export function tenantExists(tenantId: string): boolean {
  return fs.existsSync(path.join(tenantDir(tenantId), 'company.yaml'));
}

export function listTenants(): string[] {
  if (!fs.existsSync(env.ONBOARDING_DIR)) return [];
  return fs
    .readdirSync(env.ONBOARDING_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && tenantExists(d.name))
    .map((d) => d.name)
    .sort();
}

function readYaml(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return YAML.parse(text) ?? {};
  } catch (e) {
    throw new Error(`YAML mal formado en ${path.basename(file)}: ${(e as Error).message}`);
  }
}

function parseFile<T>(schema: z.ZodType<T>, file: string, issues: ValidationIssue[]): T | null {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    issues.push({ severity: 'ERROR', file: name, path: '', message: 'archivo faltante' });
    return null;
  }
  let doc: unknown;
  try {
    doc = readYaml(file);
  } catch (e) {
    issues.push({ severity: 'ERROR', file: name, path: '', message: (e as Error).message });
    return null;
  }
  const result = schema.safeParse(doc);
  if (!result.success) {
    for (const i of result.error.issues) {
      issues.push({
        severity: 'ERROR',
        file: name,
        path: i.path.join('.') || '(raíz)',
        message: i.message,
      });
    }
    return null;
  }
  return result.data;
}

/**
 * Carga y valida los cinco YAML del tenant. No consulta OpenAI ni la DB:
 * es puro parseo, para que los tests puedan ejercitarlo sin red.
 */
export function loadTenantConfig(tenantId: string): { config: TenantConfig | null; issues: ValidationIssue[] } {
  const dir = tenantDir(tenantId);
  const issues: ValidationIssue[] = [];

  if (!fs.existsSync(dir)) throw new TenantNotFoundError(tenantId);

  const company = parseFile(CompanySchema, path.join(dir, 'company.yaml'), issues);
  const personality = parseFile(PersonalitySchema, path.join(dir, 'personality.yaml'), issues);
  const departments = parseFile(DepartmentsSchema, path.join(dir, 'departments.yaml'), issues);
  const workflows = parseFile(WorkflowsSchema, path.join(dir, 'workflows.yaml'), issues);
  const routing = parseFile(RoutingSchema, path.join(dir, 'routing.yaml'), issues);

  if (!company || !personality || !departments || !workflows || !routing) {
    return { config: null, issues };
  }

  if (company.company.id !== tenantId) {
    issues.push({
      severity: 'ERROR',
      file: 'company.yaml',
      path: 'company.id',
      message: `debe ser "${tenantId}" (el nombre de la carpeta), no "${company.company.id}"`,
    });
    return { config: null, issues };
  }

  return {
    config: { tenantId, company, personality, departments, workflows, routing, dir },
    issues,
  };
}

/** Igual que `loadTenantConfig` pero lanza si hay errores. Uso en runtime. */
export function requireTenantConfig(tenantId: string): TenantConfig {
  const { config, issues } = loadTenantConfig(tenantId);
  const errors = issues.filter((i) => i.severity === 'ERROR');
  if (!config || errors.length > 0) throw new TenantConfigError(tenantId, errors);
  return config;
}

// ── Caché en proceso ─────────────────────────────────────────────────────────

const cache = new Map<string, { mtime: number; config: TenantConfig }>();

function dirMtime(dir: string): number {
  let latest = 0;
  for (const f of ['company.yaml', 'personality.yaml', 'departments.yaml', 'workflows.yaml', 'routing.yaml']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) latest = Math.max(latest, fs.statSync(p).mtimeMs);
  }
  return latest;
}

/** Versión cacheada con invalidación por mtime — el CLI de chat recarga en caliente. */
export function getTenantConfig(tenantId: string): TenantConfig {
  const dir = tenantDir(tenantId);
  const mtime = dirMtime(dir);
  const hit = cache.get(tenantId);
  if (hit && hit.mtime === mtime) return hit.config;
  const config = requireTenantConfig(tenantId);
  cache.set(tenantId, { mtime, config });
  return config;
}

export function clearTenantCache(): void {
  cache.clear();
}
