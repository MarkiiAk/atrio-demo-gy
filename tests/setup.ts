import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Aislamiento por archivo de test.
 *
 * Vitest ejecuta `setupFiles` ANTES de importar el módulo de test, que es la
 * única ventana válida para tocar `process.env`: los `import` de ESM se evalúan
 * antes que el cuerpo del módulo, así que hacerlo dentro del propio test llegaría
 * tarde — `src/config/env` ya se habría congelado con los valores reales.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), `atrio-test-${crypto.randomBytes(4).toString('hex')}-`));
const onboardingDir = path.join(root, 'onboarding');
fs.mkdirSync(onboardingDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'demo';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL = `file:${path.join(root, 'test.db').replace(/\\/g, '/')}`;
process.env.ONBOARDING_DIR = onboardingDir;
process.env.CACHE_DIR = path.join(root, '.cache');
process.env.PUBLIC_BASE_URL = 'https://demo.example.com';
process.env.OPENAI_API_KEY = 'sk-test-jamas-se-usa-en-tests-unitarios';
process.env.OPENAI_MODEL = 'modelo-de-prueba';
process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'testtoken00000000000000000000000';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+15550000001';
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.INBOUND_DEBOUNCE_MS = '0';
process.env.SMTP_ENABLED = 'false';
process.env.ATRIO_TEST_ROOT = root;
