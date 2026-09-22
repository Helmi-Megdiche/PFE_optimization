import { Router, Response, NextFunction } from 'express';
import { env } from '../config/env';
import {
  requireChildRole,
  requireParentRole,
  AuthenticatedRequest,
} from '../middleware/auth';
import { requireChildAccess } from '../middleware/childAccess';
import { validateBody, validateQuery } from '../middleware/validate';
import {
  listBlockedDomainsQuerySchema,
  recordBlockedDomainSchema,
  unblockDomainDevSchema,
} from '../validators/blockedDomains.validator';
import {
  listBlockedDomains,
  recordDetectedDomain,
  unblockDomain,
  type BlockedDomainRow,
} from '../services/blockedDomainsService';
import { logger } from '../utils/logger';

const router = Router();

function mapBlockedDomain(row: BlockedDomainRow) {
  return {
    id: row.id,
    domain: row.domain,
    source: row.source,
    detectedAt: row.detected_at,
  };
}

/**
 * Named guard, same shape as `missions.routes.ts`'s `devOnlyRoute` — a flat 404 in
 * production before any role/body/ownership branch, so the unblock endpoint cannot
 * become a 403-vs-404 ownership oracle on a route meant to be invisible in prod
 * (CLAUDE.md, the `#8-SF4` failure class). There is deliberately no parent-facing
 * DELETE — unblocking only ever goes through this dev-only route.
 */
function devOnlyRoute(
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (env.isProduction) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

/**
 * POST /api/blocked-domains — device sync (backfill + live detections). Child token,
 * same as POST /api/screen-events: childId comes from the JWT, never the body.
 */
router.post(
  '/',
  requireChildRole,
  validateBody(recordBlockedDomainSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    const childId = req.user!.childId!;
    // Joi's date().iso() converts the wire string into a Date (validateBody writes the
    // converted value back to req.body) — normalise back to ISO here so the service layer
    // has one stable string type to compare and persist.
    const { domain, detectedAt } = req.body as { domain: string; detectedAt: Date };
    const detectedAtIso = new Date(detectedAt).toISOString();

    try {
      const { outcome, row } = await recordDetectedDomain(childId, domain, detectedAtIso);
      res.status(200).json({ domain: row.domain, outcome });
    } catch (err) {
      logger.error('Failed to record blocked domain', {
        childId,
        domain,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to record blocked domain' });
    }
  },
);

/**
 * GET /api/blocked-domains/:childId — parent dashboard, read-only.
 */
router.get(
  '/:childId',
  requireParentRole,
  requireChildAccess('param:childId'),
  validateQuery(listBlockedDomainsQuerySchema),
  async (req: AuthenticatedRequest, res: Response) => {
    const { childId } = req.params;
    const { limit } = req.query as unknown as { limit: number };

    try {
      const rows = await listBlockedDomains(childId, limit);
      res.json({ childId, domains: rows.map(mapBlockedDomain) });
    } catch (err) {
      logger.error('Failed to list blocked domains', {
        childId,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to fetch blocked domains' });
    }
  },
);

/**
 * POST /api/blocked-domains/dev/unblock — dev-only (404 in production). The only
 * unblock path; there is no parent-facing DELETE in the UI or the API.
 */
router.post(
  '/dev/unblock',
  devOnlyRoute,
  requireParentRole,
  validateBody(unblockDomainDevSchema),
  requireChildAccess('body:childId'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { childId, domain } = req.body as { childId: string; domain: string };

    try {
      const unblocked = await unblockDomain(childId, domain);
      res.json({ domain, unblocked });
    } catch (err) {
      logger.error('Failed to unblock domain', {
        childId,
        domain,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to unblock domain' });
    }
  },
);

export default router;
