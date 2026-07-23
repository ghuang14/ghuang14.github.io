import sys, json, sqlite3
con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    out = {"id": req["id"]}
    try:
        rows = []
        for st in req["stmts"]:
            cur = con.execute(st["sql"], st.get("binds") or [])
            rows.append([dict(r) for r in cur.fetchall()])
        con.commit()
        out["results"] = rows
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
