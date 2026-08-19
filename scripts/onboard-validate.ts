import { env } from '../src/config/env';
import { c, die, fail, heading, ok, out, requireTenantArg, warn } from '../src/lib/cli';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';
import { summarizeIssues, validateTenant } from '../src/tenants/tenant-validator';
import type { ValidationIssue } from '../src/tenants/config-schema';

function render(issues: ValidationIssue[]): void {
  const byFile = new Map<string, ValidationIssue[]>();
  for (const i of issues) {
    const list = byFile.get(i.file) ?? [];
    list.push(i);
    byFile.set(i.file, list);
  }
  for (const [file, list] of byFile) {
    out();
    out(c.bold(file));
    for (const i of list) {
      const tag = i.severity === 'ERROR' ? c.red('ERROR  ') : c.yellow('AVISO  ');
      const where = i.path ? c.gray(` ${i.path}`) : '';
      out(`  ${tag}${where} ${i.message}`);
    }
  }
}

function main(): void {
  const tenantId = requireTenantArg('onboard:validate');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}" en ${env.ONBOARDING_DIR}`);

  heading(`Validación — ${tenantId}  (APP_MODE=${env.APP_MODE})`);

  const { config, issues: parseIssues } = loadTenantConfig(tenantId);

  if (!config) {
    render(parseIssues);
    out();
    fail(`La configuración no se puede cargar. Corrige los errores de arriba.`);
    process.exit(1);
  }

  const issues = [...parseIssues, ...validateTenant(config, env.APP_MODE)];
  const { errors, warnings } = summarizeIssues(issues);

  if (issues.length === 0) {
    ok('Sin observaciones.');
  } else {
    render(issues);
  }

  heading('Resumen');
  out(`  Empresa:    ${config.company.company.name}`);
  out(`  Asistente:  ${config.company.assistant.display_name}`);
  out(`  Áreas:      ${Object.keys(config.departments.departments).length}`);
  out(
    `  Workflows:  ${Object.values(config.workflows.workflows).filter((w) => w.enabled).length} habilitados de ${Object.keys(config.workflows.workflows).length}`,
  );
  out(`  WhatsApp:   ${config.company.channels.whatsapp.enabled ? 'sí' : 'no'}`);
  out();
  if (errors > 0) fail(`${errors} error(es), ${warnings} aviso(s).`);
  else if (warnings > 0) warn(`0 errores, ${warnings} aviso(s).`);
  else ok('0 errores, 0 avisos.');
  out();

  process.exit(errors > 0 ? 1 : 0);
}

main();
