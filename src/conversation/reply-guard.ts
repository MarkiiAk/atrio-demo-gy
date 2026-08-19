import type { TenantConfig } from '../tenants/config-schema';

/**
 * Capa determinista sobre el texto que se le va a mandar al cliente.
 *
 * El prompt guía; esto verifica. Si el modelo ignora una regla, la aplicación
 * lo detecta DESPUÉS de generar y antes de enviar, sin depender de su buena fe.
 */

export type GuardViolation =
  | { kind: 'UNAUTHORIZED_DELIVERY_CLAIM'; match: string }
  | { kind: 'INTERNALS_LEAK'; match: string }
  | { kind: 'BANNED_PHRASE'; match: string }
  | { kind: 'EMPTY_REPLY'; match: string }
  | { kind: 'STRUCTURED_LEAK'; match: string };

export interface GuardResult {
  violations: GuardViolation[];
  ok: boolean;
}

/**
 * Fin de palabra tolerante a acentos.
 *
 * `\b` de JavaScript se define sobre [A-Za-z0-9_], así que una vocal acentuada
 * NO cuenta como carácter de palabra: en "envié tu", entre la "é" y el espacio
 * no hay frontera y un `\b` final jamás coincide. Todo el guardián estaba ciego
 * a las formas conjugadas en primera persona por esto.
 */
const FIN = '(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9_])';

const rx = (source: string): RegExp => new RegExp(source, 'i');

/** Afirmaciones de que algo YA se entregó/turnó a una persona o área. */
const DELIVERY_CLAIM_PATTERNS: RegExp[] = [
  rx(
    `\\b(ya|acabo de|he|hemos)\\s+(lo\\s+|la\\s+|los\\s+|las\\s+|le\\s+)?(envi[eé]|envi[aá]d[oa]|mand[eé]|mandad[oa]|turn[eé]|turnad[oa]|escal[eé]|escalad[oa]|notifiqu[eé]|notificad[oa]|canaliz[eé]|canalizad[oa]|compart[ií]|transfer[ií]|pas[eé])${FIN}`,
  ),
  rx(
    `\\b(fue|fueron|ha sido|han sido|qued[oó]|quedaron)\\s+(ya\\s+)?(enviad[oa]s?|turnad[oa]s?|escalad[oa]s?|canalizad[oa]s?|notificad[oa]s?|remitid[oa]s?|entregad[oa]s?|compartid[oa]s?)${FIN}`,
  ),
  rx(
    `\\b(ya\\s+)?(se\\s+)?(lo|la|los|las)?\\s*(envi[eé]|mand[eé]|turn[eé])\\s+(a|al|con)\\s+\\w+`,
  ),
  rx(
    `\\b(ya\\s+)(est[aá]|qued[oó])\\s+(con|en manos de)\\s+(el|la|los|las)\\s+(equipo|[aá]rea|departamento|encargad)`,
  ),
  rx(
    `\\b(el|un)\\s+(ejecutivo|asesor|agente|responsable|encargado)\\s+.{0,30}(ya\\s+)?(recibi[oó]|tiene|fue notificad)`,
  ),
  rx(`\\b(ya\\s+)?le\\s+(avis[eé]|notifiqu[eé]|inform[eé])\\s+(a|al)${FIN}`),
];

/** Frases que exponen la arquitectura interna al cliente. */
const INTERNALS_PATTERNS: RegExp[] = [
  /\bno tengo (acceso|permisos?|forma de (consultar|acceder))\b/i,
  /\b(mi|nuestra|la) base de (datos|conocimiento)\b/i,
  /\bno (est[aá]|aparece|figura) en (mi|la|mis|las) (base|sistema|registros|documentos|informaci[oó]n cargada)/i,
  /\b(el\s+)?(erp|crm|sistema interno|backend|api|rag|vector store|prompt|workflow|pipeline)\b/i,
  /\bseg[uú]n (la|mi) configuraci[oó]n\b/i,
  /\bno tengo esa informaci[oó]n (cargada|disponible en|en mi)\b/i,
  /\b(no fui|no estoy) (entrenad|configurad|programad)/i,
  /\b(el|al) (medio|canal|departamento|[aá]rea) que .{0,40}(tenga|tengan|corresponda) (definid|establecid)/i,
  /\bcomo (modelo|asistente) de (lenguaje|ia|inteligencia artificial)\b/i,
  /\bmis (instrucciones|reglas) (internas|del sistema)\b/i,
];

/** Restos de plantilla o de la capa estructurada que nunca deben salir. */
const STRUCTURED_LEAK_PATTERNS: RegExp[] = [
  /\[[a-z_]{3,}\]/i,
  /\{\{?[a-z_]{3,}\}?\}/i,
  /\b(null|undefined|NaN|TBD)\b/,
  /"(reply|detected_intents|field_updates|onboarding_gaps)"\s*:/i,
  /\b(SALES_QUOTE|PRODUCT_DAMAGE|GENERAL_INFORMATION|ORDER_STATUS|CUSTOMER_SERVICE|HUMAN_RESOURCES|UNKNOWN_INTENT)\b/,
  /\b(essential|field_updates|knowledge_used|needs_clarification)\b/i,
];

export interface GuardContext {
  config: TenantConfig;
  /** true si en este turno la aplicación YA canalizó con éxito algún caso. */
  deliveryAuthorized: boolean;
  /** Alcance máximo autorizado si `deliveryAuthorized`. */
  confirmationSemantics: 'REGISTERED_ONLY' | 'DELIVERED_TO_TEAM' | null;
}

export function inspectReply(reply: string, ctx: GuardContext): GuardResult {
  const violations: GuardViolation[] = [];
  const text = reply ?? '';

  if (text.trim().length === 0) {
    violations.push({ kind: 'EMPTY_REPLY', match: '' });
    return { violations, ok: false };
  }

  // Afirmar entrega sólo se permite con autorización explícita y alcance suficiente.
  const allowDelivery = ctx.deliveryAuthorized && ctx.confirmationSemantics === 'DELIVERED_TO_TEAM';
  if (!allowDelivery) {
    for (const re of DELIVERY_CLAIM_PATTERNS) {
      const m = text.match(re);
      if (m) {
        violations.push({ kind: 'UNAUTHORIZED_DELIVERY_CLAIM', match: m[0] });
        break;
      }
    }
  }

  for (const re of INTERNALS_PATTERNS) {
    const m = text.match(re);
    if (m) {
      violations.push({ kind: 'INTERNALS_LEAK', match: m[0] });
      break;
    }
  }

  for (const re of STRUCTURED_LEAK_PATTERNS) {
    const m = text.match(re);
    if (m) {
      violations.push({ kind: 'STRUCTURED_LEAK', match: m[0] });
      break;
    }
  }

  for (const phrase of ctx.config.personality.base.banned_phrases) {
    if (phrase && text.toLowerCase().includes(phrase.toLowerCase())) {
      violations.push({ kind: 'BANNED_PHRASE', match: phrase });
      break;
    }
  }

  return { violations, ok: violations.length === 0 };
}

/**
 * Instrucción correctiva para el reintento. Se le dice al modelo QUÉ rompió,
 * sin darle el texto completo de las reglas otra vez.
 */
export function buildCorrectionInstruction(result: GuardResult): string {
  const notes = result.violations.map((v) => {
    switch (v.kind) {
      case 'UNAUTHORIZED_DELIVERY_CLAIM':
        return `Afirmaste que algo ya se envió o turnó ("${v.match}"), y eso todavía no ha ocurrido. Reescribe sin afirmar ninguna entrega: como mucho puedes decir que estás dejando la solicitud lista.`;
      case 'INTERNALS_LEAK':
        return `Expusiste funcionamiento interno ("${v.match}"). Reescribe sin mencionar sistemas, accesos, bases, configuración ni tus limitaciones técnicas; ofrece el siguiente paso útil.`;
      case 'STRUCTURED_LEAK':
        return `Se filtró texto que no es conversacional ("${v.match}"). Reescribe como mensaje natural, sin claves técnicas ni marcadores.`;
      case 'BANNED_PHRASE':
        return `Usaste una frase que este cliente prohíbe ("${v.match}"). Reformula con otras palabras.`;
      case 'EMPTY_REPLY':
        return 'La respuesta llegó vacía. Escribe una respuesta real.';
    }
  });

  return [
    'Tu respuesta anterior rompió una regla y NO se envió al cliente.',
    ...notes.map((n) => `- ${n}`),
    'Reescribe únicamente el campo `reply`. Mantén el resto de la extracción igual.',
  ].join('\n');
}
