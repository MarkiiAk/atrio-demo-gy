import * as crypto from 'crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { log } from '../../lib/logger';
import { acceptInbound, runTurnAndPersist } from '../../conversation/conversation.service';
import { closeConversation } from '../../repositories/conversation.repository';
import { getTenantConfig, listTenants, tenantExists } from '../../tenants/tenant-loader';

/**
 * Canal WEB: la misma conversación que WhatsApp, en un navegador.
 *
 * Existe para que el cliente pueda probar su asistente sin dar de alta un número.
 * Usa el MISMO ConversationEngine: no hay lógica alternativa ni respuestas
 * distintas, sólo un canal distinto.
 *
 * A diferencia de WhatsApp, aquí se procesa de forma síncrona: el navegador
 * espera la respuesta, así que no tiene sentido pasar por la cola.
 */

const SESSION_COOKIE = 'atrio_sid';
const CHANNEL = 'web';

function resolveSessionId(req: Request, res: Response): string {
  const fromBody = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (/^[a-f0-9]{32}$/.test(fromBody)) return fromBody;

  const cookies = parseCookies(req.header('cookie') ?? '');
  const existing = cookies[SESSION_COOKIE];
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;

  const fresh = crypto.randomBytes(16).toString('hex');
  res.cookie?.(SESSION_COOKIE, fresh, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24,
  });
  return fresh;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function resolveTenantId(req: Request): string | null {
  const raw =
    (typeof req.body?.tenantId === 'string' && req.body.tenantId) ||
    (typeof req.query?.tenant === 'string' && req.query.tenant) ||
    '';
  const candidate = raw.trim().toLowerCase();
  if (candidate && tenantExists(candidate)) return candidate;

  // Sin parámetro: si hay exactamente un tenant, se usa ese.
  const all = listTenants();
  return all.length === 1 ? all[0] : null;
}

/** Metadatos para pintar el encabezado del chat sin hardcodear ningún cliente. */
export function handleWebMeta(req: Request, res: Response): void {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(404).json({ error: 'tenant no resuelto', tenants: listTenants() });
    return;
  }
  try {
    const config = getTenantConfig(tenantId);
    res.json({
      tenantId,
      companyName: config.company.company.name,
      assistantName: config.company.assistant.display_name,
      locale: config.company.assistant.locale,
      mode: env.APP_MODE,
      website: config.company.company.website || null,
    });
  } catch (e) {
    log.error('No se pudo cargar el tenant para el chat web', { tenantId, error: e });
    res.status(500).json({ error: 'configuración del tenant inválida' });
  }
}

export async function handleWebChat(req: Request, res: Response): Promise<void> {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(404).json({ error: 'tenant no resuelto' });
    return;
  }

  const text = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'mensaje vacío' });
    return;
  }
  if (text.length > 2000) {
    res.status(413).json({ error: 'mensaje demasiado largo' });
    return;
  }

  const sessionId = resolveSessionId(req, res);

  try {
    if (req.body?.reset === true) {
      const seed = acceptInbound({
        tenantId,
        channel: CHANNEL,
        externalUserId: sessionId,
        body: '(reinicio)',
      });
      if (seed) closeConversation(seed.conversation.id);
    }

    const accepted = acceptInbound({
      tenantId,
      channel: CHANNEL,
      externalUserId: sessionId,
      profileName: typeof req.body?.name === 'string' ? req.body.name.slice(0, 80) : null,
      body: text,
    });

    if (!accepted) {
      res.status(409).json({ error: 'mensaje duplicado' });
      return;
    }

    const result = await runTurnAndPersist(accepted, [text]);

    res.json({
      sessionId,
      reply: result.reply,
      degraded: result.degraded,
      // Panel de transparencia del demo: deja ver que hay ingeniería detrás,
      // sin exponer el prompt ni datos de otros tenants.
      trace: {
        intents: result.debug.intents,
        knowledgeSources: result.debug.knowledgeSources,
        missingEssential: result.debug.missingEssential,
        routed: result.debug.routed,
        tokens: result.debug.usage.inputTokens + result.debug.usage.outputTokens,
        latencyMs: result.debug.usage.latencyMs,
      },
    });
  } catch (e) {
    log.error('Falló el turno del chat web', { tenantId, error: e });
    res.status(500).json({ error: 'no se pudo procesar el mensaje' });
  }
}

/** Reinicio explícito de la conversación del navegador. */
export function handleWebReset(req: Request, res: Response): void {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(404).json({ error: 'tenant no resuelto' });
    return;
  }
  const sessionId = resolveSessionId(req, res);
  const seed = acceptInbound({
    tenantId,
    channel: CHANNEL,
    externalUserId: sessionId,
    body: '(reinicio)',
  });
  if (seed) closeConversation(seed.conversation.id);
  res.json({ ok: true, sessionId });
}
