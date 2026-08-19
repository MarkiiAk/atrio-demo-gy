import { getDb } from '../src/db';
import { c, die, flag, heading, out, requireTenantArg } from '../src/lib/cli';
import { buildGapReport, clearGaps } from '../src/onboarding/gap.service';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';

const TITLES: Record<string, string> = {
  UNANSWERED_KNOWLEDGE: 'Preguntas sin respaldo',
  MISSING_CLIENT_POLICY: 'Políticas del cliente sin definir',
  MISSING_ROUTING: 'Canalización pendiente',
  MISSING_WORKFLOW_RULE: 'Configuración pendiente',
  UNKNOWN_INTENT: 'Solicitudes no clasificadas',
  LOW_CONFIDENCE: 'Detecciones de baja confianza',
};

const ORDER = [
  'UNANSWERED_KNOWLEDGE',
  'MISSING_CLIENT_POLICY',
  'MISSING_WORKFLOW_RULE',
  'MISSING_ROUTING',
  'UNKNOWN_INTENT',
  'LOW_CONFIDENCE',
];

function main(): void {
  const tenantId = requireTenantArg('onboard:gaps');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);
  getDb();

  if (flag('clear')) {
    const n = clearGaps(tenantId);
    out(`${c.green('✓')} ${n} gap(s) eliminados para ${tenantId}.`);
    return;
  }

  const { config } = loadTenantConfig(tenantId);
  const name = config?.company.company.name ?? tenantId;
  const report = buildGapReport(tenantId);

  heading('ONBOARDING GAPS');
  out(name);
  out();
  out(`Conversaciones analizadas: ${report.conversationsAnalyzed}`);

  if (report.total === 0) {
    out();
    out(c.green('Sin gaps registrados. El asistente pudo respaldar todo lo que le preguntaron.'));
    out();
    return;
  }

  const keys = [...ORDER.filter((k) => report.byType[k]), ...Object.keys(report.byType).filter((k) => !ORDER.includes(k))];

  for (const key of keys) {
    const rows = report.byType[key];
    if (!rows || rows.length === 0) continue;
    out();
    out(c.bold(`${TITLES[key] ?? key}:`));
    for (const r of rows) {
      const freq = c.yellow(`${r.frequency}x`);
      const detail = r.missing_information ? c.gray(`  → ${r.missing_information}`) : '';
      out(`  ${freq} ${r.topic}`);
      if (detail) out(`      ${detail}`);
    }
  }

  out();
  out(c.gray(`Total de ocurrencias: ${report.total}`));
  out(c.gray('Cada línea es una pregunta que el cliente debería poder responder para su asistente.'));
  out(c.gray(`Para limpiar tras resolverlos: npm run onboard:gaps -- ${tenantId} --clear`));
  out();
}

main();
