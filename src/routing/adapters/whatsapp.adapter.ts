import { log } from '../../lib/logger';
import { confirmDelivery, explainTwilioError, sendWhatsApp } from '../../channels/whatsapp/twilio.service';
import { getTenantConfig } from '../../tenants/tenant-loader';
import { isTodo } from '../../tenants/config-schema';
import type { RoutingTarget } from '../../tenants/config-schema';
import type { AdapterResult, CaseBrief, RoutingAdapter } from '../types';

/**
 * Avisa por WhatsApp a la persona responsable del área.
 *
 * Este adapter SÍ entrega a un ser humano, así que es el único (junto con EMAIL)
 * que puede respaldar `confirmation_semantics: DELIVERED_TO_TEAM`. Si el envío
 * falla, devuelve FAILED y la aplicación NO autoriza al asistente a confirmarle
 * al cliente que su solicitud llegó a alguien.
 *
 * Límite de la plataforma: WhatsApp sólo permite mandar texto libre a un número
 * dentro de las 24 h siguientes a que ESE número escribió al sender. Si la
 * ventana está cerrada, Twilio rechaza el mensaje (error 63016) y hace falta una
 * plantilla aprobada. Por eso el fallo se reporta con su causa en vez de
 * silenciarse: es información que el cliente necesita para decidir.
 */

/** Normaliza un destinatario a `whatsapp:+E164`. */
function toWhatsAppAddress(raw: string): string | null {
  const cleaned = raw.trim().replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  if (cleaned.length < 10) return null;
  const withPlus = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  return `whatsapp:${withPlus}`;
}

/** Mensaje compacto y legible en un teléfono, no un volcado de datos. */
function renderMessage(brief: CaseBrief): string {
  const lines: string[] = [];
  lines.push(`*${brief.folio}* · ${brief.departmentName}`);
  if (brief.urgency === 'HIGH') lines.push('⚠ Marcado como URGENTE');
  lines.push('');
  lines.push(`*${brief.tenantName}* recibió una solicitud nueva.`);
  lines.push('');

  lines.push('*Quién escribe*');
  lines.push(`${brief.contact.name ?? 'No dio su nombre'}`);
  if (brief.contact.phone) lines.push(`${brief.contact.phone}`);
  lines.push('');

  if (brief.fields.length > 0) {
    lines.push('*Lo que nos dijo*');
    for (const f of brief.fields) lines.push(`• ${f.label}: ${f.value}`);
    lines.push('');
  }

  if (brief.openQuestions.length > 0) {
    lines.push('*Pendiente de resolver*');
    for (const q of brief.openQuestions) lines.push(`• ${q}`);
    lines.push('');
  }

  lines.push('_Responda directamente al cliente por su medio de contacto._');
  return lines.join('\n');
}

export const whatsappAdapter: RoutingAdapter = {
  type: 'WHATSAPP',

  async deliver(brief: CaseBrief, target: RoutingTarget): Promise<AdapterResult> {
    const recipients = target.to
      .filter((t) => t && !isTodo(t))
      .map(toWhatsAppAddress)
      .filter((t): t is string => t !== null);

    if (recipients.length === 0) {
      return { outcome: 'SKIPPED', detail: 'sin destinatarios de WhatsApp configurados' };
    }

    let config;
    try {
      config = getTenantConfig(brief.tenantId);
    } catch (e) {
      return { outcome: 'FAILED', detail: `no se pudo cargar el tenant: ${(e as Error).message}` };
    }

    const body = renderMessage(brief);
    const delivered: string[] = [];
    const failed: string[] = [];

    for (const to of recipients) {
      try {
        const queued = await sendWhatsApp({ config, to, body });

        // Twilio acepta el mensaje y devuelve `queued`. Eso NO es entrega: hay
        // que preguntarle cómo acabó antes de decir que el área ya lo tiene.
        const confirmed = await confirmDelivery(queued.sid);

        if (confirmed.delivered) {
          delivered.push(confirmed.sid);
        } else {
          failed.push(`${to}: ${confirmed.status} — ${explainTwilioError(confirmed.errorCode)}`);
          log.warn('El aviso al área no se entregó', {
            folio: brief.folio,
            sid: confirmed.sid,
            status: confirmed.status,
            errorCode: confirmed.errorCode,
          });
        }
      } catch (e) {
        failed.push(`${to}: ${(e as Error).message ?? String(e)}`);
        log.warn('No se pudo avisar al área por WhatsApp', { folio: brief.folio, error: e });
      }
    }

    // Sin una entrega confirmada, esto es un FALLO. La aplicación entonces no
    // autoriza al asistente a decirle al cliente que su caso ya llegó a alguien.
    if (delivered.length === 0) {
      return { outcome: 'FAILED', detail: failed.join(' | ') || 'no se confirmó ninguna entrega' };
    }
    if (failed.length > 0) {
      return {
        outcome: 'SUCCESS',
        detail: `entregado a ${delivered.length} de ${recipients.length}; fallaron: ${failed.join(' | ')}`,
      };
    }
    return {
      outcome: 'SUCCESS',
      detail: `entregado por WhatsApp a ${delivered.length} destinatario(s)`,
    };
  },
};
