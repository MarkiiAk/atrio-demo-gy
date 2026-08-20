import { getTenantConfig as getStoredConfig, setTenantConfig } from '../db';
import { log } from '../lib/logger';
import { openai } from '../ai/openai.service';
import { loadManifest } from './knowledge-manifest';

const VS_KEY = 'vector_store_id';

/**
 * Un vector store POR TENANT. Es el mecanismo de aislamiento fuerte de knowledge:
 * ninguna consulta puede alcanzar documentos de otro cliente porque el id del
 * store se resuelve siempre desde el tenant en curso.
 */
export async function ensureVectorStore(tenantId: string, tenantName: string): Promise<string> {
  const existing = getStoredConfig(tenantId, VS_KEY);
  if (existing) {
    try {
      await openai().vectorStores.retrieve(existing);
      return existing;
    } catch {
      log.warn('El vector store registrado ya no existe en OpenAI; se creará uno nuevo', {
        tenant: tenantId,
      });
    }
  }

  const created = await openai().vectorStores.create({
    name: `atrio-${tenantId}`,
    metadata: { tenant_id: tenantId, tenant_name: tenantName.slice(0, 120) },
  });
  setTenantConfig(tenantId, VS_KEY, created.id);
  log.info('Vector store creado', { tenant: tenantId, vectorStoreId: created.id });
  return created.id;
}

/**
 * Vector store del tenant, o `null` si no hay conocimiento indexado.
 *
 * Se consulta primero la base y, si está vacía, el manifest del onboarding.
 * Ese doble camino no es redundancia: el id se guarda en la base al sincronizar,
 * pero un despliegue nuevo arranca con la base en blanco mientras el manifest sí
 * viaja en el repo. Sin este respaldo el asistente perdía el RAG al desplegar
 * —respondía sin catálogo y sin darse cuenta— aunque el conocimiento siguiera
 * perfectamente indexado en OpenAI.
 */
export function getVectorStoreId(tenantId: string): string | null {
  const stored = getStoredConfig(tenantId, VS_KEY);
  if (stored) return stored;

  const fromManifest = loadManifest(tenantId).vectorStoreId;
  if (!fromManifest) return null;

  // Se persiste para no volver a leer el archivo en cada turno.
  setTenantConfig(tenantId, VS_KEY, fromManifest);
  log.info('Vector store recuperado del manifest de onboarding', {
    tenant: tenantId,
    vectorStoreId: fromManifest,
  });
  return fromManifest;
}

export interface UploadInput {
  tenantId: string;
  vectorStoreId: string;
  filename: string;
  content: Buffer;
  attributes: Record<string, string>;
}

/**
 * Sube un archivo y lo asocia al store con sus atributos de metadata.
 * Los atributos permiten filtrar por visibilidad en tiempo de consulta.
 */
export async function uploadToStore(input: UploadInput): Promise<string> {
  const client = openai();

  const file = await client.files.create({
    file: new File([new Uint8Array(input.content)], input.filename, { type: 'text/markdown' }),
    purpose: 'assistants',
  });

  await client.vectorStores.files.create(input.vectorStoreId, {
    file_id: file.id,
    attributes: input.attributes,
  });

  return file.id;
}

/** Quita un archivo del store y lo borra del almacenamiento de OpenAI. */
export async function removeFromStore(vectorStoreId: string, fileId: string): Promise<void> {
  const client = openai();
  try {
    await client.vectorStores.files.delete(fileId, { vector_store_id: vectorStoreId });
  } catch (e) {
    log.warn('No se pudo desasociar el archivo del vector store', { fileId, error: e });
  }
  try {
    await client.files.delete(fileId);
  } catch (e) {
    log.warn('No se pudo borrar el archivo de OpenAI', { fileId, error: e });
  }
}

/** Espera a que el store termine de procesar (los archivos recién subidos se indexan async). */
export async function waitForIngestion(vectorStoreId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const vs = await openai().vectorStores.retrieve(vectorStoreId);
    const counts = vs.file_counts;
    if (!counts || counts.in_progress === 0) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  log.warn('Se agotó el tiempo esperando la indexación del vector store', { vectorStoreId });
}
