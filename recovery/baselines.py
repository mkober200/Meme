"""Schritt 4: Basislinien aus data/days.json. Stichproben-Standardabweichung (n-1)."""
import json, statistics as st
from datetime import date, timedelta
J = json.load(open("data/days.json"))["days"]
TODAY = date(2026, 10, 11)   # letzte vollstaendige Nacht (Aufwachtag)

def asleep_min(D):
    """Schlafdauer laut Entscheid aus Schritt 3."""
    o = D.get("sleepOverview") or {}
    if not o.get("sleepStart"): return None
    if o.get("mainAsleep_min") is not None: return o["mainAsleep_min"]
    if D["date"] == "2026-07-13": return o["legacyMainSleep_min"]          # nur Fenster bekannt
    h = D.get("dailyHealth") or {}
    return h["deep_min"] + h["light_min"] + h["rem_min"]                   # altes Format

def window(days_back):
    lo = TODAY - timedelta(days=days_back - 1)
    return [d for d in J if lo.isoformat() <= d <= TODAY.isoformat()]

def stats(xs):
    return dict(n=len(xs), mean=round(st.mean(xs), 2), sd=round(st.stdev(xs), 2), min=min(xs), max=max(xs))

hrv_all = [J[d]["hrv"]["avg"] for d in J if J[d].get("hrv")]
hrv_noNap = [J[d]["hrv"]["avg"] for d in J if J[d].get("hrv") and (asleep_min(J[d]) or 0) >= 240]
out = {"today": TODAY.isoformat()}
out["hrv_all"] = stats(hrv_all)
out["hrv_ohne_nickerchen_naechte"] = stats(hrv_noNap)
for w in (30, 14):
    out[f"hrv_{w}"] = stats([J[d]["hrv"]["avg"] for d in window(w) if J[d].get("hrv")])
    out[f"rhr_{w}"] = stats([J[d]["restingHR"] for d in window(w) if J[d].get("restingHR")])
sl = {d: asleep_min(J[d]) for d in J if asleep_min(J[d]) is not None}
naps = sorted((d, m) for d, m in sl.items() if m < 240)
full = sorted(m for m in sl.values() if m >= 240)
q = st.quantiles(full, n=4, method="inclusive")
out["sleep"] = dict(n_alle=len(sl), n_basis=len(full), median_min=st.median(full), p75_min=q[2], unter_4h=naps)
out["coros_hrv_baseline_heute"] = J[TODAY.isoformat()]["hrv"]
for k in ("hrv", "rhr"):
    a, b = out[f"{k}_30"], out[f"{k}_14"]
    out[f"{k}_drift"] = dict(diff=round(b["mean"] - a["mean"], 2), halbe_sd=round(a["sd"] / 2, 2),
                             ueber_halber_sd=abs(b["mean"] - a["mean"]) > a["sd"] / 2)
json.dump(out, open("data/baselines.json", "w"), indent=1)
print(json.dumps(out, indent=1, ensure_ascii=False))
