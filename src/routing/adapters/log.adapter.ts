import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_ROOT } from '../../config/env';
import { log } from '../../lib/logger';
import type { AdapterResult, CaseBrief, RoutingAdapter } from '../types';

const OUT_DIR = path.join(PROJECT_ROOT, 'data', 'routed');

/**
 * Adapter obligatorio del MVP: deja el caso en consola y en un archivo JSONL por
 * tenant. NO entrega nada a ninguna persona, y por eso su semántica de
 * confirmación válida es únicamente REGISTERED_ONLY (lo impone el validador).
 */
export const logAdapter: RoutingAdapter = {
  type: 'LOG',

  async deliver(brief: CaseBrief): Promise<AdapterResult> {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${brief.tenantId}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...brief })}\n`, 'utf8');

    log.block('CASE ROUTED (LOG)', [
      ['Tenant', brief.tenantName],
      ['Folio', `${brief.folio} (${brief.workflowKey})`],
      ['Área', brief.departmentName],
      ['Urgencia', brief.urgency],
      ['Contacto', brief.contact.name ?? '(sin nombre)'],
      ['Datos', brief.fields.map((f) => `${f.label}=${f.value}`).join(' | ') || '(ninguno)'],
      ['Pendientes', brief.openQuestions.join(' / ') || '(ninguno)'],
      ['Archivo', file],
    ]);

    return { outcome: 'SUCCESS', detail: `registrado en ${path.relative(PROJECT_ROOT, file)}` };
  },
};
