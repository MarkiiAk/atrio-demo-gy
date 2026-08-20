import * as fs from 'fs';
import * as path from 'path';
import type { TenantConfig } from '../tenants/config-schema';
import { websiteCacheDir } from './knowledge-manifest';

/**
 * Verificación DETERMINISTA de términos contra el conocimiento del tenant.
 *
 * Por qué existe: el prompt le pide al modelo que verifique antes de afirmar,
 * pero una instrucción se puede ignorar. En un caso real, un cliente escribió
 * "vi en su página que venden acetona" y el asistente le creyó y armó una
 * cotización de 1000 litros de un producto que NO está en el catálogo (venden
 * acetatos, que es otra cosa). Que el cliente afirme algo no lo vuelve cierto.
 *
 * La misma copia local que alimenta el vector store sirve para comprobarlo aquí,
 * sin gastar una llamada a la API y sin depender de la buena fe del modelo.
 */

export type VerificationResult = 'FOUND' | 'NOT_FOUND' | 'NO_KNOWLEDGE';

interface Corpus {
  text: string;
  loadedAt: number;
  fileCount: number;
}

const cache = new Map<string, Corpus>();
const TTL_MS = 60_000;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readDir(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      try {
        return fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * Corpus consultable: el caché del sitio más los documentos de texto del
 * onboarding. Los PDF y binarios no se leen aquí — para ellos la verificación
 * devuelve lo que encuentre en el resto, y ante la duda no se afirma nada.
 */
function loadCorpus(config: TenantConfig): Corpus {
  const cached = cache.get(config.tenantId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached;

  const parts: string[] = [
    ...readDir(websiteCacheDir(config.tenantId), ['.md']),
    ...readDir(path.join(config.dir, 'knowledge', 'public'), ['.md', '.txt', '.json', '.csv']),
    ...readDir(path.join(config.dir, 'knowledge', 'customer-safe'), ['.md', '.txt', '.json', '.csv']),
  ];

  const corpus: Corpus = {
    text: normalize(parts.join('\n')),
    loadedAt: Date.now(),
    fileCount: parts.length,
  };
  cache.set(config.tenantId, corpus);
  return corpus;
}

export function clearVerifierCache(): void {
  cache.clear();
}

/**
 * ¿Aparece el término en la documentación autorizada del tenant?
 *
 * Deliberadamente estricto con los límites de palabra: en catálogos químicos
 * "acetona" y "acetato" comparten prefijo pero son productos distintos, y una
 * coincidencia por subcadena haría pasar justo el error que esto previene.
 */
export function verifyTerm(config: TenantConfig, term: string): VerificationResult {
  const corpus = loadCorpus(config);
  if (corpus.fileCount === 0) return 'NO_KNOWLEDGE';

  const needle = normalize(term)
    // Se ignoran cantidades y unidades: lo que se verifica es el producto.
    .replace(/\b\d[\d.,]*\s*(l|lt|lts|litros?|kg|kgs|kilos?|ton|toneladas?|m3|piezas?|pzas?)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (needle.length < 3) return 'NO_KNOWLEDGE';

  // Se buscan las palabras significativas del término; todas deben aparecer
  // como palabra completa en algún punto del corpus.
  const words = needle.split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (words.length === 0) return 'NO_KNOWLEDGE';

  const allPresent = words.every((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(corpus.text);
  });

  return allPresent ? 'FOUND' : 'NOT_FOUND';
}

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'para',
  'con',
  'por',
  'que',
  'and',
  'the',
  'of',
]);

export interface FieldVerification {
  workflowKey: string;
  field: string;
  value: string;
  result: VerificationResult;
}

/**
 * Verifica los campos que el workflow marcó como comprobables contra el
 * catálogo. Devuelve sólo los que NO se pudieron confirmar: son los que el
 * asistente debe dejar de tratar como algo que la empresa ofrece.
 */
export function verifyCaseFields(
  config: TenantConfig,
  workflowKey: string,
  fields: Record<string, string>,
): FieldVerification[] {
  const wf = config.workflows.workflows[workflowKey];
  if (!wf || wf.verify_against_knowledge.length === 0) return [];

  const out: FieldVerification[] = [];
  for (const field of wf.verify_against_knowledge) {
    const value = fields[field];
    if (!value) continue;
    const result = verifyTerm(config, value);
    if (result === 'NOT_FOUND') {
      out.push({ workflowKey, field, value, result });
    }
  }
  return out;
}
