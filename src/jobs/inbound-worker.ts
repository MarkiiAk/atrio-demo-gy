import { env } from '../config/env';
import { log, pii, snip } from '../lib/logger';
import { processTurn } from '../conversation/conversation-engine';
import { getTenantConfig } from '../tenants/tenant-loader';
import { getContact } from '../repositories/contact.repository';
import {
  getConversation,
  getMessage,
  recordMessage,
} from '../repositories/conversation.repository';
import { getDb } from '../db';
import { sendWhatsApp } from '../channels/whatsapp/twilio.service';
import { recordUsage } from '../usage/usage.service';
import { claimNextBatch, completeJobs, failJobs, recoverStaleJobs } from './job.repository';
import type { ExternalIdentityRow } from '../types/domain';

let running = false;
let timer: NodeJS.Timeout | null = null;
/** Conversaciones con trabajo async en vuelo: refuerza la serialización. */
const inFlight = new Set<number>();

export function startInboundWorker(): void {
  if (running) return;
  running = true;
  recoverStaleJobs();
  log.info('Worker de mensajes entrantes iniciado', {
    pollMs: env.WORKER_POLL_MS,
    debounceMs: env.INBOUND_DEBOUNCE_MS,
  });
  tick();
}

export function stopInboundWorker(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(tick, env.WORKER_POLL_MS);
  timer.unref?.();
}

async function tick(): Promise<void> {
  if (!running) return;
  try {
    const batch = claimNextBatch(inFlight);
    if (!batch) {
      schedule();
      return;
    }

    inFlight.add(batch.conversationId);
    // No await: liberamos el loop para que otras conversaciones avancen en paralelo.
    void handleBatch(batch)
      .catch((e) => log.error('El lote falló de forma inesperada', { error: e }))
      .finally(() => inFlight.delete(batch.conversationId));
  } catch (e) {
    log.error('Fallo en el ciclo del worker', { error: e });
  }
  schedule();
}

async function handleBatch(batch: {
  tenantId: string;
  conversationId: number;
  jobs: Array<{ id: number; message_id: number }>;
}): Promise<void> {
  const jobIds = batch.jobs.map((j) => j.id);

  try {
    const conversation = getConversation(batch.conversationId);
    if (!conversation) {
      completeJobs(jobIds);
      return;
    }

    const config = getTenantConfig(batch.tenantId);
    const contact = getContact(batch.tenantId, conversation.contact_id);
    if (!contact) {
      completeJobs(jobIds);
      return;
    }

    const identity = getDb()
      .prepare(
        `SELECT * FROM external_identities WHERE tenant_id = ? AND contact_id = ? AND channel = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(batch.tenantId, contact.id, conversation.channel) as ExternalIdentityRow | undefined;

    const bodies = batch.jobs
      .map((j) => getMessage(j.message_id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map((m) => (m.body ?? '').trim())
      .filter((b) => b !== '');

    const result = await processTurn({
      config,
      contact,
      conversation,
      channel: {
        channel: conversation.channel,
        phone: identity?.phone ?? contact.primary_phone,
        profileName: identity?.profile_name ?? contact.display_name,
      },
      newMessages: bodies,
    });

    // Enviar por el canal correspondiente y persistir con el id real del proveedor.
    let providerMessageId: string | null = null;
    if (conversation.channel === 'whatsapp' && identity?.external_user_id) {
      const sent = await sendWhatsApp({
        config,
        to: identity.external_user_id,
        body: result.reply,
      });
      providerMessageId = sent.sid;
      recordUsage({
        tenantId: batch.tenantId,
        conversationId: conversation.id,
        model: 'n/a',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        openaiRequestId: null,
        latencyMs: 0,
        twilioOutbound: 1,
      });
    }

    recordMessage({
      tenantId: batch.tenantId,
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      kind: 'TEXT',
      body: result.reply,
      provider: conversation.channel === 'whatsapp' ? 'twilio' : conversation.channel,
      providerMessageId,
    });

    log.block('OUTBOUND', [
      ['Tenant', batch.tenantId],
      ['Para', pii(identity?.external_user_id ?? '')],
      ['Sid', providerMessageId ?? '(no enviado por canal)'],
      ['Texto', snip(result.reply, 400)],
      ['Degradado', String(result.degraded)],
    ]);

    completeJobs(jobIds);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    log.error('Falló el procesamiento del lote', { conversationId: batch.conversationId, error: e });
    failJobs(jobIds, msg);
  }
}
