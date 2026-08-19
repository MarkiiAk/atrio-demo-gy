import { GAP_TYPES, INTENTS, SENTIMENTS, URGENCIES } from '../types/domain';
import type { GapType, Intent, Sentiment, Urgency } from '../types/domain';

/**
 * Contrato de salida del LLM.
 *
 * Nota de diseño: Structured Outputs en modo `strict` exige `required` completo y
 * `additionalProperties: false`, así que NO se puede usar un objeto de claves
 * libres para los campos extraídos. Por eso `field_updates` viaja como lista de
 * pares {key, value} y se reconstruye del lado de la aplicación.
 */
export const AI_OUTPUT_SCHEMA_NAME = 'assistant_turn';

export const AI_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reply',
    'detected_intents',
    'field_updates',
    'customer_sentiment',
    'urgency_signal',
    'knowledge_used',
    'needs_clarification',
    'suggested_next_focus',
    'requested_actions',
    'onboarding_gaps',
  ],
  properties: {
    reply: {
      type: 'string',
      description:
        'Único texto que verá el cliente. Natural, en el idioma y trato configurados. Sin JSON, sin markdown, sin encabezados.',
    },
    detected_intents: {
      type: 'array',
      description:
        'Todos los motivos presentes en la conversación reciente. Un solo mensaje puede contener varios; no elijas uno artificialmente.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['intent', 'confidence'],
        properties: {
          intent: { type: 'string', enum: [...INTENTS] },
          confidence: { type: 'number', description: 'Entre 0 y 1.' },
        },
      },
    },
    field_updates: {
      type: 'array',
      description:
        'Estado ACUMULADO de los datos que la persona ha dado en TODA la conversación, no sólo en el último mensaje. Si un campo aparece como FALTA y la persona ya lo mencionó antes, inclúyelo aquí igualmente: reenviarlo no causa daño, omitirlo hace que se le vuelva a preguntar algo que ya dijo. Usa SOLO las claves listadas en el estado actual. Nunca inventes un valor que la persona no haya dicho.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workflow', 'key', 'value'],
        properties: {
          workflow: {
            type: 'string',
            description: 'Clave del workflow al que pertenece el campo.',
          },
          key: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
    customer_sentiment: { type: 'string', enum: [...SENTIMENTS] },
    urgency_signal: { type: 'string', enum: [...URGENCIES] },
    knowledge_used: {
      type: 'boolean',
      description:
        'true sólo si la respuesta se apoya en información recuperada de las fuentes autorizadas.',
    },
    needs_clarification: {
      type: 'boolean',
      description: 'true si el mensaje del usuario es demasiado ambiguo para actuar.',
    },
    suggested_next_focus: {
      type: 'string',
      description: 'Clave del siguiente campo a conversar, o cadena vacía si no aplica.',
    },
    requested_actions: {
      type: 'array',
      description:
        'Acciones concretas que el usuario pidió y que este asistente no puede ejecutar (ej. "consultar estatus de pedido en sistema").',
      items: { type: 'string' },
    },
    onboarding_gaps: {
      type: 'array',
      description:
        'Cosas que el cliente preguntó y NO pudiste responder con la información autorizada disponible. Esto es telemetría interna: nunca lo menciones en `reply`.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['gap_type', 'topic', 'missing_information'],
        properties: {
          gap_type: { type: 'string', enum: [...GAP_TYPES] },
          topic: { type: 'string', description: 'Tema corto y normalizado, reutilizable como etiqueta.' },
          missing_information: { type: 'string' },
        },
      },
    },
  },
} as const;

// ── Tipos del lado de la aplicación ──────────────────────────────────────────

export interface AiDetectedIntent {
  intent: Intent;
  confidence: number;
}

export interface AiFieldUpdate {
  workflow: string;
  key: string;
  value: string;
}

export interface AiGap {
  gap_type: GapType;
  topic: string;
  missing_information: string;
}

export interface AiTurnOutput {
  reply: string;
  detected_intents: AiDetectedIntent[];
  field_updates: AiFieldUpdate[];
  customer_sentiment: Sentiment;
  urgency_signal: Urgency;
  knowledge_used: boolean;
  needs_clarification: boolean;
  suggested_next_focus: string;
  requested_actions: string[];
  onboarding_gaps: AiGap[];
}

/**
 * Normaliza la salida del modelo. Structured Outputs garantiza la forma, pero no
 * garantiza semántica: aquí se recortan confianzas fuera de rango, se descartan
 * intents desconocidos y se limpia texto.
 */
export function normalizeAiOutput(raw: unknown): AiTurnOutput {
  const o = (raw ?? {}) as Partial<AiTurnOutput>;
  const validIntents = new Set<string>(INTENTS);
  const validSentiments = new Set<string>(SENTIMENTS);
  const validUrgencies = new Set<string>(URGENCIES);
  const validGaps = new Set<string>(GAP_TYPES);

  const intents = (Array.isArray(o.detected_intents) ? o.detected_intents : [])
    .filter((d) => d && validIntents.has(String(d.intent)))
    .map((d) => ({
      intent: d.intent as Intent,
      confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0)),
    }));

  return {
    reply: typeof o.reply === 'string' ? o.reply.trim() : '',
    detected_intents: dedupeIntents(intents),
    field_updates: (Array.isArray(o.field_updates) ? o.field_updates : [])
      .filter((f) => f && typeof f.key === 'string' && typeof f.value === 'string')
      .map((f) => ({ workflow: String(f.workflow ?? ''), key: f.key, value: f.value })),
    customer_sentiment: validSentiments.has(String(o.customer_sentiment))
      ? (o.customer_sentiment as Sentiment)
      : 'NEUTRAL',
    urgency_signal: validUrgencies.has(String(o.urgency_signal))
      ? (o.urgency_signal as Urgency)
      : 'NORMAL',
    knowledge_used: Boolean(o.knowledge_used),
    needs_clarification: Boolean(o.needs_clarification),
    suggested_next_focus: typeof o.suggested_next_focus === 'string' ? o.suggested_next_focus : '',
    requested_actions: (Array.isArray(o.requested_actions) ? o.requested_actions : [])
      .filter((s) => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim()),
    onboarding_gaps: (Array.isArray(o.onboarding_gaps) ? o.onboarding_gaps : [])
      .filter((g) => g && validGaps.has(String(g.gap_type)) && typeof g.topic === 'string')
      .map((g) => ({
        gap_type: g.gap_type as GapType,
        topic: g.topic.trim().slice(0, 160),
        missing_information: String(g.missing_information ?? '').slice(0, 400),
      }))
      .filter((g) => g.topic !== ''),
  };
}

function dedupeIntents(list: AiDetectedIntent[]): AiDetectedIntent[] {
  const best = new Map<Intent, number>();
  for (const d of list) {
    best.set(d.intent, Math.max(best.get(d.intent) ?? 0, d.confidence));
  }
  return [...best.entries()]
    .map(([intent, confidence]) => ({ intent, confidence }))
    .sort((a, b) => b.confidence - a.confidence);
}
