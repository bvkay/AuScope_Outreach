"""Write the MT site positions for the 3D viewer, in the viewer's local kilometres.

Usage (needs pyproj, e.g. the eastpilbara env):
    python make_sites.py <folder of .edi files> <volume .json from make_volume.py> <out .json>

Positions come from the >HEAD LAT / LONG lines (degrees:minutes:seconds). The decimal LATITUDE in the
>INFO block is not used: on Vulcan 2022 it disagrees with the header (A1: header -30:8:45.208 =
-30.1459, info -29.8541, which is the header with the minutes added the wrong way for a southern
latitude).

Check:
    This test fails if fewer than 90 % of the sites fall inside the model's horizontal extent.
    The model extent comes from the model file and the sites from the EDI headers, so a wrong
    UTM zone, hemisphere, sign or swapped axis puts the sites outside and fails it.
"""
import glob
import json
import os
import re
import sys

from pyproj import Transformer

edi_dir, vol_json, out = sys.argv[1:4]
meta = json.load(open(vol_json))
x0, y0, _ = meta["origin_utm_m"]
ex, ey, _ = meta["extent_km"]
to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32753", always_xy=True)   # WGS84 -> UTM 53S


def dms(text):
    sign = -1 if text.strip().startswith("-") else 1
    d, m, s = (abs(float(p)) for p in text.strip().lstrip("+-").split(":"))
    return sign * (d + m / 60 + s / 3600)


sites = []
for f in sorted(glob.glob(os.path.join(edi_dir, "*.edi"))):
    head = open(f, errors="replace").read(4000)
    g = lambda key: re.search(r"^\s*" + key + r"\s*=\s*\"?([^\"\r\n]+)", head, re.M).group(1)
    e, n = to_utm.transform(dms(g("LONG")), dms(g("LAT")))
    sites.append({"id": g("DATAID").strip(), "x": round((e - x0) / 1000, 3), "y": round((n - y0) / 1000, 3)})

inside = [s for s in sites if 0 <= s["x"] <= ex and 0 <= s["y"] <= ey]
frac = len(inside) / len(sites)
json.dump({"crs": "local km from model south-west corner (UTM 53S)", "sites": sites}, open(out, "w"), indent=0)
print(f"{len(sites)} sites, x {min(s['x'] for s in sites):.2f}..{max(s['x'] for s in sites):.2f} km, "
      f"y {min(s['y'] for s in sites):.2f}..{max(s['y'] for s in sites):.2f} km; model is {ex:.1f} x {ey:.1f} km")
print(f"check: {frac*100:.0f} % of sites inside the model extent (limit 90 %)")
print("PASS" if frac >= 0.9 else "FAIL")
sys.exit(0 if frac >= 0.9 else 1)
