import { env } from '../src/config/env';
import { getDb } from '../src/db';
import { c, createPrompt, die, flag, heading, option, out, requireTenantArg } from '../src/lib/cli';
import { acceptInbound, runTurnAndPersist } from '../src/conversation/conversation.service';
import { closeConversation } from '../src/repositories/conversation.repository';
import { getVectorStoreId } from '../src/knowledge/vector-store.service';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';
import type { EngineResult } from '../src/conversation/conversation-engine';

/**
 * Chat local. Usa EXACTAMENTE el mismo ConversationEngine que WhatsApp: la
 * única diferencia es el canal y que aquí no hay envío por Twilio.
 */
async function main(): Promise<void> {
  const tenantId = requireTenantArg('chat');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);
  if (!env.OPENAI_API_KEY) die('Falta OPENAI_API_KEY: el chat habla con OpenAI de verdad.');

  getDb();
  const { config } = loadTenantConfig(tenantId);
  if (!config) die('Configuración inválida. Corre onboard:validate.');

  const channel = 'cli';
  const externalUserId = option('user', 'cli-local') as string;
  const phone = option('phone');
  let debug = flag('debug');

  const vectorStoreId = getVectorStoreId(tenantId);

  heading(`${config.company.company.name} — demo local`);
  out(c.gray(`  asistente:    ${config.company.assistant.display_name}`));
  out(c.gray(`  modo:         ${env.APP_MODE}`));
  out(c.gray(`  modelo:       ${env.OPENAI_MODEL}`));
  out(
    c.gray(
      `  knowledge:    ${vectorStoreId ? vectorStoreId : 'sin vector store (corre onboard:sync)'}`,
    ),
  );
  out();
  out(c.gray('  /reset  reinicia la conversación'));
  out(c.gray('  /debug  muestra el detalle interno de cada turno'));
  out(c.gray('  /prompt imprime el system prompt del último turno'));
  out(c.gray('  /salir  termina'));
  out();

  const { ask, close } = createPrompt();
  let lastResult: EngineResult | null = null;

  for (;;) {
    const input = await ask(c.bold('Tú'));
    if (!input) continue;

    if (input === '/salir' || input === '/exit' || input === '/quit') break;

    if (input === '/debug') {
      debug = !debug;
      out(c.gray(`  debug ${debug ? 'activado' : 'desactivado'}`));
      continue;
    }

    if (input === '/prompt') {
      out();
      out(c.gray(lastResult?.debug.systemPrompt ?? '(todavía no hay ningún turno)'));
      out();
      continue;
    }

    if (input === '/reset') {
      const accepted = acceptInbound({
        tenantId,
        channel,
        externalUserId,
        phone,
        profileName: null,
        body: '(reset)',
      });
      if (accepted) closeConversation(accepted.conversation.id);
      out(c.gray('  conversación reiniciada'));
      out();
      continue;
    }

    const accepted = acceptInbound({
      tenantId,
      channel,
      externalUserId,
      phone,
      profileName: null,
      body: input,
    });

    if (!accepted) {
      out(c.gray('  (mensaje duplicado, ignorado)'));
      continue;
    }

    const started = Date.now();
    let result: EngineResult;
    try {
      result = await runTurnAndPersist(accepted, [input]);
    } catch (e) {
      out(c.red(`  error: ${(e as Error).message}`));
      continue;
    }
    lastResult = result;

    out();
    out(`${c.cyan(config.company.assistant.display_name)}: ${result.reply}`);
    out();

    if (debug) {
      const d = result.debug;
      out(c.gray('  ─ debug ─────────────────────────────────'));
      out(
        c.gray(
          `  intents:    ${d.intents.map((i) => `${i.intent}@${i.confidence.toFixed(2)}`).join(', ') || '—'}`,
        ),
      );
      out(
        c.gray(
          `  campos:     ${d.fieldUpdates.map((f) => `${f.workflow}.${f.key}=${f.value}`).join(' | ') || '—'}`,
        ),
      );
      out(c.gray(`  knowledge:  ${d.knowledgeSources.join(', ') || 'ninguna fuente citada'}`));
      out(
        c.gray(
          `  faltantes:  ${Object.entries(d.missingEssential).map(([k, v]) => `${k}:[${v.join(',')}]`).join(' ') || '—'}`,
        ),
      );
      out(
        c.gray(
          `  canalizado: ${d.routed.map((r) => `#${r.caseId} ${r.workflow} → ${r.detail}`).join(' | ') || 'no'}`,
        ),
      );
      out(c.gray(`  guard:      ${d.guardViolations.join(', ') || 'ok'}`));
      out(
        c.gray(
          `  tokens:     in ${d.usage.inputTokens} / out ${d.usage.outputTokens} · ${d.passes} pasada(s) · ${Date.now() - started} ms`,
        ),
      );
      out(c.gray('  ─────────────────────────────────────────'));
      out();
    }
  }

  close();
  out(c.gray('Hasta luego.'));
}

main().catch((e) => die('El chat terminó con error', e));
