/**
 * Self-hosted request log for ghuang14.github.io
 *
 * Replaces the two third-party page counters the site used to embed, both of
 * which are effectively dead. Runs on Cloudflare Workers, stores rows in D1
 * (SQLite).
 *
 * Routes
 *   POST|GET /e            record a pageview (called by the beacon on the site)
 *   POST|GET /e.gif        same, but always answers with a 1x1 GIF
 *   POST|GET /hit          legacy alias for /e, kept for pages already cached
 *   GET      /stats        HTML dashboard          (needs ?token=)
 *   GET      /stats.json   same numbers as JSON    (needs ?token=)
 *   GET      /export.csv   raw rows as CSV         (needs ?token=)
 *
 * The connecting address comes from Cloudflare's CF-Connecting-IP header, and
 * the geo / network fields come from `request.cf` — no third-party lookup
 * needed.
 */

const BOT_RE =
  /bot\b|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pingdom|uptimerobot|curl|wget|python-requests|go-http-client|axios|node-fetch|okhttp|java\/|libwww|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity|applebot|yandex|baiduspider|duckduckbot|archive\.org/i;

// 43-byte transparent 1x1 GIF, used by the no-JS / <img> fallback beacon.
const PIXEL = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return preflight(request, env);

    switch (path) {
      case "/e":
      case "/e.gif":
      case "/hit":
        return handleHit(request, env, ctx, url, path.endsWith(".gif"));
      case "/stats":
        return guard(request, env, url, () => handleDashboard(env, url));
      case "/stats.json":
        return guard(request, env, url, () => handleStatsJson(env, url));
      case "/export.csv":
        return guard(request, env, url, () => handleExport(env, url));
      default:
        return new Response("Not found", { status: 404 });
    }
  },

  // Optional retention cleanup; enable the [triggers] block in wrangler.toml.
  async scheduled(_event, env, ctx) {
    const days = parseInt(env.RETENTION_DAYS || "0", 10);
    if (!days) return;
    const cutoff = Date.now() - days * 86400000;
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM visits WHERE ts < ?").bind(cutoff).run()
    );
  },
};

/* ------------------------------------------------------------------ */
/* ingest                                                              */
/* ------------------------------------------------------------------ */

async function handleHit(request, env, ctx, url, forcePixel) {
  const wantsPixel = forcePixel || url.searchParams.get("f") === "gif";

  // Origin policy, four ways.
  //
  //   allowed   — Origin (or Referer-derived origin) is ours. Full record.
  //   mirror    — an origin the owner listed in MIRROR_ORIGINS. Full record,
  //               with the mirror's host kept in `origin_host`.
  //   no-origin — neither header was sent. Recorded, but marked unverified.
  //   denied    — some other origin was volunteered. 403, nothing stored.
  //
  // The "no-origin" case is the one that decides whether requests from the
  // harder networks are measurable at all. An <img> never sends Origin, so the
  // pixel fallback depends entirely on Referer — and the clients that need a
  // fallback are exactly the ones whose Referer gets stripped: in-app webviews,
  // and the transparent HTTP proxies common on the networks where the primary
  // endpoint does not connect. Both routinely send neither header.
  //
  // The first version of this file answered them with a 200 and stored nothing
  // at all. The second stored a country and a path but deliberately discarded
  // the connecting address, on the grounds that a request which cannot be
  // attributed to this site carries an address that cannot be trusted either.
  // That reasoning is sound about *trust* and wrong about *storage*: it means
  // the one slice of traffic this endpoint exists to measure — requests from
  // networks where the normal transports are the ones that fail — is precisely
  // the slice whose network metadata is dropped on arrival.
  //
  // So unverified hits are now recorded in full (address, geo, ASN, user agent)
  // and quarantined instead of blanked:
  //
  //   * origin_missing = 1 marks them, and every trusted figure on the
  //     dashboard still filters them out. They get their own tile, their own
  //     table and their own colour on the map.
  //   * Nothing the *page* volunteered is kept — no title, referrer, client
  //     id, language or screen — so a third-party page driving this endpoint
  //     still cannot write a single field of its own choosing. All it can
  //     produce is a quarantined row holding facts the network established.
  //   * PROFILE_UNVERIFIED="false" restores the previous blank-it behaviour.
  //
  // DNT/GPC is untouched by any of this: it is a legal opt-out, not a coverage
  // problem, and those rows still store no address at all.
  const verdict = originVerdict(request, env);
  if (verdict === "denied") {
    return wantsPixel
      ? pixelResponse()
      : cors(new Response(null, { status: 403 }), request, env);
  }

  let payload = {};
  if (request.method === "POST") {
    try {
      payload = JSON.parse(await request.text()) || {};
    } catch {
      payload = {};
    }
  } else {
    for (const [k, v] of url.searchParams) payload[k] = v;
    // The pixel packs the whole JSON body into `z` so it stays in step with
    // the POST payload. Older cached pages send flat query params instead.
    if (typeof payload.z === "string") {
      try {
        payload = { ...payload, ...(JSON.parse(payload.z) || {}) };
      } catch {
        /* keep the flat params */
      }
      delete payload.z;
    }
  }

  const cf = request.cf || {};
  const ua = request.headers.get("user-agent") || "";
  const eventId = /^[0-9a-z]{16,64}$/i.test(String(payload.e || ""))
    ? String(payload.e)
    : null;
  // An empty User-Agent used to be treated as proof of a bot, which quietly
  // filed every request coming through a header-stripping proxy under "bots
  // filtered" and hid it from the default dashboard — the same networks, again.
  // A hit carrying a well-formed beacon event id came from the script on this
  // site running in a real browser, whatever survived of the headers.
  const isBot = BOT_RE.test(ua) ? 1 : ua || eventId ? 0 : 1;

  // Do-Not-Track / GPC hits are counted and nothing more: no address, no id, no
  // user agent, no referrer, no title. `ip_hash` is NOT NULL in the schema, so
  // it gets a deliberately non-identifying bucket value; these rows are excluded
  // from every unique count on the dashboard.
  //
  // The request headers are checked as well as the flag the beacon sends,
  // because the <noscript> pixel is by definition the one transport where the
  // beacon's own DNT/GPC check never runs — reading only `payload.d` would keep
  // detail on exactly the clients that asked us not to. GPC is a legally
  // operative opt-out under CPRA, and the header is the client's own signal
  // rather than something a page had to volunteer, so it is honoured
  // unconditionally.
  const dnt =
    truthy(payload.d) ||
    request.headers.get("dnt") === "1" ||
    request.headers.get("sec-gpc") === "1"
      ? 1
      : 0;
  const noOrigin = verdict === "no-origin" ? 1 : 0;
  // Unverified rows keep their full detail unless the owner turns that off.
  const profileUnverified = env.PROFILE_UNVERIFIED !== "false";
  // `blank` — store no address, no geo, no user agent. Opt-outs always;
  // unverified hits only when PROFILE_UNVERIFIED says so.
  const blank = dnt || (noOrigin && !profileUnverified) ? 1 : 0;
  // `attributed` — the hit is provably from a page of ours, so the fields the
  // page volunteered can be believed. Never true for an opt-out (it sends
  // none) or for an unverified hit (it could have been sent by anyone).
  const attributed = !dnt && !noOrigin;

  const rawIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "";

  // The address the browser discovered for itself, via the echo endpoints in
  // _includes/edge-client.html. It is what recovers the real one when
  // CF-Connecting-IP is a mirror, a corporate proxy or a CDN in front of us —
  // the usual shape of a request from a network that cannot reach the primary
  // endpoint directly. Only a well-formed public address is kept, and only when
  // it actually differs from the connecting address.
  const claimed = publicIp(str(payload.ci, 64));
  const clientIp = blank || !claimed || claimed === rawIp ? null : claimed;

  // A hit the browser could not deliver when it happened, replayed from its
  // localStorage queue on a later pageview. `qt` is an AGE in milliseconds, not
  // a timestamp: the client's clock and ours need not agree, and the elapsed
  // time is what is needed to file the row on the day the request was actually
  // made rather than the day the network finally worked. Bounded on both
  // sides, so a bad clock or a forged value can move a row within the queue's
  // own retention window and nowhere else.
  const queuedMs = replayAge(payload.qt);
  const now = Date.now();

  // A replay's connecting address belongs to whatever network finally worked,
  // not to the request it describes — so when the queue carried the address the
  // browser found for itself at the time, that is what identifies the client
  // here. Bucketing on the relay instead would count one client as a new one for
  // every network it eventually got out through.
  const hashSource = queuedMs && clientIp ? clientIp : rawIp;

  const ipHash = blank
    ? (dnt ? "dnt:" : "anon:") + (cf.country || "??") + ":" +
      new Date().toISOString().slice(0, 10)
    : await sha256(hashSource + "|" + salt(env));

  // An enrichment ping: the beacon resolved the client's own address after the
  // pageview had already been sent, and is filling that one column in. It
  // carries no new pageview and must never create a row, or a client whose
  // lookup outran its beacon would be counted twice.
  if (truthy(payload.x)) {
    if (eventId && clientIp) ctx.waitUntil(enrich(env, eventId, ipHash, clientIp));
    if (wantsPixel) return pixelResponse();
    return cors(
      new Response(null, { status: 204, headers: { "cache-control": "no-store" } }),
      request,
      env
    );
  }

  // The zone the BROWSER reports, which is the client's own — unlike `timezone`
  // below, which Cloudflare derives from the connecting address and therefore
  // describes the VPN exit, the mirror or the proxy whenever there is one. The
  // pair disagreeing is the only evidence available here that a request started
  // somewhere other than where it comes out, and on a replayed hit it is the
  // only locating evidence left at all.
  //
  // It is kept for an unverified hit as well, unlike title/referrer/id, and for
  // the same reason `path` is: those rows are the traffic this endpoint exists
  // to measure, and a row that cannot say where it came from is not worth
  // storing. The value is validated to an IANA zone shape and nothing else, it
  // stays out of every trusted figure with the rest of its row, and it is shown
  // only in the sections already labelled unattributed — so the worst a forged
  // one can do is add a line to a table that is captioned as unverifiable.
  // Opt-outs send none and are never given one.
  const clientTz = blank ? null : ianaTz(payload.tz);
  const tzOffset = blank ? null : offsetMinutes(payload.tzo);


  const storeFull = env.STORE_FULL_IP !== "false";
  const row = {
    ts: queuedMs ? now - queuedMs : now,
    // Only a well-formed id is honoured, so a hostile caller cannot squat an
    // arbitrary string and have INSERT OR IGNORE swallow a real request.
    event_id: eventId,
    ip: blank || !rawIp ? null : storeFull ? rawIp : anonymiseIp(rawIp),
    client_ip: clientIp && !storeFull ? anonymiseIp(clientIp) : clientIp,
    // ip_hash is NOT NULL, so blanked rows get a deliberately non-identifying
    // country/day bucket. They are excluded from every unique count on the
    // dashboard, so the bucket never distorts a figure.
    ip_hash: ipHash,
    country: cf.country || null,
    region: blank ? null : cf.region || null,
    city: blank ? null : cf.city || null,
    postal: blank ? null : cf.postalCode || null,
    latitude: blank ? null : cf.latitude || null,
    longitude: blank ? null : cf.longitude || null,
    timezone: blank ? null : cf.timezone || null,
    asn: !blank && typeof cf.asn === "number" ? cf.asn : null,
    as_org: blank ? null : cf.asOrganization || null,
    colo: cf.colo || null,
    path: str(payload.p, 512) || pathFromReferer(request),
    // Everything below is volunteered by the page, so it is kept only for a
    // hit that is provably one of ours.
    title: attributed ? str(payload.t, 300) : null,
    referrer: attributed ? str(payload.r, 512) : null,
    user_agent: blank ? null : ua.slice(0, 400) || null,
    lang: attributed ? str(payload.l, 40) : null,
    screen: attributed ? str(payload.s, 40) : null,
    visitor_id: attributed ? str(payload.v, 64) : null,
    // `payload.n` arrives as the string "0" from a GET, which is truthy in
    // JavaScript — the old `payload.n ? 1 : 0` marked every pixel hit as a
    // brand-new client.
    is_new: attributed && truthy(payload.n) ? 1 : 0,
    is_bot: isBot,
    dnt,
    transport: str(payload.k, 16) || (wantsPixel ? "pixel" : "post"),
    origin_missing: noOrigin,
    origin_host: verdict === "mirror" ? originHost(request) : null,
    client_tz: clientTz,
    tz_offset: tzOffset,
    queued_ms: queuedMs,
    // How many transports had to fail before one worked. `transport` says which
    // one carried the hit; this says what it cost to get there, which is the
    // figure that shows a primary endpoint degrading before it disappears —
    // and, once a fallback endpoint is configured, exactly how many requests it
    // saved.
    failovers: countBounded(payload.f, 99),
    // Milliseconds from navigation start to the moment the page handed this
    // pageview to the network. The whole send path exists to keep this small —
    // a visitor who closes the tab before it elapses is a visitor nobody counts
    // — so it is recorded per row and reported as a distribution rather than
    // being assumed. Client-supplied and therefore bounded, but it is a
    // duration, not an identifier, and a wrong one is cosmetic.
    latency_ms: latencyMs(payload.dt),
  };

  // Write in the background so the browser isn't kept waiting.
  ctx.waitUntil(insert(env, row));

  if (wantsPixel) return pixelResponse();
  return cors(
    new Response(null, { status: 204, headers: { "cache-control": "no-store" } }),
    request,
    env
  );
}

// Fill in client_ip on a row that is already there. Scoped by the unique index
// key, and only ever fills a hole — an enrichment ping cannot overwrite an
// address that was already recorded.
async function enrich(env, eventId, ipHash, clientIp) {
  try {
    await migrate(env);
    await env.DB.prepare(
      `UPDATE visits SET client_ip = ?
         WHERE id = (SELECT id FROM visits
                      WHERE event_id = ? AND ip_hash = ? AND client_ip IS NULL
                      ORDER BY id DESC LIMIT 1)`
    )
      .bind(clientIp, eventId, ipHash)
      .run();
  } catch (err) {
    console.error("enrich failed", err && err.message);
  }
}

// Columns added after the table was first created. D1 has no
// "ADD COLUMN IF NOT EXISTS", and the deploy applies schema.sql on every push,
// so a failing ALTER there would break deploys forever. Migrating lazily from
// the Worker instead is idempotent and cannot take the deploy down. Runs at
// most once per isolate.
const LATE_COLUMNS = [
  ["event_id", "ALTER TABLE visits ADD COLUMN event_id TEXT"],
  ["dnt", "ALTER TABLE visits ADD COLUMN dnt INTEGER NOT NULL DEFAULT 0"],
  ["transport", "ALTER TABLE visits ADD COLUMN transport TEXT"],
  ["origin_missing", "ALTER TABLE visits ADD COLUMN origin_missing INTEGER NOT NULL DEFAULT 0"],
  ["client_ip", "ALTER TABLE visits ADD COLUMN client_ip TEXT"],
  ["origin_host", "ALTER TABLE visits ADD COLUMN origin_host TEXT"],
  ["client_tz", "ALTER TABLE visits ADD COLUMN client_tz TEXT"],
  ["tz_offset", "ALTER TABLE visits ADD COLUMN tz_offset INTEGER"],
  ["queued_ms", "ALTER TABLE visits ADD COLUMN queued_ms INTEGER"],
  ["failovers", "ALTER TABLE visits ADD COLUMN failovers INTEGER NOT NULL DEFAULT 0"],
  ["latency_ms", "ALTER TABLE visits ADD COLUMN latency_ms INTEGER"],
];
let migration = null;

function migrate(env) {
  if (!migration) migration = runMigration(env).catch((err) => {
    migration = null; // let the next request retry
    throw err;
  });
  return migration;
}

async function runMigration(env) {
  // If the PRAGMA is unavailable for any reason, fall through with an empty set
  // and let the duplicate-column check below do the work instead.
  let have = new Set();
  try {
    const info = await env.DB.prepare("PRAGMA table_info(visits)").all();
    have = new Set((info.results || []).map((c) => c.name));
  } catch (err) {
    console.error("table_info failed, attempting the ALTERs blind", err && err.message);
  }
  for (const [name, sql] of LATE_COLUMNS) {
    if (have.has(name)) continue;
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      // Another isolate may have won the race; only a genuine failure matters.
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  // Scoped to (event_id, ip_hash): every transport of one pageview comes from
  // the same client, so de-duplication is unaffected, but an id planted by
  // someone else can no longer collide with — and silently discard — a real
  // client's row.
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_event ON visits (event_id, ip_hash) WHERE event_id IS NOT NULL"
  ).run();
}

const BASE_COLS =
  `ts, ip, ip_hash, country, region, city, postal, latitude, longitude,
   timezone, asn, as_org, colo, path, title, referrer, user_agent, lang,
   screen, visitor_id, is_new, is_bot`;

const baseBinds = (r) => [
  r.ts, r.ip, r.ip_hash, r.country, r.region, r.city, r.postal,
  r.latitude, r.longitude, r.timezone, r.asn, r.as_org, r.colo,
  r.path, r.title, r.referrer, r.user_agent, r.lang, r.screen,
  r.visitor_id, r.is_new, r.is_bot,
];

// Everything the lazy migration adds. Kept next to LATE_COLUMNS so the INSERT
// and the ALTERs cannot drift apart.
const LATE_COLS =
  "event_id, dnt, transport, origin_missing, client_ip, origin_host, " +
  "client_tz, tz_offset, queued_ms, failovers, latency_ms";
const lateBinds = (r) => [
  r.event_id, r.dnt, r.transport, r.origin_missing, r.client_ip, r.origin_host,
  r.client_tz, r.tz_offset, r.queued_ms, r.failovers, r.latency_ms,
];

const marks = (n) => new Array(n).fill("?").join(",");

async function insert(env, r) {
  try {
    await migrate(env);
    // A replay from the browser's queue is the one hit that can arrive on a
    // different network than the request it describes — that is the entire point
    // of it — and a different network means a different ip_hash. The unique
    // index is scoped to (event_id, ip_hash), so it would not recognise the
    // copy, and nothing else about the two rows matches either.
    //
    // This is not hypothetical: a client that bounces has its pageview parked
    // on `pagehide` while the keepalive fetch is still in flight, and that fetch
    // routinely completes after the tab is gone — with no page left to clear the
    // parked copy. Without this the next pageview would replay a hit that had
    // already landed, and on a new address it would count twice.
    //
    // So a replay is admitted only if its id is not already on record, on any
    // network. That is a weaker key than the live path uses, deliberately:
    // suppressing someone else's row would mean guessing their 128-bit random
    // id, while double-counting every fast bounce is otherwise a certainty.
    if (r.queued_ms && r.event_id) {
      const binds = [...baseBinds(r), ...lateBinds(r)];
      await env.DB.prepare(
        `INSERT INTO visits (${BASE_COLS}, ${LATE_COLS})
         SELECT ${marks(binds.length)}
          WHERE NOT EXISTS (SELECT 1 FROM visits WHERE event_id = ?)`
      )
        .bind(...binds, r.event_id)
        .run();
      return;
    }
    // OR IGNORE plus the unique index on (event_id, ip_hash) is what makes it
    // safe to fire several transports for one pageview: whichever arrives first
    // wins and the rest collapse into it.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO visits (${BASE_COLS}, ${LATE_COLS})
       VALUES (${marks(baseBinds(r).length + lateBinds(r).length)})`
    )
      .bind(...baseBinds(r), ...lateBinds(r))
      .run();
    return;
  } catch (err) {
    console.error("insert failed", err && err.message, JSON.stringify({
      path: r.path, transport: r.transport, dnt: r.dnt,
    }));
  }

  // Losing a request is the failure this whole rewrite exists to stop, so if the
  // migration or the new columns are the problem, fall back to the columns the
  // table has always had rather than dropping the row.
  try {
    await env.DB.prepare(
      `INSERT INTO visits (${BASE_COLS}) VALUES (${marks(baseBinds(r).length)})`
    )
      .bind(...baseBinds(r))
      .run();
    console.error("stored without the added columns");
  } catch (err) {
    console.error("legacy insert failed too", err && err.message);
  }
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

// Opt-out and unverified rows are held out of every "trusted" figure. Opt-outs
// hold no address and their ip_hash is a country/day bucket, so counting them
// would corrupt every unique figure; unverified rows are real measurements but
// come from requests nobody can attribute to this site, so mixing them into the
// rankings would let anyone move a number. Each group gets its own tile, its
// own table and its own colour on the map instead.
const TRUSTED = "AND dnt = 0 AND origin_missing = 0";

async function collect(env, url) {
  // The dashboard can be the first thing to touch a freshly deployed Worker,
  // before any hit has run the lazy migration.
  await migrate(env);

  const days = parseRange(url.searchParams.get("days"));
  const since = days === 0 ? 0 : Date.now() - days * 86400000;
  const bots = url.searchParams.get("bots") === "1";
  const botFilter = (bots ? "" : "AND is_bot = 0") + " " + TRUSTED;
  const dayStart = new Date().setUTCHours(0, 0, 0, 0);
  // Previous window of the same length, for the movement figure on each tile.
  // Meaningless for "All time", where there is nothing before the range.
  const prevSince = days === 0 ? 0 : since - days * 86400000;
  const prevUntil = days === 0 ? 0 : since;

  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const top = (expr, alias, extra = "") =>
    q(
      `SELECT ${expr} AS k, COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u
         FROM visits WHERE ts >= ? ${botFilter} ${extra}
          AND ${alias} IS NOT NULL AND ${alias} != ''
        GROUP BY k ORDER BY c DESC LIMIT 12`,
      since
    );

  // A replayed pageview reached us over whatever network eventually worked, so
  // its country, city and ASN describe that route and not where the request was
  // made. Counting them would file a request under the country it was finally
  // relayed through — the misattribution this whole feature exists to stop. They
  // keep their place in views, uniques and pages; only the claims about WHERE
  // are withheld, and the Restricted tab reports them on their own terms.
  // A row whose browser clock contradicts its address: the address is a VPN
  // exit, a mirror or a proxy, and the request started elsewhere.
  const RELAYED =
    "client_tz IS NOT NULL AND client_tz != '' AND " +
    "timezone IS NOT NULL AND timezone != '' AND client_tz != timezone";
  // None of these expressions can be NULL, so NOT(...) is safe here.
  const LOCATED = `AND queued_ms IS NULL AND NOT (${RELAYED})`;

  const [
    summary, prev, botCount, today, series, countries, cities, pages, referrers,
    networks, ips, recent, lifetime, optouts, optoutCountries, transports,
    points, tzPoints, unverified, unverifiedIps, proxied, proxiedTotal,
    relayed, relayedTotal, recovered, recoveredRows, failoverTotal, sendLatency,
  ] = await env.DB.batch([
      // Must carry botFilter, otherwise the headline numbers silently include
      // the traffic the dashboard claims to be filtering out.
      q(
        `SELECT COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS uniques,
                COUNT(DISTINCT country) AS countries
           FROM visits WHERE ts >= ? ${botFilter}`,
        since
      ),
      q(
        `SELECT COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS uniques,
                COUNT(DISTINCT country) AS countries
           FROM visits WHERE ts >= ? AND ts < ? ${botFilter}`,
        prevSince, prevUntil
      ),
      // Always unfiltered — this is the count of what the filter removed.
      q(
        `SELECT SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) AS bots
           FROM visits WHERE ts >= ?`,
        since
      ),
      q(
        `SELECT COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS uniques
           FROM visits WHERE ts >= ? ${botFilter}`,
        dayStart
      ),
      q(
        `SELECT date(ts / 1000, 'unixepoch') AS d, COUNT(*) AS c,
                COUNT(DISTINCT ip_hash) AS u
           FROM visits WHERE ts >= ? ${botFilter}
          GROUP BY d ORDER BY d`,
        since
      ),
      top("country", "country", LOCATED),
      top("city || ', ' || COALESCE(country, '??')", "city", LOCATED),
      top("path", "path"),
      top("referrer", "referrer"),
      top("'AS' || asn || ' · ' || COALESCE(as_org, '?')", "asn", LOCATED),
      q(
        `SELECT ip, COUNT(*) AS c, MAX(ts) AS last_ts,
                MAX(country) AS country, MAX(city) AS city, MAX(as_org) AS as_org,
                MAX(client_ip) AS client_ip
           FROM visits WHERE ts >= ? ${botFilter} AND ip IS NOT NULL
          GROUP BY ip ORDER BY c DESC, last_ts DESC LIMIT 25`,
        since
      ),
      q(
        `SELECT ts, ip, client_ip, country, region, city, as_org, path, referrer,
                user_agent, is_bot, transport
           FROM visits WHERE ts >= ? ${botFilter}
          ORDER BY ts DESC LIMIT 60`,
        since
      ),
      // Unfiltered, so the header can show when collection actually started.
      q(`SELECT MIN(ts) AS first_ts, COUNT(*) AS views FROM visits`),
      // The groups of rows that used to be invisible.
      q(
        `SELECT SUM(CASE WHEN dnt = 1 AND origin_missing = 0 THEN 1 ELSE 0 END) AS hits,
                COUNT(DISTINCT CASE WHEN dnt = 1 AND origin_missing = 0 THEN country END)
                  AS countries,
                SUM(CASE WHEN origin_missing = 1 THEN 1 ELSE 0 END) AS no_origin
           FROM visits WHERE ts >= ?`,
        since
      ),
      q(
        `SELECT country AS k, COUNT(*) AS c, 0 AS u
           FROM visits
          WHERE ts >= ? AND dnt = 1 AND origin_missing = 0 AND country IS NOT NULL
          GROUP BY k ORDER BY c DESC LIMIT 12`,
        since
      ),
      // Deliberately NOT filtered to trusted rows. Transport is a fact about
      // the network, not a traffic metric, and the unverified rows are the
      // ones that arrived by pixel — hiding them here would hide the single
      // clearest sign that the primary transport is failing to connect.
      q(
        `SELECT COALESCE(transport, '?') AS k, COUNT(*) AS c,
                COUNT(DISTINCT ip_hash) AS u
           FROM visits WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"} AND dnt = 0
          GROUP BY k ORDER BY c DESC LIMIT 12`,
        since
      ),
      // Map points. Bucketed to 0.1 degrees (~11 km), which is finer than the
      // city-level precision Cloudflare hands out anyway, so nothing is lost by
      // collapsing them. Unverified hits are included but counted separately,
      // so the map can show them in their own colour rather than either dropping
      // them entirely or quietly passing their traffic off as verified.
      q(
        `SELECT ROUND(CAST(latitude AS REAL), 1) AS lat,
                ROUND(CAST(longitude AS REAL), 1) AS lon,
                COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u, MAX(ts) AS last_ts,
                MAX(city) AS city, MAX(region) AS region, MAX(country) AS country,
                SUM(origin_missing) AS unverified
           FROM visits
          WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"} AND dnt = 0 ${LOCATED}
            AND latitude IS NOT NULL AND longitude IS NOT NULL
            AND latitude != '' AND longitude != ''
          GROUP BY lat, lon ORDER BY c DESC LIMIT 400`,
        since
      ),
      // The same rows again, but to be drawn where the request was made rather
      // than where it came out. Grouped by the browser's own zone, which for a
      // replayed hit is the only locator left and for a relayed one is the only
      // truthful one. These rows are held out of the address-derived points
      // above, so nothing is plotted twice.
      q(
        `SELECT client_tz AS tz, COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u,
                MAX(ts) AS last_ts,
                SUM(CASE WHEN queued_ms IS NOT NULL THEN 1 ELSE 0 END) AS recovered,
                SUM(origin_missing) AS unverified,
                COUNT(DISTINCT country) AS exits
           FROM visits
          WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"} AND dnt = 0
            AND client_tz IS NOT NULL AND client_tz != ''
            AND (queued_ms IS NOT NULL OR (${RELAYED}))
          GROUP BY tz ORDER BY c DESC LIMIT 200`,
        since
      ),
      // The unattributed rows, on their own terms.
      q(
        `SELECT COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS uniques,
                COUNT(DISTINCT country) AS countries,
                SUM(CASE WHEN ip IS NOT NULL THEN 1 ELSE 0 END) AS with_ip
           FROM visits WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"}
            AND dnt = 0 AND origin_missing = 1`,
        since
      ),
      q(
        `SELECT ip, COUNT(*) AS c, MAX(ts) AS last_ts, MAX(country) AS country,
                MAX(city) AS city, MAX(as_org) AS as_org, MAX(client_ip) AS client_ip
           FROM visits
          WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"}
            AND dnt = 0 AND origin_missing = 1 AND ip IS NOT NULL
          GROUP BY ip ORDER BY c DESC, last_ts DESC LIMIT 25`,
        since
      ),
      // Hits where the browser found a different address for itself than the
      // one that reached the edge: a mirror, a proxy or a VPN in between.
      q(
        `SELECT ip, client_ip, COUNT(*) AS c, MAX(ts) AS last_ts,
                MAX(country) AS country, MAX(city) AS city, MAX(as_org) AS as_org,
                MAX(origin_host) AS origin_host, MAX(origin_missing) AS unverified
           FROM visits
          WHERE ts >= ? AND dnt = 0 AND client_ip IS NOT NULL
          GROUP BY ip, client_ip ORDER BY c DESC, last_ts DESC LIMIT 25`,
        since
      ),
      // The table above is capped at 25 rows, so the tile cannot count it.
      q(
        `SELECT COUNT(*) AS hits, COUNT(DISTINCT client_ip) AS addresses
           FROM visits WHERE ts >= ? AND dnt = 0 AND client_ip IS NOT NULL`,
        since
      ),
      // Requests whose browser reports one timezone while their address
      // resolves to another. `timezone` is Cloudflare's guess from the
      // connecting address, so it describes the VPN exit, the mirror or the
      // proxy; `client_tz` is the client's own clock. A row where the two
      // disagree was made somewhere other than where it comes out — which is the
      // only shape a request can have when the endpoint is not reachable
      // directly from where it started.
      q(
        `SELECT client_tz AS k, timezone AS ip_tz, COUNT(*) AS c,
                COUNT(DISTINCT ip_hash) AS u, MAX(ts) AS last_ts,
                MAX(country) AS country, MAX(city) AS city, MAX(as_org) AS as_org,
                SUM(origin_missing) AS unverified,
                SUM(CASE WHEN queued_ms IS NOT NULL THEN 1 ELSE 0 END) AS queued
           FROM visits
          WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"} AND dnt = 0
            AND client_tz IS NOT NULL AND client_tz != ''
            AND timezone IS NOT NULL AND timezone != ''
            AND client_tz != timezone
          GROUP BY k, ip_tz ORDER BY c DESC, last_ts DESC LIMIT 25`,
        since
      ),
      q(
        `SELECT COUNT(*) AS hits, COUNT(DISTINCT ip_hash) AS uniques,
                COUNT(DISTINCT client_tz) AS zones
           FROM visits
          WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"} AND dnt = 0
            AND client_tz IS NOT NULL AND client_tz != ''
            AND timezone IS NOT NULL AND timezone != ''
            AND client_tz != timezone`,
        since
      ),
      // Pageviews no endpoint could deliver when they happened, replayed from
      // the browser's queue later. `ts` is the moment of the visit, not of the
      // delivery, so these land in the window they belong to.
      q(
        `SELECT COUNT(*) AS hits, COUNT(DISTINCT ip_hash) AS uniques,
                MAX(queued_ms) AS longest
           FROM visits WHERE ts >= ? AND queued_ms IS NOT NULL`,
        since
      ),
      q(
        `SELECT ts, queued_ms, client_tz, timezone, country, city, as_org,
                ip, client_ip, path, transport, origin_missing, failovers
           FROM visits WHERE ts >= ? AND queued_ms IS NOT NULL
          ORDER BY ts DESC LIMIT 25`,
        since
      ),
      // What delivery actually cost. `transport` says which one carried the
      // hit; this says how many had to fail first, which is what shows a host
      // degrading before it disappears entirely.
      q(
        `SELECT SUM(CASE WHEN failovers > 0 THEN 1 ELSE 0 END) AS hits,
                MAX(failovers) AS worst, COUNT(*) AS total
           FROM visits WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"} AND dnt = 0`,
        since
      ),
      // How long each pageview took to reach the network, as the page itself
      // measured it. This is the figure the send path is built around: a
      // visitor who closes the tab before their hit is dispatched is a visitor
      // who is never counted at all, so a regression here does not show up as
      // an error, it shows up as quietly fewer people. Replays are excluded —
      // their latency belongs to the original pageview, not to this delivery.
      q(
        `SELECT COUNT(*) AS n,
                MAX(CASE WHEN pct <= 0.50 THEN latency_ms END) AS p50,
                MAX(CASE WHEN pct <= 0.95 THEN latency_ms END) AS p95,
                MAX(latency_ms) AS worst,
                SUM(CASE WHEN latency_ms <= 1000 THEN 1 ELSE 0 END) AS under1s
           FROM (SELECT latency_ms, CUME_DIST() OVER (ORDER BY latency_ms) AS pct
                   FROM visits
                  WHERE ts >= ? ${bots ? "" : "AND is_bot = 0"} AND dnt = 0
                    AND queued_ms IS NULL AND latency_ms IS NOT NULL)`,
        since
      ),
    ]);

  return {
    range: { days, since, bots },
    lifetime: lifetime.results[0] || {},
    summary: { ...(summary.results[0] || {}), ...(botCount.results[0] || {}) },
    previous: prev.results[0] || {},
    today: today.results[0] || {},
    series: series.results,
    countries: countries.results,
    cities: cities.results,
    pages: pages.results,
    referrers: referrers.results,
    networks: networks.results,
    ips: ips.results,
    recent: recent.results,
    optouts: optouts.results[0] || {},
    optoutCountries: optoutCountries.results,
    transports: transports.results,
    points: points.results,
    tzPoints: tzPoints.results,
    unverified: unverified.results[0] || {},
    unverifiedIps: unverifiedIps.results,
    proxied: proxied.results,
    proxiedTotal: proxiedTotal.results[0] || {},
    relayed: relayed.results,
    relayedTotal: relayedTotal.results[0] || {},
    recovered: recovered.results[0] || {},
    recoveredRows: recoveredRows.results,
    failoverTotal: failoverTotal.results[0] || {},
    sendLatency: sendLatency.results[0] || {},
  };
}

async function handleStatsJson(env, url) {
  const data = await collect(env, url);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleExport(env, url) {
  await migrate(env);
  const days = parseRange(url.searchParams.get("days"));
  const since = days === 0 ? 0 : Date.now() - days * 86400000;
  const { results } = await env.DB.prepare(
    `SELECT ts, ip, client_ip, country, region, city, postal, latitude, longitude,
            timezone, asn, as_org, colo, path, title, referrer, lang, screen,
            visitor_id, is_new, is_bot, dnt, transport, origin_missing,
            origin_host, client_tz, tz_offset, queued_ms, failovers, latency_ms,
            user_agent
       FROM visits WHERE ts >= ? ORDER BY ts DESC LIMIT 50000`
  )
    .bind(since)
    .all();

  const cols = results.length ? Object.keys(results[0]) : ["ts"];
  // Quoting alone does not stop a spreadsheet evaluating a field that starts
  // with =, +, -, @, TAB or CR as a formula, and several of these columns hold
  // text supplied by the client.
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const raw = String(v);
    const safe = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const body = [
    ["datetime_utc", ...cols].join(","),
    ...results.map((r) => [esc(new Date(r.ts).toISOString()), ...cols.map((c) => esc(r[c]))].join(",")),
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="visits-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

// The map is drawn from a land mask baked into this file, not from tiles.
//
// A tile basemap was the obvious first choice and it is the wrong one here.
// Every keyless raster provider left has either started stamping "API KEY
// REQUIRED" across the imagery (CARTO) or blocks unattended clients under its
// usage policy (openstreetmap.org), so a tiled dashboard is one silent
// provider change away from showing nothing — and it would drag a CDN script
// and a tile host into a page whose whole job is to be readable at a glance.
//
// This mask is 360x144 one-degree cells covering 180W..180E and 84N..60S, one
// bit per cell, packed row-major MSB-first and base64'd: 6,480 bytes for a
// world map that needs no network at all and renders identically offline.
// Derived from Natural Earth 110m land (public domain, naturalearthdata.com)
// by scanline-filling each polygon ring at cell-centre latitudes.
const MAP_W = 360, MAP_H = 144, MAP_LAT_TOP = 84, MAP_LAT_BOTTOM = -60;
const WORLD_MASK =
  "AAAAAAAAAAAAAAAAAAAAAAAH/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH///+AAf///4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD////n//////3/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/gf/7////////wAAAAAfgAAD4AAAAAAf4AAAAAAAAAAAAAAAAAAAAAAAAAAA///+A////////AAAAD/3wAAAAAAAAAAH+AAAAAAAAAAAAAAAAAAAAAAAAcH3v//5////////+AAAAA/gAAAAAAAAAAAAD8AAAAAAAAAAAAAAAAAAAAAA8YAAQP/AH///////+AAAAAPCAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAD4HAd//+AP///////4AAAAAAAAAAAAAD4AAAAD/+AAAAAAAAAAAAAAAAAAAAAP/4e3/8AAAf/////+AAAAAAAAAAAAH8AAAB////AAAB/wAAAAAAAAAAAAAAAA4AAA/YAAAP/////+AAAAAAAAAAAAfAAAAP///4AAAAAAAAAAAAAAAAAAAAf+Ac++c/gAAD/////8AAAAAAAAAAAA8AAAP/////+HwAPAAAAAAAAAAAAAAA///5/4/9wAAB/////wAAAAAAAAAAADwAPsP///////4AfwAAAAAwAAAAAAAAf//8O4//9AAD/////wAAAAAAAAAAAHwAff////////9///gAAABAAAf/gAAAAA//B+f//8AB////+gAAAAAAB/wAAAAA/v/////////////8AAAAAD///+H//H//PfDwf+AB3////AAAAAAA//8AAAA8/////////////////P8wAf////////B4Gfz4H8AAf///4AAAAAAD///4YDH/3//////////////////+AH/////////////45/wA///4AAAAAAAP///+c////v//////////////////8H/////////////gD/8A///wAAYAAAAf//9+P///////////////////////4/////////////+AH+4Af/4AA/8AAAB/8f+H///////////////////////BwP/////////////5//gAf/wAAf8AAAD/9/+///////////////////////8AOB////////////DMB/wAP/gAABAAAAP/3/////////////////////////+AAP///////////8AwgPAAH/AAAAAAAB//H//////////////////////////AAf///////////4AA/gAAD/AAAAAAAB//H//////////////////////3//AAAP//3////////wAA/4AAAOAAAAAAAB//n//////////////////////A/8AAAA/7AD///////wAA/44AAAAAAAAAAB//g7////////////////////eDwAAAAAP4AA///////4AB/98AAAAAAAAA4B5+B///////////////////8AAPgAAAAADcAAD//////8AAf/+AAAAAAAAA8AH+G///////////////////wAA/wAAAAAMAAAB///////wAf/+AAAAAAAAA8AO+H///////////////////gAB/wAAAABwAAAA///////+A///AAAAAAAAA+AP4H//////////////////+AAB/AAAAAEAAAAAf///////z///4AAAAAAAHvAOD///////////////////+AAB+AAAAAAAAAADv///////x///8AAAAAAAPPg//////////////////////6AB+AAAAAAAAAAAn///////5///+AAAAAAAPfz///////////////////////AA4AAAAAAAAAAAD///////////+AAAAAAAAf3///////////////////////AAwAAAAAAAAAAAG///////////sAAAAAAAA4f//////////////////////7AAAAAAAAAAAAAAB/////////+MfAAAAAAAAD///////////////////////7gAAAAAAAAAAAAAAf/////////w/gAAAAAAAf///////////////////////+AAAAAAAAAAAAAAAf/////////wDwAAAAAAAH///////////////////////2AAAAAAAAAAAAAAAf/////////5AAAAAAAAAD//////f/x//////////////nAAAAAAAAAAAAAAAP//////////AAAAAAAAAD/////Pf/B//////////////GAAAAAAAAAAAAAAAf/////////4AAAAAAAAAD//n/+GP+P/////////////+HAAAAAAAAAAAAAAAf////////wAAAAAAAAAHz/zz/+AH/H/////////////4HwAAAAAAAAAAAAAAf////////wAAAAAAAAAH/4N4/8AB/D////////////+AfAAAAAAAAAAAAAAAf////////wAAAAAAAAAH/4M8f+fh/i////////////8AAAAAAAAAAAAAAAAAf///////8AAAAAAAAAAH/gMP/L///7///////////v8AcAAAAAAAAAAAAAAAP///////8AAAAAAAAAAP/AMHPP///x///////////ZwAMAAAAAAAAAAAAAAAP///////4AAAAAAAAAAP/AAGPP///h//////////8D4AcAAAAAAAAAAAAAAAH///////4AAAAAAAAAAH+AA8HH///x//////////+w8A4AAAAAAAAAAAAAAAD///////4AAAAAAAAAABwf+ADB+//////////////g8D4AAAAAAAAAAAAAAAD///////4AAAAAAAAAABz/+ABgD//////////////A8f4AAAAAAAAAAAAAAAB///////gAAAAAAAAAAB//+AAAB//////////////Ax/AAAAAAAAAAAAAAAAAP/////+AAAAAAAAAAAH//+AAAB//////////////gD8AAAAAAAAAAAAAAAAAP/////8AAAAAAAAAAAP///4PAD//////////////wDAAAAAAAAAAAAAAAAAAH/////4AAAAAAAAAAAP///8f4z//////////////wDAAAAAAAAAAAAAAAAAAH/////4AAAAAAAAAAAP/////////////////////wAAAAAAAAAAAAAAAAAAADf//zg4AAAAAAAAAAAP/////////v///////////4AAAAAAAAAAAAAAAAAAABv//AAcAAAAAAAAAAA//////////n///////////wAAAAAAAAAAAAAAAAAAAB3/+AAcAAAAAAAAAAD///////9//z///////////gAAAAAAAAAAAAAAAAAAAA7/+AAdgAAAAAAAAAD///////8//4n//////////gAAAAAAAAAAAAAAAAAAAAb/+AAMAAAAAAAAAAH///////+//8Z//////////AAAAAAAAAAAAAAAAAAAAAM/+AABgAAAAAAAAAP////////f/84Af///////+wAAAAAAAAAAAAAAAAAAAAGf+AAAAAAAAAAAAAf////////P//+AP///////8wAAAAAAAAAAAAAAAAAAAAAP+AB/AAAAAAAAAAf////////n///AH///////gwAAAAAAAAAAAAGAAAAAAAAP+AIBwAAAAAAAAA/////////3///AH//8P//cAAAAAAAAAAAAAAAAAAAAAAAP+B4A8AAAAAAAAAf////////3//+AA//4P/+YAAAAAAAAAAAAAAAwAAAAAAAP/B4AB4AAAAAAAAf////////z//8AA//wH/84AAAAAAAAAAAAAAAAAAAAAAAD/34An/AAAAAAAAf////////x//4AA//gD/+4AwAAAAAAAAAAAAAAAAAAAAAA//wAAAAAAAAAAAf////////4//wAAf+AD/+AA4AAAAAAAAAAAAAAAAAAAAAAH/wAAAAAAAAAAAf////////8/+AAAf+AD//AA4AAAAAAAAAAAAAAAAAAAAAAAP/gAAAAAAAAAAf////////8/8AAAf4AAf/gBwAAAAAAAAAAAAAAAAAAAAAAAH/gAAAAAAAAAA///////////wAAAP4AAf/wAwAAAAAAAAAAAAAAAAAAAAAAAA/gAAAAAAAAAAf//////////AAAAP4AAP/wAMAAAAAAAAAAAAAAAAAAAAAAAAPgAAAAAAAAAAf/////////wAAAAP4AAP/wATAAAAAAAAAAAAAAAAAAAAAAAAHgB4AAAAAAAAP/////////wcAAAHwAAM/gAPAAAAAAAAAAAAAAAAAAAAAAAADgP/fAAAAAAAH//////////4AAADwAAMPABfAAAAAAAAAAAAAAAAAAAAAAAAByP/+AAAAAAAD//////////4AAADoAAMOACNAAAAAAAAAAAAAAAAAAAAAAAAA////gAAAAAAD//////////4AAAD8AAOAAEHgAAAAAAAAAAAAAAAAAAAAAAAAF///wAAAAAAB//////////wAAAAcAAGAAAPgAAAAAAAAAAAAAAAAAAAAAAAAA///4AAAAAAA//////////wAAAAMAADAAMDgAAAAAAAAAAAAAAAAAAAAAAAAA////gAAAAAAP/B///////gAAAAAAADgAeAAAAAAAAAAAAAAAAAAAAAAAAAAA////4AAAAAAGAB///////AAAAAAAB7wA+AAAAAAAAAAAAAAAAAAAAAAAAAAA////4AAAAAAAAAH//////AAAAAAAA9wB8AAAAAAAAAAAAAAAAAAAAAAAAAAB////8AAAAAAAAAH/////+AAAAAAAAfwH8AAAAAAAAAAAAAAAAAAAAAAAAAAB////+AAAAAAAAAH/////4AAAAAAAAP4f+DYAAAAAAAAAAAAAAAAAAAAAAAAH////8AAAAAAAAAH/////wAAAAAAAAHw/8+YAAAAAAAAAAAAAAAAAAAAAAAAH/////AAAAAAAAAH/////gAAAAAAAAHwf9gYgAAAAAAAAAAAAAAAAAAAAAAAH/////4AAAAAAAAH/////AAAAAAAAAD4f54B4AAAAAAAAAAAAAAAAAAAAAAAH//////AAAAAAAAH////+AAAAAAAAAB8P7wA74AAAAAAAAAAAAAAAAAAAAAAH//////8AAAAAAAD////8AAAAAAAAAA+A54y//AIAAAAAAAAAAAAAAAAAAAAP//////+AAAAAAAB////8AAAAAAAAAAcAB8AH/wcAAAAAAAAAAAAAAAAAAAAP///////gAAAAAAA////4AAAAAAAAAAMABoAJ/7yAAAAAAAAAAAAAAAAAAAAH///////wAAAAAAA////4AAAAAAAAAAHoAAAI/8BAAAAAAAAAAAAAAAAAAAAD///////wAAAAAAA////8AAAAAAAAAAB+AAAA/8AIAAAAAAAAAAAAAAAAAAAB///////gAAAAAAAf///8AAAAAAAAAAAB35wAPOAHAAAAAAAAAAAAAAAAAAAB///////gAAAAAAAf///8AAAAAAAAAAAABmAAAHAHAAAAAAAAAAAAAAAAAAAB///////AAAAAAAAf///+AAAAAAAAAAAAAAAAABgBgAAAAAAAAAAAAAAAAAAA//////+AAAAAAAAf///+AAAAAAAAAAAAAAAwCAAAAAAAAAAAAAAAAAAAAAAAf/////+AAAAAAAAf///+AwAAAAAAAAAAAAD+HAAAAAAAAAAAAAAAAAAAAAAAf/////8AAAAAAAA////+A4AAAAAAAAAAAAD+HAAAAAAAAAAAAAAAAAAAAAAAf/////8AAAAAAAA////+B4AAAAAAAAAAAB/8HgAAAAAAAAAAAAAAAAAAAAAAH/////8AAAAAAAB////+D4AAAAAAAAAAAD/+HwAADAAgAAAAAAAAAAAAAAAAD/////4AAAAAAAB////8PwAAAAAAAAAAAP//HwAABADAAAAAAAAAAAAAAAAAA/////4AAAAAAAB////wfwAAAAAAAAAAAP///4AAAAGAAAAAAAAAAAAAAAAAAf////4AAAAAAAA////gPwAAAAAAAAAAAf///4AAAAAAAAAAAAAAAAAAAAAAAf////4AAAAAAAA////APgAAAAAAAAAAAf///8AAAAAAAAAAAAAAAAAAAAAAAf////wAAAAAAAAf//+APgAAAAAAAAAAH////+AAMAAAAAAAAAAAAAAAAAAAAf////wAAAAAAAAf///AfgAAAAAAAAAAf/////AAGAAAAAAAAAAAAAAAAAAAAf////gAAAAAAAAP///AfAAAAAAAAAAB//////gAAAAAAAAAAAAAAAAAAAAAAf///8AAAAAAAAAP///AfAAAAAAAAAAB//////gAAAAAAAAAAAAAAAAAAAAAAf///gAAAAAAAAAP//+AfAAAAAAAAAAB//////4AAAAAAAAAAAAAAAAAAAAAAf///AAAAAAAAAAP//4AEAAAAAAAAAAA//////4AAAAAAAAAAAAAAAAAAAAAAf///AAAAAAAAAAH//4AAAAAAAAAAAAB//////8AAAAAAAAAAAAAAAAAAAAAAf///AAAAAAAAAAH//4AAAAAAAAAAAAA//////8AAAAAAAAAAAAAAAAAAAAAA////AAAAAAAAAAD//4AAAAAAAAAAAAA//////8AAAAAAAAAAAAAAAAAAAAAA///+AAAAAAAAAAD//wAAAAAAAAAAAAAf/////8AAAAAAAAAAAAAAAAAAAAAA///8AAAAAAAAAAB//gAAAAAAAAAAAAAf/////8AAAAAAAAAAAAAAAAAAAAAA///4AAAAAAAAAAA//AAAAAAAAAAAAAAf/////4AAAAAAAAAAAAAAAAAAAAAA///wAAAAAAAAAAA/+AAAAAAAAAAAAAAf/AP//4AAAAAAAAAAAAAAAAAAAAAA///gAAAAAAAAAAA/4AAAAAAAAAAAAAAf+AP//wAAAAAAAAAAAAAAAAAAAAAB//3AAAAAAAAAAAAYAAAAAAAAAAAAAAAfAAH//gAADAAAAAAAAAAAAAAAAAAB//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//gAABgAAAAAAAAAAAAAAAAAB//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/gAAAgAAAAAAAAAAAAAAAAAD//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/AAAAwAAAAAAAAAAAAAAAAAD//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADcAAAA+AAAAAAAAAAAAAAAAAD/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAAAAAD/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACYAAAAAAAAAAAAAAAAAD/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+AAAHwAAAAAAAAAAAAAAAAAH/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAAAHAAAAAAAAAAAAAAAAAAB/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAeAAAAAAAAAAAAAAAAAAH/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAAAAAAH+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AAAAAAAAAAAAAAAAAAP+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAH/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP+AAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8B4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Where a timezone is, so a request whose browser clock contradicts its address
// can be drawn where it started rather than where it came out. Cloudflare's
// geolocation describes the VPN exit; the browser's IANA zone describes the
// origin. Without this the map can only show the exit.
//
// Derived from the IANA tzdb `zone.tab` (public domain), one line per zone as
// "zone|lat|lon|CC", plus the handful of legacy aliases browsers still emit
// (Asia/Calcutta, Hongkong, ROK, Singapore...). A zone is a region, not a
// point, so the coordinate is tzdb's principal city — accurate to the country
// and no further, which is exactly the precision claimed for it.
const TZ_TABLE = `
Africa/Abidjan|5.32|-4.03|CI
Africa/Accra|5.55|-0.22|GH
Africa/Addis_Ababa|9.03|38.7|ET
Africa/Algiers|36.78|3.05|DZ
Africa/Asmara|15.33|38.88|ER
Africa/Bamako|12.65|-8.0|ML
Africa/Bangui|4.37|18.58|CF
Africa/Banjul|13.47|-16.65|GM
Africa/Bissau|11.85|-15.58|GW
Africa/Blantyre|-15.78|35.0|MW
Africa/Brazzaville|-4.27|15.28|CG
Africa/Bujumbura|-3.38|29.37|BI
Africa/Cairo|30.05|31.25|EG
Africa/Casablanca|33.65|-7.58|MA
Africa/Ceuta|35.88|-5.32|ES
Africa/Conakry|9.52|-13.72|GN
Africa/Dakar|14.67|-17.43|SN
Africa/Dar_es_Salaam|-6.8|39.28|TZ
Africa/Djibouti|11.6|43.15|DJ
Africa/Douala|4.05|9.7|CM
Africa/El_Aaiun|27.15|-13.2|EH
Africa/Freetown|8.5|-13.25|SL
Africa/Gaborone|-24.65|25.92|BW
Africa/Harare|-17.83|31.05|ZW
Africa/Johannesburg|-26.25|28.0|ZA
Africa/Juba|4.85|31.62|SS
Africa/Kampala|0.32|32.42|UG
Africa/Khartoum|15.6|32.53|SD
Africa/Kigali|-1.95|30.07|RW
Africa/Kinshasa|-4.3|15.3|CD
Africa/Lagos|6.45|3.4|NG
Africa/Libreville|0.38|9.45|GA
Africa/Lome|6.13|1.22|TG
Africa/Luanda|-8.8|13.23|AO
Africa/Lubumbashi|-11.67|27.47|CD
Africa/Lusaka|-15.42|28.28|ZM
Africa/Malabo|3.75|8.78|GQ
Africa/Maputo|-25.97|32.58|MZ
Africa/Maseru|-29.47|27.5|LS
Africa/Mbabane|-26.3|31.1|SZ
Africa/Mogadishu|2.07|45.37|SO
Africa/Monrovia|6.3|-10.78|LR
Africa/Nairobi|-1.28|36.82|KE
Africa/Ndjamena|12.12|15.05|TD
Africa/Niamey|13.52|2.12|NE
Africa/Nouakchott|18.1|-15.95|MR
Africa/Ouagadougou|12.37|-1.52|BF
Africa/Porto-Novo|6.48|2.62|BJ
Africa/Sao_Tome|0.33|6.73|ST
Africa/Tripoli|32.9|13.18|LY
Africa/Tunis|36.8|10.18|TN
Africa/Windhoek|-22.57|17.1|NA
America/Adak|51.88|-176.66|US
America/Anchorage|61.22|-149.9|US
America/Anguilla|18.2|-63.07|AI
America/Antigua|17.05|-61.8|AG
America/Araguaina|-7.2|-48.2|BR
America/Argentina/Buenos_Aires|-34.6|-58.45|AR
America/Argentina/Catamarca|-28.47|-65.78|AR
America/Argentina/Cordoba|-31.4|-64.18|AR
America/Argentina/Jujuy|-24.18|-65.3|AR
America/Argentina/La_Rioja|-29.43|-66.85|AR
America/Argentina/Mendoza|-32.88|-68.82|AR
America/Argentina/Rio_Gallegos|-51.63|-69.22|AR
America/Argentina/Salta|-24.78|-65.42|AR
America/Argentina/San_Juan|-31.53|-68.52|AR
America/Argentina/San_Luis|-33.32|-66.35|AR
America/Argentina/Tucuman|-26.82|-65.22|AR
America/Argentina/Ushuaia|-54.8|-68.3|AR
America/Aruba|12.5|-69.97|AW
America/Asuncion|-25.27|-57.67|PY
America/Atikokan|48.76|-91.62|CA
America/Bahia|-12.98|-38.52|BR
America/Bahia_Banderas|20.8|-105.25|MX
America/Barbados|13.1|-59.62|BB
America/Belem|-1.45|-48.48|BR
America/Belize|17.5|-88.2|BZ
America/Blanc-Sablon|51.42|-57.12|CA
America/Boa_Vista|2.82|-60.67|BR
America/Bogota|4.6|-74.08|CO
America/Boise|43.61|-116.2|US
America/Buenos_Aires|-34.6|-58.45|AR
America/Cambridge_Bay|69.11|-105.05|CA
America/Campo_Grande|-20.45|-54.62|BR
America/Cancun|21.08|-86.77|MX
America/Caracas|10.5|-66.93|VE
America/Cayenne|4.93|-52.33|GF
America/Cayman|19.3|-81.38|KY
America/Chicago|41.85|-87.65|US
America/Chihuahua|28.63|-106.08|MX
America/Ciudad_Juarez|31.73|-106.48|MX
America/Costa_Rica|9.93|-84.08|CR
America/Coyhaique|-45.57|-72.07|CL
America/Creston|49.1|-116.52|CA
America/Cuiaba|-15.58|-56.08|BR
America/Curacao|12.18|-69.0|CW
America/Danmarkshavn|76.77|-18.67|GL
America/Dawson|64.07|-139.42|CA
America/Dawson_Creek|55.77|-120.23|CA
America/Denver|39.74|-104.98|US
America/Detroit|42.33|-83.05|US
America/Dominica|15.3|-61.4|DM
America/Edmonton|53.55|-113.47|CA
America/Eirunepe|-6.67|-69.87|BR
America/El_Salvador|13.7|-89.2|SV
America/Fort_Nelson|58.8|-122.7|CA
America/Fortaleza|-3.72|-38.5|BR
America/Glace_Bay|46.2|-59.95|CA
America/Goose_Bay|53.33|-60.42|CA
America/Grand_Turk|21.47|-71.13|TC
America/Grenada|12.05|-61.75|GD
America/Guadeloupe|16.23|-61.53|GP
America/Guatemala|14.63|-90.52|GT
America/Guayaquil|-2.17|-79.83|EC
America/Guyana|6.8|-58.17|GY
America/Halifax|44.65|-63.6|CA
America/Havana|23.13|-82.37|CU
America/Hermosillo|29.07|-110.97|MX
America/Indiana/Indianapolis|39.77|-86.16|US
America/Indiana/Knox|41.3|-86.62|US
America/Indiana/Marengo|38.38|-86.34|US
America/Indiana/Petersburg|38.49|-87.28|US
America/Indiana/Tell_City|37.95|-86.76|US
America/Indiana/Vevay|38.75|-85.07|US
America/Indiana/Vincennes|38.68|-87.53|US
America/Indiana/Winamac|41.05|-86.6|US
America/Inuvik|68.35|-133.72|CA
America/Iqaluit|63.73|-68.47|CA
America/Jamaica|17.97|-76.79|JM
America/Juneau|58.3|-134.42|US
America/Kentucky/Louisville|38.25|-85.76|US
America/Kentucky/Monticello|36.83|-84.85|US
America/Kralendijk|12.15|-68.28|BQ
America/La_Paz|-16.5|-68.15|BO
America/Lima|-12.05|-77.05|PE
America/Los_Angeles|34.05|-118.24|US
America/Lower_Princes|18.05|-63.05|SX
America/Maceio|-9.67|-35.72|BR
America/Managua|12.15|-86.28|NI
America/Manaus|-3.13|-60.02|BR
America/Marigot|18.07|-63.08|MF
America/Martinique|14.6|-61.08|MQ
America/Matamoros|25.83|-97.5|MX
America/Mazatlan|23.22|-106.42|MX
America/Menominee|45.11|-87.61|US
America/Merida|20.97|-89.62|MX
America/Metlakatla|55.13|-131.58|US
America/Mexico_City|19.4|-99.15|MX
America/Miquelon|47.05|-56.33|PM
America/Moncton|46.1|-64.78|CA
America/Monterrey|25.67|-100.32|MX
America/Montevideo|-34.91|-56.21|UY
America/Montserrat|16.72|-62.22|MS
America/Nassau|25.08|-77.35|BS
America/New_York|40.71|-74.01|US
America/Nome|64.5|-165.41|US
America/Noronha|-3.85|-32.42|BR
America/North_Dakota/Beulah|47.26|-101.78|US
America/North_Dakota/Center|47.12|-101.3|US
America/North_Dakota/New_Salem|46.84|-101.41|US
America/Nuuk|64.18|-51.73|GL
America/Ojinaga|29.57|-104.42|MX
America/Panama|8.97|-79.53|PA
America/Paramaribo|5.83|-55.17|SR
America/Phoenix|33.45|-112.07|US
America/Port-au-Prince|18.53|-72.33|HT
America/Port_of_Spain|10.65|-61.52|TT
America/Porto_Velho|-8.77|-63.9|BR
America/Puerto_Rico|18.47|-66.11|PR
America/Punta_Arenas|-53.15|-70.92|CL
America/Rankin_Inlet|62.82|-92.08|CA
America/Recife|-8.05|-34.9|BR
America/Regina|50.4|-104.65|CA
America/Resolute|74.7|-94.83|CA
America/Rio_Branco|-9.97|-67.8|BR
America/Santarem|-2.43|-54.87|BR
America/Santiago|-33.45|-70.67|CL
America/Santo_Domingo|18.47|-69.9|DO
America/Sao_Paulo|-23.53|-46.62|BR
America/Scoresbysund|70.48|-21.97|GL
America/Sitka|57.18|-135.3|US
America/St_Barthelemy|17.88|-62.85|BL
America/St_Johns|47.57|-52.72|CA
America/St_Kitts|17.3|-62.72|KN
America/St_Lucia|14.02|-61.0|LC
America/St_Thomas|18.35|-64.93|VI
America/St_Vincent|13.15|-61.23|VC
America/Swift_Current|50.28|-107.83|CA
America/Tegucigalpa|14.1|-87.22|HN
America/Thule|76.57|-68.78|GL
America/Tijuana|32.53|-117.02|MX
America/Toronto|43.65|-79.38|CA
America/Tortola|18.45|-64.62|VG
America/Vancouver|49.27|-123.12|CA
America/Whitehorse|60.72|-135.05|CA
America/Winnipeg|49.88|-97.15|CA
America/Yakutat|59.55|-139.73|US
Antarctica/Casey|-66.28|110.52|AQ
Antarctica/Davis|-68.58|77.97|AQ
Antarctica/DumontDUrville|-66.67|140.02|AQ
Antarctica/Macquarie|-54.5|158.95|AU
Antarctica/Mawson|-67.6|62.88|AQ
Antarctica/McMurdo|-77.83|166.6|AQ
Antarctica/Palmer|-64.8|-64.1|AQ
Antarctica/Rothera|-67.57|-68.13|AQ
Antarctica/Syowa|-69.01|39.59|AQ
Antarctica/Troll|-72.01|2.53|AQ
Antarctica/Vostok|-78.4|106.9|AQ
Arctic/Longyearbyen|78.0|16.0|SJ
Asia/Aden|12.75|45.2|YE
Asia/Almaty|43.25|76.95|KZ
Asia/Amman|31.95|35.93|JO
Asia/Anadyr|64.75|177.48|RU
Asia/Aqtau|44.52|50.27|KZ
Asia/Aqtobe|50.28|57.17|KZ
Asia/Ashgabat|37.95|58.38|TM
Asia/Atyrau|47.12|51.93|KZ
Asia/Baghdad|33.35|44.42|IQ
Asia/Bahrain|26.38|50.58|BH
Asia/Baku|40.38|49.85|AZ
Asia/Bangkok|13.75|100.52|TH
Asia/Barnaul|53.37|83.75|RU
Asia/Beirut|33.88|35.5|LB
Asia/Bishkek|42.9|74.6|KG
Asia/Brunei|4.93|114.92|BN
Asia/Calcutta|22.53|88.37|IN
Asia/Chita|52.05|113.47|RU
Asia/Chongqing|31.23|121.47|CN
Asia/Chungking|31.23|121.47|CN
Asia/Colombo|6.93|79.85|LK
Asia/Dacca|23.72|90.42|BD
Asia/Damascus|33.5|36.3|SY
Asia/Dhaka|23.72|90.42|BD
Asia/Dili|-8.55|125.58|TL
Asia/Dubai|25.3|55.3|AE
Asia/Dushanbe|38.58|68.8|TJ
Asia/Famagusta|35.12|33.95|CY
Asia/Gaza|31.5|34.47|PS
Asia/Harbin|31.23|121.47|CN
Asia/Hebron|31.53|35.09|PS
Asia/Ho_Chi_Minh|10.75|106.67|VN
Asia/Hong_Kong|22.28|114.15|HK
Asia/Hovd|48.02|91.65|MN
Asia/Irkutsk|52.27|104.33|RU
Asia/Jakarta|-6.17|106.8|ID
Asia/Jayapura|-2.53|140.7|ID
Asia/Jerusalem|31.78|35.22|IL
Asia/Kabul|34.52|69.2|AF
Asia/Kamchatka|53.02|158.65|RU
Asia/Karachi|24.87|67.05|PK
Asia/Kashgar|43.8|87.58|CN
Asia/Kathmandu|27.72|85.32|NP
Asia/Katmandu|27.72|85.32|NP
Asia/Khandyga|62.66|135.55|RU
Asia/Kolkata|22.53|88.37|IN
Asia/Krasnoyarsk|56.02|92.83|RU
Asia/Kuala_Lumpur|3.17|101.7|MY
Asia/Kuching|1.55|110.33|MY
Asia/Kuwait|29.33|47.98|KW
Asia/Macao|22.2|113.54|MO
Asia/Macau|22.2|113.54|MO
Asia/Magadan|59.57|150.8|RU
Asia/Makassar|-5.12|119.4|ID
Asia/Manila|14.59|120.97|PH
Asia/Muscat|23.6|58.58|OM
Asia/Nicosia|35.17|33.37|CY
Asia/Novokuznetsk|53.75|87.12|RU
Asia/Novosibirsk|55.03|82.92|RU
Asia/Omsk|55.0|73.4|RU
Asia/Oral|51.22|51.35|KZ
Asia/Phnom_Penh|11.55|104.92|KH
Asia/Pontianak|-0.03|109.33|ID
Asia/Pyongyang|39.02|125.75|KP
Asia/Qatar|25.28|51.53|QA
Asia/Qostanay|53.2|63.62|KZ
Asia/Qyzylorda|44.8|65.47|KZ
Asia/Rangoon|16.78|96.17|MM
Asia/Riyadh|24.63|46.72|SA
Asia/Saigon|10.75|106.67|VN
Asia/Sakhalin|46.97|142.7|RU
Asia/Samarkand|39.67|66.8|UZ
Asia/Seoul|37.55|126.97|KR
Asia/Shanghai|31.23|121.47|CN
Asia/Singapore|1.28|103.85|SG
Asia/Srednekolymsk|67.47|153.72|RU
Asia/Taipei|25.05|121.5|TW
Asia/Tashkent|41.33|69.3|UZ
Asia/Tbilisi|41.72|44.82|GE
Asia/Tehran|35.67|51.43|IR
Asia/Thimphu|27.47|89.65|BT
Asia/Tokyo|35.65|139.74|JP
Asia/Tomsk|56.5|84.97|RU
Asia/Ulaanbaatar|47.92|106.88|MN
Asia/Urumqi|43.8|87.58|CN
Asia/Ust-Nera|64.56|143.23|RU
Asia/Vientiane|17.97|102.6|LA
Asia/Vladivostok|43.17|131.93|RU
Asia/Yakutsk|62.0|129.67|RU
Asia/Yangon|16.78|96.17|MM
Asia/Yekaterinburg|56.85|60.6|RU
Asia/Yerevan|40.18|44.5|AM
Atlantic/Azores|37.73|-25.67|PT
Atlantic/Bermuda|32.28|-64.77|BM
Atlantic/Canary|28.1|-15.4|ES
Atlantic/Cape_Verde|14.92|-23.52|CV
Atlantic/Faroe|62.02|-6.77|FO
Atlantic/Madeira|32.63|-16.9|PT
Atlantic/Reykjavik|64.15|-21.85|IS
Atlantic/South_Georgia|-54.27|-36.53|GS
Atlantic/St_Helena|-15.92|-5.7|SH
Atlantic/Stanley|-51.7|-57.85|FK
Australia/Adelaide|-34.92|138.58|AU
Australia/Brisbane|-27.47|153.03|AU
Australia/Broken_Hill|-31.95|141.45|AU
Australia/Canberra|-33.87|151.22|AU
Australia/Darwin|-12.47|130.83|AU
Australia/Eucla|-31.72|128.87|AU
Australia/Hobart|-42.88|147.32|AU
Australia/Lindeman|-20.27|149.0|AU
Australia/Lord_Howe|-31.55|159.08|AU
Australia/Melbourne|-37.82|144.97|AU
Australia/Perth|-31.95|115.85|AU
Australia/Sydney|-33.87|151.22|AU
Europe/Amsterdam|52.37|4.9|NL
Europe/Andorra|42.5|1.52|AD
Europe/Astrakhan|46.35|48.05|RU
Europe/Athens|37.97|23.72|GR
Europe/Belgrade|44.83|20.5|RS
Europe/Berlin|52.5|13.37|DE
Europe/Bratislava|48.15|17.12|SK
Europe/Brussels|50.83|4.33|BE
Europe/Bucharest|44.43|26.1|RO
Europe/Budapest|47.5|19.08|HU
Europe/Busingen|47.7|8.68|DE
Europe/Chisinau|47.0|28.83|MD
Europe/Copenhagen|55.67|12.58|DK
Europe/Dublin|53.33|-6.25|IE
Europe/Gibraltar|36.13|-5.35|GI
Europe/Guernsey|49.45|-2.54|GG
Europe/Helsinki|60.17|24.97|FI
Europe/Isle_of_Man|54.15|-4.47|IM
Europe/Istanbul|41.02|28.97|TR
Europe/Jersey|49.18|-2.11|JE
Europe/Kaliningrad|54.72|20.5|RU
Europe/Kiev|50.43|30.52|UA
Europe/Kirov|58.6|49.65|RU
Europe/Kyiv|50.43|30.52|UA
Europe/Lisbon|38.72|-9.13|PT
Europe/Ljubljana|46.05|14.52|SI
Europe/London|51.51|-0.13|GB
Europe/Luxembourg|49.6|6.15|LU
Europe/Madrid|40.4|-3.68|ES
Europe/Malta|35.9|14.52|MT
Europe/Mariehamn|60.1|19.95|AX
Europe/Minsk|53.9|27.57|BY
Europe/Monaco|43.7|7.38|MC
Europe/Moscow|55.76|37.62|RU
Europe/Oslo|59.92|10.75|NO
Europe/Paris|48.87|2.33|FR
Europe/Podgorica|42.43|19.27|ME
Europe/Prague|50.08|14.43|CZ
Europe/Riga|56.95|24.1|LV
Europe/Rome|41.9|12.48|IT
Europe/Samara|53.2|50.15|RU
Europe/San_Marino|43.92|12.47|SM
Europe/Sarajevo|43.87|18.42|BA
Europe/Saratov|51.57|46.03|RU
Europe/Simferopol|44.95|34.1|UA
Europe/Skopje|41.98|21.43|MK
Europe/Sofia|42.68|23.32|BG
Europe/Stockholm|59.33|18.05|SE
Europe/Tallinn|59.42|24.75|EE
Europe/Tirane|41.33|19.83|AL
Europe/Ulyanovsk|54.33|48.4|RU
Europe/Vaduz|47.15|9.52|LI
Europe/Vatican|41.9|12.45|VA
Europe/Vienna|48.22|16.33|AT
Europe/Vilnius|54.68|25.32|LT
Europe/Volgograd|48.73|44.42|RU
Europe/Warsaw|52.25|21.0|PL
Europe/Zagreb|45.8|15.97|HR
Europe/Zurich|47.38|8.53|CH
Hongkong|22.28|114.15|HK
Indian/Antananarivo|-18.92|47.52|MG
Indian/Chagos|-7.33|72.42|IO
Indian/Christmas|-10.42|105.72|CX
Indian/Cocos|-12.17|96.92|CC
Indian/Comoro|-11.68|43.27|KM
Indian/Kerguelen|-49.35|70.22|TF
Indian/Mahe|-4.67|55.47|SC
Indian/Maldives|4.17|73.5|MV
Indian/Mauritius|-20.17|57.5|MU
Indian/Mayotte|-12.78|45.23|YT
Indian/Reunion|-20.87|55.47|RE
Japan|35.65|139.74|JP
PRC|31.23|121.47|CN
Pacific/Apia|-13.83|-171.73|WS
Pacific/Auckland|-36.87|174.77|NZ
Pacific/Bougainville|-6.22|155.57|PG
Pacific/Chatham|-43.95|-176.55|NZ
Pacific/Chuuk|7.42|151.78|FM
Pacific/Easter|-27.15|-109.43|CL
Pacific/Efate|-17.67|168.42|VU
Pacific/Fakaofo|-9.37|-171.23|TK
Pacific/Fiji|-18.13|178.42|FJ
Pacific/Funafuti|-8.52|179.22|TV
Pacific/Galapagos|-0.9|-89.6|EC
Pacific/Gambier|-23.13|-134.95|PF
Pacific/Guadalcanal|-9.53|160.2|SB
Pacific/Guam|13.47|144.75|GU
Pacific/Honolulu|21.31|-157.86|US
Pacific/Kanton|-2.78|-171.72|KI
Pacific/Kiritimati|1.87|-157.33|KI
Pacific/Kosrae|5.32|162.98|FM
Pacific/Kwajalein|9.08|167.33|MH
Pacific/Majuro|7.15|171.2|MH
Pacific/Marquesas|-9.0|-139.5|PF
Pacific/Midway|28.22|-177.37|UM
Pacific/Nauru|-0.52|166.92|NR
Pacific/Niue|-19.02|-169.92|NU
Pacific/Norfolk|-29.05|167.97|NF
Pacific/Noumea|-22.27|166.45|NC
Pacific/Pago_Pago|-14.27|-170.7|AS
Pacific/Palau|7.33|134.48|PW
Pacific/Pitcairn|-25.07|-130.08|PN
Pacific/Pohnpei|6.97|158.22|FM
Pacific/Port_Moresby|-9.5|147.17|PG
Pacific/Rarotonga|-21.23|-159.77|CK
Pacific/Saipan|15.2|145.75|MP
Pacific/Tahiti|-17.53|-149.57|PF
Pacific/Tarawa|1.42|173.0|KI
Pacific/Tongatapu|-21.13|-175.2|TO
Pacific/Wake|19.28|166.62|UM
Pacific/Wallis|-13.3|-176.17|WF
ROC|25.05|121.5|TW
ROK|37.55|126.97|KR
Singapore|1.28|103.85|SG
UTC|0.0|0.0|`;

let tzIndex = null;
function tzPoint(zone) {
  if (!tzIndex) {
    tzIndex = new Map();
    for (const line of TZ_TABLE.trim().split("\n")) {
      const [z, la, lo, cc] = line.split("|");
      tzIndex.set(z, { lat: Number(la), lon: Number(lo), cc: cc || "" });
    }
  }
  return tzIndex.get(zone) || null;
}

const DASH_CSS = `
:root{
  --bg:#faf9f7;--card:#fff;--fg:#1a1a19;--muted:#6b6b68;--faint:#93938e;
  --line:#e7e5e1;--line-soft:#f0eeea;--accent:#c05f3c;--accent-soft:#f4e5dd;
  --accent-ink:#a34c2c;--alt:#3f6ea8;--alt-soft:#e3ecf7;--good:#3f7d55;--bad:#b1533b;
  --shadow:0 1px 2px rgba(26,26,25,.05),0 8px 24px -18px rgba(26,26,25,.35);
  --map-sea:#edefee;--map-land:#bcc0bb;--map-hit:#d9603a;--map-unver:#4d86d6;--map-tz:#2f8f6f;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme=light]){
    --bg:#131312;--card:#1c1c1a;--fg:#f1efec;--muted:#9c9b95;--faint:#78776f;
    --line:#2e2e2a;--line-soft:#232320;--accent:#e08b6b;--accent-soft:#3a2921;
    --accent-ink:#f0a888;--alt:#7ba7de;--alt-soft:#1f2b3a;--good:#78b78f;--bad:#e08b6b;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -20px rgba(0,0,0,.9);
    --map-sea:#191918;--map-land:#44443f;--map-hit:#e8794f;--map-unver:#6fa0e8;--map-tz:#4fbf98;
  }
}
:root[data-theme=dark]{
  --bg:#131312;--card:#1c1c1a;--fg:#f1efec;--muted:#9c9b95;--faint:#78776f;
  --line:#2e2e2a;--line-soft:#232320;--accent:#e08b6b;--accent-soft:#3a2921;
  --accent-ink:#f0a888;--alt:#7ba7de;--alt-soft:#1f2b3a;--good:#78b78f;--bad:#e08b6b;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -20px rgba(0,0,0,.9);
    --map-sea:#191918;--map-land:#44443f;--map-hit:#e8794f;--map-unver:#6fa0e8;--map-tz:#4fbf98;
}
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:var(--accent-ink);text-underline-offset:2px}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px 80px}

/* ---- top bar ---- */
.top{position:sticky;top:0;z-index:40;background:var(--bg);
  border-bottom:1px solid var(--line);padding:0 20px}
@supports (backdrop-filter:blur(1px)){
  .top{background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:saturate(1.6) blur(10px)}
}
.top .inner{max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;gap:12px 18px;
  align-items:center;justify-content:space-between;padding:14px 0 12px}
h1{font-size:19px;margin:0;letter-spacing:-.015em;display:flex;align-items:center;gap:9px}
h1 .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none;
  box-shadow:0 0 0 4px var(--accent-soft)}
.sub{color:var(--muted);font-size:12.5px;margin-top:3px}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chips{display:inline-flex;gap:3px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);
  border-radius:999px;padding:3px}
.chip{display:inline-block;padding:4px 11px;border-radius:999px;font-size:12.5px;color:var(--muted);
  text-decoration:none;white-space:nowrap}
.chip.on{background:var(--accent);color:#fff;font-weight:500}
.chip:hover:not(.on){background:var(--accent-soft);color:var(--accent-ink)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid var(--line);
  border-radius:9px;background:var(--card);color:var(--muted);font-size:12.5px;text-decoration:none;
  cursor:pointer;font-family:inherit;line-height:1.4}
.btn:hover{border-color:var(--accent);color:var(--accent-ink)}
.btn.on{background:var(--accent);border-color:var(--accent);color:#fff}

/* ---- tabs ---- */
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;margin:0 -20px;padding:0 20px;
  border-bottom:1px solid var(--line)}
.tabs::-webkit-scrollbar{display:none}
.tabs button{appearance:none;background:none;border:0;border-bottom:2px solid transparent;
  padding:11px 13px;font:inherit;font-size:13.5px;color:var(--muted);cursor:pointer;white-space:nowrap}
.tabs button:hover{color:var(--fg)}
.tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent);font-weight:500}
.tabs .count{color:var(--faint);font-variant-numeric:tabular-nums;font-size:12px;margin-left:5px}
section.panel{padding-top:20px}

/* ---- tiles ---- */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:11px;margin-bottom:11px}
.tiles:last-of-type{margin-bottom:18px}
.tiles.small .tile{padding:11px 14px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:13px 15px;
  box-shadow:var(--shadow)}
.tile .v{display:block;font-size:27px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums;
  line-height:1.15}
.tile .l{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.055em;
  display:block;margin-top:3px}
.tile .d{font-size:11.5px;margin-top:6px;color:var(--faint);font-variant-numeric:tabular-nums}
.tile .d.up{color:var(--good)}.tile .d.down{color:var(--bad)}
.tile.quiet .v{color:var(--muted);font-size:23px}

/* ---- cards ---- */
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:15px 17px;
  margin-bottom:15px;box-shadow:var(--shadow)}
.card>h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.065em;color:var(--muted);
  margin:0 0 12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:10px}
.card>h2 .hint{text-transform:none;letter-spacing:0;font-weight:400;color:var(--faint);font-size:11.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:15px}
.grid .card{margin:0}
.note{color:var(--muted);font-size:12.5px;line-height:1.6;margin:0}
.note+.note{margin-top:9px}

/* ---- chart ---- */
.chartwrap{position:relative}
.chart{display:block;width:100%;height:184px;overflow:visible}
.chart .area{fill:var(--accent-soft)}
.chart .line{fill:none;stroke:var(--accent);stroke-width:1.75;vector-effect:non-scaling-stroke;
  stroke-linejoin:round;stroke-linecap:round}
.chart .uline{fill:none;stroke:var(--alt);stroke-width:1.25;stroke-dasharray:3 3;
  vector-effect:non-scaling-stroke;opacity:.85}
.chart .grid-l{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.chart .hot{fill:transparent}
.chart .hot:hover{fill:var(--accent);fill-opacity:.09}
.chart .cursor{stroke:var(--accent);stroke-width:1;vector-effect:non-scaling-stroke;opacity:0}
.chart .cursor.on{opacity:.5}
.axis{display:flex;justify-content:space-between;color:var(--faint);font-size:11px;margin-top:4px}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:11.5px;margin-top:9px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.tipbox{position:absolute;pointer-events:none;opacity:0;transition:opacity .08s;background:var(--fg);
  color:var(--bg);font-size:11.5px;line-height:1.45;padding:6px 9px;border-radius:7px;white-space:nowrap;
  transform:translate(-50%,-118%);z-index:5;font-variant-numeric:tabular-nums}
.tipbox.on{opacity:1}

/* ---- rank lists ---- */
ul.rank{list-style:none;margin:0;padding:0}
ul.rank li{display:grid;grid-template-columns:1fr auto 40px;gap:4px 10px;padding:7px 2px 8px;
  font-size:13.5px;border-radius:6px}
ul.rank li:hover{background:var(--line-soft)}
ul.rank li .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ul.rank li .c{color:var(--muted);font-variant-numeric:tabular-nums}
ul.rank li .pc{color:var(--faint);font-variant-numeric:tabular-nums;text-align:right}
ul.rank li .track{grid-column:1/-1;height:3px;border-radius:2px;background:var(--line-soft);
  overflow:hidden;margin-top:1px}
ul.rank li .track i{display:block;height:100%;background:var(--accent);opacity:.8;border-radius:2px}

/* ---- map ---- */
.mapcard{padding:0;overflow:hidden}
.maphead{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  padding:13px 16px;border-bottom:1px solid var(--line)}
.maphead h2{margin:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.065em;
  color:var(--muted);font-weight:600}
.maphead h2 .hint{text-transform:none;letter-spacing:0;font-weight:400;color:var(--faint)}
.mapbox{position:relative;height:min(60vh,520px);background:var(--map-sea);cursor:grab;
  touch-action:none;overflow:hidden}
.mapbox.tall{height:calc(100vh - 168px)}
.mapbox.drag{cursor:grabbing}
.mapbox canvas{display:block;width:100%;height:100%}
.maptip{position:absolute;z-index:3;pointer-events:none;opacity:0;transition:opacity .08s;
  background:var(--fg);color:var(--bg);font-size:11.5px;line-height:1.5;padding:7px 10px;
  border-radius:8px;white-space:nowrap;transform:translate(-50%,-124%);
  font-variant-numeric:tabular-nums;box-shadow:0 6px 20px -8px rgba(0,0,0,.45)}
.maptip.on{opacity:1}
.mapempty{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:13px}
.mapempty[hidden]{display:none}
.maplegend{display:flex;gap:16px;flex-wrap:wrap;align-items:center;color:var(--muted);
  font-size:11.5px;padding:10px 16px;border-top:1px solid var(--line)}
.maplegend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;
  vertical-align:-1px}

/* ---- tables ---- */
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:11px}
.toolbar input{flex:1;min-width:150px;padding:6px 10px;border:1px solid var(--line);border-radius:9px;
  background:var(--bg);color:var(--fg);font:inherit;font-size:13px}
.toolbar input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:10.5px;text-transform:uppercase;
  letter-spacing:.06em;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap;
  position:sticky;top:0;background:var(--card);z-index:1}
th[data-sort]{cursor:pointer;user-select:none}
th[data-sort]:hover{color:var(--accent-ink)}
th[data-sort]::after{content:"";opacity:.35;margin-left:5px}
th[data-sort][aria-sort=ascending]::after{content:"▲";opacity:.85}
th[data-sort][aria-sort=descending]::after{content:"▼";opacity:.85}
td{padding:6px 10px;border-bottom:1px solid var(--line-soft);white-space:nowrap}
tbody tr:hover td{background:var(--line-soft)}
tbody tr:last-child td{border-bottom:0}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
code.ip{cursor:pointer;border-radius:4px;padding:1px 4px;margin:-1px -4px}
code.ip:hover{background:var(--accent-soft);color:var(--accent-ink)}
.dim{color:var(--muted)}
.trunc{max-width:250px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}
.tag{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:5px;background:var(--alt-soft);
  color:var(--alt);letter-spacing:.03em;vertical-align:1px}
.empty{color:var(--muted);font-size:13px;padding:12px 9px;text-align:center}
footer{color:var(--muted);font-size:12px;margin-top:26px;display:grid;gap:9px;max-width:78ch}
@media (max-width:640px){
  .wrap{padding:0 14px 60px}.top{margin:0 -14px;padding:0 14px}.tabs{margin:0 -14px;padding:0 14px}
  .tile .v{font-size:23px}.trunc{max-width:150px}
}
@media print{.top,.tabs,.toolbar{display:none}.panel{display:block!important}}
`;

const DASH_JS = `
(function () {
  var root = document.documentElement;
  var LS = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
             set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  /* ---- theme: auto -> light -> dark, remembered ---- */
  var themeBtn = document.getElementById('theme');
  function applyTheme(t) {
    if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    themeBtn.textContent = (t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark') + ' theme';
    themeBtn.title = 'Theme: ' + t + ' (click to change)';
  }
  var theme = LS.get('vt-theme') || 'auto';
  applyTheme(theme);
  themeBtn.addEventListener('click', function () {
    theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
    LS.set('vt-theme', theme); applyTheme(theme);
    if (window.vtRedrawMap) window.vtRedrawMap();
  });

  /* ---- tabs ---- */
  var tabs = [].slice.call(document.querySelectorAll('.tabs button'));
  var panels = [].slice.call(document.querySelectorAll('section.panel'));
  function show(name) {
    tabs.forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
    panels.forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    try { sessionStorage.setItem('vt-tab', name); } catch (e) {}
    if (name === 'map') initMap();
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  }
  tabs.forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.tab); }); });
  /* show() is called at the very bottom of this script, not here: it can open
     the map, whose state lives in declarations further down that would
     otherwise not have run their initialisers yet. */

  /* ---- times: UTC <-> local ---- */
  var localMode = LS.get('vt-time') === 'local';
  var timeBtn = document.getElementById('timemode');
  function paintTimes() {
    timeBtn.textContent = localMode ? 'Local time' : 'UTC';
    [].forEach.call(document.querySelectorAll('[data-ts]'), function (el) {
      var ts = +el.dataset.ts;
      if (!ts) return;
      var d = new Date(ts);
      if (!localMode) { el.textContent = el.dataset.utc; el.title = 'UTC'; return; }
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      el.textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      el.title = el.dataset.utc + ' UTC';
    });
  }
  timeBtn.addEventListener('click', function () {
    localMode = !localMode; LS.set('vt-time', localMode ? 'local' : 'utc'); paintTimes();
  });
  paintTimes();

  /* ---- click an address to copy it ---- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('code.ip') : null;
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.dataset.ip || el.textContent).then(function () {
      var was = el.textContent; el.textContent = 'copied';
      setTimeout(function () { el.textContent = was; }, 800);
    }, function () {});
  });

  /* ---- table filter + sort ---- */
  [].forEach.call(document.querySelectorAll('[data-filters]'), function (input) {
    var body = document.querySelector('#' + input.dataset.filters + ' tbody');
    if (!body) return;
    var out = document.getElementById(input.dataset.filters + '-n');
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase(), shown = 0;
      [].forEach.call(body.rows, function (row) {
        var hit = !q || row.textContent.toLowerCase().indexOf(q) > -1;
        row.hidden = !hit; if (hit) shown++;
      });
      if (out) out.textContent = q ? shown + ' of ' + body.rows.length : '';
    });
  });
  [].forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      var table = th.closest('table'), body = table.tBodies[0];
      var i = [].indexOf.call(th.parentNode.cells, th);
      var desc = th.getAttribute('aria-sort') !== 'descending';
      [].forEach.call(table.querySelectorAll('th[data-sort]'), function (o) { o.removeAttribute('aria-sort'); });
      th.setAttribute('aria-sort', desc ? 'descending' : 'ascending');
      var num = th.dataset.sort === 'num';
      var key = function (row) {
        var c = row.cells[i]; if (!c) return num ? 0 : '';
        var v = c.dataset.v !== undefined ? c.dataset.v : c.textContent.trim();
        return num ? parseFloat(v) || 0 : v.toLowerCase();
      };
      [].slice.call(body.rows)
        .sort(function (a, b) { var x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); })
        .forEach(function (r) { body.appendChild(r); });
    });
  });

  /* ---- chart tooltip ---- */
  var chart = document.querySelector('.chart');
  if (chart) {
    var tip = document.querySelector('.tipbox');
    var cursor = chart.querySelector('.cursor');
    var wrap = chart.closest('.chartwrap');
    [].forEach.call(chart.querySelectorAll('.hot'), function (hot) {
      hot.addEventListener('mouseenter', function () {
        var r = hot.getBoundingClientRect(), w = wrap.getBoundingClientRect();
        var c = chart.getBoundingClientRect();
        /* data-y is in viewBox units; the tooltip is placed in CSS pixels. */
        var vb = (chart.viewBox && chart.viewBox.baseVal && chart.viewBox.baseVal.height) || c.height;
        tip.innerHTML = '<b>' + hot.dataset.d + '</b><br>' + hot.dataset.c + ' views · ' +
          hot.dataset.u + ' unique';
        tip.style.left = (r.left - w.left + r.width / 2) + 'px';
        tip.style.top = ((c.top - w.top) + (+hot.dataset.y || 0) / vb * c.height) + 'px';
        tip.classList.add('on');
        if (cursor) { cursor.setAttribute('x1', hot.dataset.x); cursor.setAttribute('x2', hot.dataset.x);
                      cursor.classList.add('on'); }
      });
      hot.addEventListener('mouseleave', function () {
        tip.classList.remove('on'); if (cursor) cursor.classList.remove('on');
      });
    });
  }

  /* ---- keyboard ---- */
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    var n = '1234567'.indexOf(e.key);
    if (n > -1 && tabs[n]) { show(tabs[n].dataset.tab); return; }
    if (e.key === '/') { var f = document.querySelector('section.panel:not([hidden]) [data-filters]');
                         if (f) { e.preventDefault(); f.focus(); } }
  });

  /* ---- the map ---- */
  /* Equirectangular, drawn on a canvas from the land mask baked into the
     Worker: no tiles, no map library, nothing to fetch. World coordinates are
     mask cells (0..360 across, 0..144 down), so the projection is two lines. */
  var mapReady = false, cv, ctx2d, tip, box, hot = [];
  var view = { cx: MAP_W / 2, cy: MAP_H / 2, z: 1 };
  var PTS = [];

  var landBytes = null;
  function land(col, row) {
    if (!landBytes) {
      var raw = atob(WORLD_MASK), n = raw.length;
      landBytes = new Uint8Array(n);
      for (var i = 0; i < n; i++) landBytes[i] = raw.charCodeAt(i);
    }
    var b = row * MAP_W + col;
    return (landBytes[b >> 3] >> (7 - (b & 7))) & 1;
  }
  function toX(lon) { return (lon + 180) / 360 * MAP_W; }
  function toY(lat) { return (MAP_LAT_TOP - lat) / (MAP_LAT_TOP - MAP_LAT_BOTTOM) * MAP_H; }

  function css(name, fallback) {
    var v = getComputedStyle(document.body).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function drawMap() {
    if (!cv) return;
    var cw = box.clientWidth, ch = box.clientHeight;
    if (!cw || !ch) return;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    var g = ctx2d;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css('--map-sea', '#eef0ef');
    g.fillRect(0, 0, cw, ch);

    var fitK = Math.min(cw / MAP_W, ch / MAP_H);
    var k = fitK * view.z;
    var offX = cw / 2 - view.cx * k, offY = ch / 2 - view.cy * k;

    /* Land as a dot grid. fillRect rather than arc(): 16k of them land inside
       one animation frame even while dragging, and at this size a square dot
       and a round one are the same three pixels. */
    var d = Math.max(1, k * 0.62), h = d / 2;
    g.fillStyle = css('--map-land', '#bcc0bb');
    for (var row = 0; row < MAP_H; row++) {
      var y = offY + (row + 0.5) * k;
      if (y < -d || y > ch + d) continue;
      for (var col = 0; col < MAP_W; col++) {
        if (!land(col, row)) continue;
        var x = offX + (col + 0.5) * k;
        if (x < -d || x > cw + d) continue;
        g.fillRect(x - h, y - h, d, d);
      }
    }

    /* Traffic bubbles, at a fixed screen size so they stay readable at every
       zoom — the position is geographic, the radius is a quantity. */
    var max = 1;
    for (var i = 0; i < PTS.length; i++) if (PTS[i].c > max) max = PTS[i].c;
    hot = [];
    var hit = css('--map-hit', '#d9603a'), unv = css('--map-unver', '#4d86d6');
    var tzc = css('--map-tz', '#2f8f6f');
    for (i = 0; i < PTS.length; i++) {
      var p = PTS[i];
      var sx = offX + toX(p.lon) * k, sy = offY + toY(p.lat) * k;
      if (sx < -40 || sx > cw + 40 || sy < -40 || sy > ch + 40) continue;
      var r = 3.5 + 15 * Math.sqrt(p.c / max);
      /* The ring is the honest place for the verified/unverified split: a
         location that is 40% unverified is neither, and painting the whole
         bubble one colour would round that away in whichever direction. */
      var frac = p.c ? p.unverified / p.c : 0;
      g.beginPath(); g.arc(sx, sy, r, 0, 6.2832);
      g.fillStyle = p.tz ? tzc : frac > 0.5 ? unv : hit;
      g.globalAlpha = 0.32; g.fill();
      g.globalAlpha = 0.95; g.lineWidth = 1.6;
      var a0 = -1.5708, full = 6.2832;
      /* Located by the browser's clock rather than by an address: a dashed ring,
         because it is a different kind of claim and should not be mistaken for
         the geolocated ones it sits beside. */
      if (p.tz) {
        g.save(); g.setLineDash([3, 2.5]);
        g.beginPath(); g.arc(sx, sy, r, 0, full);
        g.strokeStyle = tzc; g.stroke(); g.restore();
      } else if (frac > 0.001 && frac < 0.999) {
        g.beginPath(); g.arc(sx, sy, r, a0, a0 + full * frac);
        g.strokeStyle = unv; g.stroke();
        g.beginPath(); g.arc(sx, sy, r, a0 + full * frac, a0 + full);
        g.strokeStyle = hit; g.stroke();
      } else {
        g.beginPath(); g.arc(sx, sy, r, 0, full);
        g.strokeStyle = frac >= 0.999 ? unv : hit; g.stroke();
      }
      g.globalAlpha = 1;
      hot.push({ x: sx, y: sy, r: Math.max(r, 7), p: p });
    }
  }

  function pointAt(mx, my) {
    var best = null, bd = 1e9;
    for (var i = 0; i < hot.length; i++) {
      var dx = mx - hot[i].x, dy = my - hot[i].y, dd = dx * dx + dy * dy;
      if (dd <= hot[i].r * hot[i].r && dd < bd) { bd = dd; best = hot[i]; }
    }
    return best;
  }

  function fitPoints() {
    if (!PTS.length) return;
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (var i = 0; i < PTS.length; i++) {
      var x = toX(PTS[i].lon), y = toY(PTS[i].lat);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    var w = Math.max(x1 - x0, 12) * 1.25, h2 = Math.max(y1 - y0, 8) * 1.35;
    view.cx = (x0 + x1) / 2; view.cy = (y0 + y1) / 2;
    view.z = Math.max(1, Math.min(10, Math.min(MAP_W / w, MAP_H / h2)));
    clampView(); drawMap();
  }
  function clampView() {
    view.z = Math.max(1, Math.min(14, view.z));
    var halfW = MAP_W / (2 * view.z), halfH = MAP_H / (2 * view.z);
    view.cx = Math.max(halfW, Math.min(MAP_W - halfW, view.cx));
    view.cy = Math.max(halfH, Math.min(MAP_H - halfH, view.cy));
  }

  function initMap() {
    if (mapReady) return;
    box = document.getElementById('mapbox');
    cv = document.getElementById('vt-canvas');
    if (!box || !cv || !cv.getContext) return;
    mapReady = true;
    ctx2d = cv.getContext('2d');
    tip = document.getElementById('maptip');
    try { PTS = JSON.parse(document.getElementById('vt-points').textContent) || []; } catch (e) { PTS = []; }
    var empty = document.getElementById('mapempty');
    if (empty) empty.hidden = PTS.length > 0;

    window.vtRedrawMap = drawMap;
    window.addEventListener('resize', drawMap);

    box.addEventListener('mousemove', function (e) {
      var b = cv.getBoundingClientRect();
      var mx = e.clientX - b.left, my = e.clientY - b.top;
      var found = pointAt(mx, my);
      if (!found) { tip.classList.remove('on'); return; }
      var p = found.p;
      var where = [p.city, p.region, p.country].filter(Boolean).join(', ') || 'Unknown location';
      tip.innerHTML = '<b>' + p.flag + ' ' + escHtml(where) + '</b><br>' +
        p.c + (p.c === 1 ? ' view' : ' views') + ' · ' + p.u + ' unique' +
        (p.unverified ? '<br>' + p.unverified + ' unverified' : '') +
        (p.tz ? '<br><i>placed by the browser clock ' + escHtml(p.zone) + '</i>' +
                (p.exits ? '<br>reached us via ' + p.exits +
                           (p.exits === 1 ? ' other country' : ' other countries') : '') +
                (p.recovered ? '<br>' + p.recovered + ' recovered after the fact' : '')
              : '') +
        '<br>last seen ' + p.last + ' UTC';
      tip.style.left = found.x + 'px';
      tip.style.top = (found.y - found.r) + 'px';
      tip.classList.add('on');
    });
    box.addEventListener('mouseleave', function () { tip.classList.remove('on'); });

    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      var b = cv.getBoundingClientRect();
      var cw = box.clientWidth, ch = box.clientHeight;
      var fitK = Math.min(cw / MAP_W, ch / MAP_H), k = fitK * view.z;
      /* Keep the world point under the cursor under the cursor. */
      var wx = view.cx + (e.clientX - b.left - cw / 2) / k;
      var wy = view.cy + (e.clientY - b.top - ch / 2) / k;
      var before = view.z;
      view.z *= e.deltaY < 0 ? 1.25 : 0.8;
      clampView();
      var k2 = fitK * view.z;
      if (view.z !== before) {
        view.cx = wx - (e.clientX - b.left - cw / 2) / k2;
        view.cy = wy - (e.clientY - b.top - ch / 2) / k2;
        clampView();
      }
      drawMap();
    }, { passive: false });

    var drag = null;
    box.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
      box.classList.add('drag');
      if (box.setPointerCapture) box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var fitK = Math.min(box.clientWidth / MAP_W, box.clientHeight / MAP_H);
      var k = fitK * view.z;
      view.cx = drag.cx - (e.clientX - drag.x) / k;
      view.cy = drag.cy - (e.clientY - drag.y) / k;
      clampView(); drawMap();
    });
    var stopDrag = function () { drag = null; box.classList.remove('drag'); };
    box.addEventListener('pointerup', stopDrag);
    box.addEventListener('pointercancel', stopDrag);

    document.getElementById('mapfit').addEventListener('click', fitPoints);
    document.getElementById('mapworld').addEventListener('click', function () {
      view.cx = MAP_W / 2; view.cy = MAP_H / 2; view.z = 1; drawMap();
    });
    document.getElementById('mapbig').addEventListener('click', function () {
      box.classList.toggle('tall');
      this.classList.toggle('on');
      drawMap();
    });
    fitPoints();
    drawMap();
  }
  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  /* ---- auto refresh ---- */
  var auto = document.getElementById('auto');
  var timer = null;
  function setAuto(on) {
    auto.classList.toggle('on', on); LS.set('vt-auto', on ? '1' : '0');
    auto.textContent = on ? 'Auto-refresh: on' : 'Auto-refresh';
    if (timer) clearInterval(timer);
    timer = on ? setInterval(function () { location.reload(); }, 60000) : null;
  }
  auto.addEventListener('click', function () { setAuto(!auto.classList.contains('on')); });
  setAuto(LS.get('vt-auto') === '1');

  /* Everything is defined; open the tab the URL, or the last visit, asked for. */
  var start = location.hash.slice(1) || (function () {
    try { return sessionStorage.getItem('vt-tab'); } catch (e) { return null; } })() || 'overview';
  if (!tabs.some(function (b) { return b.dataset.tab === start; })) start = 'overview';
  show(start);
})();
`;

async function handleDashboard(env, url) {
  const d = await collect(env, url);
  const token = url.searchParams.get("token") || "";
  const qs = (over) => {
    const p = new URLSearchParams({ token, days: String(d.range.days) });
    if (d.range.bots) p.set("bots", "1");
    for (const [k, v] of Object.entries(over)) v === null ? p.delete(k) : p.set(k, v);
    return "?" + p.toString().replace(/&/g, "&amp;"); // embedded in href attributes
  };

  const ranges = [
    ["1", "24h"], ["7", "7d"], ["30", "30d"], ["90", "90d"], ["365", "1y"], ["0", "All"],
  ]
    .map(
      ([v, label]) =>
        `<a class="chip${String(d.range.days) === v ? " on" : ""}" href="${qs({ days: v })}">${label}</a>`
    )
    .join("");

  const ipPoints = d.points.map((p) => ({
    lat: Number(p.lat), lon: Number(p.lon), c: p.c, u: p.u,
    unverified: p.unverified || 0,
    city: p.city || "", region: p.region || "", country: p.country || "",
    flag: flag(p.country), last: fmtDate(p.last_ts, true),
  }));

  // Rows drawn where the browser's own clock says they started, not where they
  // came out. These are the ones held out of `points` above, so a relayed
  // request appears exactly once — in the right country instead of the wrong
  // one. A zone is a region, so the coordinate is tzdb's principal city; that is
  // country-level precision and the tooltip says so.
  let tzUnplaceable = 0;
  const tzPoints = d.tzPoints
    .map((p) => ({ p, at: tzPoint(p.tz) }))
    .filter(({ p, at }) => at || (tzUnplaceable += p.c, false))
    .map(({ p, at }) => ({
      lat: at.lat, lon: at.lon, c: p.c, u: p.u,
      unverified: p.unverified || 0,
      tz: 1, zone: p.tz, recovered: p.recovered || 0, exits: p.exits || 0,
      city: p.tz.split("/").pop().replace(/_/g, " "),
      region: "", country: at.cc, flag: flag(at.cc),
      last: fmtDate(p.last_ts, true),
    }));
  const points = [...ipPoints, ...tzPoints];

  const tabs = [
    ["overview", "Overview", null],
    ["map", "Map", points.length],
    ["locations", "Locations", d.cities.length],
    ["clients", "Clients", d.ips.length],
    ["delivery", "Delivery", d.transports.length],
    ["restricted", "Restricted", d.relayed.length + d.recoveredRows.length],
  ]
    .map(
      ([id, label, n]) =>
        `<button data-tab="${id}" role="tab" aria-selected="false">${label}${
          n ? `<span class="count">${num(n)}</span>` : ""
        }</button>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Clients · ghuang14.github.io</title>
<style>${DASH_CSS}</style>
</head><body>

<div class="top"><div class="inner">
  <div>
    <h1><span class="dot"></span>Clients</h1>
    <div class="sub">ghuang14.github.io · ${
      d.lifetime.first_ts
        ? `${num(d.lifetime.views)} hits since ${fmtDate(d.lifetime.first_ts)}`
        : "no data yet"
    } · showing ${rangeLabel(d.range.days)}</div>
  </div>
  <div class="controls">
    <div class="chips">${ranges}</div>
    <a class="btn${d.range.bots ? " on" : ""}" href="${qs({ bots: d.range.bots ? null : "1" })}"
       title="Include traffic identified as crawlers">Bots</a>
    <button class="btn" id="timemode" title="Switch between UTC and your local time">UTC</button>
    <button class="btn" id="theme" title="Theme">Auto theme</button>
    <button class="btn" id="auto" title="Reload every minute">Auto-refresh</button>
  </div>
</div></div>

<div class="wrap">
<div class="tabs" role="tablist">${tabs}</div>

<section class="panel" data-panel="overview">
  <div class="tiles">
    ${tile(d.summary.views, "Pageviews", d.previous.views, d.range.days)}
    ${tile(d.summary.uniques, "Unique clients", d.previous.uniques, d.range.days)}
    ${tile(d.summary.countries, "Countries", d.previous.countries, d.range.days)}
    ${tile(d.today.views, "Today", null, 0)}
  </div>
  <div class="tiles small">
    ${tile(d.unverified.views, "Unverified hits", null, 0, "quiet")}
    ${tile(d.summary.bots, "Bot hits filtered", null, 0, "quiet")}
    ${tile(d.optouts.hits, "DNT/GPC opt-outs", null, 0, "quiet")}
    ${tile(d.proxiedTotal.hits, "Proxied / mirrored", null, 0, "quiet")}
    ${tile(d.relayedTotal.hits, "Relayed / restricted", null, 0, "quiet")}
  </div>

  <div class="card">
    <h2>Traffic <span class="hint">views (solid) · unique clients (dashed)</span></h2>
    ${chart(d.series)}
  </div>

  <div class="grid">
    ${rankCard("Countries", d.countries, { flags: true })}
    ${rankCard("Pages", d.pages)}
    ${rankCard("Referrers", d.referrers, { label: shortRef })}
    ${rankCard("Networks (ASN)", d.networks)}
  </div>
</section>

<section class="panel" data-panel="map" hidden>
  <div class="card mapcard">
    <div class="maphead">
      <h2>Where clients are<span class="hint"> · ${num(points.length)} location${
        points.length === 1 ? "" : "s"
      } in ${rangeLabel(d.range.days)}</span></h2>
      <div class="controls">
        <button class="btn" id="mapfit">Fit to clients</button>
        <button class="btn" id="mapworld">Whole world</button>
        <button class="btn" id="mapbig">Expand</button>
      </div>
    </div>
    <div class="mapbox" id="mapbox">
      <canvas id="vt-canvas" role="img" aria-label="World map of client locations"></canvas>
      <div class="maptip" id="maptip"></div>
      <div class="mapempty" id="mapempty" hidden>No located visits in this range.</div>
    </div>
    <div class="maplegend">
      <span><i style="background:var(--map-hit)"></i>Verified visits</span>
      <span><i style="background:var(--map-unver)"></i>Unverified share of the ring (no Origin or Referer — see Delivery)</span>
      <span><i style="background:var(--map-tz);border-radius:50%;box-shadow:inset 0 0 0 1px var(--card)"></i>Placed by the client's own clock, not their address — a dashed ring. These are
        clients whose browser timezone contradicts where their traffic came out, so plotting them
        by address would put them in the wrong country. Accurate to the country, not the city.${
          tzUnplaceable ? ` ${num(tzUnplaceable)} could not be placed: no coordinates for that zone.` : ""
        }</span>
      <span>Circle area is proportional to views. Drag to pan, scroll to zoom, hover for detail.</span>
      <span>Positions are Cloudflare's city-level edge geolocation, not precise addresses.</span>
    </div>
  </div>
  <script type="application/json" id="vt-points">${jsonScript(points)}</script>
</section>

<section class="panel" data-panel="locations" hidden>
  <div class="grid">
    ${rankCard("Countries", d.countries, { flags: true })}
    ${rankCard("Cities", d.cities)}
  </div>
  <div class="card">
    <h2>Every location <span class="hint">includes unverified hits, which the
      Countries and Cities rankings above exclude — hence the higher
      numbers<span id="loc-n"></span></span></h2>
    <div class="toolbar"><input data-filters="loc" placeholder="Filter locations…  (press / to focus)"></div>
    <div class="scroll"><table id="loc">
      <thead><tr>
        <th data-sort="text">Location</th><th data-sort="num">Views</th>
        <th data-sort="num">Unique</th><th data-sort="num">Unverified</th>
        <th data-sort="text">Coordinates</th><th data-sort="text">Last seen</th>
      </tr></thead>
      <tbody>${
        points.length
          ? points
              .map(
                (p) => `<tr>
        <td>${esc(p.flag)} ${esc([p.city, p.region, p.country].filter(Boolean).join(", ") || "Unknown")}</td>
        <td data-v="${p.c}">${num(p.c)}</td>
        <td class="dim" data-v="${p.u}">${num(p.u)}</td>
        <td class="dim" data-v="${p.unverified}">${p.unverified ? num(p.unverified) : "—"}</td>
        <td class="dim"><code>${p.lat.toFixed(1)}, ${p.lon.toFixed(1)}</code></td>
        <td class="dim">${p.last}</td></tr>`
              )
              .join("")
          : `<tr><td colspan="6" class="empty">No located visits in this range.</td></tr>`
      }</tbody>
    </table></div>
  </div>
</section>

<section class="panel" data-panel="clients" hidden>
  <div class="card">
    <h2>Recent visits <span class="hint" id="recent-n"></span></h2>
    <div class="toolbar"><input data-filters="recent" placeholder="Filter by IP, city, page, network…"></div>
    <div class="scroll"><table id="recent">
      <thead><tr>
        <th data-sort="num">Time</th><th data-sort="text">IP</th><th data-sort="text">Location</th>
        <th data-sort="text">Network</th><th data-sort="text">Page</th>
        <th data-sort="text">Referrer</th><th data-sort="text">Device</th>
      </tr></thead>
      <tbody>${
        d.recent.length
          ? d.recent.map(recentRow).join("")
          : `<tr><td colspan="7" class="empty">No data in this range.</td></tr>`
      }</tbody>
    </table></div>
  </div>

  <div class="grid">
    ${ipCard("Most frequent IPs", "ips", d.ips)}
    ${ipCard("Unverified IPs", "uips", d.unverifiedIps,
      "Real addresses from hits that carried no Origin or Referer — typically restricted-region browsers and stripping proxies. Kept out of every figure above.")}
  </div>

  <div class="card">
    <h2>Behind a proxy or mirror <span class="hint">${num(d.proxiedTotal.hits)} hits from ${num(
      d.proxiedTotal.addresses
    )} address${d.proxiedTotal.addresses === 1 ? "" : "es"} · top 25 pairs</span></h2>
    <div class="scroll"><table id="proxied">
      <thead><tr>
        <th data-sort="text">Browser's own IP</th><th data-sort="text">Connecting IP</th>
        <th data-sort="text">Location of connection</th><th data-sort="text">Via</th>
        <th data-sort="num">Hits</th><th data-sort="num">Last seen</th>
      </tr></thead>
      <tbody>${
        d.proxied.length
          ? d.proxied
              .map(
                (r) => `<tr>
        <td><code class="ip" data-ip="${esc(r.client_ip)}">${esc(r.client_ip)}</code></td>
        <td class="dim"><code class="ip" data-ip="${esc(r.ip || "")}">${esc(r.ip || "—")}</code></td>
        <td>${esc(flag(r.country))} ${esc([r.city, r.country].filter(Boolean).join(", ") || "—")}</td>
        <td class="dim">${r.origin_host ? esc(r.origin_host) : r.unverified ? '<span class="tag">unverified</span>' : "—"}</td>
        <td data-v="${r.c}">${num(r.c)}</td>
        ${tsCell(r.last_ts)}</tr>`
              )
              .join("")
          : `<tr><td colspan="6" class="empty">Nothing in this range. This table fills in when a
             client's browser reports a different public address than the one that reached the edge —
             the usual sign of a mirror, a corporate proxy or a VPN.</td></tr>`
      }</tbody>
    </table></div>
  </div>
</section>

<section class="panel" data-panel="delivery" hidden>
  <div class="tiles">
    ${tile(d.transports.reduce((a, t) => a + t.c, 0), "Delivered hits", null, 0)}
    ${latencyTile(d.sendLatency)}
    ${tile(d.unverified.views, "Unverified", null, 0, "quiet")}
    ${tile(d.unverified.with_ip, "…of those, with an IP", null, 0, "quiet")}
    ${tile(d.optouts.hits, "DNT/GPC opt-outs", null, 0, "quiet")}
    ${tile(d.summary.bots, "Bot hits filtered", null, 0, "quiet")}
  </div>
  <div class="grid">
    ${rankCard("Delivery transport", d.transports)}
    ${rankCard("Opt-out visits by country", d.optoutCountries, { flags: true })}
  </div>
  ${latencyCard(d.sendLatency)}
  <div class="card">
    <h2>How to read these</h2>
    <p class="note"><b>Transport</b> is how the hit arrived: <code>load</code> is the primary
      keepalive <code>fetch</code>; <code>pixel</code> and <code>nojs</code> are the
      <code>&lt;img&gt;</code> fallbacks; <code>bfcache</code> is a back/forward-cache restore.
      A high <code>pixel</code> share means something between the client and this Worker is
      blocking the main transport.</p>
    <p class="note"><b>Unverified</b> hits (${num(d.unverified.views)} here, from ${num(
      d.unverified.countries
    )} countr${d.unverified.countries === 1 ? "y" : "ies"}) arrived with neither an
      <code>Origin</code> nor a <code>Referer</code> header, so nothing proves they came from this
      site. Their IP, geo and network <em>are</em> recorded — that is the only way clients on
      referrer-stripping browsers and proxies get counted at all — but nothing the page volunteered
      is kept, and they stay out of every trusted figure. Set <code>PROFILE_UNVERIFIED="false"</code>
      to go back to storing no address for them.</p>
    <p class="note"><b>Opt-outs</b> (${num(d.optouts.hits)}${
      d.optouts.countries ? ` across ${num(d.optouts.countries)} countries` : ""
    }) sent Do-Not-Track or Global Privacy Control. They are counted in aggregate and never
      profiled: no IP, no id, no user agent, no city. Set <code>count_optouts: false</code> in
      <code>_config.yml</code> to drop them entirely instead.</p>
  </div>
</section>

<section class="panel" data-panel="restricted" hidden>
  <div class="tiles">
    ${tile(d.relayedTotal.hits, "Relayed connections", null, 0)}
    ${tile(d.relayedTotal.zones, "…across this many clocks", null, 0, "quiet")}
    ${tile(d.recovered.hits, "Recovered from a dead network", null, 0)}
    ${tile(d.failoverTotal.hits, "Hits that needed a fallback", null, 0, "quiet")}
  </div>

  <div class="card">
    <h2>Where clients say they are
      <span class="hint">browser clock vs. the address it arrived from · top 25</span></h2>
    <p class="note">Cloudflare reads a location off the connecting address. When the site is
      read through a VPN, a mirror or a proxy that address belongs to the exit, not the client,
      and every one of them lands in the wrong city. The browser's own IANA timezone is the
      client's. Rows below are the ones where the two disagree.</p>
    <div style="height:10px"></div>
    <div class="scroll"><table id="relayed">
      <thead><tr><th data-sort="text">Client's clock</th>
        <th data-sort="text">Address resolves to</th>
        <th data-sort="num">Hits</th><th data-sort="num">Last seen</th></tr></thead>
      <tbody>${
        d.relayed.length
          ? d.relayed
              .map(
                (r) => `<tr>
        <td><code>${esc(r.k)}</code>${
                  r.queued ? `<br><span class="tag">${num(r.queued)} recovered</span>` : ""
                }</td>
        <td>${esc(flag(r.country))} <code class="dim">${esc(r.ip_tz)}</code>
          <span class="dim trunc"> · ${esc([r.city, r.country].filter(Boolean).join(", ") || "—")}${
                  r.as_org ? " · " + esc(r.as_org) : ""
                }</span>${r.unverified ? ' <span class="tag">unverified</span>' : ""}</td>
        <td data-v="${r.c}">${num(r.c)}<span class="dim"> · ${num(r.u)}u</span></td>
        ${tsCell(r.last_ts)}</tr>`
              )
              .join("")
          : `<tr><td colspan="4" class="empty">No relayed connections in this range.</td></tr>`
      }</tbody>
    </table></div>
  </div>

  <div class="card">
    <h2>Recovered pageviews
      <span class="hint">${
        d.recovered.longest ? "longest wait " + dur(d.recovered.longest) + " · " : ""
      }most recent 25</span></h2>
    <p class="note">Visits that reached no endpoint at all when they happened. The browser kept
      them and replayed them from a network that worked — so the time below is when the visit
      <em>happened</em>, not when it arrived. <b>Address at the time</b> is the address the browser
      found for itself <em>during</em> the visit and carried through the queue; it is the client's
      real one. <b>Delivered from</b> is only the route out, and is deliberately kept out of the
      country, city, network and map figures so a visit made on one network is never filed
      under the country it escaped through.</p>
    <div style="height:10px"></div>
    <div class="scroll"><table id="recovered">
      <thead><tr><th data-sort="num">Visited</th><th data-sort="num">Waited</th>
        <th data-sort="text">Address at the time</th><th data-sort="text">Client's clock</th>
        <th data-sort="text">Delivered from</th><th data-sort="text">Page</th></tr></thead>
      <tbody>${
        d.recoveredRows.length
          ? d.recoveredRows
              .map(
                (r) => `<tr>
        ${tsCell(r.ts)}
        <td data-v="${r.queued_ms}">${dur(r.queued_ms)}</td>
        <td>${
                  r.client_ip
                    ? `<code class="ip" data-ip="${esc(r.client_ip)}">${esc(r.client_ip)}</code>`
                    : '<span class="dim">not resolvable</span>'
                }</td>
        <td><code>${esc(r.client_tz || "—")}</code></td>
        <td>${esc(flag(r.country))} ${esc([r.city, r.country].filter(Boolean).join(", ") || "—")}
          ${r.failovers ? `<span class="dim"> · ${num(r.failovers)} failed first</span>` : ""}</td>
        <td class="trunc">${esc(r.path || "—")}</td></tr>`
              )
              .join("")
          : `<tr><td colspan="6" class="empty">Nothing recovered in this range.</td></tr>`
      }</tbody>
    </table></div>
  </div>

  <div class="card">
    <h2>If this page is empty</h2>
    <p class="note">Empty means one of two things, and they are not the same: nobody visited from
      a restricted network, or they did and nothing about them could ever reach here. Every URL in
      <code>_config.yml</code> is on one hostname, and a network that blocks that hostname blocks
      all of them at once — racing endpoints cannot help, because there is nothing to race
      against. The queue above recovers such a visit only if the same browser later reaches the
      site from a network that works.</p>
    <p class="note">The fix that recovers them <em>as they happen</em> is a second collector on a
      <b>different host</b>, added to <code>extra_endpoints</code>. See
      <b>Unreachable networks</b> in <code>edge/README.md</code> — including how to get a hostname
      for nothing, and how to check it is reachable before trusting it.</p>
  </div>
</section>

<footer>
  <div>
    <a href="/stats.json${qs({})}">JSON</a> ·
    <a href="/export.csv${qs({})}">CSV export</a> ·
    keys <b>1</b>–<b>6</b> switch tabs, <b>/</b> focuses a filter
  </div>
  <div>Times are UTC unless the header toggle says otherwise. Locations are Cloudflare's
    city-level edge geolocation, not precise addresses.</div>
</footer>
</div>

<script>
  var WORLD_MASK = ${JSON.stringify(WORLD_MASK)};
  var MAP_W = ${MAP_W}, MAP_H = ${MAP_H};
  var MAP_LAT_TOP = ${MAP_LAT_TOP}, MAP_LAT_BOTTOM = ${MAP_LAT_BOTTOM};
</script>
<script>${DASH_JS}</script>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Coarse on purpose: the interesting thing about a recovered pageview is the
// order of magnitude it waited, not the minute.
// Milliseconds, at the resolution a send path is argued about in.
function millis(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n < 1000 ? Math.round(n) + " ms" : (n / 1000).toFixed(n < 10000 ? 2 : 1) + " s";
}

function latencyTile(l) {
  const has = l && l.n;
  return `<div class="tile${has && l.p50 <= 250 ? "" : " quiet"}">
    <span class="v">${has ? esc(millis(l.p50)) : "—"}</span>
    <span class="l">Median time to send</span>
    ${has ? `<span class="d">p95 ${esc(millis(l.p95))}</span>` : ""}</div>`;
}

// The send path's own report card. Everything else on this page counts hits
// that arrived; this is the only figure that speaks to the ones that did not,
// because the visitors lost to a slow send are precisely the ones with no row.
function latencyCard(l) {
  if (!l || !l.n) {
    return `<div class="card"><h2>Time to send</h2>
      <div class="empty">No timing reported yet in this range. Clients send it from
      <code>performance.now()</code>; rows recorded before that shipped, replays, and clients with
      no performance clock are all excluded.</div></div>`;
  }
  const pct = Math.round((l.under1s / l.n) * 100);
  const good = l.p50 <= 250;
  return `<div class="card">
    <h2>Time to send <span class="hint">navigation start → pageview handed to the network</span></h2>
    <div class="tiles" style="margin:0 0 12px">
      <div class="tile"><span class="v">${esc(millis(l.p50))}</span><span class="l">Median</span></div>
      <div class="tile"><span class="v">${esc(millis(l.p95))}</span><span class="l">95th percentile</span></div>
      <div class="tile"><span class="v">${pct}%</span><span class="l">Sent within 1s</span></div>
      <div class="tile quiet"><span class="v">${esc(millis(l.worst))}</span><span class="l">Slowest</span></div>
    </div>
    <p class="note">The client is sent from <code>&lt;head&gt;</code> the moment it parses, before
      the stylesheet, before any render-blocking script, and without waiting for
      <code>DOMContentLoaded</code> — with a <code>preconnect</code> emitted earlier still, so the
      connection is already open when the request is made. ${
        good
          ? `A median of ${esc(millis(l.p50))} means essentially everyone who opens a page is counted.`
          : `A median of ${esc(millis(l.p50))} is high: anyone who closes the tab sooner than that is
             not counted at all, and will never appear anywhere on this dashboard.`
      }</p>
    <p class="note">This measures dispatch, not delivery — the hedged endpoint race and the
      store-and-forward queue are what handle a request that fails <em>after</em> it goes out.
      Replays are excluded, since their latency belongs to the pageview that was queued, not to the
      delivery that finally carried it.</p>
  </div>`;
}

function dur(ms) {
  if (!ms && ms !== 0) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h";
  return Math.round(h / 24) + "d";
}

function tile(value, label, prev, days, cls) {
  let delta = "";
  if (days && prev !== null && prev !== undefined) {
    const now = value || 0;
    const before = prev || 0;
    if (before > 0) {
      const pc = Math.round(((now - before) / before) * 100);
      const dir = pc > 0 ? "up" : pc < 0 ? "down" : "";
      delta = `<span class="d ${dir}">${pc > 0 ? "+" : ""}${pc}% vs previous ${rangeLabel(days)}</span>`;
    } else if (now > 0) {
      delta = `<span class="d up">new in this period</span>`;
    }
  }
  return `<div class="tile${cls ? " " + cls : ""}"><span class="v">${num(value)}</span>
    <span class="l">${label}</span>${delta}</div>`;
}

function rankCard(title, rows, opts) {
  const { flags = false, label = (k) => k } = opts || {};
  if (!rows.length)
    return `<div class="card"><h2>${title}</h2><div class="empty">No data in this range.</div></div>`;
  const max = Math.max(...rows.map((r) => r.c));
  const total = rows.reduce((a, r) => a + r.c, 0);
  const items = rows
    .map(
      (r) => `<li>
      <span class="k" title="${esc(r.k)}">${flags ? esc(flag(r.k)) + " " : ""}${esc(label(r.k))}</span>
      <span class="c">${num(r.c)}${r.u ? `<span class="dim"> · ${num(r.u)}u</span>` : ""}</span>
      <span class="pc">${total ? Math.round((r.c / total) * 100) : 0}%</span>
      <span class="track"><i style="width:${Math.max(1.5, (r.c / max) * 100)}%"></i></span></li>`
    )
    .join("");
  return `<div class="card"><h2>${title}</h2><ul class="rank">${items}</ul></div>`;
}

function ipCard(title, id, rows, hint) {
  return `<div class="card">
    <h2>${title}<span class="hint">click an address to copy</span></h2>
    ${hint ? `<p class="note">${hint}</p><div style="height:10px"></div>` : ""}
    <div class="scroll"><table id="${id}">
      <thead><tr><th data-sort="text">IP</th><th data-sort="num">Hits</th>
        <th data-sort="text">Location</th><th data-sort="num">Last seen</th></tr></thead>
      <tbody>${
        rows.length
          ? rows
              .map(
                (r) => `<tr>
        <td><code class="ip" data-ip="${esc(r.ip)}">${esc(r.ip)}</code>${
                  r.client_ip ? `<br><code class="ip dim" data-ip="${esc(r.client_ip)}">via ${esc(r.client_ip)}</code>` : ""
                }</td>
        <td data-v="${r.c}">${num(r.c)}</td>
        <td>${esc(flag(r.country))} ${esc([r.city, r.country].filter(Boolean).join(", ") || "—")}
          ${r.as_org ? `<span class="dim trunc"> · ${esc(r.as_org)}</span>` : ""}</td>
        ${tsCell(r.last_ts)}</tr>`
              )
              .join("")
          : `<tr><td colspan="4" class="empty">No data in this range.</td></tr>`
      }</tbody>
    </table></div>
  </div>`;
}

function recentRow(r) {
  return `<tr>
    ${tsCell(r.ts, true)}
    <td><code class="ip" data-ip="${esc(r.ip || "")}">${esc(r.ip || "—")}</code>${
    r.client_ip ? `<br><code class="ip dim" data-ip="${esc(r.client_ip)}">via ${esc(r.client_ip)}</code>` : ""
  }</td>
    <td>${esc(flag(r.country))} ${esc([r.city, r.region, r.country].filter(Boolean).join(", ") || "—")}</td>
    <td class="dim"><span class="trunc">${esc(r.as_org || "—")}</span></td>
    <td><span class="trunc">${esc(r.path || "—")}</span></td>
    <td class="dim"><span class="trunc">${esc(shortRef(r.referrer))}</span></td>
    <td class="dim"><span class="trunc">${esc(device(r.user_agent))}</span>${
    r.transport && r.transport !== "load" ? ` <span class="tag">${esc(r.transport)}</span>` : ""
  }</td></tr>`;
}

// One cell that can be re-rendered client-side in the viewer's own timezone.
function tsCell(ts, withTime) {
  const utc = fmtDate(ts, withTime !== false);
  return `<td class="dim" data-v="${ts || 0}"><span data-ts="${ts || 0}" data-utc="${utc}">${utc}</span></td>`;
}

function chart(series) {
  if (!series.length) return `<div class="empty">No data in this range.</div>`;
  const W = 1000, H = 184, PT = 10, PB = 4;
  const n = series.length;
  const max = Math.max(...series.map((r) => r.c), 1);
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v) => PT + (1 - v / max) * (H - PT - PB);
  const path = (key) =>
    series.map((r, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(r[key]).toFixed(1)).join(" ");
  const area =
    `M0 ${H - PB} ` +
    series.map((r, i) => "L" + x(i).toFixed(1) + " " + y(r.c).toFixed(1)).join(" ") +
    ` L${W} ${H - PB} Z`;
  const bw = n === 1 ? W : W / n;
  const hot = series
    .map(
      (r, i) => `<rect class="hot" x="${(x(i) - bw / 2).toFixed(1)}" y="0" width="${bw.toFixed(1)}"
      height="${H}" data-d="${esc(r.d)}" data-c="${r.c}" data-u="${r.u}"
      data-x="${x(i).toFixed(1)}" data-y="${y(r.c).toFixed(1)}"></rect>`
    )
    .join("");
  return `<div class="chartwrap">
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Pageviews per day">
      <line class="grid-l" x1="0" y1="${(H - PB).toFixed(1)}" x2="${W}" y2="${(H - PB).toFixed(1)}"></line>
      <line class="grid-l" x1="0" y1="${y(max / 2).toFixed(1)}" x2="${W}" y2="${y(max / 2).toFixed(1)}"
            stroke-dasharray="2 5"></line>
      <path class="area" d="${area}"></path>
      <path class="line" d="${path("c")}"></path>
      <path class="uline" d="${path("u")}"></path>
      <line class="cursor" x1="0" y1="0" x2="0" y2="${H}"></line>
      ${hot}
    </svg>
    <div class="tipbox"></div>
    <div class="axis"><span>${esc(series[0].d)}</span><span>peak ${num(max)} views/day</span>
      <span>${esc(series[n - 1].d)}</span></div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* auth + CORS                                                         */
/* ------------------------------------------------------------------ */

async function guard(request, env, url, fn) {
  const expected = env.DASHBOARD_TOKEN;
  if (!expected) {
    return new Response(
      "DASHBOARD_TOKEN is not set. Run: wrangler secret put DASHBOARD_TOKEN",
      { status: 500 }
    );
  }
  const given =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(given, expected)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  return fn();
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function splitList(v) {
  return (v || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function allowedList(env) {
  return splitList(env.ALLOWED_ORIGINS);
}

// Extra origins the owner has decided are also this site: a mirror on another
// host, a reverse proxy, a staging copy. Entries may be exact origins
// ("https://m.example.net") or wildcards ("https://*.example.net"). Hits from
// them are recorded in full, with the origin kept in `origin_host` so a mirror
// can be told apart from the site itself.
function mirrorMatches(candidate, env) {
  const host = safeHost(candidate);
  if (!host) return false;
  return splitList(env.MIRROR_ORIGINS).some((pattern) => {
    if (pattern === candidate) return true;
    const p = safeHost(pattern) || pattern.replace(/^\*\./, "");
    if (!p) return false;
    if (p.startsWith("*.")) {
      const base = p.slice(2).toLowerCase();
      return host === base || host.endsWith("." + base);
    }
    return host === p.toLowerCase();
  });
}

// "allowed"   — Origin/Referer present and on the allowlist
// "mirror"    — present, not ours, but listed in MIRROR_ORIGINS
// "no-origin" — neither header sent; recorded, but flagged unverified
// "denied"    — a real origin was sent and it is none of the above
function originVerdict(request, env) {
  const list = allowedList(env);
  if (!list.length) return "allowed";
  const candidate = presentedOrigin(request);
  if (!candidate) return "no-origin";
  if (list.includes(candidate)) return "allowed";
  if (mirrorMatches(candidate, env)) return "mirror";
  return "denied";
}

function presentedOrigin(request) {
  const origin = request.headers.get("origin");
  const ref = request.headers.get("referer");
  const candidate = origin || (ref ? safeOrigin(ref) : null);
  return candidate ? candidate.replace(/\/$/, "") : null;
}

function originHost(request) {
  return safeHost(presentedOrigin(request));
}

function preflight(request, env) {
  return cors(new Response(null, { status: 204 }), request, env);
}

function cors(response, request, env) {
  const list = allowedList(env);
  const origin = request.headers.get("origin");
  // Mirrors have to be echoed too, or the keepalive fetch from a mirrored page
  // fails CORS and falls all the way down to the pixel for no reason.
  const allow = !list.length
    ? "*"
    : origin && (list.includes(origin.replace(/\/$/, "")) || mirrorMatches(origin.replace(/\/$/, ""), env))
    ? origin
    : null;
  if (allow) {
    response.headers.set("access-control-allow-origin", allow);
    response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
    response.headers.set("access-control-allow-headers", "content-type");
    response.headers.set("access-control-max-age", "86400");
    if (allow !== "*") response.headers.set("vary", "Origin");
  }
  return response;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function sha256(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function anonymiseIp(ip) {
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::";
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-f:]{2,45}$/i;

// The client-reported address is the one page-supplied value that lands in a
// network-metadata column, so it is validated hard: well-formed, and public.
// A private, loopback or link-local answer means the echo service saw a LAN
// address, which locates nothing and would only add noise.
function publicIp(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase().replace(/^\[|\]$/g, "");
  const m = s.match(IPV4_RE);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    if (o[0] === 10 || o[0] === 127 || o[0] === 0 || o[0] >= 224) return null;
    if (o[0] === 192 && o[1] === 168) return null;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return null;
    if (o[0] === 169 && o[1] === 254) return null;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return null; // CGNAT
    return o.join(".");
  }
  if (!s.includes(":") || !IPV6_RE.test(s)) return null;
  if (s === "::1" || s === "::") return null;
  if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s)) return null; // ULA, link-local
  return s;
}

// Query-string values arrive as strings, so "0" and "false" are truthy in
// JavaScript. Anything that means "no" has to be rejected explicitly.
function truthy(v) {
  if (v === undefined || v === null || v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "null" && s !== "undefined";
}

// IP_SALT is a write-only secret: it cannot be read back out of Cloudflare, so
// a second deployment configured by hand can easily end up without it — and the
// old `env.IP_SALT || "no-salt"` then produced a *working* endpoint whose
// ip_hash values simply did not match the other deployment's. Every client seen
// by both would count twice, with nothing anywhere saying so. It still falls
// back, because refusing the hit would lose the request outright, but it says so
// once per isolate so `wrangler tail` shows it.
let saltWarned = false;
function salt(env) {
  if (env.IP_SALT) return env.IP_SALT;
  if (!saltWarned) {
    saltWarned = true;
    console.error(
      "IP_SALT is not set on this deployment. Unique-client counts from it " +
        "will not line up with any other collector sharing this database. Set " +
        "it to the SAME value as the other one."
    );
  }
  return "no-salt";
}

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).slice(0, max);
  return s === "" ? null : s;
}

// An IANA zone name and nothing else: "Asia/Tokyo", "Europe/Athens",
// "America/Argentina/Buenos_Aires", "Etc/GMT+8", "UTC". This is stored on rows
// that nobody can attribute to this site, so it is matched against a shape
// rather than merely truncated — the column has to stay a timezone whoever
// sends it.
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]{0,24}(?:\/[A-Za-z0-9_+.-]{1,26}){0,2}$/;
function ianaTz(v) {
  const s = str(v, 64);
  return s && TZ_RE.test(s) ? s : null;
}

// Minutes east of UTC. Real offsets run from -12:00 to +14:00; anything outside
// that is not a clock, and a non-integer is not one either.
function offsetMinutes(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= -720 && n <= 840 ? n : null;
}

// How long a replayed hit sat in the browser's queue, in milliseconds. Anything
// under a minute is a live hit, whatever it claims, and anything past the
// queue's own retention window plus slack is a clock that cannot be trusted;
// both are treated as "not a replay" rather than rejected, so the pageview is
// still counted — just at the time it arrived.
const REPLAY_MIN_MS = 60000;
const REPLAY_MAX_MS = 45 * 86400000;
function replayAge(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const ms = Math.round(n);
  return ms >= REPLAY_MIN_MS && ms <= REPLAY_MAX_MS ? ms : null;
}

// Time-to-send, as the page measured it with performance.now(). Anything
// negative means the browser had no usable clock and is stored as unknown
// rather than as zero, which would flatter the median. The upper bound is ten
// minutes: beyond that the value came from a tab left parked, not from a send
// path, and averaging it in would say nothing useful.
const LATENCY_MAX_MS = 600000;
function latencyMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > LATENCY_MAX_MS) return null;
  return n;
}

// A small non-negative counter from the page, clamped. Used for `failovers`,
// where a wrong number is cosmetic but an unbounded one is a column full of
// whatever a caller felt like sending.
function countBounded(v, max) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

function safeOrigin(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function safeHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pathFromReferer(request) {
  const ref = request.headers.get("referer");
  if (!ref) return null;
  try {
    return new URL(ref).pathname;
  } catch {
    return null;
  }
}

function parseRange(v) {
  const n = parseInt(v ?? "30", 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function rangeLabel(days) {
  if (!days) return "all time";
  if (days === 1) return "24h";
  if (days === 365) return "1 year";
  return days + " days";
}

function num(n) {
  return (n || 0).toLocaleString("en-US");
}

// JSON for a <script type="application/json"> block: the only sequence that can
// end the block early is "</", so that is the only one that has to go.
function jsonScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function fmtDate(ts, withTime) {
  if (!ts) return "—";
  const iso = new Date(ts).toISOString();
  return withTime ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

function shortRef(r) {
  if (!r) return "direct";
  try {
    const u = new URL(r);
    return u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return r;
  }
}

function device(ua) {
  if (!ua) return "—";
  const os = /Windows/.test(ua) ? "Windows"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux" : "?";
  const br = /MicroMessenger/.test(ua) ? "WeChat"
    : /QQBrowser|MQQBrowser/.test(ua) ? "QQ"
    : /UCBrowser|UCWEB/.test(ua) ? "UC"
    : /Quark/.test(ua) ? "Quark"
    : /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox" : "?";
  return `${os} · ${br}`;
}

// ISO-3166 alpha-2 -> regional indicator emoji
function flag(cc) {
  if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return "🏳";
  return String.fromCodePoint(
    ...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function pixelResponse() {
  return new Response(PIXEL, {
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
