import { describe, expect, it } from 'vitest';


import { writeTenant } from './helpers/fixtures';
import { clearTenantCache, requireTenantConfig } from '../src/tenants/tenant-loader';
import {
  allFields,
  channelSatisfiedFields,
  evaluateFields,
  isMeaningful,
  mergeFields,
  nextFocus,
  resolveFieldKey,
} from '../src/workflows/field-engine';
import {
  enabledWorkflows,
  fieldLabel,
  routableIntents,
  toneFor,
  workflowForIntent,
} from '../src/workflows/workflow-engine';
import { normalizeAiOutput } from '../src/ai/ai-schema';

writeTenant('acme');
clearTenantCache();
const config = requireTenantConfig('acme');
const wf = config.workflows.workflows.SALES_QUOTE;

describe('valores significativos', () => {
  it('descarta relleno y basura del modelo', () => {
    for (const junk of ['', '   ', '-', 'N/A', 'null', 'undefined', 'no sé', 'TBD', 'pendiente']) {
      expect(isMeaningful(junk)).toBe(false);
    }
    expect(isMeaningful('Tolueno')).toBe(true);
    expect(isMeaningful(42 as unknown as string)).toBe(false);
  });
});

describe('fusión de campos', () => {
  it('acepta valores nuevos y significativos', () => {
    const { merged, changed } = mergeFields({}, { product: 'Tolueno', quantity: '800 L' }, wf);
    expect(merged).toEqual({ product: 'Tolueno', quantity: '800 L' });
    expect(changed.sort()).toEqual(['product', 'quantity']);
  });

  it('nunca borra un valor confirmado con basura', () => {
    const { merged, changed } = mergeFields({ product: 'Tolueno' }, { product: 'N/A' }, wf);
    expect(merged.product).toBe('Tolueno');
    expect(changed).toEqual([]);
  });

  it('permite que el usuario se corrija', () => {
    const { merged, changed } = mergeFields({ quantity: '800 L' }, { quantity: '1200 L' }, wf);
    expect(merged.quantity).toBe('1200 L');
    expect(changed).toEqual(['quantity']);
  });

  it('ignora campos que no pertenecen al workflow', () => {
    const { merged } = mergeFields({}, { inventado: 'x', product: 'Xileno' }, wf);
    expect(merged).toEqual({ product: 'Xileno' });
  });

  it('no registra cambio si el valor es idéntico', () => {
    const { changed } = mergeFields({ product: 'Tolueno' }, { product: 'Tolueno' }, wf);
    expect(changed).toEqual([]);
  });
});

describe('datos que aporta el canal', () => {
  it('satisface el teléfono sin preguntarlo', () => {
    const satisfied = channelSatisfiedFields(wf, { channel: 'whatsapp', phone: '+5215550001111' });
    expect(satisfied.contact_phone).toBe('+5215550001111');
  });

  it('no inventa nada si el canal no aporta', () => {
    expect(channelSatisfiedFields(wf, { channel: 'cli' })).toEqual({});
  });

  it('sólo satisface campos declarados en satisfied_by_channel', () => {
    const satisfied = channelSatisfiedFields(wf, {
      channel: 'whatsapp',
      phone: '+52155',
      profileName: 'Pedro',
    });
    // contact_name existe en el workflow pero NO está en satisfied_by_channel.
    expect(satisfied.contact_name).toBeUndefined();
  });
});

describe('evaluación de campos esenciales', () => {
  it('marca lo que falta', () => {
    const status = evaluateFields(wf, { product: 'Tolueno' }, { channel: 'cli' });
    expect(status.missingEssential).toEqual(['quantity']);
    expect(status.essentialComplete).toBe(false);
    expect(nextFocus(status)).toBe('quantity');
  });

  it('completa cuando están todos los esenciales', () => {
    const status = evaluateFields(wf, { product: 'Tolueno', quantity: '800 L' }, { channel: 'cli' });
    expect(status.missingEssential).toEqual([]);
    expect(status.essentialComplete).toBe(true);
  });

  it('el siguiente foco prioriza esencial sobre útil', () => {
    const status = evaluateFields(wf, {}, { channel: 'cli' });
    expect(nextFocus(status)).toBe('product');
  });

  it('nunca propone un campo opcional como foco', () => {
    const status = evaluateFields(
      wf,
      { product: 'X', quantity: '1', contact_name: 'Ana' },
      { channel: 'whatsapp', phone: '+521' },
    );
    expect(nextFocus(status)).toBeNull();
    expect(status.missingOptional).toContain('intended_use');
  });

  it('resuelve claves que el modelo reportó mal', () => {
    // El fallo real observado: el modelo traducía la etiqueta legible en vez de
    // usar la clave, y el dato se perdía.
    expect(resolveFieldKey(wf, 'quantity')).toBe('quantity');
    expect(resolveFieldKey(wf, 'cantidad')).toBe('quantity');
    expect(resolveFieldKey(wf, 'Cantidad')).toBe('quantity');
    expect(resolveFieldKey(wf, 'contact-phone')).toBe('contact_phone');
    expect(resolveFieldKey(wf, 'teléfono')).toBe('contact_phone');
    expect(resolveFieldKey(wf, 'producto')).toBe('product');
  });

  it('no adivina cuando la clave no corresponde a nada', () => {
    expect(resolveFieldKey(wf, 'color_favorito')).toBeNull();
    expect(resolveFieldKey(wf, '')).toBeNull();
    expect(resolveFieldKey(wf, '   ')).toBeNull();
  });

  it('allFields cubre los tres niveles', () => {
    expect(allFields(wf).sort()).toEqual(
      ['contact_name', 'contact_phone', 'intended_use', 'product', 'quantity'].sort(),
    );
  });
});

describe('resolución de workflow por intent', () => {
  it('mapea el intent a su workflow habilitado', () => {
    expect(workflowForIntent(config, 'SALES_QUOTE')?.key).toBe('SALES_QUOTE');
    expect(workflowForIntent(config, 'GENERAL_INFORMATION')?.key).toBe('INFO');
  });

  it('devuelve null para un intent sin workflow', () => {
    expect(workflowForIntent(config, 'SUPPLIER')).toBeNull();
  });

  it('ignora workflows deshabilitados', () => {
    writeTenant('off', {
      workflows: `workflows:
  SALES_QUOTE:
    enabled: false
    department: SALES
    strategy: collect_then_route
    intents: [SALES_QUOTE]
    fields: { essential: [a], useful: [], optional: [] }
    field_labels: { a: "a" }
    routing: { require_all_essential: true, satisfied_by_channel: [] }
    cannot_do: []
`,
    });
    clearTenantCache();
    const off = requireTenantConfig('off');
    expect(workflowForIntent(off, 'SALES_QUOTE')).toBeNull();
    expect(enabledWorkflows(off)).toEqual([]);
  });

  it('routableIntents refleja lo configurado', () => {
    expect(routableIntents(config).sort()).toEqual(['GENERAL_INFORMATION', 'SALES_QUOTE']);
  });

  it('fieldLabel cae a la clave técnica si no hay etiqueta', () => {
    expect(fieldLabel(wf, 'product')).toBe('producto');
    expect(fieldLabel(wf, 'inexistente')).toBe('inexistente');
  });

  it('toneFor usa el tono del workflow y si no el estilo base', () => {
    expect(toneFor(config, 'SALES_QUOTE')).toEqual(['comercial']);
    expect(toneFor(config, 'NO_EXISTE')).toEqual(config.personality.base.style);
    expect(toneFor(config, null)).toEqual(config.personality.base.style);
  });
});

describe('normalización de la salida del modelo', () => {
  it('detecta varios intents y los ordena por confianza', () => {
    const out = normalizeAiOutput({
      reply: 'ok',
      detected_intents: [
        { intent: 'INVOICE', confidence: 0.7 },
        { intent: 'PRODUCT_DAMAGE', confidence: 0.95 },
      ],
      field_updates: [],
      customer_sentiment: 'NEUTRAL',
      urgency_signal: 'NORMAL',
      knowledge_used: false,
      needs_clarification: false,
      suggested_next_focus: '',
      requested_actions: [],
      onboarding_gaps: [],
    });
    expect(out.detected_intents.map((i) => i.intent)).toEqual(['PRODUCT_DAMAGE', 'INVOICE']);
  });

  it('descarta intents desconocidos y recorta confianzas', () => {
    const out = normalizeAiOutput({
      detected_intents: [
        { intent: 'NO_EXISTE', confidence: 0.9 },
        { intent: 'SALES_QUOTE', confidence: 5 },
      ],
    });
    expect(out.detected_intents).toEqual([{ intent: 'SALES_QUOTE', confidence: 1 }]);
  });

  it('sobrevive a una salida vacía', () => {
    const out = normalizeAiOutput(null);
    expect(out.reply).toBe('');
    expect(out.customer_sentiment).toBe('NEUTRAL');
    expect(out.detected_intents).toEqual([]);
    expect(out.onboarding_gaps).toEqual([]);
  });

  it('deduplica el mismo intent quedándose con la confianza mayor', () => {
    const out = normalizeAiOutput({
      detected_intents: [
        { intent: 'SALES_QUOTE', confidence: 0.4 },
        { intent: 'SALES_QUOTE', confidence: 0.8 },
      ],
    });
    expect(out.detected_intents).toEqual([{ intent: 'SALES_QUOTE', confidence: 0.8 }]);
  });
});
