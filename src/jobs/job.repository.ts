import { getDb } from '../db';
import { env } from '../config/env';
import type { InboundJobRow } from '../types/domain';

/**
 * Cola persistente sobre SQLite. Suficiente para el MVP y honesta con sus
 * límites: un solo proceso trabajador. Si mañana hay varios, esto se cambia por
 * Redis sin tocar el engine.
 */

export function enqueueInbound(params: {
  tenantId: string;
  conversationId: number;
  messageId: number;
  delayMs?: number;
}): InboundJobRow | null {
  const db = getDb();
  const delaySeconds = Math.max(0, params.delayMs ?? env.INBOUND_DEBOUNCE_MS) / 1000;

  try {
    const id = db
      .prepare(
        `INSERT INTO inbound_jobs (tenant_id, conversation_id, message_id, scheduled_at)
         VALUES (?, ?, ?, datetime('now', ?))`,
      )
      .run(params.tenantId, params.conversationId, params.messageId, `+${delaySeconds} seconds`)
      .lastInsertRowid as number;
    return db.prepare(`SELECT * FROM inbound_jobs WHERE id = ?`).get(id) as InboundJobRow;
  } catch (e) {
    // uq_jobs_message: el mismo mensaje ya tenía job (reintento de webhook).
    if (String((e as Error).message).includes('UNIQUE')) return null;
    throw e;
  }
}

export interface ClaimedBatch {
  tenantId: string;
  conversationId: number;
  jobs: InboundJobRow[];
}

/**
 * Reclama TODOS los jobs vencidos de UNA conversación, en una transacción.
 *
 * Dos propiedades importantes:
 *  - serialización: nunca se reclama una conversación que ya tiene un job en
 *    PROCESSING, así que dos mensajes de la misma persona no se procesan a la vez;
 *  - agrupación (debounce): si llegaron tres mensajes seguidos, los tres entran
 *    en el mismo lote y se responde una sola vez.
 */
export function claimNextBatch(excludeConversations: Set<number> = new Set()): ClaimedBatch | null {
  const db = getDb();

  return db.transaction((): ClaimedBatch | null => {
    const candidate = db
      .prepare(
        `SELECT j.tenant_id, j.conversation_id
           FROM inbound_jobs j
          WHERE j.status = 'PENDING'
            AND j.scheduled_at <= datetime('now')
            AND NOT EXISTS (
              SELECT 1 FROM inbound_jobs p
               WHERE p.conversation_id = j.conversation_id AND p.status = 'PROCESSING'
            )
          ORDER BY j.scheduled_at ASC, j.id ASC
          LIMIT 20`,
      )
      .all() as Array<{ tenant_id: string; conversation_id: number }>;

    const pick = candidate.find((c) => !excludeConversations.has(c.conversation_id));
    if (!pick) return null;

    db.prepare(
      `UPDATE inbound_jobs
          SET status = 'PROCESSING', locked_at = datetime('now'), attempts = attempts + 1,
              updated_at = datetime('now')
        WHERE conversation_id = ? AND status = 'PENDING' AND scheduled_at <= datetime('now')`,
    ).run(pick.conversation_id);

    const jobs = db
      .prepare(
        `SELECT * FROM inbound_jobs
          WHERE conversation_id = ? AND status = 'PROCESSING'
          ORDER BY id ASC`,
      )
      .all(pick.conversation_id) as InboundJobRow[];

    if (jobs.length === 0) return null;
    return { tenantId: pick.tenant_id, conversationId: pick.conversation_id, jobs };
  })();
}

export function completeJobs(jobIds: number[]): void {
  if (jobIds.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE inbound_jobs SET status = 'COMPLETED', updated_at = datetime('now') WHERE id = ?`,
  );
  db.transaction(() => jobIds.forEach((id) => stmt.run(id)))();
}

/** Devuelve a PENDING para reintentar, o marca FAILED si se agotaron los intentos. */
export function failJobs(jobIds: number[], error: string): void {
  if (jobIds.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE inbound_jobs
        SET status = CASE WHEN attempts >= ? THEN 'FAILED' ELSE 'PENDING' END,
            locked_at = NULL,
            last_error = ?,
            scheduled_at = datetime('now', '+' || (attempts * 5) || ' seconds'),
            updated_at = datetime('now')
      WHERE id = ?`,
  );
  db.transaction(() => jobIds.forEach((id) => stmt.run(env.JOB_MAX_ATTEMPTS, error.slice(0, 500), id)))();
}

/** Rescata jobs que quedaron PROCESSING por una caída del proceso. */
export function recoverStaleJobs(olderThanSeconds = 300): number {
  return getDb()
    .prepare(
      `UPDATE inbound_jobs
          SET status = 'PENDING', locked_at = NULL, updated_at = datetime('now')
        WHERE status = 'PROCESSING' AND locked_at <= datetime('now', ?)`,
    )
    .run(`-${olderThanSeconds} seconds`).changes;
}

export function jobStats(tenantId?: string): Record<string, number> {
  const rows = tenantId
    ? (getDb()
        .prepare(`SELECT status, COUNT(*) AS n FROM inbound_jobs WHERE tenant_id = ? GROUP BY status`)
        .all(tenantId) as Array<{ status: string; n: number }>)
    : (getDb()
        .prepare(`SELECT status, COUNT(*) AS n FROM inbound_jobs GROUP BY status`)
        .all() as Array<{ status: string; n: number }>);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
