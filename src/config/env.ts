import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { z } from 'zod';

// En tests el entorno lo fija `tests/setup.ts`; cargar el .env real ahí sólo
// arrastraría credenciales de producción a una suite que no las necesita.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

/**
 * Raíz del repo.
 *
 * Se busca el `package.json` hacia arriba en vez de contar niveles con `..`,
 * porque la profundidad cambia entre ejecutar el fuente (`src/config/`) y el
 * compilado (`dist/src/config/`). Contar niveles haría que en producción
 * `onboarding/`, `public/` y `data/` se resolvieran dentro de `dist/`.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..', '..');
}

export const PROJECT_ROOT = findProjectRoot(__dirname);

const boolish = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return dflt;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const intish = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return dflt;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : dflt;
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_MODE: z.enum(['demo', 'production']).default('demo'),

  PORT: intish(3000),
  PUBLIC_BASE_URL: z.string().optional().default(''),

  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().optional().default('gpt-5.6'),
  OPENAI_TIMEOUT_MS: intish(45_000),

  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_WHATSAPP_FROM: z.string().optional().default(''),
  TWILIO_VALIDATE_SIGNATURE: boolish(true),

  DATABASE_URL: z.string().optional().default('file:./data/app.db'),

  INBOUND_DEBOUNCE_MS: intish(1500),
  WORKER_POLL_MS: intish(400),
  JOB_MAX_ATTEMPTS: intish(3),
  DATA_RETENTION_DAYS: intish(90),

  RUN_LIVE_EVALS: boolish(false),

  SMTP_ENABLED: boolish(false),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: intish(587),
  SMTP_SECURE: boolish(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  LOG_REDACT_PII: z.string().optional().default(''),

  // Rutas base. Normalmente se derivan del repo; se pueden apuntar a otro lado
  // para tests o para montar el onboarding en un volumen.
  ONBOARDING_DIR: z.string().optional().default(''),
  CACHE_DIR: z.string().optional().default(''),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Nunca imprimimos valores, sólo qué variable está mal formada.
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Configuración de entorno inválida:\n${issues}`);
}

const raw = parsed.data;

/** Ruta absoluta del archivo SQLite derivada de DATABASE_URL (`file:./data/app.db`). */
function resolveDbFile(url: string): string {
  const stripped = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return path.isAbsolute(stripped) ? stripped : path.resolve(PROJECT_ROOT, stripped);
}

export type AppMode = 'demo' | 'production';

/**
 * URL pública del servicio, sin slash final.
 *
 * La firma de Twilio se calcula sobre la URL EXACTA a la que llegó el POST, así
 * que un dedazo aquí rechaza todos los webhooks con un 403 difícil de diagnosticar.
 * Cuando el host ya publica su propio dominio, se toma de ahí en vez de pedirle
 * a alguien que lo copie a mano.
 */
function resolvePublicBaseUrl(explicit: string): string {
  const candidate =
    explicit.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    (process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}`
      : '') ||
    (process.env.FLY_APP_NAME?.trim() ? `https://${process.env.FLY_APP_NAME.trim()}.fly.dev` : '') ||
    '';

  if (!candidate) return '';
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  return withScheme.replace(/\/+$/, '');
}

export const env = {
  ...raw,
  PUBLIC_BASE_URL: resolvePublicBaseUrl(raw.PUBLIC_BASE_URL),
  DB_FILE: resolveDbFile(raw.DATABASE_URL),
  /** Enmascarar PII en logs: explícito si se configuró, si no, sólo en producción. */
  REDACT_PII:
    raw.LOG_REDACT_PII.trim() === ''
      ? raw.NODE_ENV === 'production'
      : ['1', 'true', 'yes', 'on'].includes(raw.LOG_REDACT_PII.trim().toLowerCase()),
  ONBOARDING_DIR: raw.ONBOARDING_DIR
    ? path.resolve(raw.ONBOARDING_DIR)
    : path.resolve(PROJECT_ROOT, 'onboarding'),
  CACHE_DIR: raw.CACHE_DIR ? path.resolve(raw.CACHE_DIR) : path.resolve(PROJECT_ROOT, '.cache'),
} as const;

export function requireOpenAI(): string {
  if (!env.OPENAI_API_KEY) {
    throw new Error('Falta OPENAI_API_KEY en el entorno (.env). Este comando requiere OpenAI real.');
  }
  return env.OPENAI_API_KEY;
}

export function twilioConfigured(): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
}

export function requireTwilio(): { sid: string; token: string; from: string } {
  if (!twilioConfigured()) {
    throw new Error(
      'Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM en el entorno (.env).',
    );
  }
  return {
    sid: env.TWILIO_ACCOUNT_SID,
    token: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_WHATSAPP_FROM,
  };
}
