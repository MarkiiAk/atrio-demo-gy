import type { TenantConfig } from '../tenants/config-schema';
import type { ActiveCaseView } from '../prompts/build-system-prompt';
import { activeCases, lastRoutingOutcome, type CaseWithData } from '../repositories/case.repository';
import type { ChannelContext } from '../workflows/field-engine';
import { evaluateFields } from '../workflows/field-engine';
import { verifyCaseFields } from '../knowledge/knowledge-verifier';

export interface ConversationSnapshot {
  cases: CaseWithData[];
  views: ActiveCaseView[];
}

/**
 * Estado que ve el prompt. Se calcula SIEMPRE desde la base, nunca desde lo que
 * el modelo creyó en el turno anterior.
 */
export function snapshotConversation(
  config: TenantConfig,
  conversationId: number,
  channel: ChannelContext,
  /** Casos canalizados en ESTE turno: sólo ellos pueden confirmarse ahora. */
  justRoutedCaseIds: ReadonlySet<number> = new Set(),
): ConversationSnapshot {
  const cases = activeCases(conversationId);
  const views: ActiveCaseView[] = [];

  for (const c of cases) {
    const wf = config.workflows.workflows[c.row.workflow_key];
    if (!wf) continue;

    const status = evaluateFields(wf, c.fields, channel);
    const routed = c.row.status === 'ROUTED';
    let semantics: ActiveCaseView['confirmationSemantics'] = null;

    if (routed) {
      const target =
        config.routing.routing[c.row.department_key ?? ''] ?? config.routing.fallback ?? null;
      const outcome = lastRoutingOutcome(c.row.id);
      // Sólo autoriza confirmar si el último evento realmente fue exitoso.
      semantics = outcome?.outcome === 'SUCCESS' ? (target?.confirmation_semantics ?? 'REGISTERED_ONLY') : null;
    }

    views.push({
      caseId: c.row.id,
      workflowKey: c.row.workflow_key,
      departmentKey: c.row.department_key,
      status,
      routed: routed && semantics !== null,
      justRouted: justRoutedCaseIds.has(c.row.id),
      confirmationSemantics: semantics,
      // Se comprueba contra el conocimiento en disco, no contra lo que el
      // modelo crea: que el cliente afirme que vendemos algo no lo vuelve cierto.
      unverified: verifyCaseFields(config, c.row.workflow_key, status.known).map((v) => ({
        field: v.field,
        value: v.value,
      })),
    });
  }

  return { cases, views };
}

/** Datos que el canal aporta gratis, en lenguaje entendible para el prompt. */
export function channelKnownFacts(channel: ChannelContext): string[] {
  const facts: string[] = [];
  if (channel.phone) facts.push(`número de ${channel.channel} de contacto`);
  if (channel.profileName) facts.push(`nombre de perfil (${channel.profileName})`);
  return facts;
}
