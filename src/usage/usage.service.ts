import { getDb } from '../db';

export interface UsageInput {
  tenantId: string;
  conversationId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  openaiRequestId: string | null;
  latencyMs: number;
  twilioInbound?: number;
  twilioOutbound?: number;
}

export function recordUsage(input: UsageInput): void {
  getDb()
    .prepare(
      `INSERT INTO usage_records
         (tenant_id, conversation_id, model, input_tokens, output_tokens, total_tokens,
          openai_request_id, latency_ms, twilio_inbound_messages, twilio_outbound_messages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      input.conversationId,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.totalTokens || input.inputTokens + input.outputTokens,
      input.openaiRequestId,
      input.latencyMs,
      input.twilioInbound ?? 0,
      input.twilioOutbound ?? 0,
    );
}

export interface UsageReport {
  tenantId: string;
  from: string;
  to: string;
  conversations: number;
  inboundMessages: number;
  outboundMessages: number;
  openaiCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  byModel: Array<{ model: string; calls: number; totalTokens: number }>;
}

/**
 * Reporte de consumo. Deliberadamente NO calcula dinero: los precios cambian y
 * hardcodearlos produciría números falsos. Se entregan las magnitudes crudas.
 */
export function buildUsageReport(tenantId: string, days = 30): UsageReport {
  const db = getDb();
  const since = `-${Math.max(1, days)} days`;

  const totals = db
    .prepare(
      `SELECT
         COUNT(*)                       AS calls,
         COALESCE(SUM(input_tokens),0)  AS input_tokens,
         COALESCE(SUM(output_tokens),0) AS output_tokens,
         COALESCE(SUM(total_tokens),0)  AS total_tokens,
         COALESCE(AVG(latency_ms),0)    AS avg_latency
       FROM usage_records
       WHERE tenant_id = ? AND created_at >= datetime('now', ?)`,
    )
    .get(tenantId, since) as {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    avg_latency: number;
  };

  const latencies = db
    .prepare(
      `SELECT latency_ms FROM usage_records
        WHERE tenant_id = ? AND created_at >= datetime('now', ?) AND latency_ms > 0
        ORDER BY latency_ms ASC`,
    )
    .all(tenantId, since) as Array<{ latency_ms: number }>;

  const p95 =
    latencies.length === 0
      ? 0
      : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))].latency_ms;

  const msgs = db
    .prepare(
      `SELECT
         SUM(CASE WHEN direction = 'INBOUND'  THEN 1 ELSE 0 END) AS inbound,
         SUM(CASE WHEN direction = 'OUTBOUND' THEN 1 ELSE 0 END) AS outbound
       FROM messages
       WHERE tenant_id = ? AND created_at >= datetime('now', ?)`,
    )
    .get(tenantId, since) as { inbound: number | null; outbound: number | null };

  const convs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM conversations
        WHERE tenant_id = ? AND created_at >= datetime('now', ?)`,
    )
    .get(tenantId, since) as { n: number };

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS total_tokens
         FROM usage_records
        WHERE tenant_id = ? AND created_at >= datetime('now', ?)
        GROUP BY model ORDER BY calls DESC`,
    )
    .all(tenantId, since) as Array<{ model: string; calls: number; total_tokens: number }>;

  return {
    tenantId,
    from: `hace ${days} días`,
    to: 'ahora',
    conversations: convs.n,
    inboundMessages: msgs.inbound ?? 0,
    outboundMessages: msgs.outbound ?? 0,
    openaiCalls: totals.calls,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    totalTokens: totals.total_tokens,
    avgLatencyMs: Math.round(totals.avg_latency),
    p95LatencyMs: p95,
    byModel: byModel.map((m) => ({ model: m.model, calls: m.calls, totalTokens: m.total_tokens })),
  };
}
