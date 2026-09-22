-- Phase B Part 2: parent-visible record of on-device adult-domain blocking (Task 10).
--
-- blocked_domains: one row per (child_id, domain), reactivated in place rather than
-- re-inserted, so history (detected_at / removed_at) survives a re-detection after an
-- unblock. `source` is CHECK-pinned to 'detected' now (the only source the device ever
-- writes); a future static-list mirror would add a value here, not a new table.
CREATE TABLE blocked_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  domain VARCHAR(253) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'detected' CHECK (source = 'detected'),
  detected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  UNIQUE (child_id, domain)
);

CREATE INDEX idx_blocked_domains_child_active
  ON blocked_domains (child_id)
  WHERE removed_at IS NULL;

-- browser_block_incidents: append-only log of every Back+block-screen sequence the
-- device actually ran (the F2 leave-only path deliberately never inserts here — that
-- adult detection already reaches the parent via the screen event it fires from).
CREATE TABLE browser_block_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  domain VARCHAR(253) NOT NULL,
  list_source VARCHAR(20) NOT NULL CHECK (list_source IN ('static', 'detected')),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_browser_block_incidents_child
  ON browser_block_incidents (child_id, occurred_at DESC);
