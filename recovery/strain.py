"""Schritt 5a: Belastung 0-21. Erst Verteilung pruefen, dann alles andere."""
import json, math
from datetime import date, timedelta
J = json.load(open("data/days.json"))
START, TODAY = date(2026, 7, 13), date(2026, 10, 11)

def pctl(xs, p):                      # lineare Interpolation (wie numpy 'linear')
    xs = sorted(xs); k = (len(xs) - 1) * p; f = math.floor(k)
    return xs[f] + (xs[min(f + 1, len(xs) - 1)] - xs[f]) * (k - f)

load = {}
for a in J["activities"]:
    load.setdefault(a["date"], []).append(a)
days = [(START + timedelta(i)).isoformat() for i in range((TODAY - START).days + 1)]
tageslast = {d: sum(a["trainingLoad"] for a in load.get(d, [])) + 4.0 for d in days}
aktiv = [tageslast[d] for d in days if d in load]
p95 = pctl(aktiv, 0.95); anker = max(60.0, p95)
def belastung_roh(tl): return 21 * math.log(1 + tl / 12) / math.log(1 + anker / 12)
res = {d: belastung_roh(tageslast[d]) for d in days}
band = lambda s: "leicht" if s < 10 else "moderat" if s < 14 else "hoch" if s < 18 else "alles gegeben"
from collections import Counter
print("Tage gesamt:", len(days), "| mit Aktivitaet:", len(aktiv), "| ohne:", len(days) - len(aktiv))
print("P95 Tageslast (aktive Tage):", round(p95, 2), "-> Anker:", round(anker, 2))
print("Hoechste Tageslasten:", sorted(((tageslast[d], d) for d in days), reverse=True)[:5])
print("Verteilung (roh, ungedeckelt):", Counter(band(min(s, 21)) if s <= 21 else "UEBER 21" for s in res.values()))
over = [(d, tageslast[d], round(res[d], 2)) for d in days if res[d] > 21]
print("Tage ueber 21:", over)
print("Ruhetag (Tageslast 4,0):", round(belastung_roh(4.0), 2))
print("Aktivitaeten ohne Puls:", [(a["date"], a["type"], a["trainingLoad"]) for a in J["activities"] if a["avgHR"] is None])
json.dump({"anker": anker, "p95": p95, "tageslast": tageslast, "belastung_roh": res}, open("data/strain.json", "w"), indent=1)
