# Edge request log

Self-hosted replacement for an earlier third-party script, no longer
maintained. A small Cloudflare Worker receives a beacon from every pageview and
records the connecting address, geo and network metadata into a D1 (SQLite)
database. Everything stays in your own Cloudflare account — no third-party
service that can disappear.

The address comes from Cloudflare's `CF-Connecting-IP` header and the geo/ASN
fields come from `request.cf`, so there is no external geo lookup.

There is deliberately no rate limiting: the write path is cheap, and D1's free
tier allows 100k writes a day. A determined flood could still exhaust that, and
`insert()` only logs to the Worker console when a write fails, so watch
`npm run tail` if the numbers ever look wrong. Adding a Workers Rate Limiting
binding keyed on `ip_hash` is the fix if it ever matters.

**Why not plain Cloudflare?** `ghuang14.github.io` has no custom domain, so
Cloudflare can't proxy the site's DNS, and Cloudflare Web Analytics never
reports the connecting address by design. A Worker you ping directly does.

## What gets recorded

Per pageview: timestamp, the connecting address, its salted hash,
country/region/city/postcode, approximate lat-lon, timezone, ASN + network
operator, Cloudflare edge location, path, page title, referrer, user agent,
browser language, screen size, a localStorage client id, and a bot flag.

Plus, since the delivery rework: a per-pageview `event_id` (so several
transports for one pageview collapse into one row), `transport` (how the hit
arrived — `load`, `bfcache`, `hidden`, `pagehide`, `nojs`, `pixel`), `dnt`
(the client opted out), `origin_missing` (the request presented neither an
`Origin` nor a `Referer`), `client_ip` (the address the *browser* found for
itself, when it differs from the one that reached the edge) and `origin_host`
(which mirror a hit came through).

Two kinds of request are handled differently from an ordinary one:

* **`dnt` — Do-Not-Track / GPC.** Counted in aggregate only: path and country
  are stored and nothing else. No address, no user agent, no client id, no
  title, no referrer, no city. This is a legal opt-out and is not negotiable.
* **`origin_missing` — unverified.** Recorded in full, then quarantined. The
  address, geo, ASN and user agent are kept, because they are facts the network
  established and because throwing them away is what used to lose every request
  from a referrer-stripping browser. Nothing the *page* volunteered is kept —
  no title, referrer, client id, language or screen — and the row is excluded
  from every trusted figure on the dashboard, appearing only in the unverified
  tile, the unverified address table and its own share of a map bubble.
  `PROFILE_UNVERIFIED="false"` restores the old behaviour of storing no
  address at all.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /e` | Record a pageview (called by the site) |
| `GET /e?f=gif&z=…` | `<img>` fallback; `z` carries the same JSON payload |
| `GET /e.gif` | Same, for callers that need the URL to end in `.gif` |
| `POST\|GET /hit` | Legacy alias for `/e`. Kept forever — pages cached in browsers keep using it |
| `GET /stats` | HTML dashboard — needs `?token=` |
| `GET /stats.json` | Same figures as JSON — needs `?token=` |
| `GET /export.csv` | Raw rows as CSV — needs `?token=` |

`/stats` accepts `?days=1|7|30|90|365|0` (`0` = all time) and `?bots=1` to
include traffic the bot filter would otherwise hide.

## How this runs in production

Nothing is recorded from a local build. The flow is:

1. You push to `master`.
2. GitHub Pages builds the Jekyll site on its own servers (this repo has no
   Pages workflow, so Pages' built-in Jekyll does it).
3. A browser loads `https://ghuang14.github.io/...`. The beacon in
   `_includes/edge-client.html` fires and the Worker records the request.

The beacon deliberately does nothing on `localhost` / `127.0.0.1`, so running
`bundle exec jekyll serve` never pollutes your stats. `ALLOWED_ORIGINS` rejects
hits that present a *foreign* origin — see
[What the origin check does and does not do](#what-the-origin-check-does-and-does-not-do).

The one-time Worker setup below is the only part that touches Cloudflare. After
that, `.github/workflows/deploy-edge.yml` redeploys the Worker automatically
whenever you push a change under `edge/` — see
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
`IP_SALT` is a random string used when hashing addresses. Use long random
values:

```bash
openssl rand -hex 24   # run twice, paste one into each prompt
npx wrangler secret put DASHBOARD_TOKEN
npx wrangler secret put IP_SALT
```

> Changing `IP_SALT` later re-buckets the unique counts, so pick one and
> keep it.

**4. Deploy:**

```bash
npm run deploy
```

Wrangler prints your URL, e.g.
`https://visitor-tracker.<subdomain>.workers.dev`.

**5. Point the site at it.** In `_config.yml` at the repo root:

```yaml
edge_client:
  endpoint               : "https://visitor-tracker.<subdomain>.workers.dev/e"
  respect_optout            : true
```

Commit and push. While `endpoint` is empty no beacon code is emitted at all.

The rest of the block is optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `fallback_endpoint` | `…/hit` | A second URL, raced against the first. |
| `extra_endpoints` | `[]` | Further collectors, each ideally on a **different host** — the only thing that survives one host becoming unreachable. See [Unreachable networks](#unreachable-networks). |
| `hedge_ms` | `1200` | How long to give one host before starting the next. An unreachable host usually hangs rather than failing, so this, not the error handler, is what reaches the second collector. |
| `resolve_self` | `true` | Ask the browser for its own public address and send it, so a request through a mirror or proxy records the originating address as well as the middlebox's. Never runs for opt-outs. |
| `echo_endpoints` | `[]` | Which services to ask. Empty uses the built-in defaults; each was verified to answer 2xx, send CORS, and return an address. |
| `store_and_forward` | `true` | Keep a pageview that reached **no** endpoint and replay it on a later one. The only mechanism here that survives every host being unreachable at once. |
| `queue_days` | `30` | How long an undelivered pageview is worth keeping. |
| `queue_max` | `50` | How many to hold at once; the stalest are shed first. |
| `count_optouts` | `true` | Count DNT/GPC requests in aggregate. `false` drops them entirely. |

**6. Open your dashboard:**

```
https://visitor-tracker.<subdomain>.workers.dev/stats?token=YOUR_DASHBOARD_TOKEN
```

Bookmark it. Anyone with that URL can read the whole log, so treat it as a
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

**From then on**, pushing any change under `edge/` triggers
`.github/workflows/deploy-edge.yml`, which applies `schema.sql` and deploys
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
| `ALLOWED_ORIGINS` | `https://ghuang14.github.io` | Comma-separated origins. A hit presenting a *different* origin is rejected with 403 unless `MIRROR_ORIGINS` covers it; a hit presenting none is recorded and flagged unverified (see below). Empty = accept anything. |
| `MIRROR_ORIGINS` | `""` | Extra origins that are also this site — a mirror, a reverse proxy, a staging copy. Exact origins or wildcards (`https://*.mirror.example`). Recorded in full, with the host kept in `origin_host`. |
| `PROFILE_UNVERIFIED` | `"true"` | `"false"` stores no address, geo or user agent for hits that arrived without an `Origin` or `Referer`. The default records them, quarantined. |
| `STORE_FULL_IP` | `"true"` | `"false"` stores an anonymised address instead (IPv4 last octet zeroed, IPv6 truncated to /48). Unique counts keep working either way. Applies to `client_ip` too. |
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
curl -X POST 'http://localhost:8787/e' \
  -H 'Origin: https://ghuang14.github.io' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  --data '{"p":"/publications/","r":"https://www.google.com/"}'
```

Note that `curl` matches the bot filter, so those hits appear only under
"incl. bots".

## What the origin check does and does not do

`ALLOWED_ORIGINS` is not authentication, and it is worth being precise about
what it buys, because the honest answer changes what you should store.

A hit is handled one of four ways:

| Situation | Result |
| --- | --- |
| `Origin`, or an origin derived from `Referer`, is on the list | Full record: address, geo, ASN, user agent, the lot |
| It matches `MIRROR_ORIGINS` | Full record, plus the mirror's host in `origin_host` |
| Neither header is present | Full record of what the *network* established, flagged `origin_missing`, quarantined out of every trusted figure; nothing the page volunteered is kept |
| Some other origin is presented | `403`, nothing stored |

The third row is the one that matters. An `<img>` never sends `Origin`, so the
pixel fallback depends entirely on `Referer` — and the clients that need a
fallback at all are disproportionately the ones whose referrer gets stripped:
in-app browser webviews, and the transparent HTTP proxies common on some
networks, routinely send neither header.

This has now been wrong twice in opposite directions. The first version
answered those requests with a `200` and stored nothing, which lost them
silently. The second stored a country and a path and deliberately discarded the
address, reasoning that a request which cannot be attributed to this site
carries an address that cannot be trusted either. That is sound about *trust*
and wrong about *storage*: it means the one slice of traffic this endpoint
exists to see — clients on networks where the normal transports are the ones
that fail — is precisely the one whose address is dropped on arrival.

So the row is now kept and quarantined rather than blanked. The abuse case that
motivated the blanking still cannot do anything useful. A third-party page can
drive this endpoint from its readers' browsers with the referrer suppressed,
and the result is a row that:

* is flagged `origin_missing`, so it reaches no ranking, no unique count, no
  "most frequent IPs" table and no headline number;
* contains no field the attacker chose — title, referrer, client id, language,
  screen and `is_new` are all dropped, and a forged `client_ip` has to be a
  well-formed public address or it is discarded;
* is visibly separated everywhere it does appear.

What it costs is a row holding a real address for a request that did not come
from this site. What it buys is every request from a constrained network that
did. `PROFILE_UNVERIFIED="false"` takes the other trade if you prefer it.

Note what the allowlist never protected against: a script can set any header it
likes, so `curl -H 'Origin: https://ghuang14.github.io'` has always been
accepted. The allowlist stops *browsers* on other people's pages, not scripts.
That is why the bot filter and the quarantine matter more than the allowlist
does.

## Why the beacon looks like this

Every choice in `_includes/edge-client.html` is there because the obvious
version loses requests silently. `edge/test/` locks each one in.

**`fetch(keepalive)` is the primary transport, not `navigator.sendBeacon`.**
EasyPrivacy ships an unqualified `*$ping,third-party` rule (easyprivacy.txt,
added 2022-01-05, still live). `sendBeacon` is typed `ping` by every filter
engine, so that rule blocks *every* cross-origin `sendBeacon` on the web — and
EasyPrivacy is enabled by default in uBlock Origin and in Brave. A keepalive
`fetch` is typed `xmlhttprequest` and is allowed by every list tested. This one
swap is the difference between losing and keeping roughly a third of all
requests, everywhere, not just on one kind of network.

**Endpoints are raced, not chained.** This is the fix that matters when a host
is unreachable. The previous version tried the second endpoint only once the
first had *proved* itself dead — and an unreachable host usually does not fail,
it hangs: a name that resolves to somewhere useless, or a route that goes
nowhere, sits there until the TCP timeout, by which point the client has
navigated away and there is no JavaScript left running to fail over. The second
collector was therefore unreachable in practice for exactly the clients it
existed for. Now host *N+1* starts on a
timer (`hedge_ms`, default 1200 ms) whether or not host *N* has answered, and
every pending timer is cancelled the moment one succeeds. A host that fails
outright still escalates immediately. Because every send carries the same
`event_id`, an overlap costs one request and can never cost a wrong number.

**The beacon asks the browser for its own public address.** `CF-Connecting-IP`
is the address that reached Cloudflare, which is the client's own address only
when the client talked to Cloudflare directly. Read through a mirror, a reverse
proxy or a corporate gateway — the ordinary way this site is reached from a
network that cannot reach the endpoint directly — it is the middlebox's, and a
whole slice of traffic collapses onto a handful of rows in the wrong city. So
the beacon queries a small list of echo services (`echo_endpoints`; the built-in
defaults were picked to answer on the networks that need them), one at a time
with a short timeout, at most once per tab, and
sends the answer as `ci`. The pageview is never delayed for it: if the lookup
finishes late, a follow-up ping carrying the same `event_id` and `x:1` fills
the column in without creating a second row. The Worker keeps the value only if
it is a well-formed *public* address that differs from the connecting address.
Opt-out requests are never sent to a third-party echo service at all, and
`resolve_self: false` turns the whole thing off.

**`sendBeacon`'s return value is never treated as success.** It reports that the
payload was *queued*, not that it was delivered, so a request that never leaves,
a DNS failure and an HTTP 403 all return `true`. The old code returned early on that
`true` and never ran its own fallbacks. `sendBeacon` is now only a fallback, and
it is always fired alongside the `<img>` pixel, because the pixel's `onerror` is
the only honest delivery signal of the three.

**The HTTP status is inspected.** A `fetch` that resolves with 403 is a failure;
the old code treated any resolved promise as a win.

**Every hit carries a random `event_id`, and the Worker does `INSERT OR
IGNORE`** against a unique index on `(event_id, ip_hash)`. That is what makes it safe to fire
several transports for one pageview: whichever arrives first wins, the rest
collapse into it. It also makes a bfcache restore countable — it just gets a
fresh id. The index is scoped to the client, and only a well-formed id is
honoured, so nobody can plant an id that silently swallows someone else's row.

**A pageview that reached nothing is kept, not dropped.** The race covers a
dead *first* host. It cannot cover every host being dead at once, which is what
a name-level failure looks like from the inside, and when the tab closes that
pageview is gone. It now goes to `localStorage` and is replayed on a later
pageview from a network that works, carrying its original event id and its own
age. See [Unreachable networks](#unreachable-networks).

**The browser's own timezone is sent.** `request.cf.timezone` is inferred from
the connecting address, so it describes the VPN exit or the proxy rather than
the client whenever there is one in between. The browser's IANA zone is the
client's own. The pair disagreeing is the only evidence available that a request
did not originate where it came out — and for a replayed hit it is the only
locating evidence left, since the address by then belongs to a different
network. Never collected for an opt-out.

**The send happens at parse time, from `<head>`, on no event at all.** This has
been wrong twice, each time by waiting for something.

`load` was the first version: it waits for every subresource, and every page
here pulls MathJax from `cdnjs.cloudflare.com` as an `async` script, so anyone
who left before that finished was counted nowhere. Moving to
`DOMContentLoaded` fixed that and was still far later than necessary, because
the script also sat at the bottom of `<body>`, directly beneath a
render-blocking `main.min.js`. The first byte of a pageview therefore went out
only after that bundle had been fetched and executed, the rest of the document
had been parsed, and a cold DNS + TCP + TLS handshake to a third-party host had
completed. Measured on a reconstruction of the real document with a 300 ms
blocking bundle, that was a **median 335 ms** before anything was dispatched —
and every client who closed the tab inside that window left no row at all,
which is not a visible loss. It looks like less traffic.

Three changes, together taking the same measurement to a **median 13 ms**:

* The client moved to `<head>`, after `<title>` (it reads `document.title`) and
  before the stylesheet and every script.
* It sends immediately instead of registering a `DOMContentLoaded` listener.
  Nothing it collects needs a parsed DOM — path, referrer, language, screen and
  the stored id are all available at once.
* A `preconnect` is emitted earlier still, next to `<meta charset>`, so DNS, TCP
  and TLS to the collector run concurrently with parsing the rest of the
  document rather than being paid for serially at send time. The local A/B
  understates this: over loopback a handshake is free, and on the distant
  networks this exists for it is most of the cost.

The address lookup was also moved to *after* the pageview goes out. It is a
third-party request, and issuing it first put a DNS lookup and a TLS handshake
in front of the very hit it exists to annotate.

`visibilitychange`/`pagehide` remain as backstops, and `pageshow` with
`persisted` catches back/forward-cache restores.

**Every pageview reports how long its own send took.** `performance.now()` at
dispatch, stored as `latency_ms`, surfaced on the Delivery tab as a median, a
95th percentile and the share that got out inside a second. This is the only
figure on the dashboard that speaks to the requests that never arrived: a
regression in the send path cannot be seen by counting rows, because the rows
are exactly what goes missing. A client with no performance clock reports `-1`
and is stored as `NULL` rather than as a zero that would flatter the median.

**A hit with no `Origin` *and* no `Referer` is recorded with its address, not
silently dropped and not blanked** — quarantined, in the form described above.
This is the difference between seeing referrer-stripping traffic and having no
idea it exists.

**Opt-outs are counted in aggregate only.** With `respect_optout: true` the
beacon still sends `{d:1, p:<path>}` and nothing else — no id, no title, no
referrer, no language, no screen — and the Worker stores no address, no user
agent and no city for it. Without this, a whole class of traffic (Brave turns
GPC on for everyone) is indistinguishable from "no requests at all", which is
the exact ambiguity this endpoint exists to resolve. Set `count_optouts: false`
in `_config.yml` to drop them entirely instead.

**The Worker checks the `DNT` and `Sec-GPC` request headers too, not just the
flag the beacon sends.** The `<noscript>` pixel is by definition the one
transport where the beacon's own opt-out check never runs, so trusting only the
JSON flag would have kept a full record for precisely the clients that asked not
to have one. The header is the client's own signal rather than something a page
had to volunteer, and GPC is a legally operative opt-out under CPRA, so it is
honoured whatever the page sent.

## Unreachable networks

Some networks cannot reach the primary endpoint at all. That case is what the
whole delivery design is aimed at, so it is worth being precise about what is
now fixed in code and what still needs ten dollars.

**Fixed in code.** Three separate things used to throw away requests from those
networks even when the request *did* arrive:

1. **The failover never ran.** All three transports pointed at one host and the
   second endpoint was only tried after the first had proved itself dead, which
   an unreachable host never does in time. Endpoints are now raced on a timer,
   so a reachable collector is actually reached — see the beacon section above.
2. **The address was discarded on arrival.** In-app browser webviews and the
   transparent proxies common on those networks send neither `Origin` nor
   `Referer`, which put every one of those hits in the aggregate-only bucket:
   country and path, no address. Those rows now keep their address, geo and
   network, quarantined rather than blanked.
3. **A stripped `User-Agent` counted as a bot.** Proxies that drop the header
   had their traffic filed under "bot hits filtered" and hidden from the
   default dashboard. A hit carrying a well-formed beacon `event_id` is now
   treated as the browser it is, whatever survived of the headers.

Plus two things that make the record truthful rather than merely present: the
browser's own public address is resolved and stored as `client_ip` (the default
echo services were chosen to answer on these networks), so a request through a
mirror shows the originating address next to the middlebox's; and
`MIRROR_ORIGINS` lets you name the mirrors you know about, which turns a `403`
into a full record tagged with the mirror's host.

**Recovered without a domain.** Two more things now work with the hostnames
already shipped, because both stop depending on the request going out while the
pageview is happening.

0. **The echo list was broken and is fixed.** The two endpoints shipped as
   reachable from these networks — `qifu-api.baidubce.com/ip/local/geo/v1/district`
   and `forge.speedtest.cn/api/location/info` — now answer `404` and `405`.
   Those are application responses, identical from everywhere, so `resolve_self`
   had been resolving nothing for anybody, not merely on the networks in
   question. The replacements were each checked for three things the old list
   failed silently: a 2xx, an `Access-Control-Allow-Origin` a browser will
   accept, and an address in the body. Reachability from inside one of these
   networks cannot be established from outside it — verify the order from a
   proxy on one.

1. **A pageview nothing could deliver is kept and replayed later.** Racing
   endpoints recovers a client whose *first* host is unreachable. It does
   nothing when every host is unreachable, which is the entire situation here:
   all three URLs in `_config.yml` are on one name, that one name is
   unreachable, and the race has nothing to race against. So the beacon writes
   the pageview to `localStorage` instead of dropping it when the tab closes,
   and replays it on a later pageview — after a VPN goes on, after the reader
   travels, or simply from the next network the site is read from. It keeps its
   original event id, so a transport that did quietly land collapses the replay
   into the row it already made instead of counting twice; and it reports its
   own *age*, not a timestamp, so the Worker files it on the day the pageview
   happened rather than the day the network finally worked, and the two clocks
   never have to agree. Bounded by `queue_days` and `queue_max`; opt-outs are
   never queued.

   It also carries **the address the browser found for itself at the time of
   the pageview**. This is the only way a pageview from a network that cannot
   reach the endpoint ever yields an address at all: by the time a replay can be
   delivered, the connection belongs to whatever network finally worked, and the
   original is gone unless it was captured at the time and kept. Sending the
   current address instead would be worse than sending none — it would put the
   wrong one on the row and look right. That address is also what the row's
   `ip_hash` is derived from, so one reader who gets through on three different
   networks stays one unique rather than becoming three.

   For the same reason, a replayed row's `country`, `city`, network and map
   position — all taken from the connection that delivered it — are held out of
   those rankings. They describe the delivery path, not the pageview. Filing a
   pageview under whichever country the network that finally carried it out sits
   in is the exact misattribution this feature exists to prevent.

2. **The browser's own timezone is recorded next to the one Cloudflare infers
   from the address.** `timezone` is derived from whatever address reached the
   edge, which is the VPN exit's, the mirror's or the proxy's whenever the site
   is not read directly — so a reader on a US exit node lands in California and
   is counted as an American wherever they actually are. `client_tz` is the
   browser's own clock. The two disagreeing is the only evidence available that
   a request did not originate where it came out, and on a replayed hit it is
   the only locating evidence left at all, because by then the address belongs
   to a different network. It is stored for unverified rows too — unlike title,
   referrer or client id — for the same reason `path` is: those rows *are* the
   traffic this section is about, and one that cannot say where it came from is
   not worth keeping. It is validated to an IANA zone shape, stays out of every
   trusted figure with the rest of its row, and is never collected for an
   opt-out.

Neither recovers a reader who comes once, from a network that cannot reach the
endpoint, and never returns. Together they turn "invisible" into "arrives late,
and says where it came from", which is the difference between not knowing that
traffic exists and measuring it.

**Real time: `pages.dev` answers where `workers.dev` does not.** This is the
fix, and it costs nothing. Measured from a proxy node on such a network rather
than assumed:

```
200  https://ghuang14.github.io/                          the site itself loads
000  https://visitor-tracker.<sub>.workers.dev/nope       the collector: no answer
200  https://astro.pages.dev/                             pages.dev: reachable
200  https://ip.zxinc.org/api.php?type=json               echo: reachable
000  https://ipwho.is/                                    echo: no answer
```

Both `workers.dev` and `pages.dev` are Cloudflare's and resolve to the same
anycast network, so what fails is keyed on the *name*, not on the address.
`ghuang14.github.io` resolves correctly, which is why the page loads and only
the beacon dies.

`edge/pages/` therefore deploys **the same collector, from the same source
file, against the same D1 database**, to `visitor-tracker-cn.pages.dev`. The
deploy copies `src/index.js` to `public/_worker.js` and lets Pages run it for
every request — advanced mode, no `functions/` directory. The idiomatic layout
(a `functions/[[path]].js` re-exporting the Worker) was tried first and shipped a
deployment with no Worker running at all: every path on `pages.dev` answered 200
with the static placeholder instead of the collector's 404. Not a
second dataset: the same rows in the same table. The beacon races both hosts and
both carry the same event id, so whichever wins, the other collapses into it —
and a request from one of these networks is recorded live, with its real
address, no queue involved.

One-time setup (the workflow step explains it too):

1. **Create the project.** In the dashboard there is no "Create" button — the
   button is **Create application**, and the Pages flow sits behind it:

   > Workers & Pages → **Create application** → **Get started** → *Drag and drop
   > your files* → name it `visitor-tracker-cn`

   Or from a terminal:

   ```
   npx wrangler pages project create visitor-tracker-cn --production-branch=master
   ```

   **Do not drop `--production-branch`.** wrangler 4.x contains a
   Pages-to-Workers redirect: `pages project create` and `pages deploy` both
   call `maybeDelegatePagesToWorkers()`, which silently creates a *Worker*
   instead whenever it detects an AI coding agent installed in `$HOME` — and a
   Worker is served from `*.workers.dev`, the one name this deployment exists to
   avoid. Passing `--production-branch` (or the hidden `--force`) opts out.
   Running the command from inside an agent terminal is exactly the case that
   trips it. CI is unaffected: no agent is installed on the runner. The workflow
   verifies the hostname afterwards regardless, because a delegated deploy still
   reports success.

2. **Set that project's production branch to `master`.** Project → **Settings →
   Builds & deployments → Production branch**. A project created through the
   dashboard does not default to `master`, and wrangler decides production
   versus preview by `project.production_branch === branch`. Get this wrong and
   every deploy lands on a per-commit preview URL while
   `visitor-tracker-cn.pages.dev` keeps serving whatever was uploaded by hand —
   with the deploy step reporting success throughout. The workflow passes
   `--branch=master` explicitly; this is the other half of that pair.

3. That project → **Settings → Variables and secrets** → add `IP_SALT` with the
   **same value as the Worker's**. A different salt re-buckets every `ip_hash`,
   so one client is counted once per collector. This is the only setting here
   that corrupts the numbers instead of failing loudly.
4. **Give the Cloudflare API token one more permission.** Two different things
   share a name here. The *credential* lives on Cloudflare and carries the
   permissions; `CLOUDFLARE_API_TOKEN` is only the GitHub secret holding that
   credential's string. The permission goes on the credential:
   [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   → the token you made for this repo → **Edit** → under **Permissions** add a
   row **Account | Cloudflare Pages | Edit** → *Continue to summary* → *Save*.
   Editing in place does not change the token's value, so the GitHub secret does
   not need updating. Without this, `wrangler pages deploy` fails with
   `Authentication error [code: 10000]` — the same way it does without D1:Edit.
5. Uncomment the `pages.dev` entry under `extra_endpoints` in `_config.yml`.

If `pages.dev` ever stops answering too, the fallback is unchanged: a name whose
nameservers you control, bound as a Workers **Custom Domain** (~$10/yr, or free
from `nic.eu.org`; a CNAME-only free subdomain cannot work, since a Custom
Domain needs the zone on your Cloudflare account). Re-measure before assuming —
reachability from inside such a network cannot be established from outside it,
and the suffix that works today is an empirical fact with a shelf life.

**How to tell whether any of it is working.** The **Restricted** tab is the
instrument, and it answers the question the rest of the dashboard cannot:
*empty* used to mean either "no requests from a constrained network" or "there
were some and nothing about them can reach here", with no way to tell which.

* *Relayed connections* counts hits whose browser clock disagrees with their
  address. A row reading `Asia/Tokyo` against `America/Los_Angeles` is a client
  reading through a US exit node — one the country ranking is currently filing
  under the United States.
* *Recovered from a dead network* counts pageviews that reached nothing when
  they happened and arrived later from the queue. Any number above zero is
  direct proof that the delivery failure is real and is costing you traffic;
  the wait column is how long that pageview was invisible.
* *Hits that needed a fallback* is the delivery cost. Once a second host is
  configured this is, near enough, the number of pageviews that host saved.
* The `pixel` share of the Delivery tab's transport breakdown still reads on
  its own: a high one means something between the client and this Worker is
  stopping the primary transport, not that the host is unreachable.

## The dashboard

`/stats?token=…` is six tabs over the same range selector (`?days=`) and bot
toggle:

* **Overview** — pageviews, uniques, countries and today, each with its
  movement against the previous window of the same length; a traffic chart with
  views as an area and uniques as a dashed line; and the country, page,
  referrer and network rankings.
* **Map** — a world map of request locations, bubbles sized by views. The
  ring around each bubble is split by the unverified share, because a location
  that is 40% unverified is neither one thing nor the other and painting the
  whole bubble one colour would round that away. A third kind of bubble, drawn
  with a **dashed ring**, is placed by the browser's own clock rather than by
  the connecting address: those are the rows whose timezone contradicts where
  their traffic came out, so plotting them by address would put them in the
  wrong country. They appear once, in the right place, and coordinates come from
  the IANA `zone.tab` principal city — country-level precision, not city-level.
  Drag to pan, scroll to zoom, hover for detail.
* **Locations** — countries, cities, and every located point with its
  coordinates, filterable and sortable.
* **Clients** — recent rows, the *Most frequent IPs* card, the quarantined
  unverified addresses, and a *Behind a proxy or mirror* table pairing each
  `client_ip` with the address that actually reached the edge. Click any address
  to copy it.
* **Delivery** — how hits arrive, what opted out, and what is quarantined.
* **Restricted** — the traffic an unreachable or relayed network would otherwise
  hide: browser clock against the location derived from the connecting address,
  pageviews recovered from the browser queue with how long each waited, and what
  delivery cost. See [Unreachable networks](#unreachable-networks).

Everything else is a convenience: a theme toggle (auto/light/dark), a UTC↔local
time switch, per-table filter and sort, a minute auto-refresh, and keys `1`–`6`
for the tabs with `/` to focus the visible filter.

The page loads nothing from the network — no map library, no tile server, no
font. The world map is drawn on a canvas from a 6.4 KB land mask baked into
`src/index.js` (one bit per one-degree cell, from public-domain Natural Earth
110m data). That is not purity for its own sake: every keyless raster tile
provider left either stamps "API KEY REQUIRED" across the imagery or blocks
unattended clients under its usage policy, so a tiled dashboard is one silent
provider change away from showing an empty rectangle. `worker.test.mjs` asserts
that no third-party URL appears in the rendered page.

## Tests

```bash
cd edge && npm test
```

`test/worker.test.mjs` drives `src/index.js` against a real in-memory SQLite —
starting from the *old* table shape, so the lazy migration is exercised against
what production is actually holding. `test/beacon.test.mjs` runs the beacon as
the browser receives it (Liquid-rendered, then whitespace-collapsed the way
`_layouts/compress.html` does) inside a stubbed DOM — including the case that
motivated the rework, a first endpoint that hangs forever rather than failing. Neither needs wrangler,
a network or Node 22; the deploy workflow runs both before it touches
Cloudflare.

## Cost

Workers free tier is 100,000 requests/day and D1 gives 5 GB storage with
5 million row reads/day — orders of magnitude above what a personal academic
site generates. Rows are roughly 300 bytes.

## Useful queries

```bash
npx wrangler d1 execute visitor-tracker --remote \
  --command "SELECT country, COUNT(DISTINCT ip) FROM visits WHERE is_bot=0 GROUP BY country ORDER BY 2 DESC LIMIT 10;"

# recent hits on the publications pages
npx wrangler d1 execute visitor-tracker --remote \
  --command "SELECT datetime(ts/1000,'unixepoch') t, ip, city, country, as_org FROM visits WHERE path LIKE '/publications/%' AND is_bot=0 ORDER BY ts DESC LIMIT 30;"
```

## Privacy note

The connecting address is personal data under GDPR, and university or
institutional traffic is often directly identifiable via the ASN. If you want
the aggregate figures without that exposure, set `STORE_FULL_IP="false"` — you
keep every chart on the dashboard except the raw-address columns.
`respect_optout: true` in `_config.yml` means requests that send Do-Not-Track or
Global Privacy Control are counted in aggregate only: path and country, with no
address, no address hash, no client id, no user agent, no referrer and no city.
That holds on every transport — the Worker reads the `DNT` and `Sec-GPC` headers
itself, so it also covers the `<noscript>` pixel, where no JavaScript runs to
send the flag. Set `count_optouts: false` to stop recording them at all.

Two things here go further than a plain pageview counter, and both are opt-out:
unverified hits are stored with their address rather than blanked
(`PROFILE_UNVERIFIED="false"` reverts it), and the beacon asks a third-party
echo service for the browser's own public address (`resolve_self: false`
turns it off). Neither applies to a DNT/GPC request. If what you want from this
endpoint is aggregate reach rather than individual addresses,
`STORE_FULL_IP="false"` plus `PROFILE_UNVERIFIED="false"` gets you every chart
on the dashboard with nothing personally identifying in the table.
