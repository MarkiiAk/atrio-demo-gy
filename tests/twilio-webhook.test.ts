import { afterAll, describe, expect, it } from 'vitest';


import request from 'supertest';
import twilio from 'twilio';
import { writeTenant } from './helpers/fixtures';
import { clearTenantCache } from '../src/tenants/tenant-loader';
import { closeDb, getDb } from '../src/db';
import { createApp } from '../src/app';
import { normalizeWhatsAppAddress, resolveTenantByInboundTo } from '../src/channels/whatsapp/tenant-resolver';
import { splitForWhatsApp } from '../src/channels/whatsapp/twilio.service';
import { maskPhone, scrubSecrets } from '../src/lib/logger';

writeTenant('acme');
clearTenantCache();

const app = createApp();
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN as string;
const WEBHOOK_URL = 'https://demo.example.com/webhooks/twilio/whatsapp';

function sign(params: Record<string, string>, url = WEBHOOK_URL): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
}

function inbound(sid: string, body = 'Hola'): Record<string, string> {
  return {
    From: 'whatsapp:+5215551234567',
    To: 'whatsapp:+15550000001',
    Body: body,
    MessageSid: sid,
    ProfileName: 'Pedro',
    NumMedia: '0',
  };
}

afterAll(() => closeDb());

describe('validación de firma de Twilio', () => {
  it('rechaza una petición sin firma', async () => {
    const res = await request(app).post('/webhooks/twilio/whatsapp').type('form').send(inbound('SM_NOSIG'));
    expect(res.status).toBe(403);
  });

  it('rechaza una firma calculada sobre otra URL', async () => {
    const params = inbound('SM_URLMALA');
    const res = await request(app)
      .post('/webhooks/twilio/whatsapp')
      .type('form')
      .set('X-Twilio-Signature', sign(params, 'https://otro-host.example.com/webhooks/twilio/whatsapp'))
      .send(params);
    expect(res.status).toBe(403);
  });

  it('rechaza si un parámetro fue alterado tras firmar', async () => {
    const params = inbound('SM_ALTERADO');
    const signature = sign(params);
    const res = await request(app)
      .post('/webhooks/twilio/whatsapp')
      .type('form')
      .set('X-Twilio-Signature', signature)
      .send({ ...params, Body: 'texto inyectado' });
    expect(res.status).toBe(403);
  });

  it('acepta una firma correcta y responde TwiML vacío', async () => {
    const params = inbound('SM_OK_1');
    const res = await request(app)
      .post('/webhooks/twilio/whatsapp')
      .type('form')
      .set('X-Twilio-Signature', sign(params))
      .send(params);

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response></Response>');
  });
});

describe('idempotencia del webhook', () => {
  it('un reintento con el mismo MessageSid no duplica mensaje ni job', async () => {
    const params = inbound('SM_IDEMPOTENTE', 'Quiero cotizar tolueno');
    const signature = sign(params);

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/webhooks/twilio/whatsapp')
        .type('form')
        .set('X-Twilio-Signature', signature)
        .send(params);
      expect(res.status).toBe(200);
    }

    const db = getDb();
    const msgs = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE provider_message_id = 'SM_IDEMPOTENTE'`)
      .get() as { n: number };
    const jobs = db
      .prepare(
        `SELECT COUNT(*) AS n FROM inbound_jobs j
           JOIN messages m ON m.id = j.message_id
          WHERE m.provider_message_id = 'SM_IDEMPOTENTE'`,
      )
      .get() as { n: number };

    expect(msgs.n).toBe(1);
    expect(jobs.n).toBe(1);
  });

  it('encola el mensaje para el worker en vez de procesarlo en el webhook', async () => {
    const params = inbound('SM_ENCOLADO');
    await request(app)
      .post('/webhooks/twilio/whatsapp')
      .type('form')
      .set('X-Twilio-Signature', sign(params))
      .send(params);

    const job = getDb()
      .prepare(
        `SELECT j.status FROM inbound_jobs j
           JOIN messages m ON m.id = j.message_id
          WHERE m.provider_message_id = 'SM_ENCOLADO'`,
      )
      .get() as { status: string } | undefined;
    expect(job?.status).toBe('PENDING');
  });
});

describe('resolución de tenant por número receptor', () => {
  it('normaliza formatos equivalentes', () => {
    expect(normalizeWhatsAppAddress('whatsapp:+52 155-5000 0001')).toBe('+5215550000001');
    expect(normalizeWhatsAppAddress('WhatsApp:+15550000001')).toBe('+15550000001');
  });

  it('resuelve el tenant que declara ese sender', () => {
    expect(resolveTenantByInboundTo('whatsapp:+15550000001')?.tenantId).toBe('acme');
  });

  it('no entrega el mensaje a ningún tenant si el número no coincide', () => {
    expect(resolveTenantByInboundTo('whatsapp:+19999999999')).toBeNull();
  });

  it('un segundo tenant con otro sender no roba los mensajes del primero', () => {
    writeTenant('segunda', {
      company: `company:
  id: segunda
  name: "Segunda"
assistant:
  display_name: "Asistente Segunda"
  locale: es-MX
channels:
  whatsapp:
    enabled: true
    from: "whatsapp:+15550000002"
`,
    });
    clearTenantCache();

    expect(resolveTenantByInboundTo('whatsapp:+15550000001')?.tenantId).toBe('acme');
    expect(resolveTenantByInboundTo('whatsapp:+15550000002')?.tenantId).toBe('segunda');
  });
});

describe('callbacks de estado', () => {
  it('persiste el estado de un mensaje saliente', async () => {
    const params = { MessageSid: 'SM_SALIENTE', MessageStatus: 'delivered' };
    const res = await request(app)
      .post('/webhooks/twilio/status')
      .type('form')
      .set('X-Twilio-Signature', sign(params, 'https://demo.example.com/webhooks/twilio/status'))
      .send(params);

    expect(res.status).toBe(204);
    const row = getDb()
      .prepare(`SELECT status FROM delivery_statuses WHERE provider_message_id = 'SM_SALIENTE'`)
      .get() as { status: string } | undefined;
    expect(row?.status).toBe('delivered');
  });
});

describe('utilidades del canal', () => {
  it('parte mensajes largos en frontera de palabra', () => {
    const long = `${'palabra '.repeat(400)}fin`;
    const parts = splitForWhatsApp(long, 1500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1500);
    expect(parts.join(' ')).toContain('fin');
  });

  it('un mensaje corto no se parte', () => {
    expect(splitForWhatsApp('Hola')).toEqual(['Hola']);
  });
});

describe('higiene de logs', () => {
  it('nunca deja pasar una API key ni un Account SID', () => {
    const dirty = 'key sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA sid ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const clean = scrubSecrets(dirty);
    expect(clean).not.toContain('sk-proj-');
    expect(clean).not.toContain('ACaaaaaaaa');
    expect(clean).toContain('[REDACTED]');
  });

  it('enmascara teléfonos conservando lada y últimos dígitos', () => {
    const masked = maskPhone('whatsapp:+5215551234567');
    expect(masked.startsWith('whatsapp:+521')).toBe(true);
    expect(masked.endsWith('4567')).toBe(true);
    expect(masked).toContain('*');
    expect(masked).not.toContain('555123');
  });
});

describe('salud del servicio', () => {
  it('/health reporta modo, tenants y validación de firma', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.tenants).toContain('acme');
    expect(res.body.signatureValidation).toBe(true);
  });
});
