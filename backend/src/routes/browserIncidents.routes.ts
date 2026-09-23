import { Router, Response } from 'express';
import { requireChildRole, requireParentRole, AuthenticatedRequest } from '../middleware/auth';
import { requireChildAccess } from '../middleware/childAccess';
import { validateBody, validateQuery } from '../middleware/validate';
import {
  listBrowserIncidentsQuerySchema,
  recordBrowserIncidentSchema,
} from '../validators/blockedDomains.validator';
import {
  listBrowserIncidents,
  recordBrowserIncident,
  type BrowserBlockIncidentRow,
} from '../services/blockedDomainsService';
import { logger } from '../utils/logger';

const router = Router();

function mapIncident(row: BrowserBlockIncidentRow) {
  return {
    id: row.id,
    domain: row.domain,
    listSource: row.list_source,
    occurredAt: row.occurred_at,
  };
}

/**
 * POST /api/browser-incidents — device posts on `onBrowserBlocked` (a URL-watcher
 * match, Back + block screen). Child token, same shape as POST /api/screen-events.
 * The F2 leave-only path (an OCR-only adult detection sent back one page) never
 * posts here — no domain is blacklisted and no block screen shown, so there is
 * nothing to log as an incident; that detection already reaches the parent via the
 * screen event it fires from (see CLAUDE.md's Phase B F2 bullet).
 */
router.post(
  '/',
  requireChildRole,
  validateBody(recordBrowserIncidentSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    const childId = req.user!.childId!;
    // Same Date-conversion note as blockedDomains.routes.ts's POST /.
    const { domain, listSource, occurredAt } = req.body as {
      domain: string;
      listSource: 'static' | 'detected';
      occurredAt: Date;
    };
    const occurredAtIso = new Date(occurredAt).toISOString();

    try {
      const row = await recordBrowserIncident(childId, domain, listSource, occurredAtIso);
      res.status(201).json(mapIncident(row));
    } catch (err) {
      logger.error('Failed to record browser incident', {
        childId,
        domain,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to record browser incident' });
    }
  },
);

/**
 * GET /api/browser-incidents/:childId — parent dashboard, read-only.
 */
router.get(
  '/:childId',
  requireParentRole,
  requireChildAccess('param:childId'),
  validateQuery(listBrowserIncidentsQuerySchema),
  async (req: AuthenticatedRequest, res: Response) => {
    const { childId } = req.params;
    const { limit } = req.query as unknown as { limit: number };

    try {
      const rows = await listBrowserIncidents(childId, limit);
      res.json({ childId, incidents: rows.map(mapIncident) });
    } catch (err) {
      logger.error('Failed to list browser incidents', {
        childId,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to fetch browser incidents' });
    }
  },
);

export default router;
