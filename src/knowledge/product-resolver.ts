import {
  CAS_PATTERN,
  loadCatalog,
  normalizeCas,
  normalizeTerm,
  type ProductCatalog,
  type ProductEntity,
} from './product-catalog';

/**
 * PRODUCT ENTITY RESOLVER — decide a qué producto declarado se refiere alguien.
 *
 * Reglas del dominio, en orden de importancia:
 *
 *  1. Un MATCH sólo puede venir de una IDENTIDAD DECLARADA: nombre canónico,
 *     alias oficial, alias químico común, nombre de una fuente, nombre de un
 *     grado, o número CAS. El catálogo lo exige explícitamente con
 *     `noSemanticExistenceProof`. Afirmar que la empresa vende algo que no vende
 *     es el peor fallo posible de este sistema.
 *
 *  2. Un término que encaja con varios productos devuelve AMBIGUOUS, no el
 *     primero. "thinner" son tres productos distintos y "alcohol" son ocho.
 *     Elegir por él le vendería a alguien un químico que no pidió.
 *
 *  3. Un término genérico que es palabra de algún nombre del catálogo devuelve
 *     AMBIGUOUS con candidatos, nunca MATCH: sirve para PREGUNTAR cuál, no para
 *     afirmar. Esto no viola la regla 1 porque no autoriza ninguna afirmación.
 *
 *  4. Sin catálogo se devuelve NO_KNOWLEDGE, que no autoriza ni afirmar ni negar.
 *
 * No hay fuzzy matching ni scoring a propósito. Con 64 entidades, la coincidencia
 * exacta normalizada sobre identidades declaradas es más predecible y auditable
 * que un umbral que nadie ha calibrado, y no puede confundir MEK con MIBK.
 */

export type ResolutionStatus = 'MATCH' | 'AMBIGUOUS' | 'NO_MATCH' | 'NO_KNOWLEDGE';

export type MatchedBy =
  | 'canonicalName'
  | 'aliasesOfficial'
  | 'aliasesCommon'
  | 'sourceName'
  | 'variant'
  | 'cas'
  /** Palabra genérica contenida en nombres del catálogo. Nunca produce MATCH. */
  | 'family';

export interface ProductResolution {
  status: ResolutionStatus;
  /** Término tal como llegó, para poder auditar qué se preguntó. */
  rawTerm: string;
  normalizedTerm: string;
  /** Presente sólo con MATCH. */
  product?: ProductEntity;
  matchedBy?: MatchedBy;
  /** Grado concreto cuando se pidió por su nombre ("Trietanolamina 85%"). */
  matchedVariant?: string;
  /** Presente sólo con AMBIGUOUS: los productos entre los que hay que preguntar. */
  candidates?: ProductEntity[];
  /** Familia declarada que se pidió, para poder decir "tipos de thinner". */
  matchedFamily?: string;
}

// ── Índice de identidades ────────────────────────────────────────────────────

interface Identity {
  key: string;
  product: ProductEntity;
  matchedBy: MatchedBy;
  variant?: string;
}

/** Prioridad de cada tipo de identidad, según `matchOrder` del catálogo. */
function rankOf(catalog: ProductCatalog, matchedBy: MatchedBy): number {
  const i = catalog.resolverConfig.matchOrder.indexOf(matchedBy as never);
  if (i >= 0) return i;
  // Nombres de fuente y de grado son identidades oficiales publicadas: valen
  // tanto como el nombre canónico. `family` nunca llega aquí porque no compite.
  if (matchedBy === 'sourceName' || matchedBy === 'variant') return 0;
  return 99;
}

const indexCache = new WeakMap<ProductCatalog, Map<string, Identity[]>>();

function indexOf(catalog: ProductCatalog): Map<string, Identity[]> {
  const cached = indexCache.get(catalog);
  if (cached) return cached;

  const index = new Map<string, Identity[]>();
  const push = (raw: string, product: ProductEntity, matchedBy: MatchedBy, variant?: string) => {
    const key = normalizeTerm(raw);
    if (key.length < 2) return;
    const list = index.get(key);
    const entry: Identity = { key, product, matchedBy, variant };
    if (list) list.push(entry);
    else index.set(key, [entry]);
  };

  for (const p of catalog.products) {
    push(p.canonicalName, p, 'canonicalName');
    for (const a of p.aliasesOfficial) push(a, p, 'aliasesOfficial');
    for (const a of p.aliasesCommon) push(a, p, 'aliasesCommon');
    for (const n of p.sourceNames.pdf2025) push(n, p, 'sourceName');
    for (const n of p.sourceNames.web) push(n, p, 'sourceName');
    for (const v of p.variants) push(v.sourceName, p, 'variant', v.grade);
  }

  indexCache.set(catalog, index);
  return index;
}

// ── Resolución ───────────────────────────────────────────────────────────────

/**
 * Resuelve un término a una entidad del catálogo.
 *
 * El término debe ser SÓLO la identidad del producto. Quien llama es responsable
 * de haber separado antes cantidades, presentaciones y envases: "etanol de 20
 * litros" no se resuelve aquí, "etanol" sí. Esa separación es deliberada — que
 * no exista una presentación no significa que no exista el producto.
 */
export function resolveProduct(tenantId: string, rawTerm: string): ProductResolution {
  const catalog = loadCatalog(tenantId);
  const normalized = normalizeTerm(rawTerm);
  const base = { rawTerm, normalizedTerm: normalized };

  if (!catalog || catalog.products.length === 0) return { status: 'NO_KNOWLEDGE', ...base };
  if (normalized.length < 2) return { status: 'NO_KNOWLEDGE', ...base };

  // 1. CAS primero: es un identificador único e inequívoco, y "108-10-1" no
  //    tiene ninguna lectura como nombre de producto.
  const asCas = normalizeCas(rawTerm);
  if (CAS_PATTERN.test(asCas)) {
    const byCas = catalog.products.filter((p) => p.cas && normalizeCas(p.cas) === asCas);
    // El sitio publica el mismo CAS para dos productos distintos (141-78-6 y
    // 95-63-6). Un CAS repetido no identifica nada: se pregunta.
    if (byCas.length === 1) {
      return { status: 'MATCH', product: byCas[0], matchedBy: 'cas', ...base };
    }
    if (byCas.length > 1) {
      return { status: 'AMBIGUOUS', candidates: byCas, ...base };
    }
    return { status: 'NO_MATCH', ...base };
  }

  // 2. Identidad declarada exacta.
  const exact = indexOf(catalog).get(normalized) ?? [];
  if (exact.length > 0) {
    const byProduct = new Map<string, Identity>();
    for (const id of exact) {
      const prev = byProduct.get(id.product.id);
      if (!prev || rankOf(catalog, id.matchedBy) < rankOf(catalog, prev.matchedBy)) {
        byProduct.set(id.product.id, id);
      }
    }

    if (byProduct.size === 1) {
      const hit = [...byProduct.values()][0];
      // El grado puede venir por otra identidad del mismo producto: "Trietanolamina
      // 85%" es a la vez nombre de fuente y nombre de grado. Se conserva el grado
      // aunque haya ganado la otra, porque es el dato que se pidió.
      const variant = hit.variant ?? exact.find((i) => i.product.id === hit.product.id && i.variant)?.variant;
      return {
        status: 'MATCH',
        product: hit.product,
        matchedBy: hit.matchedBy,
        ...(variant ? { matchedVariant: variant } : {}),
        ...base,
      };
    }

    // Mismo término apuntando a varios productos. El catálogo pide preguntar.
    if (catalog.resolverConfig.ambiguousIfMultipleExactAliasTargets) {
      return {
        status: 'AMBIGUOUS',
        candidates: [...byProduct.values()].map((i) => i.product),
        ...base,
      };
    }
    const best = [...byProduct.values()].sort(
      (a, b) => rankOf(catalog, a.matchedBy) - rankOf(catalog, b.matchedBy),
    )[0];
    return { status: 'MATCH', product: best.product, matchedBy: best.matchedBy, ...base };
  }

  // 3. Identidad declarada DENTRO de la frase.
  //
  //    "27 tambos de thinner americano" no coincide exacto con nada, y sin este
  //    paso caía en la familia `thinner` y devolvía los tres como ambiguos:
  //    perdía el discriminador que la persona sí había dado. Se busca la
  //    identidad declarada MÁS LARGA que aparezca como secuencia completa de
  //    palabras. Sigue siendo coincidencia exacta contra identidades declaradas,
  //    no un parecido: lo único que cambia es que puede venir acompañada.
  const inPhrase = matchIdentityInPhrase(catalog, normalized);
  if (inPhrase) {
    if (inPhrase.length === 1) {
      const hit = inPhrase[0];
      return {
        status: 'MATCH',
        product: hit.product,
        matchedBy: hit.matchedBy,
        ...(hit.variant ? { matchedVariant: hit.variant } : {}),
        ...base,
      };
    }
    return { status: 'AMBIGUOUS', candidates: inPhrase.map((i) => i.product), ...base };
  }

  // 4. Familia DECLARADA: el término pide un grupo, no un producto.
  //
  //    Sólo cuentan los términos escritos en `families` del catálogo. Antes esto
  //    tomaba cualquier palabra de ≥4 letras de un nombre canónico como término
  //    de grupo, y eso convertía en familia a "butil", "monomero" o "dioctil"
  //    sin que nadie lo hubiera decidido, dependiendo de cómo estuviera escrito
  //    cada nombre. Aquí agrupa exactamente lo que está declarado y nada más.
  //
  //    Devuelve candidatos para PREGUNTAR cuál. Nunca un MATCH: una familia no
  //    prueba la existencia de ningún producto concreto.
  const family = matchFamily(catalog, normalized);
  if (family) {
    return {
      status: 'AMBIGUOUS',
      candidates: family.products,
      matchedBy: 'family',
      matchedFamily: family.label || family.key,
      ...base,
    };
  }

  return { status: 'NO_MATCH', ...base };
}

// ── Identidad dentro de una frase ────────────────────────────────────────────

/**
 * Identidades declaradas que aparecen como secuencia completa de palabras dentro
 * del término, quedándose con las MÁS LARGAS.
 *
 * Se exige que la identidad tenga varias palabras o al menos 6 caracteres. Sin
 * ese mínimo, identidades cortas como "sosa", "IPA" o "DOP" dispararían desde
 * cualquier texto que las contuviera por casualidad, y un acrónimo suelto no es
 * evidencia de que alguien esté pidiendo ese producto.
 *
 * Quedarse con la más larga es lo que hace que "thinner americano" gane sobre
 * cualquier identidad más corta contenida en la misma frase.
 */
function matchIdentityInPhrase(catalog: ProductCatalog, normalized: string): Identity[] | null {
  const padded = ` ${normalized} `;
  let best = 0;
  let winners: Identity[] = [];

  for (const [key, identities] of indexOf(catalog)) {
    const wordCount = key.split(' ').length;
    if (wordCount < 2 && key.length < 6) continue;
    if (key === normalized) continue; // ya lo habría resuelto la coincidencia exacta
    if (!padded.includes(` ${key} `)) continue;

    // Más palabras gana; a igualdad de palabras, la más larga en caracteres.
    const score = wordCount * 1000 + key.length;
    if (score > best) {
      best = score;
      winners = identities;
    } else if (score === best) {
      winners = [...winners, ...identities];
    }
  }

  if (winners.length === 0) return null;

  const byProduct = new Map<string, Identity>();
  for (const i of winners) {
    const prev = byProduct.get(i.product.id);
    if (!prev || rankOf(catalog, i.matchedBy) < rankOf(catalog, prev.matchedBy)) {
      byProduct.set(i.product.id, i);
    }
  }
  return [...byProduct.values()];
}

// ── Familias declaradas ──────────────────────────────────────────────────────

interface FamilyHit {
  key: string;
  label: string;
  products: ProductEntity[];
}

/**
 * ¿El término pide una familia declarada?
 *
 * Se acepta que el término de familia venga acompañado ("quiero thinner", "5
 * tambores de thinner") comprobándolo como PALABRA COMPLETA del término. Eso no
 * reabre la puerta a los substrings arbitrarios: sólo se buscan los términos que
 * el catálogo declara como nombre de grupo, no cualquier palabra de un nombre.
 *
 * Si el término nombra varias familias se devuelven todos los candidatos juntos:
 * seguir siendo ambiguo es correcto, y elegir una familia sería inventar.
 */
function matchFamily(catalog: ProductCatalog, normalized: string): FamilyHit | null {
  const families = Object.entries(catalog.families);
  if (families.length === 0) return null;

  const words = new Set(normalized.split(' ').filter(Boolean));
  const hits: FamilyHit[] = [];

  for (const [key, family] of families) {
    const terms = family.terms.length > 0 ? family.terms : [key];
    const asked = terms.some((t) => {
      const nt = normalizeTerm(t);
      if (!nt) return false;
      // Un término de familia de una sola palabra puede venir dentro de la frase;
      // uno de varias palabras tiene que aparecer completo y en orden.
      return nt.includes(' ') ? normalized.includes(nt) : words.has(nt);
    });
    if (!asked) continue;

    const products = catalog.products.filter((p) => p.families.includes(key));
    if (products.length > 0) hits.push({ key, label: family.label, products });
  }

  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];

  const byId = new Map<string, ProductEntity>();
  for (const h of hits) for (const p of h.products) byId.set(p.id, p);
  return {
    key: hits.map((h) => h.key).join('+'),
    label: hits.map((h) => h.label || h.key).join(' y '),
    products: [...byId.values()],
  };
}

// ── Consultas de apoyo ───────────────────────────────────────────────────────

/** Nombres canónicos declarados, para listar opciones a quien pregunta. */
export function catalogProductNames(tenantId: string): string[] {
  return (loadCatalog(tenantId)?.products ?? []).map((p) => p.canonicalName);
}

/** Cuántos productos declara el tenant. 0 significa que no hay catálogo. */
export function catalogSize(tenantId: string): number {
  return loadCatalog(tenantId)?.products.length ?? 0;
}

export function findProductById(tenantId: string, id: string): ProductEntity | null {
  return loadCatalog(tenantId)?.products.find((p) => p.id === id) ?? null;
}
