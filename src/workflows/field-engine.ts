import type { WorkflowConfig } from '../tenants/config-schema';

export type FieldMap = Record<string, string>;

/** Datos que el canal aporta gratis (WhatsApp ya trae teléfono y nombre de perfil). */
export interface ChannelContext {
  channel: string;
  phone?: string | null;
  profileName?: string | null;
}

const EMPTYISH = new Set([
  '',
  '-',
  'n/a',
  'na',
  'null',
  'undefined',
  'none',
  'no aplica',
  'no se',
  'no sé',
  'desconocido',
  'tbd',
  'pendiente',
]);

/** Un valor extraído sólo cuenta si realmente dice algo. */
export function isMeaningful(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0) return false;
  return !EMPTYISH.has(v.toLowerCase());
}

/**
 * Funde lo que el modelo extrajo sobre lo ya conocido.
 *
 * Reglas:
 *  - un valor vacío/basura NUNCA borra un valor previamente confirmado;
 *  - un valor nuevo y significativo sí sobrescribe (el usuario puede corregirse);
 *  - se ignoran campos que no pertenecen al workflow, para que el modelo no
 *    invente columnas.
 */
export function mergeFields(
  existing: FieldMap,
  incoming: Record<string, unknown>,
  wf: WorkflowConfig,
): { merged: FieldMap; changed: string[] } {
  const known = new Set(allFields(wf));
  const merged: FieldMap = { ...existing };
  const changed: string[] = [];

  for (const [key, raw] of Object.entries(incoming ?? {})) {
    if (!known.has(key)) continue;
    if (!isMeaningful(raw)) continue;
    const value = raw.trim();
    if (merged[key] === value) continue;
    merged[key] = value;
    changed.push(key);
  }

  return { merged, changed };
}

export function allFields(wf: WorkflowConfig): string[] {
  return [...wf.fields.essential, ...wf.fields.useful, ...wf.fields.optional];
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Resuelve la clave que reportó el modelo contra las claves reales del workflow.
 *
 * El prompt le muestra las claves exactas, pero un LLM ocasionalmente devuelve
 * una variante: la etiqueta traducida ("cantidad" por "quantity"), un sinónimo
 * o la misma clave con otra separación. Descartar el dato en ese caso obligaría
 * a volver a preguntar algo que la persona ya dijo, así que se intenta casar
 * contra la clave y contra su etiqueta legible antes de rendirse.
 *
 * Devuelve `null` si no hay una correspondencia inequívoca: adivinar mal sería
 * peor que no registrar nada.
 */
export function resolveFieldKey(wf: WorkflowConfig, reported: string): string | null {
  const fields = allFields(wf);
  if (fields.includes(reported)) return reported;

  const target = normalizeKey(reported);
  if (!target) return null;

  const byKey = fields.filter((f) => normalizeKey(f) === target);
  if (byKey.length === 1) return byKey[0];

  const byLabel = fields.filter((f) => {
    const label = wf.field_labels[f];
    return Boolean(label) && normalizeKey(label) === target;
  });
  if (byLabel.length === 1) return byLabel[0];

  return null;
}

/**
 * Campos que el canal ya satisface. Evita el "ya deberían tener mi teléfono":
 * si el workflow declara `satisfied_by_channel: [phone]`, no se vuelve a pedir.
 */
export function channelSatisfiedFields(wf: WorkflowConfig, ctx: ChannelContext): FieldMap {
  const out: FieldMap = {};
  for (const field of wf.routing.satisfied_by_channel) {
    if (!allFields(wf).includes(field)) continue;
    if (/phone|tel|whats/i.test(field) && ctx.phone) out[field] = ctx.phone;
    if (/name|nombre|contacto/i.test(field) && ctx.profileName) out[field] = ctx.profileName;
  }
  return out;
}

export interface FieldStatus {
  known: FieldMap;
  missingEssential: string[];
  missingUseful: string[];
  missingOptional: string[];
  /** Cumple la condición dura de canalización configurada por el tenant. */
  essentialComplete: boolean;
}

export function evaluateFields(
  wf: WorkflowConfig,
  known: FieldMap,
  ctx: ChannelContext,
): FieldStatus {
  const effective: FieldMap = { ...channelSatisfiedFields(wf, ctx), ...known };
  const missing = (list: string[]) => list.filter((f) => !isMeaningful(effective[f]));

  const missingEssential = missing(wf.fields.essential);

  return {
    known: effective,
    missingEssential,
    missingUseful: missing(wf.fields.useful),
    missingOptional: missing(wf.fields.optional),
    essentialComplete: wf.routing.require_all_essential
      ? missingEssential.length === 0
      : wf.fields.essential.length === 0 || missingEssential.length < wf.fields.essential.length,
  };
}

/**
 * Siguiente foco sugerido por la aplicación (no por el modelo): primero lo
 * esencial que falta, después lo útil. Nunca lo opcional — pedirlo sería
 * convertir la conversación en formulario.
 */
export function nextFocus(status: FieldStatus): string | null {
  return status.missingEssential[0] ?? status.missingUseful[0] ?? null;
}
