import { query } from '../db/pool';

export interface BlockedDomainRow {
  id: string;
  child_id: string;
  domain: string;
  source: string;
  detected_at: string;
  created_at: string;
  removed_at: string | null;
}

export interface BrowserBlockIncidentRow {
  id: string;
  child_id: string;
  domain: string;
  list_source: string;
  occurred_at: string;
  created_at: string;
}

export type RecordBlockedDomainOutcome = 'added' | 'reactivated' | 'already_active' | 'ignored';

/**
 * A10: one row per (child_id, domain), reactivated in place rather than re-inserted.
 *
 * - no row yet -> insert active (removed_at NULL).
 * - row active (removed_at IS NULL) -> idempotent; advance detected_at forward only.
 * - row removed AND detectedAt < removed_at -> IGNORED. A stale queued POST from before
 *   the parent's unblock must not silently re-block a domain the parent just cleared.
 * - row removed AND detectedAt >= removed_at -> a genuine later detection; reactivate.
 */
export async function recordDetectedDomain(
  childId: string,
  domain: string,
  detectedAt: string,
): Promise<{ outcome: RecordBlockedDomainOutcome; row: BlockedDomainRow }> {
  const { rows: existingRows } = await query<BlockedDomainRow>(
    `SELECT id, child_id, domain, source, detected_at, created_at, removed_at
     FROM blocked_domains WHERE child_id = $1 AND domain = $2 LIMIT 1`,
    [childId, domain],
  );
  const existing = existingRows[0];

  if (!existing) {
    const { rows } = await query<BlockedDomainRow>(
      `INSERT INTO blocked_domains (child_id, domain, source, detected_at)
       VALUES ($1, $2, 'detected', $3)
       RETURNING id, child_id, domain, source, detected_at, created_at, removed_at`,
      [childId, domain, detectedAt],
    );
    return { outcome: 'added', row: rows[0] };
  }

  if (existing.removed_at !== null) {
    if (new Date(detectedAt).getTime() < new Date(existing.removed_at).getTime()) {
      return { outcome: 'ignored', row: existing };
    }
    const { rows } = await query<BlockedDomainRow>(
      `UPDATE blocked_domains
       SET removed_at = NULL, detected_at = $1
       WHERE id = $2
       RETURNING id, child_id, domain, source, detected_at, created_at, removed_at`,
      [detectedAt, existing.id],
    );
    return { outcome: 'reactivated', row: rows[0] };
  }

  if (new Date(detectedAt).getTime() > new Date(existing.detected_at).getTime()) {
    const { rows } = await query<BlockedDomainRow>(
      `UPDATE blocked_domains SET detected_at = $1 WHERE id = $2
       RETURNING id, child_id, domain, source, detected_at, created_at, removed_at`,
      [detectedAt, existing.id],
    );
    return { outcome: 'already_active', row: rows[0] };
  }
  return { outcome: 'already_active', row: existing };
}

export async function listBlockedDomains(
  childId: string,
  limit: number,
): Promise<BlockedDomainRow[]> {
  const { rows } = await query<BlockedDomainRow>(
    `SELECT id, child_id, domain, source, detected_at, created_at, removed_at
     FROM blocked_domains
     WHERE child_id = $1 AND removed_at IS NULL
     ORDER BY detected_at DESC
     LIMIT $2`,
    [childId, limit],
  );
  return rows;
}

/** __DEV__-only unblock (Task 10). No-op (false) if the domain wasn't actively blocked. */
export async function unblockDomain(childId: string, domain: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE blocked_domains SET removed_at = NOW()
     WHERE child_id = $1 AND domain = $2 AND removed_at IS NULL`,
    [childId, domain],
  );
  return (rowCount ?? 0) > 0;
}

export async function recordBrowserIncident(
  childId: string,
  domain: string,
  listSource: 'static' | 'detected',
  occurredAt: string,
): Promise<BrowserBlockIncidentRow> {
  const { rows } = await query<BrowserBlockIncidentRow>(
    `INSERT INTO browser_block_incidents (child_id, domain, list_source, occurred_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, child_id, domain, list_source, occurred_at, created_at`,
    [childId, domain, listSource, occurredAt],
  );
  return rows[0];
}

export async function listBrowserIncidents(
  childId: string,
  limit: number,
): Promise<BrowserBlockIncidentRow[]> {
  const { rows } = await query<BrowserBlockIncidentRow>(
    `SELECT id, child_id, domain, list_source, occurred_at, created_at
     FROM browser_block_incidents
     WHERE child_id = $1
     ORDER BY occurred_at DESC
     LIMIT $2`,
    [childId, limit],
  );
  return rows;
}
