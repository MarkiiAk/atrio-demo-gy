import type { TenantConfig, WorkflowConfig } from '../tenants/config-schema';
import { isTodo } from '../tenants/config-schema';
import type { Intent } from '../types/domain';

export interface ResolvedWorkflow {
  key: string;
  config: WorkflowConfig;
}

/**
 * Intent → workflow. Determinista: recorre los workflows en el orden en que el
 * tenant los declaró y toma el primero habilitado que reclame ese intent.
 * Si dos workflows reclaman el mismo intent, el validador ya lo advirtió.
 */
export function workflowForIntent(config: TenantConfig, intent: Intent): ResolvedWorkflow | null {
  for (const [key, wf] of Object.entries(config.workflows.workflows)) {
    if (!wf.enabled) continue;
    if (wf.intents.includes(intent)) return { key, config: wf };
  }
  return null;
}

export function getWorkflow(config: TenantConfig, key: string): ResolvedWorkflow | null {
  const wf = config.workflows.workflows[key];
  return wf ? { key, config: wf } : null;
}

export function enabledWorkflows(config: TenantConfig): ResolvedWorkflow[] {
  return Object.entries(config.workflows.workflows)
    .filter(([, wf]) => wf.enabled)
    .map(([key, wf]) => ({ key, config: wf }));
}

/** Todos los intents que el tenant sabe convertir en caso. */
export function routableIntents(config: TenantConfig): Intent[] {
  const out = new Set<Intent>();
  for (const wf of enabledWorkflows(config)) {
    for (const i of wf.config.intents) out.add(i);
  }
  return [...out];
}

export function departmentName(config: TenantConfig, key: string | null): string {
  if (!key) return '';
  return config.departments.departments[key]?.name ?? key;
}

/** Etiqueta legible de un campo, o la clave técnica si el tenant no la definió. */
export function fieldLabel(wf: WorkflowConfig, field: string): string {
  const label = wf.field_labels[field];
  return label && !isTodo(label) ? label : field;
}

export function toneFor(config: TenantConfig, workflowKey: string | null): string[] {
  if (workflowKey && config.personality.tones[workflowKey]) {
    return config.personality.tones[workflowKey];
  }
  return config.personality.base.style;
}
