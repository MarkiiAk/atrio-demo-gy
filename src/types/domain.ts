/**
 * Tipos de dominio compartidos. Nada aquí conoce a un tenant concreto:
 * los intents, departamentos y workflows reales vienen de la configuración YAML.
 */

/** Catálogo cerrado de intents que el core sabe manejar. */
export const INTENTS = [
  'GENERAL_INFORMATION',
  'SALES_QUOTE',
  'SUPPLIER',
  'HR',
  'INVOICE',
  'ORDER_STATUS',
  'DELIVERY_ISSUE',
  'PRODUCT_DAMAGE',
  'COMPLAINT',
  'SUGGESTION',
  'UNKNOWN',
] as const;
export type Intent = (typeof INTENTS)[number];

export const SENTIMENTS = ['NEUTRAL', 'POSITIVE', 'FRUSTRATED', 'ANGRY', 'URGENT'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const URGENCIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const GAP_TYPES = [
  'UNANSWERED_KNOWLEDGE',
  'MISSING_ROUTING',
  'MISSING_WORKFLOW_RULE',
  'UNKNOWN_INTENT',
  'LOW_CONFIDENCE',
  'MISSING_CLIENT_POLICY',
] as const;
export type GapType = (typeof GAP_TYPES)[number];

export type Visibility = 'PUBLIC' | 'CUSTOMER_SAFE';

export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageKind = 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'UNKNOWN';

export type CaseStatus = 'OPEN' | 'READY' | 'ROUTED' | 'ROUTING_FAILED' | 'CLOSED';

export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type RoutingAdapterType = 'LOG' | 'EMAIL' | 'WEBHOOK' | 'CRM' | 'HUMAN_INBOX';
export type RoutingOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED';

// ── Filas persistidas ────────────────────────────────────────────────────────

export interface ContactRow {
  id: number;
  tenant_id: string;
  display_name: string | null;
  primary_phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExternalIdentityRow {
  id: number;
  tenant_id: string;
  contact_id: number;
  channel: string;
  external_user_id: string;
  phone: string | null;
  profile_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: number;
  tenant_id: string;
  contact_id: number;
  channel: string;
  status: 'ACTIVE' | 'CLOSED';
  ambiguity_count: number;
  last_sentiment: Sentiment | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  tenant_id: string;
  conversation_id: number;
  direction: MessageDirection;
  kind: MessageKind;
  body: string | null;
  provider: string;
  provider_message_id: string | null;
  media_json: string | null;
  created_at: string;
}

export interface CaseRow {
  id: number;
  tenant_id: string;
  conversation_id: number;
  contact_id: number;
  workflow_key: string;
  department_key: string | null;
  status: CaseStatus;
  urgency: Urgency;
  created_at: string;
  updated_at: string;
  routed_at: string | null;
  closed_at: string | null;
}

export interface CaseDataRow {
  id: number;
  case_id: number;
  field_key: string;
  field_value: string;
  source: 'LLM' | 'SYSTEM' | 'USER';
  created_at: string;
  updated_at: string;
}

export interface CaseIntentRow {
  id: number;
  case_id: number;
  intent: string;
  confidence: number;
  created_at: string;
}

export interface RoutingEventRow {
  id: number;
  tenant_id: string;
  case_id: number;
  adapter: RoutingAdapterType;
  outcome: RoutingOutcome;
  detail: string | null;
  created_at: string;
}

export interface InboundJobRow {
  id: number;
  tenant_id: string;
  conversation_id: number;
  message_id: number;
  status: JobStatus;
  attempts: number;
  scheduled_at: string;
  locked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OnboardingGapRow {
  id: number;
  tenant_id: string;
  gap_type: GapType;
  /** Cadena vacía cuando no hay intent (nunca NULL: ver índice UNIQUE). */
  intent: string;
  topic: string;
  missing_information: string | null;
  conversation_id: number | null;
  frequency: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface UsageRecordRow {
  id: number;
  tenant_id: string;
  conversation_id: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  openai_request_id: string | null;
  latency_ms: number;
  twilio_inbound_messages: number;
  twilio_outbound_messages: number;
  created_at: string;
}

export interface KnowledgeSourceRow {
  id: number;
  tenant_id: string;
  visibility: Visibility;
  source_type: string;
  source_name: string;
  uri: string | null;
  content_hash: string;
  openai_file_id: string | null;
  vector_store_id: string | null;
  bytes: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSyncRow {
  id: number;
  tenant_id: string;
  started_at: string;
  finished_at: string | null;
  vector_store_id: string | null;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  detail: string | null;
}
