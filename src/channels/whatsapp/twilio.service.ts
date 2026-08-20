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

/** Estados de Twilio que todavía no dicen nada sobre la entrega. */
const PENDING_STATUSES = new Set(['queued', 'accepted', 'scheduled', 'sending']);
/** Estados que confirman que el mensaje salió de Twilio hacia WhatsApp. */
const DELIVERED_STATUSES = new Set(['sent', 'delivered', 'read']);

export interface ConfirmedSend extends SendResult {
  /** `true` sólo si Twilio confirmó que el mensaje salió. */
  delivered: boolean;
  errorCode: number | null;
  errorMessage: string | null;
}

/**
 * Espera a que Twilio resuelva el estado de un mensaje.
 *
 * `messages.create()` devuelve `queued`: eso significa "lo acepté", NO "llegó".
 * Tratar el SID como entrega hizo que el asistente le confirmara a un cliente
 * que su caso ya estaba con el área cuando en realidad el aviso terminó
 * `undelivered` (error 63016, ventana de 24 h cerrada). Antes de autorizar esa
 * confirmación hay que preguntarle a Twilio cómo acabó.
 */
export async function confirmDelivery(
  sid: string,
  timeoutMs = 8000,
  intervalMs = 900,
): Promise<ConfirmedSend> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; errorCode: number | null; errorMessage: string | null } = {
    status: 'queued',
    errorCode: null,
    errorMessage: null,
  };

  while (Date.now() < deadline) {
    try {
      const m = await getClient().messages(sid).fetch();
      last = {
        status: m.status ?? 'unknown',
        errorCode: m.errorCode ?? null,
        errorMessage: m.errorMessage ?? null,
      };
      if (!PENDING_STATUSES.has(last.status)) break;
    } catch (e) {
      log.warn('No se pudo consultar el estado del mensaje', { sid, error: e });
      break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    sid,
    status: last.status,
    // Un estado que sigue pendiente NO cuenta como entregado: ante la duda,
    // el asistente no promete nada.
    delivered: DELIVERED_STATUSES.has(last.status),
    errorCode: last.errorCode,
    errorMessage: last.errorMessage,
  };
}

/** Explicación legible de los errores de WhatsApp que más se dan. */
export function explainTwilioError(code: number | null): string {
  switch (code) {
    case 63016:
      return 'fuera de la ventana de 24 h de WhatsApp: ese número debe escribirle primero al asistente, o hace falta una plantilla aprobada';
    case 63015:
      return 'el número no tiene WhatsApp activo';
    case 63003:
      return 'destinatario no encontrado en WhatsApp';
    case 21610:
      return 'el destinatario se dio de baja de estos mensajes';
    default:
      return code ? `error ${code} de Twilio` : 'sin detalle del proveedor';
  }
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
