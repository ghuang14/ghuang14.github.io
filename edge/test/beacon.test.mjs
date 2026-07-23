// Behavioural tests for _includes/edge-client.html, run against the script
// as it is actually served (Liquid-rendered and whitespace-collapsed by
// _layouts/compress.html), inside a stubbed DOM. Run with `npm test`.

import vm from 'node:vm';
import { render } from './render-include.mjs';

// The script exactly as a browser receives it: Liquid-rendered, then put
// through the _layouts/compress.html whitespace collapse.
const SRC1 = render({ fallback_endpoint: '' });
// Two hosts, with the hedge cut from 1200ms to 30ms so the race is testable.
const SRC2 = render({ fallback_endpoint: 'https://t2.example.net/e', hedge_ms: 30 });

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
                               : (fail++, console.log('  FAIL  ' + n + (d ? '\n        ' + d : ''))); };

const T0 = Date.now();

function run(src, opts = {}) {
  // `fetch` is the transport for both the hit and the echo lookup, so they
  // are logged apart: a hit carries a body, an echo lookup does not.
  // `order` records the interleaving of the two, which is the thing the send
  // path is now sensitive to: the pageview must not queue behind a
  // third-party address lookup.
  const log = { fetch: [], beacon: [], image: [], echo: [], enrich: [], order: [] };
  const listeners = { document: {}, window: {} };
  const add = (bag) => (t, f) => { (bag[t] = bag[t] || []).push(f); };

  const doc = {
    readyState: opts.readyState || 'complete',
    visibilityState: 'visible',
    title: 'Publications',
    referrer: opts.referrer ?? 'https://scholar.google.com/',
    addEventListener: add(listeners.document),
  };
  // Shared between runs when a test needs a later pageview to see what an
  // earlier one left behind — which is the whole of the store-and-forward path.
  const store = opts.store || {};
  const ls = opts.storageThrows
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  // Shared between runs when a test wants a second pageview in the same tab.
  const session = opts.session || {};
  const ss = { getItem: k => (k in session ? session[k] : null),
               setItem: (k, v) => { session[k] = v; } };

  const ctx = {
    location: { hostname: opts.hostname || 'ghuang14.github.io', pathname: '/publications/', search: '' },
    document: doc,
    navigator: {
      doNotTrack: opts.dnt ? '1' : undefined,
      globalPrivacyControl: opts.gpc || undefined,
      language: 'en-US',
      sendBeacon: opts.noBeacon ? undefined : (url, blob) => { log.beacon.push(url); return true; },
    },
    screen: { width: 1512, height: 982 },
    // Every real browser has this; the beacon measures its own time-to-send
    // with it. opts.noPerf drops it, to prove the send still happens without.
    performance: opts.noPerf ? undefined : { now: () => Date.now() - T0 },
    localStorage: ls,
    sessionStorage: ss,
    setTimeout, clearTimeout,
    // Shaped like a real one. The Worker only honours an event id matching
    // /^[0-9a-z]{16,64}$/ and silently stores null for anything else, so a stub
    // that is merely unique would let a beacon whose ids the Worker rejects
    // pass every test here.
    crypto: opts.noCrypto ? undefined : {
      randomUUID: () => {
        const h = (n) => Array.from({ length: n },
          () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
        return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
      },
    },
    Blob: class { constructor(p) { this.p = p; } },
    Image: class {
      constructor() { this.onerror = null; log.image.push(this); }
      set src(v) { this._src = v; log.image[log.image.length - 1].url = v;
        if (opts.imageFails) queueMicrotask(() => this.onerror && this.onerror());
        else if (opts.imageLoads) queueMicrotask(() => this.onload && this.onload()); }
      get src() { return this._src; }
    },
    fetch: opts.noFetch ? undefined : (url, init) => {
      init = init || {};
      if (!init.body) {
        // An echo lookup. Answers with opts.echoIp when the test supplies
        // one, and otherwise with a failure, which is what an unreachable or
        // CORS-refusing echo service looks like.
        log.echo.push(url);
        log.order.push('echo');
        if (opts.echoHangs) return new Promise(() => {});
        if (opts.echoIp === undefined) return Promise.resolve({ ok: false, status: 403 });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(opts.echoIp) });
      }
      const body = JSON.parse(init.body);
      if (body.x) { log.enrich.push({ url, body }); return Promise.resolve({ ok: true, status: 204 }); }
      log.fetch.push({ url, init, body });
      log.order.push('hit');
      if (opts.fetchHangs) return new Promise(() => {});
      if (opts.fetchRejects) return Promise.reject(new TypeError('Failed to fetch'));
      if (opts.fetchThrows) throw new TypeError('fetch is not a function');
      return Promise.resolve({ ok: opts.fetchStatus ? opts.fetchStatus < 400 : true,
                               status: opts.fetchStatus || 204 });
    },
  };
  // `window` IS the global in a browser, so the listener bag lives on ctx itself.
  ctx.addEventListener = add(listeners.window);
  ctx.doNotTrack = opts.dnt ? '1' : undefined;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  const fire = (bag, t, ev) => (listeners[bag][t] || []).forEach(f => f(ev));
  return { log, fire, ctx, session, store };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const drain = () => wait(20);
const hosts = (list) => list.map(f => new URL(f.url).host);

console.log('\n=== A. normal request: one send, and it is a fetch ===');
let r = run(SRC1); await drain();
check('exactly one fetch', r.log.fetch.length === 1, JSON.stringify(r.log.fetch.map(f => f.url)));
check('no sendBeacon (the EasyPrivacy $ping rule drops it)', r.log.beacon.length === 0);
check('no pixel', r.log.image.length === 0);
check('keepalive set', r.log.fetch[0].init.keepalive === true);
check('payload complete', (b => b.p === '/publications/' && b.t === 'Publications' && b.l === 'en-US'
  && b.s === '1512x982' && b.n === 1 && !!b.v && !!b.e && b.k === 'load')(r.log.fetch[0].body),
  JSON.stringify(r.log.fetch[0].body));

console.log('\n=== B. uBlock/Brave client: sendBeacon refused, fetch allowed ===');
r = run(SRC1, { noBeacon: true }); await drain();
check('still exactly one fetch, hit is recorded', r.log.fetch.length === 1);
check('never falls back', r.log.beacon.length === 0 && r.log.image.length === 0);

console.log('\n=== C. endpoint answers 403 (the old code called this success) ===');
r = run(SRC1, { fetchStatus: 403 }); await drain();
check('status inspected -> falls back', r.log.beacon.length === 1 && r.log.image.length === 1,
  `beacon=${r.log.beacon.length} img=${r.log.image.length}`);
check('pixel carries the SAME event id (server de-dupes)',
  decodeURIComponent(r.log.image[0].url).includes(r.log.fetch[0].body.e));

console.log('\n=== D. network failure ===');
r = run(SRC1, { fetchRejects: true }); await drain();
check('rejection -> beacon + pixel', r.log.beacon.length === 1 && r.log.image.length === 1);

console.log('\n=== E. no fetch() at all (ancient browser) ===');
r = run(SRC1, { noFetch: true }); await drain();
check('beacon + pixel still fire', r.log.beacon.length === 1 && r.log.image.length === 1);

console.log('\n=== F. second endpoint failover (fallback_endpoint set) ===');
r = run(SRC2, { fetchRejects: true, imageFails: true }); await drain(); await drain();
check('both endpoints attempted', r.log.fetch.length === 2, JSON.stringify(r.log.fetch.map(f => f.url)));
check('second host is the fallback', (r.log.fetch[1] || {}).url === 'https://t2.example.net/e');
check('same event id across hosts -> no double count',
  r.log.fetch[0].body.e === (r.log.fetch[1] || {}).body?.e);

console.log('\n=== M. THE HUNG-HOST FIX: one dead endpoint no longer strands the rest ===');
// A host that does not resolve, or whose packets go nowhere, never fails
// outright — it hangs, long past the point where the client has navigated away
// and no JavaScript is left to fail over. The old chain only started host 2
// after host 1 had *proved* itself dead, so on the networks where host 1 hangs
// the fallback endpoint was never reached at all.
r = run(SRC2, { fetchHangs: true });
await drain();
check('the hung host has not answered, and nothing else has been tried yet',
  r.log.fetch.length === 1, JSON.stringify(hosts(r.log.fetch)));
await wait(90);
check('the second host is tried anyway, on the hedge timer',
  r.log.fetch.length === 2 && hosts(r.log.fetch)[1] === 't2.example.net',
  JSON.stringify(hosts(r.log.fetch)));
check('  carrying the same event id, so the two collapse into one row',
  r.log.fetch[0].body.e === r.log.fetch[1].body.e);

console.log('\n=== N. the hedge costs nothing when the first host works ===');
r = run(SRC2); await wait(90);
check('one host answered -> the second is never contacted', r.log.fetch.length === 1,
  JSON.stringify(hosts(r.log.fetch)));

console.log('\n=== O. the connecting address, for requests that arrive through a proxy ===');
r = run(SRC2, { echoIp: '{"code":"Success","ip":"203.0.113.99"}' });
await wait(60);
check('an echo lookup was made', r.log.echo.length >= 1, JSON.stringify(r.log.echo));
check('the pageview itself was NOT delayed for it',
  r.log.fetch.length === 1 && r.log.fetch[0].body.ci === undefined,
  JSON.stringify(r.log.fetch[0].body));
check('the address is filled in afterwards, on the host that answered',
  r.log.enrich.length === 1 && r.log.enrich[0].body.ci === '203.0.113.99' &&
  r.log.enrich[0].url === r.log.fetch[0].url, JSON.stringify(r.log.enrich));
check('  the follow-up reuses the event id and is marked as an update, not a hit',
  r.log.enrich[0].body.e === r.log.fetch[0].body.e && r.log.enrich[0].body.x === 1);

const tab = {};
r = run(SRC2, { echoIp: '{"ip":"203.0.113.99"}', session: tab }); await wait(60);
let r2 = run(SRC2, { echoIp: '{"ip":"203.0.113.99"}', session: tab }); await wait(60);
check('a second pageview in the same tab carries it inline instead',
  r2.log.fetch[0].body.ci === '203.0.113.99' && r2.log.enrich.length === 0,
  JSON.stringify(r2.log.fetch[0].body));
check('  and does not look it up again', r2.log.echo.length === 0);

r = run(SRC2, { echoIp: '198.51.100.5' });
await wait(60);
check('a plain-text echo response is parsed too', r.log.enrich.length === 1 &&
  r.log.enrich[0].body.ci === '198.51.100.5', JSON.stringify(r.log.enrich));

r = run(SRC2, { gpc: true, echoIp: '203.0.113.99' }); await wait(60);
check('an opt-out request never reaches the third-party echo service',
  r.log.echo.length === 0 && r.log.enrich.length === 0);

// The uBlock/Brave shape: the fetch is refused, the pixel gets through. Its
// onload is then the only delivery signal there is, so it has to be what
// releases the follow-up too, or the address is never attached for exactly the
// clients that had to fall back.
r = run(SRC1, { fetchStatus: 403, imageLoads: true, echoIp: '203.0.113.77' });
await wait(60);
check('a hit delivered only by the pixel still gets its address filled in',
  r.log.enrich.length === 1 && r.log.enrich[0].body.ci === '203.0.113.77' &&
  r.log.enrich[0].body.e === r.log.fetch[0].body.e, JSON.stringify(r.log.enrich));

console.log('\n=== G. GPC / DNT request is counted, and nothing else is sent ===');
r = run(SRC1, { gpc: true }); await drain();
const b = r.log.fetch[0].body;
check('minimal payload sent', b.d === 1 && b.p === '/publications/' && !!b.e);
check('no id, title, referrer, language or screen',
  b.v === undefined && b.t === undefined && b.r === undefined && b.l === undefined && b.s === undefined,
  JSON.stringify(b));

console.log('\n=== H. storage unavailable (Safari private) ===');
r = run(SRC1, { storageThrows: true }); await drain();
check('no throwaway id, is_new=0 -> uniques not inflated',
  r.log.fetch[0].body.v === '' && r.log.fetch[0].body.n === 0, JSON.stringify(r.log.fetch[0].body));

console.log('\n=== I. THE TIMING FIX: sent at parse time, on no event at all ===');
// The send path has been wrong twice, each time by waiting for something.
// `load` waits on every subresource including the async MathJax bundle.
// DOMContentLoaded waits for the whole document to parse — and the script used
// to sit at the bottom of <body> behind a render-blocking main.min.js, so the
// wait was: fetch main.min.js, execute it, parse the remaining ~70%, and only
// then open a cold connection to a third-party host. Anyone who left inside
// that window was never counted. It now runs from <head> and sends
// immediately, while the document is still parsing.
r = run(SRC1, { readyState: 'loading' });
await drain();
check('the pageview is already on the wire while the document is still parsing',
  r.log.fetch.length === 1, 'sent ' + r.log.fetch.length + ' — still waiting for an event');
check('  it did not wait for DOMContentLoaded', r.log.fetch.length === 1);
const firstEid = r.log.fetch[0].body.e;
r.fire('document', 'DOMContentLoaded', {});
r.fire('window', 'load', {});
await drain();
check('  and the later events do not send it a second time',
  r.log.fetch.length === 1 && r.log.fetch[0].body.e === firstEid, 'sent ' + r.log.fetch.length);

// The measurement that keeps this honest. Without it a regression back to a
// late send is invisible: the hits still arrive, just from fewer people.
check('every pageview reports how long it took to reach the network',
  typeof r.log.fetch[0].body.dt === 'number' && r.log.fetch[0].body.dt >= 0,
  JSON.stringify(r.log.fetch[0].body));

// A browser with no performance clock must still be counted; it just reports
// an unknown latency, which the Worker stores as NULL rather than as a zero
// that would flatter the median.
let rp = run(SRC1, { noPerf: true });
await drain();
check('a client with no performance clock is still recorded',
  rp.log.fetch.length === 1 && rp.log.fetch[0].body.dt === -1,
  JSON.stringify((rp.log.fetch[0] || {}).body));

// The address lookup is a third-party request. Issuing it first put a DNS
// lookup and a TLS handshake in front of the hit it exists to annotate.
r = run(SRC2, { echoIp: '203.0.113.99' });
await drain();
check('the pageview goes out before the third-party address lookup',
  r.log.order.length >= 2 && r.log.order[0] === 'hit', JSON.stringify(r.log.order.slice(0, 3)));

console.log('\n=== J. a bounce is still counted, and still counted once ===');
r = run(SRC1, { readyState: 'loading' });
await drain();
check('the hit is already sent before any bounce can happen', r.log.fetch.length === 1);
r.ctx.document.visibilityState = 'hidden';
r.fire('document', 'visibilitychange', {});
r.fire('document', 'DOMContentLoaded', {}); r.fire('window', 'pagehide', {});
await drain();
check('and later events do not double-count', r.log.fetch.length === 1, 'sent ' + r.log.fetch.length);

console.log('\n=== K. bfcache restore is a new pageview ===');
r = run(SRC1); await drain();
r.fire('window', 'pageshow', { persisted: true }); await drain();
check('second hit recorded', r.log.fetch.length === 2);
check('with a different event id', r.log.fetch[0].body.e !== r.log.fetch[1].body.e);
check('tagged bfcache', r.log.fetch[1].body.k === 'bfcache');
r.fire('window', 'pageshow', { persisted: false }); await drain();
check('a normal pageshow does not', r.log.fetch.length === 2);

console.log('\n=== L. local preview is never counted ===');
r = run(SRC1, { hostname: 'localhost' }); await drain();
check('nothing sent from localhost', r.log.fetch.length === 0 && r.log.image.length === 0);
check('  and no echo lookup either', r.log.echo.length === 0);

console.log('\n=== P. the client clock rides along ===');
r = run(SRC1); await drain();
check('the browser timezone is sent', typeof r.log.fetch[0].body.tz === 'string' && r.log.fetch[0].body.tz.length > 0,
  JSON.stringify(r.log.fetch[0].body));
check('  with its offset', typeof r.log.fetch[0].body.tzo === 'number', JSON.stringify(r.log.fetch[0].body));
r = run(SRC1, { gpc: true }); await drain();
check('an opt-out sends neither', !('tz' in r.log.fetch[0].body) && !('tzo' in r.log.fetch[0].body),
  JSON.stringify(r.log.fetch[0].body));

console.log('\n=== Q. THE NOTHING-REACHABLE FIX: no transport works, so the hit is kept ===');
// When no endpoint answers at all, the race in M has nothing to race against.
// Rather than lose the pageview when the tab closes, it goes to localStorage
// and waits for a later pageview that finds a connection that works.
const QK = '_vt_q';
let box = {};
r = run(SRC1, { fetchRejects: true, imageFails: true, store: box });
await drain();
check('every transport failed', r.log.fetch.length === 1 && r.log.image.length === 1);
let queued = JSON.parse(box[QK] || '[]');
check('the pageview is kept instead of lost', queued.length === 1 && queued[0].p === '/publications/',
  JSON.stringify(box[QK]));
check('  with the id it would have been recorded under', /^[0-9a-z]{16,64}$/i.test((queued[0] || {}).e || ''),
  JSON.stringify(queued[0]));
check('  and the timezone reading captured when it happened',
  typeof (queued[0] || {}).z === 'string' && queued[0].z.length > 0, JSON.stringify(queued[0]));

console.log('\n=== R. ...and goes out on the next pageview that reaches anything ===');
const strandedId = (queued[0] || {}).e || 'never-queued';
r = run(SRC1, { store: box });
await drain();
const replay = r.log.fetch.filter(f => f.body.e === strandedId);
check('the stranded pageview is replayed', replay.length === 1, JSON.stringify(r.log.fetch.map(f => f.body.e)));
check('  reusing its id, so a copy that did land collapses into it', !!replay[0] && replay[0].body.e === strandedId);
check('  and reporting its age, so the Worker files it on the right day',
  typeof (replay[0] || { body: {} }).body.qt === 'number', JSON.stringify(replay[0] && replay[0].body));
check('  carrying no address picked up on the connection it was replayed on',
  !!replay[0] && !('ci' in replay[0].body), JSON.stringify(replay[0] && replay[0].body));
check('the live pageview still went out too', r.log.fetch.some(f => f.body.e !== strandedId));
check('the queue is empty once the replay is accepted', JSON.parse(box[QK] || '[]').length === 0,
  JSON.stringify(box[QK]));

console.log('\n=== R2. the address is captured when the hit happens and carried out with it ===');
// A replay arrives over whatever connection eventually worked, so the address
// the server sees on it describes the replay and not the original request. The
// only address that describes that request is the one the browser resolved
// while it was being made, and it exists only if the queue kept it.
box = {};
r = run(SRC1, { fetchRejects: true, imageFails: true, echoIp: '{"ip":"223.5.5.5"}', store: box });
await drain();
let held = JSON.parse(box[QK] || '[]')[0] || {};
check('the parked pageview carries the address resolved at the time',
  held.ci === '223.5.5.5', JSON.stringify(held));

// A different network on the way out, with a different address of its own.
r = run(SRC1, { echoIp: '{"ip":"198.51.100.4"}', store: box });
await drain();
const back = r.log.fetch.filter(f => 'qt' in f.body)[0];
check('the replay reports the address from the original hit, not from the way out',
  !!back && back.body.ci === '223.5.5.5', JSON.stringify(back && back.body));
check('  while the live pageview reports the current one',
  r.log.fetch.some(f => !('qt' in f.body) && (f.body.ci === '198.51.100.4' || !f.body.ci)),
  JSON.stringify(r.log.fetch.map(f => ({ qt: f.body.qt, ci: f.body.ci }))));

console.log('\n=== S. what is NOT queued ===');
box = {};
r = run(SRC1, { store: box }); await drain();
check('a hit that was delivered leaves nothing behind', !box[QK] || JSON.parse(box[QK]).length === 0,
  JSON.stringify(box[QK]));
box = {};
r = run(SRC1, { fetchRejects: true, imageFails: true, gpc: true, store: box }); await drain();
check('an opt-out is never queued: nothing of it is carried between sessions',
  !box[QK] || JSON.parse(box[QK]).length === 0, JSON.stringify(box[QK]));

console.log('\n=== T. the queue cannot grow without bound or replay the ancient ===');
box = {};
const old = { e: 'ancient1111111111111111111111111', t: Date.now() - 60 * 86400000, p: '/ancient/', q: 1 };
box[QK] = JSON.stringify([old]);
r = run(SRC1, { store: box }); await drain();
check('an entry past its shelf life is never sent',
  !r.log.fetch.some(f => f.body.p === '/ancient/'), JSON.stringify(r.log.fetch.map(f => f.body.p)));
check('  and is dropped from storage', !JSON.parse(box[QK] || '[]').some(x => x.e === old.e),
  JSON.stringify(box[QK]));

box = {};
box[QK] = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({
  e: 'pad' + String(i).padStart(29, '0'), t: Date.now() - 1000, p: '/p' + i + '/', q: 1,
})));
r = run(SRC1, { fetchRejects: true, imageFails: true, store: box }); await drain();
const capped = JSON.parse(box[QK]);
check('the queue is capped', capped.length === 50, 'length ' + capped.length);
check('  and the cap sheds the stalest, not the newest', (capped[0] || {}).p === '/publications/',
  JSON.stringify(capped.slice(0, 2)));

console.log('\n=== U. a backlog goes out a few at a time, not all at once ===');
box = {};
box[QK] = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({
  e: 'bk' + String(i).padStart(30, '0'), t: Date.now() - 120000, p: '/b' + i + '/', q: 1,
})));
r = run(SRC1, { store: box }); await drain();
const replays = r.log.fetch.filter(f => 'qt' in f.body);
check('a returning client does not open twenty connections', replays.length === 8, 'sent ' + replays.length);
check('  and what is left stays for the next pageview', JSON.parse(box[QK]).length === 12,
  'left ' + JSON.parse(box[QK]).length);

console.log('\n=== V2. store_and_forward: false turns the queue off completely ===');
{
  const noq = render({ fallback_endpoint: '', store_and_forward: false });
  const b2 = {};
  const r2 = run(noq, { fetchRejects: true, imageFails: true, store: b2 });
  await drain();
  check('an undeliverable hit is not kept when the owner turned it off',
    !b2[QK], JSON.stringify(b2));
  b2[QK] = JSON.stringify([{ e: 'seed1111111111111111111111111111', t: Date.now() - 120000, p: '/seed/', q: 1 }]);
  const r3 = run(noq, { store: b2 });
  await drain();
  check('  and an existing backlog is left alone rather than replayed',
    !r3.log.fetch.some(f => f.body.p === '/seed/'), JSON.stringify(r3.log.fetch.map(f => f.body.p)));
}

console.log('\n=== V. the event id is one the Worker will actually honour ===');
// The Worker stores null for any id outside /^[0-9a-z]{16,64}$/, and a null id
// takes multi-transport de-duplication and the whole replay path down with it.
const EID = /^[0-9a-z]{16,64}$/i;
r = run(SRC1); await drain();
check('crypto.randomUUID path', EID.test(r.log.fetch[0].body.e), r.log.fetch[0].body.e);
r = run(SRC1, { noCrypto: true }); await drain();
check('and the fallback for a context without crypto', EID.test(r.log.fetch[0].body.e), r.log.fetch[0].body.e);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
