import { env } from '../src/config/env';
import { getDb } from '../src/db';
import { heading, ok, out } from '../src/lib/cli';

/**
 * El esquema es idempotente, así que "migrar" es simplemente abrir la base.
 * Existe como comando explícito para poder preparar el archivo sin arrancar
 * el servidor (útil en CI y en el primer arranque).
 */
function main(): void {
  heading('Base de datos');
  const db = getDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;

  out(`  Archivo: ${env.DB_FILE}`);
  out(`  Tablas:  ${tables.length}`);
  for (const t of tables) out(`    · ${t.name}`);
  out();
  ok('Esquema aplicado.');
  out();
}

main();
