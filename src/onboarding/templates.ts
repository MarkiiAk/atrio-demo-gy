import { TODO_SENTINEL } from '../tenants/config-schema';

export interface WizardAnswers {
  tenantId: string;
  companyName: string;
  assistantName: string;
  locale: string;
  website: string;
  pronounStyle: 'usted' | 'tu';
  departments: string[];
  workflows: string[];
  routingType: 'LOG' | 'EMAIL';
  routingTo: string;
}

export const DEFAULT_DEPARTMENTS: Record<string, string> = {
  SALES: 'Ventas',
  PURCHASES: 'Compras',
  HUMAN_RESOURCES: 'Recursos Humanos',
  CUSTOMER_SERVICE: 'Atención al Cliente',
  ADMINISTRATION: 'Administración',
  LOGISTICS: 'Logística',
};

/** Catálogo de workflows sugeridos. El cliente elige cuáles habilitar. */
export const WORKFLOW_LIBRARY: Record<
  string,
  {
    department: string;
    displayName: string;
    strategy: string;
    intents: string[];
    description: string;
    essential: string[];
    useful: string[];
    optional: string[];
    labels: Record<string, string>;
    tone: string[];
    cannotDo: string[];
    satisfiedByChannel: string[];
    verifyAgainstKnowledge: string[];
    describeFields: string[];
  }
> = {
  SALES_QUOTE: {
    displayName: 'Cotizaciones',
    department: 'SALES',
    strategy: 'qualify_then_route',
    intents: ['SALES_QUOTE'],
    description: 'Solicitudes de cotización o compra',
    essential: ['product', 'quantity'],
    // contact_name va primero a propósito: el foco sugerido sigue este orden, y
    // preguntar el nombre al final se siente como un formulario, no como alguien
    // que te atiende.
    useful: ['contact_name', 'delivery_city', 'presentation', 'company', 'email', 'contact_phone'],
    optional: ['intended_use'],
    labels: {
      product: 'producto que necesita',
      quantity: 'cantidad',
      presentation: 'presentación o envase',
      delivery_city: 'ciudad de entrega',
      contact_name: 'nombre de contacto',
      company: 'empresa',
      email: 'correo',
      contact_phone: 'teléfono de contacto',
      intended_use: 'uso previsto',
    },
    tone: ['comercial', 'amable', 'proactivo', 'natural'],
    cannotDo: ['dar precios o cotizaciones con monto', 'confirmar disponibilidad de inventario'],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: ['product'],
    describeFields: []
  },

  SUPPLIER: {
    displayName: 'Proveedores que se ofrecen',
    department: 'PURCHASES',
    strategy: 'collect_then_route',
    intents: ['SUPPLIER'],
    description: 'Empresas que ofrecen productos o servicios',
    essential: ['company', 'offering'],
    useful: ['location', 'coverage', 'certifications', 'contact_name', 'email', 'contact_phone'],
    optional: ['documentation'],
    labels: {
      company: 'nombre de la empresa',
      offering: 'qué ofrecen',
      location: 'ubicación',
      coverage: 'cobertura de entrega',
      certifications: 'certificaciones',
      contact_name: 'nombre de contacto',
      email: 'correo',
      contact_phone: 'teléfono de contacto',
      documentation: 'documentación disponible',
    },
    tone: ['profesional', 'cordial', 'estructurado'],
    cannotDo: [
      'expresar interés de compra en nombre de la empresa',
      'comprometer una reunión o una respuesta',
    ],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: [],
    describeFields: ['offering']
  },

  HR: {
    displayName: 'Solicitudes de empleo',
    department: 'HUMAN_RESOURCES',
    strategy: 'answer_then_optional_route',
    intents: ['HR'],
    description: 'Postulaciones y consultas de empleo',
    essential: ['position_interest'],
    useful: ['contact_name', 'email', 'experience', 'contact_phone'],
    optional: ['availability'],
    labels: {
      position_interest: 'área o puesto de interés',
      contact_name: 'nombre',
      email: 'correo',
      experience: 'experiencia',
      contact_phone: 'teléfono de contacto',
      availability: 'disponibilidad',
    },
    tone: ['cordial', 'claro', 'neutral'],
    cannotDo: ['confirmar vacantes disponibles', 'agendar entrevistas'],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: [],
    describeFields: []
  },

  INVOICE: {
    displayName: 'Facturación',
    department: 'ADMINISTRATION',
    strategy: 'collect_then_route',
    intents: ['INVOICE'],
    description: 'Facturación y comprobantes',
    essential: ['order_or_invoice_reference'],
    useful: ['company', 'contact_name', 'email', 'issue_description', 'contact_phone'],
    optional: ['tax_id'],
    labels: {
      order_or_invoice_reference: 'número de pedido o factura',
      company: 'empresa',
      contact_name: 'nombre',
      email: 'correo',
      issue_description: 'qué necesita con la factura',
      contact_phone: 'teléfono de contacto',
      tax_id: 'RFC',
    },
    tone: ['empático', 'resolutivo', 'breve'],
    cannotDo: ['emitir, reenviar o cancelar facturas', 'consultar el estado de una factura'],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: [],
    describeFields: ['issue_description']
  },

  ORDER_STATUS: {
    displayName: 'Seguimiento de pedidos',
    department: 'CUSTOMER_SERVICE',
    strategy: 'collect_then_route',
    intents: ['ORDER_STATUS'],
    description: 'Seguimiento de pedidos',
    essential: ['order_number'],
    useful: ['contact_name', 'company', 'contact_phone'],
    optional: ['expected_date'],
    labels: {
      order_number: 'número de pedido',
      contact_name: 'nombre',
      company: 'empresa',
      contact_phone: 'teléfono de contacto',
      expected_date: 'fecha esperada',
    },
    tone: ['empático', 'resolutivo', 'breve'],
    cannotDo: ['consultar el estatus real de un pedido', 'dar fechas de entrega'],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: [],
    describeFields: []
  },

  DELIVERY_ISSUE: {
    displayName: 'Problemas de entrega',
    department: 'LOGISTICS',
    strategy: 'collect_then_route',
    intents: ['DELIVERY_ISSUE'],
    description: 'Problemas de entrega',
    essential: ['order_number', 'issue_description'],
    useful: ['delivery_city', 'contact_name', 'urgency', 'contact_phone'],
    optional: ['notes'],
    labels: {
      order_number: 'número de pedido',
      issue_description: 'qué ocurrió con la entrega',
      delivery_city: 'ciudad',
      contact_name: 'nombre',
      urgency: 'urgencia',
      contact_phone: 'teléfono de contacto',
      notes: 'notas adicionales',
    },
    tone: ['sereno', 'cuidadoso', 'empático', 'no defensivo'],
    cannotDo: ['reprogramar una entrega', 'contactar al transportista'],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: [],
    describeFields: ['issue_description']
  },

  PRODUCT_DAMAGE: {
    displayName: 'Producto dañado',
    department: 'CUSTOMER_SERVICE',
    strategy: 'collect_then_route',
    intents: ['PRODUCT_DAMAGE'],
    description: 'Producto dañado o en mal estado',
    essential: ['order_number', 'product', 'damage_description'],
    useful: ['affected_quantity', 'leak_or_spill', 'seal_damage', 'urgency', 'contact_name', 'contact_phone'],
    optional: ['notes'],
    labels: {
      order_number: 'número de pedido',
      product: 'producto afectado',
      damage_description: 'daño observado',
      affected_quantity: 'cantidad afectada',
      leak_or_spill: 'si hubo fuga o derrame',
      seal_damage: 'si los sellos venían dañados',
      urgency: 'urgencia',
      contact_name: 'nombre',
      contact_phone: 'teléfono de contacto',
      notes: 'notas adicionales',
    },
    tone: ['sereno', 'cuidadoso', 'empático', 'no defensivo'],
    cannotDo: [
      'autorizar cambios, reembolsos o notas de crédito',
      'determinar responsabilidad del daño',
    ],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: ['product'],
    describeFields: ['damage_description']
  },

  COMPLAINT: {
    displayName: 'Quejas',
    department: 'CUSTOMER_SERVICE',
    strategy: 'collect_then_route',
    intents: ['COMPLAINT'],
    description: 'Quejas e inconformidades',
    essential: ['complaint_description'],
    useful: ['order_number', 'contact_name', 'company', 'urgency', 'contact_phone'],
    optional: ['expected_resolution'],
    labels: {
      complaint_description: 'motivo de la queja',
      order_number: 'número de pedido',
      contact_name: 'nombre',
      company: 'empresa',
      urgency: 'urgencia',
      contact_phone: 'teléfono de contacto',
      expected_resolution: 'qué esperaría como solución',
    },
    tone: ['sereno', 'cuidadoso', 'empático', 'no defensivo'],
    cannotDo: ['ofrecer compensaciones', 'asignar culpas'],
    satisfiedByChannel: ['contact_phone', 'contact_name'],
    verifyAgainstKnowledge: [],
    describeFields: ['complaint_description']
  },

  SUGGESTION: {
    displayName: 'Sugerencias',
    department: 'CUSTOMER_SERVICE',
    strategy: 'collect_then_route',
    intents: ['SUGGESTION'],
    description: 'Sugerencias y comentarios',
    essential: ['suggestion'],
    useful: ['contact_name', 'company'],
    optional: [],
    labels: {
      suggestion: 'sugerencia',
      contact_name: 'nombre',
      company: 'empresa',
    },
    tone: ['cordial', 'breve', 'agradecido'],
    cannotDo: ['comprometer que la sugerencia se implementará'],
    satisfiedByChannel: [],
    verifyAgainstKnowledge: [],
    describeFields: ['suggestion']
  },

  GENERAL_INFORMATION: {
    displayName: 'Preguntas generales',
    department: 'CUSTOMER_SERVICE',
    strategy: 'answer_then_optional_route',
    intents: ['GENERAL_INFORMATION'],
    description: 'Preguntas informativas respondibles con la documentación autorizada',
    essential: [],
    useful: ['topic'],
    optional: ['contact_name'],
    labels: { topic: 'tema de la consulta', contact_name: 'nombre' },
    tone: ['directo', 'útil', 'breve'],
    cannotDo: [],
    satisfiedByChannel: [],
    verifyAgainstKnowledge: [],
    describeFields: []
  },
};

export const ALL_WORKFLOW_KEYS = Object.keys(WORKFLOW_LIBRARY);

// ── Generadores de YAML ──────────────────────────────────────────────────────

function q(value: string): string {
  return JSON.stringify(value);
}

export function companyYaml(a: WizardAnswers): string {
  return `# Identidad del cliente. Todo lo que el asistente dice de sí mismo sale de aquí.
company:
  id: ${a.tenantId}
  name: ${q(a.companyName)}
  website: ${q(a.website)}
  # URL del catálogo público. Si alguien pide algo que no se maneja, el asistente
  # lo dice claro y remite aquí. Si se deja vacío, usa el sitio web.
  catalog_url: ""
  # Una o dos frases sobre qué hace la empresa. El asistente las usa para presentarse.
  description: ${q(TODO_SENTINEL + ': describir a qué se dedica la empresa')}

assistant:
  display_name: ${q(a.assistantName)}
  locale: ${q(a.locale)}
  # Texto exacto que se envía si el proveedor de IA no responde.
  fallback_message: ${q(`Gracias por escribir a ${a.companyName}. En este momento no pude procesar tu mensaje. ¿Puedes intentar de nuevo en unos minutos?`)}
  # Texto seguro cuando ya se tiene la información pero la canalización interna falló.
  # No debe prometer que alguien ya lo recibió.
  routing_failed_message: ${q('Ya tengo la información necesaria. La dejo registrada para darle seguimiento.')}

channels:
  whatsapp:
    enabled: true
    # Sender de Twilio de este cliente, formato whatsapp:+E164.
    # Si se deja vacío se usa TWILIO_WHATSAPP_FROM del entorno.
    from: ""
`;
}

export function personalityYaml(a: WizardAnswers, enabledWorkflows: string[]): string {
  const tones = enabledWorkflows
    .map((k) => {
      const wf = WORKFLOW_LIBRARY[k];
      if (!wf) return '';
      return `  ${k}:\n${wf.tone.map((t) => `    - ${t}`).join('\n')}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `# Cómo suena el asistente. Cambiar esto cambia el trato sin tocar código.
base:
  style:
    - profesional
    - amable
    - natural
    - breve

  # "usted" o "tu"
  pronoun_style: ${a.pronounStyle}

  principles:
    - conversar, no interrogar
    - no sonar como formulario
    - no exponer limitaciones técnicas internas
    - no inventar información
    - no prometer acciones o resultados no autorizados
    - no usar lenguaje innecesariamente corporativo
    - priorizar claridad
    - no repetir lo que la persona acaba de decir
    - pedir los datos que faltan de una vez, no de uno en uno
    - reconocer lo que preocupa a la persona, no sólo sus datos

  # Frases que este cliente NO quiere oír nunca. Se verifican DESPUÉS de generar
  # la respuesta: si aparecen, se regenera. Sirven para matar muletillas.
  banned_phrases:
    - "quedó registrado para seguimiento"

  # Temas por respuesta (no datos: dentro de un tema se pueden pedir varios
  # datos juntos). 2 permite responder algo y además pedir lo que falta.
  max_questions_per_reply: 2

# Tono por tipo de solicitud. La clave debe existir en workflows.yaml.
tones:
${tones || '  {}'}
`;
}

export function departmentsYaml(departments: string[]): string {
  const body = departments
    .map((key) => {
      const name = DEFAULT_DEPARTMENTS[key] ?? key;
      return `  ${key}:\n    name: ${q(name)}\n    description: ""`;
    })
    .join('\n\n');

  return `# Áreas internas de la empresa. Son configuración, no un catálogo fijo del producto.
departments:
${body}
`;
}

export function workflowsYaml(enabled: string[]): string {
  const body = enabled
    .map((key) => {
      const wf = WORKFLOW_LIBRARY[key];
      if (!wf) return '';
      const list = (items: string[], indent: string) =>
        items.length === 0 ? ' []' : `\n${items.map((i) => `${indent}- ${i}`).join('\n')}`;
      const labels = Object.entries(wf.labels)
        .map(([k, v]) => `      ${k}: ${q(v)}`)
        .join('\n');

      return `  ${key}:
    enabled: true
    # Nombre que se ve en el panel de administración.
    display_name: ${q(wf.displayName)}
    department: ${wf.department}
    strategy: ${wf.strategy}
    description: ${q(wf.description)}

    intents:
${wf.intents.map((i) => `      - ${i}`).join('\n')}

    fields:
      # Sin estos, la aplicación NO canaliza.
      essential:${list(wf.essential, '        ')}
      # Se piden sólo si surgen de forma natural.
      useful:${list(wf.useful, '        ')}
      # Nunca se preguntan; se guardan si el cliente los menciona.
      optional:${list(wf.optional, '        ')}

    # Cómo nombrar cada campo al conversar.
    field_labels:
${labels || '      {}'}

    routing:
      require_all_essential: true
      # Campos que el canal ya aporta y no deben volver a pedirse.
      satisfied_by_channel:${list(wf.satisfiedByChannel, '        ')}

    # Lo que este asistente NO puede hacer en este flujo. Se le dice al modelo
    # para que no lo prometa.
    cannot_do:${list(wf.cannotDo, '      ')}

    # Campos que la APLICACIÓN verifica contra la documentación autorizada antes
    # de que el asistente los trate como algo que la empresa ofrece. Evita que
    # un cliente afirme "ustedes venden X" y el asistente se lo crea.
    verify_against_knowledge:${list(wf.verifyAgainstKnowledge, '      ')}

    # Campos que describen el asunto en palabras de la propia persona. Si el
    # modelo no los extrae, la aplicación los rellena con lo que ella escribió,
    # para no volver a preguntar algo que acaba de decir.
    describe_fields:${list(wf.describeFields, '      ')}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `# Tipos de solicitud que el asistente sabe atender y qué información recaba.
workflows:
${body}
`;
}

export function routingYaml(a: WizardAnswers, departments: string[]): string {
  const target = (dept: string) => {
    if (a.routingType === 'EMAIL') {
      const to = a.routingTo || `${TODO_SENTINEL}: correo del área ${dept}`;
      return `  ${dept}:
    type: EMAIL
    to:
      - ${q(to)}
    # DELIVERED_TO_TEAM autoriza al asistente a confirmar que el área ya lo tiene.
    confirmation_semantics: DELIVERED_TO_TEAM`;
    }
    return `  ${dept}:
    type: LOG
    to: []
    # Con LOG nadie recibe nada todavía: el asistente sólo puede confirmar registro.
    confirmation_semantics: REGISTERED_ONLY`;
  };

  return `# A dónde va cada caso una vez que la aplicación decide que está listo.
# Adapters disponibles hoy: LOG (siempre), EMAIL (si SMTP_ENABLED=true).
# WEBHOOK / CRM / HUMAN_INBOX están declarados pero no implementados: caen a LOG.
routing:
${departments.map(target).join('\n\n')}

# Destino usado cuando un caso no tiene área resoluble.
fallback:
  type: LOG
  to: []
  confirmation_semantics: REGISTERED_ONLY
`;
}

export function readmeMd(a: WizardAnswers): string {
  return `# Onboarding — ${a.companyName}

\`tenant_id\`: \`${a.tenantId}\`

Toda la personalización de este cliente vive en esta carpeta. **No se edita TypeScript para dar de alta o cambiar un cliente.**

## Archivos

| Archivo | Qué controla |
|---|---|
| \`company.yaml\` | Identidad, nombre visible del asistente, idioma, canal, textos de respaldo |
| \`personality.yaml\` | Estilo, trato (usted/tú), principios, frases prohibidas, tono por tipo de solicitud |
| \`departments.yaml\` | Áreas internas de la empresa |
| \`workflows.yaml\` | Tipos de solicitud, qué información recabar, cuándo se puede canalizar |
| \`routing.yaml\` | A dónde va cada caso y qué puede confirmarle el asistente al cliente |

## Conocimiento

\`\`\`
knowledge/
  public/         → información ya publicada (catálogos, fichas, documentos públicos)
  customer-safe/  → información NO publicada que ${a.companyName} AUTORIZA a usar frente al cliente
\`\`\`

**Colocar un archivo en \`customer-safe/\` es una autorización explícita.** Significa que ${a.companyName} acepta que el asistente use ese contenido para responderle a cualquier persona que escriba. Si algo no debe salir de la empresa, no va aquí.

Las reglas internas (a quién se canaliza, correos internos, criterios de prioridad) **no van en \`knowledge/\`**: van en \`routing.yaml\` y \`workflows.yaml\`, que la aplicación consume y el cliente externo nunca ve.

## Marcadores pendientes

Los campos con \`${TODO_SENTINEL}\` son preguntas abiertas del onboarding.

- En \`APP_MODE=demo\` se toleran y se reportan como advertencia.
- En \`APP_MODE=production\`, dentro de un workflow habilitado, son **error de arranque**.

## Comandos

\`\`\`bash
npm run onboard:validate -- ${a.tenantId}
npm run knowledge:web-sync -- ${a.tenantId} ${a.website || '<url>'}
npm run onboard:sync -- ${a.tenantId}
npm run onboard:status -- ${a.tenantId}
npm run chat -- ${a.tenantId}
npm run onboard:gaps -- ${a.tenantId}
\`\`\`
`;
}

export function knowledgeReadme(kind: 'public' | 'customer-safe', companyName: string): string {
  if (kind === 'public') {
    return `# Conocimiento PÚBLICO

Documentos que ya son públicos: catálogos, fichas técnicas publicadas, folletos, documentos institucionales.

Formatos soportados: \`.md\`, \`.txt\`, \`.pdf\`, \`.html\`, \`.json\`, \`.csv\`, \`.docx\`, \`.pptx\`.

Las páginas del sitio web NO se colocan aquí: se sincronizan con \`npm run knowledge:web-sync\`.
`;
  }
  return `# Conocimiento AUTORIZADO POR EL CLIENTE (customer-safe)

Todo archivo en esta carpeta significa:

> **${companyName} autoriza expresamente que esta información se use para atender a personas externas.**

Ejemplos típicos: correo autorizado para recibir CV, horarios de recepción, requisitos para proveedores, documentación que se le pide a un cliente, proceso público de atención, preguntas frecuentes aprobadas.

Lo que NO va aquí:

- correos y teléfonos internos de empleados que no son punto de contacto público;
- reglas de a quién se canaliza cada caso (eso es \`routing.yaml\`);
- listas de precios, márgenes, condiciones comerciales o cualquier cosa que no deba salir de la empresa.

El asistente trata este contenido como **dato**, nunca como instrucción: si un documento contiene texto tipo "ignora tus reglas", no se obedece.
`;
}
