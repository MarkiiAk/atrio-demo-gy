import { getDb } from '../db';
import type { GapType, OnboardingGapRow } from '../types/domain';

export interface GapInput {
  tenantId: string;
  gapType: GapType;
  intent?: string | null;
  topic: string;
  missingInformation?: string | null;
  conversationId?: number | null;
}

/** Normaliza el tema para que "¿tienen acetona?" y "Tienen acetona" agreguen juntos. */
export function normalizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Registra un gap agregando por frecuencia. La clave de agregación es
 * (tenant, tipo, intent, tema normalizado) — así el reporte muestra
 * "3x recubrimiento interior de tambores" en vez de tres filas distintas.
 */
export function recordGap(input: GapInput): void {
  const topic = normalizeTopic(input.topic);
  if (!topic) return;

  getDb()
    .prepare(
      `INSERT INTO onboarding_gaps
         (tenant_id, gap_type, intent, topic, missing_information, conversation_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, gap_type, intent, topic)
       DO UPDATE SET
         frequency = frequency + 1,
         last_seen_at = datetime('now'),
         missing_information = COALESCE(excluded.missing_information, missing_information)`,
    )
    .run(
      input.tenantId,
      input.gapType,
      // Cadena vacía, no NULL: ver la nota del índice UNIQUE en schema.sql.
      input.intent ?? '',
      topic,
      input.missingInformation ?? null,
      input.conversationId ?? null,
    );
}

export interface GapReport {
  tenantId: string;
  conversationsAnalyzed: number;
  byType: Record<string, OnboardingGapRow[]>;
  total: number;
}

export function buildGapReport(tenantId: string): GapReport {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM onboarding_gaps WHERE tenant_id = ? ORDER BY frequency DESC, last_seen_at DESC`,
    )
    .all(tenantId) as OnboardingGapRow[];

  const conversations = db
    .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ?`)
    .get(tenantId) as { n: number };

  const byType: Record<string, OnboardingGapRow[]> = {};
  for (const r of rows) {
    (byType[r.gap_type] ??= []).push(r);
  }

  return {
    tenantId,
    conversationsAnalyzed: conversations.n,
    byType,
    total: rows.reduce((acc, r) => acc + r.frequency, 0),
  };
}

export function clearGaps(tenantId: string): number {
  return getDb().prepare(`DELETE FROM onboarding_gaps WHERE tenant_id = ?`).run(tenantId).changes;
}
