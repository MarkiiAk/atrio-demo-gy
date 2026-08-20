import { getDb } from '../db';
import { knowledgeStatus } from '../knowledge/knowledge.service';
import { buildGapReport } from '../onboarding/gap.service';
import { getTenantConfig } from '../tenants/tenant-loader';
import { departmentName, fieldLabel } from '../workflows/workflow-engine';
import {
  caseStatusView,
  channelLabel,
  folioFor,
  gapLabel,
  humanDate,
  sentimentLabel,
  urgencyLabel,
  workflowLabel,
} from './labels';

/**
 * Lecturas para el panel de administración.
 *
 * Este panel lo usa una persona de administración del cliente, así que la capa
 * de datos entrega ya el vocabulario de negocio: nada de claves internas
 * (`SALES_QUOTE`), estados en inglés ni métricas de ingeniería (tokens,
 * latencia, ids de vector store). Esas siguen disponibles en los comandos de
 * CLI, que son para nosotros.
 *
 * Todo va scopeado por tenant en la propia consulta: el panel no puede enseñar
 * datos de otro cliente aunque alguien manipule un id.
 */

/** ¿El destino de esta área entrega a una persona, o sólo deja registro? */
function deliversToTeam(tenantId: string, departmentKey: string | null): boolean {
  const config = getTenantConfig(tenantId);
  const target =
    config.routing.routing[departmentKey ?? ''] ?? config.routing.fallback ?? null;
  return target?.confirmation_semantics === 'DELIVERED_TO_TEAM';
}

export interface PanelSummary {
  tenant: { id: string; name: string; assistantName: string; isDemo: boolean };
  headline: Array<{ label: string; value: string; sub: string }>;
  attention: {
    pendingCases: number;
    unhappyConversations: number;
    unanswered: number;
  };
  byDepartment: Array<{ name: string; total: number; ready: number; pending: number }>;
  byType: Array<{ name: string; total: number; ready: number; pending: number }>;
  knowledge: { sources: number; lastUpdate: string; website: number; documents: number };
}

export function panelSummary(tenantId: string): PanelSummary {
  const db = getDb();
  const config = getTenantConfig(tenantId);

  const t = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM conversations WHERE tenant_id = @t) AS conversations,
         (SELECT COUNT(*) FROM contacts      WHERE tenant_id = @t) AS people,
         (SELECT COUNT(*) FROM messages      WHERE tenant_id = @t AND direction = 'INBOUND') AS messages_in,
         (SELECT COUNT(*) FROM cases         WHERE tenant_id = @t) AS cases,
         (SELECT COUNT(*) FROM cases         WHERE tenant_id = @t AND status = 'ROUTED') AS ready,
         (SELECT COUNT(*) FROM cases         WHERE tenant_id = @t AND status IN ('OPEN','READY','ROUTING_FAILED')) AS pending,
         (SELECT COUNT(*) FROM conversations WHERE tenant_id = @t AND last_sentiment IN ('ANGRY','FRUSTRATED')) AS unhappy,
         (SELECT COALESCE(SUM(frequency),0) FROM onboarding_gaps
            WHERE tenant_id = @t AND gap_type = 'UNANSWERED_KNOWLEDGE') AS unanswered`,
    )
    .get({ t: tenantId }) as Record<string, number>;

  const group = (column: 'department_key' | 'workflow_key') =>
    db
      .prepare(
        `SELECT ${column} AS k,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'ROUTED' THEN 1 ELSE 0 END) AS ready,
                SUM(CASE WHEN status IN ('OPEN','READY','ROUTING_FAILED') THEN 1 ELSE 0 END) AS pending
           FROM cases WHERE tenant_id = ? AND ${column} IS NOT NULL
          GROUP BY ${column} ORDER BY total DESC`,
      )
      .all(tenantId) as Array<{ k: string; total: number; ready: number; pending: number }>;

  const k = knowledgeStatus(config);

  return {
    tenant: {
      id: tenantId,
      name: config.company.company.name,
      assistantName: config.company.assistant.display_name,
      isDemo: (process.env.APP_MODE ?? 'demo') === 'demo',
    },
    headline: [
      {
        label: 'Personas atendidas',
        value: String(t.people),
        sub: `${t.conversations} ${t.conversations === 1 ? 'conversación' : 'conversaciones'}`,
      },
      {
        label: 'Mensajes recibidos',
        value: String(t.messages_in),
        sub: 'sin que nadie tuviera que contestar',
      },
      {
        label: 'Solicitudes capturadas',
        value: String(t.cases),
        sub: `${t.ready} listas para atender`,
      },
      {
        label: 'Pendientes de dar seguimiento',
        value: String(t.pending),
        sub: t.pending > 0 ? 'requieren que alguien las tome' : 'todo al día',
      },
    ],
    attention: {
      pendingCases: t.pending,
      unhappyConversations: t.unhappy,
      unanswered: t.unanswered,
    },
    byDepartment: group('department_key').map((d) => ({
      name: departmentName(config, d.k),
      total: d.total,
      ready: d.ready,
      pending: d.pending,
    })),
    byType: group('workflow_key').map((w) => ({
      name: workflowLabel(config, w.k),
      total: w.total,
      ready: w.ready,
      pending: w.pending,
    })),
    knowledge: {
      sources: k.websitePages + k.publicDocs + k.customerSafeDocs,
      lastUpdate: humanDate(k.lastSyncAt),
      website: k.websitePages,
      documents: k.publicDocs + k.customerSafeDocs,
    },
  };
}

export interface PanelCase {
  id: number;
  folio: string;
  type: string;
  department: string;
  status: { label: string; tone: string; hint: string };
  urgency: { label: string; tone: string } | null;
  received: string;
  conversationId: number;
  person: { name: string | null; phone: string | null; channel: string };
  summary: string;
  fields: Array<{ label: string; value: string }>;
  note: string | null;
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
    const routing = db
      .prepare(`SELECT outcome, detail FROM routing_events WHERE case_id = ? ORDER BY id DESC LIMIT 1`)
      .get(r.id) as { outcome: string; detail: string | null } | undefined;

    const labelled = fields.map((f) => ({
      label: wf ? fieldLabel(wf, f.field_key) : f.field_key,
      value: f.field_value,
    }));

    // Qué le falta, dicho en palabras de la persona que atiende.
    let note: string | null = null;
    if (r.status !== 'ROUTED' && wf) {
      const known = new Set(fields.map((f) => f.field_key));
      const missing = wf.fields.essential.filter((f) => !known.has(f));
      if (missing.length > 0) {
        note = `Falta por confirmar: ${missing.map((f) => fieldLabel(wf, f)).join(', ')}.`;
      }
    }
    if (routing?.outcome === 'FAILED' || routing?.outcome === 'SKIPPED') {
      note = 'La información está completa, pero no se pudo avisar al área. Requiere revisión.';
    }

    return {
      id: r.id,
      folio: folioFor(r.workflow_key, r.id),
      type: workflowLabel(config, r.workflow_key),
      department: departmentName(config, r.department_key),
      status: caseStatusView(r.status, deliversToTeam(tenantId, r.department_key)),
      urgency: urgencyLabel(r.urgency),
      received: humanDate(r.created_at),
      conversationId: r.conversation_id,
      person: {
        name: r.display_name,
        phone: r.primary_phone,
        channel: channelLabel(r.channel),
      },
      summary: labelled
        .slice(0, 3)
        .map((f) => `${f.label}: ${f.value}`)
        .join(' · '),
      fields: labelled,
      note,
    };
  });
}

export interface PanelConversation {
  id: number;
  person: { name: string | null; phone: string | null };
  channel: string;
  mood: { label: string; tone: string } | null;
  lastActivity: string;
  messages: number;
  requests: number;
  preview: string | null;
}

export function panelConversations(tenantId: string, limit = 50): PanelConversation[] {
  const rows = getDb()
    .prepare(
      `SELECT cv.id, cv.channel, cv.last_message_at, cv.last_sentiment,
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
    person: { name: r.display_name, phone: r.primary_phone },
    channel: channelLabel(r.channel),
    mood: sentimentLabel(r.last_sentiment),
    lastActivity: humanDate(r.last_message_at),
    messages: r.message_count,
    requests: r.case_count,
    preview: r.preview,
  }));
}

export interface PanelMessage {
  from: 'persona' | 'asistente';
  text: string;
  at: string;
}

export function panelTranscript(tenantId: string, conversationId: number): PanelMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT m.direction, m.body, m.created_at
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.conversation_id = ? AND cv.tenant_id = ?
        ORDER BY m.id ASC`,
    )
    .all(conversationId, tenantId) as Array<Record<string, any>>;

  return rows.map((r) => ({
    from: r.direction === 'INBOUND' ? 'persona' : 'asistente',
    text: r.body ?? '',
    at: humanDate(r.created_at),
  }));
}

export interface PanelGap {
  category: string;
  categoryHint: string;
  topic: string;
  action: string | null;
  times: number;
  lastSeen: string;
}

export function panelGaps(tenantId: string, limit = 60): PanelGap[] {
  return Object.values(buildGapReport(tenantId).byType)
    .flat()
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit)
    .map((g) => {
      const l = gapLabel(g.gap_type);
      return {
        category: l.label,
        categoryHint: l.hint,
        topic: g.topic.charAt(0).toUpperCase() + g.topic.slice(1),
        action: g.missing_information,
        times: g.frequency,
        lastSeen: humanDate(g.last_seen_at),
      };
    });
}

export interface PanelCapabilities {
  assistantName: string;
  tone: string;
  treatment: string;
  handles: Array<{
    name: string;
    department: string;
    asksFor: string[];
    verifies: string[];
    cannotDo: string[];
  }>;
  routing: Array<{ department: string; behaviour: string }>;
  neverDoes: string[];
}

/** "Qué sabe hacer": la configuración explicada, sin YAML ni claves. */
export function panelCapabilities(tenantId: string): PanelCapabilities {
  const config = getTenantConfig(tenantId);

  const handles = Object.entries(config.workflows.workflows)
    .filter(([, wf]) => wf.enabled)
    .map(([key, wf]) => ({
      name: workflowLabel(config, key),
      department: departmentName(config, wf.department),
      asksFor: wf.fields.essential.map((f) => fieldLabel(wf, f)),
      verifies: wf.verify_against_knowledge.map((f) => fieldLabel(wf, f)),
      cannotDo: wf.cannot_do,
    }));

  return {
    assistantName: config.company.assistant.display_name,
    tone: config.personality.base.style.join(', '),
    treatment: config.personality.base.pronoun_style === 'usted' ? 'de usted' : 'de tú',
    handles,
    routing: Object.entries(config.routing.routing).map(([dept, target]) => ({
      department: departmentName(config, dept),
      behaviour:
        target.confirmation_semantics === 'DELIVERED_TO_TEAM'
          ? 'Se avisa al área y se le confirma al cliente'
          : 'Queda registrada para que el área la revise',
    })),
    neverDoes: [
      'Inventar información que no esté respaldada',
      'Dar precios o comprometer condiciones comerciales',
      'Afirmar que se manejan productos que no están en el catálogo',
      'Decirle al cliente que ya se envió algo cuando todavía no ocurrió',
      ...new Set(handles.flatMap((h) => h.cannotDo)),
    ],
  };
}
