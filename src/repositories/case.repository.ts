import { getDb } from '../db';
import type { CaseDataRow, CaseIntentRow, CaseRow, CaseStatus, Urgency } from '../types/domain';
import type { FieldMap } from '../workflows/field-engine';

export interface CaseWithData {
  row: CaseRow;
  fields: FieldMap;
  intents: CaseIntentRow[];
}

/** Casos vivos de la conversación (los que aún admiten más información). */
export function openCases(conversationId: number): CaseWithData[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM cases
        WHERE conversation_id = ? AND status IN ('OPEN', 'READY', 'ROUTING_FAILED')
        ORDER BY id ASC`,
    )
    .all(conversationId) as CaseRow[];
  return rows.map(hydrate);
}

/**
 * Casos que siguen siendo relevantes para el prompt: los abiertos más los ya
 * canalizados en esta misma conversación, porque el asistente necesita saber
 * qué ya puede confirmar.
 */
export function activeCases(conversationId: number): CaseWithData[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM cases
        WHERE conversation_id = ? AND status != 'CLOSED'
        ORDER BY id ASC`,
    )
    .all(conversationId) as CaseRow[];
  return rows.map(hydrate);
}

function hydrate(row: CaseRow): CaseWithData {
  const db = getDb();
  const data = db
    .prepare(`SELECT * FROM case_data WHERE case_id = ?`)
    .all(row.id) as CaseDataRow[];
  const intents = db
    .prepare(`SELECT * FROM case_intents WHERE case_id = ? ORDER BY confidence DESC`)
    .all(row.id) as CaseIntentRow[];
  const fields: FieldMap = {};
  for (const d of data) fields[d.field_key] = d.field_value;
  return { row, fields, intents };
}

export function findOpenCaseByWorkflow(
  conversationId: number,
  workflowKey: string,
): CaseWithData | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM cases
        WHERE conversation_id = ? AND workflow_key = ? AND status IN ('OPEN','READY','ROUTING_FAILED')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId, workflowKey) as CaseRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Último caso del workflow que sigue vivo en la conversación, INCLUYENDO los ya
 * canalizados.
 *
 * Si la persona sigue aportando datos del mismo asunto después de que se
 * canalizó, eso es la misma solicitud enriquecida, no una solicitud nueva.
 * Buscar sólo casos abiertos haría que el siguiente mensaje creara un caso
 * vacío y el asistente volviera a preguntar lo que ya sabía.
 */
export function findActiveCaseByWorkflow(
  conversationId: number,
  workflowKey: string,
): CaseWithData | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM cases
        WHERE conversation_id = ? AND workflow_key = ? AND status != 'CLOSED'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId, workflowKey) as CaseRow | undefined;
  return row ? hydrate(row) : null;
}

export function createCase(input: {
  tenantId: string;
  conversationId: number;
  contactId: number;
  workflowKey: string;
  departmentKey: string | null;
}): CaseWithData {
  const db = getDb();
  const id = db
    .prepare(
      `INSERT INTO cases (tenant_id, conversation_id, contact_id, workflow_key, department_key)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      input.conversationId,
      input.contactId,
      input.workflowKey,
      input.departmentKey,
    ).lastInsertRowid as number;
  return hydrate(getDb().prepare(`SELECT * FROM cases WHERE id = ?`).get(id) as CaseRow);
}

export function upsertCaseFields(caseId: number, fields: FieldMap, source: 'LLM' | 'SYSTEM' | 'USER'): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO case_data (case_id, field_key, field_value, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(case_id, field_key)
     DO UPDATE SET field_value = excluded.field_value, source = excluded.source, updated_at = datetime('now')`,
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(fields)) stmt.run(caseId, k, v, source);
  })();
}

export function recordCaseIntent(caseId: number, intent: string, confidence: number): void {
  getDb()
    .prepare(
      `INSERT INTO case_intents (case_id, intent, confidence) VALUES (?, ?, ?)
       ON CONFLICT(case_id, intent) DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`,
    )
    .run(caseId, intent, confidence);
}

export function setCaseStatus(caseId: number, status: CaseStatus): void {
  const db = getDb();
  db.prepare(`UPDATE cases SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    caseId,
  );
  if (status === 'ROUTED') {
    db.prepare(`UPDATE cases SET routed_at = datetime('now') WHERE id = ? AND routed_at IS NULL`).run(
      caseId,
    );
  }
  if (status === 'CLOSED') {
    db.prepare(`UPDATE cases SET closed_at = datetime('now') WHERE id = ?`).run(caseId);
  }
}

export function setCaseUrgency(caseId: number, urgency: Urgency): void {
  getDb()
    .prepare(`UPDATE cases SET urgency = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(urgency, caseId);
}

export function getCase(caseId: number): CaseWithData | null {
  const row = getDb().prepare(`SELECT * FROM cases WHERE id = ?`).get(caseId) as CaseRow | undefined;
  return row ? hydrate(row) : null;
}

/** Último resultado de canalización de un caso, para saber qué se puede confirmar. */
export function lastRoutingOutcome(
  caseId: number,
): { adapter: string; outcome: string; detail: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT adapter, outcome, detail FROM routing_events WHERE case_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(caseId) as { adapter: string; outcome: string; detail: string | null } | undefined;
  return row ?? null;
}
