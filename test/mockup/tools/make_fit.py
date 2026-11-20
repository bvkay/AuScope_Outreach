"""Write the model-fit file for the viewer from a Geotools (RLM-3D) inversion package.

Usage (plain Python, no extra packages):
    python make_fit.py <package folder> <sites .json from make_sites.py> <out .json>

Reads, from the Level 3 package layout:
    inputs/EDI_used/<site>_ObsUsed.edi            observed Z with the floored variances the run used
    outputs/responses/EDI_predicted/<site>_prd.edi final response, distortion applied
    outputs/misfit/*_MT_tab.rms                    the code's RMS per site
    outputs/misfit/*_MT_tab.Zrms                   the code's RMS per site and period
    outputs/misfit/*_tab.log                       nRMS per iteration
    outputs/misfit/*.log                           error floors

Writes one JSON file: run summary, per-site RMS (the code's own totals, plus RMS per impedance
component worked out here from the EDIs), RMS per site and period, and the observed and predicted
impedances for drawing curves.

RMS convention (found by matching the code's tables, see checks):
    rms = sqrt( mean over real and imaginary parts of (obs - predicted)^2 / variance )

Checks. The code's tables and the EDIs are separate files written by the inversion, so a wrong
pairing of sites, a wrong variance convention, a period-order flip or a mixed-up component fails them.
    1. This test fails if any site's RMS recomputed from the EDIs differs from the code's table by
       more than 0.02 (the table is rounded to 0.01).
    2. This test fails if any site-and-period RMS recomputed from the EDIs differs from the code's
       table by more than 0.02 or 1 %.
    3. This test fails if the overall RMS recomputed from every datum differs from the final nRMS
       in the iteration log by more than 0.005.
    4. This test fails if sqrt((Zxy^2 + Zyx^2) / 2) of the per-component RMS worked out here differs
       from the code's off-diagonal column by more than 0.02 at any site (same for the diagonal).
    5. This test fails if any site in the fit has no position in the sites file, or if two sites
       share a name. Geotools writes a doubled underscore in its output names where the input EDI
       has one (input "J6_BxRepaced", output "J6__BxRepaced"), so names are compared with repeated
       underscores collapsed. The first run of this check failed on exactly those seven renamed
       sites; their header LAT / LONG are identical in the input and output EDIs, so it is a naming
       difference and not a wrong pairing.
"""
import glob
import json
import math
import os
import re
import sys

pkg, sites_json, out = sys.argv[1:4]
COMPS = ["zxx", "zxy", "zyx", "zyy"]


def one(pattern, skip=()):
    hits = [f for f in glob.glob(os.path.join(pkg, pattern)) if not any(s in os.path.basename(f) for s in skip)]
    assert len(hits) == 1, f"expected one file for {pattern}, found {hits}"
    return hits[0]


def read_edi(path):
    """Return (dataid, {block name: [numbers]}) for the >NAME //N blocks."""
    text = open(path, errors="replace").read()
    dataid = re.search(r'DATAID\s*=\s*"?([^"\r\n]+)', text).group(1).strip()
    empty = float(re.search(r"EMPTY\s*=\s*(\S+)", text).group(1))
    blocks = {}
    for m in re.finditer(r"^>([A-Z.]+)[^\n]*//\s*(\d+)\s*\n([^>]*)", text, re.M):
        vals = [float(v) for v in m.group(3).split()]
        assert len(vals) == int(m.group(2)), f"{path}: {m.group(1)} has {len(vals)} values, header says {m.group(2)}"
        blocks[m.group(1)] = [None if abs(v) >= empty * 0.99 else v for v in vals]
    return dataid, blocks


def sig(v, n=5):
    return None if v is None else float(f"{v:.{n}g}")


# ── the code's own tables ──
rows = [l.rstrip("\n").split("\t") for l in open(one("outputs/misfit/*_MT_tab.rms"))]
head = [h.strip() for h in rows[0]]
reported = {r[0].strip(): dict(zip(head[1:], (float(v) for v in r[1:]))) for r in rows[1:] if r[0].strip()}

rows = [l.rstrip("\n").split("\t") for l in open(one("outputs/misfit/*_MT_tab.Zrms"))]
table_freqs = [float(v) for v in rows[0][1:] if re.match(r"\s*[\d.]+E", v)]
reported_fp = {r[0].strip(): [float(v) for v in r[1:1 + len(table_freqs)]] for r in rows[1:] if r[0].strip()}

rows = [l.split("\t") for l in open(one("outputs/misfit/*_tab.log"))]
conv = [float(r[3]) for r in rows[1:] if len(r) > 3]

log = open(one("outputs/misfit/*.log", skip=("_tab",))).read()
floors = {c: float(re.search(c.capitalize() + r" percentage error floor:\s*([\d.]+)", log).group(1)) for c in COMPS}
version = re.search(r"Version:\s*(\S+)", log).group(1)

# ── observed and predicted, site by site ──
norm = lambda name: re.sub(r"_+", "_", name)
positions = {norm(s["id"]): s["id"] for s in json.load(open(sites_json))["sites"]}
sites, worst_site, worst_fp, worst_pair, missing = {}, 0.0, 0.0, 0.0, []
freqs, all_sq, all_n = None, 0.0, 0

for name in sorted(reported):
    did, obs = read_edi(os.path.join(pkg, "inputs", "EDI_used", name + "_ObsUsed.edi"))
    did2, prd = read_edi(os.path.join(pkg, "outputs", "responses", "EDI_predicted", name + "_prd.edi"))
    assert did == did2, f"{name}: observed DATAID {did} but predicted {did2}"
    assert obs["FREQ"] == prd["FREQ"], f"{name}: observed and predicted frequencies differ"
    assert obs["ZROT"] == prd["ZROT"], f"{name}: observed and predicted rotations differ"
    if freqs is None:
        freqs = obs["FREQ"]
        assert all(abs(a - b) / b < 2e-3 for a, b in zip(freqs, table_freqs)), "EDI and Zrms table frequencies differ"
    assert obs["FREQ"] == freqs, f"{name}: frequencies differ from the first site"
    if norm(did) not in positions or positions[norm(did)] in sites:
        missing.append(did)
    did = positions.get(norm(did), did)          # the name the sites file uses

    nf = len(freqs)
    sq_c = {c: 0.0 for c in COMPS}
    n_c = {c: 0 for c in COMPS}
    sq_f, n_f = [0.0] * nf, [0] * nf
    for c in COMPS:
        C = c.upper()
        for k in range(nf):
            o_r, o_i, var = obs[C + "R"][k], obs[C + "I"][k], obs[C + ".VAR"][k]
            p_r, p_i = prd[C + "R"][k], prd[C + "I"][k]
            if None in (o_r, o_i, var, p_r, p_i) or var <= 0:
                continue
            d = ((o_r - p_r) ** 2 + (o_i - p_i) ** 2) / var
            sq_c[c] += d; n_c[c] += 2
            sq_f[k] += d; n_f[k] += 2
    tot_sq, tot_n = sum(sq_c.values()), sum(n_c.values())
    all_sq += tot_sq; all_n += tot_n
    mine = {c: math.sqrt(sq_c[c] / n_c[c]) for c in COMPS}
    total = math.sqrt(tot_sq / tot_n)
    by_f = [math.sqrt(s / n) if n else None for s, n in zip(sq_f, n_f)]

    rep = reported[name]
    worst_site = max(worst_site, abs(total - rep["TOTAL"]))
    for a, b in zip(by_f, reported_fp[name]):
        worst_fp = max(worst_fp, min(abs(a - b), abs(a - b) / b * 2))        # 0.02 or 1 %, whichever is looser
    worst_pair = max(worst_pair,
                     abs(math.sqrt((mine["zxy"] ** 2 + mine["zyx"] ** 2) / 2) - rep["Zxy+Zyx"]),
                     abs(math.sqrt((mine["zxx"] ** 2 + mine["zyy"] ** 2) / 2) - rep["Zxx+Zyy"]))

    sites[did] = {
        "file": name, "label": did.split("_")[0],
        "rms": {"total": rep["TOTAL"], "offdiag": rep["Zxy+Zyx"], "diag": rep["Zxx+Zyy"],
                **{c: round(mine[c], 2) for c in COMPS}},
        "n": int(rep["ncZ"]),
        "by_period": reported_fp[name],
        "obs": {c: {"re": [sig(v) for v in obs[c.upper() + "R"]], "im": [sig(v) for v in obs[c.upper() + "I"]],
                    "var": [sig(v, 4) for v in obs[c.upper() + ".VAR"]]} for c in COMPS},
        "prd": {c: {"re": [sig(v) for v in prd[c.upper() + "R"]], "im": [sig(v) for v in prd[c.upper() + "I"]]} for c in COMPS},
    }

overall = math.sqrt(all_sq / all_n)
fit = {
    "code": "RLM-3D " + version + " (Geotools)",
    "inverted": "complex impedance Z",
    "units": "Z in mV/km/nT (EDI field units); apparent resistivity = 0.2 / f * |Z|^2",
    "rms_definition": "sqrt(mean over real and imaginary parts of (observed - predicted)^2 / variance)",
    "error_floors_percent": floors,
    "errors": "observed errors plus error floors",
    "nrms_final": conv[-1], "iterations": len(conv) - 1, "nrms_by_iteration": conv,
    "n_sites": len(sites), "n_data": all_n,
    "freqs_hz": freqs, "rotation_deg": obs["ZROT"][0],
    "component_rms_source": "zxx, zxy, zyx, zyy worked out from the EDIs by make_fit.py; total, offdiag, diag and by_period are the inversion code's own tables",
    "sites": sites,
}
json.dump(fit, open(out, "w"), separators=(",", ":"))

print(f"{len(sites)} sites, {len(freqs)} frequencies, {all_n} data; file {os.path.getsize(out) / 1024:.0f} kB")
checks = [
    ("1 per-site RMS, EDIs vs code table: worst difference", worst_site, 0.02),
    ("2 per-site-and-period RMS, EDIs vs code table: worst difference (0.02 or 1 %)", worst_fp, 0.02),
    ("3 overall RMS from every datum %.4f vs log %.4f: difference" % (overall, conv[-1]), abs(overall - conv[-1]), 0.005),
    ("4 component pairs vs code's diagonal / off-diagonal columns: worst difference", worst_pair, 0.02),
    ("5 sites without a position: %s" % (missing or "none"), len(missing), 0.5),
]
ok = True
for label, value, limit in checks:
    good = value <= limit
    ok = ok and good
    print(f"check {label} = {value:.4f} (limit {limit}) {'PASS' if good else 'FAIL'}")
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
