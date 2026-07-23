// End-to-end tests for the Worker: every regression this file covers was a real
// bug that silently lost requests. Run with `npm test` in edge/.
//
// The suite deliberately starts from the OLD table shape (schema.sql with the
// late columns stripped) so the lazy migration in src/index.js is exercised
// against the same thing production is holding.

import { makeD1 } from './d1-shim.mjs';
import fs from 'node:fs';
import worker from '../src/index.js';

const SITE = 'https://ghuang14.github.io';
const BASE = 'https://visitor-tracker.alexhuang1403.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const DB = makeD1();
const env = {
  DB,
  ALLOWED_ORIGINS: SITE,
  STORE_FULL_IP: 'true',
  IP_SALT: 'test-salt',
  DASHBOARD_TOKEN: 'tok',
  RETENTION_DAYS: '0',
};

// --- start from the ORIGINAL schema, i.e. the table as it exists in production
// today, so the lazy migration is exercised for real. -------------------------
const SHIPPED = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
// The table as production holds it: the shipped file with everything that was
// added after the fact taken back out. Statements naming a late column go too,
// so that re-introducing one shows up as a clean failure in section 13 rather
// than as a crash here.
const LATE = ['event_id', 'dnt', 'transport', 'origin_missing', 'client_ip', 'origin_host',
              'client_tz', 'tz_offset', 'queued_ms', 'failovers', 'latency_ms'];
const legacy = SHIPPED
  // Everything from the "Added after" marker to the table's closing paren, so
  // this keeps working as further columns are appended.
  .replace(/,\n  -- Added after[\s\S]*?\n\)/, '\n)')
  .replace(/--[^\n]*/g, '')
  .split(';')
  .filter(st => !new RegExp('\\b(' + LATE.join('|') + ')\\b').test(st))
  .join(';');

/** Runs a .sql file the way `wrangler d1 execute --file=` does. */
const applySql = (db, sql) =>
  sql
    // Comments come out before the split, because a ';' inside one would
    // otherwise cut a statement in half. wrangler's own splitter is
    // comment-aware; this is the cheap equivalent (no string literals here).
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(x => x.trim())
    .filter(Boolean)
    .reduce((p, st) => p.then(() => db.raw(st)), Promise.resolve());

await applySql(DB, legacy);
const cols0 = (await DB.raw('PRAGMA table_info(visits)')).map(c => c.name);
// Guard the strip itself: if the regex above ever stops matching, every
// migration assertion below would pass against an already-migrated table and
// prove nothing.
if (LATE.some(c => cols0.includes(c))) { console.error('FATAL: legacy strip failed, cols=' + cols0); process.exit(1); }
// one pre-existing row, to prove migration preserves data
await DB.raw(`INSERT INTO visits (ts, ip_hash, path, is_new, is_bot) VALUES (1, 'old', '/legacy', 0, 0)`);

const waits = [];
const ctx = { waitUntil: p => waits.push(p) };
const settle = async () => { await Promise.all(waits.splice(0)); };

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
};

const P = (o) => JSON.stringify(o);

const cf = { country: 'GR', region: 'Attica', city: 'Athens', postalCode: '104', latitude: '37.9',
             longitude: '23.7', timezone: 'Europe/Athens', asn: 3329, asOrganization: 'OTEnet', colo: 'ATH' };

async function hit(path, { method = 'POST', body, origin, referer, ua = UA, ip = '203.0.113.7',
                           headers = {}, env: over = null, geo = cf } = {}) {
  const h = { 'user-agent': ua, 'cf-connecting-ip': ip, ...headers };
  if (ua === '') delete h['user-agent'];
  if (origin) h.origin = origin;
  if (referer) h.referer = referer;
  const req = new Request(BASE + path, { method, body, headers: h });
  Object.defineProperty(req, 'cf', { value: geo });
  const res = await worker.fetch(req, over || env, ctx);
  await settle();
  return res;
}
const gif = (payload, opts) =>
  hit('/e.gif?f=gif&z=' + encodeURIComponent(P(payload)), { method: 'GET', ...opts });
const rows = async where => await DB.raw(`SELECT * FROM visits ${where ? 'WHERE ' + where : ''} ORDER BY id`);
const count = async where => (await DB.raw(`SELECT COUNT(*) c FROM visits WHERE ${where}`))[0].c;

console.log('\n=== 1. migration on the live production table shape ===');
let r = await hit('/e', { body: P({ e: 'aaaa1111bbbb2222cccc3333dddd4444', p: '/about/', t: 'About', r: '', l: 'el-GR', s: '1440x900', v: 'v1', n: 1, k: 'load' }), origin: SITE });
const cols1 = (await DB.raw('PRAGMA table_info(visits)')).map(c => c.name);
check('new columns added at runtime', ['event_id','dnt','transport','origin_missing'].every(c => cols1.includes(c)), cols1.join(','));
check('pre-existing row preserved', (await count(`path = '/legacy'`)) === 1);
check('POST /e with allowed Origin -> 204', r.status === 204, 'got ' + r.status);
check('  ACAO echoed', r.headers.get('access-control-allow-origin') === SITE);
let a = (await rows(`event_id = 'aaaa1111bbbb2222cccc3333dddd4444'`))[0];
check('  row stored with ip + geo', a && a.ip === '203.0.113.7' && a.country === 'GR' && a.city === 'Athens', P(a));
check('  transport=load, is_new=1, dnt=0, origin_missing=0',
  a && a.transport === 'load' && a.is_new === 1 && a.dnt === 0 && a.origin_missing === 0, P(a));

console.log('\n=== 2. THE SILENT-DROP BUG: pixel with no Origin and no Referer ===');
// An <img> never sends Origin, so this transport depends entirely on Referer —
// and the clients that need it are the ones that strip Referer: some embedded
// webviews and the transparent proxies that sit in front of them. The first
// version of the Worker stored nothing at all for them. The second stored a
// country and threw the connecting address away, which loses precisely the
// traffic the fallback transports exist for. Now the row is kept in full and
// quarantined.
r = await gif({ e: 'bbbb1111cccc2222dddd3333eeee4444', p: '/cv/', t: 'CV', l: 'zh-CN',
                s: '390x844', v: 'v2', n: 0, k: 'load' });
check('answers with a GIF', r.headers.get('content-type') === 'image/gif');
a = (await rows(`event_id = 'bbbb1111cccc2222dddd3333eeee4444'`))[0];
check('ROW IS NOW WRITTEN (was silently dropped before)', !!a, 'no row');
check('  flagged origin_missing=1', a && a.origin_missing === 1);
check('  THE IP IS KEPT — this is the whole fix', a && a.ip === '203.0.113.7', P(a));
check('  with the geo and network the edge established, not the page',
  a && a.country === 'GR' && a.city === 'Athens' && a.asn === 3329 && a.user_agent === UA, P(a));
check('  and a real salted hash, so its unique count means something',
  a && /^[0-9a-f]{64}$/.test(String(a.ip_hash)), a && a.ip_hash);
// Nothing the page volunteered survives: the request still carries no proof it
// came from this site, so only what the edge itself established is kept.
check('  nothing the page volunteered is trusted: no title, id, language or screen',
  a && a.title === null && a.visitor_id === null && a.lang === null &&
  a.screen === null && a.is_new === 0, P(a));
check('  path still kept, so the row is readable', a && a.path === '/cv/', P(a));

{
  // The old blank-it behaviour has to remain one setting away.
  const strict = { ...env, PROFILE_UNVERIFIED: 'false' };
  await gif({ e: '1a2b3c4d5e6f70819a2b3c4d5e6f7081', p: '/strict/', k: 'load' }, { env: strict });
  a = (await rows(`path = '/strict/'`))[0];
  check('PROFILE_UNVERIFIED="false" goes back to storing no address',
    a && a.ip === null && a.user_agent === null && a.city === null &&
    String(a.ip_hash).startsWith('anon:GR:'), P(a));
  check('  while still counting the visit', a && a.origin_missing === 1 && a.country === 'GR');
}

console.log('\n=== 3. THE is_new BUG: "n=0" is a truthy string ===');
r = await hit('/hit?f=gif&p=%2Fposts%2F&v=v3&n=0', { method: 'GET', referer: SITE + '/posts/' });
a = (await rows(`path = '/posts/'`))[0];
check('legacy flat-param pixel still accepted', !!a);
check('is_new correctly 0 for n=0', a && a.is_new === 0, 'is_new=' + (a && a.is_new));

console.log('\n=== 4. multi-transport de-duplication ===');
for (const k of [1, 2, 3]) {
  await hit('/e', { body: P({ e: 'cccc1111dddd2222eeee3333ffff4444', p: '/dup/', k: 'load' }), origin: SITE });
  await hit('/e.gif?f=gif&z=' + encodeURIComponent(P({ e: 'cccc1111dddd2222eeee3333ffff4444', p: '/dup/', k: 'load' })), { method: 'GET', referer: SITE + '/' });
}
check('6 sends of one event id -> exactly 1 row', (await count(`event_id = 'cccc1111dddd2222eeee3333ffff4444'`)) === 1,
  'rows=' + (await count(`event_id = 'cccc1111dddd2222eeee3333ffff4444'`)));
check('rows with NULL event_id do NOT collide', (await count(`event_id IS NULL`)) === 2,
  'legacy+flat-pixel rows=' + (await count(`event_id IS NULL`)));
await hit('/e', { body: P({ e: 'not a valid id!', p: '/badid/' }), origin: SITE });
check('a malformed event id is dropped rather than trusted',
  (await rows(`path = '/badid/'`))[0].event_id === null);

console.log('\n=== 5. DNT/GPC opt-out is counted, with no detail stored ===');
r = await hit('/e', { body: P({ e: 'dddd1111eeee2222ffff3333aaaa4444', d: 1, p: '/', k: 'load' }), origin: SITE });
a = (await rows(`event_id = 'dddd1111eeee2222ffff3333aaaa4444'`))[0];
check('opt-out row recorded', !!a);
check('  no IP, no user agent, no client id, no referrer, no city',
  a && a.ip === null && a.user_agent === null && a.visitor_id === null && a.referrer === null && a.city === null, P(a));
check('  ip_hash is a non-identifying bucket', a && String(a.ip_hash).startsWith('dnt:GR:'), a && a.ip_hash);
check('  country kept for aggregate counting', a && a.country === 'GR');
check('  dnt=1', a && a.dnt === 1);

console.log('\n=== 6. spam still rejected ===');
r = await hit('/e', { body: P({ e: 'eeee1111ffff2222aaaa3333bbbb4444', p: '/x' }), origin: 'https://evil.example' });
check('POST from a foreign Origin -> 403', r.status === 403, 'got ' + r.status);
check('  and stores nothing', (await count(`event_id = 'eeee1111ffff2222aaaa3333bbbb4444'`)) === 0);
r = await hit('/e.gif?f=gif&z=' + encodeURIComponent(P({ e: 'ffff1111aaaa2222bbbb3333cccc4444', p: '/x' })), { method: 'GET', referer: 'https://evil.example/p' });
check('pixel from a foreign Referer -> GIF but no row',
  r.headers.get('content-type') === 'image/gif' && (await count(`event_id = 'ffff1111aaaa2222bbbb3333cccc4444'`)) === 0);

console.log('\n=== 7. noscript pixel ===');
r = await hit('/e?f=gif&k=nojs&p=%2Fpublications%2F', { method: 'GET', referer: SITE + '/', ua: UA });
a = (await rows(`transport = 'nojs'`))[0];
check('no-JS client recorded with the right path', a && a.path === '/publications/', P(a));

// The <noscript> pixel is the one transport where the beacon's own DNT/GPC
// check cannot run, so the opt-out only reaches the Worker as a request header.
// Reading `payload.d` alone would keep the full record for exactly the requests
// that opted out.
r = await hit('/e?f=gif&k=nojs&p=%2Fcv%2F', { method: 'GET', referer: SITE + '/', ua: UA,
  ip: '198.51.100.77', headers: { dnt: '1' } });
a = (await rows(`path = '/cv/' AND transport = 'nojs'`))[0];
check('a DNT: 1 header opts out even with no JS to send the flag', a && a.dnt === 1, P(a));
check('  so it is counted but not profiled',
  a && a.ip === null && a.user_agent === null && a.city === null && a.asn === null &&
  a.country === 'GR' && String(a.ip_hash).startsWith('dnt:'), P(a));
r = await hit('/e?f=gif&k=nojs&p=%2Fgpc%2F', { method: 'GET', referer: SITE + '/', ua: UA,
  ip: '198.51.100.78', headers: { 'sec-gpc': '1' } });
a = (await rows(`path = '/gpc/'`))[0];
check('Sec-GPC: 1 is honoured the same way', a && a.dnt === 1 && a.ip === null, P(a));

console.log('\n=== 8. bfcache restore is a separate pageview ===');
await hit('/e', { body: P({ e: '11112222333344445555666677778888', p: '/', k: 'bfcache' }), origin: SITE });
check('bfcache hit stored with its own transport', (await count(`transport = 'bfcache'`)) === 1);

console.log('\n=== 9. abuse: a third-party page cannot record its own traffic here ===');
// A browser cannot forge Origin, so an attacker page uses an <img> with the
// referrer suppressed. It looks identical, on the wire, to a genuine request
// whose browser strips both headers — which is why the row is quarantined
// rather than discarded. What must hold is that the attacker controls none of
// it: every field it chose is dropped, and the row is kept out of every figure.
const drive = P({ e: '99998888777766665555444433332222', p: '/never-visited/?utm=attacker',
                  t: 'FORGED', r: 'https://news.example/x', l: 'ru-RU', s: '9999x9999',
                  v: 'forged-client-id', n: 1, k: 'load' });
await hit('/e.gif?f=gif&z=' + encodeURIComponent(drive), { method: 'GET', ip: '198.51.100.42' });
a = (await rows(`event_id = '99998888777766665555444433332222'`))[0];
check('the row is quarantined, not blanked', a && a.origin_missing === 1, P(a));
check('forged title, referrer, client id, language and screen are NOT recorded',
  a && a.title === null && a.referrer === null && a.visitor_id === null &&
  a.lang === null && a.screen === null, P(a));
check('a forged is_new cannot inflate the new-client count', a && a.is_new === 0, P(a));
// Section 11 proves the rest: this row reaches no ranking, no unique count and
// no address table on the dashboard.

// Squatting: plant an id from one client, then let a genuine request use the
// same id from a different address. The genuine hit must survive.
await hit('/e.gif?f=gif&z=' + encodeURIComponent(P({ e: '5555666677778888999900001111aaaa', p: '/squatted/' })),
          { method: 'GET', ip: '198.51.100.42' });
await hit('/e', { body: P({ e: '5555666677778888999900001111aaaa', p: '/real-page/', k: 'load' }),
                  origin: SITE, ip: '203.0.113.9' });
check('a squatted event id cannot suppress a real visit',
  (await count(`path = '/real-page/'`)) === 1, 'the genuine row was swallowed');

console.log('\n=== 9b. mirrors: an origin the owner listed is this site too ===');
// Where the site itself does not resolve, it is normally read through a mirror
// or a reverse proxy, which presents its OWN origin — indistinguishable from a
// hostile page to the allowlist, so every request arriving that way used to get
// a 403 and vanish. MIRROR_ORIGINS is the owner saying which origins count.
{
  const mirrored = { ...env, MIRROR_ORIGINS: 'https://mirror.example.cn, https://*.cdn.example.cn' };
  r = await hit('/e', { body: P({ e: 'm1m1m1m1m2m2m2m2m3m3m3m3m4m4m4m4', p: '/mirrored/', t: 'CV',
                                  v: 'mv1', n: 1, k: 'load' }),
                        origin: 'https://mirror.example.cn', ip: '203.0.113.77', env: mirrored });
  check('a listed mirror is accepted, not 403d', r.status === 204, 'got ' + r.status);
  check('  and its Origin is echoed, so the fetch transport works from it',
    r.headers.get('access-control-allow-origin') === 'https://mirror.example.cn');
  a = (await rows(`path = '/mirrored/'`))[0];
  check('  full record kept', a && a.ip === '203.0.113.77' && a.city === 'Athens' && a.origin_missing === 0, P(a));
  check('  with the mirror named, so it can be told from the site itself',
    a && a.origin_host === 'mirror.example.cn', P(a));
  r = await hit('/e', { body: P({ e: 'm5m5m5m5m6m6m6m6m7m7m7m7m8m8m8m8', p: '/wild/' }),
                        origin: 'https://a.cdn.example.cn', ip: '203.0.113.78', env: mirrored });
  check('  a wildcard entry matches a subdomain', (await count(`path = '/wild/'`)) === 1, 'got ' + r.status);
  r = await hit('/e', { body: P({ e: 'm9m9m9m9n1n1n1n1n2n2n2n2n3n3n3n3', p: '/nope/' }),
                        origin: 'https://evil.example', env: mirrored });
  check('  anything not listed is still 403', r.status === 403 && (await count(`path = '/nope/'`)) === 0);
}

console.log('\n=== 9c. the client\'s own address, when the connecting one is a middlebox ===');
// CF-Connecting-IP is the address that reached Cloudflare. Behind a mirror or a
// proxy that is the middlebox, and every client behind it collapses onto one
// wrong row.
await hit('/e', { body: P({ e: 'c1c1c1c1c2c2c2c2c3c3c3c3c4c4c4c4', p: '/via-proxy/', k: 'load',
                            ci: '198.51.100.200' }), origin: SITE, ip: '203.0.113.7' });
a = (await rows(`path = '/via-proxy/'`))[0];
check('the browser-reported address is stored alongside the connecting one',
  a && a.ip === '203.0.113.7' && a.client_ip === '198.51.100.200', P(a));

await hit('/e', { body: P({ e: 'c5c5c5c5c6c6c6c6c7c7c7c7c8c8c8c8', p: '/lan/', ci: '192.168.1.5' }),
                  origin: SITE });
check('a private address identifies nobody and is dropped',
  (await rows(`path = '/lan/'`))[0].client_ip === null);
await hit('/e', { body: P({ e: 'd1d1d1d1d2d2d2d2d3d3d3d3d4d4d4d4', p: '/junk/', ci: 'not-an-ip' }),
                  origin: SITE });
check('so is anything malformed', (await rows(`path = '/junk/'`))[0].client_ip === null);
await hit('/e', { body: P({ e: 'd5d5d5d5d6d6d6d6d7d7d7d7d8d8d8d8', p: '/same/', ci: '203.0.113.7' }),
                  origin: SITE, ip: '203.0.113.7' });
check('and so is a repeat of the connecting address', (await rows(`path = '/same/'`))[0].client_ip === null);

// The lookup usually finishes after the pageview has already been sent, so the
// address arrives as a follow-up ping. It must fill the column in without
// creating a second row.
await hit('/e', { body: P({ e: 'e1e1e1e1e2e2e2e2e3e3e3e3e4e4e4e4', p: '/late/', k: 'load' }), origin: SITE });
await hit('/e', { body: P({ e: 'e1e1e1e1e2e2e2e2e3e3e3e3e4e4e4e4', ci: '198.51.100.201', x: 1 }), origin: SITE });
check('a follow-up ping fills the address in', 
  (await rows(`path = '/late/'`))[0].client_ip === '198.51.100.201');
check('  and creates no second row', (await count(`path = '/late/'`)) === 1);
const before = (await DB.raw('SELECT COUNT(*) c FROM visits'))[0].c;
await hit('/e', { body: P({ e: 'f1f1f1f1f2f2f2f2f3f3f3f3f4f4f4f4', ci: '198.51.100.202', x: 1 }), origin: SITE });
check('a ping for an event that was never recorded writes nothing at all',
  (await DB.raw('SELECT COUNT(*) c FROM visits'))[0].c === before);

console.log('\n=== 9d. a stripped User-Agent is not proof of a bot ===');
// Empty UA used to mean is_bot=1, which filed every request behind a
// header-stripping proxy under "bots filtered" and hid it from the default
// dashboard — the same networks as everything else in this section.
await hit('/e', { body: P({ e: 'aabbccdd11223344aabbccdd11223344', p: '/no-ua/', k: 'load' }),
                  origin: SITE, ua: '' });
check('a hit carrying a valid beacon event id is a browser, whatever the headers say',
  (await rows(`path = '/no-ua/'`))[0].is_bot === 0);
await hit('/hit?p=%2Fscraper%2F', { method: 'GET', referer: SITE + '/', ua: '' });
check('a UA-less request with no event id is still treated as a bot',
  (await rows(`path = '/scraper/'`))[0].is_bot === 1);
r = await hit('/e', { body: P({ e: '0f0f0f0f1e1e1e1e2d2d2d2d3c3c3c3c', p: '/crawler/' }), origin: SITE,
                      ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
check('a declared crawler still is', (await rows(`path = '/crawler/'`))[0].is_bot === 1);

console.log('\n=== 10. CSV export cannot carry a spreadsheet formula ===');
await hit('/e', { body: P({ e: 'ccccddddeeeeffff0000111122223333', p: '/f/', t: '=HYPERLINK("http://evil.example")',
                            l: '@SUM(A1)', s: "+cmd|'/c calc'!A0", v: '-1+1', k: 'load' }), origin: SITE });
const csvText = await (await worker.fetch(new Request(BASE + '/export.csv?token=tok&days=30'), env, ctx)).text();
const triggers = csvText.split('\n').slice(1)
  .flatMap(line => line.match(/"(?:[^"]|"")*"/g) || [])
  .filter(cell => /^"[=+\-@\t\r]/.test(cell));
check('no exported field begins with a formula trigger', triggers.length === 0, triggers.join(' | '));

console.log('\n=== 11. dashboard renders and excludes opt-outs from the headline ===');
const stats = await worker.fetch(new Request(BASE + '/stats.json?token=tok&days=30'), env, ctx);
check('/stats.json -> 200', stats.status === 200, 'got ' + stats.status);
const j = await stats.json();
// Assert against the figures the dashboard actually reports. The previous
// version of this check grepped j.countries for the string '"dnt', which is an
// ip_hash prefix and is never serialised into that array — it passed whether or
// not the filtering worked.
const win = `ts >= ${Date.now() - 30 * 86400000} AND is_bot = 0`;
const realViews = await count(`${win} AND dnt = 0 AND origin_missing = 0`);
const realUniq = (await DB.raw(
  `SELECT COUNT(DISTINCT ip_hash) u FROM visits WHERE ${win} AND dnt = 0 AND origin_missing = 0`))[0].u;
const realOptouts = await count(`ts >= ${Date.now() - 30 * 86400000} AND dnt = 1 AND origin_missing = 0`);
check('  opt-out rows excluded from pageviews and uniques',
  j.summary.views === realViews && j.summary.uniques === realUniq,
  P(j.summary) + ' expected views=' + realViews + ' uniques=' + realUniq);
check('  no opt-out bucket leaks into a unique count',
  (j.countries || []).every(c => c.u <= realUniq) && j.summary.uniques <= realUniq, P(j.countries));
check('  opt-out tile counts only real opt-outs',
  j.optouts && j.optouts.hits === realOptouts, P(j.optouts) + ' expected ' + realOptouts);
const realNoOrigin = await count(`ts >= ${Date.now() - 30 * 86400000} AND origin_missing = 1`);
check('  unverified hits counted separately', j.optouts && j.optouts.no_origin === realNoOrigin,
  P(j.optouts) + ' expected ' + realNoOrigin);
check('  and reported on their own terms, with their addresses',
  j.unverified && j.unverified.views > 0 && j.unverified.with_ip > 0, P(j.unverified));
check('  quarantined rows never enter a trusted unique count',
  j.summary.uniques === realUniq && j.unverified.views + j.summary.views <= realNoOrigin + realViews,
  P(j.summary));
check('  forged path never reaches the rankings',
  !JSON.stringify(j.pages || []).includes('/never-visited/'), P(j.pages));
check('  forged referrer never reaches the rankings',
  !JSON.stringify(j.referrers || []).includes('news.example'), P(j.referrers));
check('  forged IP never reaches the trusted IP table',
  !JSON.stringify(j.ips || []).includes('198.51.100.42'), P(j.ips));
check('  it is visible only in the quarantined one',
  JSON.stringify(j.unverifiedIps || []).includes('198.51.100.42'), P(j.unverifiedIps));
check('  the map gets located points, tagged with how many are unverified',
  Array.isArray(j.points) && j.points.length > 0 &&
  j.points.every(pt => typeof pt.lat === 'number' && typeof pt.lon === 'number') &&
  j.points.some(pt => pt.unverified > 0), P(j.points));
check('  proxied visits are listed with both addresses',
  (j.proxied || []).some(x => x.client_ip === '198.51.100.200' && x.ip === '203.0.113.7'),
  P(j.proxied));
check('  the previous period is reported, for the movement figures',
  j.previous && typeof j.previous.views === 'number', P(j.previous));
check('  transport breakdown present', Array.isArray(j.transports) && j.transports.length >= 3,
  P(j.transports));
const gr = (j.countries || []).find(c => c.k === 'GR');
check('  Greece visible in countries', !!gr, P(j.countries));
const dash = await worker.fetch(new Request(BASE + '/stats?token=tok&days=30'), env, ctx);
check('/stats HTML -> 200', dash.status === 200, 'got ' + dash.status);
const html = await dash.text();
check('  DNT tile rendered', html.includes('DNT/GPC opt-outs'));
check('  transport card rendered', html.includes('Delivery transport'));
check('  map tab and its point data are in the page',
  html.includes('data-tab="map"') && html.includes('id="vt-points"') &&
  html.includes('id="vt-canvas"'), 'map missing');
check('  the map needs no network: the land mask ships in the page',
  html.includes('WORLD_MASK') && !/https?:\/\/(?!.*ghuang14)/.test(html),
  'the dashboard pulled in a third-party resource');
check('  the embedded point JSON cannot close the script block',
  !/<script type="application\/json" id="vt-points">[^<]*<\/(?!script>)/.test(html) &&
  !html.slice(html.indexOf('id="vt-points"')).slice(0, 4000).includes('</script></script>'));
check('  the quarantined population has its own table',
  html.includes('Unverified IPs'), 'no unverified table');
check('  and the tables render a sortable, filterable header',
  html.includes('data-sort=') && html.includes('data-filters='));
const csv = await worker.fetch(new Request(BASE + '/export.csv?token=tok&days=30'), env, ctx);
const csvHead = (await csv.text()).split('\n')[0];
check('/export.csv -> 200 with new columns',
  csv.status === 200 && ['origin_missing', 'client_ip', 'origin_host'].every(c => csvHead.includes(c)),
  csvHead);
const unauth = await worker.fetch(new Request(BASE + '/stats.json?token=nope'), env, ctx);
check('bad token -> 401', unauth.status === 401, 'got ' + unauth.status);

console.log('\n=== 12. a broken migration must not lose the request ===');
{
  // Fresh database at the OLD shape, with every schema-changing statement
  // rigged to fail, so the fallback insert path is the only way a row lands.
  const DB2 = makeD1();
  await applySql(DB2, legacy);
  const realPrepare = DB2.prepare.bind(DB2);
  DB2.prepare = (sql) =>
    /ALTER TABLE|PRAGMA|CREATE UNIQUE INDEX/i.test(sql)
      ? { bind: () => DB2.prepare(sql), run: async () => { throw new Error('no schema access'); },
          all: async () => { throw new Error('no schema access'); } }
      : realPrepare(sql);
  const env2 = { ...env, DB: DB2 };
  const req = new Request(BASE + '/e', { method: 'POST', headers: { origin: SITE, 'user-agent': UA,
    'cf-connecting-ip': '203.0.113.55' }, body: P({ e: 'ffffeeeeddddccccbbbbaaaa99998888', p: '/degraded/', k: 'load' }) });
  Object.defineProperty(req, 'cf', { value: cf });
  const res2 = await worker.fetch(req, env2, ctx);
  await settle();
  const kept = await DB2.raw(`SELECT * FROM visits WHERE path = '/degraded/'`);
  check('still answers 204', res2.status === 204, 'got ' + res2.status);
  check('the visit is stored anyway, via the pre-migration columns', kept.length === 1, 'rows=' + kept.length);
  check('  with the IP and geo intact', kept[0] && kept[0].ip === '203.0.113.55' && kept[0].country === 'GR', P(kept[0]));
  DB2.close();
}

console.log('\n=== 13. schema.sql as shipped survives the deploy that re-applies it ===');
{
  // The deploy runs `wrangler d1 execute --file=./schema.sql` on EVERY push,
  // against the table that is already there, and it runs BEFORE the Worker that
  // performs the lazy migration. So anything in this file naming a late column
  // fails with "no such column", takes the deploy down, and deadlocks: the
  // Worker that would add the column is exactly what never ships.
  const DB3 = makeD1();
  await applySql(DB3, legacy);
  await DB3.raw(`INSERT INTO visits (ts, ip_hash, path, is_new, is_bot) VALUES (2, 'keep', '/kept', 0, 0)`);
  let err = null;
  try {
    await applySql(DB3, SHIPPED);   // the first deploy carrying this change
    await applySql(DB3, SHIPPED);   // and every deploy after it
  } catch (e) { err = e; }
  check('re-applies over the pre-migration table without failing', !err, err && err.message);
  check('  and leaves the existing rows alone',
    (await DB3.raw(`SELECT COUNT(*) c FROM visits WHERE path = '/kept'`))[0].c === 1);

  // The same file must still build everything from nothing.
  const DB4 = makeD1();
  await applySql(DB4, SHIPPED);
  await applySql(DB4, SHIPPED);
  const fresh = (await DB4.raw('PRAGMA table_info(visits)')).map(c => c.name);
  check('a fresh database still gets every column', LATE.every(c => fresh.includes(c)), fresh.join(','));

  // idx_visits_event lives in runMigration() rather than schema.sql, so prove
  // the Worker creates it on a database schema.sql built from scratch. A fresh
  // module instance is needed because migrate() memoises per isolate.
  const worker2 = (await import('../src/index.js?fresh-db')).default;
  const env4 = { ...env, DB: DB4 };
  const mk = (eid) => {
    const q = new Request(BASE + '/e', { method: 'POST',
      headers: { origin: SITE, 'user-agent': UA, 'cf-connecting-ip': '203.0.113.90' },
      body: P({ e: eid, p: '/fresh/', k: 'load' }) });
    Object.defineProperty(q, 'cf', { value: cf });
    return q;
  };
  await worker2.fetch(mk('abcdabcd12341234abcdabcd12341234'), env4, ctx); await settle();
  await worker2.fetch(mk('abcdabcd12341234abcdabcd12341234'), env4, ctx); await settle();
  const idx = (await DB4.raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_visits_event'`));
  check('the Worker creates idx_visits_event on a fresh database', idx.length === 1, P(idx));
  check('  so de-duplication works there too',
    (await DB4.raw(`SELECT COUNT(*) c FROM visits WHERE path = '/fresh/'`))[0].c === 1);
  DB3.close(); DB4.close();
}

console.log('\n=== 14. the client\'s own clock, when its address is somewhere else ===');
// Cloudflare reads a location off the connecting address, which belongs to the
// VPN exit / mirror / proxy whenever there is one. The browser's IANA zone is
// the client's own. The pair disagreeing is the only signal available that the
// traffic did not originate where it came out — and where this collector is not
// reachable directly, that is the only shape a request can take.
const usGeo = { ...cf, country: 'US', region: 'California', city: 'Los Angeles',
                timezone: 'America/Los_Angeles', asn: 63949, asOrganization: 'Akamai' };
await hit('/e', {
  body: P({ e: 'cn11111111111111111111111111aaaa', p: '/publications/', t: 'Pubs', r: '',
            l: 'zh-CN', s: '1440x900', v: 'vcn', n: 1, k: 'load',
            tz: 'Asia/Shanghai', tzo: 480, f: 2 }),
  origin: SITE, ip: '198.51.100.9', geo: usGeo,
});
let z = (await rows(`event_id = 'cn11111111111111111111111111aaaa'`))[0];
check('browser timezone stored alongside the IP-derived one',
  z && z.client_tz === 'Asia/Shanghai' && z.timezone === 'America/Los_Angeles', P(z));
check('  offset stored', z && z.tz_offset === 480, P(z));
check('  failover count stored', z && z.failovers === 2, P(z));

// A page can put this string in front of us, so it is matched against a shape
// rather than merely truncated.
await hit('/e', {
  body: P({ e: 'tzjunk11111111111111111111111111', p: '/j/', k: 'load',
            tz: '<script>alert(1)</script>', tzo: 99999 }),
  origin: SITE,
});
let zj = (await rows(`event_id = 'tzjunk11111111111111111111111111'`))[0];
check('a timezone that is not one is rejected outright', zj && zj.client_tz === null, P(zj));
check('  and so is an offset no clock has', zj && zj.tz_offset === null, P(zj));

// Deliberate, and the opposite of how title/referrer/id are treated: these rows
// ARE the traffic that could not reach the endpoint directly, and one that
// cannot say where it came from is not worth storing. It stays out of every
// trusted figure regardless.
await hit('/e', {
  body: P({ e: 'noorigin1111111111111111111tzaa', p: '/q/', k: 'pixel', tz: 'Asia/Urumqi', tzo: 480 }),
});
let zq = (await rows(`event_id = 'noorigin1111111111111111111tzaa'`))[0];
check('an unverified hit keeps its timezone (it is the only locator it has)',
  zq && zq.client_tz === 'Asia/Urumqi' && zq.origin_missing === 1, P(zq));

await hit('/e', { body: P({ e: 'dnttz1111111111111111111111111aa', d: 1, p: '/d/', k: 'load', tz: 'Asia/Shanghai', tzo: 480 }), origin: SITE });
let zd = (await rows(`event_id = 'dnttz1111111111111111111111111aa'`))[0];
check('an opt-out is never given one, whatever it sends',
  zd && zd.client_tz === null && zd.tz_offset === null && zd.dnt === 1, P(zd));

console.log('\n=== 15. THE RETRY-QUEUE FIX: a pageview replayed from the browser queue ===');
// The one case racing endpoints cannot cover: no endpoint reachable at all, so
// nothing connects while the page is open. The browser keeps the pageview and
// replays it from a network that works — days later, from a different address.
// It has to land on the day it HAPPENED, or the whole point (knowing when the
// request occurred) is lost.
const THREE_DAYS = 3 * 86400000;
const replayedAt = Date.now();
await hit('/e', {
  body: P({ e: 'queued11111111111111111111111111', p: '/blocked/', t: 'T', r: '', l: 'zh-CN',
            s: '390x844', v: 'vq', n: 0, k: 'load', tz: 'Asia/Shanghai', tzo: 480,
            f: 3, qt: THREE_DAYS }),
  origin: SITE, ip: '198.51.100.9', geo: usGeo,
});
let q1 = (await rows(`event_id = 'queued11111111111111111111111111'`))[0];
check('a replayed hit is filed on the day it happened, not the day it arrived',
  q1 && Math.abs((replayedAt - THREE_DAYS) - q1.ts) < 5000, q1 && `ts is ${replayedAt - q1.ts}ms ago`);
check('  and says how long it waited', q1 && q1.queued_ms === THREE_DAYS, P(q1));
check('  keeping the clock that identifies the network it happened on',
  q1 && q1.client_tz === 'Asia/Shanghai', P(q1));

// The queue replays an id that may already have landed by some other transport.
const dupBefore = await count(`event_id = 'queued11111111111111111111111111'`);
await hit('/e', {
  body: P({ e: 'queued11111111111111111111111111', p: '/blocked/', k: 'load', qt: THREE_DAYS }),
  origin: SITE, ip: '198.51.100.9', geo: usGeo,
});
check('  replaying an id that already landed does not count it twice',
  (await count(`event_id = 'queued11111111111111111111111111'`)) === dupBefore && dupBefore === 1);

// The case the (event_id, ip_hash) index cannot see. A client bounces, the
// pageview is parked on pagehide while the keepalive fetch is still in flight,
// that fetch lands after the tab is gone, and the parked copy is replayed from
// somewhere else days later — a different address, so a different ip_hash.
await hit('/e', {
  body: P({ e: 'bounce111111111111111111111111aa', p: '/bounced/', k: 'load', tz: 'Asia/Shanghai', tzo: 480 }),
  origin: SITE, ip: '203.0.113.7',
});
check('the original bounce landed once', (await count(`event_id = 'bounce111111111111111111111111aa'`)) === 1);
await hit('/e', {
  body: P({ e: 'bounce111111111111111111111111aa', p: '/bounced/', k: 'load',
            tz: 'Asia/Shanghai', tzo: 480, qt: THREE_DAYS }),
  origin: SITE, ip: '198.51.100.77', geo: usGeo,
});
check('  and its replay from a different network does not become a second row',
  (await count(`event_id = 'bounce111111111111111111111111aa'`)) === 1,
  P(await rows(`event_id = 'bounce111111111111111111111111aa'`)));

// Both bounds treat a bad value as "not a replay" rather than dropping the hit:
// the pageview is real either way, it just gets filed on arrival.
await hit('/e', { body: P({ e: 'qtsmall111111111111111111111111a', p: '/s/', k: 'load', qt: 900 }), origin: SITE });
let q2 = (await rows(`event_id = 'qtsmall111111111111111111111111a'`))[0];
check('an age under a minute is a live hit, whatever it claims',
  q2 && q2.queued_ms === null && Math.abs(Date.now() - q2.ts) < 5000, P(q2));
await hit('/e', { body: P({ e: 'qtwild1111111111111111111111111a', p: '/w/', k: 'load', qt: 400 * 86400000 }), origin: SITE });
let q3 = (await rows(`event_id = 'qtwild1111111111111111111111111a'`))[0];
check('a clock a year out cannot backdate a row past the queue window',
  q3 && q3.queued_ms === null && Math.abs(Date.now() - q3.ts) < 5000, P(q3));
await hit('/e', { body: P({ e: 'qtneg11111111111111111111111111a', p: '/n/', k: 'load', qt: -99999999 }), origin: SITE });
let q4 = (await rows(`event_id = 'qtneg11111111111111111111111111a'`))[0];
check('  nor can a negative one push it into the future',
  q4 && q4.queued_ms === null && q4.ts <= Date.now() + 1000, P(q4));
await hit('/e', { body: P({ e: 'fclamp1111111111111111111111111a', p: '/f/', k: 'load', f: 1e9 }), origin: SITE });
let q5 = (await rows(`event_id = 'fclamp1111111111111111111111111a'`))[0];
check('the failover counter is clamped', q5 && q5.failovers === 99, P(q5));

console.log('\n=== 15a. time-to-send is recorded, so a slow send path is visible ===');
// A visitor who closes the tab before their pageview is dispatched leaves no
// row at all, so a regression in the send path cannot be seen by counting rows
// — it looks like less traffic. The page measures its own dispatch latency and
// reports it, and that is the only signal that distinguishes the two.
await hit('/e', { body: P({ e: 'lat1111111111111111111111111111a', p: '/fast/', k: 'load', dt: 12 }), origin: SITE });
let L = (await rows(`event_id = 'lat1111111111111111111111111111a'`))[0];
check('a reported dispatch latency is stored', L && L.latency_ms === 12, P(L));
await hit('/e', { body: P({ e: 'lat2222222222222222222222222222a', p: '/noclock/', k: 'load', dt: -1 }), origin: SITE });
L = (await rows(`event_id = 'lat2222222222222222222222222222a'`))[0];
check('a client with no performance clock stores NULL, not a flattering zero',
  L && L.latency_ms === null, P(L));
await hit('/e', { body: P({ e: 'lat3333333333333333333333333333a', p: '/parked/', k: 'load', dt: 99999999 }), origin: SITE });
L = (await rows(`event_id = 'lat3333333333333333333333333333a'`))[0];
check('  an absurd value is rejected rather than skewing the median', L && L.latency_ms === null, P(L));
await hit('/e', { body: P({ e: 'lat4444444444444444444444444444a', p: '/junk/', k: 'load', dt: 'soon' }), origin: SITE });
L = (await rows(`event_id = 'lat4444444444444444444444444444a'`))[0];
check('  so is a non-numeric one', L && L.latency_ms === null, P(L));
await hit('/e', { body: P({ e: 'lat5555555555555555555555555555a', p: '/slow/', k: 'load', dt: 2400 }), origin: SITE });
{
  const js = await (await worker.fetch(new Request(BASE + '/stats.json?token=tok&days=30'), env, ctx)).json();
  check('the dashboard reports the distribution, not just a mean',
    js.sendLatency && js.sendLatency.n >= 2 &&
    typeof js.sendLatency.p50 === 'number' && typeof js.sendLatency.p95 === 'number' &&
    js.sendLatency.worst >= 2400, P(js.sendLatency));
  check('  and how many made it out inside a second',
    js.sendLatency && js.sendLatency.under1s >= 1 && js.sendLatency.under1s <= js.sendLatency.n,
    P(js.sendLatency));
  const html = await (await worker.fetch(new Request(BASE + '/stats?token=tok&days=30'), env, ctx)).text();
  check('  and renders it on the Delivery tab', html.includes('Median time to send') &&
    html.includes('Time to send'), 'latency card missing');
}

console.log('\n=== 15b. THE POINT OF ALL THIS: the client address survives the queue ===');
// A replay reaches us over whatever network eventually connected, so its
// connecting address belongs to that route. The address that matters is the one
// the browser found for ITSELF while the page was open and carried in the queue
// — without it a recovered pageview records that a request happened and nothing
// at all about where it came from.
const sgGeo = { ...cf, country: 'SG', region: 'Singapore', city: 'Singapore',
                timezone: 'Asia/Singapore', asn: 9009, asOrganization: 'M247',
                latitude: '1.35', longitude: '103.8' };
await hit('/e', {
  body: P({ e: 'recovip111111111111111111111aaaa', p: '/recovered/', k: 'load',
            tz: 'Asia/Shanghai', tzo: 480, qt: THREE_DAYS, ci: '223.5.5.5' }),
  origin: SITE, ip: '198.51.100.200', geo: sgGeo,
});
let ri = (await rows(`event_id = 'recovip111111111111111111111aaaa'`))[0];
check('the address captured during the visit is stored', ri && ri.client_ip === '223.5.5.5', P(ri));
check('  and the escape route is kept separate, not passed off as the client',
  ri && ri.ip === '198.51.100.200' && ri.client_ip !== ri.ip, P(ri));

// One client, two different routes out on two days. Hashing the relay would
// make them two new uniques every time.
await hit('/e', {
  body: P({ e: 'recovip222222222222222222222aaaa', p: '/recovered2/', k: 'load',
            tz: 'Asia/Shanghai', tzo: 480, qt: THREE_DAYS + 60000, ci: '223.5.5.5' }),
  origin: SITE, ip: '203.0.113.250', geo: usGeo,
});
const r2 = (await rows(`event_id = 'recovip222222222222222222222aaaa'`))[0];
check('two replays of one client are one unique, whatever route each took out',
  ri && r2 && ri.ip_hash === r2.ip_hash && ri.ip !== r2.ip, P([ri && ri.ip_hash, r2 && r2.ip_hash]));

console.log('\n=== 16. relayed traffic reaches the dashboard ===');
{
  const js = await (await hit('/stats.json?days=0&token=tok', { method: 'GET', origin: SITE })).json();
  const zones = js.relayed.map(r => r.k);
  check('relayed connections are reported', zones.includes('Asia/Shanghai'), P(zones));
  const row = js.relayed.find(r => r.k === 'Asia/Shanghai');
  check('  paired with what the address resolved to', row && row.ip_tz === 'America/Los_Angeles', P(row));
  check('  and counted in the tile', js.relayedTotal.hits >= 2 && js.relayedTotal.zones >= 1, P(js.relayedTotal));
  check('recovered pageviews are reported',
    js.recovered.hits === (await count(`queued_ms IS NOT NULL`)) && js.recovered.hits > 0
      && js.recovered.longest === THREE_DAYS + 60000,
    P(js.recovered));
  check('  with a row to inspect', js.recoveredRows.some(r => r.path === '/blocked/' && r.client_tz === 'Asia/Shanghai'), P(js.recoveredRows));
  check('delivery cost is reported', js.failoverTotal.hits >= 2 && js.failoverTotal.worst === 99, P(js.failoverTotal));

  // An opt-out must not be able to appear here: it is the one class of row that
  // is counted and never located.
  check('  no opt-out row leaks into the relayed table',
    js.relayed.every(r => r.k && r.k !== null) && js.relayedTotal.hits === (await count(
      `dnt = 0 AND is_bot = 0 AND client_tz IS NOT NULL AND client_tz != '' AND timezone IS NOT NULL AND timezone != '' AND client_tz != timezone`)),
    P(js.relayedTotal));

  // The misattribution this exists to stop: a request made elsewhere and relayed
  // out through Singapore must never be reported as Singaporean traffic.
  check('the escape route is not counted as a country',
    !js.countries.some(c => c.k === 'SG'), P(js.countries.map(c => c.k)));
  check('  nor as a city', !js.cities.some(c => /Singapore/.test(c.k)), P(js.cities.map(c => c.k)));
  check('  nor as a network', !js.networks.some(n => /M247/.test(n.k)), P(js.networks.map(n => n.k)));
  check('  nor as a point on the map',
    !js.points.some(pt => pt.country === 'SG'), P(js.points.map(pt => pt.country)));
  check('but the pageview itself is still counted',
    (await count(`event_id = 'recovip111111111111111111111aaaa'`)) === 1);
  check('  and its address is reachable from the proxied table',
    js.proxied.some(x => x.client_ip === '223.5.5.5'), P(js.proxied.map(x => x.client_ip)));

  const html = await (await hit('/stats?days=0&token=tok', { method: 'GET', origin: SITE })).text();
  check('the Restricted tab exists', html.includes('data-panel="restricted"') && html.includes('data-tab="restricted"'));
  check('  and shows the client\'s clock against the address', html.includes('Asia/Shanghai') && html.includes('America/Los_Angeles'));
  check('  and the recovered pageview, in days not milliseconds', html.includes('>3d<'), 'no coarse duration rendered');
  check('  and the address recovered from the blocked network', html.includes('223.5.5.5'));

  const csv = await (await hit('/export.csv?days=0&token=tok', { method: 'GET', origin: SITE })).text();
  check('the export carries the new columns',
    /client_tz/.test(csv) && /tz_offset/.test(csv) && /queued_ms/.test(csv) && /failovers/.test(csv),
    csv.split('\n')[0]);
  check('  with the values in them', csv.includes('"Asia/Shanghai"'));
}

console.log('\n=== 17. relayed requests are drawn where they originate, not where they exit ===');
{
  const js = await (await hit('/stats.json?days=0&token=tok', { method: 'GET', origin: SITE })).json();
  const cn = js.tzPoints.find(t => t.tz === 'Asia/Shanghai');
  check('the client\'s own zone is grouped for the map', !!cn && cn.c >= 2, P(js.tzPoints));

  const html = await (await hit('/stats?days=0&token=tok', { method: 'GET', origin: SITE })).text();
  const m = html.match(/<script type="application\/json" id="vt-points">([\s\S]*?)<\/script>/);
  const pts = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  const drawn = pts.find(x => x.tz && x.zone === 'Asia/Shanghai');
  check('it is plotted at the zone\'s coordinates, in China',
    !!drawn && Math.abs(drawn.lat - 31.23) < 0.5 && Math.abs(drawn.lon - 121.47) < 0.5,
    P(drawn));
  check('  flagged as placed by the clock, so the map can draw it apart',
    !!drawn && drawn.tz === 1 && drawn.country === 'CN', P(drawn));
  check('  and NOT also plotted at the address it came out of',
    !pts.some(x => !x.tz && x.country === 'US'), P(pts.filter(x => !x.tz).map(x => x.country)));
  check('the legend explains the third kind of bubble',
    html.includes('--map-tz') && /Placed by the client's own clock/.test(html));

  // A zone with no coordinates must be reported, not silently dropped.
  await hit('/e', {
    body: P({ e: 'weirdzone11111111111111111111aa', p: '/z/', k: 'load', tz: 'Mars/Olympus', tzo: 0 }),
    origin: SITE, ip: '198.51.100.31', geo: usGeo,
  });
  const html2 = await (await hit('/stats?days=0&token=tok', { method: 'GET', origin: SITE })).text();
  check('an unplaceable zone is counted and admitted to, not dropped in silence',
    /could not be placed/.test(html2), 'no unplaceable note rendered');
}

console.log('\n=== 18. the pages.dev collector is the same collector ===');
// The second host exists because *.workers.dev does not resolve on some
// networks while *.pages.dev does. It is served by Pages "advanced mode": the
// deploy copies src/index.js to public/_worker.js and Cloudflare runs it for
// every request. So what has to hold is that src/index.js is usable as that
// file *verbatim* — the previous layout re-exported it from a
// functions/[[path]].js, and shipped a deployment with no Worker running at all.
{
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('the worker has no imports, so it can be copied rather than bundled',
    !/^\s*import\s/m.test(src) && !/\brequire\(/.test(src),
    (src.match(/^\s*import\s.*/m) || [''])[0]);
  check('  and default-exports the module shape Pages runs',
    typeof worker.fetch === 'function' && /export default/.test(src));

  // Drive it exactly as Pages would: same module, request from the pages.dev
  // hostname, and an address on a network where workers.dev does not resolve.
  const req = new Request('https://visitor-tracker-cn.pages.dev/e', {
    method: 'POST',
    body: P({ e: 'viapages1111111111111111111111aa', p: '/via-pages/', k: 'load',
              tz: 'Asia/Shanghai', tzo: 480 }),
    headers: { origin: SITE, 'user-agent': UA, 'cf-connecting-ip': '198.51.100.217' },
  });
  Object.defineProperty(req, 'cf', { value: { ...cf, country: 'CN', city: 'Testville',
    region: 'Testshire', timezone: 'Asia/Shanghai', asn: 4134, asOrganization: 'Example Telecom' } });
  const res = await worker.fetch(req, env, ctx);
  await settle();
  check('a hit through the pages.dev collector is accepted', res.status === 204, 'got ' + res.status);
  const row = (await rows(`event_id = 'viapages1111111111111111111111aa'`))[0];
  check('  and lands in the same table as everything else',
    row && row.ip === '198.51.100.217' && row.country === 'CN', P(row));
  check('  with a Chinese address recorded directly, no queue involved',
    row && row.queued_ms === null && row.client_tz === 'Asia/Shanghai', P(row));

  // The failure that shipped: an unknown path must be the collector's 404, not
  // a static placeholder answering 200, which is what the live site returned.
  const miss = await worker.fetch(
    new Request('https://visitor-tracker-cn.pages.dev/nope'), env, ctx);
  check('an unknown path is the collector 404 the deploy check looks for',
    miss.status === 404 && (await miss.text()) === 'Not found',
    'status ' + miss.status);
}

console.log('\n=== 19. a collector with no IP_SALT says so ===');
// The one misconfiguration that produces a working collector with wrong numbers:
// two collectors on one database, salted differently, counting every client
// they both see twice. The secret cannot be read back from Cloudflare, so it is
// easy to leave off the second deployment.
{
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  const { IP_SALT, ...noSalt } = env;
  await hit('/e', { body: P({ e: 'nosalt111111111111111111111111aa', p: '/ns/', k: 'load' }),
                    origin: SITE, env: noSalt });
  console.error = realError;
  check('the visit is still recorded rather than refused',
    (await count(`event_id = 'nosalt111111111111111111111111aa'`)) === 1);
  check('  and the mismatch is reported, not swallowed',
    errs.some(e => /IP_SALT is not set/.test(e)), P(errs));
  const salted = (await rows(`event_id = 'nosalt111111111111111111111111aa'`))[0];
  const other = (await rows(`event_id = 'aaaa1111bbbb2222cccc3333dddd4444'`))[0];
  check('  the two salts really do produce different buckets for one address',
    salted && other && salted.ip === other.ip && salted.ip_hash !== other.ip_hash,
    P([salted && salted.ip_hash, other && other.ip_hash]));
}

console.log('\n=== 20. changing IP_SALT need not split a returning client in two ===');
// IP_SALT cannot be read back out of Cloudflare, so a second collector can end
// up needing a salt nobody still has. The standard answer — "never change it" —
// holds only because ip_hash is computed at insert and stored, so a new salt
// buckets the same client two ways either side of the change.
//
// But `ip` and `client_ip` are stored too, so every salted hash is
// reconstructible. The claim under test is the strong one: after the backfill,
// a database written under salt A is byte-identical, in ip_hash, to one written
// under salt B from the start.
{
  const { plan, hash, isBucket, sourceOf } = await import('../tools/resalt.mjs');

  const build = async (saltValue, mod) => {
    const db = makeD1();
    await applySql(db, SHIPPED);
    const w = (await import('../src/index.js?resalt' + mod)).default;
    const e = { ...env, DB: db, IP_SALT: saltValue };
    const send = async (body, { ip = '203.0.113.7', origin = SITE, geo = cf, headers = {} } = {}) => {
      const h = { 'user-agent': UA, ...headers };
      if (ip) h['cf-connecting-ip'] = ip;
      if (origin) h.origin = origin;
      const req = new Request(BASE + '/e', { method: 'POST', body: P(body), headers: h });
      Object.defineProperty(req, 'cf', { value: geo });
      await w.fetch(req, e, ctx);
      await settle();
    };
    // One of every shape that reaches ip_hash by a different route.
    await send({ e: 'rs01' + '0'.repeat(28), p: '/a/', k: 'load' });
    await send({ e: 'rs02' + '0'.repeat(28), p: '/b/', k: 'load' }, { ip: '198.51.100.9' });
    await send({ e: 'rs03' + '0'.repeat(28), p: '/c/', k: 'load', d: 1 });            // dnt bucket
    await send({ e: 'rs04' + '0'.repeat(28), p: '/d/', k: 'pixel' }, { origin: null }); // unverified
    await send({ e: 'rs05' + '0'.repeat(28), p: '/e/', k: 'load',                      // replay
                 qt: 3 * 86400000, ci: '223.5.5.5' }, { ip: '198.51.100.9' });
    await send({ e: 'rs06' + '0'.repeat(28), p: '/f/', k: 'load' }, { ip: null });      // no address
    return db;
  };

  const A = await build('salt-alpha-value', 'A');
  const B = await build('salt-bravo-value', 'B');

  const rowsOf = async (db) =>
    await db.raw('SELECT id, ip, client_ip, queued_ms, ip_hash, path FROM visits ORDER BY id');
  const rowsOfWithEvent = async (db) =>
    await db.raw('SELECT id, event_id, ip, client_ip, queued_ms, ip_hash FROM visits ORDER BY id');
  const before = await rowsOf(A), target = await rowsOf(B);

  check('the two salts really do disagree to begin with',
    before.some((r, i) => r.ip_hash !== target[i].ip_hash),
    'no row differed, so this proves nothing');

  const p = plan(before, 'salt-bravo-value');
  check('opt-out rows are recognised as unsalted buckets and left alone',
    p.buckets === 1 && before.filter(r => isBucket(r.ip_hash)).length === 1,
    P({ buckets: p.buckets }));

  for (const w of p.writes) {
    await A.raw(`UPDATE visits SET ip_hash = '${w.ip_hash}' WHERE id = ${w.id}`);
  }
  const after = await rowsOf(A);

  check('after the backfill every hash matches the from-scratch database',
    after.every((r, i) => r.ip_hash === target[i].ip_hash),
    P(after.map((r, i) => r.ip_hash === target[i].ip_hash ? null : [r.path, r.ip_hash, target[i].ip_hash]).filter(Boolean)));
  check('  including the replayed row, keyed on the address from the visit',
    after.find(r => r.path === '/e/').ip_hash === hash('223.5.5.5|salt-bravo-value'),
    P(after.find(r => r.path === '/e/')));
  check('  and the row that arrived with no address at all',
    after.find(r => r.path === '/f/').ip_hash === hash('|salt-bravo-value'),
    P(after.find(r => r.path === '/f/')));
  check('  and uniques therefore do not split across the change',
    (await A.raw('SELECT COUNT(DISTINCT ip_hash) u FROM visits'))[0].u ===
    (await B.raw('SELECT COUNT(DISTINCT ip_hash) u FROM visits'))[0].u);

  // An interrupted run must be safe to repeat.
  const second = plan(after, 'salt-bravo-value');
  check('re-running the backfill is a no-op, so an interrupted one just runs again',
    second.writes.length === 0, P(second));

  // The one schema-level way a re-salt can abort: idx_visits_event is UNIQUE on
  // (event_id, ip_hash), so two rows of one pageview rewritten to one hash kill
  // the batch. Under a single salt that is unreachable — different old hashes
  // imply different addresses imply different new hashes — but it becomes
  // reachable the moment the derivation changes rather than the salt, which is
  // what replayed pageviews keying on client_ip already did once.
  const { collisions } = await import('../tools/resalt.mjs');
  const siblings = [
    { id: 1, event_id: 'ev1', ip: '1.1.1.1', client_ip: null, queued_ms: null, ip_hash: 'old-a' },
    { id: 2, event_id: 'ev1', ip: '1.1.1.1', client_ip: null, queued_ms: null, ip_hash: 'old-b' },
  ];
  check('two rows of one pageview collapsing onto one hash is caught before writing',
    P(collisions(siblings, 'salt-bravo-value')) === P([[1, 2]]), P(collisions(siblings, 'salt-bravo-value')));
  check('  and distinct addresses under one event id are not a collision',
    collisions([siblings[0], { ...siblings[1], id: 2, ip: '2.2.2.2' }], 'salt-bravo-value').length === 0);
  check('  and the real database has no such group',
    collisions(await rowsOfWithEvent(A), 'salt-bravo-value').length === 0);

  A.close(); B.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
DB.close();
process.exit(fail ? 1 : 0);
