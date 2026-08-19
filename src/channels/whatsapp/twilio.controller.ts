import type { Request, Response } from 'express';
import { getDb } from '../../db';
import { log, pii, snip } from '../../lib/logger';
import { acceptInbound } from '../../conversation/conversation.service';
import { enqueueInbound } from '../../jobs/job.repository';
import type { MessageKind } from '../../types/domain';
import { resolveTenantByInboundTo } from './tenant-resolver';

interface TwilioInbound {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
  SmsMessageSid?: string;
  ProfileName?: string;
  WaId?: string;
  NumMedia?: string;
  [key: string]: string | undefined;
}

/** TwiML vacío: contestamos rápido y respondemos de verdad por la API REST. */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function kindFromContentType(contentType: string | undefined): MessageKind {
  if (!contentType) return 'UNKNOWN';
  if (contentType.startsWith('image/')) return 'IMAGE';
  if (contentType.startsWith('audio/')) return 'AUDIO';
  if (contentType.startsWith('application/') || contentType.startsWith('text/')) return 'DOCUMENT';
  return 'UNKNOWN';
}

function collectMedia(body: TwilioInbound): Array<{ url: string; contentType: string }> {
  const count = Number.parseInt(body.NumMedia ?? '0', 10);
  if (!Number.isFinite(count) || count <= 0) return [];
  const out: Array<{ url: string; contentType: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const url = body[`MediaUrl${i}`];
    const contentType = body[`MediaContentType${i}`];
    if (url) out.push({ url, contentType: contentType ?? 'application/octet-stream' });
  }
  return out;
}

/**
 * Webhook de entrada. Hace lo mínimo indispensable y devuelve 200 de inmediato:
 * validar (ya lo hizo el middleware), deduplicar, persistir y encolar. Todo el
 * trabajo lento (OpenAI, envío) ocurre en el worker.
 */
export function handleInboundWhatsApp(req: Request, res: Response): void {
  const body = (req.body ?? {}) as TwilioInbound;
  const messageSid = body.MessageSid ?? body.SmsMessageSid ?? null;
  const from = body.From ?? '';
  const to = body.To ?? '';

  log.block('INBOUND', [
    ['From', pii(from)],
    ['To', pii(to)],
    ['MessageSid', messageSid ?? '(sin sid)'],
    ['ProfileName', body.ProfileName ?? ''],
    ['Body', snip(body.Body ?? '', 400)],
    ['NumMedia', body.NumMedia ?? '0'],
  ]);

  if (!from || !to) {
    res.status(400).type('text/xml').send(EMPTY_TWIML);
    return;
  }

  const resolved = resolveTenantByInboundTo(to);
  if (!resolved) {
    // Respondemos 200 para que Twilio no reintente algo que nunca funcionará.
    log.warn('Mensaje descartado: ningún tenant reclama ese número receptor');
    res.status(200).type('text/xml').send(EMPTY_TWIML);
    return;
  }

  try {
    const media = collectMedia(body);
    const text = (body.Body ?? '').trim();

    const accepted = acceptInbound({
      tenantId: resolved.tenantId,
      channel: 'whatsapp',
      externalUserId: from,
      phone: from.replace(/^whatsapp:/, ''),
      profileName: body.ProfileName ?? null,
      body: text || (media.length > 0 ? '[el cliente envió un archivo adjunto]' : ''),
      kind: media.length > 0 ? kindFromContentType(media[0].contentType) : 'TEXT',
      provider: 'twilio',
      providerMessageId: messageSid,
      media: media.length > 0 ? media : undefined,
    });

    if (!accepted) {
      // Reintento de Twilio sobre un MessageSid ya visto: no se procesa dos veces.
      log.info('Mensaje duplicado ignorado', { messageSid });
      res.status(200).type('text/xml').send(EMPTY_TWIML);
      return;
    }

    enqueueInbound({
      tenantId: resolved.tenantId,
      conversationId: accepted.conversation.id,
      messageId: accepted.message.id,
    });

    res.status(200).type('text/xml').send(EMPTY_TWIML);
  } catch (e) {
    log.error('Error procesando el webhook de entrada', { error: e });
    // 500 hace que Twilio reintente; la deduplicación por MessageSid lo hace seguro.
    res.status(500).type('text/xml').send(EMPTY_TWIML);
  }
}

/** Callbacks de estado de mensajes salientes. Opcional pero útil para depurar entregas. */
export function handleStatusCallback(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, string>;
  const sid = body.MessageSid ?? body.SmsSid ?? '';
  const status = body.MessageStatus ?? body.SmsStatus ?? 'unknown';

  if (sid) {
    getDb()
      .prepare(
        `INSERT INTO delivery_statuses (provider, provider_message_id, status, error_code)
         VALUES ('twilio', ?, ?, ?)`,
      )
      .run(sid, status, body.ErrorCode ?? null);
    log.debug('Estado de entrega recibido', { sid, status, errorCode: body.ErrorCode });
  }

  res.status(204).end();
}
