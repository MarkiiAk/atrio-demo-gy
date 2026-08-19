import { env } from '../src/config/env';
import { ensureTenantRow, getDb } from '../src/db';
import { c, die, fail, heading, ok, out, requireTenantArg, warn } from '../src/lib/cli';
import { syncKnowledge } from '../src/knowledge/knowledge.service';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';
import { summarizeIssues, validateTenant } from '../src/tenants/tenant-validator';

async function main(): Promise<void> {
  const tenantId = requireTenantArg('onboard:sync');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);
  if (!env.OPENAI_API_KEY) die('Falta OPENAI_API_KEY: la sincronización necesita OpenAI real.');

  getDb();

  heading(`Sincronización — ${tenantId}`);

  // 1 y 2. Validar YAMLs y TODOs antes de gastar un solo token.
  const { config, issues: parseIssues } = loadTenantConfig(tenantId);
  if (!config) {
    for (const i of parseIssues) fail(`${i.file} ${i.path}: ${i.message}`);
    die('Configuración inválida; no se sincroniza nada.');
  }

  const issues = [...parseIssues, ...validateTenant(config, env.APP_MODE)];
  const { errors, warnings } = summarizeIssues(issues);

  if (errors > 0) {
    for (const i of issues.filter((i) => i.severity === 'ERROR')) {
      fail(`${i.file} ${i.path}: ${i.message}`);
    }
    die(`${errors} error(es) de configuración. Corrige y vuelve a intentar.`);
  }

  ensureTenantRow(config.tenantId, config.company.company.name);

  out(c.gray('Indexando sitio, documentos públicos y documentos autorizados…'));
  const summary = await syncKnowledge(config);

  // ── Salida amigable ────────────────────────────────────────────────────────
  out();
  out(c.bold(c.green('TENANT READY')));
  out();
  out(c.bold('Company'));
  out(`  ${config.company.company.name}`);
  out(`  vector store: ${c.gray(summary.vectorStoreId)}`);
  out();
  out(c.bold('Knowledge'));
  out(`  Website pages:          ${summary.websitePages}`);
  out(`  Public documents:       ${summary.publicDocs}`);
  out(`  Customer-safe documents:${String(summary.customerSafeDocs).padStart(2)}`);
  out(
    c.gray(
      `  (+${summary.added} nuevas, ~${summary.updated} actualizadas, -${summary.removed} retiradas, =${summary.unchanged} sin cambios)`,
    ),
  );
  out();
  out(c.bold('Workflows'));
  for (const [key, wf] of Object.entries(config.workflows.workflows)) {
    out(`  ${wf.enabled ? c.green('✓') : c.gray('·')} ${key}${wf.enabled ? '' : c.gray(' (deshabilitado)')}`);
  }
  out();
  out(c.bold('Routing'));
  for (const [dept, target] of Object.entries(config.routing.routing)) {
    out(`  ${c.green('✓')} ${dept} ${c.gray(`→ ${target.type} (${target.confirmation_semantics})`)}`);
  }
  out();
  out(c.bold('Warnings'));
  out(`  ${warnings}`);
  if (warnings > 0) {
    for (const i of issues.filter((i) => i.severity === 'WARNING').slice(0, 12)) {
      out(c.gray(`    - ${i.file} ${i.path}: ${i.message}`));
    }
    if (warnings > 12) out(c.gray(`    … y ${warnings - 12} más (ver onboard:validate)`));
  }

  if (summary.errors.length > 0) {
    out();
    warn(`${summary.errors.length} fuente(s) no se pudieron indexar:`);
    for (const e of summary.errors) out(c.gray(`    - ${e}`));
  }

  out();
  ok(`Listo. Prueba con: ${c.cyan(`npm run chat -- ${tenantId}`)}`);
  out();
}

main().catch((e) => die('Falló la sincronización', e));
