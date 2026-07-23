# Visitor tracker

Self-hosted replacement for ClustrMaps / MapMyVisitors, which are no longer
maintained. A small Cloudflare Worker receives a beacon from every pageview and
records the visitor's IP, geo and network details into a D1 (SQLite) database.
Everything stays in your own Cloudflare account — no third-party service that
can disappear.

The IP comes from Cloudflare's `CF-Connecting-IP` header and the geo/ASN fields
come from `request.cf`, so there is no external geo-IP lookup and nothing to
rate-limit.

**Why not plain Cloudflare?** `ghuang14.github.io` has no custom domain, so
Cloudflare can't proxy the site's DNS, and Cloudflare Web Analytics never
reports IP addresses by design. A Worker you ping directly is what gets you IPs.

## What gets recorded

Per pageview: timestamp, IP, salted IP hash, country/region/city/postcode,
approximate lat-lon, timezone, ASN + network operator, Cloudflare edge location,
path, page title, referrer, user agent, browser language, screen size, a
localStorage visitor id, and a bot flag.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /hit` | Record a pageview (called by the site) |
| `GET /hit?f=gif` | `<img>` fallback for browsers where `fetch`/`sendBeacon` fail |
| `GET /stats` | HTML dashboard — needs `?token=` |
| `GET /stats.json` | Same figures as JSON — needs `?token=` |
| `GET /export.csv` | Raw rows as CSV — needs `?token=` |

`/stats` accepts `?days=1|7|30|90|365|0` (`0` = all time) and `?bots=1` to
include traffic the bot filter would otherwise hide.

## How this runs in production

Nothing is tracked from a local build. The flow is:

1. You push to `master`.
2. GitHub Pages builds the Jekyll site on its own servers (this repo has no
   Pages workflow, so Pages' built-in Jekyll does it).
3. A visitor loads `https://ghuang14.github.io/...`. The beacon in
   `_includes/visitor-tracker.html` fires and the Worker records the hit.

The beacon deliberately does nothing on `localhost` / `127.0.0.1`, so running
`bundle exec jekyll serve` never pollutes your stats. `ALLOWED_ORIGINS` also
restricts hits to `https://ghuang14.github.io`.

The one-time Worker setup below is the only part that touches Cloudflare. After
that, `.github/workflows/deploy-tracker.yml` redeploys the Worker automatically
whenever you push a change under `tracker/` — see
[Deploying from GitHub](#deploying-from-github-no-local-tooling).

## Deploy

You need a free Cloudflare account. From this directory:

```bash
npm install
npx wrangler login
```

**1. Create the database** and copy the printed `database_id` into
`wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`:

```bash
npx wrangler d1 create visitor-tracker
```

**2. Create the table:**

```bash
npm run db:init
```

**3. Set the two secrets.** `DASHBOARD_TOKEN` is the password for `/stats`;
`IP_SALT` is a random string used when hashing IPs. Use long random values:

```bash
openssl rand -hex 24   # run twice, paste one into each prompt
npx wrangler secret put DASHBOARD_TOKEN
npx wrangler secret put IP_SALT
```

> Changing `IP_SALT` later re-buckets unique-visitor counts, so pick one and
> keep it.

**4. Deploy:**

```bash
npm run deploy
```

Wrangler prints your URL, e.g.
`https://visitor-tracker.<subdomain>.workers.dev`.

**5. Point the site at it.** In `_config.yml` at the repo root:

```yaml
visitor_tracker:
  endpoint               : "https://visitor-tracker.<subdomain>.workers.dev/hit"
  respect_dnt            : true
```

Commit and push. While `endpoint` is empty no tracking code is emitted at all.

**6. Open your dashboard:**

```
https://visitor-tracker.<subdomain>.workers.dev/stats?token=YOUR_DASHBOARD_TOKEN
```

Bookmark it. Anyone with that URL can read your visitor data, so treat it as a
password.

## Deploying from GitHub (no local tooling)

If you'd rather not install Node or wrangler at all, do the one-time setup in
the Cloudflare dashboard and let GitHub Actions handle every deploy after that.

**One-time, in the browser** at [dash.cloudflare.com](https://dash.cloudflare.com):

1. **Storage & Databases → D1 → Create**, name it `visitor-tracker`. Copy the
   database ID into `database_id` in `wrangler.toml` and commit that change.
2. **My Profile → API Tokens → Create Token**, using the *Edit Cloudflare
   Workers* template. **Then add one more permission before saving:
   `Account` → `D1` → `Edit`.** The template covers Workers but not D1, and
   without it creating the table fails with `Authentication error [code: 10000]`
   on `/d1/database/<id>/import`. Copy the token.

   Your own "Super Administrator" role does not help here — an API token only
   carries the scopes ticked when it was created. An existing token can be
   edited in place at
   [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens);
   the value stays the same, so the GitHub secret does not need updating.
3. In this GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**, name it exactly `CLOUDFLARE_API_TOKEN`, paste the token.
4. Push, or run the workflow from the **Actions** tab. It creates the table and
   deploys the Worker.
5. Back in Cloudflare, open the now-deployed `visitor-tracker` Worker →
   **Settings → Variables and Secrets** and add `DASHBOARD_TOKEN` and `IP_SALT`
   as *Secret* type, using long random values. Until `DASHBOARD_TOKEN` is set,
   `/stats` returns a 500 telling you so.

The `DB` binding does not need setting up by hand — it comes from the
`[[d1_databases]]` block in `wrangler.toml` on every deploy. Worker secrets set
in the dashboard survive redeploys.

**From then on**, pushing any change under `tracker/` triggers
`.github/workflows/deploy-tracker.yml`, which applies `schema.sql` and deploys
the Worker for you. You can also re-run it by hand from the repo's **Actions**
tab.

The workflow pins wrangler `4.113.0` on Node 22 (wrangler 4.113 requires Node
>= 22). To bump it later, change both `wranglerVersion` values in the workflow.

If you would rather not grant `D1:Edit`, delete the *Apply D1 schema* step from
the workflow and instead paste `schema.sql` once into the database's **Console**
tab in the dashboard. Deploying the Worker itself only needs Workers
permissions.

Adding this workflow does not change how your site is built — GitHub Pages'
Jekyll build is a repository setting and runs independently.

## Configuration (`[vars]` in `wrangler.toml`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `https://ghuang14.github.io` | Comma-separated origins allowed to post hits. Empty = accept anything. |
| `STORE_FULL_IP` | `"true"` | `"false"` stores an anonymised IP instead (IPv4 last octet zeroed, IPv6 truncated to /48). Unique counts keep working either way. |
| `RETENTION_DAYS` | `"0"` | Delete rows older than N days on the scheduled run. `0` = keep forever. |

To run the retention cleanup nightly, uncomment the `[triggers]` block in
`wrangler.toml` and redeploy.

## Local development

```bash
printf 'DASHBOARD_TOKEN=devtoken\nIP_SALT=devsalt\n' > .dev.vars
npm run db:init:local
npm run dev
```

Then `http://localhost:8787/stats?token=devtoken`. The beacon skips `localhost`,
so send test hits by hand:

```bash
curl -X POST 'http://localhost:8787/hit' \
  -H 'Origin: https://ghuang14.github.io' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  --data '{"p":"/publications/","r":"https://www.google.com/"}'
```

Note that `curl` matches the bot filter, so those hits appear only under
"incl. bots".

## Cost

Workers free tier is 100,000 requests/day and D1 gives 5 GB storage with
5 million row reads/day — orders of magnitude above what a personal academic
site generates. Rows are roughly 300 bytes.

## Useful queries

```bash
npx wrangler d1 execute visitor-tracker --remote \
  --command "SELECT country, COUNT(DISTINCT ip) FROM visits WHERE is_bot=0 GROUP BY country ORDER BY 2 DESC LIMIT 10;"

# who read a specific paper page
npx wrangler d1 execute visitor-tracker --remote \
  --command "SELECT datetime(ts/1000,'unixepoch') t, ip, city, country, as_org FROM visits WHERE path LIKE '/publications/%' AND is_bot=0 ORDER BY ts DESC LIMIT 30;"
```

## Privacy note

IP addresses are personal data under GDPR, and university/institutional traffic
is often directly identifiable via the ASN. If you want the analytics without
that exposure, set `STORE_FULL_IP="false"` — you keep every chart on the
dashboard except the raw-IP columns. `respect_dnt: true` in `_config.yml` also
makes the beacon skip visitors who send Do-Not-Track or Global Privacy Control.
