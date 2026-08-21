import { env } from '../config/env';
import { log, pii, snip } from '../lib/logger';
import { runAssistantTurn, OpenAiUnavailableError, type TurnResult } from '../ai/openai.service';
import type { AiTurnOutput } from '../ai/ai-schema';
import { getVectorStoreId } from '../knowledge/vector-store.service';
import {
  canonicalizeProduct,
  findSubstitutedFields,
  inspectCatalogFields,
  resolveKnownProduct,
  resolveTerm,
  verifyCaseFields,
  verifyTerm,
} from '../knowledge/knowledge-verifier';
import { presentationSummary } from '../knowledge/product-catalog';
import { recordGap } from '../onboarding/gap.service';
import {
  buildSystemPrompt,
  buildTurnHint,
  type ActiveCaseView,
  type MentionedProduct,
} from '../prompts/build-system-prompt';
import {
  createCase,
  findActiveCaseByWorkflow,
  recordCaseIntent,
  setCaseStatus,
  setCaseUrgency,
  upsertCaseFields,
  type CaseWithData,
} from '../repositories/case.repository';
import { setContactName } from '../repositories/contact.repository';
import {
  recentMessages,
  recordMessage,
  updateConversationState,
} from '../repositories/conversation.repository';
import { evaluateEligibility, routeCase } from '../routing/routing.service';
import type { TenantConfig } from '../tenants/config-schema';
import type { ContactRow, ConversationRow, Sentiment } from '../types/domain';
import {
  candidateProductTerms,
  evaluateFields,
  fillDescriptiveFields,
  mergeFields,
  nextFocus,
  resolveFieldKey,
  type ChannelContext,
} from '../workflows/field-engine';
import { enabledWorkflows, workflowForIntent } from '../workflows/workflow-engine';
import { recordUsage } from '../usage/usage.service';
import { buildCorrectionInstruction, inspectReply, safeFallbackFor } from './reply-guard';
import { channelKnownFacts, snapshotConversation } from './state.service';

export interface EngineInput {
  config: TenantConfig;
  contact: ContactRow;
  conversation: ConversationRow;
  channel: ChannelContext;
  /** Mensajes entrantes ya persistidos que este turno debe considerar. */
  newMessages: string[];
}

export interface EngineDebug {
  intents: Array<{ intent: string; confidence: number }>;
  fieldUpdates: Array<{ workflow: string; key: string; value: string }>;
  knowledgeSources: string[];
  missingEssential: Record<string, string[]>;
  routed: Array<{ caseId: number; workflow: string; detail: string }>;
  /** Valores que la aplicación NO pudo confirmar contra la documentación. */
  unverified: string[];
  guardViolations: string[];
  usage: { inputTokens: number; outputTokens: number; latencyMs: number };
  passes: number;
  systemPrompt: string;
}

export interface EngineResult {
  reply: string;
  /** true si la respuesta es el fallback configurado porque OpenAI falló. */
  degraded: boolean;
  debug: EngineDebug;
}

const MAX_HISTORY = 24;

/**
 * El único camino por el que se produce una respuesta. WhatsApp y el CLI entran
 * exactamente por aquí; no existe una variante simplificada.
 */
export async function processTurn(input: EngineInput): Promise<EngineResult> {
  const { config, contact, conversation, channel } = input;
  const tenantId = config.tenantId;

  const debug: EngineDebug = {
    intents: [],
    fieldUpdates: [],
    knowledgeSources: [],
    missingEssential: {},
    routed: [],
    unverified: [],
    guardViolations: [],
    usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
    passes: 0,
    systemPrompt: '',
  };

  const vectorStoreId = getVectorStoreId(tenantId);

  // ── 1. Estado actual ───────────────────────────────────────────────────────
  let snapshot = snapshotConversation(config, conversation.id, channel);

  // Lo que la persona acaba de mencionar, resuelto ANTES de generar. En el turno
  // en que alguien pide algo por primera vez todavía no hay caso, así que los
  // hallazgos del estado llegan un turno tarde: sin esto el asistente contestaba
  // la primera petición a ciegas.
  const mentionedProducts = resolveMentions(config, input.newMessages);

  const buildPrompt = (views: ActiveCaseView[]): string =>
    buildSystemPrompt({
      config,
      mode: env.APP_MODE,
      channel: channel.channel,
      contactName: contact.display_name,
      channelKnownFacts: channelKnownFacts(channel),
      activeCases: views,
      lastSentiment: conversation.last_sentiment,
      ambiguityCount: conversation.ambiguity_count,
      hasKnowledge: Boolean(vectorStoreId),
      globalCannotDo: [...new Set(enabledWorkflows(config).flatMap((w) => w.config.cannot_do))],
      mentionedProducts,
    });

  const history = buildHistory(conversation.id, input.newMessages);

  // Pista de foco: la calcula la APLICACIÓN, no el modelo.
  const focusCase = snapshot.views.find((v) => v.status.missingEssential.length > 0);
  const hint = focusCase
    ? buildTurnHint(nextFocus(focusCase.status), focusCase.workflowKey, config)
    : '';
  if (hint && history.length > 0) {
    const last = history[history.length - 1];
    history[history.length - 1] = { ...last, content: `${last.content}\n\n${hint}` };
  }

  // ── 2. Turno del modelo ────────────────────────────────────────────────────
  let systemPrompt = buildPrompt(snapshot.views);
  debug.systemPrompt = systemPrompt;

  let turn: TurnResult;
  try {
    turn = await runAssistantTurn({ systemPrompt, messages: history, vectorStoreId });
    debug.passes += 1;
  } catch (e) {
    if (e instanceof OpenAiUnavailableError) {
      log.error('Turno degradado: OpenAI no respondió', { tenant: tenantId, error: e });
      return {
        reply: config.company.assistant.fallback_message,
        degraded: true,
        debug,
      };
    }
    throw e;
  }

  accumulateUsage(debug, turn);
  recordUsage({
    tenantId,
    conversationId: conversation.id,
    model: turn.model,
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
    totalTokens: turn.usage.totalTokens,
    openaiRequestId: turn.requestId,
    latencyMs: turn.latencyMs,
    twilioInbound: input.newMessages.length,
  });

  let ai: AiTurnOutput = turn.output;
  debug.intents = ai.detected_intents;
  debug.fieldUpdates = ai.field_updates;
  debug.knowledgeSources = turn.citations.map((c) => c.fileName);

  // ── 3. Estado conversacional derivado ──────────────────────────────────────
  applyConversationSignals(conversation.id, ai);

  // ── 4. Casos: crear / actualizar ───────────────────────────────────────────
  const userMessages = historyUserMessages(conversation.id, input.newMessages);
  const touched = materializeCases(config, contact, conversation, ai, channel, userMessages);
  snapshot = snapshotConversation(config, conversation.id, channel, new Set(), userMessages);
  for (const v of snapshot.views) debug.missingEssential[v.workflowKey] = v.status.missingEssential;

  // Lo que la persona pidió y no está en la documentación es información que el
  // cliente debería aclarar: o sí lo maneja y falta documentarlo, o no lo maneja
  // y conviene saber cuánta gente lo pide.
  for (const v of snapshot.views) {
    for (const u of v.unverified) {
      debug.unverified.push(`${v.workflowKey}.${u.field}="${u.value}"`);
      recordGap({
        tenantId,
        gapType: 'UNANSWERED_KNOWLEDGE',
        intent: v.workflowKey,
        topic: `"${u.value}" no aparece en la documentación`,
        missingInformation: `confirmar si se maneja "${u.value}"; si sí, documentarlo`,
        conversationId: conversation.id,
      });
    }
  }

  // ── 5. Canalización determinista ───────────────────────────────────────────
  let deliveryAuthorized = false;
  let bestSemantics: 'REGISTERED_ONLY' | 'DELIVERED_TO_TEAM' | null = null;
  let routedSomething = false;
  /**
   * El producto que pidieron no está en la documentación. La respuesta ya se
   * generó sin saberlo (la verificación ocurre después de extraer los campos),
   * así que hay que rehacerla: si no, el asistente sigue pidiendo cantidad y
   * ciudad de algo que quizá ni se vende.
   */
  let blockedByVerification = false;
  const justRoutedCaseIds = new Set<number>();

  // Señal de escalamiento: algo quedó sin respaldo o pidieron una acción que
  // este asistente no puede ejecutar. Es lo único que hace que un flujo
  // meramente informativo llegue a una persona.
  const escalationSignal = ai.onboarding_gaps.length > 0 || ai.requested_actions.length > 0;

  for (const caseData of touched) {
    const wf = config.workflows.workflows[caseData.row.workflow_key];
    if (!wf) continue;
    const status = evaluateFields(wf, caseData.fields, channel);
    const decision = evaluateEligibility(config, caseData, {
      essentialComplete: status.essentialComplete,
      escalationSignal,
      // Dos comprobaciones distintas: que el dato exista en el catálogo, y que
      // sea lo que la persona realmente pidió. Un producto sustituido por otro
      // parecido pasa la primera y falla la segunda.
      unverifiedFields: [
        ...verifyCaseFields(config, caseData.row.workflow_key, status.known).map((v) => v.field),
        ...findSubstitutedFields(
          config,
          caseData.row.workflow_key,
          status.known,
          userMessages,
        ).map((v) => v.field),
        // Un producto ambiguo tampoco se canaliza. "thinner" son tres productos
        // distintos: mandarle a Ventas una cotización sin saber cuál obliga a
        // volver a preguntar por otro medio, que es justo lo que este asistente
        // debía evitar. Un producto sin presentaciones publicadas SÍ se canaliza:
        // existe y se sabe cuál es, sólo falta el envase, y eso lo resuelve quien
        // atienda.
        ...inspectCatalogFields(config, caseData.row.workflow_key, status.known)
          .filter((f) => f.kind === 'AMBIGUOUS')
          .map((f) => f.field),
      ],
    });
    if (!decision.eligible) {
      if (decision.reason.startsWith('sin confirmar')) {
        blockedByVerification = true;
        debug.routed.push({
          caseId: caseData.row.id,
          workflow: caseData.row.workflow_key,
          detail: `BLOQUEADO — ${decision.reason}`,
        });
      }
      continue;
    }

    const outcome = await routeCase(config, caseData, decision, {
      contactName: contact.display_name,
      contactPhone: channel.phone ?? null,
      channel: channel.channel,
      openQuestions: ai.requested_actions,
    });

    debug.routed.push({
      caseId: caseData.row.id,
      workflow: caseData.row.workflow_key,
      detail: `${outcome.routed ? 'SUCCESS' : 'NO'} — ${outcome.detail}`,
    });

    if (outcome.routed) {
      routedSomething = true;
      deliveryAuthorized = true;
      justRoutedCaseIds.add(caseData.row.id);
      if (outcome.confirmationSemantics === 'DELIVERED_TO_TEAM') bestSemantics = 'DELIVERED_TO_TEAM';
      else if (bestSemantics === null) bestSemantics = outcome.confirmationSemantics;
    }
  }

  // ── 6. Segunda pasada si la canalización cambió lo que se puede afirmar ────
  //
  // La respuesta se generó cuando el caso AÚN no estaba canalizado, así que no
  // podía confirmar nada. Ahora que sí ocurrió, se regenera con el estado real:
  // así el asistente confirma después del hecho, nunca antes.
  // También cuando hay un dato sin confirmar, aunque el caso SÍ se canalice
  // marcado: la advertencia llega al estado después de que el modelo ya habló,
  // así que sin rehacer la respuesta el asistente pide RFC y razón social de un
  // producto que no está en catálogo, como si fuera un pedido normal.
  if (routedSomething || blockedByVerification || debug.unverified.length > 0) {
    snapshot = snapshotConversation(config, conversation.id, channel, justRoutedCaseIds, userMessages);
    systemPrompt = buildPrompt(snapshot.views);
    debug.systemPrompt = systemPrompt;
    try {
      const second = await runAssistantTurn({ systemPrompt, messages: history, vectorStoreId });
      debug.passes += 1;
      accumulateUsage(debug, second);
      recordUsage({
        tenantId,
        conversationId: conversation.id,
        model: second.model,
        inputTokens: second.usage.inputTokens,
        outputTokens: second.usage.outputTokens,
        totalTokens: second.usage.totalTokens,
        openaiRequestId: second.requestId,
        latencyMs: second.latencyMs,
      });
      ai = { ...second.output, detected_intents: ai.detected_intents };
      debug.knowledgeSources = [
        ...new Set([...debug.knowledgeSources, ...second.citations.map((c) => c.fileName)]),
      ];
    } catch {
      // Si la segunda pasada falla nos quedamos con la primera respuesta: es
      // conservadora (no confirma nada), así que es segura.
      log.warn('La segunda pasada falló; se conserva la respuesta conservadora', { tenant: tenantId });
    }
  }

  // ── 7. Guarda determinista sobre el texto ──────────────────────────────────
  const guardCtx = {
    config,
    deliveryAuthorized,
    confirmationSemantics: bestSemantics,
    // Permite cazar "sí manejamos X" cuando X no está en la documentación.
    // La respuesta se genera antes de que se pueda verificar el campo extraído,
    // así que este es el único punto donde se puede atrapar en el mismo turno.
    verify: (term: string) => verifyTerm(config, term),
  };

  let inspection = inspectReply(ai.reply, guardCtx);
  if (!inspection.ok) {
    debug.guardViolations = inspection.violations.map((v) => `${v.kind}:${v.match}`);
    log.warn('La respuesta rompió una regla; se regenera', {
      tenant: tenantId,
      violations: debug.guardViolations,
    });

    try {
      const retry = await runAssistantTurn({
        systemPrompt: `${systemPrompt}\n\n## Corrección obligatoria\n${buildCorrectionInstruction(inspection)}`,
        messages: history,
        vectorStoreId,
      });
      debug.passes += 1;
      accumulateUsage(debug, retry);
      recordUsage({
        tenantId,
        conversationId: conversation.id,
        model: retry.model,
        inputTokens: retry.usage.inputTokens,
        outputTokens: retry.usage.outputTokens,
        totalTokens: retry.usage.totalTokens,
        openaiRequestId: retry.requestId,
        latencyMs: retry.latencyMs,
      });

      const retryInspection = inspectReply(retry.output.reply, guardCtx);
      if (retryInspection.ok) {
        ai = { ...ai, reply: retry.output.reply };
        inspection = retryInspection;
      } else {
        debug.guardViolations.push(
          ...retryInspection.violations.map((v) => `retry:${v.kind}:${v.match}`),
        );
      }
    } catch {
      log.warn('El reintento correctivo falló', { tenant: tenantId });
    }

    // Si aún rompe la regla, no mandamos algo que miente: mandamos un texto
    // seguro ACORDE a lo que se bloqueó. Un genérico ("ya tengo la información
    // necesaria") ante un producto sin confirmar suena a que todo va bien
    // justo cuando no lo está.
    const finalCheck = inspectReply(ai.reply, guardCtx);
    if (!finalCheck.ok) {
      ai = { ...ai, reply: safeFallbackFor(finalCheck, guardCtx) };
    }
  }

  // ── 8. Gaps de onboarding ──────────────────────────────────────────────────
  persistGaps(config, conversation.id, ai, Boolean(vectorStoreId));

  let reply = ai.reply.trim() || config.company.assistant.fallback_message;

  // Enlace al catálogo cuando se pidió algo que no manejamos. El prompt ya lo
  // pide, pero el modelo lo incluye de forma intermitente y es justo el dato
  // que convierte un "no" en algo útil. Se añade sólo si no lo puso él.
  if (debug.unverified.length > 0) {
    const catalog = (
      config.company.company.catalog_url ||
      config.company.company.website ||
      ''
    ).trim();
    if (catalog && !reply.includes(catalog)) {
      reply = `${reply}\n\nPuede ver nuestro catálogo completo aquí: ${catalog}`;
    }
  }

  log.block('AI', [
    ['Tenant', tenantId],
    ['Intents', ai.detected_intents.map((i) => `${i.intent} ${i.confidence.toFixed(2)}`).join(', ')],
    ['Campos', ai.field_updates.map((f) => `${f.workflow}.${f.key}=${f.value}`).join(' | ')],
    ['Knowledge', `${turn.citations.length} fuente(s): ${debug.knowledgeSources.join(', ')}`],
    ['Sentimiento', `${ai.customer_sentiment} / urgencia ${ai.urgency_signal}`],
    [
      'Faltantes',
      Object.entries(debug.missingEssential)
        .map(([k, v]) => `${k}:[${v.join(',')}]`)
        .join(' ') || '(ninguno)',
    ],
    ['Canalizado', debug.routed.map((r) => `#${r.caseId} ${r.workflow} ${r.detail}`).join(' | ') || '(no)'],
    ['Sin confirmar', debug.unverified.join(', ') || '(nada)'],
    ['Guard', debug.guardViolations.join(', ') || 'ok'],
    ['Pasadas', String(debug.passes)],
  ]);

  return { reply, degraded: false, debug };
}

// ── piezas internas ──────────────────────────────────────────────────────────

/**
 * Resuelve contra el catálogo los productos que la persona nombró en los mensajes
 * de ESTE turno.
 *
 * Se descartan los términos que no resuelven a nada Y que además no parecen un
 * producto: `candidateProductTerms` es generoso a propósito, y decirle al modelo
 * "«buenas tardes» no está en el catálogo" lo empuja a negar cosas absurdas. Sólo
 * se reporta un NO_MATCH cuando el término tiene pinta de producto pedido, que es
 * cuando negarlo es la respuesta correcta.
 */
function resolveMentions(config: TenantConfig, messages: string[]): MentionedProduct[] {
  const seen = new Set<string>();
  const out: MentionedProduct[] = [];

  for (const message of messages) {
    for (const term of candidateProductTerms(message)) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const r = resolveTerm(config, term);

      if (r.status === 'MATCH' && r.product) {
        out.push({
          term,
          status: 'MATCH',
          canonicalName: r.product.canonicalName,
          presentations: presentationSummary(r.product),
        });
      } else if (r.status === 'AMBIGUOUS') {
        out.push({
          term,
          status: 'AMBIGUOUS',
          candidates: (r.candidates ?? []).map((p) => p.canonicalName),
          ...(r.matchedFamily ? { familyLabel: r.matchedFamily } : {}),
        });
      }
      // NO_MATCH y NO_KNOWLEDGE no se reportan aquí: de negar un producto se
      // encarga la verificación del campo extraído, que sabe cuál de todos los
      // términos del mensaje era realmente el producto pedido.
    }
  }

  // Un mensaje puede nombrar dos productos ("tolueno y xileno") y eso es legítimo,
  // pero una lista larga es ruido del extractor: se acota para no diluir el prompt.
  return out.slice(0, 6);
}

function accumulateUsage(debug: EngineDebug, turn: TurnResult): void {
  debug.usage.inputTokens += turn.usage.inputTokens;
  debug.usage.outputTokens += turn.usage.outputTokens;
  debug.usage.latencyMs += turn.latencyMs;
}

function buildHistory(
  conversationId: number,
  newMessages: string[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const rows = recentMessages(conversationId, MAX_HISTORY);
  const history = rows
    .filter((m) => (m.body ?? '').trim() !== '')
    .map((m) => ({
      role: (m.direction === 'INBOUND' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.body as string,
    }));

  // Si los mensajes nuevos ya están persistidos, no los dupliques.
  const pending = newMessages.filter((text) => {
    const last = history[history.length - 1];
    return !(last && last.role === 'user' && last.content === text);
  });

  if (pending.length > 0) {
    history.push({ role: 'user', content: pending.join('\n') });
  }
  if (history.length === 0) {
    history.push({ role: 'user', content: newMessages.join('\n') || 'Hola' });
  }
  return history;
}

/** Mensajes que escribió la persona, del más viejo al más nuevo. */
function historyUserMessages(conversationId: number, newMessages: string[]): string[] {
  const previous = recentMessages(conversationId, MAX_HISTORY)
    .filter((m) => m.direction === 'INBOUND' && (m.body ?? '').trim() !== '')
    .map((m) => m.body as string);
  const extra = newMessages.filter((m) => !previous.includes(m));
  return [...previous, ...extra];
}

function applyConversationSignals(conversationId: number, ai: AiTurnOutput): void {
  updateConversationState(conversationId, {
    sentiment: ai.customer_sentiment as Sentiment,
    ambiguityDelta: ai.needs_clarification ? 1 : 0,
  });
}

/**
 * Convierte los intents detectados en casos persistidos y funde los campos.
 * Una conversación puede producir 0..N casos: nunca se fuerza a uno solo.
 */
function materializeCases(
  config: TenantConfig,
  contact: ContactRow,
  conversation: ConversationRow,
  ai: AiTurnOutput,
  channel: ChannelContext,
  userMessages: string[],
): CaseWithData[] {
  const touched = new Map<number, CaseWithData>();
  const MIN_CONFIDENCE = 0.35;

  for (const detected of ai.detected_intents) {
    if (detected.confidence < MIN_CONFIDENCE) continue;
    const wf = workflowForIntent(config, detected.intent);
    if (!wf) continue;

    let caseData = findActiveCaseByWorkflow(conversation.id, wf.key);
    if (!caseData) {
      caseData = createCase({
        tenantId: config.tenantId,
        conversationId: conversation.id,
        contactId: contact.id,
        workflowKey: wf.key,
        departmentKey: wf.config.department,
      });
    }
    recordCaseIntent(caseData.row.id, detected.intent, detected.confidence);
    if (ai.urgency_signal === 'HIGH' || ai.customer_sentiment === 'URGENT') {
      setCaseUrgency(caseData.row.id, 'HIGH');
    }
    touched.set(caseData.row.id, caseData);
  }

  // Campos → caso. La etiqueta `workflow` que pone el modelo es una pista, no la
  // verdad: cuando hay varios asuntos abiertos suele equivocarse. Si falla, se
  // resuelve por la clave del campo, que sí es un dato duro de la configuración.
  // Descartar el dato en silencio significaría volver a preguntar algo que la
  // persona ya dijo, que es justo lo que hace insoportable a un bot.
  const openList = [...touched.values()];
  for (const update of ai.field_updates) {
    // Resuelve la clave reportada contra las claves reales de cada workflow
    // abierto; un caso "declara" el campo sólo si la resolución tiene éxito.
    const resolvedFor = (c: CaseWithData): string | null => {
      const wf = config.workflows.workflows[c.row.workflow_key];
      return wf ? resolveFieldKey(wf, update.key) : null;
    };

    const byWorkflow = openList.find(
      (c) => c.row.workflow_key === update.workflow && resolvedFor(c) !== null,
    );
    const candidates = openList.filter((c) => resolvedFor(c) !== null);
    // Sólo se desempata solo si UN único workflow abierto declara ese campo.
    const target = byWorkflow ?? (candidates.length === 1 ? candidates[0] : null);

    if (!target) continue;

    const wf = config.workflows.workflows[target.row.workflow_key];
    if (!wf) continue;

    const key = resolveFieldKey(wf, update.key);
    if (!key) continue;

    const { merged, changed } = mergeFields(target.fields, { [key]: update.value }, wf);
    if (changed.length === 0) continue;
    target.fields = merged;
    upsertCaseFields(target.row.id, Object.fromEntries(changed.map((k) => [k, merged[k]])), 'LLM');

    // Si el caso ya estaba canalizado y llega información ESENCIAL nueva, vuelve
    // a estar vivo para que el área reciba la versión completa. Con datos
    // secundarios no se reabre: volver a avisar en cada turno convierte el canal
    // interno en spam y el responsable deja de leerlo.
    if (target.row.status === 'ROUTED' && changed.some((k) => wf.fields.essential.includes(k))) {
      setCaseStatus(target.row.id, 'OPEN');
      target.row.status = 'OPEN';
    }
  }

  // El canal aporta datos sin preguntarlos: se persisten como SYSTEM para que
  // queden en el brief que recibe el área interna.
  for (const c of touched.values()) {
    const wf = config.workflows.workflows[c.row.workflow_key];
    if (!wf) continue;

    // Lo que la persona ya describió con sus palabras, si el modelo lo omitió.
    const described = fillDescriptiveFields(wf, c.fields, userMessages);
    if (Object.keys(described).length > 0) {
      upsertCaseFields(c.row.id, described, 'USER');
      c.fields = { ...c.fields, ...described };
    }

    // Producto que la persona nombró y que SÍ está en el catálogo, cuando el
    // modelo no lo registró. Está dicho y confirmado: no hay nada que suponer, y
    // dejarlo vacío hace que se le pida "el producto exacto" a alguien que abrió
    // la conversación diciéndolo.
    const missingVerifiable = wf.verify_against_knowledge.filter((f) => !c.fields[f]?.trim());
    if (missingVerifiable.length > 0) {
      // `product_query` primero: el modelo ya separó ahí la identidad del producto
      // de las cantidades y los envases, así que es más preciso que barrer el
      // mensaje palabra por palabra. El barrido queda como respaldo.
      const known =
        resolveKnownProduct(config, ai.product_query ? [ai.product_query] : []) ??
        resolveKnownProduct(config, userMessages.flatMap((m) => candidateProductTerms(m)));
      if (known) {
        const filled = Object.fromEntries(missingVerifiable.map((f) => [f, known]));
        upsertCaseFields(c.row.id, filled, 'USER');
        c.fields = { ...c.fields, ...filled };
      }
    }

    // Se normaliza al nombre del catálogo: quien escribió "thiner americano" deja
    // registrado "Thinner Americano". Así el panel y el aviso al área ven el
    // nombre real del producto y no la grafía de cada persona, y dos clientes que
    // piden lo mismo con palabras distintas producen el mismo dato.
    for (const field of wf.verify_against_knowledge) {
      const value = c.fields[field];
      if (!value) continue;
      const canonical = canonicalizeProduct(config, value);
      if (canonical) {
        upsertCaseFields(c.row.id, { [field]: canonical }, 'SYSTEM');
        c.fields = { ...c.fields, [field]: canonical };
      }
    }

    const status = evaluateFields(wf, c.fields, channel);
    const fromChannel: Record<string, string> = {};
    for (const [k, v] of Object.entries(status.known)) {
      if (!c.fields[k] && v) fromChannel[k] = v;
    }
    if (Object.keys(fromChannel).length > 0) {
      upsertCaseFields(c.row.id, fromChannel, 'SYSTEM');
      c.fields = { ...c.fields, ...fromChannel };
    }
  }

  // Nombre del contacto: si el modelo lo extrajo, se guarda a nivel contacto.
  if (!contact.display_name) {
    const nameField = ai.field_updates.find((f) => /contact_name|nombre/i.test(f.key));
    if (nameField?.value) setContactName(contact.id, nameField.value);
  }

  return [...touched.values()];
}

function persistGaps(
  config: TenantConfig,
  conversationId: number,
  ai: AiTurnOutput,
  hasKnowledge: boolean,
): void {
  for (const gap of ai.onboarding_gaps) {
    recordGap({
      tenantId: config.tenantId,
      gapType: gap.gap_type,
      intent: ai.detected_intents[0]?.intent ?? null,
      topic: gap.topic,
      missingInformation: gap.missing_information,
      conversationId,
    });
  }

  // Intents que ningún workflow habilitado reclama: eso es configuración faltante.
  for (const detected of ai.detected_intents) {
    if (detected.confidence < 0.5) continue;
    if (detected.intent === 'UNKNOWN') {
      recordGap({
        tenantId: config.tenantId,
        gapType: 'UNKNOWN_INTENT',
        intent: 'UNKNOWN',
        topic: snip(ai.requested_actions[0] ?? 'motivo no clasificado', 120),
        missingInformation: 'no hay workflow que cubra este tipo de solicitud',
        conversationId,
      });
      continue;
    }
    if (!workflowForIntent(config, detected.intent)) {
      recordGap({
        tenantId: config.tenantId,
        gapType: 'MISSING_WORKFLOW_RULE',
        intent: detected.intent,
        topic: `sin workflow para ${detected.intent}`,
        missingInformation: `definir un workflow que atienda ${detected.intent} en workflows.yaml`,
        conversationId,
      });
    }
  }

  if (!hasKnowledge) {
    recordGap({
      tenantId: config.tenantId,
      gapType: 'UNANSWERED_KNOWLEDGE',
      intent: null,
      topic: 'sin knowledge sincronizada',
      missingInformation: 'ejecutar onboard:sync para indexar sitio y documentos autorizados',
      conversationId,
    });
  }
}

/** Persiste la respuesta saliente. La usan tanto el worker como el CLI. */
export function persistAssistantReply(
  tenantId: string,
  conversationId: number,
  reply: string,
  provider = 'internal',
  providerMessageId: string | null = null,
): void {
  recordMessage({
    tenantId,
    conversationId,
    direction: 'OUTBOUND',
    kind: 'TEXT',
    body: reply,
    provider,
    providerMessageId,
  });
  log.block('OUTBOUND', [
    ['Tenant', tenantId],
    ['Conversación', String(conversationId)],
    ['Texto', pii(snip(reply, 500))],
  ]);
}
