import * as fs from 'fs';
import * as path from 'path';
import { onboardingDir } from './env';

/** Escribe un tenant mínimo pero completo, listo para cargar y validar. */
export function writeTenant(
  tenantId: string,
  overrides: Partial<Record<'company' | 'personality' | 'departments' | 'workflows' | 'routing', string>> = {},
): string {
  const dir = path.join(onboardingDir(), tenantId);
  fs.mkdirSync(path.join(dir, 'knowledge', 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'knowledge', 'customer-safe'), { recursive: true });

  const files: Record<string, string> = {
    'company.yaml':
      overrides.company ??
      `company:
  id: ${tenantId}
  name: "Empresa de Prueba"
  website: "https://ejemplo.test"
  description: "Fabrica cosas."
assistant:
  display_name: "Asistente de Prueba"
  locale: es-MX
  fallback_message: "No pude procesar tu mensaje."
  routing_failed_message: "Lo dejo registrado."
channels:
  whatsapp:
    enabled: true
    from: "whatsapp:+15550000001"
`,

    'personality.yaml':
      overrides.personality ??
      `base:
  style:
    - profesional
    - breve
  pronoun_style: usted
  principles:
    - conversar, no interrogar
  banned_phrases:
    - "a la brevedad posible"
  max_questions_per_reply: 1
tones:
  SALES_QUOTE:
    - comercial
  INFO:
    - directo
`,

    'departments.yaml':
      overrides.departments ??
      `departments:
  SALES:
    name: Ventas
  CUSTOMER_SERVICE:
    name: Atención al Cliente
`,

    'workflows.yaml':
      overrides.workflows ??
      `workflows:
  SALES_QUOTE:
    enabled: true
    department: SALES
    strategy: qualify_then_route
    intents:
      - SALES_QUOTE
    fields:
      essential:
        - product
        - quantity
      useful:
        - contact_name
        - contact_phone
      optional:
        - intended_use
    field_labels:
      product: "producto"
      quantity: "cantidad"
      contact_name: "nombre"
      contact_phone: "teléfono"
      intended_use: "uso"
    routing:
      require_all_essential: true
      satisfied_by_channel:
        - contact_phone
    cannot_do:
      - dar precios
  INFO:
    enabled: true
    department: CUSTOMER_SERVICE
    strategy: answer_then_optional_route
    intents:
      - GENERAL_INFORMATION
    fields:
      essential: []
      useful: []
      optional: []
    field_labels: {}
    routing:
      require_all_essential: true
      satisfied_by_channel: []
    cannot_do: []
`,

    'routing.yaml':
      overrides.routing ??
      `routing:
  SALES:
    type: LOG
    to: []
    confirmation_semantics: REGISTERED_ONLY
  CUSTOMER_SERVICE:
    type: LOG
    to: []
    confirmation_semantics: REGISTERED_ONLY
fallback:
  type: LOG
  to: []
  confirmation_semantics: REGISTERED_ONLY
`,
  };

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }

  return dir;
}

/** Escribe el catálogo declarado del tenant, que es la fuente de existencia. */
export function writeCatalog(tenantId: string, catalog: unknown): void {
  const dir = path.join(onboardingDir(), tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Catálogo pequeño de una empresa ficticia.
 *
 * Deliberadamente NO incluye acetona, thinner ni sosa cáustica: así los tests
 * que comprueban que no se inventan productos siguen siendo verdaderos. (El
 * catálogo real de Grupo Yoma sí los vende, y afirmar lo contrario en un test
 * fue justo el error que nos costó cuatro ventas.)
 */
export function fixtureCatalog(): unknown {
  const p = (
    id: string,
    canonicalName: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    canonicalName,
    aliasesOfficial: [],
    aliasesCommon: [],
    variants: [],
    families: [],
    cas: null,
    description: null,
    presentations: [],
    applications: [],
    sourceNames: { pdf2025: [], web: [canonicalName] },
    sourcePresence: { pdf2025: false, webCatalog: true, detailPage: true },
    sourceUrls: [],
    dataQualityFlags: [],
    ...extra,
  });

  return {
    schemaVersion: '1.0.0',
    catalogName: 'Catálogo de prueba',
    generatedAt: '2026-01-01',
    families: { acetato: { label: 'acetato', terms: ['acetato', 'acetatos'] } },
    resolverConfig: {
      matchOrder: ['canonicalName', 'aliasesOfficial', 'aliasesCommon', 'cas'],
      noSemanticExistenceProof: true,
      ambiguousIfMultipleExactAliasTargets: true,
    },
    products: [
      p('alcohol-isopropilico', 'Alcohol Isopropílico', {
        aliasesCommon: ['isopropanol', 'IPA'],
        cas: '67-63-0',
        presentations: [
          { container: 'tambor', quantities: [200], unit: 'l', raw: 'Tambos: 200 l' },
        ],
      }),
      p('acetato-de-etilo', 'Acetato de Etilo', { families: ['acetato'], cas: '141-78-6' }),
      p('acetato-de-butilo', 'Acetato de Butilo', { families: ['acetato'], cas: '123-86-4' }),
      p('tolueno', 'Tolueno', { aliasesCommon: ['toluol'], cas: '108-88-3' }),
      p('xileno', 'Xileno', { aliasesCommon: ['xilol'], cas: '1330-20-7' }),
      p('monomero-de-estireno', 'Monómero de Estireno', { aliasesCommon: ['estireno'] }),
    ],
  };
}

/**
 * Catálogo REAL de Grupo Yoma tal como se despliega.
 *
 * Los tests que dependen de él comprueban el dato publicado, no un fixture
 * inventado: el fallo que nos costó cuatro ventas fue exactamente que el dato
 * real no contenía lo que el código suponía.
 */
export function realYomaCatalog(): unknown {
  const file = path.join(__dirname, '..', '..', 'onboarding', 'grupo-yoma', 'catalog.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
