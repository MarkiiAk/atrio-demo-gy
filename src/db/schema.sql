-- ATRIO — esquema base (SQLite).
-- Todo dato de negocio está scopeado por tenant_id. No existe una sola tabla
-- consultable sin tenant, y ese es el mecanismo primario de aislamiento.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Estado derivado del onboarding que sí necesita vivir en DB (no en YAML):
-- ids de vector store, sender de whatsapp resuelto, hash de config, etc.
CREATE TABLE IF NOT EXISTS tenant_config (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name  TEXT,
  primary_phone TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);

-- El teléfono NO es el identificador canónico: es una identidad más de un contacto.
CREATE TABLE IF NOT EXISTS external_identities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id        INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL,
  external_user_id  TEXT NOT NULL,
  phone             TEXT,
  profile_name      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, channel, external_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_contact ON external_identities(contact_id);

CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  ambiguity_count INTEGER NOT NULL DEFAULT 0,
  last_sentiment  TEXT,
  last_message_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_contact
  ON conversations(tenant_id, contact_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction           TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'TEXT',
  body                TEXT,
  provider            TEXT NOT NULL DEFAULT 'internal',
  provider_message_id TEXT,
  media_json          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
-- Idempotencia real: Twilio puede reintentar el mismo MessageSid.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_provider_sid
  ON messages(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  workflow_key    TEXT NOT NULL,
  department_key  TEXT,
  status          TEXT NOT NULL DEFAULT 'OPEN',
  urgency         TEXT NOT NULL DEFAULT 'NORMAL',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  routed_at       TEXT,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cases_conversation ON cases(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_cases_tenant ON cases(tenant_id, status);

CREATE TABLE IF NOT EXISTS case_intents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  intent      TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (case_id, intent)
);

CREATE TABLE IF NOT EXISTS case_data (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  field_key   TEXT NOT NULL,
  field_value TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'LLM',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (case_id, field_key)
);

CREATE TABLE IF NOT EXISTS routing_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  adapter     TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_routing_case ON routing_events(case_id);

CREATE TABLE IF NOT EXISTS inbound_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  scheduled_at    TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at       TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON inbound_jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_conversation ON inbound_jobs(conversation_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_message ON inbound_jobs(message_id);

CREATE TABLE IF NOT EXISTS onboarding_gaps (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gap_type              TEXT NOT NULL,
  -- Cadena vacía, NUNCA NULL: en SQLite dos NULL no colisionan en un índice
  -- UNIQUE, así que un intent nulo rompería la agregación por frecuencia
  -- (cada ocurrencia crearía una fila nueva en vez de sumar).
  intent                TEXT NOT NULL DEFAULT '',
  topic                 TEXT NOT NULL,
  missing_information   TEXT,
  conversation_id       INTEGER,
  frequency             INTEGER NOT NULL DEFAULT 1,
  first_seen_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, gap_type, intent, topic)
);
CREATE INDEX IF NOT EXISTS idx_gaps_tenant ON onboarding_gaps(tenant_id, frequency DESC);

CREATE TABLE IF NOT EXISTS usage_records (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id         INTEGER,
  model                   TEXT NOT NULL,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,
  openai_request_id       TEXT,
  latency_ms              INTEGER NOT NULL DEFAULT 0,
  twilio_inbound_messages INTEGER NOT NULL DEFAULT 0,
  twilio_outbound_messages INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage_records(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visibility        TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  source_name       TEXT NOT NULL,
  uri               TEXT,
  content_hash      TEXT NOT NULL,
  openai_file_id    TEXT,
  vector_store_id   TEXT,
  bytes             INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, visibility, source_name)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON knowledge_sources(tenant_id);

CREATE TABLE IF NOT EXISTS knowledge_syncs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  vector_store_id TEXT,
  added           INTEGER NOT NULL DEFAULT 0,
  updated         INTEGER NOT NULL DEFAULT 0,
  removed         INTEGER NOT NULL DEFAULT 0,
  unchanged       INTEGER NOT NULL DEFAULT 0,
  detail          TEXT
);

-- Callbacks de estado de mensajes salientes de Twilio (opcional pero útil).
CREATE TABLE IF NOT EXISTS delivery_statuses (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider            TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  status              TEXT NOT NULL,
  error_code          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_sid ON delivery_statuses(provider_message_id);
