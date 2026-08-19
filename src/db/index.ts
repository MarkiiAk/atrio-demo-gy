import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { env, PROJECT_ROOT } from '../config/env';

export type Db = Database.Database;

let instance: Db | null = null;

function schemaSql(): string {
  // En dev el .sql vive junto al .ts; en dist/ no se copia, así que caemos al source.
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(PROJECT_ROOT, 'src', 'db', 'schema.sql'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  }
  throw new Error(`No se encontró schema.sql. Buscado en:\n${candidates.join('\n')}`);
}

/**
 * Abre (y crea si hace falta) la base SQLite. El esquema es idempotente
 * (`CREATE TABLE IF NOT EXISTS`), así que arrancar siempre lo aplica.
 */
export function getDb(): Db {
  if (instance) return instance;

  const file = env.DB_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schemaSql());
  migrate(db);

  instance = db;
  return db;
}

/**
 * Migraciones correctivas para bases creadas con un esquema anterior.
 * `CREATE TABLE IF NOT EXISTS` no altera una tabla que ya existe, así que los
 * cambios de forma sobre tablas vivas se aplican aquí, de forma idempotente.
 */
function migrate(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(onboarding_gaps)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const intent = columns.find((c) => c.name === 'intent');

  // v0.1: `intent` pasó de NULL-able a NOT NULL DEFAULT ''. En SQLite dos NULL
  // no colisionan en un índice UNIQUE, así que con la forma vieja los gaps sin
  // intent nunca agregaban por frecuencia.
  if (intent && intent.notnull === 0) {
    // Nada de UPDATE previo: normalizar los NULL in-place chocaría contra el
    // índice UNIQUE viejo. Se normaliza y agrupa al copiar a la tabla nueva.
    db.exec(`
      BEGIN;
      CREATE TABLE onboarding_gaps__new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        gap_type              TEXT NOT NULL,
        intent                TEXT NOT NULL DEFAULT '',
        topic                 TEXT NOT NULL,
        missing_information   TEXT,
        conversation_id       INTEGER,
        frequency             INTEGER NOT NULL DEFAULT 1,
        first_seen_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (tenant_id, gap_type, intent, topic)
      );
      INSERT INTO onboarding_gaps__new
        (tenant_id, gap_type, intent, topic, missing_information, conversation_id,
         frequency, first_seen_at, last_seen_at)
        SELECT tenant_id, gap_type, COALESCE(intent, ''), topic,
               MAX(missing_information), MAX(conversation_id),
               SUM(frequency), MIN(first_seen_at), MAX(last_seen_at)
          FROM onboarding_gaps
         GROUP BY tenant_id, gap_type, COALESCE(intent, ''), topic;
      DROP TABLE onboarding_gaps;
      ALTER TABLE onboarding_gaps__new RENAME TO onboarding_gaps;
      CREATE INDEX IF NOT EXISTS idx_gaps_tenant ON onboarding_gaps(tenant_id, frequency DESC);
      COMMIT;
    `);
  }
}

/** Cierra la conexión (tests, scripts one-shot). */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Timestamp uniforme, mismo formato que los DEFAULT del esquema. */
export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Marca un tenant como existente en DB (idempotente). */
export function ensureTenantRow(tenantId: string, name: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tenants (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = datetime('now')`,
  ).run(tenantId, name);
}

export function setTenantConfig(tenantId: string, key: string, value: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO tenant_config (tenant_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(tenantId, key, value);
}

export function getTenantConfig(tenantId: string, key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM tenant_config WHERE tenant_id = ? AND key = ?`)
    .get(tenantId, key) as { value: string | null } | undefined;
  return row?.value ?? null;
}
