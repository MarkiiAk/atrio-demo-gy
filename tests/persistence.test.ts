import { afterAll, describe, expect, it } from 'vitest';


import { writeTenant } from './helpers/fixtures';
import { clearTenantCache } from '../src/tenants/tenant-loader';
import { closeDb, ensureTenantRow, getDb } from '../src/db';
import { resolveContact, setContactName } from '../src/repositories/contact.repository';
import {
  getOrCreateConversation,
  recentMessages,
  recordMessage,
  updateConversationState,
} from '../src/repositories/conversation.repository';
import {
  createCase,
  findActiveCaseByWorkflow,
  findOpenCaseByWorkflow,
  openCases,
  recordCaseIntent,
  setCaseStatus,
  upsertCaseFields,
} from '../src/repositories/case.repository';
import { claimNextBatch, completeJobs, enqueueInbound, failJobs, jobStats } from '../src/jobs/job.repository';
import { acceptInbound } from '../src/conversation/conversation.service';
import { buildGapReport, normalizeTopic, recordGap } from '../src/onboarding/gap.service';
import { buildUsageReport, recordUsage } from '../src/usage/usage.service';

writeTenant('acme');
clearTenantCache();
ensureTenantRow('acme', 'Empresa de Prueba');
ensureTenantRow('otra', 'Otra Empresa');

afterAll(() => closeDb());

describe('contactos e identidades', () => {
  it('crea contacto e identidad la primera vez y reutiliza después', () => {
    const first = resolveContact({
      tenantId: 'acme',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550001111',
      phone: '+5215550001111',
      profileName: 'Pedro',
    });
    const second = resolveContact({
      tenantId: 'acme',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550001111',
      phone: '+5215550001111',
      profileName: 'Pedro Páramo',
    });

    expect(second.contact.id).toBe(first.contact.id);
    expect(second.identity.id).toBe(first.identity.id);
    expect(second.identity.profile_name).toBe('Pedro Páramo');
  });

  it('el mismo número en otro tenant es otro contacto', () => {
    const a = resolveContact({
      tenantId: 'acme',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550002222',
    });
    const b = resolveContact({
      tenantId: 'otra',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550002222',
    });
    expect(a.contact.id).not.toBe(b.contact.id);
    expect(a.contact.tenant_id).toBe('acme');
    expect(b.contact.tenant_id).toBe('otra');
  });

  it('el mismo teléfono en otro canal es otra identidad del mismo tenant', () => {
    const wa = resolveContact({
      tenantId: 'acme',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550003333',
    });
    const web = resolveContact({
      tenantId: 'acme',
      channel: 'web',
      externalUserId: 'sesion-abc',
    });
    expect(wa.identity.id).not.toBe(web.identity.id);
  });

  it('guarda el nombre detectado', () => {
    const { contact } = resolveContact({
      tenantId: 'acme',
      channel: 'web',
      externalUserId: 'sesion-nombre',
    });
    setContactName(contact.id, 'Ana Ruiz');
    const row = getDb().prepare('SELECT display_name FROM contacts WHERE id = ?').get(contact.id) as {
      display_name: string;
    };
    expect(row.display_name).toBe('Ana Ruiz');
  });
});

describe('idempotencia de mensajes', () => {
  it('un MessageSid repetido NO se persiste dos veces', () => {
    const { contact } = resolveContact({
      tenantId: 'acme',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550009999',
    });
    const conv = getOrCreateConversation('acme', contact.id, 'whatsapp');

    const first = recordMessage({
      tenantId: 'acme',
      conversationId: conv.id,
      direction: 'INBOUND',
      body: 'Hola',
      provider: 'twilio',
      providerMessageId: 'SM_DUPLICADO',
    });
    const second = recordMessage({
      tenantId: 'acme',
      conversationId: conv.id,
      direction: 'INBOUND',
      body: 'Hola',
      provider: 'twilio',
      providerMessageId: 'SM_DUPLICADO',
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE provider_message_id = 'SM_DUPLICADO'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('acceptInbound devuelve null ante un reintento de webhook', () => {
    const a = acceptInbound({
      tenantId: 'acme',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550008888',
      body: 'Cotización',
      provider: 'twilio',
      providerMessageId: 'SM_REINTENTO',
    });
    const b = acceptInbound({
      tenantId: 'acme',
      channel: 'whatsapp',
      externalUserId: 'whatsapp:+5215550008888',
      body: 'Cotización',
      provider: 'twilio',
      providerMessageId: 'SM_REINTENTO',
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('mensajes sin id de proveedor siempre se persisten', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-1' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    expect(recordMessage({ tenantId: 'acme', conversationId: conv.id, direction: 'INBOUND', body: 'a' })).not.toBeNull();
    expect(recordMessage({ tenantId: 'acme', conversationId: conv.id, direction: 'INBOUND', body: 'a' })).not.toBeNull();
  });

  it('el historial se devuelve del más viejo al más nuevo', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-orden' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    for (const body of ['uno', 'dos', 'tres']) {
      recordMessage({ tenantId: 'acme', conversationId: conv.id, direction: 'INBOUND', body });
    }
    expect(recentMessages(conv.id).map((m) => m.body)).toEqual(['uno', 'dos', 'tres']);
  });
});

describe('conversación y casos', () => {
  it('una conversación puede producir varios casos', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-multi' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');

    const quote = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });
    const info = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'INFO',
      departmentKey: 'CUSTOMER_SERVICE',
    });

    expect(quote.row.id).not.toBe(info.row.id);
    expect(openCases(conv.id)).toHaveLength(2);
  });

  it('reencuentra el caso abierto del mismo workflow en vez de duplicarlo', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-reuse' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const created = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });
    expect(findOpenCaseByWorkflow(conv.id, 'SALES_QUOTE')?.row.id).toBe(created.row.id);

    setCaseStatus(created.row.id, 'ROUTED');
    expect(findOpenCaseByWorkflow(conv.id, 'SALES_QUOTE')).toBeNull();
  });

  it('un caso ya canalizado sigue siendo el caso activo del asunto', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-activo' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const created = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });
    upsertCaseFields(created.row.id, { product: 'Tolueno', quantity: '800 L' }, 'LLM');
    setCaseStatus(created.row.id, 'ROUTED');

    // Si esto devolviera null, el siguiente mensaje abriría un caso VACÍO y el
    // asistente volvería a preguntar producto y cantidad.
    const active = findActiveCaseByWorkflow(conv.id, 'SALES_QUOTE');
    expect(active?.row.id).toBe(created.row.id);
    expect(active?.fields).toEqual({ product: 'Tolueno', quantity: '800 L' });

    setCaseStatus(created.row.id, 'CLOSED');
    expect(findActiveCaseByWorkflow(conv.id, 'SALES_QUOTE')).toBeNull();
  });

  it('los campos del caso se acumulan y sobrescriben', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-campos' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const c = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });

    upsertCaseFields(c.row.id, { product: 'Tolueno' }, 'LLM');
    upsertCaseFields(c.row.id, { quantity: '800 L' }, 'LLM');
    upsertCaseFields(c.row.id, { product: 'Xileno' }, 'USER');

    const reloaded = findOpenCaseByWorkflow(conv.id, 'SALES_QUOTE');
    expect(reloaded?.fields).toEqual({ product: 'Xileno', quantity: '800 L' });
  });

  it('un intent repetido conserva la confianza más alta', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-intent' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const c = createCase({
      tenantId: 'acme',
      conversationId: conv.id,
      contactId: contact.id,
      workflowKey: 'SALES_QUOTE',
      departmentKey: 'SALES',
    });
    recordCaseIntent(c.row.id, 'SALES_QUOTE', 0.4);
    recordCaseIntent(c.row.id, 'SALES_QUOTE', 0.9);
    recordCaseIntent(c.row.id, 'SALES_QUOTE', 0.6);

    expect(findOpenCaseByWorkflow(conv.id, 'SALES_QUOTE')?.intents).toEqual([
      expect.objectContaining({ intent: 'SALES_QUOTE', confidence: 0.9 }),
    ]);
  });

  it('el contador de ambigüedad sube y se reinicia', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-ambiguo' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');

    updateConversationState(conv.id, { ambiguityDelta: 1 });
    updateConversationState(conv.id, { ambiguityDelta: 1 });
    let row = getDb().prepare('SELECT ambiguity_count FROM conversations WHERE id = ?').get(conv.id) as {
      ambiguity_count: number;
    };
    expect(row.ambiguity_count).toBe(2);

    updateConversationState(conv.id, { ambiguityDelta: 0 });
    row = getDb().prepare('SELECT ambiguity_count FROM conversations WHERE id = ?').get(conv.id) as {
      ambiguity_count: number;
    };
    expect(row.ambiguity_count).toBe(0);
  });
});

describe('cola de entrada: orden y serialización', () => {
  it('agrupa los mensajes pendientes de una misma conversación en un lote', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-cola' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');

    for (const body of ['Hola', 'quiero cotizar', 'tolueno']) {
      const m = recordMessage({ tenantId: 'acme', conversationId: conv.id, direction: 'INBOUND', body });
      enqueueInbound({ tenantId: 'acme', conversationId: conv.id, messageId: m!.id, delayMs: 0 });
    }

    const batch = claimNextBatch();
    expect(batch?.conversationId).toBe(conv.id);
    expect(batch?.jobs).toHaveLength(3);

    // Mientras el lote está en PROCESSING, esa conversación no se vuelve a reclamar.
    expect(claimNextBatch()).toBeNull();

    completeJobs(batch!.jobs.map((j) => j.id));
    expect(claimNextBatch()).toBeNull();
  });

  it('un mismo mensaje no genera dos jobs', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-job-dup' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const m = recordMessage({ tenantId: 'acme', conversationId: conv.id, direction: 'INBOUND', body: 'x' });

    expect(enqueueInbound({ tenantId: 'acme', conversationId: conv.id, messageId: m!.id, delayMs: 0 })).not.toBeNull();
    expect(enqueueInbound({ tenantId: 'acme', conversationId: conv.id, messageId: m!.id, delayMs: 0 })).toBeNull();

    const batch = claimNextBatch();
    expect(batch?.jobs).toHaveLength(1);
    completeJobs(batch!.jobs.map((j) => j.id));
  });

  it('un fallo reencola hasta agotar los intentos', () => {
    const { contact } = resolveContact({ tenantId: 'acme', channel: 'cli', externalUserId: 'cli-fallo' });
    const conv = getOrCreateConversation('acme', contact.id, 'cli');
    const m = recordMessage({ tenantId: 'acme', conversationId: conv.id, direction: 'INBOUND', body: 'y' });
    const job = enqueueInbound({ tenantId: 'acme', conversationId: conv.id, messageId: m!.id, delayMs: 0 })!;

    failJobs([job.id], 'boom');
    let row = getDb().prepare('SELECT status, attempts FROM inbound_jobs WHERE id = ?').get(job.id) as {
      status: string;
      attempts: number;
    };
    expect(row.status).toBe('PENDING');

    getDb().prepare(`UPDATE inbound_jobs SET attempts = 99 WHERE id = ?`).run(job.id);
    failJobs([job.id], 'boom otra vez');
    row = getDb().prepare('SELECT status FROM inbound_jobs WHERE id = ?').get(job.id) as {
      status: string;
      attempts: number;
    };
    expect(row.status).toBe('FAILED');
    expect(jobStats('acme').FAILED).toBeGreaterThan(0);
  });
});

describe('agregación de gaps', () => {
  it('cuenta frecuencia en vez de duplicar filas', () => {
    recordGap({ tenantId: 'acme', gapType: 'UNANSWERED_KNOWLEDGE', topic: '¿Recubrimiento de tambores?' });
    recordGap({ tenantId: 'acme', gapType: 'UNANSWERED_KNOWLEDGE', topic: 'recubrimiento de tambores' });
    recordGap({ tenantId: 'acme', gapType: 'UNANSWERED_KNOWLEDGE', topic: 'Recubrimiento de tambores.' });

    const report = buildGapReport('acme');
    const row = report.byType.UNANSWERED_KNOWLEDGE.find((r) => r.topic.includes('recubrimiento'));
    expect(row?.frequency).toBe(3);
  });

  it('normaliza acentos, signos y espacios', () => {
    expect(normalizeTopic('  ¿Horário  de  ALMACÉN? ')).toBe('horario de almacen');
  });

  it('no mezcla gaps entre tenants', () => {
    recordGap({ tenantId: 'otra', gapType: 'UNANSWERED_KNOWLEDGE', topic: 'algo de otra empresa' });
    const acme = buildGapReport('acme');
    const otra = buildGapReport('otra');
    expect(otra.byType.UNANSWERED_KNOWLEDGE).toHaveLength(1);
    expect(acme.byType.UNANSWERED_KNOWLEDGE.some((r) => r.topic.includes('otra empresa'))).toBe(false);
  });

  it('ignora temas vacíos', () => {
    const before = buildGapReport('acme').total;
    recordGap({ tenantId: 'acme', gapType: 'UNKNOWN_INTENT', topic: '   ' });
    expect(buildGapReport('acme').total).toBe(before);
  });
});

describe('agregación de consumo', () => {
  it('suma tokens y separa por tenant', () => {
    recordUsage({
      tenantId: 'acme',
      conversationId: null,
      model: 'modelo-x',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      openaiRequestId: 'req_1',
      latencyMs: 900,
    });
    recordUsage({
      tenantId: 'acme',
      conversationId: null,
      model: 'modelo-x',
      inputTokens: 200,
      outputTokens: 60,
      totalTokens: 260,
      openaiRequestId: 'req_2',
      latencyMs: 1100,
    });
    recordUsage({
      tenantId: 'otra',
      conversationId: null,
      model: 'modelo-y',
      inputTokens: 999,
      outputTokens: 999,
      totalTokens: 1998,
      openaiRequestId: 'req_3',
      latencyMs: 100,
    });

    const acme = buildUsageReport('acme', 30);
    expect(acme.openaiCalls).toBe(2);
    expect(acme.inputTokens).toBe(300);
    expect(acme.totalTokens).toBe(410);
    expect(acme.avgLatencyMs).toBe(1000);
    expect(acme.byModel.map((m) => m.model)).toEqual(['modelo-x']);

    expect(buildUsageReport('otra', 30).totalTokens).toBe(1998);
  });

  it('calcula total cuando no se pasa explícito', () => {
    ensureTenantRow('tercera', 'Tercera');
    recordUsage({
      tenantId: 'tercera',
      conversationId: null,
      model: 'm',
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 0,
      openaiRequestId: null,
      latencyMs: 5,
    });
    expect(buildUsageReport('tercera', 30).totalTokens).toBe(10);
  });
});
