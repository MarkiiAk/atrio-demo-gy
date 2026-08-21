import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { env } from '../config/env';
import { log } from '../lib/logger';

/**
 * CATÁLOGO DECLARADO — la única fuente de verdad sobre qué existe.
 *
 * Antes la existencia se decidía buscando subcadenas en el markdown crawleado
 * del sitio. Eso negaba productos reales: las fichas HTML cubren 38 de los 63
 * renglones del catálogo oficial 2025, así que Acetona, Metil Etil Cetona,
 * Thinner Americano y Sosa Cáustica —productos que la empresa sí vende— se
 * rechazaban como inexistentes. Cuatro ventas negadas por medir contra la
 * fuente equivocada.
 *
 * Ahora el tenant declara su catálogo en `onboarding/<tenant>/catalog.json` y
 * este módulo sólo lo lee y lo valida. Vive en `onboarding/` y no en la caché a
 * propósito: viaja en el repo, así que no puede faltar en un despliegue como
 * pasó con el vector store.
 *
 * Separación que sostiene todo lo demás:
 *
 *   EXISTENCIA → este catálogo. Si un producto no está declarado, no se afirma.
 *   DETALLE    → fichas del sitio y RAG documental (CAS, presentaciones,
 *                aplicaciones). El PDF no trae presentaciones, así que estar
 *                declarado NO implica conocer envases ni volúmenes.
 *
 * El RAG documental (`file_search` sobre el vector store) no se toca: sigue
 * siendo lo que redacta y da contexto. Lo que cambia es quién decide existencia.
 */

// ── Contrato del archivo declarado ───────────────────────────────────────────

const PresentationSchema = z
  .object({
    container: z.string().default(''),
    unit: z.string().default(''),
    raw: z.string().default(''),
    /** Tamaños concretos publicados: "Tambos: 200 L y 208 L" → [200, 208]. */
    quantities: z.array(z.number()).default([]),
    /** Algunas fichas publican un rango en lugar de tamaños discretos. */
    minQuantity: z.number().optional(),
    maxQuantity: z.number().optional(),
  })
  .passthrough();

const VariantSchema = z
  .object({ grade: z.string().default(''), sourceName: z.string().default('') })
  .passthrough();

const ProductSchema = z
  .object({
    id: z.string().min(1),
    canonicalName: z.string().min(1),
    /** Aliases que la propia empresa publica (el "(MEK)" del renglón del PDF). */
    aliasesOfficial: z.array(z.string()).default([]),
    /** Nombres químicos de uso común, para resolver, nunca para probar existencia. */
    aliasesCommon: z.array(z.string()).default([]),
    /** Grados del mismo producto: Trietanolamina 85% y 99%. */
    variants: z.array(VariantSchema).default([]),
    /**
     * Familias declaradas a las que pertenece. Es una LISTA y no un campo único
     * porque un producto pertenece a varios grupos legítimos: Dioctil Ftalato es
     * de la familia `ftalato` y de la familia `dioctil`, y elegir una sola sería
     * arbitrario.
     */
    families: z.array(z.string()).default([]),
    cas: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    presentations: z.array(PresentationSchema).default([]),
    applications: z.array(z.string()).default([]),
    /**
     * Cómo escribe la empresa este producto en cada fuente. Cuentan como
     * identidad oficial: el PDF dice "Alcohol Etilico de Caña" y la ficha dice
     * "Alcohol Etílico", y quien pregunte por cualquiera de las dos formas debe
     * resolver al mismo producto sin que eso sea un parecido semántico.
     */
    sourceNames: z
      .object({
        pdf2025: z.array(z.string()).default([]),
        web: z.array(z.string()).default([]),
      })
      .default({ pdf2025: [], web: [] }),
    sourcePresence: z
      .object({
        pdf2025: z.boolean().default(false),
        webCatalog: z.boolean().default(false),
        detailPage: z.boolean().default(false),
      })
      .default({ pdf2025: false, webCatalog: false, detailPage: false }),
    sourceUrls: z.array(z.string()).default([]),
    /** Avisos de calidad del dato publicado. Telemetría interna, nunca al cliente. */
    dataQualityFlags: z.array(z.string()).default([]),
  })
  .passthrough();

const ResolverConfigSchema = z
  .object({
    /** Orden en que se intentan las identidades. El primero que coincide gana. */
    matchOrder: z
      .array(z.enum(['canonicalName', 'aliasesOfficial', 'aliasesCommon', 'cas']))
      .default(['canonicalName', 'aliasesOfficial', 'aliasesCommon', 'cas']),
    /** Si es true, el parecido semántico NUNCA puede producir un MATCH. */
    noSemanticExistenceProof: z.boolean().default(true),
    /** Si un término exacto apunta a varios productos, es ambiguo, no el primero. */
    ambiguousIfMultipleExactAliasTargets: z.boolean().default(true),
  })
  .passthrough();

/**
 * Familia de productos: un término que la gente usa para pedir un GRUPO, no un
 * producto. "thinner" son tres productos distintos y elegir uno le vendería a
 * alguien algo que no pidió.
 *
 * Las familias son DECLARADAS y cerradas. La alternativa —tratar cualquier
 * palabra de un nombre canónico como término de grupo— convertía en familia a
 * `butil`, `monomero` o `dioctil` sin que nadie lo decidiera, y dependía de cómo
 * estuviera escrito cada nombre. Aquí sólo agrupa lo que está escrito aquí.
 */
const FamilySchema = z
  .object({
    /** Cómo se le llama al grupo al hablarle al cliente: "tipos de thinner". */
    label: z.string().default(''),
    /** Términos exactos que piden este grupo, erratas incluidas. */
    terms: z.array(z.string()).default([]),
  })
  .passthrough();

const CatalogSchema = z
  .object({
    schemaVersion: z.string().default('1.0.0'),
    catalogName: z.string().default(''),
    generatedAt: z.string().default(''),
    products: z.array(ProductSchema).min(1),
    families: z.record(z.string(), FamilySchema).default({}),
    // Si el catálogo no declara política de resolución se usa la más estricta:
    // nada de parecidos semánticos y ambigüedad antes que elegir por la persona.
    resolverConfig: ResolverConfigSchema.default({
      matchOrder: ['canonicalName', 'aliasesOfficial', 'aliasesCommon', 'cas'],
      noSemanticExistenceProof: true,
      ambiguousIfMultipleExactAliasTargets: true,
    }),
  })
  .passthrough();

export type ProductPresentation = z.infer<typeof PresentationSchema>;
export type ProductVariant = z.infer<typeof VariantSchema>;
export type ProductEntity = z.infer<typeof ProductSchema>;
export type ResolverConfig = z.infer<typeof ResolverConfigSchema>;
export type ProductCatalog = z.infer<typeof CatalogSchema> & { tenantId: string };

export function catalogPath(tenantId: string): string {
  return path.join(env.ONBOARDING_DIR, tenantId, 'catalog.json');
}

// ── Lectura ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  loadedAt: number;
  mtimeMs: number;
  catalog: ProductCatalog | null;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/**
 * Carga el catálogo declarado del tenant. Devuelve `null` cuando no hay
 * catálogo: eso NO autoriza a negar productos, sólo significa que no se sabe.
 *
 * Se relee si cambia el mtime, para que editar el catálogo en desarrollo no
 * exija reiniciar el proceso.
 */
export function loadCatalog(tenantId: string): ProductCatalog | null {
  const file = catalogPath(tenantId);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.set(tenantId, { loadedAt: Date.now(), mtimeMs: 0, catalog: null });
    return null;
  }

  const hit = cache.get(tenantId);
  if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.loadedAt < TTL_MS) {
    return hit.catalog;
  }

  let catalog: ProductCatalog | null = null;
  try {
    const parsed = CatalogSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed.success) {
      catalog = { ...parsed.data, tenantId };
    } else {
      // Se prefiere quedarse sin catálogo antes que con uno a medias: un catálogo
      // parcial haría negar productos declarados, que es el fallo que esto evita.
      log.error('catalog.json no cumple el contrato; el tenant queda SIN catálogo', {
        tenant: tenantId,
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
  } catch (e) {
    log.error('catalog.json ilegible; el tenant queda SIN catálogo', { tenant: tenantId, error: e });
  }

  cache.set(tenantId, { loadedAt: Date.now(), mtimeMs, catalog });
  return catalog;
}

export function clearCatalogCache(): void {
  cache.clear();
}

// ── Normalización ────────────────────────────────────────────────────────────

/**
 * Minúsculas, sin acentos, guiones como espacio, puntuación fuera, y letra
 * separada de dígito.
 *
 * El guion se colapsa porque el catálogo escribe "Exxsol D-40" y "Alcohol
 * N-Propanol" mientras la gente escribe "exxsol d40" y "alcohol n propanol".
 * Y letra/dígito se separan porque sin eso "exxsol d40" quedaba como un token
 * "d40" que no coincidía con "exxsol d 40", y el término caía en la vía de
 * familia devolviendo los dos Exxsol como ambiguos en lugar de resolver el
 * pedido exacto.
 *
 * Los CAS no pasan por aquí: tienen su propia normalización que sí conserva los
 * guiones, porque en un CAS son parte del identificador.
 */
export function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Un CAS conserva dígitos y guiones: "CAS# 64-17-5" → "64-17-5". */
export function normalizeCas(value: string): string {
  return value.replace(/[^0-9-]/g, '');
}

export const CAS_PATTERN = /^\d{2,7}-\d{2}-\d$/;

// ── Utilidades de presentación ───────────────────────────────────────────────

/** ¿Se conocen los envases de este producto, o sólo que existe? */
export function hasKnownPresentations(product: ProductEntity): boolean {
  return product.presentations.length > 0;
}

/** Texto de presentaciones tal como lo publica la empresa, para redactar. */
export function presentationSummary(product: ProductEntity): string {
  return product.presentations
    .map((p) => p.raw || `${p.container}: ${p.quantities.join(' y ')} ${p.unit}`.trim())
    .filter(Boolean)
    .join('; ');
}

/**
 * Todas las formas en que la empresa nombra este producto. Son identidades
 * declaradas, no parecidos: el nombre canónico, los aliases, cómo lo escribe
 * cada fuente y los nombres de sus grados.
 */
export function identityTermsOf(product: ProductEntity): string[] {
  return [
    product.canonicalName,
    ...product.aliasesOfficial,
    ...product.aliasesCommon,
    ...product.sourceNames.pdf2025,
    ...product.sourceNames.web,
    ...product.variants.map((v) => v.sourceName),
  ].filter((t) => t.trim() !== '');
}

// ── Auditoría del catálogo declarado ─────────────────────────────────────────

export interface CatalogAudit {
  products: number;
  withCas: number;
  withPresentations: number;
  /** Declarados sin ficha en el sitio: existen, pero no se conocen sus envases. */
  existenceOnly: number;
  aliasesOfficial: number;
  aliasesCommon: number;
  /** Un mismo nombre o alias apuntando a dos productos: rompe la resolución. */
  aliasCollisions: Array<{ term: string; products: string[] }>;
  duplicateIds: string[];
  flags: Record<string, number>;
}

/**
 * Revisa el catálogo declarado. Se ejecuta en el sync para que una colisión de
 * alias se vea al publicar y no en una conversación con un cliente.
 */
export function auditCatalog(catalog: ProductCatalog): CatalogAudit {
  const byTerm = new Map<string, Set<string>>();
  const idCounts = new Map<string, number>();
  const flags: Record<string, number> = {};

  for (const p of catalog.products) {
    idCounts.set(p.id, (idCounts.get(p.id) ?? 0) + 1);
    for (const f of p.dataQualityFlags) flags[f] = (flags[f] ?? 0) + 1;
    for (const term of identityTermsOf(p)) {
      const key = normalizeTerm(term);
      if (!key) continue;
      if (!byTerm.has(key)) byTerm.set(key, new Set());
      byTerm.get(key)!.add(p.id);
    }
  }

  return {
    products: catalog.products.length,
    withCas: catalog.products.filter((p) => p.cas).length,
    withPresentations: catalog.products.filter((p) => hasKnownPresentations(p)).length,
    existenceOnly: catalog.products.filter((p) => !hasKnownPresentations(p)).length,
    aliasesOfficial: catalog.products.reduce((n, p) => n + p.aliasesOfficial.length, 0),
    aliasesCommon: catalog.products.reduce((n, p) => n + p.aliasesCommon.length, 0),
    aliasCollisions: [...byTerm.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([term, ids]) => ({ term, products: [...ids] })),
    duplicateIds: [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id),
    flags,
  };
}
