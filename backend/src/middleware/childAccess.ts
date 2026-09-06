import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest, JwtPayload } from './auth.types';
import { query } from '../db/pool';
import { logger } from '../utils/logger';

/**
 * Ownership predicate. `parentId` is a `users.id` (a parent JWT's `sub`);
 * `children.parent_id` references `users.id`. `children.id` is the PK, so this is a
 * PK probe plus an equality filter — the cheapest query in the system.
 */
export async function parentOwnsChild(
  parentId: string,
  childId: string,
): Promise<boolean> {
  if (!parentId || !childId) {
    return false;
  }
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM children WHERE id = $1 AND parent_id = $2 LIMIT 1`,
    [childId, parentId],
  );
  return rows.length > 0;
}

/**
 * The single authorization predicate for "may this token act on this child?".
 * Child branch: a child token may only reach its own `childId` claim.
 * Parent branch: a parent may only reach a child they own.
 */
export async function userCanAccessChild(
  user: JwtPayload | undefined,
  childId: string | undefined,
): Promise<boolean> {
  if (!user || !childId) {
    return false;
  }
  if (user.role === 'child') {
    return user.childId === childId;
  }
  if (user.role === 'parent') {
    return parentOwnsChild(user.sub, childId);
  }
  return false;
}

export type ChildIdSource = 'param:childId' | 'query:childId' | 'body:childId';

/**
 * Declared per-route ownership guard. The returned middleware is a **named**
 * function expression on purpose: `tests/routeAuthorization.test.ts` walks the
 * router stack and asserts `requireChildAccessMw` appears in the handler chain of
 * every child-scoped route.
 *
 * `query:childId` is optional — `listBadgesQuerySchema` is
 * `Joi.string().uuid().optional()` with `stripUnknown`, so a present value is
 * always a uuid string and `?childId=` (empty) is rejected with 400 before this
 * runs. `undefined` is therefore the only pass-through case.
 */
export function requireChildAccess(source: ChildIdSource) {
  const [loc, key] = source.split(':') as [
    'param' | 'query' | 'body',
    string,
  ];
  return async function requireChildAccessMw(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const bag =
      loc === 'param' ? req.params : loc === 'query' ? req.query : req.body;
    const childId = (bag as Record<string, unknown> | undefined)?.[key];

    if (loc === 'query' && childId === undefined) {
      next();
      return;
    }

    try {
      if (
        typeof childId === 'string' &&
        (await userCanAccessChild(req.user, childId))
      ) {
        next();
        return;
      }
      res.status(403).json({ error: 'Access denied for this child' });
    } catch (err) {
      // Express 4 does not forward a rejected async-middleware promise to the
      // error handler — an unhandled rejection here hangs the request. Catch and
      // fail closed with a 500 (matches the pre-existing in-handler behaviour).
      logger.error('Ownership check failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}
