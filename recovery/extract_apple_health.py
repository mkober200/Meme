"""Streamt eine Apple-Health-export.xml (oder die export.zip) und zieht nur die
Datensaetze heraus, die fuer Recovery, Strain, Sleep und Richtung gebraucht werden.

Jeder Datensatz wird VOLLSTAENDIG gespeichert: alle XML-Attribute plus alle
MetadataEntry-Kinder (und bei Workouts alle Statistik-/Event-Kinder). Nichts wird
vorab auf "bekannte" Felder reduziert - das passiert erst nach Schritt 3.

Aufruf:  python3 -I extract_apple_health.py <export.zip|export.xml> <ausgabe.json>
"""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

RECORD_TYPES = {
    "HKCategoryTypeIdentifierSleepAnalysis",
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
    "HKQuantityTypeIdentifierRestingHeartRate",
    "HKQuantityTypeIdentifierVO2Max",
    "HKQuantityTypeIdentifierRespiratoryRate",
    "HKQuantityTypeIdentifierOxygenSaturation",
    "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
    "HKQuantityTypeIdentifierHeartRate",  # Pulskurve fuer TRIMPexp
}
# Pulsrohdaten sind riesig - nur das Fenster, das fuer Strain gebraucht wird.
HR_DAYS = 120
OTHER_DAYS = 400


def parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")


def open_xml(path):
    if path.lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        name = next(n for n in z.namelist() if n.endswith("export.xml") and "cda" not in n)
        return z.open(name)
    return open(path, "rb")


def element_to_dict(el):
    d = dict(el.attrib)
    meta = {m.get("key"): m.get("value") for m in el.findall("MetadataEntry")}
    if meta:
        d["_metadata"] = meta
    if el.tag == "Workout":
        d["_statistics"] = [dict(s.attrib) for s in el.findall("WorkoutStatistics")]
        d["_events"] = [dict(e.attrib) for e in el.findall("WorkoutEvent")]
        d["_activities"] = [dict(a.attrib) for a in el.findall("WorkoutActivity")]
    return d


def main(src, dst):
    now = datetime.now(timezone.utc)
    hr_cut = now - timedelta(days=HR_DAYS)
    other_cut = now - timedelta(days=OTHER_DAYS)
    out = {"records": {t: [] for t in RECORD_TYPES}, "workouts": [], "me": None,
           "exportDate": None, "sources": {}}
    with open_xml(src) as fh:
        for event, el in ET.iterparse(fh, events=("end",)):
            tag = el.tag
            if tag == "ExportDate":
                out["exportDate"] = el.get("value")
            elif tag == "Me":
                out["me"] = dict(el.attrib)
            elif tag == "Record":
                t = el.get("type")
                if t in RECORD_TYPES:
                    start = parse_date(el.get("startDate"))
                    if start >= (hr_cut if t == "HKQuantityTypeIdentifierHeartRate" else other_cut):
                        if t == "HKQuantityTypeIdentifierHeartRate":
                            # Puls kompakt, aber vollstaendig je Messpunkt
                            out["records"][t].append([el.get("startDate"), el.get("endDate"),
                                                      el.get("value"), el.get("sourceName")])
                        else:
                            out["records"][t].append(element_to_dict(el))
                        key = f'{t}|{el.get("sourceName")}'
                        out["sources"][key] = out["sources"].get(key, 0) + 1
                el.clear()
            elif tag == "Workout":
                if parse_date(el.get("startDate")) >= other_cut:
                    out["workouts"].append(element_to_dict(el))
                    key = f'Workout|{el.get("sourceName")}'
                    out["sources"][key] = out["sources"].get(key, 0) + 1
                el.clear()
            elif tag in ("ActivitySummary", "Correlation", "ClinicalRecord", "Audiogram"):
                el.clear()
    with open(dst, "w") as f:
        json.dump(out, f)
    for k in sorted(out["sources"]):
        print(f'{out["sources"][k]:>9}  {k}')


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
