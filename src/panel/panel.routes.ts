import { Router, type Request, type Response } from 'express';
import { log } from '../lib/logger';
import { listTenants, tenantExists } from '../tenants/tenant-loader';
import {
  panelCases,
  panelConfig,
  panelConversations,
  panelGaps,
  panelSummary,
  panelTranscript,
} from './panel.service';

export const panelRouter: Router = Router();

/** Resuelve el tenant del query; si sólo hay uno, se usa ése. */
function resolveTenant(req: Request, res: Response): string | null {
  const raw = typeof req.query.tenant === 'string' ? req.query.tenant.trim().toLowerCase() : '';
  if (raw) {
    if (!tenantExists(raw)) {
      res.status(404).json({ error: 'tenant no encontrado' });
      return null;
    }
    return raw;
  }
  const all = listTenants();
  if (all.length === 1) return all[0];
  res.status(400).json({ error: 'especifica ?tenant=', tenants: all });
  return null;
}

function handle(fn: (tenantId: string, req: Request) => unknown) {
  return (req: Request, res: Response): void => {
    const tenantId = resolveTenant(req, res);
    if (!tenantId) return;
    try {
      res.json(fn(tenantId, req));
    } catch (e) {
      log.error('Error en el panel', { path: req.path, error: e });
      res.status(500).json({ error: 'no se pudo leer la información' });
    }
  };
}

function intParam(value: unknown, dflt: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
}

panelRouter.get('/tenants', (_req: Request, res: Response) => {
  res.json({ tenants: listTenants() });
});

panelRouter.get('/summary', handle((t) => panelSummary(t)));

panelRouter.get(
  '/cases',
  handle((t, req) => ({ cases: panelCases(t, intParam(req.query.limit, 50, 200)) })),
);

panelRouter.get(
  '/conversations',
  handle((t, req) => ({ conversations: panelConversations(t, intParam(req.query.limit, 50, 200)) })),
);

panelRouter.get(
  '/conversations/:id/transcript',
  handle((t, req) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return { messages: [] };
    return { messages: panelTranscript(t, id) };
  }),
);

panelRouter.get(
  '/gaps',
  handle((t, req) => ({ gaps: panelGaps(t, intParam(req.query.limit, 60, 200)) })),
);

panelRouter.get('/config', handle((t) => panelConfig(t)));
