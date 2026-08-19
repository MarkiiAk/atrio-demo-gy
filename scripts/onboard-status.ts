import { env } from '../src/config/env';
import { getDb } from '../src/db';
import { c, die, heading, out, requireTenantArg } from '../src/lib/cli';
import { knowledgeStatus } from '../src/knowledge/knowledge.service';
import { jobStats } from '../src/jobs/job.repository';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';
import { summarizeIssues, validateTenant } from '../src/tenants/tenant-validator';
import { buildUsageReport } from '../src/usage/usage.service';
import { senderFor } from '../src/channels/whatsapp/twilio.service';

function main(): void {
  const tenantId = requireTenantArg('onboard:status');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);

  const db = getDb();
  const { config, issues: parseIssues } = loadTenantConfig(tenantId);
  if (!config) die('La configuración no se puede cargar. Corre onboard:validate.');

  const issues = [...parseIssues, ...validateTenant(config, env.APP_MODE)];
  const { errors, warnings } = summarizeIssues(issues);
  const knowledge = knowledgeStatus(config);

  heading(`Estado — ${config.company.company.name} (${tenantId})`);

  out(c.bold('Configuración'));
  out(`  APP_MODE:      ${env.APP_MODE}`);
  out(`  Errores:       ${errors > 0 ? c.red(String(errors)) : c.green('0')}`);
  out(`  Avisos:        ${warnings > 0 ? c.yellow(String(warnings)) : '0'}`);
  out(`  Áreas:         ${Object.keys(config.departments.departments).length}`);
  out(
    `  Workflows:     ${Object.values(config.workflows.workflows).filter((w) => w.enabled).length} habilitados`,
  );

  out();
  out(c.bold('Canal'));
  out(`  WhatsApp:      ${config.company.channels.whatsapp.enabled ? c.green('activo') : c.gray('inactivo')}`);
  try {
    out(`  Sender:        ${config.company.channels.whatsapp.enabled ? senderFor(config) : '—'}`);
  } catch {
    out(`  Sender:        ${c.yellow('sin definir (company.yaml o TWILIO_WHATSAPP_FROM)')}`);
  }
  out(
    `  Webhook:       ${env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/twilio/whatsapp` : c.yellow('define PUBLIC_BASE_URL')}`,
  );
  out(`  Firma Twilio:  ${env.TWILIO_VALIDATE_SIGNATURE ? c.green('validando') : c.red('DESACTIVADA')}`);

  out();
  out(c.bold('Knowledge'));
  out(`  Vector store:  ${knowledge.vectorStoreId ?? c.yellow('sin crear (corre onboard:sync)')}`);
  out(`  Páginas web:   ${knowledge.websitePages}`);
  out(`  Docs públicos: ${knowledge.publicDocs}`);
  out(`  Docs autorizados: ${knowledge.customerSafeDocs}`);
  out(`  Último sync:   ${knowledge.lastSyncAt ?? c.gray('nunca')}`);

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM contacts WHERE tenant_id = @t)      AS contacts,
         (SELECT COUNT(*) FROM conversations WHERE tenant_id = @t) AS conversations,
         (SELECT COUNT(*) FROM messages WHERE tenant_id = @t)      AS messages,
         (SELECT COUNT(*) FROM cases WHERE tenant_id = @t)         AS cases,
         (SELECT COUNT(*) FROM cases WHERE tenant_id = @t AND status = 'ROUTED') AS routed,
         (SELECT COUNT(*) FROM onboarding_gaps WHERE tenant_id = @t) AS gaps`,
    )
    .get({ t: tenantId }) as Record<string, number>;

  out();
  out(c.bold('Actividad'));
  out(`  Contactos:     ${counts.contacts}`);
  out(`  Conversaciones:${String(counts.conversations).padStart(3)}`);
  out(`  Mensajes:      ${counts.messages}`);
  out(`  Casos:         ${counts.cases} (${counts.routed} canalizados)`);
  out(`  Gaps:          ${counts.gaps}`);

  const usage = buildUsageReport(tenantId, 30);
  out();
  out(c.bold('Consumo (30 días)'));
  out(`  Llamadas IA:   ${usage.openaiCalls}`);
  out(`  Tokens:        ${usage.totalTokens} (in ${usage.inputTokens} / out ${usage.outputTokens})`);
  out(`  Latencia media:${String(usage.avgLatencyMs).padStart(6)} ms`);

  const jobs = jobStats(tenantId);
  if (Object.keys(jobs).length > 0) {
    out();
    out(c.bold('Cola'));
    for (const [status, n] of Object.entries(jobs)) out(`  ${status.padEnd(12)} ${n}`);
  }

  out();
}

main();
