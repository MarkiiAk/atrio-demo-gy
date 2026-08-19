import { getDb } from '../db';
import type { ConversationRow, MessageRow, MessageDirection, MessageKind, Sentiment } from '../types/domain';

/** Conversación activa del contacto en ese canal, o una nueva. */
export function getOrCreateConversation(
  tenantId: string,
  contactId: number,
  channel: string,
): ConversationRow {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM conversations
        WHERE tenant_id = ? AND contact_id = ? AND channel = ? AND status = 'ACTIVE'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(tenantId, contactId, channel) as ConversationRow | undefined;
  if (existing) return existing;

  const id = db
    .prepare(`INSERT INTO conversations (tenant_id, contact_id, channel) VALUES (?, ?, ?)`)
    .run(tenantId, contactId, channel).lastInsertRowid as number;

  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow;
}

export function getConversation(id: number): ConversationRow | null {
  return (
    (getDb().prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
      | ConversationRow
      | undefined) ?? null
  );
}

export function closeConversation(id: number): void {
  getDb()
    .prepare(`UPDATE conversations SET status = 'CLOSED', updated_at = datetime('now') WHERE id = ?`)
    .run(id);
}

export function updateConversationState(
  id: number,
  patch: { sentiment?: Sentiment | null; ambiguityDelta?: number },
): void {
  const db = getDb();
  if (patch.sentiment !== undefined) {
    db.prepare(
      `UPDATE conversations SET last_sentiment = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(patch.sentiment, id);
  }
  if (patch.ambiguityDelta !== undefined) {
    // Un turno claro reinicia el contador; uno ambiguo lo incrementa.
    if (patch.ambiguityDelta > 0) {
      db.prepare(
        `UPDATE conversations SET ambiguity_count = ambiguity_count + ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(patch.ambiguityDelta, id);
    } else {
      db.prepare(
        `UPDATE conversations SET ambiguity_count = 0, updated_at = datetime('now') WHERE id = ?`,
      ).run(id);
    }
  }
}

export interface RecordMessageInput {
  tenantId: string;
  conversationId: number;
  direction: MessageDirection;
  kind?: MessageKind;
  body: string | null;
  provider?: string;
  providerMessageId?: string | null;
  media?: unknown;
}

/**
 * Persiste un mensaje. Devuelve `null` si el `providerMessageId` ya existía:
 * ése es el mecanismo de idempotencia frente a reintentos de webhook.
 */
export function recordMessage(input: RecordMessageInput): MessageRow | null {
  const db = getDb();
  const provider = input.provider ?? 'internal';

  if (input.providerMessageId) {
    const dup = db
      .prepare(`SELECT id FROM messages WHERE provider = ? AND provider_message_id = ?`)
      .get(provider, input.providerMessageId) as { id: number } | undefined;
    if (dup) return null;
  }

  try {
    const id = db
      .prepare(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, kind, body, provider, provider_message_id, media_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.conversationId,
        input.direction,
        input.kind ?? 'TEXT',
        input.body,
        provider,
        input.providerMessageId ?? null,
        input.media ? JSON.stringify(input.media) : null,
      ).lastInsertRowid as number;

    db.prepare(
      `UPDATE conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(input.conversationId);

    return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow;
  } catch (e) {
    // La restricción única puede dispararse en una carrera entre dos reintentos.
    if (String((e as Error).message).includes('UNIQUE')) return null;
    throw e;
  }
}

export function recentMessages(conversationId: number, limit = 24): MessageRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse();
}

export function getMessage(id: number): MessageRow | null {
  return (
    (getDb().prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined) ?? null
  );
}
