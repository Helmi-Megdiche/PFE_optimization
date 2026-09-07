/**
 * Route-authorization enumeration guard (ALL_IS_FIXED #7).
 *
 * Walks the fully-mounted Express router and checks the **complete** route table
 * against a committed inventory. Any route added, removed or renamed reds this
 * suite until a human classifies it here — that churn is the point: it is the
 * mechanism that stops a child-scoped route shipping without an ownership guard.
 *
 * Hermetic: mocks `config/env` and `db/pool` so importing the router tree pulls
 * in no live DB and no native binding. It sends no HTTP requests.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/config/env', () => ({
  env: {
    isProduction: false,
    jwtSecret: 't',
    jwtIssuer: 't',
    databaseUrl: 'postgres://t',
    missionRiskCooldownMinutes: 2,
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
  },
}));
jest.mock('../src/db/pool', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

import router from '../src/routes/index';

/* ------------------------------------------------------------------ */
/* Router walk                                                         */
/* ------------------------------------------------------------------ */

interface LiveRoute {
  key: string; // "METHOD /api/full/path"
  method: string;
  path: string;
  chain: string[]; // named middleware/handlers in order (anon = "<anon>")
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountOf(layer: any): string {
  const src: string = layer?.regexp?.source ?? '';
  const cut = src.indexOf('\\/?(?=');
  const body = cut >= 0 ? src.slice(0, cut) : src;
  return body.replace(/^\^/, '').replace(/\\\//g, '/');
}

function canonical(p: string): string {
  if (p.length > 1 && p.endsWith('/')) {
    return p.slice(0, -1);
  }
  return p;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(stack: any[], prefix: string, inherited: string[], out: LiveRoute[]): void {
  let acc = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const routePath = canonical(prefix + layer.route.path);
      const localNames: string[] = (layer.route.stack ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => s.handle?.name || '<anon>',
      );
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase());
      for (const method of methods) {
        out.push({
          key: `${method} ${routePath}`,
          method,
          path: routePath,
          chain: [...acc, ...localNames],
        });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountOf(layer), acc, out);
    } else {
      // bare middleware (router.use(fn)) — applies to every sibling below it
      acc = [...acc, layer.handle?.name || layer.name || '<anon-mw>'];
    }
  }
}

const live: LiveRoute[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
walk((router as any).stack, '/api', [], live);
const liveByKey = new Map(live.map((r) => [r.key, r]));

/* ------------------------------------------------------------------ */
/* Committed inventory — EVERY route in the non-production mounted tree */
/* ------------------------------------------------------------------ */

type Access =
  | 'child:param' // childId in req.params.childId  -> requireChildAccessMw in chain
  | 'child:query' // childId in req.query.childId    -> requireChildAccessMw in chain
  | 'child:body' //  childId in req.body.childId     -> requireChildAccessMw in chain
  | 'child:derived' // childId from a loaded row     -> in DERIVED_ROUTES + source assertion
  | 'child:token' // childId from the JWT claim      -> requireChildRole in chain
  | 'public' //       mounted before verifyToken
  | 'role-only' //    authenticated + role-gated, not child-scoped
  | 'none'; //        authenticated only

interface InvEntry {
  key: string;
  access: Access;
  note?: string;
}

const ROUTE_INVENTORY: InvEntry[] = [
  // --- public (before verifyToken) ---
  { key: 'GET /api/health', access: 'public' },
  { key: 'GET /api/dev/child-token', access: 'public' },
  { key: 'GET /api/dev/parent-token', access: 'public' },
  {
    key: 'POST /api/dev/reward-age-badges/:childId',
    access: 'public',
    note: 'ALL_IS_FIXED #7 §6: unauthenticated dev-only route, deliberately out of scope; needs a real auth story, not this fix.',
  },
  { key: 'POST /api/debug/classify', access: 'public' },
  { key: 'POST /api/debug/arabic-ocr', access: 'public' },

  // --- screen-events ---
  { key: 'POST /api/screen-events', access: 'child:token' },
  { key: 'GET /api/screen-events/:childId', access: 'child:param' },

  // --- usage ---
  { key: 'POST /api/usage', access: 'child:token' },
  { key: 'GET /api/usage/:childId', access: 'child:param' },

  // --- scores ---
  { key: 'GET /api/scores/:childId/trend', access: 'child:param' },
  { key: 'GET /api/scores/:childId', access: 'child:param' },

  // --- missions ---
  { key: 'POST /api/missions/suggest', access: 'child:token' },
  { key: 'POST /api/missions/generate', access: 'child:body' },
  { key: 'POST /api/missions/dev/force', access: 'child:body' },
  { key: 'GET /api/missions/child/:childId/points', access: 'child:param' },
  { key: 'GET /api/missions/child/:childId', access: 'child:param' },
  { key: 'POST /api/missions/:missionId/approve', access: 'child:derived' },
  { key: 'POST /api/missions/:missionId/reject', access: 'child:derived' },
  { key: 'GET /api/missions/:missionId', access: 'child:token' },
  { key: 'POST /api/missions/:missionId/abandon', access: 'child:token' },
  { key: 'POST /api/missions/:missionId/complete', access: 'child:token' },

  // --- rewards (parent-owned resource; out of #7 scope) ---
  { key: 'GET /api/rewards', access: 'none', note: 'in-handler role branch; parent-owned rows scoped by parent_id / getChildParentId' },
  { key: 'POST /api/rewards', access: 'role-only' },
  { key: 'PUT /api/rewards/:rewardId', access: 'role-only', note: 'ownership by reward.parent_id, not childId' },
  { key: 'DELETE /api/rewards/:rewardId', access: 'role-only', note: 'ownership by reward.parent_id, not childId' },
  { key: 'POST /api/rewards/:rewardId/claim', access: 'child:token' },

  // --- badges ---
  { key: 'GET /api/badges', access: 'child:query' },
  { key: 'GET /api/badges/child/:childId', access: 'child:param' },

  // --- bonus ---
  { key: 'POST /api/bonus/child/:childId', access: 'child:param' },

  // --- custom-missions (parent-owned resource; out of #7 scope) ---
  { key: 'GET /api/custom-missions', access: 'role-only' },
  { key: 'POST /api/custom-missions', access: 'role-only' },
  { key: 'PUT /api/custom-missions/:id', access: 'role-only' },
  { key: 'DELETE /api/custom-missions/:id', access: 'role-only' },

  // --- child ---
  { key: 'GET /api/child/profile/:childId', access: 'child:param' },
  { key: 'PUT /api/child/profile', access: 'child:body' },
  { key: 'GET /api/child/interests/:childId', access: 'child:param' },
  { key: 'PUT /api/child/interests', access: 'child:body' },
];

// Routes whose child id is derived from a loaded row: ownership is checked
// in-handler after the mission is fetched, so it cannot appear in the middleware
// chain. Backed by the source assertion below, and by acceptance arm A3.
const DERIVED_ROUTES = new Set<string>([
  'POST /api/missions/:missionId/approve',
  'POST /api/missions/:missionId/reject',
]);

const invByKey = new Map(ROUTE_INVENTORY.map((e) => [e.key, e]));

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

describe('route authorization enumeration guard', () => {
  it('1. the live route table exactly matches the committed inventory', () => {
    const liveKeys = new Set(live.map((r) => r.key));
    const invKeys = new Set(ROUTE_INVENTORY.map((e) => e.key));

    const missingFromInventory = [...liveKeys].filter((k) => !invKeys.has(k)).sort();
    const staleInInventory = [...invKeys].filter((k) => !liveKeys.has(k)).sort();

    expect({ missingFromInventory, staleInInventory }).toEqual({
      missingFromInventory: [],
      staleInInventory: [],
    });
  });

  it('2. every param/query/body child-scoped route carries requireChildAccessMw', () => {
    const offenders: string[] = [];
    for (const e of ROUTE_INVENTORY) {
      if (
        e.access === 'child:param' ||
        e.access === 'child:query' ||
        e.access === 'child:body'
      ) {
        const r = liveByKey.get(e.key);
        if (!r || !r.chain.includes('requireChildAccessMw')) {
          offenders.push(`${e.key} [chain: ${r ? r.chain.join(', ') : 'ROUTE MISSING'}]`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('3. every child:token route carries requireChildRole (a failure here is a live defect, not test data)', () => {
    const offenders: string[] = [];
    for (const e of ROUTE_INVENTORY) {
      if (e.access !== 'child:token') {
        continue;
      }
      const r = liveByKey.get(e.key);
      if (!r || !r.chain.includes('requireChildRole')) {
        offenders.push(`${e.key} [chain: ${r ? r.chain.join(', ') : 'ROUTE MISSING'}]`);
      }
    }
    // If this reds, the route dereferences req.user!.childId! on a token that may
    // not carry it — fix the route, do NOT relax the inventory entry.
    expect(offenders).toEqual([]);
  });

  it('4. every child:derived route is on the DERIVED_ROUTES allow-list', () => {
    const offenders = ROUTE_INVENTORY.filter(
      (e) => e.access === 'child:derived' && !DERIVED_ROUTES.has(e.key),
    ).map((e) => e.key);
    expect(offenders).toEqual([]);
    // and no allow-list entry without an inventory classification
    const orphan = [...DERIVED_ROUTES].filter(
      (k) => invByKey.get(k)?.access !== 'child:derived',
    );
    expect(orphan).toEqual([]);
  });

  it('5. derived routes really do call userCanAccessChild in the handler source', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'missions.routes.ts'),
      'utf8',
    );
    const approveIdx = src.indexOf("'/:missionId/approve'");
    const rejectIdx = src.indexOf("'/:missionId/reject'");
    const abandonIdx = src.indexOf("'/:missionId/abandon'");
    expect(approveIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(-1);
    // approve handler region: from its declaration to the next route declaration
    const approveRegion = src.slice(approveIdx, rejectIdx);
    const rejectRegion = src.slice(rejectIdx, abandonIdx > rejectIdx ? abandonIdx : src.length);
    expect(approveRegion).toContain('userCanAccessChild(');
    expect(rejectRegion).toContain('userCanAccessChild(');
  });

  it('6. a route with :childId in its path cannot be silently non-child (guards the inventory against its maintainer)', () => {
    const offenders: string[] = [];
    for (const r of live) {
      if (!r.path.includes(':childId')) {
        continue;
      }
      const e = invByKey.get(r.key);
      if (!e) {
        continue; // caught by assertion 1
      }
      const ok =
        e.access === 'child:param' ||
        (e.access === 'public' && !!e.note);
      if (!ok) {
        offenders.push(`${r.key} classified '${e.access}'${e.note ? '' : ' (no note)'}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
