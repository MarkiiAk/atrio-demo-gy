import { z } from 'zod';
import { INTENTS } from '../types/domain';

/**
 * Marcador que un onboarding incompleto deja en un campo que el cliente todavía
 * no ha respondido. En APP_MODE=demo se tolera y se registra como gap; en
 * production, si aparece en un workflow habilitado, es error de arranque.
 */
export const TODO_SENTINEL = 'TODO_REQUIRES_CLIENT_ONBOARDING';

export function isTodo(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase().startsWith(TODO_SENTINEL);
}

const Slug = z
  .string()
  .min(2)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'debe ser kebab-case en minúsculas');

const Key = z
  .string()
  .min(2)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'debe ser UPPER_SNAKE_CASE');

// ── company.yaml ─────────────────────────────────────────────────────────────

export const CompanySchema = z.object({
  company: z.object({
    id: Slug,
    name: z.string().min(1),
    website: z.string().optional().default(''),
    description: z.string().optional().default(''),
  }),
  assistant: z.object({
    display_name: z.string().min(1),
    locale: z.string().default('es-MX'),
    /** Texto exacto que se envía si OpenAI falla. Configurable por tenant. */
    fallback_message: z
      .string()
      .default(
        'Gracias por escribir. En este momento no pude procesar correctamente tu mensaje. ¿Podrías intentar de nuevo en unos minutos?',
      ),
    /** Mensaje seguro cuando el caso está listo pero la canalización falló. */
    routing_failed_message: z
      .string()
      .default(
        'Ya tengo la información. Voy a dejarla registrada para que el equipo le dé seguimiento en cuanto sea posible.',
      ),
  }),
  channels: z
    .object({
      whatsapp: z
        .object({
          enabled: z.boolean().default(false),
          /** Sender de Twilio de este tenant (`whatsapp:+E164`). Si se omite, se usa TWILIO_WHATSAPP_FROM. */
          from: z.string().optional().default(''),
        })
        .default({ enabled: false, from: '' }),
    })
    .default({ whatsapp: { enabled: false, from: '' } }),
});
export type CompanyConfig = z.infer<typeof CompanySchema>;

// ── personality.yaml ─────────────────────────────────────────────────────────

export const ToneSchema = z.array(z.string().min(1)).min(1);

export const PersonalitySchema = z.object({
  base: z.object({
    style: z.array(z.string().min(1)).min(1),
    pronoun_style: z.enum(['usted', 'tu']).default('usted'),
    principles: z.array(z.string().min(1)).default([]),
    /** Frases que este tenant no quiere oír nunca en boca del asistente. */
    banned_phrases: z.array(z.string().min(1)).default([]),
    /** Máximo de preguntas por respuesta. Evita el efecto interrogatorio. */
    max_questions_per_reply: z.number().int().min(1).max(3).default(1),
  }),
  /** Tono por workflow. La clave debe existir en workflows.yaml. */
  tones: z.record(z.string(), ToneSchema).default({}),
});
export type PersonalityConfig = z.infer<typeof PersonalitySchema>;

// ── departments.yaml ─────────────────────────────────────────────────────────

export const DepartmentsSchema = z.object({
  departments: z.record(
    Key,
    z.object({
      name: z.string().min(1),
      description: z.string().optional().default(''),
    }),
  ),
});
export type DepartmentsConfig = z.infer<typeof DepartmentsSchema>;

// ── workflows.yaml ───────────────────────────────────────────────────────────

export const WorkflowSchema = z.object({
  enabled: z.boolean().default(true),
  department: Key,
  /** Sólo documental: cómo se comporta el workflow. La app no ramifica por esto. */
  strategy: z
    .enum(['qualify_then_route', 'collect_then_route', 'answer_then_optional_route'])
    .default('collect_then_route'),
  /** Intents que activan este workflow. Deben pertenecer al catálogo del core. */
  intents: z.array(z.enum(INTENTS)).min(1),
  description: z.string().optional().default(''),
  fields: z
    .object({
      essential: z.array(z.string().min(1)).default([]),
      useful: z.array(z.string().min(1)).default([]),
      optional: z.array(z.string().min(1)).default([]),
    })
    .default({ essential: [], useful: [], optional: [] }),
  /** Etiqueta humana por campo, para que el LLM pregunte con lenguaje natural. */
  field_labels: z.record(z.string(), z.string()).default({}),
  routing: z
    .object({
      require_all_essential: z.boolean().default(true),
      /**
       * Si el contacto llegó por un canal que ya aporta un dato (p.ej. el teléfono
       * de WhatsApp), estos campos se consideran satisfechos sin preguntarlos.
       */
      satisfied_by_channel: z.array(z.string().min(1)).default([]),
    })
    .default({ require_all_essential: true, satisfied_by_channel: [] }),
  /** Cosas que este workflow explícitamente NO puede prometer ni resolver. */
  cannot_do: z.array(z.string().min(1)).default([]),
});
export type WorkflowConfig = z.infer<typeof WorkflowSchema>;

export const WorkflowsSchema = z.object({
  workflows: z.record(Key, WorkflowSchema),
});
export type WorkflowsConfig = z.infer<typeof WorkflowsSchema>;

// ── routing.yaml ─────────────────────────────────────────────────────────────

export const RoutingTargetSchema = z.object({
  type: z.enum(['LOG', 'EMAIL', 'WEBHOOK', 'CRM', 'HUMAN_INBOX']).default('LOG'),
  to: z.array(z.string()).default([]),
  url: z.string().optional().default(''),
  /**
   * Qué puede confirmarle el asistente al usuario cuando este destino tuvo éxito.
   * En DEMO con adapter LOG esto debe ser honesto: nadie recibió un correo.
   */
  confirmation_semantics: z
    .enum(['REGISTERED_ONLY', 'DELIVERED_TO_TEAM'])
    .default('REGISTERED_ONLY'),
});
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;

export const RoutingSchema = z.object({
  routing: z.record(Key, RoutingTargetSchema),
  /** Destino usado cuando un caso no tiene departamento resoluble. */
  fallback: RoutingTargetSchema.optional(),
});
export type RoutingConfig = z.infer<typeof RoutingSchema>;

// ── Config agregada ──────────────────────────────────────────────────────────

export interface TenantConfig {
  tenantId: string;
  company: CompanyConfig;
  personality: PersonalityConfig;
  departments: DepartmentsConfig;
  workflows: WorkflowsConfig;
  routing: RoutingConfig;
  /** Ruta absoluta de `onboarding/<tenant>/`. */
  dir: string;
}

export interface ValidationIssue {
  severity: 'ERROR' | 'WARNING';
  file: string;
  path: string;
  message: string;
}
