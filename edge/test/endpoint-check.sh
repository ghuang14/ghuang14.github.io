#!/bin/sh
# One curl per URL: a single multi-URL command is too easy to mangle with
# line continuations, and a mangled argument produces exactly the same output
# as a host that fails to connect.
for u in \
  "https://ghuang14.github.io/" \
  "https://visitor-tracker.alexhuang1403.workers.dev/nope" \
  "https://visitor-tracker-cn.pages.dev/nope" \
  "https://astro.pages.dev/" \
  "https://ip.zxinc.org/api.php?type=json" \
  "https://api.bigdatacloud.net/data/client-ip" \
  "https://ipwho.is/" \
  "https://api64.ipify.org?format=json"
do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$u" 2>/dev/null)
  # Any HTTP status at all means the name resolved and TLS completed, so the
  # host is reachable — a 404 from an endpoint is still a reachable endpoint.
  # 000 means no response: the host is unreachable from here, or (for the
  # pages.dev endpoint) not deployed yet. Run this from inside the network you
  # are asking about.
  [ "$code" = "000" ] && verdict="no response - blocked, or not deployed" || verdict="reachable"
  printf '%-4s  %-58s %s\n' "$code" "$u" "$verdict"
done
