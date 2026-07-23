// Minimal stand-in for the D1 binding, backed by a real in-memory SQLite via a
// python3 co-process. Real SQLite matters here: the suite depends on partial
// unique indexes, INSERT OR IGNORE and PRAGMA table_info behaving exactly as
// they do in D1. Used because wrangler 4 needs Node 22 and this runs anywhere
// node + python3 exist.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function makeD1() {
  const proc = spawn('python3', ['-u', new URL('./sqlite-server.py', import.meta.url).pathname]);
  proc.stderr.on('data', d => process.stderr.write('[sqlsrv] ' + d));
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let seq = 0;
  rl.on('line', l => {
    const o = JSON.parse(l);
    const p = pending.get(o.id); pending.delete(o.id);
    o.error ? p.reject(new Error(o.error)) : p.resolve(o.results);
  });
  const exec = stmts => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ id, stmts }) + '\n');
  });

  const stmt = (sql, binds = []) => ({
    sql, binds,
    bind: (...b) => stmt(sql, b),
    run: async () => { await exec([{ sql, binds }]); return { success: true }; },
    all: async () => ({ results: (await exec([{ sql, binds }]))[0] }),
    first: async () => ((await exec([{ sql, binds }]))[0] || [])[0] || null,
  });

  return {
    prepare: sql => stmt(sql),
    batch: async list => (await exec(list.map(s => ({ sql: s.sql, binds: s.binds }))))
      .map(r => ({ results: r })),
    close: () => proc.stdin.end(),
    raw: sql => exec([{ sql, binds: [] }]).then(r => r[0]),
  };
}
