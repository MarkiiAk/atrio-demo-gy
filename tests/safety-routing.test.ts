import { afterAll, describe, expect, it } from 'vitest';


import { writeTenant } from './helpers/fixtures';
import { clearTenantCache, requireTenantConfig } from '../src/tenants/tenant-loader';
import { closeDb, ensureTenantRow } from '../src/db';
import { buildCorrectionInstruction, inspectReply, safeFallbackFor } from '../src/conversation/reply-guard';
import { evaluateEligibility, routeCase } from '../src/routing/routing.service';
import { createCase, getCase, upsertCaseFields } from '../src/repositories/case.repository';
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
    // Suena inofensivo, pero afirma un hecho que todavía no ocurrió.
    'La solicitud queda registrada para seguimiento.',
    'Su solicitud ya quedó registrada.',
    'Listo, ya la anoté.',
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
      // Condicional: ofrece hacerlo, no afirma que ya pasó.
      'Gracias, con el número de pedido puedo dejar registrada la revisión.',
      'Si me confirma la cantidad, preparo la solicitud.',
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

describe('guardián: afirmar que se ofrece algo no documentado', () => {
  // Catálogo de prueba: tiene tolueno y acetatos, NO tiene acetona ni óxido nitroso.
  const catalogo = new Set(['tolueno', 'acetato de etilo', 'alcohol isopropilico', 'productos quimicos']);
  const verify = (term: string) => {
    const t = term.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return [...catalogo].some((c) => c.includes(t) || t.includes(c)) ? 'FOUND' : 'NOT_FOUND';
  };
  const ctx = { config, deliveryAuthorized: false, confirmationSemantics: null, verify } as const;

  it('bloquea afirmar un producto que no está en el catálogo', () => {
    // El fallo real observado con Grupo Yoma.
    for (const reply of [
      'Sí manejamos óxido nitroso. Para preparar su cotización necesito la cantidad.',
      'Sí, vendemos acetona en varias presentaciones.',
      'Claro, contamos con hidróxido de sodio.',
    ]) {
      const r = inspectReply(reply, ctx);
      expect(r.ok, `debió bloquear: "${reply}"`).toBe(false);
      expect(r.violations.some((v) => v.kind === 'UNVERIFIED_CLAIM')).toBe(true);
    }
  });

  it('NO bloquea la respuesta honesta que niega tener el producto', () => {
    // Falso positivo real en producción: el modelo contestó bien —"no tenemos
    // confirmado acetona dentro de lo que manejamos"— y el guardián lo leyó
    // como una afirmación, tiró la respuesta correcta y puso un texto roto.
    for (const reply of [
      'No tenemos confirmado acetona dentro de lo que manejamos.',
      'No manejamos óxido nitroso, pero sí tolueno y xileno.',
      'Sobre la acetona, no tengo confirmado que la vendamos.',
      'Ni vendemos acetona ni la distribuimos.',
      'No contamos con hidróxido de sodio en este momento.',
    ]) {
      const r = inspectReply(reply, ctx);
      expect(
        r.violations.some((v) => v.kind === 'UNVERIFIED_CLAIM'),
        `no debió marcar como afirmación: "${reply}"`,
      ).toBe(false);
    }
  });

  it('cuando sí bloquea, nombra el producto y no una muletilla', () => {
    const r = inspectReply('Sí tenemos disponible óxido nitroso para su pedido.', ctx);
    const v = r.violations.find((x) => x.kind === 'UNVERIFIED_CLAIM');
    expect(v).toBeDefined();
    // "disponible" es un adjetivo, no el producto.
    expect(v!.match.toLowerCase()).toContain('xido nitroso');
    expect(v!.match.toLowerCase()).not.toContain('disponible');
  });

  it('permite afirmar lo que sí está documentado', () => {
    for (const reply of [
      'Sí manejamos tolueno, en tambos y porrones.',
      'Sí, tenemos acetato de etilo disponible.',
      'Manejamos productos químicos para uso industrial.',
    ]) {
      expect(inspectReply(reply, ctx).ok, `no debió bloquear: "${reply}"`).toBe(true);
    }
  });

  it('no bloquea cuando no hay documentación con qué contrastar', () => {
    const sinKnowledge = {
      config,
      deliveryAuthorized: false,
      confirmationSemantics: null,
      verify: () => 'NO_KNOWLEDGE' as const,
    };
    expect(inspectReply('Sí manejamos óxido nitroso.', sinKnowledge).ok).toBe(true);
  });

  it('sin verificador disponible el guardián no inventa violaciones', () => {
    const sinVerify = { config, deliveryAuthorized: false, confirmationSemantics: null };
    expect(inspectReply('Sí manejamos óxido nitroso.', sinVerify).ok).toBe(true);
  });

  it('la corrección le dice al modelo qué término retirar', () => {
    const r = inspectReply('Sí manejamos óxido nitroso.', ctx);
    expect(buildCorrectionInstruction(r)).toContain('óxido nitroso');
  });

  it('el texto de respaldo encaja con lo que se bloqueó', () => {
    // El fallo real: ante un producto sin confirmar caía un genérico ("ya tengo
    // la información necesaria") que suena a que todo va bien justo cuando no.
    const porProducto = safeFallbackFor(inspectReply('Sí manejamos óxido nitroso.', ctx), ctx);
    expect(porProducto).toContain('óxido nitroso');
    expect(porProducto).not.toContain('Ya tengo la información necesaria');

    // Una promesa de entrega indebida sí usa el texto del tenant.
    const porEntrega = safeFallbackFor(
      inspectReply('Ya envié su solicitud al área.', unauthorized),
      unauthorized,
    );
    expect(porEntrega).toBe(config.company.assistant.routing_failed_message);
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
  /**
   * Crea un caso CON datos. Un caso vacío no se canaliza por diseño (evita los
   * avisos basura al área), así que sembrar un campo es parte del escenario.
   */
  function makeCase(
    workflowKey: string,
    department: string,
    external: string,
    fields: Record<string, string> = { product: 'Tolueno' },
  ) {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: external });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const created = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey,
      departmentKey: department,
    });
    if (Object.keys(fields).length > 0) {
      upsertCaseFields(created.row.id, fields, 'LLM');
      return getCase(created.row.id)!;
    }
    return created;
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
    const c = makeCase('INFO', 'CUSTOMER_SERVICE', 'elig-3', { topic: 'horarios' });
    const d = evaluateEligibility(config, c, { essentialComplete: true, escalationSignal: false });
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('informativa');
  });

  it('BLOQUEA la canalización si un dato no está confirmado en la documentación', () => {
    // El caso real: alguien pidió cotizar óxido nitroso, que Grupo Yoma no
    // vende, y el sistema canalizó la solicitud a Ventas igualmente.
    const c = makeCase('SALES_QUOTE', 'SALES', 'elig-unverified');
    const d = evaluateEligibility(config, c, {
      essentialComplete: true,
      escalationSignal: false,
      unverifiedFields: ['product'],
    });
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('sin confirmar');
    expect(d.target).toBeNull();
  });

  it('canaliza normalmente cuando todo está confirmado', () => {
    const c = makeCase('SALES_QUOTE', 'SALES', 'elig-verified');
    const d = evaluateEligibility(config, c, {
      essentialComplete: true,
      escalationSignal: false,
      unverifiedFields: [],
    });
    expect(d.eligible).toBe(true);
  });

  it('NUNCA avisa al área con un caso vacío', () => {
    // El fallo real: llegó un aviso por WhatsApp que sólo decía "alguien
    // escribió", sin un solo dato. Ese ruido hace que el responsable deje de
    // leer el canal interno.
    const c = makeCase('INFO', 'CUSTOMER_SERVICE', 'elig-vacio', {});
    const d = evaluateEligibility(config, c, { essentialComplete: true, escalationSignal: true });
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('sin información sustantiva');
  });

  it('un flujo informativo SÍ escala cuando hay algo concreto sin resolver', () => {
    const c = makeCase('INFO', 'CUSTOMER_SERVICE', 'elig-4', {
      topic: 'recubrimiento interior de los tambores',
    });
    const d = evaluateEligibility(config, c, {
      essentialComplete: true,
      escalationSignal: true,
    });
    expect(d.eligible).toBe(true);
  });

  it('el teléfono que aporta el canal no basta para justificar un aviso', () => {
    // Llega solo, sin que la persona haya dicho nada: no es información.
    const c = makeCase('SALES_QUOTE', 'SALES', 'elig-solo-canal', {
      contact_phone: '+5215519330800',
    });
    const d = evaluateEligibility(config, c, {
      essentialComplete: true,
      escalationSignal: false,
    });
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain('sin información sustantiva');
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
    const created = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });
    // Con datos reales: un caso vacío no se canaliza por diseño.
    upsertCaseFields(created.row.id, { product: 'Tolueno', quantity: '800 L' }, 'LLM');
    const c = getCase(created.row.id)!;

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
          folio: 'COT-0001',
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status,
          routed: false,
          confirmationSemantics: null,
          unverified: [],
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
        {
          caseId: 1,
          folio: 'COT-0001',
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status,
          routed: false,
          justRouted: false,
          registered: false,
          confirmationSemantics: null,
          unverified: [],
        },
      ],
    });
    expect(notRouted).toContain('NO AUTORIZADO');

    const justRouted = prompt({
      activeCases: [
        {
          caseId: 1,
          folio: 'COT-0001',
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status,
          routed: true,
          justRouted: true,
          registered: true,
          confirmationSemantics: 'REGISTERED_ONLY',
          unverified: [],
        },
      ],
    });
    expect(justRouted).toContain('CIERRA ESTE ASUNTO (sólo en esta respuesta)');
    expect(justRouted).toContain('COT-0001'); // el folio va en el cierre
    expect(justRouted).toContain('NO afirmes que ya la recibió');

    // Turnos posteriores: ya se confirmó. Repetirlo es la muletilla que hace
    // que el asistente suene a robot.
    const alreadyConfirmed = prompt({
      activeCases: [
        {
          caseId: 1,
          folio: 'COT-0001',
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status,
          routed: true,
          justRouted: false,
          registered: true,
          confirmationSemantics: 'REGISTERED_ONLY',
          unverified: [],
        },
      ],
    });
    expect(alreadyConfirmed).toContain('YA CONFIRMADO');
    expect(alreadyConfirmed).toContain('NO lo vuelvas a anunciar');

    // Caso completo cuyo aviso al área FALLÓ: el registro sí existe, así que el
    // folio se puede dar. Lo que no se puede es decir que ya llegó a alguien.
    const registradoSinEntrega = prompt({
      activeCases: [
        {
          caseId: 1,
          folio: 'COT-0001',
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status,
          routed: false,
          justRouted: false,
          registered: true,
          confirmationSemantics: null,
          unverified: [],
        },
      ],
    });
    expect(registradoSinEntrega).toContain('COT-0001');
    expect(registradoSinEntrega).toContain('quedó REGISTRADA');
    expect(registradoSinEntrega).toContain('NO puedes decir es que ya llegó');

    // Caso incompleto: ni folio ni confirmación de nada.
    const incompleto = prompt({
      activeCases: [
        {
          caseId: 1,
          folio: 'COT-0001',
          workflowKey: 'SALES_QUOTE',
          departmentKey: 'SALES',
          status: evaluateFields(wf, {}, { channel: 'whatsapp', phone: '+1' }),
          routed: false,
          justRouted: false,
          registered: false,
          confirmationSemantics: null,
          unverified: [],
        },
      ],
    });
    expect(incompleto).toContain('NO AUTORIZADO');
    expect(incompleto).toContain('no des folio');
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
