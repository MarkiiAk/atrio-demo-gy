import { env } from '../src/config/env';
import { getDb } from '../src/db';
import { c, die, heading, out, positionals } from '../src/lib/cli';
import { acceptInbound, runTurnAndPersist } from '../src/conversation/conversation.service';
import { closeConversation } from '../src/repositories/conversation.repository';
import { tenantExists } from '../src/tenants/tenant-loader';

/**
 * Recorre los escenarios que tienen que salir bien en una demo, sin interacción.
 *
 * Existe porque cada uno de estos casos falló en producción y sólo se descubrió
 * enseñándoselo a un cliente. Es la misma ruta que WhatsApp: mismo motor, mismo
 * catálogo, mismo RAG. Consume tokens de OpenAI de verdad.
 *
 *   npm run demo:smoke -- grupo-yoma
 */

interface Scenario {
  name: string;
  /** Turnos del cliente, en orden. */
  turns: string[];
  /** Lo que la respuesta DEBE contener (alguno de estos, no todos). */
  expectAny?: string[];
  /** Lo que NUNCA debe aparecer. */
  expectNone?: string[];
}

/**
 * Frases que delatan los tres fallos que arruinan una demo: negar lo que se
 * vende, dudar en voz alta, y contar cómo funciona el sistema por dentro.
 */
const NEGACION = ['no manejamos', 'no contamos', 'no lo tenemos', 'no disponemos', 'no vendemos'];
const DUDA = [
  'no me aparece',
  'no aparece confirmad',
  'sin verificarlo',
  'no puedo confirmar',
  'prefiero no confirmar',
  'tengo confirmado',
  'lo que revisé',
  'en lo que reviso',
  'no quiero asumir',
  // Delata la sustitución semántica: en lugar de responder por el producto
  // pedido, ofrece un surtido de lo que sí hay.
  'parecidos',
  'similares',
];

const SCENARIOS: Scenario[] = [
  {
    name: 'Familia ambigua: no negar, no elegir, preguntar',
    turns: ['Buenas tardes, quiero cotizar 5 tambores de thinner'],
    expectAny: ['americano'],
    expectNone: [...NEGACION, ...DUDA],
  },
  {
    name: 'Producto del PDF sin ficha: confirmar y preguntar presentación',
    turns: ['Hola, necesito acetona'],
    expectAny: ['acetona'],
    // El fallo medido: ofreció "acetato y otras opciones similares" ante una
    // petición de acetona. Son químicos distintos.
    expectNone: [...NEGACION, ...DUDA, 'acetato'],
  },
  {
    name: 'Errata real del cliente: thiner americano',
    turns: ['me gustaría cotizar 27 tambos de thiner americano, para Colima 28000'],
    expectAny: ['thinner americano'],
    expectNone: [...NEGACION, ...DUDA],
  },
  {
    name: 'MEK existe y NO es MIBK',
    turns: ['¿manejan MEK?'],
    expectAny: ['metil etil cetona', 'mek'],
    expectNone: [...NEGACION, ...DUDA, 'isobutil'],
  },
  {
    name: 'Fuera de catálogo: negar con tacto y remitir al catálogo',
    turns: ['necesito 1000 litros de óxido nitroso'],
    expectAny: ['grupoyoma.com.mx'],
  },
  {
    name: 'Producto con ficha: cotización completa que sí se canaliza',
    turns: [
      'buenas, necesito cotizar tolueno',
      '20 tambos de 200 litros, entrega en Guadalajara. Soy Marco Candiani',
    ],
  },
];

function reveal(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  const [tenantId] = positionals();
  if (!tenantId) die('Uso: npm run demo:smoke -- <tenant-id>');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);
  if (!env.OPENAI_API_KEY) die('Falta OPENAI_API_KEY: esto habla con OpenAI de verdad.');

  getDb();
  heading(`Escenarios de demo — ${tenantId}`);
  out(c.gray(`  modelo: ${env.OPENAI_MODEL} · modo: ${env.APP_MODE}`));
  out();

  let failures = 0;

  for (const [i, s] of SCENARIOS.entries()) {
    out(c.bold(`${i + 1}. ${s.name}`));

    // Conversación nueva por escenario: el estado de una no debe contaminar otra.
    const externalUserId = `smoke-${i}-${process.pid}`;
    let lastReply = '';

    for (const turn of s.turns) {
      const accepted = acceptInbound({
        tenantId,
        channel: 'cli',
        externalUserId,
        phone: '+525500000000',
        profileName: 'Demo',
        body: turn,
      });
      if (!accepted) {
        out(c.yellow('   mensaje descartado por idempotencia'));
        continue;
      }

      out(c.gray(`   → ${turn}`));
      const result = await runTurnAndPersist(accepted, [turn]);
      lastReply = result.reply;
      out(`   ← ${reveal(result.reply)}`);

      const d = result.debug;
      const detalles = [
        d.routed.length > 0 ? `ruteo: ${d.routed.map((r) => r.detail).join(' | ')}` : '',
        d.unverified.length > 0 ? `sin confirmar: ${d.unverified.join(', ')}` : '',
        d.guardViolations.length > 0 ? `guard: ${d.guardViolations.join(', ')}` : '',
        `fuentes RAG: ${d.knowledgeSources.length}`,
        `pasadas: ${d.passes}`,
      ].filter(Boolean);
      out(c.gray(`     ${detalles.join(' · ')}`));
    }

    const lower = lastReply.toLowerCase();
    const problemas: string[] = [];

    for (const bad of s.expectNone ?? []) {
      if (lower.includes(bad.toLowerCase())) problemas.push(`dijo "${bad}"`);
    }
    if (s.expectAny && !s.expectAny.some((g) => lower.includes(g.toLowerCase()))) {
      problemas.push(`no mencionó ninguno de: ${s.expectAny.join(', ')}`);
    }

    if (problemas.length === 0) {
      out(c.green('   ✓ OK'));
    } else {
      failures += 1;
      out(c.red(`   ✗ ${problemas.join(' · ')}`));
    }

    // Se cierra para que el siguiente escenario arranque limpio.
    const closing = acceptInbound({ tenantId, channel: 'cli', externalUserId, body: null, kind: 'UNKNOWN' });
    if (closing) closeConversation(closing.conversation.id);
    out();
  }

  if (failures > 0) {
    out(c.red(`${failures} de ${SCENARIOS.length} escenario(s) con problemas.`));
    process.exitCode = 1;
  } else {
    out(c.green(`Los ${SCENARIOS.length} escenarios se comportaron como deben.`));
  }
  out();
}

main().catch((e) => die('Falló el recorrido de demo', e));
