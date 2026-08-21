import { c, die, heading, ok, option, out, positionals, warn, fail } from '../src/lib/cli';
import { crawlWebsite } from '../src/knowledge/website-crawler';
import { websiteCacheDir } from '../src/knowledge/knowledge-manifest';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';

async function main(): Promise<void> {
  const [tenantId, urlArg] = positionals();
  if (!tenantId) die('Uso: npm run knowledge:web-sync -- <tenant-id> [url] [--max 40] [--delay 600] [--no-robots]');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);

  const { config } = loadTenantConfig(tenantId);
  const url = urlArg || config?.company.company.website || '';
  if (!url) {
    die(
      `No se indicó URL y company.yaml no tiene website.\nUso: npm run knowledge:web-sync -- ${tenantId} https://ejemplo.com`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    die(`URL inválida: ${url}`);
  }

  // Tope de seguridad, no criterio de fin: el crawl termina al agotar el sitio.
  const maxPages = Number.parseInt(option('max', '500') as string, 10);
  const delayMs = Number.parseInt(option('delay', '600') as string, 10);
  const respectRobots = !process.argv.includes('--no-robots');

  heading(`Sincronización de sitio — ${tenantId}`);
  out(`  Origen:        ${parsed.origin}`);
  out(`  Tope seguridad:${String(maxPages).padStart(5)} páginas (el fin normal es agotar el sitio)`);
  out(`  Pausa:         ${delayMs} ms`);
  out(`  robots.txt:    ${respectRobots ? 'se respeta' : c.yellow('IGNORADO')}`);
  out();

  const result = await crawlWebsite(tenantId, parsed.toString(), {
    maxPages,
    delayMs,
    respectRobots,
  });

  out();
  ok(`${result.pages.length} página(s) indexadas de ${result.visited} visitadas.`);
  out(c.gray(`  Copia local: ${websiteCacheDir(tenantId)}`));

  // Diagnóstico del recorrido. Un catálogo truncado se ve igual que uno
  // completo si sólo se cuenta páginas, así que se dice explícitamente.
  out();
  out(c.bold('Diagnóstico del recorrido'));
  if (result.stoppedBecause === 'exhausted') {
    out(`  ${c.green('✓')} Terminó al agotar el sitio: no quedaron URLs por visitar.`);
  } else {
    fail(`Se detuvo por el tope de seguridad. Quedan ${result.pending} URL(s) sin visitar.`);
    out(c.yellow(`    El catálogo está INCOMPLETO. Repite con --max ${maxPages * 2}.`));
  }
  out(`  URLs duplicadas descartadas: ${result.duplicates}`);
  out(`  Páginas sin contenido útil:  ${result.unparsed.length}`);
  const httpCodes = Object.entries(result.httpErrors);
  if (httpCodes.length === 0) {
    out(`  Errores HTTP:               0`);
  } else {
    out(`  Errores HTTP:               ${httpCodes.map(([k, v]) => `${v}× ${k}`).join(', ')}`);
  }

  if (result.pages.length > 0) {
    out();
    out(c.bold('Páginas'));
    for (const p of result.pages.slice(0, 25)) {
      out(`  ${c.gray('·')} ${p.title.slice(0, 60).padEnd(62)} ${c.gray(`${Math.round(p.bytes / 1024)} KB`)}`);
    }
    if (result.pages.length > 25) out(c.gray(`  … y ${result.pages.length - 25} más`));
  }

  const reasons = new Map<string, number>();
  for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  if (reasons.size > 0) {
    out();
    out(c.bold('Omitidas'));
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      out(c.gray(`  ${String(n).padStart(3)}x ${reason}`));
    }
  }

  if (result.pages.length === 0) {
    warn('No se indexó ninguna página. Revisa que el sitio devuelva HTML y no requiera JavaScript para renderizar.');
  }

  out();
  out(`Siguiente paso: ${c.cyan(`npm run onboard:sync -- ${tenantId}`)} para subirlas al vector store.`);
  out();
}

main().catch((e) => die('Falló el crawl', e));
