import { c, die, fail, heading, ok, out, positionals, warn } from '../src/lib/cli';
import {
  auditCatalog,
  catalogPath,
  hasKnownPresentations,
  loadCatalog,
  presentationSummary,
} from '../src/knowledge/product-catalog';
import { resolveTerm } from '../src/knowledge/knowledge-verifier';
import { requireTenantConfig, tenantExists } from '../src/tenants/tenant-loader';

/**
 * Revisa el catálogo declarado y prueba la resolución de términos.
 *
 * Existe porque una colisión de alias o un producto mal declarado sólo se notaba
 * en una conversación con un cliente. Aquí se ve antes de publicar.
 *
 *   npm run catalog:check -- grupo-yoma
 *   npm run catalog:check -- grupo-yoma "MEK" "acetona" "108-10-1" "thinner"
 */

/** Términos que cubren los fallos reales que ya nos costaron una venta. */
const DEFAULT_PROBES = [
  'MEK',
  'metil etil cetona',
  'MIBK',
  'metil isobutil cetona',
  'acetona',
  'thinner americano',
  'thiner americano',
  '27 tambos de thiner americano',
  'sosa caustica',
  'hidroxido de sodio',
  'etanol',
  'alcohol etilico',
  'isopropanol',
  'IPA',
  'DOP',
  'toluol',
  'tolueno en tambo',
  'exxsol d40',
  'trietanolamina 85%',
  '108-10-1',
  '141-78-6',
  'thinner',
  'alcohol',
  'cetona',
  'ftalato',
  'oxido nitroso',
  'pito en tambo',
];

function main(): void {
  const [tenantId, ...probes] = positionals();
  if (!tenantId) die('Uso: npm run catalog:check -- <tenant-id> [término...]');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);

  const catalog = loadCatalog(tenantId);
  if (!catalog) {
    die(
      `No hay catálogo declarado en ${catalogPath(tenantId)}.\n` +
        'Sin catálogo el asistente no puede afirmar ni negar ningún producto.',
    );
  }

  heading(`Catálogo declarado — ${tenantId}`);
  out(`  Archivo:   ${catalogPath(tenantId)}`);
  out(`  Catálogo:  ${catalog.catalogName || '(sin nombre)'} · v${catalog.schemaVersion}`);
  out(`  Generado:  ${catalog.generatedAt || '(sin fecha)'}`);
  out();

  const audit = auditCatalog(catalog);
  out(c.bold('Contenido'));
  out(`  Productos declarados:        ${audit.products}`);
  out(`  Con CAS:                     ${audit.withCas}`);
  out(`  Con presentaciones conocidas:${String(audit.withPresentations).padStart(4)}`);
  out(
    `  Sólo existencia (sin envases):${String(audit.existenceOnly).padStart(3)} ` +
      c.gray('← existen, pero hay que preguntar presentación'),
  );
  out(`  Aliases oficiales / comunes: ${audit.aliasesOfficial} / ${audit.aliasesCommon}`);
  out();

  out(c.bold('Integridad'));
  if (audit.duplicateIds.length === 0) ok('Sin ids duplicados.');
  else fail(`Ids duplicados: ${audit.duplicateIds.join(', ')}`);

  if (audit.aliasCollisions.length === 0) {
    ok('Sin colisiones: ningún término apunta a dos productos.');
  } else {
    fail(`${audit.aliasCollisions.length} colisión(es) de identidad:`);
    for (const col of audit.aliasCollisions.slice(0, 10)) {
      out(c.yellow(`    "${col.term}" → ${col.products.join(' / ')}`));
    }
    out(c.gray('    Una colisión hace que el término quede AMBIGUO en vez de resolver.'));
  }
  out();

  const flags = Object.entries(audit.flags).sort((a, b) => b[1] - a[1]);
  if (flags.length > 0) {
    out(c.bold('Avisos de calidad del dato publicado') + c.gray('  (telemetría interna)'));
    for (const [flag, n] of flags) out(c.gray(`  ${String(n).padStart(3)}x ${flag}`));
    out();
  }

  // ── Resolución ─────────────────────────────────────────────────────────────
  const terms = probes.length > 0 ? probes : DEFAULT_PROBES;
  out(c.bold('Resolución de términos'));
  out(c.gray('  MATCH exige identidad declarada. AMBIGUOUS = hay que preguntar cuál.'));
  out();

  // Se prueba por la MISMA vía que usa el motor, que limpia cantidades y envases
  // antes de resolver. Probar el resolver crudo daría un resultado más optimista
  // que el real para frases como "27 tambos de thinner americano".
  const config = requireTenantConfig(tenantId);

  const tally: Record<string, number> = {};
  for (const term of terms) {
    const r = resolveTerm(config, term);
    tally[r.status] = (tally[r.status] ?? 0) + 1;

    const label = `"${term}"`.padEnd(34);
    if (r.status === 'MATCH' && r.product) {
      const detail = hasKnownPresentations(r.product)
        ? c.gray(presentationSummary(r.product).slice(0, 52))
        : c.yellow('sin presentaciones publicadas');
      out(
        `  ${c.green('MATCH    ')} ${label} → ${r.product.canonicalName}` +
          `${r.matchedVariant ? ` [${r.matchedVariant}]` : ''} ${c.gray(`(${r.matchedBy})`)}`,
      );
      out(`  ${' '.repeat(10)} ${' '.repeat(34)}   ${detail}`);
    } else if (r.status === 'AMBIGUOUS') {
      const names = (r.candidates ?? []).map((p: { canonicalName: string }) => p.canonicalName);
      out(
        `  ${c.cyan('AMBIGUOUS')} ${label} → ${names.length} candidato(s) ${c.gray(`(${r.matchedBy ?? 'exacto'})`)}`,
      );
      out(c.gray(`  ${' '.repeat(10)} ${' '.repeat(34)}   ${names.slice(0, 5).join(' · ')}${names.length > 5 ? ` … +${names.length - 5}` : ''}`));
    } else if (r.status === 'NO_MATCH') {
      out(`  ${c.yellow('NO_MATCH ')} ${label} ${c.gray('→ no está en el catálogo')}`);
    } else {
      out(`  ${c.gray('NO_KNOWL.')} ${label} ${c.gray('→ no se puede afirmar ni negar')}`);
    }
  }

  out();
  out(c.bold('Resumen') + c.gray(`  (${terms.length} término(s))`));
  for (const [status, n] of Object.entries(tally)) out(`  ${status.padEnd(12)} ${n}`);
  out();

  if (audit.existenceOnly > 0) {
    warn(
      `${audit.existenceOnly} producto(s) existen sin presentaciones publicadas: el asistente ` +
        'debe confirmar que se manejan y preguntar el envase, nunca inventarlo.',
    );
  }
  out();
}

main();
