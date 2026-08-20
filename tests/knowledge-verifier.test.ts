import { afterEach, describe, expect, it } from 'vitest';

import * as fs from 'fs';
import * as path from 'path';
import { writeTenant } from './helpers/fixtures';
import { clearTenantCache, requireTenantConfig } from '../src/tenants/tenant-loader';
import {
  clearVerifierCache,
  findSubstitutedFields,
  verifyCaseFields,
  verifyTerm,
} from '../src/knowledge/knowledge-verifier';
import { getVectorStoreId } from '../src/knowledge/vector-store.service';
import { ensureTenantRow, getTenantConfig } from '../src/db';
import { tenantCacheDir, websiteCacheDir } from '../src/knowledge/knowledge-manifest';

/**
 * Estos tests codifican dos fallos reales observados en producción:
 *  - se aceptó una cotización de "acetona" cuando el catálogo sólo tiene
 *    "acetatos" (nombres parecidos, productos distintos);
 *  - se canalizó a Ventas una solicitud de "óxido nitroso", que no se vende.
 */

const CATALOGO = `# Catálogo
### Alcohol Isopropílico
### Acetato de Etilo
### Acetato de Butilo
### Tolueno
### Xileno
### Monómero de Estireno
Presentaciones: pipa, tambos de 200 l, porrones de 20 l y 50 l.
`;

function seedKnowledge(tenantId: string, content = CATALOGO): void {
  const dir = websiteCacheDir(tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalogo.md'), content, 'utf8');
  clearVerifierCache();
}

afterEach(() => clearVerifierCache());

describe('verificación de términos contra el conocimiento', () => {
  it('confirma un producto que sí está en el catálogo', () => {
    writeTenant('verif');
    clearTenantCache();
    seedKnowledge('verif');
    const config = requireTenantConfig('verif');

    expect(verifyTerm(config, 'Tolueno')).toBe('FOUND');
    expect(verifyTerm(config, 'alcohol isopropílico')).toBe('FOUND');
    expect(verifyTerm(config, 'XILENO')).toBe('FOUND');
  });

  it('NO confunde acetona con acetato', () => {
    writeTenant('verif-acetona');
    clearTenantCache();
    seedKnowledge('verif-acetona');
    const config = requireTenantConfig('verif-acetona');

    // El fallo real: el cliente dijo "vi que venden acetona", el asistente le
    // creyó y armó una cotización de 1000 litros de un producto inexistente.
    expect(verifyTerm(config, 'acetona')).toBe('NOT_FOUND');
    expect(verifyTerm(config, 'Acetona')).toBe('NOT_FOUND');
    // El acetato sí existe y no debe verse afectado.
    expect(verifyTerm(config, 'acetato de etilo')).toBe('FOUND');
  });

  it('rechaza un producto que no se maneja', () => {
    writeTenant('verif-nitroso');
    clearTenantCache();
    seedKnowledge('verif-nitroso');
    const config = requireTenantConfig('verif-nitroso');

    expect(verifyTerm(config, 'óxido nitroso')).toBe('NOT_FOUND');
    expect(verifyTerm(config, 'oxido nitroso')).toBe('NOT_FOUND');
  });

  it('ignora cantidades y unidades al verificar el producto', () => {
    writeTenant('verif-cant');
    clearTenantCache();
    seedKnowledge('verif-cant');
    const config = requireTenantConfig('verif-cant');

    expect(verifyTerm(config, '800 litros de tolueno')).toBe('FOUND');
    expect(verifyTerm(config, '1000 L de óxido nitroso')).toBe('NOT_FOUND');
  });

  it('sin conocimiento cargado no afirma nada', () => {
    writeTenant('verif-vacio');
    clearTenantCache();
    clearVerifierCache();
    const config = requireTenantConfig('verif-vacio');

    // Sin corpus no se puede desmentir: NO_KNOWLEDGE nunca bloquea nada.
    expect(verifyTerm(config, 'lo que sea')).toBe('NO_KNOWLEDGE');
  });
});

describe('recuperación del vector store tras un despliegue', () => {
  it('lo lee del manifest cuando la base está en blanco', () => {
    // El fallo real: al desplegar, la base nace vacía y el id del vector store
    // sólo vivía ahí. El asistente perdía el RAG y respondía sin catálogo sin
    // que nada lo delatara, aunque el conocimiento siguiera indexado en OpenAI.
    writeTenant('vs-recuperado');
    clearTenantCache();
    ensureTenantRow('vs-recuperado', 'VS Recuperado');

    const dir = tenantCacheDir('vs-recuperado');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        tenantId: 'vs-recuperado',
        vectorStoreId: 'vs_del_manifest',
        updatedAt: new Date(0).toISOString(),
        entries: {},
      }),
      'utf8',
    );

    expect(getVectorStoreId('vs-recuperado')).toBe('vs_del_manifest');
    // Y queda persistido, para no releer el archivo en cada turno.
    expect(getTenantConfig('vs-recuperado', 'vector_store_id')).toBe('vs_del_manifest');
  });

  it('sin manifest ni base devuelve null y no inventa un id', () => {
    writeTenant('vs-sin-nada');
    clearTenantCache();
    ensureTenantRow('vs-sin-nada', 'Sin Nada');
    expect(getVectorStoreId('vs-sin-nada')).toBeNull();
  });
});

describe('verificación de los campos de un caso', () => {
  it('sólo reporta los campos que el workflow marcó como verificables', () => {
    writeTenant('verif-campos', {
      workflows: `workflows:
  SALES_QUOTE:
    enabled: true
    department: SALES
    strategy: qualify_then_route
    intents: [SALES_QUOTE]
    fields:
      essential: [product, quantity]
      useful: []
      optional: []
    field_labels:
      product: "producto"
      quantity: "cantidad"
    routing:
      require_all_essential: true
      satisfied_by_channel: []
    cannot_do: []
    verify_against_knowledge:
      - product
`,
    });
    clearTenantCache();
    seedKnowledge('verif-campos');
    const config = requireTenantConfig('verif-campos');

    const malo = verifyCaseFields(config, 'SALES_QUOTE', {
      product: 'óxido nitroso',
      quantity: '1000 litros',
    });
    expect(malo).toHaveLength(1);
    expect(malo[0].field).toBe('product');

    const bueno = verifyCaseFields(config, 'SALES_QUOTE', {
      product: 'tolueno',
      quantity: 'un número cualquiera que no está en el catálogo',
    });
    // `quantity` no está en verify_against_knowledge, así que no se verifica.
    expect(bueno).toHaveLength(0);
  });

  it('detecta cuando el modelo SUSTITUYE lo que la persona pidió', () => {
    // Caso real en producción: el cliente pidió cotizar "acetona" —que no se
    // vende— y el modelo registró "acetato", que sí está en el catálogo. La
    // verificación contra catálogo lo aprobó y a Ventas le llegó una cotización
    // de un producto que nadie pidió.
    writeTenant('sustitucion', {
      workflows: `workflows:
  SALES_QUOTE:
    enabled: true
    department: SALES
    strategy: qualify_then_route
    intents: [SALES_QUOTE]
    fields:
      essential: [product, quantity]
      useful: []
      optional: []
    field_labels:
      product: "producto"
      quantity: "cantidad"
    routing:
      require_all_essential: true
      satisfied_by_channel: []
    cannot_do: []
    verify_against_knowledge:
      - product
`,
    });
    clearTenantCache();
    seedKnowledge('sustitucion');
    const config = requireTenantConfig('sustitucion');

    const mensajes = ['Hola, quisiera cotizar 1000 litros de acetona para Monterrey'];

    // "acetato" existe en el catálogo, pero la persona NUNCA lo dijo.
    const sustituido = findSubstitutedFields(
      config,
      'SALES_QUOTE',
      { product: 'acetato', quantity: '1000 litros' },
      mensajes,
    );
    expect(sustituido).toHaveLength(1);
    expect(sustituido[0].field).toBe('product');

    // Lo que sí dijo pasa sin problema, aunque no esté en catálogo: de eso se
    // encarga la otra comprobación.
    expect(
      findSubstitutedFields(config, 'SALES_QUOTE', { product: 'acetona' }, mensajes),
    ).toEqual([]);
  });

  it('tolera diferencias de forma entre lo dicho y lo registrado', () => {
    writeTenant('sustitucion-forma', {
      workflows: `workflows:
  SALES_QUOTE:
    enabled: true
    department: SALES
    strategy: qualify_then_route
    intents: [SALES_QUOTE]
    fields:
      essential: [product]
      useful: []
      optional: []
    field_labels:
      product: "producto"
    routing:
      require_all_essential: true
      satisfied_by_channel: []
    cannot_do: []
    verify_against_knowledge:
      - product
`,
    });
    clearTenantCache();
    seedKnowledge('sustitucion-forma');
    const config = requireTenantConfig('sustitucion-forma');

    // Mayúsculas, acentos y frase completa no cuentan como sustitución.
    for (const [dicho, registrado] of [
      ['necesito TOLUENO por favor', 'Tolueno'],
      ['quiero alcohol isopropilico', 'Alcohol Isopropílico'],
      ['me interesa el xileno', 'xileno en tambos'],
    ]) {
      expect(
        findSubstitutedFields(config, 'SALES_QUOTE', { product: registrado }, [dicho]),
        `no debió marcar sustitución: "${dicho}" -> "${registrado}"`,
      ).toEqual([]);
    }
  });

  it('un workflow sin campos verificables nunca bloquea', () => {
    writeTenant('verif-sin');
    clearTenantCache();
    seedKnowledge('verif-sin');
    const config = requireTenantConfig('verif-sin');

    expect(verifyCaseFields(config, 'SALES_QUOTE', { product: 'óxido nitroso' })).toEqual([]);
  });
});
