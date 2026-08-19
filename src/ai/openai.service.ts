import OpenAI from 'openai';
import { env, requireOpenAI } from '../config/env';
import { log } from '../lib/logger';
import {
  AI_OUTPUT_JSON_SCHEMA,
  AI_OUTPUT_SCHEMA_NAME,
  normalizeAiOutput,
  type AiTurnOutput,
} from './ai-schema';

let client: OpenAI | null = null;

export function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: requireOpenAI(),
      timeout: env.OPENAI_TIMEOUT_MS,
      maxRetries: 2,
    });
  }
  return client;
}

export class OpenAiUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`OpenAI no disponible: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'OpenAiUnavailableError';
  }
}

export interface KnowledgeCitation {
  fileId: string;
  fileName: string;
  score: number | null;
}

export interface TurnResult {
  output: AiTurnOutput;
  citations: KnowledgeCitation[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  requestId: string | null;
  latencyMs: number;
  model: string;
}

export interface TurnRequest {
  systemPrompt: string;
  /** Historial ya recortado: el más viejo primero. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  vectorStoreId: string | null;
  maxKnowledgeResults?: number;
}

/**
 * Un turno del asistente: Responses API + File Search (si el tenant tiene vector
 * store) + Structured Outputs. Devuelve además qué documentos se consultaron,
 * porque la aplicación necesita saber si la respuesta está respaldada.
 */
export async function runAssistantTurn(req: TurnRequest): Promise<TurnResult> {
  const started = Date.now();
  const tools =
    req.vectorStoreId
      ? [
          {
            type: 'file_search' as const,
            vector_store_ids: [req.vectorStoreId],
            max_num_results: req.maxKnowledgeResults ?? 6,
          },
        ]
      : [];

  let response: Awaited<ReturnType<OpenAI['responses']['create']>>;
  try {
    response = await openai().responses.create({
      model: env.OPENAI_MODEL,
      instructions: req.systemPrompt,
      input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      tools,
      ...(tools.length > 0 ? { include: ['file_search_call.results' as const] } : {}),
      text: {
        format: {
          type: 'json_schema',
          name: AI_OUTPUT_SCHEMA_NAME,
          strict: true,
          schema: AI_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    });
  } catch (e) {
    log.error('Llamada a OpenAI falló', { error: e });
    throw new OpenAiUnavailableError(e);
  }

  const latencyMs = Date.now() - started;
  const anyResp = response as unknown as Record<string, any>;

  if (anyResp.status === 'incomplete') {
    throw new OpenAiUnavailableError(
      new Error(`respuesta incompleta: ${anyResp.incomplete_details?.reason ?? 'desconocido'}`),
    );
  }

  const refusal = findRefusal(anyResp);
  if (refusal) {
    log.warn('El modelo rehusó responder', { refusal });
  }

  const text = typeof anyResp.output_text === 'string' ? anyResp.output_text : '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenAiUnavailableError(new Error('la salida no fue JSON válido pese al schema estricto'));
  }

  return {
    output: normalizeAiOutput(parsed),
    citations: extractCitations(anyResp),
    usage: {
      inputTokens: Number(anyResp.usage?.input_tokens ?? 0),
      outputTokens: Number(anyResp.usage?.output_tokens ?? 0),
      totalTokens: Number(anyResp.usage?.total_tokens ?? 0),
    },
    requestId: (anyResp._request_id as string | undefined) ?? null,
    latencyMs,
    model: String(anyResp.model ?? env.OPENAI_MODEL),
  };
}

function findRefusal(resp: Record<string, any>): string | null {
  for (const item of resp.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'refusal') return String(part.refusal ?? '');
    }
  }
  return null;
}

/**
 * Qué documentos consultó realmente file_search. Se lee tanto del item
 * `file_search_call` (cuando pedimos `include`) como de las anotaciones del
 * mensaje, porque el modelo puede citar sin que se incluyan los resultados.
 */
function extractCitations(resp: Record<string, any>): KnowledgeCitation[] {
  const byId = new Map<string, KnowledgeCitation>();

  for (const item of resp.output ?? []) {
    if (item?.type === 'file_search_call') {
      for (const r of item.results ?? []) {
        const id = String(r?.file_id ?? '');
        if (!id) continue;
        const score = typeof r?.score === 'number' ? r.score : null;
        const prev = byId.get(id);
        if (!prev || (score !== null && (prev.score ?? -1) < score)) {
          byId.set(id, { fileId: id, fileName: String(r?.filename ?? id), score });
        }
      }
    }
    if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        for (const a of part?.annotations ?? []) {
          if (a?.type !== 'file_citation') continue;
          const id = String(a.file_id ?? '');
          if (!id || byId.has(id)) continue;
          byId.set(id, { fileId: id, fileName: String(a.filename ?? id), score: null });
        }
      }
    }
  }

  return [...byId.values()];
}
