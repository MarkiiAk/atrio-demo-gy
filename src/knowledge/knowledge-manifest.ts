import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';
import type { Visibility } from '../types/domain';

export interface ManifestEntry {
  sourceName: string;
  visibility: Visibility;
  sourceType: string;
  uri: string | null;
  hash: string;
  bytes: number;
  cachedPath: string | null;
  openaiFileId: string | null;
  syncedAt: string | null;
}

export interface Manifest {
  tenantId: string;
  vectorStoreId: string | null;
  updatedAt: string;
  entries: Record<string, ManifestEntry>;
}

export function tenantCacheDir(tenantId: string): string {
  return path.join(env.CACHE_DIR, 'knowledge', tenantId);
}

export function websiteCacheDir(tenantId: string): string {
  return path.join(tenantCacheDir(tenantId), 'website');
}

export function manifestPath(tenantId: string): string {
  return path.join(tenantCacheDir(tenantId), 'manifest.json');
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function loadManifest(tenantId: string): Manifest {
  const file = manifestPath(tenantId);
  if (!fs.existsSync(file)) {
    return { tenantId, vectorStoreId: null, updatedAt: new Date().toISOString(), entries: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    return { ...parsed, tenantId, entries: parsed.entries ?? {} };
  } catch {
    return { tenantId, vectorStoreId: null, updatedAt: new Date().toISOString(), entries: {} };
  }
}

export function saveManifest(manifest: Manifest): void {
  const file = manifestPath(manifest.tenantId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

/** Clave estable de una fuente dentro del manifest. */
export function entryKey(visibility: Visibility, sourceName: string): string {
  return `${visibility}::${sourceName}`;
}

/** Convierte una URL en un nombre de archivo seguro y determinista. */
export function urlToFilename(url: string): string {
  const u = new URL(url);
  const slug = `${u.pathname}${u.search}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const suffix = sha256(url).slice(0, 8);
  return `${slug || 'index'}--${suffix}.md`;
}
