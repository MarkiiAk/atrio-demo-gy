import * as fs from 'fs';
import * as path from 'path';
import { getDb } from '../db';
import { log } from '../lib/logger';
import type { TenantConfig } from '../tenants/config-schema';
import type { Visibility } from '../types/domain';
import {
  entryKey,
  loadManifest,
  saveManifest,
  sha256,
  websiteCacheDir,
  type Manifest,
  type ManifestEntry,
} from './knowledge-manifest';
import { ensureVectorStore, removeFromStore, uploadToStore, waitForIngestion } from './vector-store.service';

/** Extensiones que tiene sentido mandar a File Search. */
const SUPPORTED_DOC_EXT = new Set([
  '.md',
  '.txt',
  '.pdf',
  '.html',
  '.htm',
  '.json',
  '.docx',
  '.pptx',
  '.csv',
]);

export interface CandidateSource {
  sourceName: string;
  visibility: Visibility;
  sourceType: string;
  uri: string | null;
  content: Buffer;
  hash: string;
}

export interface SyncSummary {
  vectorStoreId: string;
  websitePages: number;
  publicDocs: number;
  customerSafeDocs: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  errors: string[];
}

function knowledgeDir(config: TenantConfig, sub: 'public' | 'customer-safe'): string {
  return path.join(config.dir, 'knowledge', sub);
}

/**
 * Reúne todo lo que debe vivir en el vector store del tenant:
 *  - páginas del sitio ya crawleadas (caché local),
 *  - documentos públicos,
 *  - documentos autorizados por el cliente (CUSTOMER_SAFE).
 *
 * INTERNAL_RULES no aparece aquí a propósito: routing, destinatarios y reglas de
 * negocio viven en YAML y los consume la aplicación, nunca el RAG del cliente.
 */
export function collectSources(config: TenantConfig): CandidateSource[] {
  const out: CandidateSource[] = [];

  // 1. Sitio web (caché generada por el crawler).
  const webDir = websiteCacheDir(config.tenantId);
  if (fs.existsSync(webDir)) {
    for (const f of fs.readdirSync(webDir).filter((f) => f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(webDir, f));
      const uriMatch = content.toString('utf8').match(/<!-- fuente: (.+?) -->/);
      out.push({
        sourceName: `website/${f}`,
        visibility: 'PUBLIC',
        sourceType: 'WEBSITE',
        uri: uriMatch?.[1] ?? null,
        content,
        hash: sha256(content),
      });
    }
  }

  // 2 y 3. Documentos en disco.
  const docDirs: Array<{ dir: string; visibility: Visibility; sourceType: string }> = [
    { dir: knowledgeDir(config, 'public'), visibility: 'PUBLIC', sourceType: 'PUBLIC_DOCUMENT' },
    {
      dir: knowledgeDir(config, 'customer-safe'),
      visibility: 'CUSTOMER_SAFE',
      sourceType: 'CLIENT_ONBOARDING',
    },
  ];

  for (const { dir, visibility, sourceType } of docDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      if (f.startsWith('.') || f.toUpperCase() === 'README.MD') continue;
      if (!SUPPORTED_DOC_EXT.has(path.extname(f).toLowerCase())) continue;
      const content = fs.readFileSync(full);
      out.push({
        sourceName: `${visibility === 'PUBLIC' ? 'public' : 'customer-safe'}/${f}`,
        visibility,
        sourceType,
        uri: null,
        content,
        hash: sha256(content),
      });
    }
  }

  return out;
}

/**
 * Sincroniza el vector store con el estado en disco. Es incremental: un archivo
 * cuyo hash no cambió NO se vuelve a subir (ahorra tokens de embedding y tiempo).
 */
export async function syncKnowledge(config: TenantConfig): Promise<SyncSummary> {
  const tenantId = config.tenantId;
  const vectorStoreId = await ensureVectorStore(tenantId, config.company.company.name);
  const manifest: Manifest = loadManifest(tenantId);
  manifest.vectorStoreId = vectorStoreId;

  const sources = collectSources(config);
  const errors: string[] = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  const db = getDb();
  const syncId = db
    .prepare(`INSERT INTO knowledge_syncs (tenant_id, vector_store_id) VALUES (?, ?)`)
    .run(tenantId, vectorStoreId).lastInsertRowid as number;

  const liveKeys = new Set<string>();

  for (const src of sources) {
    const key = entryKey(src.visibility, src.sourceName);
    liveKeys.add(key);
    const prev: ManifestEntry | undefined = manifest.entries[key];

    if (prev && prev.hash === src.hash && prev.openaiFileId) {
      unchanged += 1;
      continue;
    }

    try {
      if (prev?.openaiFileId) {
        await removeFromStore(vectorStoreId, prev.openaiFileId);
      }

      const filename = safeUploadName(src.sourceName);
      const fileId = await uploadToStore({
        tenantId,
        vectorStoreId,
        filename,
        content: src.content,
        attributes: {
          tenant_id: tenantId,
          visibility: src.visibility,
          source_type: src.sourceType,
          source_name: src.sourceName,
          ...(src.uri ? { uri: src.uri.slice(0, 500) } : {}),
        },
      });

      manifest.entries[key] = {
        sourceName: src.sourceName,
        visibility: src.visibility,
        sourceType: src.sourceType,
        uri: src.uri,
        hash: src.hash,
        bytes: src.content.byteLength,
        cachedPath: null,
        openaiFileId: fileId,
        syncedAt: new Date().toISOString(),
      };

      db.prepare(
        `INSERT INTO knowledge_sources
           (tenant_id, visibility, source_type, source_name, uri, content_hash, openai_file_id, vector_store_id, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, visibility, source_name) DO UPDATE SET
           source_type = excluded.source_type,
           uri = excluded.uri,
           content_hash = excluded.content_hash,
           openai_file_id = excluded.openai_file_id,
           vector_store_id = excluded.vector_store_id,
           bytes = excluded.bytes,
           updated_at = datetime('now')`,
      ).run(
        tenantId,
        src.visibility,
        src.sourceType,
        src.sourceName,
        src.uri,
        src.hash,
        fileId,
        vectorStoreId,
        src.content.byteLength,
      );

      if (prev) updated += 1;
      else added += 1;
    } catch (e) {
      const msg = `${src.sourceName}: ${(e as Error).message}`;
      errors.push(msg);
      log.error('Falló la sincronización de una fuente', { tenant: tenantId, source: src.sourceName, error: e });
    }
  }

  // Purga de fuentes que ya no existen en disco.
  let removed = 0;
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (liveKeys.has(key)) continue;
    if (entry.openaiFileId) {
      await removeFromStore(vectorStoreId, entry.openaiFileId);
    }
    db.prepare(
      `DELETE FROM knowledge_sources WHERE tenant_id = ? AND visibility = ? AND source_name = ?`,
    ).run(tenantId, entry.visibility, entry.sourceName);
    delete manifest.entries[key];
    removed += 1;
  }

  saveManifest(manifest);

  if (added + updated > 0) {
    await waitForIngestion(vectorStoreId);
  }

  db.prepare(
    `UPDATE knowledge_syncs
        SET finished_at = datetime('now'), added = ?, updated = ?, removed = ?, unchanged = ?, detail = ?
      WHERE id = ?`,
  ).run(added, updated, removed, unchanged, errors.join(' | ') || null, syncId);

  const count = (pred: (s: CandidateSource) => boolean) => sources.filter(pred).length;

  return {
    vectorStoreId,
    websitePages: count((s) => s.sourceType === 'WEBSITE'),
    publicDocs: count((s) => s.sourceType === 'PUBLIC_DOCUMENT'),
    customerSafeDocs: count((s) => s.visibility === 'CUSTOMER_SAFE'),
    added,
    updated,
    removed,
    unchanged,
    errors,
  };
}

/** OpenAI infiere el tipo por la extensión; garantizamos una válida y sin rutas. */
function safeUploadName(sourceName: string): string {
  const base = sourceName.replace(/[\\/]/g, '__');
  return SUPPORTED_DOC_EXT.has(path.extname(base).toLowerCase()) ? base : `${base}.md`;
}

export interface KnowledgeStatus {
  vectorStoreId: string | null;
  websitePages: number;
  publicDocs: number;
  customerSafeDocs: number;
  lastSyncAt: string | null;
}

export function knowledgeStatus(config: TenantConfig): KnowledgeStatus {
  const manifest = loadManifest(config.tenantId);
  const entries = Object.values(manifest.entries);
  const lastSync = getDb()
    .prepare(
      `SELECT finished_at FROM knowledge_syncs WHERE tenant_id = ? AND finished_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(config.tenantId) as { finished_at: string } | undefined;

  return {
    vectorStoreId: manifest.vectorStoreId,
    websitePages: entries.filter((e) => e.sourceType === 'WEBSITE').length,
    publicDocs: entries.filter((e) => e.sourceType === 'PUBLIC_DOCUMENT').length,
    customerSafeDocs: entries.filter((e) => e.visibility === 'CUSTOMER_SAFE').length,
    lastSyncAt: lastSync?.finished_at ?? null,
  };
}
