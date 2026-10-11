"""Schritt 6/7: Ehrlichkeitscheck rechnen und eine selbsttragende HTML-Seite bauen.
Aufruf: python3 build.py  ->  data/pulsbuch.html  (enthaelt Gesundheitsdaten, liegt in data/ = gitignored)"""
import json, random, statistics as st, math
from datetime import date, timedelta
from collections import Counter

J = json.load(open("data/days.json")); DAYS = J["days"]
M = json.load(open("data/model.json")); T = M["tage"]; R = M["richtung"]
S = json.load(open("data/strain.json"))
B = json.load(open("data/baselines.json"))
START, TODAY = date(2026, 7, 13), date(2026, 10, 11)
days = [(START + timedelta(i)).isoformat() for i in range((TODAY - START).days + 1)]
EXCL_PHASE = {"2026-07-13", "2026-09-20"}       # Entscheid Schritt 3

def asleep(d):
    m = T.get(d); return m["schlaf"]["geschlafen"] if m else None

# ---------------- Schritt 7 ----------------
chk = {}
# 1. Phasensummen gegen die zweite Quelle, drei zufaellige Naechte (Seed fest, damit nachpruefbar)
full = [d for d in days if (DAYS.get(d, {}).get("sleepOverview") or {}).get("sleepStart") and (DAYS[d].get("dailyHealth") or {}).get("deep_min") is not None]
rng = random.Random(20261011); pick = sorted(rng.sample(full, 3)); c1 = []
for d in pick:
    o, h = DAYS[d]["sleepOverview"], DAYS[d]["dailyHealth"]
    ph = h["deep_min"] + h["light_min"] + h["rem_min"]; per = o["mainPeriod_min"] or o["legacyMainSleep_min"]
    c1.append(dict(nacht=d, tief=h["deep_min"], leicht=h["light_min"], rem=h["rem_min"], wach=h["awake_min"],
                   summe_phasen=ph, asleep_coros=o["mainAsleep_min"], summe_mit_wach=ph + h["awake_min"], periode=per,
                   stimmt=(per == ph + h["awake_min"]) and (o["mainAsleep_min"] in (None, ph))))
chk["1_phasenprobe"] = dict(seed=20261011, naechte=c1)
# 2. Spannweite Tief/REM ueber volle Naechte (>= 4 h), Anteil an Tief+Leicht+REM+Wach
dp, rp = [], []
for d in full:
    if d in EXCL_PHASE or (asleep(d) or 0) < 240: continue
    h = DAYS[d]["dailyHealth"]; tot = h["deep_min"] + h["light_min"] + h["rem_min"] + h["awake_min"]
    dp.append(100 * h["deep_min"] / tot); rp.append(100 * h["rem_min"] / tot)
chk["2_spannweite"] = dict(n=len(dp), tief=[round(min(dp), 1), round(max(dp), 1)], rem=[round(min(rp), 1), round(max(rp), 1)])
# 3. Anzahlen der Basislinien
chk["3_anzahlen"] = dict(hrv_30=B["hrv_30"]["n"], hrv_alle=B["hrv_all"]["n"], rhr_30=B["rhr_30"]["n"], schlaf=B["sleep"]["n_basis"])
# 4. Aktivitaet ohne Puls
chk["4_ohne_puls"] = [dict(datum=a["date"], art=a["type"], dauer=a["duration"], last=a["trainingLoad"]) for a in J["activities"] if a["avgHR"] is None]
# 5. Verteilung Belastung
band = lambda s: "leicht" if s < 10 else "moderat" if s < 14 else "hoch" if s < 18 else "alles gegeben"
roh = S["belastung_roh"]
chk["5_verteilung"] = dict(Counter(band(v) if v <= 21 else "ueber 21" for v in roh.values()), anker=S["anker"], p95=round(S["p95"], 1))
chk["5_ueber_21"] = [d for d, v in roh.items() if v > 21]
# 6. Fitnessalter-Boden
chk["6_fitnessalter"] = "entfaellt - COROS liefert keine Fitnessalter-Reihe"
# 7. Tage ohne aufgezeichnete Aktivitaet
akt = {a["date"] for a in J["activities"]}
chk["7_ohne_aktivitaet"] = dict(anzahl=sum(d not in akt for d in days), von=len(days))

# ---------------- Kontrast ----------------
def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
def ratio(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True); return (la + 0.05) / (lb + 0.05)
kontrast = [dict(text=t, grund=g, verhaeltnis=round(ratio(t, g), 2)) for t in ("#F2F2F2", "#B4B4B4", "#969696") for g in ("#0A0A0A", "#161616")]
chk["kontrast"] = kontrast
assert all(k["verhaeltnis"] >= 4.5 for k in kontrast)

# ---------------- Ansicht pro Tag ----------------
acts = {}
for a in J["activities"]:
    acts.setdefault(a["date"], []).append(dict(art=a["type"], dauer=a["duration"], puls=a["avgHR"], last=a["trainingLoad"]))
view = {}
for d in days:
    m = T.get(d); D = DAYS.get(d) or {}; o = D.get("sleepOverview") or {}; h = D.get("dailyHealth") or {}
    v = dict(datum=d, tageslast=S["tageslast"][d], belastung=min(21, roh[d]), einheiten=acts.get(d, []))
    if m:
        v["rec"] = dict(wert=m["recovery"], band=m["band"], ziel=m["ziel"], lage=m["lage"],
                        teile={k: dict(roh=p["roh"], wert=p["wert"], gewicht=p["gewicht"], z=p.get("z"),
                                       basis=p.get("basis")) for k, p in m["teile"].items()})
        v["schlaf"] = m["schlaf"]
    per = o.get("mainPeriod_min") or o.get("legacyMainSleep_min")
    if o.get("sleepStart") and h.get("deep_min") is not None and d not in EXCL_PHASE:
        ph = dict(tief=h["deep_min"], leicht=h["light_min"], rem=h["rem_min"], wach=h["awake_min"])
        ph["nicht_zugeordnet"] = max(0, per - sum(ph.values()))
        v["phasen"] = ph
    if o.get("sleepStart"):
        v["fenster"] = [o["sleepStart"], o["sleepEnd"]]; v["im_bett"] = per
    view[d] = v

rhr = [[d, DAYS[d]["restingHR"]] for d in days if DAYS.get(d, {}).get("restingHR")]
payload = dict(tage=view, reihenfolge=days, heute=TODAY.isoformat(), anker=S["anker"], grundbedarf=M["grundbedarf"],
               basis=B, check=chk, richtung=dict(rhr=rhr, rhr_steigung=R["rhr_steigung_pro_30d"],
               exercise=R["exercise_wochen"], exercise_steigung=R["exercise_steigung_pro_woche"],
               vo2=J["fitness"], profil=J["userInfo"]), start=START.isoformat())
html = open("page_template.html").read().replace("/*__DATA__*/null", json.dumps(payload, ensure_ascii=False))
open("data/pulsbuch.html", "w").write(html)
print(json.dumps(chk, indent=1, ensure_ascii=False))
print("geschrieben: data/pulsbuch.html", len(html) // 1024, "KB")
