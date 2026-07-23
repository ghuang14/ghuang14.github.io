/**
 * Self-hosted visitor tracker for ghuang14.github.io
 *
 * Replaces ClustrMaps / MapMyVisitors, both of which are effectively dead.
 * Runs on Cloudflare Workers, stores rows in D1 (SQLite).
 *
 * Routes
 *   POST|GET /hit          record a pageview (called by the beacon on the site)
 *   GET      /stats        HTML dashboard          (needs ?token=)
 *   GET      /stats.json   same numbers as JSON    (needs ?token=)
 *   GET      /export.csv   raw rows as CSV         (needs ?token=)
 *
 * The client IP comes from Cloudflare's CF-Connecting-IP header, and the geo /
 * network fields come from `request.cf` — no third-party geo-IP lookup needed.
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
      case "/hit":
        return handleHit(request, env, ctx, url);
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
/* collection                                                          */
/* ------------------------------------------------------------------ */

async function handleHit(request, env, ctx, url) {
  const wantsPixel = url.searchParams.get("f") === "gif";

  // Only accept hits coming from the site itself, so the endpoint can't be
  // trivially spammed from elsewhere.
  if (!originAllowed(request, env)) {
    return wantsPixel ? pixelResponse() : cors(new Response(null, { status: 403 }), request, env);
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
  }

  const cf = request.cf || {};
  const ua = request.headers.get("user-agent") || "";
  const rawIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "";

  const storeFull = env.STORE_FULL_IP !== "false";
  const row = {
    ts: Date.now(),
    ip: rawIp ? (storeFull ? rawIp : anonymiseIp(rawIp)) : null,
    ip_hash: await sha256(rawIp + "|" + (env.IP_SALT || "no-salt")),
    country: cf.country || null,
    region: cf.region || null,
    city: cf.city || null,
    postal: cf.postalCode || null,
    latitude: cf.latitude || null,
    longitude: cf.longitude || null,
    timezone: cf.timezone || null,
    asn: typeof cf.asn === "number" ? cf.asn : null,
    as_org: cf.asOrganization || null,
    colo: cf.colo || null,
    path: str(payload.p, 512) || pathFromReferer(request),
    title: str(payload.t, 300),
    referrer: str(payload.r, 512),
    user_agent: ua.slice(0, 400) || null,
    lang: str(payload.l, 40),
    screen: str(payload.s, 40),
    visitor_id: str(payload.v, 64),
    is_new: payload.n ? 1 : 0,
    is_bot: BOT_RE.test(ua) || !ua ? 1 : 0,
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

function insert(env, r) {
  return env.DB.prepare(
    `INSERT INTO visits
       (ts, ip, ip_hash, country, region, city, postal, latitude, longitude,
        timezone, asn, as_org, colo, path, title, referrer, user_agent, lang,
        screen, visitor_id, is_new, is_bot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      r.ts, r.ip, r.ip_hash, r.country, r.region, r.city, r.postal,
      r.latitude, r.longitude, r.timezone, r.asn, r.as_org, r.colo,
      r.path, r.title, r.referrer, r.user_agent, r.lang, r.screen,
      r.visitor_id, r.is_new, r.is_bot
    )
    .run()
    .catch((err) => console.error("insert failed", err));
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

async function collect(env, url) {
  const days = parseRange(url.searchParams.get("days"));
  const since = days === 0 ? 0 : Date.now() - days * 86400000;
  const bots = url.searchParams.get("bots") === "1";
  const botFilter = bots ? "" : "AND is_bot = 0";
  const dayStart = new Date().setUTCHours(0, 0, 0, 0);

  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const top = (expr, alias) =>
    q(
      `SELECT ${expr} AS k, COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u
         FROM visits WHERE ts >= ? ${botFilter} AND ${alias} IS NOT NULL AND ${alias} != ''
        GROUP BY k ORDER BY c DESC LIMIT 12`,
      since
    );

  const [summary, botCount, today, series, countries, cities, pages, referrers, networks, ips, recent, lifetime] =
    await env.DB.batch([
      // Must carry botFilter, otherwise the headline numbers silently include
      // the traffic the dashboard claims to be filtering out.
      q(
        `SELECT COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS uniques,
                COUNT(DISTINCT country) AS countries
           FROM visits WHERE ts >= ? ${botFilter}`,
        since
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
      top("country", "country"),
      top("city || ', ' || COALESCE(country, '??')", "city"),
      top("path", "path"),
      top("referrer", "referrer"),
      top("'AS' || asn || ' · ' || COALESCE(as_org, '?')", "asn"),
      q(
        `SELECT ip, COUNT(*) AS c, MAX(ts) AS last_ts,
                MAX(country) AS country, MAX(city) AS city, MAX(as_org) AS as_org
           FROM visits WHERE ts >= ? ${botFilter} AND ip IS NOT NULL
          GROUP BY ip ORDER BY c DESC, last_ts DESC LIMIT 25`,
        since
      ),
      q(
        `SELECT ts, ip, country, region, city, as_org, path, referrer, user_agent, is_bot
           FROM visits WHERE ts >= ? ${botFilter}
          ORDER BY ts DESC LIMIT 60`,
        since
      ),
      // Unfiltered, so the header can show when tracking actually started.
      q(`SELECT MIN(ts) AS first_ts, COUNT(*) AS views FROM visits`),
    ]);

  return {
    range: { days, since, bots },
    lifetime: lifetime.results[0] || {},
    summary: { ...(summary.results[0] || {}), ...(botCount.results[0] || {}) },
    today: today.results[0] || {},
    series: series.results,
    countries: countries.results,
    cities: cities.results,
    pages: pages.results,
    referrers: referrers.results,
    networks: networks.results,
    ips: ips.results,
    recent: recent.results,
  };
}

async function handleStatsJson(env, url) {
  const data = await collect(env, url);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleExport(env, url) {
  const days = parseRange(url.searchParams.get("days"));
  const since = days === 0 ? 0 : Date.now() - days * 86400000;
  const { results } = await env.DB.prepare(
    `SELECT ts, ip, country, region, city, postal, latitude, longitude, timezone,
            asn, as_org, colo, path, title, referrer, lang, screen, visitor_id,
            is_new, is_bot, user_agent
       FROM visits WHERE ts >= ? ORDER BY ts DESC LIMIT 50000`
  )
    .bind(since)
    .all();

  const cols = results.length ? Object.keys(results[0]) : ["ts"];
  const esc = (v) =>
    v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`;
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

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Visitors · ghuang14.github.io</title>
<style>
  :root{--bg:#fbfbfa;--card:#fff;--fg:#1a1a19;--muted:#6b6b68;--line:#e6e5e2;--accent:#c05f3c;--accent-soft:#f2e3dc}
  @media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--fg:#f0efec;--muted:#9a9994;--line:#2f2f2c;--accent:#e08b6b;--accent-soft:#3a2a23}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1120px;margin:0 auto;padding:32px 20px 72px}
  h1{font-size:20px;margin:0;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:13px;margin-top:4px}
  header{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between;margin-bottom:24px}
  .chips{display:flex;gap:6px;flex-wrap:wrap}
  .chip{display:inline-block;padding:5px 11px;border:1px solid var(--line);border-radius:999px;font-size:12.5px;color:var(--muted);text-decoration:none;background:var(--card)}
  .chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .chip:hover:not(.on){border-color:var(--accent);color:var(--accent)}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .tile b{display:block;font-size:26px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .tile span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px;overflow:hidden}
  .card h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 12px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
  .grid .card{margin:0}
  .bars{display:flex;align-items:flex-end;gap:2px;height:120px}
  .bars i{flex:1;min-width:2px;background:var(--accent);border-radius:2px 2px 0 0;opacity:.85;display:block}
  .bars i:hover{opacity:1}
  .axis{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-top:6px}
  ul.rank{list-style:none;margin:0;padding:0}
  ul.rank li{position:relative;display:flex;justify-content:space-between;gap:12px;padding:5px 8px;border-radius:6px;font-size:13.5px;z-index:0}
  ul.rank li .fill{position:absolute;inset:0 auto 0 0;background:var(--accent-soft);border-radius:6px;z-index:-1}
  ul.rank li .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  ul.rank li .c{color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  tr:last-child td{border-bottom:0}
  code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
  .dim{color:var(--muted)}
  .trunc{max-width:260px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}
  footer{color:var(--muted);font-size:12px;margin-top:24px;display:flex;gap:14px;flex-wrap:wrap}
  footer a{color:var(--accent)}
  .empty{color:var(--muted);font-size:13px;padding:6px 8px}
</style>
</head><body><div class="wrap">

<header>
  <div>
    <h1>Visitors</h1>
    <div class="sub">ghuang14.github.io · ${
      d.lifetime.first_ts
        ? `${num(d.lifetime.views)} hits recorded since ${fmtDate(d.lifetime.first_ts)}`
        : "no data yet"
    }</div>
  </div>
  <div class="chips">${ranges}
    <a class="chip${d.range.bots ? " on" : ""}" href="${qs({ bots: d.range.bots ? null : "1" })}">incl. bots</a>
  </div>
</header>

<div class="tiles">
  <div class="tile"><b>${num(d.summary.views)}</b><span>Pageviews</span></div>
  <div class="tile"><b>${num(d.summary.uniques)}</b><span>Unique visitors</span></div>
  <div class="tile"><b>${num(d.summary.countries)}</b><span>Countries</span></div>
  <div class="tile"><b>${num(d.today.views)}</b><span>Today</span></div>
  <div class="tile"><b>${num(d.summary.bots)}</b><span>Bot hits filtered</span></div>
</div>

<div class="card">
  <h2>Pageviews per day</h2>
  ${chart(d.series)}
</div>

<div class="grid">
  ${rankCard("Countries", d.countries)}
  ${rankCard("Cities", d.cities)}
  ${rankCard("Pages", d.pages)}
  ${rankCard("Referrers", d.referrers)}
  ${rankCard("Networks (ASN)", d.networks)}
  <div class="card">
    <h2>Most frequent IPs</h2>
    <div class="scroll"><table>
      <tr><th>IP</th><th>Hits</th><th>Location</th><th>Last seen</th></tr>
      ${
        d.ips.length
          ? d.ips
              .map(
                (r) => `<tr>
        <td><code>${esc(r.ip)}</code></td>
        <td class="dim">${r.c}</td>
        <td>${esc(flag(r.country))} ${esc([r.city, r.country].filter(Boolean).join(", ") || "—")}</td>
        <td class="dim">${fmtDate(r.last_ts)}</td></tr>`
              )
              .join("")
          : `<tr><td colspan="4" class="empty">No data in this range.</td></tr>`
      }
    </table></div>
  </div>
</div>

<div class="card">
  <h2>Recent visits</h2>
  <div class="scroll"><table>
    <tr><th>Time (UTC)</th><th>IP</th><th>Location</th><th>Network</th><th>Page</th><th>Referrer</th><th>Device</th></tr>
    ${
      d.recent.length
        ? d.recent
            .map(
              (r) => `<tr>
      <td class="dim">${fmtDate(r.ts, true)}</td>
      <td><code>${esc(r.ip || "—")}</code></td>
      <td>${esc(flag(r.country))} ${esc([r.city, r.region, r.country].filter(Boolean).join(", ") || "—")}</td>
      <td class="dim"><span class="trunc">${esc(r.as_org || "—")}</span></td>
      <td><span class="trunc">${esc(r.path || "—")}</span></td>
      <td class="dim"><span class="trunc">${esc(shortRef(r.referrer))}</span></td>
      <td class="dim"><span class="trunc">${esc(device(r.user_agent))}</span></td></tr>`
            )
            .join("")
        : `<tr><td colspan="7" class="empty">No data in this range.</td></tr>`
    }
  </table></div>
</div>

<footer>
  <a href="/stats.json${qs({})}">JSON</a>
  <a href="/export.csv${qs({})}">CSV export</a>
  <span>Times shown in UTC.</span>
</footer>

</div></body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function rankCard(title, rows) {
  if (!rows.length)
    return `<div class="card"><h2>${title}</h2><div class="empty">No data in this range.</div></div>`;
  const max = Math.max(...rows.map((r) => r.c));
  const items = rows
    .map(
      (r) => `<li><span class="fill" style="width:${Math.max(2, (r.c / max) * 100)}%"></span>
      <span class="k">${title === "Countries" ? esc(flag(r.k)) + " " : ""}${esc(r.k)}</span>
      <span class="c">${r.c}<span class="dim"> · ${r.u}u</span></span></li>`
    )
    .join("");
  return `<div class="card"><h2>${title}</h2><ul class="rank">${items}</ul></div>`;
}

function chart(series) {
  if (!series.length) return `<div class="empty">No data in this range.</div>`;
  const max = Math.max(...series.map((r) => r.c), 1);
  const bars = series
    .map(
      (r) =>
        `<i style="height:${Math.max(2, (r.c / max) * 100)}%" title="${esc(r.d)} — ${r.c} views, ${r.u} unique"></i>`
    )
    .join("");
  return `<div class="bars">${bars}</div>
    <div class="axis"><span>${esc(series[0].d)}</span><span>peak ${max}/day</span><span>${esc(series[series.length - 1].d)}</span></div>`;
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

function allowedList(env) {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function originAllowed(request, env) {
  const list = allowedList(env);
  if (!list.length) return true;
  const origin = request.headers.get("origin");
  const ref = request.headers.get("referer");
  const candidate = origin || (ref ? safeOrigin(ref) : null);
  if (!candidate) return false;
  return list.includes(candidate.replace(/\/$/, ""));
}

function preflight(request, env) {
  return cors(new Response(null, { status: 204 }), request, env);
}

function cors(response, request, env) {
  const list = allowedList(env);
  const origin = request.headers.get("origin");
  const allow = !list.length ? "*" : list.includes(origin) ? origin : null;
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

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).slice(0, max);
  return s === "" ? null : s;
}

function safeOrigin(u) {
  try {
    return new URL(u).origin;
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

function num(n) {
  return (n || 0).toLocaleString("en-US");
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
  const br = /Edg\//.test(ua) ? "Edge"
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
