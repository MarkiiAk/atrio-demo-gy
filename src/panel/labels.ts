import type { TenantConfig } from '../tenants/config-schema';

/**
 * Traducción de vocabulario interno a lenguaje de negocio.
 *
 * El panel lo usa una persona de administración, no quien escribió el código.
 * Mostrar `SALES_QUOTE`, `ROUTED` o `UNANSWERED_KNOWLEDGE` obliga a esa persona
 * a aprender nuestras claves internas para entender su propia operación.
 *
 * Los nombres de los tipos de solicitud salen de la configuración del tenant
 * (`display_name`, y si falta, `description`); estos son sólo el respaldo para
 * los tipos que trae la plataforma.
 */

const WORKFLOW_FALLBACK: Record<string, string> = {
  SALES_QUOTE: 'Cotizaciones',
  SUPPLIER: 'Proveedores que se ofrecen',
  HR: 'Solicitudes de empleo',
  INVOICE: 'Facturación',
  ORDER_STATUS: 'Seguimiento de pedidos',
  DELIVERY_ISSUE: 'Problemas de entrega',
  PRODUCT_DAMAGE: 'Producto dañado',
  COMPLAINT: 'Quejas',
  SUGGESTION: 'Sugerencias',
  GENERAL_INFORMATION: 'Preguntas generales',
};

/**
 * Prefijo de folio por tipo de solicitud. Un folio con letra ("Q-1023") dice
 * de qué se trata sin abrir nada, y es lo que la persona repite por teléfono.
 */
const FOLIO_PREFIX: Record<string, string> = {
  SALES_QUOTE: 'COT',
  SUPPLIER: 'PRV',
  HR: 'RH',
  INVOICE: 'FAC',
  ORDER_STATUS: 'PED',
  DELIVERY_ISSUE: 'ENT',
  PRODUCT_DAMAGE: 'INC',
  COMPLAINT: 'Q',
  SUGGESTION: 'SUG',
  GENERAL_INFORMATION: 'INF',
};

export function folioFor(workflowKey: string, caseId: number): string {
  const prefix = FOLIO_PREFIX[workflowKey] ?? workflowKey.slice(0, 3).toUpperCase();
  return `${prefix}-${String(caseId).padStart(4, '0')}`;
}

/** Nombre presentable de un tipo de solicitud. */
export function workflowLabel(config: TenantConfig, key: string): string {
  const wf = config.workflows.workflows[key];
  if (wf?.display_name) return wf.display_name;
  if (wf?.description && wf.description.trim() !== '') return wf.description;
  if (WORKFLOW_FALLBACK[key]) return WORKFLOW_FALLBACK[key];
  // Último recurso: convertir SALES_QUOTE en "Sales quote".
  const words = key.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface StatusView {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'mute';
  hint: string;
}

/**
 * Estado de una solicitud en términos de lo que le importa a quien la atiende.
 *
 * `deliversToTeam` distingue el caso en que la canalización realmente entrega a
 * una persona de cuando sólo queda registrada: decir "enviada al área" cuando
 * nadie la recibió sería mentirle a quien lee el panel.
 */
export function caseStatusView(status: string, deliversToTeam: boolean): StatusView {
  switch (status) {
    case 'ROUTED':
      return deliversToTeam
        ? { label: 'Enviada al área', tone: 'ok', hint: 'El área responsable ya la recibió.' }
        : { label: 'Lista para atender', tone: 'ok', hint: 'Quedó completa y registrada, esperando que alguien la tome.' };
    case 'ROUTING_FAILED':
      return {
        label: 'No se pudo enviar',
        tone: 'danger',
        hint: 'La información está completa, pero falló el envío al área. Requiere revisión.',
      };
    case 'READY':
      return { label: 'Lista para atender', tone: 'ok', hint: 'Tiene todo lo necesario.' };
    case 'CLOSED':
      return { label: 'Cerrada', tone: 'mute', hint: 'Ya no requiere seguimiento.' };
    default:
      return {
        label: 'En conversación',
        tone: 'warn',
        hint: 'El asistente sigue recabando datos o hay algo por aclarar con la persona.',
      };
  }
}

const GAP_LABELS: Record<string, { label: string; hint: string }> = {
  UNANSWERED_KNOWLEDGE: {
    label: 'No supo responder',
    hint: 'Le preguntaron algo que no está en la información que le dieron.',
  },
  MISSING_CLIENT_POLICY: {
    label: 'Falta una política de la empresa',
    hint: 'Necesita que ustedes definan cómo responder esto.',
  },
  MISSING_WORKFLOW_RULE: {
    label: 'Tipo de solicitud no contemplado',
    hint: 'Llegó un asunto que no está configurado para atenderse.',
  },
  MISSING_ROUTING: {
    label: 'Falta definir a quién avisar',
    hint: 'No hay un destino configurado para este tipo de solicitud.',
  },
  UNKNOWN_INTENT: {
    label: 'No entendió qué querían',
    hint: 'El mensaje no encajó en ningún tipo de solicitud conocido.',
  },
  LOW_CONFIDENCE: {
    label: 'Dudó al clasificar',
    hint: 'Entendió el asunto a medias.',
  },
};

export function gapLabel(gapType: string): { label: string; hint: string } {
  return (
    GAP_LABELS[gapType] ?? {
      label: 'Requiere revisión',
      hint: 'Algo quedó sin resolver en la conversación.',
    }
  );
}

const SENTIMENT_LABELS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'mute' }> = {
  ANGRY: { label: 'Enojado', tone: 'danger' },
  FRUSTRATED: { label: 'Molesto', tone: 'danger' },
  URGENT: { label: 'Con urgencia', tone: 'warn' },
  POSITIVE: { label: 'Contento', tone: 'ok' },
  NEUTRAL: { label: 'Normal', tone: 'mute' },
};

export function sentimentLabel(
  value: string | null,
): { label: string; tone: 'ok' | 'warn' | 'danger' | 'mute' } | null {
  if (!value || value === 'NEUTRAL') return null;
  return SENTIMENT_LABELS[value] ?? null;
}

export function urgencyLabel(value: string): { label: string; tone: 'danger' | 'mute' } | null {
  if (value === 'HIGH') return { label: 'Urgente', tone: 'danger' };
  return null;
}

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  web: 'Página web',
  cli: 'Prueba interna',
};

export function channelLabel(value: string): string {
  return CHANNEL_LABELS[value] ?? value;
}

/** Fecha legible en español, sin ISO ni zonas horarias. */
export function humanDate(value: string | null): string {
  if (!value) return '—';
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;

  const now = new Date();
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'hace un momento';
  if (diffMin < 60) return `hace ${diffMin} min`;
  if (diffMin < 60 * 24) {
    const h = Math.round(diffMin / 60);
    return `hace ${h} ${h === 1 ? 'hora' : 'horas'}`;
  }
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
