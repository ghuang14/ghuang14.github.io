-- D1 schema for the self-hosted request log.
-- Apply with:  wrangler d1 execute visitor-tracker --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,          -- epoch milliseconds (UTC)
  ip          TEXT,                      -- connecting address, coarsened when STORE_FULL_IP="false"
  ip_hash     TEXT NOT NULL,             -- salted SHA-256, always present so repeat clients collapse to one count
  country     TEXT,
  region      TEXT,
  city        TEXT,
  postal      TEXT,
  latitude    TEXT,
  longitude   TEXT,
  timezone    TEXT,
  asn         INTEGER,
  as_org      TEXT,
  colo        TEXT,                      -- Cloudflare edge datacentre that served the request
  path        TEXT,
  title       TEXT,
  referrer    TEXT,
  user_agent  TEXT,
  lang        TEXT,
  screen      TEXT,
  visitor_id  TEXT,                      -- random id the client keeps in its own localStorage
  is_new      INTEGER NOT NULL DEFAULT 0,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  -- Added after the table first shipped. Existing databases get these from the
  -- lazy migration in src/index.js (LATE_COLUMNS) — SQLite has no
  -- "ADD COLUMN IF NOT EXISTS", and this file is re-applied on every deploy,
  -- so an ALTER here would break the deploy the second time it ran.
  event_id       TEXT,                   -- one id per page load, de-duplicates multi-transport sends
  dnt            INTEGER NOT NULL DEFAULT 0,  -- DNT/GPC opt-out: still counted, but stored with no address, no location, no user agent
  transport      TEXT,                   -- how the request arrived: load/bfcache/pixel/nojs/...
  origin_missing INTEGER NOT NULL DEFAULT 0,  -- neither Origin nor Referer: recorded, but quarantined
  client_ip      TEXT,                   -- the address the CLIENT reports for itself, when it differs
  origin_host    TEXT,                   -- host of the presenting origin, for requests via a listed alternate host
  client_tz      TEXT,                   -- IANA zone the CLIENT reports; differs from `timezone` when relayed
  tz_offset      INTEGER,                -- minutes east of UTC, as the client sees it
  queued_ms      INTEGER,                -- request replayed from the browser's retry queue: how long it waited
  failovers      INTEGER NOT NULL DEFAULT 0,  -- transports that failed before one worked
  latency_ms     INTEGER                    -- ms from navigation start to handing the pageview to the network
);

CREATE INDEX IF NOT EXISTS idx_visits_ts      ON visits (ts);
CREATE INDEX IF NOT EXISTS idx_visits_ip      ON visits (ip);
CREATE INDEX IF NOT EXISTS idx_visits_hash    ON visits (ip_hash);
CREATE INDEX IF NOT EXISTS idx_visits_country ON visits (country);
CREATE INDEX IF NOT EXISTS idx_visits_bot_ts  ON visits (is_bot, ts);

-- idx_visits_event, the partial unique index that lets INSERT OR IGNORE collapse
-- the several transports of one page load, is deliberately NOT here. It names
-- event_id, and this file is re-applied against the EXISTING table on every
-- deploy — where that column does not exist yet, so the statement would fail
-- with "no such column: event_id" and take the whole deploy down before the
-- Worker that adds the column could ship. It is created by runMigration() in
-- src/index.js instead, right after the LATE_COLUMNS ALTERs, so fresh and
-- upgraded databases both end up with it.
