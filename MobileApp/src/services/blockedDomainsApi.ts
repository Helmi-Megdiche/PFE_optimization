import {api} from './apiClient';

export type RecordBlockedDomainOutcome =
  | 'added'
  | 'reactivated'
  | 'already_active'
  | 'ignored';

export interface RecordBlockedDomainResponse {
  domain: string;
  outcome: RecordBlockedDomainOutcome;
}

/** POST /api/blocked-domains — child token; childId comes from the JWT, not this payload. */
export function postBlockedDomain(
  domain: string,
  detectedAt: string,
): Promise<RecordBlockedDomainResponse> {
  return api.post<RecordBlockedDomainResponse>('/blocked-domains', {
    domain,
    detectedAt,
  });
}

export interface BlockedDomainSummary {
  id: string;
  domain: string;
  source: string;
  detectedAt: string;
}

/**
 * GET /api/blocked-domains/:childId — reachable by the child's own device token (Task 11), so
 * the device can reconcile its dynamic list against the parent's current active set.
 */
export function getBlockedDomains(
  childId: string,
): Promise<{domains: BlockedDomainSummary[]}> {
  return api.get<{domains: BlockedDomainSummary[]}>(
    `/blocked-domains/${childId}`,
  );
}

export interface RecordBrowserIncidentResponse {
  id: string;
  domain: string;
  listSource: 'static' | 'detected';
  occurredAt: string;
}

/**
 * POST /api/browser-incidents — device posts on `onBrowserBlocked` (a URL-watcher match, Back +
 * block screen). The F2 leave-only path never calls this — see CLAUDE.md's Phase B F2 bullet.
 */
export function postBrowserIncident(
  domain: string,
  listSource: 'static' | 'detected',
  occurredAt: string,
): Promise<RecordBrowserIncidentResponse> {
  return api.post<RecordBrowserIncidentResponse>('/browser-incidents', {
    domain,
    listSource,
    occurredAt,
  });
}
