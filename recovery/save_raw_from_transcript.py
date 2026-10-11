"""Schreibt jede COROS-Abfrage dieser Sitzung VOLLSTAENDIG (Rohtext, unveraendert)
nach recovery/data/raw/. Quelle ist das Sitzungsprotokoll, damit keine Zahl
von Hand abgetippt wird."""
import json, sys, re, pathlib
src, out = sys.argv[1], pathlib.Path(sys.argv[2])
calls, results = {}, {}
for line in open(src):
    try: ev = json.loads(line)
    except Exception: continue
    msg = ev.get("message") or {}
    for c in msg.get("content") or [] if isinstance(msg.get("content"), list) else []:
        if c.get("type") == "tool_use" and c.get("name", "").startswith("mcp__Coros__"):
            calls[c["id"]] = (c["name"].split("__")[-1], c.get("input", {}))
        if c.get("type") == "tool_result":
            cont = c.get("content")
            if isinstance(cont, list):
                cont = "".join(x.get("text", "") for x in cont if isinstance(x, dict))
            results[c["tool_use_id"]] = cont
n = 0
for cid, (name, inp) in calls.items():
    if cid not in results: continue
    text = results[cid]
    try: text = json.loads(text)          # Antwort ist ein JSON-String
    except Exception: pass
    tag = "_".join(f"{k}-{v}" for k, v in sorted(inp.items()) if v not in (None, [], "") and k in ("days","startDate","endDate","labelId"))
    fn = out / f"{name}{('__'+tag) if tag else ''}.txt"
    fn.write_text(text); n += 1
print(n, "Dateien")
