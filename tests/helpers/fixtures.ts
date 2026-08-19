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
