"""Liest die COROS-Rohtexte aus data/raw und schreibt data/days.json.
Nur Felder, die tatsaechlich in den Dateien stehen; fehlt etwas, bleibt es None."""
import re, json, glob, os, sys
from datetime import datetime
RAW = sys.argv[1] if len(sys.argv) > 1 else "data/raw"
OUT = sys.argv[2] if len(sys.argv) > 2 else "data/days.json"

def hm(s):
    """'7h 33min' / '56 min' / '22min' -> Minuten"""
    if s is None: return None
    h = re.search(r"(\d+)h", s); m = re.search(r"(\d+)\s*min", s)
    return (int(h.group(1)) * 60 if h else 0) + (int(m.group(1)) if m else 0)

def rd(p): return open(os.path.join(RAW, p)).read()
days = {}
def day(d): return days.setdefault(d, {"date": d})

# --- querySleepOverview ---------------------------------------------------
so = rd("querySleepOverview__endDate-20261012_startDate-20260713.txt")
for b in re.split(r"\n\n(?=\d{4}-\d\d-\d\d\n)", so):
    m = re.match(r"(\d{4}-\d\d-\d\d)\n", b)
    if not m: continue
    D = day(m.group(1)); o = D["sleepOverview"] = {"raw": b}
    g = lambda pat: (re.search(pat, b, re.M) or [None, None])[1]
    o["score"] = int(g(r"^Sleep Score: (-?\d+)")) if g(r"^Sleep Score: (-?\d+)") else None
    o["dailySleep_min"] = hm(g(r"^Daily Sleep: (.+?) \("))
    o["mainAsleep_min"] = hm(g(r"^Main Sleep \(asleep\): (.+)$"))
    o["mainPeriod_min"] = hm(g(r"^Main Sleep Period \(incl\. awake\): (.+)$"))
    o["legacyMainSleep_min"] = hm(g(r"^Main Sleep: (.+)$"))   # aelteres Format
    for k, pat in [("deep", "Deep Sleep Ratio"), ("light", "Light Sleep Ratio"), ("rem", "REM Ratio"), ("awake", "Awake Ratio")]:
        v = g(rf"^{pat}: (\d+)%"); o[k + "_pct"] = int(v) if v else None
    o["awake_min"] = hm(g(r"^Awake Time: (.+)$"))
    w = re.search(r"^Main Sleep Window: (\S+ \S+) - (\S+ \S+)$", b, re.M)
    o["sleepStart"], o["sleepEnd"] = (w.group(1), w.group(2)) if w else (None, None)
    o["naps_min"] = hm(g(r"^Naps Total(?: \(asleep\))?: (.+?)(?: \(|$)"))
    o["napWindows"] = re.findall(r"^Nap Window: (.+)$", b, re.M)
    o["notAvailable"] = "not available yet" in b

# --- queryDailyHealthData -------------------------------------------------
dh = rd("queryDailyHealthData__days-92.txt")
for b in re.split(r"\n\n(?=--- \d{8} ---)", dh):
    m = re.match(r"--- (\d{4})(\d\d)(\d\d) ---", b)
    if not m: continue
    D = day(f"{m.group(1)}-{m.group(2)}-{m.group(3)}"); o = D["dailyHealth"] = {"raw": b}
    g = lambda pat: (re.search(pat, b) or [None, None])[1]
    o["steps"] = int(g(r"Steps: ([\d,]+)").replace(",", "")) if g(r"Steps: ([\d,]+)") else None
    o["exercise_min"] = hm(g(r"Exercise: ([^|\n]+)"))
    o["stressAvg"] = int(g(r"Stress: Avg (\d+)")) if g(r"Stress: Avg (\d+)") else None
    for k in ["Total", "Deep", "Light", "REM", "Awake"]:
        o[k.lower() + "_min"] = hm(g(rf"{k}: ((?:\d+h )?\d+\s*min)"))
    s = re.search(r"Sleep HR: Avg (\d+) bpm \| Min (\d+) bpm \| Max (\d+) bpm", b)
    o["sleepHR"] = dict(zip(["avg", "min", "max"], map(int, s.groups()))) if s else None
    o["sleepScore"] = int(g(r"\(Score: (-?\d+)\)")) if g(r"\(Score: (-?\d+)\)") else None

# --- queryRestingHeartRate ------------------------------------------------
for d, v in re.findall(r"^(\d{4}-\d\d-\d\d): (\d+|No data)", rd("queryRestingHeartRate__days-92.txt"), re.M):
    day(d)["restingHR"] = int(v) if v.isdigit() else None

# --- querySleepHrv --------------------------------------------------------
for f in sorted(glob.glob(os.path.join(RAW, "querySleepHrv__*"))):
    t = open(f).read()
    for d, avg, lo, hi, rest in re.findall(r"^(\d{4}-\d\d-\d\d):\n  HRV Avg: (\d+) ms.*\n  Normal Range: (\d+) - (\d+) ms\n((?:  Baseline: \d+ ms\n)?)", t, re.M):
        bl = re.search(r"(\d+)", rest)
        day(d)["hrv"] = {"avg": int(avg), "normalLow": int(lo), "normalHigh": int(hi), "baseline": int(bl.group(1)) if bl else None}
    for blk in re.findall(r"^(\d{4}-\d\d-\d\d):\n((?:  timestamp=.*\n?)+)", t.split("Sleep HRV Time Series")[1], re.M):
        pts = [tuple(map(int, p)) for p in re.findall(r"timestamp=(\d+), timezone=(\d+), hrv=(\d+) ms, status=(\d+), confidence=(\d+)", blk[1])]
        day(blk[0]).setdefault("hrvPoints", pts)

# --- Aktivitaeten ---------------------------------------------------------
sr = rd("querySportRecords__endDate-20261011_startDate-20260713.txt")
acts = []
for b in re.split(r"\n\n(?=\d+\. )", sr):
    m = re.match(r"\d+\. (.+?) — (\d{4}-\d\d-\d\d)", b)
    if not m: continue
    a = {"type": m.group(1), "date": m.group(2), "raw": b}
    for k, pat in [("start", r"startTimestamp=(\d+)"), ("end", r"endTimestamp=(\d+)"), ("labelId", r"LabelId: (\d+)"), ("sportType", r"SportType: (\d+)"), ("avgHR", r"Avg HR: (\d+) bpm")]:
        v = re.search(pat, b); a[k] = int(v.group(1)) if v and k != "labelId" else (v.group(1) if v else None)
    a["duration"] = (re.search(r"Duration: ([\d:]+)", b) or [None, None])[1]
    p = os.path.join(RAW, f"getActivityDetail__labelId-{a['labelId']}.txt")
    if os.path.exists(p):
        det = open(p).read(); a["detailRaw"] = det
        tl = re.search(r"Training Load: (\d+)", det); a["trainingLoad"] = int(tl.group(1)) if tl else None
    acts.append(a)

json.dump({"days": dict(sorted(days.items())), "activities": acts,
           "userInfo": rd("queryUserInfo.txt"), "fitness": rd("queryFitnessAssessmentOverview.txt"),
           "loadAssessment": rd("queryTrainingLoadAssessment__days-92.txt"),
           "dailyHeader": dh.splitlines()[0]}, open(OUT, "w"), indent=1)
print("Tage:", len(days), "Aktivitaeten:", len(acts))
