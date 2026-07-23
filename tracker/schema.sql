-- D1 schema for the self-hosted visitor tracker.
-- Apply with:  wrangler d1 execute visitor-tracker --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,          -- epoch milliseconds (UTC)
  ip          TEXT,                      -- full IP, or anonymised when STORE_FULL_IP="false"
  ip_hash     TEXT NOT NULL,             -- salted SHA-256, always present for unique counting
  country     TEXT,
  region      TEXT,
  city        TEXT,
  postal      TEXT,
  latitude    TEXT,
  longitude   TEXT,
  timezone    TEXT,
  asn         INTEGER,
  as_org      TEXT,
  colo        TEXT,                      -- Cloudflare edge datacentre that served the hit
  path        TEXT,
  title       TEXT,
  referrer    TEXT,
  user_agent  TEXT,
  lang        TEXT,
  screen      TEXT,
  visitor_id  TEXT,                      -- random id kept in the browser's localStorage
  is_new      INTEGER NOT NULL DEFAULT 0,
  is_bot      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_visits_ts      ON visits (ts);
CREATE INDEX IF NOT EXISTS idx_visits_ip      ON visits (ip);
CREATE INDEX IF NOT EXISTS idx_visits_hash    ON visits (ip_hash);
CREATE INDEX IF NOT EXISTS idx_visits_country ON visits (country);
CREATE INDEX IF NOT EXISTS idx_visits_bot_ts  ON visits (is_bot, ts);
