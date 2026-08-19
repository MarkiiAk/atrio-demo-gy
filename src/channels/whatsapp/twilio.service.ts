import twilio from 'twilio';
import type { Twilio } from 'twilio';
import { env, requireTwilio } from '../../config/env';
import { log, pii } from '../../lib/logger';
import type { TenantConfig } from '../../tenants/config-schema';

let client: Twilio | null = null;

function getClient(): Twilio {
  if (!client) {
    const cfg = requireTwilio();
    client = twilio(cfg.sid, cfg.token);
  }
  return client;
}

/** El sender del tenant si lo declaró; si no, el global de la cuenta. */
export function senderFor(config: TenantConfig): string {
  const declared = config.company.channels.whatsapp.from?.trim();
  const from = declared || env.TWILIO_WHATSAPP_FROM;
  if (!from) {
    throw new Error(
      `El tenant "${config.tenantId}" no tiene sender de WhatsApp: define channels.whatsapp.from en company.yaml o TWILIO_WHATSAPP_FROM en el entorno.`,
    );
  }
  return from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
}

export interface SendResult {
  sid: string;
  status: string;
}

/** WhatsApp corta los mensajes largos; partimos por límite seguro en frontera de palabra. */
export function splitForWhatsApp(text: string, limit = 1500): string[] {
  const clean = text.trim();
  if (clean.length <= limit) return [clean];

  const parts: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendWhatsApp(params: {
  config: TenantConfig;
  to: string;
  body: string;
}): Promise<SendResult> {
  const from = senderFor(params.config);
  const to = params.to.startsWith('whatsapp:') ? params.to : `whatsapp:${params.to}`;
  const chunks = splitForWhatsApp(params.body);

  const statusCallback = env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/twilio/status`
    : undefined;

  let last: SendResult = { sid: '', status: 'unsent' };
  for (const chunk of chunks) {
    const msg = await getClient().messages.create({
      from,
      to,
      body: chunk,
      ...(statusCallback ? { statusCallback } : {}),
    });
    last = { sid: msg.sid, status: msg.status ?? 'queued' };
    log.debug('Mensaje de WhatsApp enviado', { to: pii(to), sid: msg.sid, status: msg.status });
  }
  return last;
}
