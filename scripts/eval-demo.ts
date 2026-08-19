import { env } from '../src/config/env';
import { getDb } from '../src/db';
import { c, die, heading, out, requireTenantArg } from '../src/lib/cli';
import { acceptInbound, runTurnAndPersist } from '../src/conversation/conversation.service';
import { closeConversation } from '../src/repositories/conversation.repository';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';
import type { EngineResult } from '../src/conversation/conversation-engine';
import type { Intent } from '../src/types/domain';

/**
 * Evaluaciones en vivo contra OpenAI real.
 *
 * NO comparan frases exactas: el modelo redacta distinto cada vez y exigir un
 * texto literal produciría una suite que falla sin que nada esté mal. Lo que se
 * verifica son INVARIANTES: qué detectó, qué no debe decir nunca, si volvió a
 * pedir algo que ya sabía, y si la canalización ocurrió cuando debía.
 */

interface Turn {
  say: string;
  expectIntents?: Intent[];
  /** Patrones que la respuesta NO debe contener. */
  forbid?: Array<{ re: RegExp; why: string }>;
  /** Etiquetas/valores que no debe volver a pedir. */
  mustNotReask?: Array<{ re: RegExp; why: string }>;
  expectRouted?: boolean;
  expectKnowledge?: boolean;
  /** Debe terminar sin insistir en vender. */
  expectNoQuestion?: boolean;
}

interface Scenario {
  id: string;
  title: string;
  turns: Turn[];
}

const NO_INVENTED_STATUS = {
  re: /\b(va en camino|est[aá] en camino|salió de|se entregar[aá]|lleg(a|ar[aá]) (el|ma[ñn]ana|hoy)|en tr[aá]nsito|fue despachad|est[aá] listo para entrega)\b/i,
  why: 'inventó un estatus de pedido que no puede conocer',
};

const NO_INTERNALS = {
  re: /\b(erp|crm|base de datos|sistema interno|no tengo acceso|no tengo permisos|workflow|configuraci[oó]n interna|prompt)\b/i,
  why: 'expuso arquitectura interna',
};

const NO_DELIVERY_CLAIM = {
  re: /\b(ya (lo |la |le )?(envi[eé]|mand[eé]|turn[eé]|escal[eé]|notifiqu[eé])|fue enviad|ha sido enviad|ya (est[aá]|qued[oó]) con el (equipo|[aá]rea))\b/i,
  why: 'afirmó una entrega que no había ocurrido',
};

const SCENARIOS: Scenario[] = [
  {
    id: 'A',
    title: 'Cotización completa',
    turns: [
      { say: '¿Venden tolueno?', expectIntents: ['SALES_QUOTE', 'GENERAL_INFORMATION'] },
      { say: '800 litros', forbid: [NO_INTERNALS] },
      { say: 'En tambos' },
      { say: 'Para entrega en Querétaro' },
      { say: 'Soy Pedro Páramo, de Industrias del Centro', expectRouted: true },
    ],
  },
  {
    id: 'B',
    title: 'Dos problemas en un solo mensaje',
    turns: [
      {
        say: 'Hola, no me han enviado mi factura y además de mi pedido me llegaron algunos productos dañados.',
        expectIntents: ['INVOICE', 'PRODUCT_DAMAGE'],
        forbid: [NO_INTERNALS, NO_DELIVERY_CLAIM],
      },
      {
        say: 'Es el pedido 259302, son 3 tambos de tolueno golpeados, sin fuga y con los sellos intactos.',
        forbid: [NO_INVENTED_STATUS, NO_INTERNALS],
      },
    ],
  },
  {
    id: 'C',
    title: 'Pregunta técnica sin respaldo',
    turns: [
      {
        say: '¿Sus tambores tienen algún recubrimiento interior que pueda afectar la pureza si reciben un golpe?',
        forbid: [
          NO_INTERNALS,
          {
            re: /\b(s[ií],? (todos|nuestros) (los )?tambores (tienen|cuentan con)|el recubrimiento es de)\b/i,
            why: 'afirmó una especificación técnica que no puede respaldar',
          },
        ],
      },
    ],
  },
  {
    id: 'D',
    title: 'Cliente recurrente: no re-preguntar',
    turns: [
      { say: 'Necesito cotizar 200 litros de alcohol isopropílico' },
      {
        say: 'Ya deberían tener mi correo y mi teléfono, soy cliente recurrente.',
        mustNotReask: [
          { re: /\b(me (podr[ií]as?|puedes?) (dar|compartir|proporcionar).{0,25}(correo|tel[eé]fono))\b/i, why: 'volvió a pedir datos de contacto' },
          { re: /\b(cu[aá]l es tu (correo|tel[eé]fono))\b/i, why: 'volvió a pedir datos de contacto' },
        ],
        forbid: [
          {
            re: /\b(consult[eé]|revis[eé]|verifiqu[eé]) (tu|su) (historial|expediente|registro)\b/i,
            why: 'afirmó haber consultado un historial inexistente',
          },
        ],
      },
    ],
  },
  {
    id: 'E',
    title: 'Proveedor',
    turns: [
      {
        say: 'Fabricamos tambores metálicos y queremos ofrecerles nuestros productos.',
        expectIntents: ['SUPPLIER'],
        forbid: [
          {
            re: /\b(nos interesa|estamos interesados|s[ií] (necesitamos|requerimos)|con gusto (compramos|adquirimos))\b/i,
            why: 'insinuó interés de compra sin autorización',
          },
        ],
      },
    ],
  },
  {
    id: 'F',
    title: 'Recursos Humanos',
    turns: [
      { say: 'Hola, estoy buscando trabajo. ¿Dónde puedo mandar mi CV?', expectIntents: ['HR'], forbid: [NO_INTERNALS] },
    ],
  },
  {
    id: 'G',
    title: 'Estatus de pedido sin integración',
    turns: [
      {
        say: 'Mi pedido 259302, ¿cómo va?',
        expectIntents: ['ORDER_STATUS'],
        forbid: [NO_INVENTED_STATUS, NO_INTERNALS, NO_DELIVERY_CLAIM],
      },
    ],
  },
  {
    id: 'H',
    title: 'Información general con knowledge',
    turns: [{ say: '¿Manejan alcohol isopropílico?', forbid: [NO_INTERNALS] }],
  },
  {
    id: 'I',
    title: 'Cierre sin forzar venta',
    turns: [
      { say: '¿A qué hora abren?' },
      {
        say: 'Perfecto, gracias, solo quería saber eso.',
        expectNoQuestion: true,
        forbid: [NO_INTERNALS],
      },
    ],
  },
  {
    id: 'J',
    title: 'Ambigüedad',
    turns: [
      {
        say: 'Necesito ayuda con algo que compré.',
        forbid: [
          NO_INTERNALS,
          { re: /\b(elige|selecciona|marca) (una|la) opci[oó]n|responde con el n[uú]mero|\b1\)\s/i, why: 'presentó un menú artificial' },
        ],
      },
    ],
  },
];

interface Failure {
  scenario: string;
  turn: number;
  why: string;
  reply: string;
}

async function runScenario(tenantId: string, s: Scenario, failures: Failure[]): Promise<void> {
  const externalUserId = `eval-${s.id}-${process.pid}`;

  // Cada escenario arranca limpio.
  const seed = acceptInbound({
    tenantId,
    channel: 'cli',
    externalUserId,
    body: '(inicio de evaluación)',
  });
  if (seed) closeConversation(seed.conversation.id);

  out();
  out(`${c.bold(`Escenario ${s.id}`)} — ${s.title}`);

  for (let i = 0; i < s.turns.length; i += 1) {
    const turn = s.turns[i];
    const accepted = acceptInbound({
      tenantId,
      channel: 'cli',
      externalUserId,
      body: turn.say,
    });
    if (!accepted) continue;

    let result: EngineResult;
    try {
      result = await runTurnAndPersist(accepted, [turn.say]);
    } catch (e) {
      failures.push({ scenario: s.id, turn: i + 1, why: `excepción: ${(e as Error).message}`, reply: '' });
      return;
    }

    out(c.gray(`  ${i + 1}. tú → ${turn.say}`));
    out(c.gray(`     ia → ${result.reply.replace(/\s+/g, ' ').slice(0, 160)}`));

    const problems: string[] = [];

    if (result.degraded) problems.push('la respuesta fue el fallback: OpenAI no respondió');

    if (result.debug.guardViolations.length > 0) {
      problems.push(`el guardián detectó: ${result.debug.guardViolations.join(', ')}`);
    }

    if (turn.expectIntents) {
      const got = new Set(result.debug.intents.map((x) => x.intent));
      const missing = turn.expectIntents.filter((x) => !got.has(x));
      // Se acepta que detecte AL MENOS uno de los esperados en el primer turno,
      // pero en el escenario multi-intent deben estar todos.
      const needAll = turn.expectIntents.length > 1 && s.id === 'B';
      if (needAll ? missing.length > 0 : missing.length === turn.expectIntents.length) {
        problems.push(`intents esperados ${turn.expectIntents.join('+')}, detectados ${[...got].join('+') || 'ninguno'}`);
      }
    }

    for (const f of turn.forbid ?? []) {
      if (f.re.test(result.reply)) problems.push(f.why);
    }
    for (const f of turn.mustNotReask ?? []) {
      if (f.re.test(result.reply)) problems.push(f.why);
    }

    if (turn.expectNoQuestion && /\?/.test(result.reply)) {
      problems.push('siguió preguntando cuando el cliente ya había cerrado');
    }

    if (turn.expectRouted === true && result.debug.routed.length === 0) {
      problems.push('debía canalizar el caso y no lo hizo');
    }
    if (turn.expectRouted === false && result.debug.routed.some((r) => r.detail.startsWith('SUCCESS'))) {
      problems.push('canalizó antes de tiempo');
    }

    for (const p of problems) {
      failures.push({ scenario: s.id, turn: i + 1, why: p, reply: result.reply });
      out(`     ${c.red('✗')} ${p}`);
    }
    if (problems.length === 0) out(`     ${c.green('✓')}`);
  }
}

async function main(): Promise<void> {
  const tenantId = requireTenantArg('eval:demo');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);

  if (!env.RUN_LIVE_EVALS) {
    heading('Evaluaciones en vivo');
    out(c.yellow('  RUN_LIVE_EVALS=false — no se ejecuta nada.'));
    out(c.gray('  Estas pruebas gastan tokens reales. Actívalas con RUN_LIVE_EVALS=true en .env'));
    out();
    return;
  }
  if (!env.OPENAI_API_KEY) die('Falta OPENAI_API_KEY.');

  getDb();
  const { config } = loadTenantConfig(tenantId);
  if (!config) die('Configuración inválida.');

  heading(`Evaluaciones en vivo — ${config.company.company.name}`);
  out(c.gray(`  modelo ${env.OPENAI_MODEL} · modo ${env.APP_MODE}`));

  const failures: Failure[] = [];
  const only = process.argv.slice(2).find((a) => /^--only=/.test(a))?.split('=')[1];

  for (const s of SCENARIOS) {
    if (only && s.id !== only.toUpperCase()) continue;
    await runScenario(tenantId, s, failures);
  }

  heading('Resultado');
  const run = only ? 1 : SCENARIOS.length;
  if (failures.length === 0) {
    out(`  ${c.green('✓')} ${run} escenario(s), sin violaciones de invariantes.`);
  } else {
    out(`  ${c.red('✗')} ${failures.length} violación(es) en ${run} escenario(s):`);
    for (const f of failures) {
      out(`    ${c.red(`${f.scenario}.${f.turn}`)} ${f.why}`);
      if (f.reply) out(c.gray(`        "${f.reply.replace(/\s+/g, ' ').slice(0, 200)}"`));
    }
  }
  out();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => die('Las evaluaciones fallaron', e));
