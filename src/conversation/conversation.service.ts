import { ensureTenantRow } from '../db';
import { getTenantConfig } from '../tenants/tenant-loader';
import type { TenantConfig } from '../tenants/config-schema';
import { resolveContact } from '../repositories/contact.repository';
import {
  getOrCreateConversation,
  recordMessage,
  type RecordMessageInput,
} from '../repositories/conversation.repository';
import type { ContactRow, ConversationRow, MessageKind, MessageRow } from '../types/domain';
import type { ChannelContext } from '../workflows/field-engine';
import { processTurn, persistAssistantReply, type EngineResult } from './conversation-engine';

export interface InboundEnvelope {
  tenantId: string;
  channel: string;
  externalUserId: string;
  phone?: string | null;
  profileName?: string | null;
  body: string | null;
  kind?: MessageKind;
  provider?: string;
  providerMessageId?: string | null;
  media?: unknown;
}

export interface AcceptedInbound {
  config: TenantConfig;
  contact: ContactRow;
  conversation: ConversationRow;
  message: MessageRow;
  channel: ChannelContext;
}

/**
 * Punto de entrada canal-agnóstico. Persiste el mensaje y devuelve el contexto
 * resuelto. Devuelve `null` si el mensaje era un duplicado (idempotencia).
 */
export function acceptInbound(env: InboundEnvelope): AcceptedInbound | null {
  const config = getTenantConfig(env.tenantId);
  ensureTenantRow(config.tenantId, config.company.company.name);

  const { contact } = resolveContact({
    tenantId: config.tenantId,
    channel: env.channel,
    externalUserId: env.externalUserId,
    phone: env.phone ?? null,
    profileName: env.profileName ?? null,
  });

  const conversation = getOrCreateConversation(config.tenantId, contact.id, env.channel);

  const payload: RecordMessageInput = {
    tenantId: config.tenantId,
    conversationId: conversation.id,
    direction: 'INBOUND',
    kind: env.kind ?? 'TEXT',
    body: env.body,
    provider: env.provider ?? env.channel,
    providerMessageId: env.providerMessageId ?? null,
    media: env.media,
  };

  const message = recordMessage(payload);
  if (!message) return null; // duplicado: ya fue procesado

  return {
    config,
    contact,
    conversation,
    message,
    channel: {
      channel: env.channel,
      phone: env.phone ?? null,
      profileName: env.profileName ?? null,
    },
  };
}

/**
 * Ejecuta el turno y persiste la respuesta. No envía nada por ningún canal:
 * el envío es responsabilidad del adaptador de canal, para que el CLI y
 * WhatsApp compartan exactamente esta ruta.
 */
export async function runTurnAndPersist(
  accepted: Pick<AcceptedInbound, 'config' | 'contact' | 'conversation' | 'channel'>,
  newMessages: string[],
): Promise<EngineResult> {
  const result = await processTurn({
    config: accepted.config,
    contact: accepted.contact,
    conversation: accepted.conversation,
    channel: accepted.channel,
    newMessages,
  });

  persistAssistantReply(
    accepted.config.tenantId,
    accepted.conversation.id,
    result.reply,
    accepted.channel.channel,
  );

  return result;
}
