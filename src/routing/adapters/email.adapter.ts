import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { isTodo } from '../../tenants/config-schema';
import type { RoutingTarget } from '../../tenants/config-schema';
import type { AdapterResult, CaseBrief, RoutingAdapter } from '../types';

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }
  return transport;
}

function renderBody(brief: CaseBrief): string {
  const lines: string[] = [];
  lines.push(`Nuevo caso ${brief.folio} — ${brief.workflowKey}`);
  lines.push(`Empresa: ${brief.tenantName}`);
  lines.push(`Área: ${brief.departmentName}`);
  lines.push(`Urgencia: ${brief.urgency}`);
  lines.push(`Recibido: ${brief.createdAt}`);
  lines.push('');
  lines.push('CONTACTO');
  lines.push(`  Nombre: ${brief.contact.name ?? '(no proporcionado)'}`);
  lines.push(`  ${brief.contact.channel}: ${brief.contact.phone ?? '(no disponible)'}`);
  lines.push('');
  lines.push('MOTIVOS DETECTADOS');
  for (const i of brief.intents) lines.push(`  - ${i.intent} (${i.confidence.toFixed(2)})`);
  lines.push('');
  lines.push('INFORMACIÓN RECABADA');
  if (brief.fields.length === 0) lines.push('  (ninguna)');
  for (const f of brief.fields) lines.push(`  ${f.label}: ${f.value}`);
  if (brief.openQuestions.length > 0) {
    lines.push('');
    lines.push('PENDIENTE DE RESOLVER POR EL ÁREA');
    for (const q of brief.openQuestions) lines.push(`  - ${q}`);
  }
  lines.push('');
  lines.push('EXTRACTO DE LA CONVERSACIÓN');
  lines.push(brief.transcriptExcerpt);
  return lines.join('\n');
}

/**
 * Adapter opcional. Si SMTP no está habilitado devuelve SKIPPED en vez de
 * fallar, para que un tenant con email configurado a medias no rompa el MVP —
 * pero SKIPPED nunca autoriza al asistente a confirmar entrega.
 */
export const emailAdapter: RoutingAdapter = {
  type: 'EMAIL',

  async deliver(brief: CaseBrief, target: RoutingTarget): Promise<AdapterResult> {
    if (!env.SMTP_ENABLED) {
      return { outcome: 'SKIPPED', detail: 'SMTP_ENABLED=false' };
    }
    if (!env.SMTP_HOST || !env.SMTP_FROM) {
      return { outcome: 'SKIPPED', detail: 'SMTP incompleto (falta host o remitente)' };
    }
    const recipients = target.to.filter((t) => t && !isTodo(t));
    if (recipients.length === 0) {
      return { outcome: 'SKIPPED', detail: 'sin destinatarios reales configurados' };
    }

    try {
      const info = await getTransport().sendMail({
        from: env.SMTP_FROM,
        to: recipients.join(', '),
        subject: `[${brief.tenantName}] ${brief.folio} — ${brief.workflowKey} (${brief.urgency})`,
        text: renderBody(brief),
      });
      return { outcome: 'SUCCESS', detail: `enviado a ${recipients.length} destinatario(s) [${info.messageId}]` };
    } catch (e) {
      return { outcome: 'FAILED', detail: (e as Error).message };
    }
  },
};
