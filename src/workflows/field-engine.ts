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

/**
 * Valores que se refieren al propio canal en vez de dar el dato.
 *
 * Cuando alguien contesta "mi teléfono es este mismo desde el que te escribo",
 * el modelo lo guardaba literal y el área interna recibía "mismo desde el que
 * se está escribiendo" en lugar de un número. El dato real lo tiene el canal.
 */
const SELF_REFERENTIAL =
  /(\best[ae]\s+mismo|\bel\s+mismo\s+(de|desde|que)|\bmismo\s+(n[uú]mero|whats|correo|desde)|desde\s+(el\s+)?que\s+.{0,20}escrib|\bel\s+que\s+.{0,12}(us|escrib)|\bpor\s+(aqu[ií]|este\s+medio)|\baqu[ií]\s+mismo|\bel\s+de\s+whats)/i;

/** Un valor extraído sólo cuenta si realmente dice algo. */
export function isMeaningful(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (EMPTYISH.has(v.toLowerCase())) return false;
  // "este mismo número" no es un número: es una referencia al canal.
  return !SELF_REFERENTIAL.test(v);
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

/**
 * Rellena los campos descriptivos con lo que la persona escribió, cuando el
 * modelo no los extrajo.
 *
 * No es adivinar: es tomar textualmente lo que dijo. Si alguien abre con "mi
 * pedido lleva 3 días de retraso", el motivo del asunto ya está dicho y volver
 * a preguntarlo es el error más irritante que puede cometer una recepción.
 *
 * Se usa el primer mensaje con contenido real, porque es donde la gente explica
 * el problema antes de empezar a contestar preguntas.
 */
export function fillDescriptiveFields(
  wf: WorkflowConfig,
  known: FieldMap,
  userMessages: string[],
): FieldMap {
  if (wf.describe_fields.length === 0) return {};

  const source = userMessages
    .map((m) => m.trim())
    .filter((m) => m.length >= 15)
    .find((m) => !/^\s*\(/.test(m));
  if (!source) return {};

  const out: FieldMap = {};
  for (const field of wf.describe_fields) {
    if (!allFields(wf).includes(field)) continue;
    if (isMeaningful(known[field])) continue;
    out[field] = source.length > 400 ? `${source.slice(0, 397)}…` : source;
  }
  return out;
}

/**
 * Extrae del texto de la persona los términos que parecen nombrar un producto.
 *
 * Red de seguridad para cuando el modelo NO registra el campo. Pasó en
 * producción: alguien pidió "27 tambos de thiner americano" y el modelo dejó
 * `product` vacío "para no asumir"; sin campo no había nada que verificar, así
 * que el sistema no pudo avisar que no está en catálogo y el asistente acabó
 * interrogando a la persona sobre algo que ya había dicho.
 *
 * Devuelve candidatos, no certezas: quien los use debe tratarlos como pistas.
 */
export function candidateProductTerms(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');

  const words = cleaned.split(/\s+/).filter(Boolean);
  const out: string[] = [];

  // Acrónimos: así pide un comprador industrial. "¿manejan MEK?" no producía
  // ningún candidato porque el mínimo eran 5 letras, y el asistente contestaba a
  // ciegas una pregunta sobre un producto que sí está en el catálogo. Se toman de
  // la mayúscula del texto ORIGINAL, que es la señal de que es un acrónimo y no
  // una palabra corta cualquiera; si no está declarado, el catálogo lo rechaza.
  // Mínimo tres caracteres: con dos entrarían "CP", "SA" o "NL", y un candidato
  // que no es producto puede acabar reportado como "algo que no vendemos".
  for (const acronym of text.match(/(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{2,5}(?![\p{L}\p{N}])/gu) ?? []) {
    if (!TERM_NOISE.has(acronym.toLowerCase())) out.push(acronym);
  }

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.length < 5 || TERM_NOISE.has(w) || /^\d+$/.test(w)) continue;
    out.push(w);
    // Nombres compuestos habituales en catálogos: "alcohol isopropilico",
    // "thiner americano", "monomero de estireno".
    const next = words[i + 1];
    if (next && next.length >= 4 && !TERM_NOISE.has(next) && !/^\d+$/.test(next)) {
      out.push(`${w} ${next}`);
    }
  }
  // Los compuestos primero: son más específicos que una palabra sola.
  return [...new Set(out)].sort((a, b) => b.length - a.length).slice(0, 8);
}

/**
 * Palabras que aparecen en cualquier pedido y no nombran un producto:
 * saludos, verbos, unidades, presentaciones y datos de contacto.
 *
 * Se usa para dos cosas: elegir candidatos en un mensaje, y limpiar un valor
 * antes de verificarlo contra el catálogo.
 */
export const TERM_NOISE = new Set([
  'buenas',
  'tardes',
  'noches',
  'gustaria',
  'quisiera',
  'necesito',
  'ocupo',
  'quiero',
  'cotizar',
  'cotizacion',
  'comprar',
  'pedido',
  'precio',
  'favor',
  'gracias',
  'hola',
  'tambo',
  'tambos',
  'tambor',
  'tambores',
  'porron',
  'porrones',
  'pipa',
  'pipas',
  'cubeta',
  'cubetas',
  'cilindro',
  'cilindros',
  'granel',
  'bidon',
  'bidones',
  'garrafa',
  'garrafas',
  'caja',
  'cajas',
  'saco',
  'sacos',
  'bolsa',
  'bolsas',
  'litros',
  'litro',
  'kilos',
  'kilogramos',
  'toneladas',
  'piezas',
  'entrega',
  'entregar',
  'enviar',
  'envio',
  'ciudad',
  'estado',
  'colonia',
  // Siglas frecuentes en un pedido que NO son productos. Sin esto, "mi RFC es..."
  // acaba reportado como un producto que no manejamos.
  'rfc',
  'iva',
  'usd',
  'mxn',
  'sat',
  'cfdi',
  'oc',
  'pdf',
  'whatsapp',
  'direccion',
  'postal',
  'codigo',
  'empresa',
  'nombre',
  'correo',
  'telefono',
  'contacto',
  'ustedes',
  'nosotros',
  'manejan',
  'venden',
  'tienen',
  'producto',
  'productos',
  'presentacion',
  'presentaciones',
  'trimestral',
  'mensual',
  'semanal',
  'aproximadamente',
  'urgente',
  'pronto',
]);

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
  // El canal MANDA sobre lo extraído para los campos que él aporta: el número
  // real de WhatsApp es más fiable que cualquier cosa que el modelo entienda del
  // texto, y evita que un "este mismo" acabe en el paquete que recibe el área.
  const effective: FieldMap = { ...known, ...channelSatisfiedFields(wf, ctx) };
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
