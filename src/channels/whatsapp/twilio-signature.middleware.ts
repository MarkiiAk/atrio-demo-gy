import type { NextFunction, Request, Response } from 'express';
import twilio from 'twilio';
import { env } from '../../config/env';
import { log } from '../../lib/logger';

/**
 * Valida `X-Twilio-Signature` con el mecanismo oficial del SDK.
 *
 * Por qué PUBLIC_BASE_URL importa: Twilio firma HMAC sobre la URL EXACTA a la
 * que hizo el POST, concatenada con los parámetros del formulario. Detrás de un
 * túnel (ngrok) o un proxy, `req.protocol` y `req.host` reflejan la conexión
 * interna (http://localhost:3000), no la URL pública que Twilio usó. Reconstruir
 * la URL desde el request produciría una firma distinta y el rechazo de webhooks
 * legítimos. Por eso la URL pública se declara explícitamente y no se adivina.
 */
export function twilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (!env.TWILIO_VALIDATE_SIGNATURE) {
    log.warn('Validación de firma de Twilio DESACTIVADA (sólo para pruebas locales)');
    next();
    return;
  }

  if (!env.TWILIO_AUTH_TOKEN) {
    log.error('No se puede validar la firma: falta TWILIO_AUTH_TOKEN');
    res.status(500).type('text/xml').send('<Response></Response>');
    return;
  }

  if (!env.PUBLIC_BASE_URL) {
    log.error('No se puede validar la firma: falta PUBLIC_BASE_URL');
    res.status(500).type('text/xml').send('<Response></Response>');
    return;
  }

  const signature = req.header('X-Twilio-Signature') ?? '';
  const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;

  const valid = twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);

  if (!valid) {
    log.warn('Firma de Twilio inválida: petición rechazada', {
      url,
      hasSignature: signature !== '',
      paramCount: Object.keys(params).length,
    });
    res.status(403).type('text/plain').send('invalid signature');
    return;
  }

  next();
}
