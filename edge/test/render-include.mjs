// Renders _includes/edge-client.html the way the published site does.
//
// Uses real Liquid via ruby when the gem is available, and otherwise falls back
// to substituting the handful of tags this template actually uses. Either way
// the result goes through the same whitespace collapse that
// _layouts/compress.html applies (Liquid's `split: " " | join: " "`, i.e.
// Ruby's awk-mode split: every run of whitespace becomes one space).

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const INCLUDE = new URL('../../_includes/edge-client.html', import.meta.url);

const DEFAULTS = {
  endpoint: 'https://visitor-tracker.alexhuang1403.workers.dev/e',
  fallback_endpoint: '',
  extra_endpoints: [],
  echo_endpoints: [],
  hedge_ms: 1200,
  resolve_self: true,
  respect_optout: true,
  count_optouts: true,
  store_and_forward: true,
  queue_days: 30,
  queue_max: 50,
};

function viaRuby(vt) {
  const script = `
    require 'liquid'
    require 'json'
    vt = JSON.parse(ARGV[0])
    tpl = Liquid::Template.parse(File.read(ARGV[1]))
    out = tpl.render!('site' => { 'edge_client' => vt },
                      'page' => { 'url' => '/publications/' })
    print out.split(" ").join(" ")
  `;
  return execFileSync('ruby', ['-e', script, JSON.stringify(vt), INCLUDE.pathname],
                      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function viaSubstitution(vt) {
  let s = fs.readFileSync(INCLUDE, 'utf8');
  s = s.replace(/\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}/g, '');
  // The template's outermost guard, resolved for these values.
  if (!vt.endpoint) return '';
  // A {% capture %} body is template source, not output; the variables it
  // builds are resolved from `vt` below instead.
  s = s.replace(/\{%\s*capture\s+\w+\s*%\}[\s\S]*?\{%\s*endcapture\s*%\}/g, '');
  // Everything left is {% if %}/{% assign %}/{% endif %}, none of which emits
  // anything, so the tags can simply go.
  s = s.replace(/\{%[\s\S]*?%\}/g, '');

  const list = (a) => a.filter(Boolean).map((u) => JSON.stringify(u)).join(',');
  const vars = {
    vt_endpoints: list([vt.endpoint, vt.fallback_endpoint, ...(vt.extra_endpoints || [])]),
    vt_echo: list(vt.echo_endpoints || []),
    vt_dnt: String(vt.respect_optout !== false),
    vt_count_optouts: String(vt.count_optouts !== false),
    vt_resolve_ip: String(vt.resolve_self !== false),
    vt_hedge: String(vt.hedge_ms == null ? 1200 : vt.hedge_ms),
    vt_queue: String(vt.store_and_forward !== false),
    vt_queue_days: String(vt.queue_days == null ? 30 : vt.queue_days),
    vt_queue_max: String(vt.queue_max == null ? 50 : vt.queue_max),
  };
  s = s.replace(/\{\{\s*(vt_\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : ''));
  s = s.replace(/\{\{\s*site\.edge_client\.endpoint\s*\}\}/g, vt.endpoint);
  s = s.replace(/\{\{[^}]*\}\}/g, '%2F');
  return s.split(/\s+/).filter(Boolean).join(' ');
}

/** Returns the <script> body as the browser sees it. */
export function render(overrides = {}) {
  const vt = { ...DEFAULTS, ...overrides };
  let html;
  try {
    html = viaRuby(vt);
  } catch {
    html = viaSubstitution(vt);
  }
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> in the rendered include');
  return m[1];
}

/** Returns the whole rendered include (script + the no-JS <img> fallback). */
export function renderAll(overrides = {}) {
  const vt = { ...DEFAULTS, ...overrides };
  try { return viaRuby(vt); } catch { return viaSubstitution(vt); }
}
