import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realYomaCatalog, writeCatalog, writeTenant } from './helpers/fixtures';
import { clearTenantCache } from '../src/tenants/tenant-loader';
import { clearCatalogCache } from '../src/knowledge/product-catalog';
import { resolveProduct } from '../src/knowledge/product-resolver';
import { candidateProductTerms } from '../src/workflows/field-engine';

/**
 * Estos tests codifican fallos MEDIDOS contra el catálogo real, no hipótesis.
 *
 * Historia: la existencia se decidía buscando subcadenas en el markdown crawleado
 * del sitio. Las fichas HTML cubren 38 de los 63 renglones del catálogo oficial
 * 2025, así que Acetona, Metil Etil Cetona, Thinner Americano y Sosa Cáustica
 * —productos que la empresa SÍ vende— se rechazaban como inexistentes. Cuatro
 * ventas negadas por medir contra la fuente equivocada.
 *
 * Se usa el catálogo REAL a propósito: un fixture inventado habría pasado
 * mientras el dato desplegado seguía roto.
 */

const T = 'resolver-yoma';

beforeEach(() => {
  writeTenant(T);
  writeCatalog(T, realYomaCatalog());
  clearTenantCache();
  clearCatalogCache();
});

afterEach(() => clearCatalogCache());

describe('familia thinner: tres productos distintos', () => {
  it('resuelve cada thinner a su propio producto', () => {
    for (const [term, id] of [
      ['thinner acrílico', 'thinner-acrilico'],
      ['thinner americano', 'thinner-americano'],
      ['thinner standard', 'thinner-standard'],
    ] as const) {
      const r = resolveProduct(T, term);
      expect(r.status, `"${term}" debió resolver`).toBe('MATCH');
      expect(r.product?.id, `"${term}"`).toBe(id);
    }
  });

  it('"thinner" es AMBIGUO con los tres candidatos, nunca uno elegido al azar', () => {
    const r = resolveProduct(T, 'thinner');

    expect(r.status).toBe('AMBIGUOUS');
    expect(r.matchedBy).toBe('family');
    expect(r.product).toBeUndefined();
    expect((r.candidates ?? []).map((p) => p.id).sort()).toEqual([
      'thinner-acrilico',
      'thinner-americano',
      'thinner-standard',
    ]);
  });

  it('la familia se reconoce dentro de la frase, con cantidades y envases', () => {
    // El caso real: nadie escribe sólo "thinner". Y convertir esto en NO_MATCH
    // haría que el asistente negara tres productos que sí se venden.
    for (const term of [
      'quiero thinner',
      'cotízame 5 tambores de thinner',
      'necesito precio de thinner por favor',
      'me manda 200 litros de thinner',
    ]) {
      const r = resolveProduct(T, term);
      expect(r.status, `"${term}" no debe caer en NO_MATCH`).toBe('AMBIGUOUS');
      expect((r.candidates ?? []).length, `"${term}"`).toBe(3);
    }
  });

  it('un thinner concreto gana sobre la familia aunque la palabra esté presente', () => {
    // "thinner americano" contiene "thinner": la identidad declarada manda.
    const r = resolveProduct(T, '27 tambos de thinner americano');
    expect(r.status).toBe('MATCH');
    expect(r.product?.id).toBe('thinner-americano');
  });

  it('reconoce las erratas con que se escribe de verdad', () => {
    // El cliente escribió "thiner americano" y el sistema lo negó.
    for (const term of ['thiner americano', 'tiner americano', 'tinner americano']) {
      const r = resolveProduct(T, term);
      expect(r.status, `"${term}"`).toBe('MATCH');
      expect(r.product?.id, `"${term}"`).toBe('thinner-americano');
    }
    // Y la errata suelta sigue siendo la familia, no un producto.
    expect(resolveProduct(T, 'thiner').status).toBe('AMBIGUOUS');
  });
});

describe('sólo agrupan las familias DECLARADAS', () => {
  it('agrupa los términos que el catálogo declara como familia', () => {
    for (const [term, n] of [
      ['alcohol', 8],
      ['acetato', 9],
      ['cetona', 4],
      ['ftalato', 2],
      ['exxsol', 2],
    ] as const) {
      const r = resolveProduct(T, term);
      expect(r.status, `"${term}"`).toBe('AMBIGUOUS');
      expect((r.candidates ?? []).length, `"${term}"`).toBe(n);
    }
  });

  it('NO agrupa por cualquier palabra de un nombre canónico', () => {
    // Antes bastaba con que la palabra apareciera en algún nombre del catálogo,
    // así que "butil" y "monomero" se volvían familias sin que nadie lo decidiera
    // y el comportamiento dependía de cómo estuviera escrito cada nombre.
    for (const term of ['butil', 'monomero', 'metil', 'dietilen', 'escamas']) {
      expect(resolveProduct(T, term).status, `"${term}" no es familia declarada`).toBe('NO_MATCH');
    }
  });
});

describe('productos que el sistema negaba y sí se venden', () => {
  it('reconoce los cuatro que costaron una venta', () => {
    for (const [term, id] of [
      ['acetona', 'acetona'],
      ['MEK', 'metil-etil-cetona'],
      ['thinner americano', 'thinner-americano'],
      ['sosa caustica', 'sosa-caustica-en-escamas'],
    ] as const) {
      const r = resolveProduct(T, term);
      expect(r.status, `"${term}" SÍ está en el catálogo oficial`).toBe('MATCH');
      expect(r.product?.id, `"${term}"`).toBe(id);
    }
  });

  it('MEK y MIBK son productos independientes, jamás uno por el otro', () => {
    // Mapear MEK a MIBK vendería una cetona distinta de la que se pidió, que es
    // peor que decir que no se maneja.
    const mek = resolveProduct(T, 'MEK');
    const mibk = resolveProduct(T, 'MIBK');

    expect(mek.product?.id).toBe('metil-etil-cetona');
    expect(mibk.product?.id).toBe('metil-isobutil-cetona');
    expect(mek.product?.id).not.toBe(mibk.product?.id);

    expect(resolveProduct(T, 'metil etil cetona').product?.id).toBe('metil-etil-cetona');
    expect(resolveProduct(T, 'metil isobutil cetona').product?.id).toBe('metil-isobutil-cetona');
    expect(resolveProduct(T, 'butanona').product?.id).toBe('metil-etil-cetona');
    expect(resolveProduct(T, 'hexona').status).not.toBe('MATCH'); // no declarado: no se inventa
  });

  it('existir no implica conocer presentaciones', () => {
    // El PDF no publica envases. Afirmar que existe es correcto; inventar el
    // tambo en el que viene, no.
    const mek = resolveProduct(T, 'MEK');
    expect(mek.status).toBe('MATCH');
    expect(mek.product?.presentations).toEqual([]);

    const mibk = resolveProduct(T, 'MIBK');
    expect(mibk.product?.presentations.length).toBeGreaterThan(0);
  });
});

describe('identidades declaradas', () => {
  it('resuelve por alias químico común', () => {
    expect(resolveProduct(T, 'etanol').product?.id).toBe('alcohol-etilico');
    expect(resolveProduct(T, 'isopropanol').product?.id).toBe('alcohol-isopropilico');
    expect(resolveProduct(T, 'IPA').product?.id).toBe('alcohol-isopropilico');
    expect(resolveProduct(T, 'toluol').product?.id).toBe('tolueno');
    expect(resolveProduct(T, 'DOP').product?.id).toBe('dioctil-ftalato');
  });

  it('resuelve por el nombre que usa cada fuente y por grado', () => {
    // El PDF dice "Alcohol Etilico de Caña" y la ficha dice "Alcohol Etílico".
    expect(resolveProduct(T, 'alcohol etilico de caña').product?.id).toBe('alcohol-etilico');

    const grado = resolveProduct(T, 'trietanolamina 85%');
    expect(grado.status).toBe('MATCH');
    expect(grado.product?.id).toBe('trietanolamina');
    expect(grado.matchedVariant).toBe('85%');
  });

  it('tolera guiones y letra pegada a dígito', () => {
    // "Exxsol D-40" en el catálogo, "exxsol d40" en el mensaje.
    for (const term of ['exxsol d40', 'exxsol d-40', 'Exxsol D 40']) {
      const r = resolveProduct(T, term);
      expect(r.status, `"${term}"`).toBe('MATCH');
      expect(r.product?.id, `"${term}"`).toBe('exxsol-d-40');
    }
  });

  it('resuelve por CAS, y pregunta si el sitio lo publica repetido', () => {
    expect(resolveProduct(T, '108-10-1').product?.id).toBe('metil-isobutil-cetona');
    expect(resolveProduct(T, 'CAS# 108-10-1').product?.id).toBe('metil-isobutil-cetona');

    // El sitio publica 141-78-6 para Acetato de Etilo Y para Alcohol Metílico
    // (metanol es 67-56-1). Un CAS repetido no identifica: se pregunta.
    const repetido = resolveProduct(T, '141-78-6');
    expect(repetido.status).toBe('AMBIGUOUS');
    expect((repetido.candidates ?? []).length).toBe(2);

    expect(resolveProduct(T, '99-99-9').status).toBe('NO_MATCH');
  });
});

describe('acrónimos: así pide un comprador industrial', () => {
  it('extrae siglas de 3 a 6 caracteres del mensaje', () => {
    // El fallo medido: "¿manejan MEK?" no producía NINGÚN candidato porque el
    // mínimo eran 5 letras, así que el asistente contestaba a ciegas y acabó
    // ofreciendo "productos parecidos" ante un producto que sí está en catálogo.
    expect(candidateProductTerms('¿manejan MEK?')).toContain('MEK');
    expect(candidateProductTerms('¿tienen DOP?')).toContain('DOP');
    expect(candidateProductTerms('cotizar IPA por favor')).toContain('IPA');
    expect(candidateProductTerms('necesito DOTP')).toContain('DOTP');
  });

  it('no toma siglas que no son productos', () => {
    // Sin esto, "mi RFC es..." acababa reportado como algo que no vendemos.
    for (const [msg, sigla] of [
      ['mi RFC es XAXX010101000', 'RFC'],
      ['el CP es 28000', 'CP'],
      ['requiero CFDI', 'CFDI'],
    ] as const) {
      expect(candidateProductTerms(msg), msg).not.toContain(sigla);
    }
  });

  it('las siglas resuelven al producto declarado', () => {
    expect(resolveProduct(T, 'MEK').product?.id).toBe('metil-etil-cetona');
    expect(resolveProduct(T, 'DOP').product?.id).toBe('dioctil-ftalato');
    expect(resolveProduct(T, 'DBP').product?.id).toBe('dibutil-ftalato');
    expect(resolveProduct(T, 'MAK').product?.id).toBe('metil-amil-cetona');
    // Y una sigla inventada no resuelve a nada.
    expect(resolveProduct(T, 'ZQX').status).toBe('NO_MATCH');
  });
});

describe('lo que NO se vende se niega', () => {
  it('no inventa productos por parecido', () => {
    for (const term of [
      'óxido nitroso',
      'pito en tambo',
      'ácido sulfúrico',
      'gasolina magna',
      'cloro',
    ]) {
      expect(resolveProduct(T, term).status, `"${term}"`).toBe('NO_MATCH');
    }
  });

  it('sin catálogo no se afirma ni se niega', () => {
    writeTenant('sin-catalogo');
    clearTenantCache();
    clearCatalogCache();
    expect(resolveProduct('sin-catalogo', 'tolueno').status).toBe('NO_KNOWLEDGE');
    expect(resolveProduct('sin-catalogo', 'óxido nitroso').status).toBe('NO_KNOWLEDGE');
  });
});
