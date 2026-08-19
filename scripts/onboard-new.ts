import { c, createPrompt, die, flag, heading, ok, out, positionals, warn } from '../src/lib/cli';
import { defaultAnswers, scaffoldTenant } from '../src/onboarding/onboarding.service';
import { ALL_WORKFLOW_KEYS, DEFAULT_DEPARTMENTS } from '../src/onboarding/templates';
import { tenantExists } from '../src/tenants/tenant-loader';
import type { WizardAnswers } from '../src/onboarding/templates';

async function wizard(base: WizardAnswers): Promise<WizardAnswers> {
  const { ask, close } = createPrompt();
  out(c.gray('Enter acepta el valor entre corchetes.\n'));

  const a = { ...base };
  a.companyName = await ask('Nombre de la empresa', a.tenantId);
  a.assistantName = await ask('Nombre visible del asistente', `Asistente de ${a.companyName}`);
  a.locale = await ask('Idioma / localización', 'es-MX');
  a.website = await ask('Sitio web (vacío si no tiene)', '');

  const pronoun = await ask('Trato al cliente (usted / tu)', 'usted');
  a.pronounStyle = pronoun.toLowerCase().startsWith('t') ? 'tu' : 'usted';

  out();
  out(c.gray(`Áreas disponibles: ${Object.keys(DEFAULT_DEPARTMENTS).join(', ')}`));
  const depts = await ask('Áreas (separadas por coma)', Object.keys(DEFAULT_DEPARTMENTS).join(','));
  a.departments = depts
    .split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);

  out();
  out(c.gray(`Tipos de solicitud disponibles: ${ALL_WORKFLOW_KEYS.join(', ')}`));
  const wfs = await ask('Tipos de solicitud a habilitar (coma)', ALL_WORKFLOW_KEYS.join(','));
  a.workflows = wfs
    .split(',')
    .map((w) => w.trim().toUpperCase())
    .filter((w) => ALL_WORKFLOW_KEYS.includes(w));

  out();
  const routing = await ask('Canalización interna (LOG / EMAIL)', 'LOG');
  a.routingType = routing.toUpperCase() === 'EMAIL' ? 'EMAIL' : 'LOG';
  if (a.routingType === 'EMAIL') {
    a.routingTo = await ask('Correo interno que recibirá los casos', '');
  }

  close();
  return a;
}

async function main(): Promise<void> {
  const [tenantId] = positionals();
  if (!tenantId) die('Uso: npm run onboard:new -- <tenant-id> [--yes] [--force]');

  if (!/^[a-z0-9][a-z0-9-]*$/.test(tenantId)) {
    die(`"${tenantId}" no es un id válido. Usa kebab-case en minúsculas (ej: grupo-yoma).`);
  }

  const force = flag('force');
  if (tenantExists(tenantId) && !force) {
    warn(`El tenant "${tenantId}" ya existe. Los archivos existentes NO se sobrescriben.`);
    out(c.gray('Usa --force para regenerar las plantillas (destruye ediciones manuales).'));
  }

  heading(`Alta de tenant: ${tenantId}`);

  let answers = defaultAnswers(tenantId);
  if (!flag('yes')) {
    answers = await wizard(answers);
  } else {
    out(c.gray('Modo no interactivo (--yes): se usan valores por defecto.'));
  }

  const result = scaffoldTenant(answers, force);

  heading('Resultado');
  out(`Carpeta: ${c.cyan(result.dir)}`);
  for (const f of result.created) ok(`creado   ${f}`);
  for (const f of result.skipped) warn(`omitido  ${f} (ya existía)`);

  heading('Siguientes pasos');
  out(`  1. Revisa y completa los ${c.yellow('TODO_REQUIRES_CLIENT_ONBOARDING')} en los YAML.`);
  out(`  2. Coloca documentos autorizados en ${c.cyan('knowledge/customer-safe/')}.`);
  if (answers.website) {
    out(`  3. ${c.cyan(`npm run knowledge:web-sync -- ${tenantId} ${answers.website}`)}`);
  } else {
    out(`  3. ${c.cyan(`npm run knowledge:web-sync -- ${tenantId} <url>`)} (si tiene sitio web)`);
  }
  out(`  4. ${c.cyan(`npm run onboard:validate -- ${tenantId}`)}`);
  out(`  5. ${c.cyan(`npm run onboard:sync -- ${tenantId}`)}`);
  out(`  6. ${c.cyan(`npm run chat -- ${tenantId}`)}`);
  out();
}

main().catch((e) => die('Falló el alta del tenant', e));
