import { getDb } from '../db';
import { knowledgeStatus } from '../knowledge/knowledge.service';
import { buildGapReport } from '../onboarding/gap.service';
import { getTenantConfig } from '../tenants/tenant-loader';
import { buildUsageReport } from '../usage/usage.service';
import { departmentName, fieldLabel } from '../workflows/workflow-engine';
import type { CaseStatus, Urgency } from '../types/domain';

/**
 * Lecturas para el panel de administración.
 *
 * Todo va scopeado por tenant en la propia consulta: el panel no puede
 * enseñar datos de otro cliente aunque alguien manipule un id.
 */

export interface PanelSummary {
  tenant: { id: string; name: string; assistantName: string; mode: string };
  totals: {
    conversations: number;
    contacts: number;
    messagesIn: number;
    messagesOut: number;
    cases: number;
    casesRouted: number;
    casesBlocked: number;
    gaps: number;
  };
  knowledge: {
    vectorStoreId: string | null;
    websitePages: number;
    publicDocs: number;
    customerSafeDocs: number;
    lastSyncAt: string | null;
  };
  usage: {
    openaiCalls: number;
    totalTokens: number;
    avgLatencyMs: number;
    tokensPerConversation: number;
  };
  byDepartment: Array<{ key: string; name: string; cases: number; routed: number }>;
  byWorkflow: Array<{ key: string; cases: number; routed: number }>;
}

export function panelSummary(tenantId: string): PanelSummary {
  const db = getDb();
  const config = getTenantConfig(tenantId);

  const t = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM conversations WHERE tenant_id = @t) AS conversations,
         (SELECT COUNT(*) FROM contacts      WHERE tenant_id = @t) AS contacts,
         (SELECT COUNT(*) FROM messages      WHERE tenant_id = @t AND direction = 'INBOUND')  AS messages_in,
         (SELECT COUNT(*) FROM messages      WHERE tenant_id = @t AND direction = 'OUTBOUND') AS messages_out,
         (SELECT COUNT(*) FROM cases         WHERE tenant_id = @t) AS cases,
         (SELECT COUNT(*) FROM cases         WHERE tenant_id = @t AND status = 'ROUTED') AS cases_routed,
         (SELECT COUNT(*) FROM cases         WHERE tenant_id = @t AND status IN ('OPEN','READY','ROUTING_FAILED')) AS cases_blocked,
         (SELECT COALESCE(SUM(frequency),0) FROM onboarding_gaps WHERE tenant_id = @t) AS gaps`,
    )
    .get({ t: tenantId }) as Record<string, number>;

  const byDept = db
    .prepare(
      `SELECT department_key AS k,
              COUNT(*) AS cases,
              SUM(CASE WHEN status = 'ROUTED' THEN 1 ELSE 0 END) AS routed
         FROM cases WHERE tenant_id = ? AND department_key IS NOT NULL
        GROUP BY department_key ORDER BY cases DESC`,
    )
    .all(tenantId) as Array<{ k: string; cases: number; routed: number }>;

  const byWf = db
    .prepare(
      `SELECT workflow_key AS k,
              COUNT(*) AS cases,
              SUM(CASE WHEN status = 'ROUTED' THEN 1 ELSE 0 END) AS routed
         FROM cases WHERE tenant_id = ?
        GROUP BY workflow_key ORDER BY cases DESC`,
    )
    .all(tenantId) as Array<{ k: string; cases: number; routed: number }>;

  const usage = buildUsageReport(tenantId, 30);
  const k = knowledgeStatus(config);

  return {
    tenant: {
      id: tenantId,
      name: config.company.company.name,
      assistantName: config.company.assistant.display_name,
      mode: process.env.APP_MODE ?? 'demo',
    },
    totals: {
      conversations: t.conversations,
      contacts: t.contacts,
      messagesIn: t.messages_in,
      messagesOut: t.messages_out,
      cases: t.cases,
      casesRouted: t.cases_routed,
      casesBlocked: t.cases_blocked,
      gaps: t.gaps,
    },
    knowledge: k,
    usage: {
      openaiCalls: usage.openaiCalls,
      totalTokens: usage.totalTokens,
      avgLatencyMs: usage.avgLatencyMs,
      tokensPerConversation:
        usage.conversations > 0 ? Math.round(usage.totalTokens / usage.conversations) : 0,
    },
    byDepartment: byDept.map((d) => ({
      key: d.k,
      name: departmentName(config, d.k),
      cases: d.cases,
      routed: d.routed,
    })),
    byWorkflow: byWf.map((w) => ({ key: w.k, cases: w.cases, routed: w.routed })),
  };
}

export interface PanelCase {
  id: number;
  workflowKey: string;
  department: string;
  status: CaseStatus;
  urgency: Urgency;
  createdAt: string;
  routedAt: string | null;
  conversationId: number;
  contactName: string | null;
  contactPhone: string | null;
  channel: string;
  intents: Array<{ intent: string; confidence: number }>;
  fields: Array<{ key: string; label: string; value: string }>;
  routing: { adapter: string; outcome: string; detail: string | null } | null;
}

export function panelCases(tenantId: string, limit = 50): PanelCase[] {
  const db = getDb();
  const config = getTenantConfig(tenantId);

  const rows = db
    .prepare(
      `SELECT c.*, ct.display_name, ct.primary_phone, cv.channel
         FROM cases c
         JOIN contacts ct      ON ct.id = c.contact_id
         JOIN conversations cv ON cv.id = c.conversation_id
        WHERE c.tenant_id = ?
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ?`,
    )
    .all(tenantId, limit) as Array<Record<string, any>>;

  return rows.map((r) => {
    const wf = config.workflows.workflows[r.workflow_key];
    const fields = db
      .prepare(`SELECT field_key, field_value FROM case_data WHERE case_id = ? ORDER BY id`)
      .all(r.id) as Array<{ field_key: string; field_value: string }>;
    const intents = db
      .prepare(`SELECT intent, confidence FROM case_intents WHERE case_id = ? ORDER BY confidence DESC`)
      .all(r.id) as Array<{ intent: string; confidence: number }>;
    const routing = db
      .prepare(
        `SELECT adapter, outcome, detail FROM routing_events WHERE case_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(r.id) as { adapter: string; outcome: string; detail: string | null } | undefined;

    return {
      id: r.id,
      workflowKey: r.workflow_key,
      department: departmentName(config, r.department_key),
      status: r.status,
      urgency: r.urgency,
      createdAt: r.created_at,
      routedAt: r.routed_at,
      conversationId: r.conversation_id,
      contactName: r.display_name,
      contactPhone: r.primary_phone,
      channel: r.channel,
      intents,
      fields: fields.map((f) => ({
        key: f.field_key,
        label: wf ? fieldLabel(wf, f.field_key) : f.field_key,
        value: f.field_value,
      })),
      routing: routing ?? null,
    };
  });
}

export interface PanelConversation {
  id: number;
  channel: string;
  status: string;
  contactName: string | null;
  contactPhone: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  caseCount: number;
  lastSentiment: string | null;
  preview: string | null;
}

export function panelConversations(tenantId: string, limit = 50): PanelConversation[] {
  const rows = getDb()
    .prepare(
      `SELECT cv.id, cv.channel, cv.status, cv.last_message_at, cv.last_sentiment,
              ct.display_name, ct.primary_phone,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id) AS message_count,
              (SELECT COUNT(*) FROM cases k    WHERE k.conversation_id = cv.id) AS case_count,
              (SELECT m2.body FROM messages m2 WHERE m2.conversation_id = cv.id
                 AND m2.direction = 'INBOUND' ORDER BY m2.id DESC LIMIT 1) AS preview
         FROM conversations cv
         JOIN contacts ct ON ct.id = cv.contact_id
        WHERE cv.tenant_id = ?
        ORDER BY COALESCE(cv.last_message_at, cv.created_at) DESC
        LIMIT ?`,
    )
    .all(tenantId, limit) as Array<Record<string, any>>;

  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    status: r.status,
    contactName: r.display_name,
    contactPhone: r.primary_phone,
    lastMessageAt: r.last_message_at,
    messageCount: r.message_count,
    caseCount: r.case_count,
    lastSentiment: r.last_sentiment,
    preview: r.preview,
  }));
}

export interface PanelMessage {
  id: number;
  direction: string;
  body: string | null;
  kind: string;
  createdAt: string;
}

/** Transcripción de una conversación. Comprueba el tenant en la consulta. */
export function panelTranscript(tenantId: string, conversationId: number): PanelMessage[] {
  return getDb()
    .prepare(
      `SELECT m.id, m.direction, m.body, m.kind, m.created_at AS createdAt
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.conversation_id = ? AND cv.tenant_id = ?
        ORDER BY m.id ASC`,
    )
    .all(conversationId, tenantId) as PanelMessage[];
}

export interface PanelGap {
  gapType: string;
  intent: string;
  topic: string;
  missingInformation: string | null;
  frequency: number;
  lastSeenAt: string;
}

export function panelGaps(tenantId: string, limit = 60): PanelGap[] {
  const report = buildGapReport(tenantId);
  return Object.values(report.byType)
    .flat()
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit)
    .map((g) => ({
      gapType: g.gap_type,
      intent: g.intent,
      topic: g.topic,
      missingInformation: g.missing_information,
      frequency: g.frequency,
      lastSeenAt: g.last_seen_at,
    }));
}

export interface PanelConfigView {
  workflows: Array<{
    key: string;
    enabled: boolean;
    department: string;
    intents: string[];
    essential: string[];
    verifiedFields: string[];
    cannotDo: string[];
  }>;
  routing: Array<{ department: string; name: string; type: string; semantics: string }>;
  personality: { style: string[]; pronoun: string; maxQuestions: number; banned: string[] };
}

/** Vista de sólo lectura de la configuración: qué sabe hacer el asistente. */
export function panelConfig(tenantId: string): PanelConfigView {
  const config = getTenantConfig(tenantId);
  return {
    workflows: Object.entries(config.workflows.workflows).map(([key, wf]) => ({
      key,
      enabled: wf.enabled,
      department: departmentName(config, wf.department),
      intents: wf.intents,
      essential: wf.fields.essential,
      verifiedFields: wf.verify_against_knowledge,
      cannotDo: wf.cannot_do,
    })),
    routing: Object.entries(config.routing.routing).map(([dept, target]) => ({
      department: dept,
      name: departmentName(config, dept),
      type: target.type,
      semantics: target.confirmation_semantics,
    })),
    personality: {
      style: config.personality.base.style,
      pronoun: config.personality.base.pronoun_style,
      maxQuestions: config.personality.base.max_questions_per_reply,
      banned: config.personality.base.banned_phrases,
    },
  };
}
