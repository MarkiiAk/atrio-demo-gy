import { env } from '../src/config/env';
import { getDb } from '../src/db';
import { c, flag, heading, ok, option, out, warn } from '../src/lib/cli';

/**
 * Retención de datos. Borra conversaciones (y por cascada mensajes, casos y
 * jobs) más viejas que DATA_RETENTION_DAYS. Los registros de consumo y los gaps
 * se conservan: son agregados operativos, no contenido de conversación.
 */
function main(): void {
  const db = getDb();
  const days = Number.parseInt(option('days', String(env.DATA_RETENTION_DAYS)) as string, 10);
  const dryRun = !flag('apply');
  const cutoff = `-${days} days`;

  heading(`Purga de datos — retención ${days} días`);

  const doomed = db
    .prepare(
      `SELECT tenant_id, COUNT(*) AS n FROM conversations
        WHERE COALESCE(last_message_at, created_at) < datetime('now', ?)
        GROUP BY tenant_id`,
    )
    .all(cutoff) as Array<{ tenant_id: string; n: number }>;

  const messages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE conversation_id IN (
          SELECT id FROM conversations WHERE COALESCE(last_message_at, created_at) < datetime('now', ?)
        )`,
    )
    .get(cutoff) as { n: number };

  const statuses = db
    .prepare(`SELECT COUNT(*) AS n FROM delivery_statuses WHERE created_at < datetime('now', ?)`)
    .get(cutoff) as { n: number };

  const total = doomed.reduce((acc, d) => acc + d.n, 0);

  if (total === 0 && statuses.n === 0) {
    ok('No hay nada que purgar.');
    out();
    return;
  }

  for (const d of doomed) out(`  ${d.tenant_id.padEnd(24)} ${d.n} conversación(es)`);
  out(`  ${'(mensajes asociados)'.padEnd(24)} ${messages.n}`);
  out(`  ${'callbacks de entrega'.padEnd(24)} ${statuses.n}`);
  out();

  if (dryRun) {
    warn('Simulación. Nada se borró.');
    out(c.gray('  Para ejecutar de verdad:  npm run data:purge -- --apply'));
    out();
    return;
  }

  const result = db.transaction(() => {
    const conv = db
      .prepare(
        `DELETE FROM conversations WHERE COALESCE(last_message_at, created_at) < datetime('now', ?)`,
      )
      .run(cutoff).changes;
    const ds = db
      .prepare(`DELETE FROM delivery_statuses WHERE created_at < datetime('now', ?)`)
      .run(cutoff).changes;
    return { conv, ds };
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');

  ok(`${result.conv} conversación(es) y ${result.ds} callback(s) eliminados.`);
  out(c.gray('  Los registros de consumo y los gaps de onboarding se conservan.'));
  out();
}

main();
