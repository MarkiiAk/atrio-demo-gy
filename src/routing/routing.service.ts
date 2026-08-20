import { getDb } from '../db';
import { log } from '../lib/logger';
import type { RoutingTarget, TenantConfig } from '../tenants/config-schema';
import { recordGap } from '../onboarding/gap.service';
import type { CaseWithData } from '../repositories/case.repository';
import { setCaseStatus } from '../repositories/case.repository';
import { recentMessages } from '../repositories/conversation.repository';
import type { RoutingAdapterType } from '../types/domain';
import { departmentName, fieldLabel, getWorkflow } from '../workflows/workflow-engine';
import { folioFor } from '../panel/labels';
import { logAdapter } from './adapters/log.adapter';
import { emailAdapter } from './adapters/email.adapter';
import { whatsappAdapter } from './adapters/whatsapp.adapter';
import type { AdapterResult, CaseBrief, RoutingAdapter } from './types';

const ADAPTERS: Partial<Record<RoutingAdapterType, RoutingAdapter>> = {
  LOG: logAdapter,
  EMAIL: emailAdapter,
  WHATSAPP: whatsappAdapter,
};

export interface RoutingDecision {
  /** La aplicación —no el modelo— decidió que este caso puede canalizarse. */
  eligible: boolean;
  reason: string;
  target: RoutingTarget | null;
}

export interface EligibilityInput {
  essentialComplete: boolean;
  /**
   * Señal de que el asunto necesita a una persona aunque sea informativo:
   * el asistente no pudo respaldar algo, o le pidieron una acción que no puede
   * ejecutar. Sólo aplica a workflows `answer_then_optional_route`.
   */
  escalationSignal: boolean;
  /**
   * Campos declarados en `verify_against_knowledge` cuyo valor NO se encontró
   * en la documentación autorizada.
   */
  unverifiedFields?: string[];
}

/**
 * Elegibilidad DETERMINISTA. Nada de lo que diga el LLM entra aquí:
 * sólo configuración + campos realmente presentes en la base.
 */
export function evaluateEligibility(
  config: TenantConfig,
  caseData: CaseWithData,
  input: EligibilityInput,
): RoutingDecision {
  const wf = getWorkflow(config, caseData.row.workflow_key);
  if (!wf) return { eligible: false, reason: 'workflow inexistente', target: null };
  if (!wf.config.enabled) return { eligible: false, reason: 'workflow deshabilitado', target: null };
  if (caseData.row.status === 'ROUTED') {
    return { eligible: false, reason: 'ya canalizado', target: null };
  }

  // Nada de avisos vacíos. Un mensaje al área que sólo dice "alguien escribió"
  // es basura que hace que el responsable deje de leer el canal. Los datos que
  // aporta el canal (teléfono, nombre de perfil) no cuentan como información
  // sustantiva: llegan solos, sin que la persona haya dicho nada.
  const fromChannel = new Set(wf.config.routing.satisfied_by_channel);
  const substantive = Object.entries(caseData.fields).filter(
    ([k, v]) => !fromChannel.has(k) && typeof v === 'string' && v.trim() !== '',
  );
  if (substantive.length === 0) {
    return {
      eligible: false,
      reason: 'sin información sustantiva que entregar al área',
      target: null,
    };
  }

  // Un flujo informativo NO genera caso sólo por haber respondido bien. Sólo
  // escala cuando algo quedó sin resolver: convertir cada consulta en un lead
  // es justo lo que hace odioso a un bot.
  if (wf.config.strategy === 'answer_then_optional_route') {
    if (!input.escalationSignal) {
      return { eligible: false, reason: 'consulta informativa resuelta; no hay nada que canalizar', target: null };
    }
  } else if (wf.config.fields.essential.length === 0) {
    // Sin criterio esencial configurado, canalizar en el primer mensaje sería
    // arbitrario. El validador ya lo advirtió al cargar la configuración.
    return { eligible: false, reason: 'el workflow no define campos esenciales', target: null };
  }

  if (!input.essentialComplete) {
    return { eligible: false, reason: 'faltan campos esenciales', target: null };
  }

  // Un dato que no se pudo confirmar contra la documentación BLOQUEA la
  // canalización. Avisarle al modelo no basta: puede ignorarlo y seguir
  // recabando, y entonces el área interna recibe una solicitud de algo que la
  // empresa no ofrece. Primero se aclara con la persona; después se canaliza.
  const unverified = input.unverifiedFields ?? [];
  if (unverified.length > 0) {
    return {
      eligible: false,
      reason: `sin confirmar contra la documentación: ${unverified.join(', ')}`,
      target: null,
    };
  }

  const deptKey = wf.config.department;
  if (!config.departments.departments[deptKey]) {
    return { eligible: false, reason: `departamento ${deptKey} inexistente`, target: null };
  }

  const target = config.routing.routing[deptKey] ?? config.routing.fallback ?? null;
  if (!target) {
    return { eligible: false, reason: `sin destino de canalización para ${deptKey}`, target: null };
  }

  return { eligible: true, reason: 'ok', target };
}

export interface RoutingOutcomeView {
  routed: boolean;
  /** Qué puede confirmarle el asistente al cliente. `null` = nada. */
  confirmationSemantics: 'REGISTERED_ONLY' | 'DELIVERED_TO_TEAM' | null;
  detail: string;
}

/**
 * Ejecuta la canalización y persiste el evento ANTES de que el asistente pueda
 * confirmar nada. Ése es el orden que impide prometer un envío que no ocurrió.
 */
export async function routeCase(
  config: TenantConfig,
  caseData: CaseWithData,
  decision: RoutingDecision,
  extras: { contactName: string | null; contactPhone: string | null; channel: string; openQuestions: string[] },
): Promise<RoutingOutcomeView> {
  if (!decision.eligible || !decision.target) {
    return { routed: false, confirmationSemantics: null, detail: decision.reason };
  }

  const target = decision.target;
  const adapter = ADAPTERS[target.type];
  const brief = buildBrief(config, caseData, extras);

  let result: AdapterResult;
  if (!adapter) {
    // CRM / HUMAN_INBOX declarados pero no implementados: degradamos a LOG y lo
    // decimos, en vez de fingir una entrega.
    result = await logAdapter.deliver(brief, target);
    result.detail = `adapter ${target.type} no implementado; se registró vía LOG (${result.detail})`;
    recordGap({
      tenantId: config.tenantId,
      gapType: 'MISSING_ROUTING',
      intent: null,
      topic: `adapter ${target.type} no implementado para ${brief.departmentKey}`,
      missingInformation: `configurar un destino soportado (LOG/EMAIL/WEBHOOK) para ${brief.departmentKey}`,
      conversationId: caseData.row.conversation_id,
    });
  } else {
    try {
      result = await adapter.deliver(brief, target);
    } catch (e) {
      result = { outcome: 'FAILED', detail: (e as Error).message };
    }
  }

  getDb()
    .prepare(
      `INSERT INTO routing_events (tenant_id, case_id, adapter, outcome, detail) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(config.tenantId, caseData.row.id, target.type, result.outcome, result.detail);

  if (result.outcome === 'SUCCESS') {
    setCaseStatus(caseData.row.id, 'ROUTED');
    return {
      routed: true,
      // La semántica la manda la configuración del destino, no el adapter ni el modelo.
      confirmationSemantics: target.confirmation_semantics,
      detail: result.detail,
    };
  }

  setCaseStatus(caseData.row.id, 'ROUTING_FAILED');
  log.warn('Canalización no completada', {
    caseId: caseData.row.id,
    adapter: target.type,
    outcome: result.outcome,
    detail: result.detail,
  });
  recordGap({
    tenantId: config.tenantId,
    gapType: 'MISSING_ROUTING',
    intent: caseData.intents[0]?.intent ?? null,
    topic: `canalización ${result.outcome} hacia ${brief.departmentKey}`,
    missingInformation: result.detail,
    conversationId: caseData.row.conversation_id,
  });

  return { routed: false, confirmationSemantics: null, detail: result.detail };
}

function buildBrief(
  config: TenantConfig,
  caseData: CaseWithData,
  extras: { contactName: string | null; contactPhone: string | null; channel: string; openQuestions: string[] },
): CaseBrief {
  const wf = config.workflows.workflows[caseData.row.workflow_key];
  const excerpt = recentMessages(caseData.row.conversation_id, 12)
    .map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body ?? ''}`)
    .join('\n');

  return {
    tenantId: config.tenantId,
    tenantName: config.company.company.name,
    caseId: caseData.row.id,
    folio: folioFor(caseData.row.workflow_key, caseData.row.id),
    conversationId: caseData.row.conversation_id,
    workflowKey: caseData.row.workflow_key,
    departmentKey: caseData.row.department_key,
    departmentName: departmentName(config, caseData.row.department_key),
    urgency: caseData.row.urgency,
    createdAt: caseData.row.created_at,
    contact: {
      name: extras.contactName,
      phone: extras.contactPhone,
      channel: extras.channel,
    },
    intents: caseData.intents.map((i) => ({ intent: i.intent, confidence: i.confidence })),
    fields: Object.entries(caseData.fields).map(([key, value]) => ({
      key,
      label: wf ? fieldLabel(wf, key) : key,
      value,
    })),
    openQuestions: extras.openQuestions,
    transcriptExcerpt: excerpt,
  };
}
