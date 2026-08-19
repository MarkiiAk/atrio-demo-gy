import { createApp } from './app';
import { env } from './config/env';
import { getDb, closeDb } from './db';
import { log } from './lib/logger';
import { startInboundWorker, stopInboundWorker } from './jobs/inbound-worker';
import { listTenants, getTenantConfig } from './tenants/tenant-loader';
import { validateTenant, summarizeIssues } from './tenants/tenant-validator';

function preflight(): boolean {
  const tenants = listTenants();
  if (tenants.length === 0) {
    log.warn('No hay tenants configurados. Crea uno con: npm run onboard:new -- <tenant-id>');
    return true;
  }

  let fatal = false;
  for (const tenantId of tenants) {
    try {
      const config = getTenantConfig(tenantId);
      const issues = validateTenant(config, env.APP_MODE);
      const { errors, warnings } = summarizeIssues(issues);
      log.info(`Tenant listo: ${tenantId}`, {
        errors,
        warnings,
        whatsapp: config.company.channels.whatsapp.enabled,
      });
      if (errors > 0) {
        for (const i of issues.filter((i) => i.severity === 'ERROR')) {
          log.error(`  [${tenantId}] ${i.file} ${i.path}: ${i.message}`);
        }
        // En production un tenant roto no debe arrancar silenciosamente.
        if (env.APP_MODE === 'production') fatal = true;
      }
    } catch (e) {
      log.error(`No se pudo cargar el tenant ${tenantId}`, { error: e });
      if (env.APP_MODE === 'production') fatal = true;
    }
  }
  return !fatal;
}

function main(): void {
  getDb();

  if (!preflight()) {
    log.error('APP_MODE=production con tenants inválidos. Arranque abortado.');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log.info('ATRIO en línea', {
      port: env.PORT,
      mode: env.APP_MODE,
      publicBaseUrl: env.PUBLIC_BASE_URL || '(sin definir)',
      webhook: env.PUBLIC_BASE_URL
        ? `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/twilio/whatsapp`
        : '(define PUBLIC_BASE_URL)',
    });
    if (!env.PUBLIC_BASE_URL && env.TWILIO_VALIDATE_SIGNATURE) {
      log.warn(
        'PUBLIC_BASE_URL vacío con validación de firma activa: los webhooks de Twilio serán rechazados.',
      );
    }
  });

  startInboundWorker();

  const shutdown = (signal: string) => {
    log.info(`Señal ${signal} recibida; cerrando`);
    stopInboundWorker();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('Promesa rechazada sin manejar', { error: reason });
  });
}

main();
