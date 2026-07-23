// Recompute every salted ip_hash in the database under a new IP_SALT.
//
// IP_SALT is write-only in Cloudflare: once set, it cannot be read back. That
// makes it easy to end up needing a *second* endpoint to share a salt nobody
// has a copy of any more. The usual advice is "never change it", because
// ip_hash is computed at insert time and stored, so a new salt splits every
// returning client into two buckets — one before the change, one after — and
// any window spanning the change counts them twice.
//
// That advice assumes the hash is all there is. It is not: `ip` (and
// `client_ip`) are stored alongside it, so every salted hash in the table can
// simply be recomputed under the new salt. Do that and the split never happens
// — the change becomes invisible in the numbers rather than merely tolerable.
//
// Rows whose ip_hash is a `dnt:`/`anon:` bucket are NOT salted at all (they are
// coarse country/day counters that carry no per-client component) and are
// left exactly as they are.
//
//   Set the new salt on BOTH endpoints first, then:
//     cd edge
//     read -rs NEW_IP_SALT && export NEW_IP_SALT   # typed, not echoed
//     node tools/resalt.mjs                        # dry run, writes nothing
//     node tools/resalt.mjs --apply
//
// The salt is read from the environment rather than argv because argv is
// visible to every other process via `ps`; and `read -rs` rather than an
// inline `NEW_IP_SALT=... node ...` because that form is written verbatim into
// shell history. Neither matters enormously — ip_hash is never published and
// the value it is derived from sits in the next column — but both are free.
//
// Safe to re-run: a row already carrying the right hash is left alone, so an
// interrupted run just needs running again, and rows written by the live
// endpoints while it runs are already correct.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DB = "visitor-tracker";
const PAGE = 500;   // rows read per wrangler call
const BATCH = 200;  // rows per UPDATE statement

/** Byte-for-byte what src/index.js does. */
export const hash = (input) => createHash("sha256").update(input, "utf8").digest("hex");

/** A `dnt:`/`anon:` bucket is a country/day label, not a salted hash. */
export const isBucket = (h) => /^(dnt|anon):/.test(String(h ?? ""));

/**
 * The value a row's hash is derived from. Mirrors `hashSource` in
 * src/index.js: a replayed request is keyed on the address the client recorded
 * when the request was made, not on the connection that finally delivered it.
 */
export const sourceOf = (r) =>
  r.queued_ms != null && r.client_ip ? r.client_ip : (r.ip ?? "");

/**
 * The one way a re-salt can fail against the schema: idx_visits_event is
 * UNIQUE on (event_id, ip_hash) WHERE event_id IS NOT NULL, so if two rows
 * sharing an event_id are rewritten to the SAME hash, the UPDATE aborts and the
 * batch leaves nothing written.
 *
 * Under a single salt this cannot happen — two rows of one event_id must
 * already differ in ip_hash, so they differ in source value, so they differ
 * again under any new salt. It becomes reachable only if the DERIVATION changes
 * rather than the salt, which is exactly what happened when replayed requests
 * started keying on client_ip instead of the connecting address. Cheap to
 * check, unrecoverable to discover halfway through.
 */
export function collisions(rows, salt) {
  const byEvent = new Map();
  for (const r of rows) {
    if (!r.event_id || isBucket(r.ip_hash)) continue;
    const key = r.event_id + "\u0000" + hash(sourceOf(r) + "|" + salt);
    (byEvent.get(key) || byEvent.set(key, []).get(key)).push(r.id);
  }
  return [...byEvent.values()].filter((ids) => ids.length > 1);
}

/** Rows that need writing, and why, without touching anything. */
export function plan(rows, salt) {
  const writes = [];
  let buckets = 0, already = 0;
  for (const r of rows) {
    if (isBucket(r.ip_hash)) { buckets++; continue; }
    const want = hash(sourceOf(r) + "|" + salt);
    if (want === r.ip_hash) { already++; continue; }
    writes.push({ id: r.id, ip_hash: want });
  }
  return { writes, buckets, already };
}

/* ---------------------------------------------------------------- */
/* the CLI half: everything below talks to wrangler                  */
/* ---------------------------------------------------------------- */

const wrangler = (sql) => {
  const out = execFileSync(
    "npx",
    ["--yes", "wrangler@4.113.0", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] }
  );
  // wrangler prints a banner before the JSON on some versions.
  const at = out.indexOf("[");
  const parsed = JSON.parse(at > 0 ? out.slice(at) : out);
  return parsed[0]?.results ?? [];
};

async function main() {
  const salt = process.env.NEW_IP_SALT;
  const apply = process.argv.includes("--apply");
  if (!salt || salt.length < 24) {
    console.error(
      "NEW_IP_SALT must be set, and should be long and random.\n" +
        "Generate one with:  openssl rand -base64 39\n" +
        "Set that SAME value on the Worker and on the Pages project first."
    );
    process.exit(1);
  }

  // Sibling rows of one request are the only rows that can collide, and they
  // are rare enough to check in full before writing anything. No multi-row
  // event_id means no collision is possible at all, whatever the salt.
  const siblings = wrangler(
    `SELECT id, event_id, ip, client_ip, queued_ms, ip_hash FROM visits ` +
      `WHERE event_id IN (SELECT event_id FROM visits WHERE event_id IS NOT NULL ` +
      `GROUP BY event_id HAVING COUNT(*) > 1)`
  );
  const clashes = collisions(siblings, salt);
  if (clashes.length) {
    console.error(
      `Refusing to run: ${clashes.length} group(s) of rows sharing an event_id would\n` +
        `collapse onto one ip_hash, which idx_visits_event forbids. Row ids:\n  ` +
        clashes.map((ids) => ids.join(",")).join("\n  ") +
        `\nThese are duplicate records of one pageview from one client. Decide what to\n` +
        `do with them before re-salting.`
    );
    process.exit(1);
  }
  console.log(
    `preflight: ${siblings.length} row(s) share an event_id with another; no collisions.`
  );

  let after = 0, seen = 0, written = 0, buckets = 0, already = 0;
  for (;;) {
    const rows = wrangler(
      `SELECT id, event_id, ip, client_ip, queued_ms, ip_hash FROM visits ` +
        `WHERE id > ${after} ORDER BY id LIMIT ${PAGE}`
    );
    if (!rows.length) break;
    seen += rows.length;
    after = rows[rows.length - 1].id;

    const p = plan(rows, salt);
    buckets += p.buckets;
    already += p.already;

    for (let i = 0; i < p.writes.length; i += BATCH) {
      const chunk = p.writes.slice(i, i + BATCH);
      // Hashes are [0-9a-f] and ids are integers straight from the table, so
      // there is nothing here that could carry a quote.
      const cases = chunk.map((w) => `WHEN ${w.id} THEN '${w.ip_hash}'`).join(" ");
      const ids = chunk.map((w) => w.id).join(",");
      const sql = `UPDATE visits SET ip_hash = CASE id ${cases} END WHERE id IN (${ids})`;
      if (apply) wrangler(sql);
      written += chunk.length;
    }
    console.log(`  ${seen} rows read, ${written} to rewrite...`);
  }

  console.log(
    `\n${seen} rows: ${written} ${apply ? "rewritten" : "would be rewritten"}, ` +
      `${already} already correct, ${buckets} unsalted opt-out buckets left alone.`
  );
  if (!apply) console.log("Dry run. Re-run with --apply to write.");
}

// Only run the CLI when invoked directly, so the pure half stays importable.
// Compared as resolved URLs rather than by basename: a suffix match on the file
// name alone would fire the live backfill for any entry script called
// resalt.mjs — or, since it was unanchored, alt.mjs or t.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
