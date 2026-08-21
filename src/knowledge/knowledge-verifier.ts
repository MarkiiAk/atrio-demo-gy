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
 * Corpus contra el que se verifica QUÉ VENDE la empresa.
 *
 * Cuando el tenant declara `catalog_sources`, sólo esas páginas cuentan: son la
 * fuente de verdad del catálogo. El resto del sitio —blog, "quiénes somos",
 * notas— puede mencionar un químico sin que la empresa lo venda, y tomarlo como
 * catálogo haría que el asistente ofreciera algo inexistente.
 *
 * Los documentos autorizados del onboarding siempre cuentan: los sube el propio
 * cliente para que se usen.
 */
function loadCorpus(config: TenantConfig): Corpus {
  const cached = cache.get(config.tenantId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached;

  const patterns = config.company.company.catalog_sources
    .map((p) => normalize(p))
    .filter(Boolean);

  const parts: string[] = [
    ...readWebsite(config.tenantId, patterns),
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

/** Páginas del sitio que cuentan como catálogo. Sin patrones, todas. */
function readWebsite(tenantId: string, patterns: string[]): string[] {
  const dir = websiteCacheDir(tenantId);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => patterns.length === 0 || patterns.some((p) => normalize(f).includes(p)))
    .map((f) => {
      try {
        return fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
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

/**
 * ¿La persona pidió algo que NO está en el catálogo, aunque el modelo no lo
 * haya registrado en ningún campo?
 *
 * Se usa como respaldo cuando el campo verificable quedó vacío. Sólo avisa
 * cuando NINGÚN candidato del mensaje aparece en la documentación: si alguno
 * coincide, es que la persona está pidiendo algo que sí manejamos y no hay nada
 * que advertir. Ante la duda, se calla — un falso aviso haría que el asistente
 * niegue productos que sí existen.
 */
export function detectUnknownRequest(
  config: TenantConfig,
  candidates: string[],
): string | null {
  if (candidates.length === 0) return null;

  const checked = candidates
    .map((term) => ({ term, result: verifyTerm(config, term) }))
    .filter((c) => c.result !== 'NO_KNOWLEDGE');

  if (checked.length === 0) return null;
  if (checked.some((c) => c.result === 'FOUND')) return null;

  // Ninguno existe: se reporta el más específico (el más largo).
  return checked[0].term;
}

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

/**
 * Campos verificables cuyo valor NO aparece en lo que la persona escribió.
 *
 * Detecta una sustitución silenciosa. Caso real: alguien pidió cotizar
 * "acetona" —que la empresa no vende— y el modelo registró "acetato", que sí
 * está en el catálogo. La verificación contra el catálogo lo aprobó, y a Ventas
 * le llegó la cotización de un producto que nadie pidió.
 *
 * Existir en el catálogo no basta: el dato también tiene que ser lo que la
 * persona dijo. Un producto plausible en el lugar del pedido real es peor que un
 * hueco, porque nadie lo cuestiona.
 */
export function findSubstitutedFields(
  config: TenantConfig,
  workflowKey: string,
  fields: Record<string, string>,
  userMessages: string[],
): Array<{ field: string; value: string }> {
  const wf = config.workflows.workflows[workflowKey];
  if (!wf || wf.verify_against_knowledge.length === 0) return [];

  const said = normalize(userMessages.join(' \n '));
  if (!said) return [];

  const out: Array<{ field: string; value: string }> = [];
  for (const field of wf.verify_against_knowledge) {
    const value = fields[field];
    if (!value) continue;

    // Basta con que la palabra significativa más larga del valor aparezca en la
    // conversación: así "Tolueno" contra "quiero tolueno" pasa, y no se exige
    // una coincidencia literal de la frase completa.
    const words = normalize(value)
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .sort((a, b) => b.length - a.length);

    if (words.length === 0) continue;
    const mentioned = words.some((w) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(said),
    );
    if (!mentioned) out.push({ field, value });
  }
  return out;
}
