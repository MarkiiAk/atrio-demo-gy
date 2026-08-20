import * as fs from 'fs';
import * as path from 'path';
import type { AppMode } from '../config/env';
import { INTENTS, type Intent } from '../types/domain';
import { isTodo, TODO_SENTINEL, type TenantConfig, type ValidationIssue } from './config-schema';

/**
 * Validación semántica cruzada entre archivos. El parseo por-archivo ya lo hizo
 * Zod en el loader; aquí verificamos lo que sólo se puede saber viendo el conjunto:
 * departamentos que no existen, intents huérfanos, routing faltante, TODOs.
 */
export function validateTenant(config: TenantConfig, mode: AppMode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const deptKeys = new Set(Object.keys(config.departments.departments));
  const routeKeys = new Set(Object.keys(config.routing.routing));

  // ── workflows → departments / routing ──────────────────────────────────────
  const seenIntents = new Map<Intent, string[]>();

  for (const [wfKey, wf] of Object.entries(config.workflows.workflows)) {
    const where = `workflows.${wfKey}`;

    if (!deptKeys.has(wf.department)) {
      issues.push({
        severity: 'ERROR',
        file: 'workflows.yaml',
        path: `${where}.department`,
        message: `"${wf.department}" no existe en departments.yaml`,
      });
    } else if (!routeKeys.has(wf.department) && !config.routing.fallback) {
      issues.push({
        severity: wf.enabled && mode === 'production' ? 'ERROR' : 'WARNING',
        file: 'routing.yaml',
        path: `routing.${wf.department}`,
        message: `el workflow ${wfKey} apunta a ${wf.department}, que no tiene destino de canalización ni existe un fallback`,
      });
    }

    for (const intent of wf.intents) {
      const owners = seenIntents.get(intent) ?? [];
      owners.push(wfKey);
      seenIntents.set(intent, owners);
    }

    // Campos: sin duplicados entre niveles y con etiqueta legible.
    const all = [...wf.fields.essential, ...wf.fields.useful, ...wf.fields.optional];
    const dupes = all.filter((f, i) => all.indexOf(f) !== i);
    for (const d of new Set(dupes)) {
      issues.push({
        severity: 'ERROR',
        file: 'workflows.yaml',
        path: `${where}.fields`,
        message: `el campo "${d}" está declarado en más de un nivel (essential/useful/optional)`,
      });
    }
    for (const f of all) {
      if (!wf.field_labels[f]) {
        issues.push({
          severity: 'WARNING',
          file: 'workflows.yaml',
          path: `${where}.field_labels.${f}`,
          message: 'sin etiqueta legible; el asistente preguntará usando la clave técnica',
        });
      }
    }
    if (wf.enabled && wf.fields.essential.length === 0 && wf.strategy !== 'answer_then_optional_route') {
      issues.push({
        severity: 'WARNING',
        file: 'workflows.yaml',
        path: `${where}.fields.essential`,
        message:
          'workflow habilitado sin campos esenciales: nunca canalizará. Define al menos uno, o usa strategy: answer_then_optional_route si es puramente informativo',
      });
    }
  }

  for (const [intent, owners] of seenIntents) {
    if (owners.length > 1) {
      issues.push({
        severity: 'WARNING',
        file: 'workflows.yaml',
        path: `intents.${intent}`,
        message: `atendido por varios workflows (${owners.join(', ')}); se usará el primero declarado`,
      });
    }
  }

  const uncovered = INTENTS.filter(
    (i) => i !== 'UNKNOWN' && !seenIntents.has(i),
  );
  if (uncovered.length > 0) {
    issues.push({
      severity: 'WARNING',
      file: 'workflows.yaml',
      path: 'intents',
      message: `sin workflow: ${uncovered.join(', ')} (se tratarán como conversación informativa)`,
    });
  }

  // ── routing → departments ──────────────────────────────────────────────────
  for (const [dept, target] of Object.entries(config.routing.routing)) {
    if (!deptKeys.has(dept)) {
      issues.push({
        severity: 'ERROR',
        file: 'routing.yaml',
        path: `routing.${dept}`,
        message: `"${dept}" no existe en departments.yaml`,
      });
    }
    if (target.type === 'EMAIL' && target.to.filter((t) => !isTodo(t)).length === 0) {
      issues.push({
        severity: mode === 'production' ? 'ERROR' : 'WARNING',
        file: 'routing.yaml',
        path: `routing.${dept}.to`,
        message: 'destino EMAIL sin destinatarios reales',
      });
    }
    if (target.type === 'WHATSAPP' && target.to.filter((t) => !isTodo(t)).length === 0) {
      issues.push({
        severity: mode === 'production' ? 'ERROR' : 'WARNING',
        file: 'routing.yaml',
        path: `routing.${dept}.to`,
        message: 'destino WHATSAPP sin números responsables',
      });
    }
    if (target.type === 'WEBHOOK' && (!target.url || isTodo(target.url))) {
      issues.push({
        severity: mode === 'production' ? 'ERROR' : 'WARNING',
        file: 'routing.yaml',
        path: `routing.${dept}.url`,
        message: 'destino WEBHOOK sin URL real',
      });
    }
    if (target.type === 'LOG' && target.confirmation_semantics === 'DELIVERED_TO_TEAM') {
      issues.push({
        severity: 'ERROR',
        file: 'routing.yaml',
        path: `routing.${dept}.confirmation_semantics`,
        message:
          'un adapter LOG no entrega nada a nadie; confirmar "DELIVERED_TO_TEAM" haría que el asistente mienta al cliente',
      });
    }
    if (['CRM', 'HUMAN_INBOX'].includes(target.type)) {
      issues.push({
        severity: mode === 'production' ? 'ERROR' : 'WARNING',
        file: 'routing.yaml',
        path: `routing.${dept}.type`,
        message: `adapter ${target.type} declarado pero no implementado en esta versión; caerá a LOG`,
      });
    }
  }

  // ── personality → workflows ────────────────────────────────────────────────
  for (const wfKey of Object.keys(config.personality.tones)) {
    if (!config.workflows.workflows[wfKey]) {
      issues.push({
        severity: 'WARNING',
        file: 'personality.yaml',
        path: `tones.${wfKey}`,
        message: 'tono declarado para un workflow que no existe',
      });
    }
  }
  for (const [wfKey, wf] of Object.entries(config.workflows.workflows)) {
    if (wf.enabled && !config.personality.tones[wfKey]) {
      issues.push({
        severity: 'WARNING',
        file: 'personality.yaml',
        path: `tones.${wfKey}`,
        message: 'sin tono específico; se usará el estilo base',
      });
    }
  }

  // ── TODOs pendientes de onboarding ─────────────────────────────────────────
  issues.push(...findTodos(config, mode));

  // ── knowledge ──────────────────────────────────────────────────────────────
  for (const sub of ['public', 'customer-safe']) {
    const dir = path.join(config.dir, 'knowledge', sub);
    if (!fs.existsSync(dir)) {
      issues.push({
        severity: 'WARNING',
        file: `knowledge/${sub}/`,
        path: '',
        message: 'carpeta faltante',
      });
    }
  }

  if (config.company.channels.whatsapp.enabled && !config.company.company.website) {
    issues.push({
      severity: 'WARNING',
      file: 'company.yaml',
      path: 'company.website',
      message: 'sin sitio web: no se podrá sincronizar knowledge público automáticamente',
    });
  }

  return issues;
}

/**
 * Recorre el árbol de configuración buscando el sentinel de onboarding.
 * En production un TODO dentro de un workflow habilitado es error de arranque.
 */
export function findTodos(config: TenantConfig, mode: AppMode): ValidationIssue[] {
  const out: ValidationIssue[] = [];

  const walk = (node: unknown, file: string, trail: string[], critical: boolean): void => {
    if (isTodo(node)) {
      out.push({
        severity: critical && mode === 'production' ? 'ERROR' : 'WARNING',
        file,
        path: trail.join('.') || '(raíz)',
        message: `pendiente de onboarding (${TODO_SENTINEL})`,
      });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, file, [...trail, String(i)], critical));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, file, [...trail, k], critical);
      }
    }
  };

  walk(config.company, 'company.yaml', [], true);
  walk(config.personality, 'personality.yaml', [], false);
  walk(config.departments, 'departments.yaml', [], false);

  for (const [wfKey, wf] of Object.entries(config.workflows.workflows)) {
    walk(wf, 'workflows.yaml', ['workflows', wfKey], wf.enabled);
  }
  for (const [dept, target] of Object.entries(config.routing.routing)) {
    const usedByEnabled = Object.values(config.workflows.workflows).some(
      (wf) => wf.enabled && wf.department === dept,
    );
    walk(target, 'routing.yaml', ['routing', dept], usedByEnabled);
  }

  return out;
}

export function summarizeIssues(issues: ValidationIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((i) => i.severity === 'ERROR').length,
    warnings: issues.filter((i) => i.severity === 'WARNING').length,
  };
}
