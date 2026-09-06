import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { requireChildAccess } from '../middleware/childAccess';
import { validateQuery } from '../middleware/validate';
import Joi from 'joi';
import {
  badgeCategory,
  getChildBadges,
  listAllBadgesWithEarnedStatus,
} from '../services/gamificationService';
import { logger } from '../utils/logger';

const router = Router();

const listBadgesQuerySchema = Joi.object({
  childId: Joi.string().uuid().optional(),
});

/**
 * GET /api/badges?childId=
 */
router.get(
  '/',
  validateQuery(listBadgesQuerySchema),
  requireChildAccess('query:childId'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { childId } = req.query as { childId?: string };

    try {
      const badges = await listAllBadgesWithEarnedStatus(childId);
      res.json({
        badges: badges.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          icon: b.icon,
          category: b.category,
          requirementType: b.requirement_type,
          requirementValue: b.requirement_value,
          requirementConfig: b.requirement_config,
          pointsAwarded: b.points_awarded,
          earned: b.earned,
          earnedAt: b.earnedAt,
        })),
      });
    } catch (err) {
      logger.error('Failed to list badges', {
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to fetch badges' });
    }
  },
);

/**
 * GET /api/badges/child/:childId
 */
router.get(
  '/child/:childId',
  requireChildAccess('param:childId'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { childId } = req.params;

    try {
      const badges = await getChildBadges(childId);
      res.json({
        childId,
        badges: badges.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          icon: b.icon,
          category: badgeCategory(b.requirement_type),
          requirementType: b.requirement_type,
          requirementValue: b.requirement_value,
          requirementConfig: b.requirement_config,
          pointsAwarded: b.points_awarded,
          earnedAt: b.earned_at,
        })),
      });
    } catch (err) {
      logger.error('Failed to fetch child badges', {
        childId,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to fetch child badges' });
    }
  },
);

export default router;
