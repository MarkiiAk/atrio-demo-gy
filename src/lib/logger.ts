import { env } from '../config/env';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];

/**
 * Patrones de secreto que NUNCA deben salir en un log, aunque alguien los pase por
 * accidente dentro de un objeto de contexto. Se aplica siempre, en dev y en prod.
 */
const SECRET_KEY_PATTERN =
  /(api[_-]?key|auth[_-]?token|authorization|password|passwd|secret|bearer|sid|signature)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_\-]{20,}/g, // OpenAI
  /\bAC[0-9a-fA-F]{32}\b/g, // Twilio Account SID
  /\bSK[0-9a-fA-F]{32}\b/g, // Twilio API Key SID
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Enmascara un teléfono dejando lada + últimos 4: `whatsapp:+52******1234`. */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '';
  const m = value.match(/^(whatsapp:)?(\+?\d{1,3})(\d+)(\d{4})$/);
  if (!m) return value.length > 6 ? `${value.slice(0, 3)}***${value.slice(-2)}` : '***';
  return `${m[1] ?? ''}${m[2]}${'*'.repeat(Math.max(2, m[3].length))}${m[4]}`;
}

/** Aplica enmascarado de PII sólo cuando REDACT_PII está activo. */
export function pii(value: string | null | undefined): string {
  if (!value) return '';
  return env.REDACT_PII ? maskPhone(value) : value;
}

/** Recorta texto libre para que un body enorme no inunde el log. */
export function snip(value: string | null | undefined, max = 300): string {
  if (!value) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: scrubSecrets(value.message) };
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

function emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${scrubSecrets(msg)}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (ctx && Object.keys(ctx).length > 0) {
    stream.write(`${line} ${JSON.stringify(sanitize(ctx))}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),

  /**
   * Bloque de traza legible para desarrollo (el formato `[INBOUND] … [AI] … [OUTBOUND]`).
   * En producción se degrada a una línea estructurada para no volcar PII a stdout.
   */
  block(title: string, lines: Array<[string, string]>): void {
    if (LEVELS.debug < threshold) return;
    if (env.NODE_ENV === 'production') {
      emit('info', `[${title}]`, Object.fromEntries(lines));
      return;
    }
    const body = lines
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `  ${k}: ${scrubSecrets(String(v))}`)
      .join('\n');
    process.stdout.write(`\n[${title}]\n${body}\n`);
  },
};
