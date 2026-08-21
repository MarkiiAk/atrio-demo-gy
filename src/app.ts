import * as path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { env, PROJECT_ROOT } from './config/env';
import { log } from './lib/logger';
import { getDb } from './db';
import { twilioRouter } from './channels/whatsapp/twilio.routes';
import { webRouter } from './channels/web/web.routes';
import { panelRouter } from './panel/panel.routes';
import { jobStats } from './jobs/job.repository';
import { listTenants } from './tenants/tenant-loader';

/**
 * Commit desplegado, tomado de lo que publica el host. Vacío en local.
 *
 * Los hosts gestionados exponen el SHA del commit que construyeron; leerlo
 * convierte "¿ya subió el arreglo?" en un dato en vez de una deducción a partir
 * del comportamiento del asistente.
 */
const STARTED_AT = new Date().toISOString();

function deployedVersion(): { commit: string; startedAt: string } {
  const sha =
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.SOURCE_VERSION ??
    '';
  return {
    commit: sha ? sha.slice(0, 7) : 'local',
    // Cuándo arrancó este proceso: distingue "no desplegué" de "desplegué y
    // sigue igual", que son problemas distintos.
    startedAt: STARTED_AT,
  };
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Twilio envía formularios; `extended: false` deja los parámetros planos,
  // que es exactamente lo que espera validateRequest.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '256kb' }));

  // Cabeceras mínimas: el demo se comparte por link con un cliente externo.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.get('/health', (_req: Request, res: Response) => {
    const db = getDb();
    const ok = (db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
    res.json({
      status: ok ? 'ok' : 'degraded',
      mode: env.APP_MODE,
      tenants: listTenants(),
      jobs: jobStats(),
      publicBaseUrl: env.PUBLIC_BASE_URL || null,
      signatureValidation: env.TWILIO_VALIDATE_SIGNATURE,
      // Qué versión está corriendo de verdad. Sin esto, cuando un arreglo no se
      // ve en producción hay que deducir por comportamiento si el despliegue
      // llegó o no, y eso cuesta ciclos enteros de prueba.
      version: deployedVersion(),
    });
  });

  app.use('/webhooks/twilio', twilioRouter);
  app.use('/api/web', webRouter);
  app.use('/api/panel', panelRouter);

  // Chat de demostración: mismo engine que WhatsApp, en el navegador.
  app.use(
    express.static(path.join(PROJECT_ROOT, 'public'), {
      index: 'index.html',
      maxAge: env.NODE_ENV === 'production' ? '1h' : 0,
    }),
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Error no controlado en HTTP', { error: err });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
