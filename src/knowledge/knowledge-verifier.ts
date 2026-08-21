import type { TenantConfig } from '../tenants/config-schema';
import { candidateProductTerms, TERM_NOISE } from '../workflows/field-engine';
import { clearCatalogCache } from './product-catalog';
import { resolveProduct, type ProductResolution } from './product-resolver';

/**
 * Verificación DETERMINISTA de existencia contra el CATÁLOGO DECLARADO.
 *
 * Por qué existe: el prompt le pide al modelo que verifique antes de afirmar,
 * pero una instrucción se puede ignorar. Un cliente escribió "vi en su página
 * que venden X" y el asistente le creyó y armó una cotización de 1000 litros.
 * Que el cliente afirme algo no lo vuelve cierto.
 *
 * Por qué cambió: esto buscaba subcadenas en el markdown crawleado del sitio.
 * Las fichas HTML cubren 38 de los 63 renglones del catálogo oficial, así que
 * Acetona, Metil Etil Cetona, Thinner Americano y Sosa Cáustica —productos que
 * la empresa SÍ vende— se rechazaban como inexistentes. El corpus documental
 * nunca fue la fuente de verdad del catálogo, y medir contra él producía falsos
 * negativos silenciosos: cuatro ventas negadas.
 *
 * Ahora la existencia la decide el Product Entity Resolver sobre el catálogo
 * declarado. El RAG documental (`file_search` sobre el vector store) sigue
 * intacto y sigue siendo lo que redacta y da contexto: lo que cambió es quién
 * decide qué existe, no de dónde sale el texto.
 */

export type VerificationResult = 'FOUND' | 'AMBIGUOUS' | 'NOT_FOUND' | 'NO_KNOWLEDGE';

/** Se conserva el nombre por compatibilidad: ahora la caché es la del catálogo. */
export function clearVerifierCache(): void {
  clearCatalogCache();
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'para',
  'con',
  'por',
  'que',
  'and',
  'the',
  'of',
]);

/**
 * Quita cantidades, unidades y envases para dejar sólo la identidad.
 *
 * El modelo suele registrar "27 tambos de thiner americano" en el campo del
 * producto. La identidad es "thiner americano": exigir que "tambos" también
 * exista negaba productos que sí se venden.
 */
function identityOf(term: string): string {
  const cleaned = normalize(term)
    .replace(/\b\d[\d.,]*\s*(l|lt|lts|litros?|kg|kgs|kilos?|ton|toneladas?|m3|piezas?|pzas?)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned
    .split(' ')
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !TERM_NOISE.has(w));

  // Ninguna identidad de producto es más corta que tres caracteres — el más
  // corto del catálogo es un acrónimo como MEK o DOP. Si sólo quedan residuos de
  // dos letras ("en tambos" deja "en"), no hay producto que verificar.
  if (!words.some((w) => w.length >= 3)) return '';

  return words.join(' ');
}

/**
 * Resuelve un término contra el catálogo declarado.
 *
 * Se intenta primero TAL CUAL: un nombre declarado siempre gana, incluso si
 * alguna de sus palabras estuviera en la lista de ruido. Sólo si eso no resuelve
 * se reintenta con la identidad limpia de cantidades y envases.
 */
export function resolveTerm(config: TenantConfig, term: string): ProductResolution {
  const direct = resolveProduct(config.tenantId, term);
  if (direct.status === 'MATCH' || direct.status === 'NO_KNOWLEDGE') return direct;

  const identity = identityOf(term);

  // El término no traía identidad de producto: sólo cantidades y envases ("a
  // granel", "en tambos"). Eso no es un producto inexistente, es la ausencia de
  // producto. Devolver NOT_FOUND haría que se reportara "a granel" como algo que
  // la empresa no vende.
  if (!identity) return { ...direct, status: 'NO_KNOWLEDGE' };

  if (identity !== direct.normalizedTerm) {
    const retry = resolveProduct(config.tenantId, identity);
    // Se queda con el reintento salvo que empeore: un AMBIGUOUS con candidatos
    // es más útil que un NO_MATCH, y un MATCH gana siempre.
    if (retry.status === 'MATCH' || (retry.status === 'AMBIGUOUS' && direct.status !== 'AMBIGUOUS')) {
      return retry;
    }
  }
  return direct;
}

/**
 * ¿Existe este producto en el catálogo del tenant?
 *
 * AMBIGUOUS es un resultado distinto de NOT_FOUND a propósito. "thinner" son
 * tres productos declarados: negarlo sería falso, y elegir uno sería inventar.
 * Lo correcto es preguntar cuál, y para eso quien llama necesita distinguirlo.
 */
export function verifyTerm(config: TenantConfig, term: string): VerificationResult {
  const r = resolveTerm(config, term);
  switch (r.status) {
    case 'MATCH':
      return 'FOUND';
    case 'AMBIGUOUS':
      return 'AMBIGUOUS';
    case 'NO_MATCH':
      return 'NOT_FOUND';
    default:
      return 'NO_KNOWLEDGE';
  }
}

/**
 * ¿La persona pidió algo que NO está en el catálogo, aunque el modelo no lo
 * haya registrado en ningún campo?
 *
 * Respaldo para cuando el campo verificable quedó vacío. Sólo avisa cuando
 * NINGÚN candidato del mensaje existe: si alguno resuelve —aunque sea de forma
 * ambigua— la persona está pidiendo algo que sí manejamos y no hay nada que
 * advertir. Ante la duda se calla: un falso aviso niega productos reales.
 */
export function detectUnknownRequest(config: TenantConfig, candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  const checked = candidates
    .map((term) => ({ term, result: verifyTerm(config, term) }))
    .filter((c) => c.result !== 'NO_KNOWLEDGE');

  if (checked.length === 0) return null;
  if (checked.some((c) => c.result === 'FOUND' || c.result === 'AMBIGUOUS')) return null;

  return checked[0].term;
}

/**
 * Nombre CANÓNICO del primer producto del mensaje que sí está en el catálogo.
 *
 * La contraparte de `detectUnknownRequest`. Devuelve el nombre canónico y no lo
 * que la persona escribió: así el caso que le llega al área dice "Thinner
 * Americano" y no "thiner americano", y dos personas que piden lo mismo con
 * palabras distintas producen el mismo dato.
 *
 * Sólo resuelve MATCH. Un término ambiguo no se rellena solo: hay que preguntar
 * cuál, porque elegir por la persona le vendería un químico que no pidió.
 */
export function resolveKnownProduct(config: TenantConfig, candidates: string[]): string | null {
  for (const term of candidates) {
    const r = resolveTerm(config, term);
    if (r.status === 'MATCH' && r.product) return r.product.canonicalName;
  }
  return null;
}

/**
 * Hallazgo del catálogo sobre un campo, para que el asistente sepa qué hacer.
 *
 * No son errores: son los dos casos en que el producto SÍ existe pero todavía no
 * se puede tratar la solicitud como completa.
 */
export interface CatalogFinding {
  field: string;
  /** Lo que está registrado en el campo. */
  value: string;
  kind: 'AMBIGUOUS' | 'NO_PRESENTATIONS';
  /** AMBIGUOUS: los productos entre los que hay que preguntar. */
  candidates: string[];
  /** AMBIGUOUS: cómo llamarle al grupo ("tipos de thinner"). */
  familyLabel?: string;
  /** NO_PRESENTATIONS: el producto resuelto, para nombrarlo bien. */
  canonicalName?: string;
}

/**
 * Revisa los campos verificables y reporta lo que el asistente debe resolver
 * ANTES de dar la solicitud por buena.
 *
 * AMBIGUOUS: "thinner" son tres productos. Hay que preguntar cuál, no elegir.
 * NO_PRESENTATIONS: el producto existe pero la empresa no publica sus envases
 * (26 de sus 64 productos sólo vienen en el catálogo oficial, sin ficha). Hay que
 * confirmar que se maneja y preguntar la presentación, jamás inventarla.
 */
export function inspectCatalogFields(
  config: TenantConfig,
  workflowKey: string,
  fields: Record<string, string>,
): CatalogFinding[] {
  const wf = config.workflows.workflows[workflowKey];
  if (!wf || wf.verify_against_knowledge.length === 0) return [];

  const out: CatalogFinding[] = [];
  for (const field of wf.verify_against_knowledge) {
    const value = fields[field];
    if (!value) continue;

    const r = resolveTerm(config, value);

    if (r.status === 'AMBIGUOUS') {
      out.push({
        field,
        value,
        kind: 'AMBIGUOUS',
        candidates: (r.candidates ?? []).map((p) => p.canonicalName),
        ...(r.matchedFamily ? { familyLabel: r.matchedFamily } : {}),
      });
      continue;
    }

    if (r.status === 'MATCH' && r.product && r.product.presentations.length === 0) {
      out.push({
        field,
        value,
        kind: 'NO_PRESENTATIONS',
        candidates: [],
        canonicalName: r.product.canonicalName,
      });
    }
  }
  return out;
}

/**
 * Nombre canónico de un valor que ya está registrado, si resuelve a un producto.
 *
 * Se usa para normalizar el campo: quien escribió "thiner americano" deja
 * registrado "Thinner Americano", así el panel y el aviso al área ven el nombre
 * real del catálogo y no la grafía de cada persona. Devuelve `null` si no hay
 * nada que corregir.
 */
export function canonicalizeProduct(config: TenantConfig, value: string): string | null {
  const r = resolveTerm(config, value);
  if (r.status !== 'MATCH' || !r.product) return null;
  return r.product.canonicalName === value ? null : r.product.canonicalName;
}

export interface FieldVerification {
  workflowKey: string;
  field: string;
  value: string;
  result: VerificationResult;
}

/**
 * Verifica los campos que el workflow marcó como comprobables contra el
 * catálogo. Devuelve sólo los que NO existen: los que el asistente debe dejar de
 * tratar como algo que la empresa ofrece.
 *
 * Un campo ambiguo NO se reporta aquí: existe, sólo falta saber cuál. Reportarlo
 * haría que el panel dijera "no aparece en el catálogo" de un producto real.
 */
export function verifyCaseFields(
  config: TenantConfig,
  workflowKey: string,
  fields: Record<string, string>,
): FieldVerification[] {
  const wf = config.workflows.workflows[workflowKey];
  if (!wf || wf.verify_against_knowledge.length === 0) return [];

  const out: FieldVerification[] = [];
  for (const field of wf.verify_against_knowledge) {
    const value = fields[field];
    if (!value) continue;
    if (verifyTerm(config, value) === 'NOT_FOUND') {
      out.push({ workflowKey, field, value, result: 'NOT_FOUND' });
    }
  }
  return out;
}

/**
 * Campos verificables cuyo valor NO es lo que la persona pidió.
 *
 * Detecta una sustitución silenciosa. Caso real: alguien pidió cotizar "acetona"
 * y el modelo registró "acetato", que también está en el catálogo. La
 * verificación de existencia lo aprobó, y a Ventas le llegó la cotización de un
 * producto que nadie pidió. Existir no basta: el dato también tiene que ser lo
 * que se pidió. Un producto plausible en el lugar del real es peor que un hueco,
 * porque nadie lo cuestiona.
 *
 * Se compara por ENTIDAD, no por texto: la aplicación normaliza los campos al
 * nombre canónico, así que quien dijo "etanol" tiene registrado "Alcohol
 * Etílico" y compararlo por palabras lo marcaría como sustitución. Lo que
 * importa es si ambos resuelven al mismo producto.
 */
export function findSubstitutedFields(
  config: TenantConfig,
  workflowKey: string,
  fields: Record<string, string>,
  userMessages: string[],
): Array<{ field: string; value: string }> {
  const wf = config.workflows.workflows[workflowKey];
  if (!wf || wf.verify_against_knowledge.length === 0) return [];

  const said = normalize(userMessages.join(' \n '));
  if (!said) return [];

  const out: Array<{ field: string; value: string }> = [];
  for (const field of wf.verify_against_knowledge) {
    const value = fields[field];
    if (!value) continue;
    if (mentionedByEntity(config, value, userMessages)) continue;
    if (mentionedByWords(value, said)) continue;
    out.push({ field, value });
  }
  return out;
}

/** ¿Algo de lo que dijo la persona resuelve al MISMO producto que el campo? */
function mentionedByEntity(config: TenantConfig, value: string, userMessages: string[]): boolean {
  const target = resolveTerm(config, value);
  if (target.status !== 'MATCH' || !target.product) return false;

  for (const message of userMessages) {
    for (const term of candidateProductTerms(message)) {
      const r = resolveTerm(config, term);
      if (r.status === 'MATCH' && r.product?.id === target.product.id) return true;
    }
  }
  return false;
}

/**
 * Respaldo textual: la palabra significativa más larga del valor aparece en la
 * conversación. Se conserva porque el extractor de candidatos no cubre todas las
 * formas de nombrar algo, y un falso positivo aquí acusaría de sustitución un
 * dato correcto.
 */
function mentionedByWords(value: string, said: string): boolean {
  const words = normalize(value)
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .sort((a, b) => b.length - a.length);

  if (words.length === 0) return false;
  return words.some((w) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(said),
  );
}
