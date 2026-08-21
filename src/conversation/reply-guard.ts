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
  | { kind: 'STRUCTURED_LEAK'; match: string }
  | { kind: 'UNVERIFIED_CLAIM'; match: string };

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

  // "queda registrada para seguimiento" mientras la aplicación aún no ha
  // canalizado nada. Suena inofensivo pero es falso: no está registrada en
  // ningún lado. Se permite el condicional ("puedo dejarla registrada"),
  // no la afirmación en presente o pasado.
  rx(
    `\\b(queda|qued[oó]|quedar[aá]|est[aá]|ya)\\s+(ya\\s+)?(registrad[oa]|anotad[oa]|asentad[oa]|guardad[oa])${FIN}`,
  ),
  rx(`\\b(ya\\s+)?(la|lo|le)\\s+(registr[eé]|anot[eé]|asent[eé])${FIN}`),
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

/**
 * Afirmaciones de que la empresa ofrece algo concreto. Se captura lo que viene
 * después para poder comprobarlo contra la documentación.
 *
 * El fallo real: ante "veo que ustedes venden óxido nitroso", el asistente
 * contestó "Sí manejamos óxido nitroso". La empresa no lo vende. Decirle al
 * modelo que verifique no basta — hay que comprobarlo después de que hable.
 */
const OFFERING_CLAIM_PATTERNS: RegExp[] = [
  // El lookbehind descarta las NEGACIONES. Sin él, "no tenemos confirmado X"
  // —que es justo la respuesta honesta que queremos— se leía como si afirmara X,
  // y el guardián tiraba la respuesta correcta para poner un texto de respaldo.
  /(?<!\b(?:no|sin|tampoco|ni|nunca)\s)(?<!\b(?:no|sin|tampoco|ni|nunca)\s\w{1,12}\s)\b(?:s[ií],?\s+)?(?:manejamos|vendemos|ofrecemos|distribuimos|comercializamos|tenemos|contamos con|disponemos de)\s+((?:[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ0-9-]+(?:\s+de)?\s*){1,4})/gi,
];

/**
 * Palabras que no nombran un producto: adjetivos y muletillas que se cuelan al
 * capturar las siguientes palabras tras el verbo ("tenemos *confirmado* X").
 * Se recortan del inicio del término antes de verificarlo.
 */
const NON_PRODUCT_LEADING = new Set([
  'confirmado',
  'confirmada',
  'confirmados',
  'confirmadas',
  'disponible',
  'disponibles',
  'registrado',
  'registrada',
  'anotado',
  'anotada',
  'listo',
  'lista',
  'claro',
  'mucho',
  'varios',
  'varias',
  'algunos',
  'algunas',
  'otros',
  'otras',
  'todo',
  'todos',
  'todas',
  'dentro',
  'como',
  'entre',
  'para',
  'desde',
  'hasta',
  'sobre',
]);

/** Términos genéricos: afirmarlos no compromete nada concreto. */
const GENERIC_TERMS = new Set([
  'productos',
  'producto',
  'quimicos',
  'quimico',
  'industriales',
  'industrial',
  'solventes',
  'servicios',
  'servicio',
  'informacion',
  'presentaciones',
  'presentacion',
  'opciones',
  'alternativas',
  'atencion',
  'entrega',
  'entregas',
  'cotizaciones',
  'cotizacion',
  'catalogo',
  'existencia',
  'inventario',
  'stock',
  'un',
  'una',
  'el',
  'la',
  'los',
  'las',
  'ese',
  'esa',
  'eso',
  'este',
  'esta',
  'esto',
  'lo',
  'su',
  'sus',
  'que',
  'de',
]);

export interface GuardContext {
  config: TenantConfig;
  /**
   * Comprueba un término contra la documentación del tenant. Se inyecta para
   * que el guardián siga siendo puro y testeable sin tocar disco.
   */
  // AMBIGUOUS no bloquea: "manejamos thinner" es cierto (hay tres), sólo falta
  // saber cuál. Bloquearlo haría negar productos declarados.
  verify?: (term: string) => 'FOUND' | 'AMBIGUOUS' | 'NOT_FOUND' | 'NO_KNOWLEDGE';
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

  const unverified = findUnverifiedOffering(text, ctx);
  if (unverified) violations.push({ kind: 'UNVERIFIED_CLAIM', match: unverified });

  return { violations, ok: violations.length === 0 };
}

/**
 * Busca una afirmación de que la empresa ofrece algo que la documentación no
 * respalda. Devuelve el término problemático, o `null` si todo cuadra.
 *
 * Es deliberadamente conservador: sólo señala un término cuando la verificación
 * responde NOT_FOUND. Si no hay documentación cargada (NO_KNOWLEDGE) no bloquea
 * nada — no se puede desmentir lo que no se puede consultar.
 */
/** Minúsculas sin acentos, para comparar palabras. */
function strip(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

function findUnverifiedOffering(text: string, ctx: GuardContext): string | null {
  if (!ctx.verify) return null;

  for (const re of OFFERING_CLAIM_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const captured = (m[1] ?? '').trim().replace(/[.,;:!?]+$/, '');
      if (!captured) continue;

      const words = captured.split(/\s+/).filter(Boolean);
      // "tenemos confirmado acetona" → el producto es "acetona", no "confirmado".
      while (words.length > 0 && NON_PRODUCT_LEADING.has(strip(words[0]))) words.shift();
      if (words.length === 0) continue;
      // Se prueban las variantes más largas primero: "óxido nitroso" antes que
      // "óxido", para no señalar una palabra suelta que sí exista por su cuenta.
      for (let len = Math.min(4, words.length); len >= 1; len -= 1) {
        const term = words.slice(0, len).join(' ');
        const normalized = term
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '');
        if (normalized.split(/\s+/).every((w) => GENERIC_TERMS.has(w))) continue;
        if (normalized.replace(/[^a-z0-9]/g, '').length < 4) continue;

        const result = ctx.verify(term);

        // Si la variante LARGA sí existe, las cortas son prefijos suyos y no hay
        // nada que reportar. Sin este corte el guard bloqueaba respuestas
        // correctas: "Metil Isobutil Cetona" existe, pero al seguir probando,
        // "Metil Isobutil" daba NOT_FOUND y se descartaba una respuesta buena.
        if (result === 'FOUND' || result === 'AMBIGUOUS') break;

        if (result === 'NOT_FOUND') return term;
      }
    }
  }
  return null;
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
      case 'UNVERIFIED_CLAIM':
        return `Afirmaste que la empresa ofrece "${v.match}", y eso NO aparece en la documentación autorizada. No lo afirmes. Di con naturalidad que no lo tienes confirmado dentro de lo que se maneja, menciona lo que sí se maneja que se le parezca si aplica, y ofrece dejar la consulta para que se lo confirmen. No sigas pidiendo datos de esa solicitud.`;
    }
  });

  return [
    'Tu respuesta anterior rompió una regla y NO se envió al cliente.',
    ...notes.map((n) => `- ${n}`),
    'Reescribe únicamente el campo `reply`. Mantén el resto de la extracción igual.',
  ].join('\n');
}

/**
 * Texto de respaldo cuando el modelo no logra una respuesta admisible ni tras
 * la corrección.
 *
 * Tiene que encajar con lo que se bloqueó. Un genérico como "ya tengo la
 * información necesaria" ante un producto sin confirmar es peor que decir nada:
 * suena a que todo va bien cuando justamente no lo está, y es exactamente la
 * clase de afirmación engañosa que el guardián existe para evitar.
 */
export function safeFallbackFor(result: GuardResult, ctx: GuardContext): string {
  const unverified = result.violations.find((v) => v.kind === 'UNVERIFIED_CLAIM');
  if (unverified) {
    // Deliberadamente NO se cita el término capturado.
    //
    // Ese término sale de reconocer una frase en español con expresiones
    // regulares, y cuando falla el cliente acaba leyendo algo absurdo —pasó en
    // producción: «Sobre "confirmado" prefiero no confirmarle nada»—. Para
    // decidir si bloquear, un término aproximado sirve; para ponérselo delante a
    // una persona, no. El detalle exacto queda en el log y en los gaps.
    return (
      'Prefiero no confirmarle ese punto sin verificarlo, para no darle información ' +
      'equivocada. Dejo su consulta anotada para que se la confirmen con precisión. ' +
      'Si gusta, dígame qué necesita y reviso con qué le podemos ayudar.'
    );
  }

  const claimedDelivery = result.violations.some(
    (v) => v.kind === 'UNAUTHORIZED_DELIVERY_CLAIM',
  );
  if (claimedDelivery) {
    return ctx.config.company.assistant.routing_failed_message;
  }

  return ctx.config.company.assistant.fallback_message;
}
