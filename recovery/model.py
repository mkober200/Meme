"""Schritt 5b: Schlafbedarf, Recovery, Belastungsziel, Richtung. Schreibt data/model.json."""
import json, math, statistics as st
from datetime import date, timedelta
def asleep_min(D):
    """Schlafdauer laut Entscheid aus Schritt 3 (gleich wie baselines.py)."""
    o = D.get("sleepOverview") or {}
    if not o.get("sleepStart"): return None
    if o.get("mainAsleep_min") is not None: return o["mainAsleep_min"]
    if D["date"] == "2026-07-13": return o["legacyMainSleep_min"]
    h = D.get("dailyHealth") or {}
    return h["deep_min"] + h["light_min"] + h["rem_min"]
J = json.load(open("data/days.json")); DAYS = J["days"]
S = json.load(open("data/strain.json"))
START, TODAY = date(2026, 7, 13), date(2026, 10, 11)
GRUNDBEDARF = 8 * 60          # Minuten - anpassbar
iso = lambda d: d.isoformat()
def dd(s): return date.fromisoformat(s)
def clamp(x, lo, hi): return max(lo, min(hi, x))
def strain(d): v = S["belastung_roh"].get(d); return None if v is None else min(21, v)

def naps_min(d):
    o = (DAYS.get(d) or {}).get("sleepOverview") or {}
    return o.get("naps_min") or 0

def schlaf(d):
    """Schlafbedarf fuer die Nacht, die am Morgen d endet."""
    D = DAYS.get(d) or {}; geschl = asleep_min(D) if D else None
    gestern = iso(dd(d) - timedelta(1))
    b_g = strain(gestern)
    f = 1.7 / (1 + math.exp((17 - b_g) / 3.5)) * 60 if b_g is not None else None
    fehl, fehlend = 0, []
    for k in (1, 2, 3):
        n = iso(dd(d) - timedelta(k)); g = asleep_min(DAYS.get(n) or {}) if DAYS.get(n) else None
        if g is None: fehlend.append(n); continue
        fehl += max(0, GRUNDBEDARF - g)
    defizit = min(0.35 * fehl, 90)
    nick = naps_min(gestern)
    bedarf = GRUNDBEDARF + (f or 0) + defizit - nick
    return dict(geschlafen=geschl, bedarf=bedarf, grund=GRUNDBEDARF, f_belastung=f, belastung_gestern=b_g,
                defizit=defizit, fehlstunden_3n=fehl, fehlende_naechte=fehlend, nickerchen=nick,
                leistung=None if geschl is None else 100 * geschl / bedarf)

def base(d, key, w=30):
    lo = iso(dd(d) - timedelta(w - 1)); xs = []
    for k, D in DAYS.items():
        if lo <= k <= d:
            v = D["hrv"]["avg"] if key == "hrv" and D.get("hrv") else D.get("restingHR") if key == "rhr" else None
            if v is not None: xs.append(v)
    return dict(n=len(xs), mean=st.mean(xs), sd=st.stdev(xs)) if len(xs) > 1 else None

def recovery(d):
    D = DAYS.get(d) or {}; sl = schlaf(d); parts = {}
    if D.get("hrv") and base(d, "hrv"):
        b = base(d, "hrv"); z = (D["hrv"]["avg"] - b["mean"]) / b["sd"]
        parts["hrv"] = dict(roh=D["hrv"]["avg"], basis=b, z=z, wert=clamp(50 + 20 * z, 0, 100), soll=0.50)
    if D.get("restingHR") and base(d, "rhr"):
        b = base(d, "rhr"); z = (D["restingHR"] - b["mean"]) / b["sd"]
        parts["rhr"] = dict(roh=D["restingHR"], basis=b, z=z, wert=clamp(50 - 20 * z, 0, 100), soll=0.25)
    if sl["leistung"] is not None:
        parts["schlaf"] = dict(roh=sl["leistung"], wert=min(100, sl["leistung"]), soll=0.25)
    if not parts: return None
    tot = sum(p["soll"] for p in parts.values())
    for p in parts.values(): p["gewicht"] = p["soll"] / tot
    r = sum(p["wert"] * p["gewicht"] for p in parts.values())
    band = "gruen" if r >= 67 else "gelb" if r >= 34 else "rot"
    ziel = {"gruen": (14.0, 18.0), "gelb": (9.0, 13.5), "rot": (0.0, 8.0)}[band]
    s = strain(d)
    lage = None if s is None else "darunter" if s < ziel[0] else "darueber" if s > ziel[1] else "drin"
    return dict(recovery=r, band=band, teile=parts, ziel=ziel, belastung=s, lage=lage, schlaf=sl)

days = [iso(START + timedelta(i)) for i in range((TODAY - START).days + 1)]
model = {d: recovery(d) for d in days}

# --- Richtung (kein Fitnessalter bei COROS) ---
def slope(pts):          # Steigung pro Tag, kleinste Quadrate
    xs = [x for x, _ in pts]; ys = [y for _, y in pts]; mx, my = st.mean(xs), st.mean(ys)
    return sum((x - mx) * (y - my) for x, y in pts) / sum((x - mx) ** 2 for x in xs)
rhr_pts = [((dd(d) - START).days, DAYS[d]["restingHR"]) for d in days if DAYS.get(d, {}).get("restingHR")]
wochen = {}
for d in days:
    ex = ((DAYS.get(d) or {}).get("dailyHealth") or {}).get("exercise_min")
    w = (dd(d) - START).days // 7
    if ex is not None: wochen.setdefault(w, []).append(ex)
wk = [(w, sum(v)) for w, v in sorted(wochen.items()) if len(v) == 7]
richtung = dict(rhr_steigung_pro_30d=slope(rhr_pts) * 30, rhr_n=len(rhr_pts),
                exercise_wochen=wk, exercise_steigung_pro_woche=slope(wk),
                vo2max=J["fitness"])
json.dump({"tage": model, "richtung": richtung, "anker": S["anker"], "grundbedarf": GRUNDBEDARF},
          open("data/model.json", "w"), indent=1, default=str)

hm = lambda m: f"{int(m//60)} h {int(round(m%60)):02d} min"
t = model[iso(TODAY)]; sl = t["schlaf"]
print("== HEUTE", TODAY, "==")
for k, p in t["teile"].items():
    print(f"  {k}: roh {p['roh']:.1f}" + (f" | Basis {p['basis']['mean']:.2f}±{p['basis']['sd']:.2f} (n={p['basis']['n']}) | z {p['z']:+.2f}" if 'z' in p else "") + f" | Wert {p['wert']:.1f} | Gewicht {p['gewicht']:.2f}")
print(f"  RECOVERY {t['recovery']:.1f} % -> {t['band']} | Ziel {t['ziel']} | Belastung heute {t['belastung']:.2f} -> {t['lage']}")
print(f"  Schlaf: geschlafen {hm(sl['geschlafen'])} | Bedarf {hm(sl['bedarf'])} = 8h + f {sl['f_belastung']:.1f} min (Belastung gestern {sl['belastung_gestern']:.2f}) + Defizit {sl['defizit']:.1f} min (Fehl 3N {sl['fehlstunden_3n']} min, fehlend {sl['fehlende_naechte']}) - Nickerchen {sl['nickerchen']} | Leistung {sl['leistung']:.1f} %")
print("== 7 TAGE ==")
for d in days[-7:]:
    m = model[d]
    if not m: print(d, "keine Eingaben"); continue
    print(d, f"Rec {m['recovery']:5.1f} {m['band']:5} | Gewichte {', '.join(f'{k} {p['gewicht']:.2f}' for k,p in m['teile'].items())} | Belastung {m['belastung']:5.2f} Ziel {m['ziel']} {m['lage']} | Schlaf " + (f"{m['schlaf']['leistung']:.0f} %" if m['schlaf']['leistung'] else "fehlt"))
from collections import Counter
print("Recovery-Baender 91 Tage:", Counter(m["band"] for m in model.values() if m))
print("Tage ohne irgendeine Eingabe:", [d for d in days if not model[d]])
L = [m["schlaf"]["leistung"] for m in model.values() if m and m["schlaf"]["leistung"]]
print(f"Schlafleistung: Median {st.median(L):.1f} %, min {min(L):.1f}, max {max(L):.1f}, n {len(L)}")
B = [m["schlaf"]["bedarf"] for m in model.values() if m]
print(f"Bedarf: min {hm(min(B))}, max {hm(max(B))}")
print("Richtung: Ruhepuls", f"{richtung['rhr_steigung_pro_30d']:+.2f} bpm/30 Tage (n={len(rhr_pts)})",
      "| Exercise-Minuten/Woche:", wk, f"Steigung {richtung['exercise_steigung_pro_woche']:+.1f} min/Woche")
