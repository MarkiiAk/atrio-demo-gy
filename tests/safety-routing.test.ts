import { afterAll, describe, expect, it } from 'vitest';


import { writeTenant } from './helpers/fixtures';
import { clearTenantCache, requireTenantConfig } from '../src/tenants/tenant-loader';
import { closeDb, ensureTenantRow } from '../src/db';
import { buildCorrectionInstruction, inspectReply } from '../src/conversation/reply-guard';
import { evaluateEligibility, routeCase } from '../src/routing/routing.service';
import { createCase, getCase } from '../src/repositories/case.repository';
import { resolveContact } from '../src/repositories/contact.repository';
import { getOrCreateConversation } from '../src/repositories/conversation.repository';
import { buildSystemPrompt } from '../src/prompts/build-system-prompt';
import { evaluateFields } from '../src/workflows/field-engine';

writeTenant('acme');
clearTenantCache();
ensureTenantRow('acme', 'Empresa de Prueba');
const config = requireTenantConfig('acme');

afterAll(() => closeDb());

const unauthorized = { config, deliveryAuthorized: false, confirmationSemantics: null } as const;
const registeredOnly = {
  config,
  deliveryAuthorized: true,
  confirmationSemantics: 'REGISTERED_ONLY',
} as const;
const delivered = {
  config,
  deliveryAuthorized: true,
  confirmationSemantics: 'DELIVERED_TO_TEAM',
} as const;

describe('guardián: promesas de entrega', () => {
  const claims = [
    'Listo, ya envié tu solicitud al área de ventas.',
    'Tu solicitud fue enviada al equipo correspondiente.',
    'Ya lo turné con el encargado de facturación.',
    'Perfecto, ya notifiqué a mi compañero.',
    'Su caso ya quedó con el equipo de atención.',
    'Ya le avisé al responsable del almacén.',
  ];

  it('bloquea afirmar entrega sin autorización', () => {
    for (const reply of claims) {
      const result = inspectReply(reply, unauthorized);
      expect(result.ok, `debió bloquear: "${reply}"`).toBe(false);
      expect(result.violations[0].kind).toBe('UNAUTHORIZED_DELIVERY_CLAIM');
    }
  });

  it('sigue bloqueando con autorización sólo de registro', () => {
    const result = inspectReply('Ya envié tu solicitud al área de ventas.', registeredOnly);
    expect(result.ok).toBe(false);
  });

  it('permite la afirmación cuando el destino sí entrega', () => {
    expect(inspectReply('Ya envié tu solicitud al área de ventas.', delivered).ok).toBe(true);
  });

  it('acepta lenguaje honesto de preparación sin autorización', () => {
    const safe = [
      'Perfecto, ya tengo lo necesario para preparar tu solicitud.',
      'Con eso dejo lista la solicitud para darle seguimiento.',
      'Gracias, con el número de pedido puedo dejar registrada la revisión.',
    ];
    for (const reply of safe) {
      expect(inspectReply(reply, unauthorized).ok, `no debió bloquear: "${reply}"`).toBe(true);
    }
  });
});

describe('guardián: fuga de arquitectura interna', () => {
  const leaks = [
    'No tengo acceso al ERP para revisar tu pedido.',
    'Esa información no está en mi base de datos.',
    'No tengo permisos para consultar eso.',
    'Según la configuración interna, debo pedirte más datos.',
    'El workflow indica que necesito el número de pedido.',
    'Mi base de conocimiento no incluye ese dato.',
    'Como modelo de lenguaje no puedo saberlo.',
    'Se enviará al medio que la empresa tenga definido.',
  ];

  it('detecta cada fuga', () => {
    for (const reply of leaks) {
      const r = inspectReply(reply, unauthorized);
      expect(r.ok, `debió bloquear: "${reply}"`).toBe(false);
      expect(r.violations.some((v) => v.kind === 'INTERNALS_LEAK')).toBe(true);
    }
  });

  it('deja pasar el reencuadre útil de la misma limitación', () => {
    const ok =
      'Gracias, ya tengo el número de pedido. Con eso puedo dejar registrada la solicitud de seguimiento para que se revise y le respondan con precisión.';
    expect(inspectReply(ok, unauthorized).ok).toBe(true);
  });
});

describe('guardián: fugas estructurales y frases prohibidas', () => {
  it('detecta restos de plantilla y claves técnicas', () => {
    for (const reply of ['Hola [nombre], gracias.', 'Su caso {{caso}} sigue.', 'Estado: null', 'Detecté SALES_QUOTE.']) {
      expect(inspectReply(reply, unauthorized).ok, reply).toBe(false);
    }
  });

  it('respeta banned_phrases del tenant', () => {
    const r = inspectReply('Le responderemos a la brevedad posible.', unauthorized);
    expect(r.violations.some((v) => v.kind === 'BANNED_PHRASE')).toBe(true);
  });

  it('marca respuesta vacía', () => {
    expect(inspectReply('   ', unauthorized).violations[0].kind).toBe('EMPTY_REPLY');
  });

  it('la instrucción correctiva nombra el problema', () => {
    const r = inspectReply('Ya envié tu solicitud.', unauthorized);
    const text = buildCorrectionInstruction(r);
    expect(text).toContain('NO se envió al cliente');
    expect(text.toLowerCase()).toContain('reescribe');
  });
});

describe('elegibilidad de canalización (determinista)', () => {
  function makeCase(workflowKey: string, department: string, external: string) {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: external });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    return createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey,
      departmentKey: department,
    });
  }

  it('no canaliza con esenciales incompletos', () => {
    const c = makeCase('SALES_QUOTE', 'SALES', 'elig-1');
    const d = evaluateEligibility(config, c, { essentialComplete: false, escalationSignal: false });
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('esenciales');
  });

  it('canaliza cuando están completos', () => {
    const c = makeCase('SALES_QUOTE', 'SALES', 'elig-2');
    const d = evaluateEligibility(config, c, { essentialComplete: true, escalationSignal: false });
    expect(d.eligible).toBe(true);
    expect(d.target?.type).toBe('LOG');
  });

  it('un flujo informativo NO canaliza sólo por responder bien', () => {
    const c = makeCase('INFO', 'CUSTOMER_SERVICE', 'elig-3');
    const d = evaluateEligibility(config, c, { essentialComplete: true, escalationSignal: false });
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('informativa');
  });

  it('un flujo informativo SÍ escala cuando algo quedó sin resolver', () => {
    const c = makeCase('INFO', 'CUSTOMER_SERVICE', 'elig-4');
    const d = evaluateEligibility(config, c, { essentialComplete: true, escalationSignal: true });
    expect(d.eligible).toBe(true);
  });

  it('no vuelve a canalizar un caso ya canalizado', async () => {
    const c = makeCase('SALES_QUOTE', 'SALES', 'elig-5');
    const first = evaluateEligibility(config, c, { essentialComplete: true, escalationSignal: false });
    await routeCase(config, c, first, {
      contactName: 'Ana',
      contactPhone: null,
      channel: 'cli',
      openQuestions: [],
    });

    const reloaded = getCase(c.row.id)!;
    expect(reloaded.row.status).toBe('ROUTED');
    expect(evaluateEligibility(config, reloaded, { essentialComplete: true, escalationSignal: false }).eligible).toBe(
      false,
    );
  });

  it('sin destino configurado no hay canalización', () => {
    writeTenant('sin-destino', {
      routing: `routing:\n  CUSTOMER_SERVICE:\n    type: LOG\n    to: []\n    confirmation_semantics: REGISTERED_ONLY\n`,
    });
    clearTenantCache();
    ensureTenantRow('sin-destino', 'Sin Destino');
    const other = requireTenantConfig('sin-destino');

    const { contact } = resolveContact({ tenantId: 'sin-destino', channel: 'cli', externalUserId: 'x' });
    const conv = getOrCreateConversation('sin-destino', contact.id, 'cli');
    const c = createCase({
      tenantId: 'sin-destino',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });

    // Sin routing.SALES y sin fallback declarado en este override.
    const d = evaluateEligibility(other, c, { essentialComplete: true, escalationSignal: false });
    expect(d.eligible).toBe(false);
  });
});

describe('la canalización ocurre ANTES de poder confirmarla', () => {
  it('el caso queda ROUTED y sólo autoriza el alcance del destino', async () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'orden-1' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const c = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });

    // Antes de canalizar: nada autorizado.
    expect(getCase(c.row.id)!.row.status).toBe('OPEN');

    const decision = evaluateEligibility(config, c, { essentialComplete: true, escalationSignal: false });
    const outcome = await routeCase(config, c, decision, {
      contactName: 'Pedro',
      contactPhone: '+521555',
      channel: 'cli',
      openQuestions: ['revisar disponibilidad'],
    });

    expect(outcome.routed).toBe(true);
    // El adapter LOG no entrega a nadie: sólo autoriza decir "registrado".
    expect(outcome.confirmationSemantics).toBe('REGISTERED_ONLY');
    expect(getCase(c.row.id)!.row.status).toBe('ROUTED');
  });

  it('una decisión no elegible no produce canalización', async () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'orden-2' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const c = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });

    const outcome = await routeCase(
      config,
      c,
      { eligible: false, reason: 'faltan campos esenciales', target: null },
      { contactName: null, contactPhone: null, channel: 'cli', openQuestions: [] },
    );

    expect(outcome.routed).toBe(false);
    expect(outcome.confirmationSemantics).toBeNull();
    expect(getCase(c.row.id)!.row.status).toBe('OPEN');
  });
});

describe('constructor del system prompt', () => {
  const wf = config.workflows.workflows.SALES_QUOTE;

  function prompt(overrides: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) {
    return buildSystemPrompt({
      config,
      mode: 'demo',
      channel: 'whatsapp',
      contactName: 'Pedro Páramo',
      channelKnownFacts: ['número de whatsapp de contacto'],
      activeCases: [],
      lastSentiment: null,
      ambiguityCount: 0,
      hasKnowledge: true,
      globalCannotDo: ['dar precios'],
      ...overrides,
    });
  }

  it('se construye desde la configuración, no desde constantes', () => {
    const text = prompt();
    expect(text).toContain('Empresa de Prueba');
    expect(text).toContain('Asistente de Prueba');
    expect(text).toContain('de usted');
    expect(text).toContain('SALES_QUOTE');
  });

  it('cambiar de tenant cambia el prompt sin tocar código', () => {
    writeTenant('otra-marca', {
      company: `company:
  id: otra-marca
  name: "Marca Distinta"
assistant:
  display_name: "Recepción Distinta"
  locale: es-MX
channels:
  whatsapp:
    enabled: true
`,
      personality: `base:
  style: [directo]
  pronoun_style: tu
  principles: []
  banned_phrases: []
  max_questions_per_reply: 2
tones: {}
`,
    });
    clearTenantCache();
    const other = requireTenantConfig('otra-marca');
    const text = buildSystemPrompt({
      config: other,
      mode: 'demo',
      channel: 'whatsapp',
      contactName: null,
      channelKnownFacts: [],
      activeCases: [],
      lastSentiment: null,
      ambiguityCount: 0,
      hasKnowledge: false,
      globalCannotDo: [],
    });
    expect(text).toContain('Marca Distinta');
    expect(text).toContain('de tú');
    expect(text).not.toContain('Empresa de Prueba');
  });

  it('declara explícitamente lo que ya sabe y lo que falta', () => {
    const status = evaluateFields(wf, { product: 'Tolueno' }, { channel: 'whatsapp', phone: '+521555' });
    const text = prompt({
      activeCases: [
        {
          caseId: 1,
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status,
          routed: false,
          confirmationSemantics: null,
        },
      ],
    });
    expect(text).toContain('YA SABES');
    expect(text).toContain('NO AUTORIZADO');

    // La clave técnica tiene que ser visible junto a la etiqueta legible.
    // Mostrar sólo "cantidad" obligaba al modelo a inventar la clave al
    // reportar el dato, y la extracción se perdía.
    expect(text).toContain('product (producto) = Tolueno');
    expect(text).toContain('FALTA (esencial): quantity (cantidad)');
    expect(text).toContain('Claves válidas de SALES_QUOTE');
    expect(text).toContain('product, quantity, contact_name, contact_phone, intended_use');
  });

  it('sólo autoriza confirmar cuando el caso ya se canalizó', () => {
    const status = evaluateFields(wf, { product: 'X', quantity: '1' }, { channel: 'whatsapp', phone: '+1' });

    const notRouted = prompt({
      activeCases: [
        { caseId: 1, workflowKey: 'SALES_QUOTE', departmentKey: 'SALES', status, routed: false, confirmationSemantics: null },
      ],
    });
    expect(notRouted).toContain('NO AUTORIZADO');

    const routed = prompt({
      activeCases: [
        {
          caseId: 1,
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status,
          routed: true,
          confirmationSemantics: 'REGISTERED_ONLY',
        },
      ],
    });
    expect(routed).toContain('AUTORIZADO');
    expect(routed).toContain('NO afirmes que ya lo recibió');
  });

  it('prohíbe explícitamente las frases que exponen las tripas', () => {
    const text = prompt();
    expect(text).toContain('no tengo acceso al sistema');
    expect(text).toContain('base de datos');
    expect(text).toContain('a la brevedad posible'); // banned_phrase del tenant
  });

  it('endurece el comportamiento cuando el cliente está molesto', () => {
    const text = prompt({ lastSentiment: 'ANGRY' });
    expect(text).toContain('ANGRY');
    expect(text).toContain('no defensivo');
  });

  it('rompe el bucle tras varias ambigüedades', () => {
    expect(prompt({ ambiguityCount: 0 })).not.toContain('turnos ambiguos');
    expect(prompt({ ambiguityCount: 3 })).toContain('turnos ambiguos');
  });

  it('declara los datos que el canal ya aporta', () => {
    expect(prompt()).toContain('NO debes volver a pedir');
  });

  it('sin knowledge, prohíbe afirmar datos concretos', () => {
    expect(prompt({ hasKnowledge: false })).toContain('no puedes afirmar ningún dato concreto');
  });
});
