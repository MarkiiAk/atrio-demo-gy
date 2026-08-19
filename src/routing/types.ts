import type { RoutingTarget } from '../tenants/config-schema';
import type { Urgency } from '../types/domain';

/** Paquete que se entrega al área interna. No contiene nada del prompt ni del LLM crudo. */
export interface CaseBrief {
  tenantId: string;
  tenantName: string;
  caseId: number;
  conversationId: number;
  workflowKey: string;
  departmentKey: string | null;
  departmentName: string;
  urgency: Urgency;
  createdAt: string;
  contact: {
    name: string | null;
    phone: string | null;
    channel: string;
  };
  intents: Array<{ intent: string; confidence: number }>;
  /** Pares etiqueta-legible → valor, ya resueltos con field_labels del tenant. */
  fields: Array<{ key: string; label: string; value: string }>;
  /** Lo que el asistente no pudo resolver y el área sí debe atender. */
  openQuestions: string[];
  transcriptExcerpt: string;
}

export interface AdapterResult {
  outcome: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  detail: string;
}

export interface RoutingAdapter {
  readonly type: RoutingTarget['type'];
  deliver(brief: CaseBrief, target: RoutingTarget): Promise<AdapterResult>;
}
