import { env } from '../../config/env';
import { log } from '../../lib/logger';
import { getTenantConfig, listTenants } from '../../tenants/tenant-loader';

/** Normaliza `whatsapp:+52...`, `+52...` y `52...` a una forma comparable. */
export function normalizeWhatsAppAddress(value: string): string {
  return value.trim().toLowerCase().replace(/^whatsapp:/, '').replace(/[^\d+]/g, '');
}

export interface ResolvedChannelTenant {
  tenantId: string;
  /** Sender configurado para ese tenant, ya normalizado. */
  from: string;
}

/**
 * Resuelve a qué tenant pertenece un mensaje según el número que lo RECIBIÓ.
 *
 * Un tenant declara su sender en `company.yaml → channels.whatsapp.from`. Si no
 * lo declara, se asume el sender global de la cuenta (TWILIO_WHATSAPP_FROM), lo
 * cual sólo es válido mientras exista un único tenant con WhatsApp activo.
 */
export function resolveTenantByInboundTo(to: string): ResolvedChannelTenant | null {
  const target = normalizeWhatsAppAddress(to);
  const fallbackFrom = normalizeWhatsAppAddress(env.TWILIO_WHATSAPP_FROM || '');

  const enabled: ResolvedChannelTenant[] = [];

  for (const tenantId of listTenants()) {
    let cfg;
    try {
      cfg = getTenantConfig(tenantId);
    } catch (e) {
      log.warn('Tenant con configuración inválida, se omite del enrutamiento de canal', {
        tenantId,
        error: e,
      });
      continue;
    }
    const wa = cfg.company.channels.whatsapp;
    if (!wa.enabled) continue;

    const declared = normalizeWhatsAppAddress(wa.from || '');
    if (declared && declared === target) return { tenantId, from: declared };
    enabled.push({ tenantId, from: declared || fallbackFrom });
  }

  // Sin coincidencia explícita: sólo es seguro si hay exactamente un tenant con
  // el canal activo y su sender coincide con el global.
  const usingGlobal = enabled.filter((t) => t.from === fallbackFrom);
  if (usingGlobal.length === 1 && fallbackFrom && fallbackFrom === target) {
    return usingGlobal[0];
  }

  log.warn('No se pudo resolver el tenant para el número receptor', {
    to: target ? `…${target.slice(-4)}` : '',
    candidates: enabled.length,
  });
  return null;
}
