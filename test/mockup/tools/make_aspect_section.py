"""Make small viewer sections from a 2D ASPECT run: one file per field per time step.

Usage (needs PyVista):
    python make_aspect_section.py <folder with solution-NNNNN.pvtu + pieces and solution.pvd> <out_stem> [nx nz [xmin_km xmax_km depth_km]]

The optional crop keeps x between xmin and xmax and the top depth_km of the model, measured down
from the highest point the surface reaches in any time step.

The adaptive mesh is sampled onto a uniform nx x nz grid. Each field uses one value range for all
time steps, so colours mean the same thing as time moves. Viewing copy only.

Check, from the written files, for every field at the last time step:
    This test fails if the correlation between 3000 randomly chosen mesh nodes and the voxels that
    contain them is below 0.95, or if the same comparison with the section flipped left-right or
    upside-down scores higher than the unflipped one. A wrong axis order or orientation fails it.
    The share of nodes that differ by more than 5 % of the field's range is printed, not tested:
    the mesh is refined to finer than a voxel along the faults, so some loss there is expected.
"""
import glob
import json
import os
import re
import sys

import numpy as np
import pyvista as pv

src, stem = sys.argv[1], sys.argv[2]
nx, nz = (int(v) for v in sys.argv[3:5]) if len(sys.argv) >= 5 else (800, 200)
crop = [float(v) for v in sys.argv[5:8]] if len(sys.argv) >= 8 else None

# field name in the files -> (label, unit, log scale, multiply by)
FIELDS = {
    "strain_rate": ("Strain rate", "1/s", True, 1.0),
    "viscosity": ("Viscosity", "Pa s", True, 1.0),
    "T": ("Temperature", "K", False, 1.0),
    "plastic_strain": ("Plastic strain", "", False, 1.0),
}
pvd = open(os.path.join(src, "solution.pvd")).read()
when = {m[1]: float(m[0]) for m in re.findall(r'timestep="([^"]+)"[^>]*file="solution/solution-(\d+)\.pvtu"', pvd)}
steps = sorted(re.search(r"solution-(\d+)\.pvtu", f).group(1) for f in glob.glob(os.path.join(src, "solution-*.pvtu")))

# The box must hold every time step: the surface rises as the footwall is exhumed. (20 Nov 2026:
# taking the box from the first step cut off the top 1.3 km of the last one, which is where the
# plastic strain is largest, and the plastic-strain check failed at 0.71.)
meshes = {s: pv.read(os.path.join(src, f"solution-{s}.pvtu")) for s in steps}
bs = np.array([m.bounds[:4] for m in meshes.values()])
box = (bs[:, 0].min(), bs[:, 1].max(), bs[:, 2].min(), bs[:, 3].max())
if crop:
    box = (crop[0] * 1000, crop[1] * 1000, box[3] - crop[2] * 1000, box[3])

store, last_mesh = {}, None
for s in steps:
    m = meshes[s]
    img = pv.ImageData(dimensions=(nx, nz, 1), origin=(box[0], box[2], 0),
                       spacing=((box[1] - box[0]) / (nx - 1), (box[3] - box[2]) / (nz - 1), 1))
    out = img.sample(m)
    valid = np.asarray(out.point_data["vtkValidPointMask"]).astype(bool)
    for f in FIELDS:
        a = np.asarray(out.point_data[f], dtype=float).copy()
        a[~valid] = np.nan
        store[(f, s)] = a.reshape(nz, nx)          # [z from the bottom, x]
    last_mesh = m
    print("sampled step", s, f"t = {when[s]/1e6:.2f} Myr", f"{(~valid).mean()*100:.1f} % outside the mesh")

ok_all = True
for f, (label, unit, log, mult) in FIELDS.items():
    allv = np.concatenate([store[(f, s)].ravel() for s in steps])
    allv = allv[np.isfinite(allv)]
    if f == "plastic_strain":
        allv = np.clip(allv, 0, None)              # small negative values are numerical overshoot
    tr = (lambda a: np.log10(np.maximum(a, 1e-300))) if log else (lambda a: a)
    lo, hi = float(np.percentile(tr(allv), 0.1)), float(np.percentile(tr(allv), 99.9))
    for s in steps:
        a = store[(f, s)]
        if f == "plastic_strain":
            a = np.clip(a, 0, None)
        t = tr(a)
        q = np.zeros(t.shape, dtype="<u2")
        g = np.isfinite(t)
        q[g] = (1 + np.round((np.clip(t[g], lo, hi) - lo) / (hi - lo) * 65534)).astype("<u2")
        q.tofile(f"{stem}-{f}-{s}.u16")
        json.dump({
            "source": f"solution-{s}.pvtu", "field": label, "units": unit, "log": log, "time_yr": when[s],
            "dims": [nx, 1, nz],
            "spacing_km": [(box[1] - box[0]) / (nx - 1) / 1000, 1, (box[3] - box[2]) / (nz - 1) / 1000],
            "extent_km": [(box[1] - box[0]) / 1000, 0, (box[3] - box[2]) / 1000],
            "axes": ["Distance (km)", "", "Depth (km)"],
            "x_origin_km": box[0] / 1000, "crop": "central part of the model" if crop else "whole model",
            "scale": {"lo": lo, "hi": hi, "dtype": "uint16-le", "nodata": 0, "value": "lo + (raw - 1) / 65534 * (hi - lo)",
                      "clipped": "values outside the 0.1 to 99.9 percentile range of all time steps are shown at the ends of the scale"},
            "nodata_voxels": int((~g).sum()),
        }, open(f"{stem}-{f}-{s}.json", "w"), indent=1)

    # ── check at the last step, from the written files ──
    s = steps[-1]
    meta = json.load(open(f"{stem}-{f}-{s}.json"))
    a = np.fromfile(f"{stem}-{f}-{s}.u16", dtype="<u2").reshape(nz, nx).astype(float)
    back = np.where(a == 0, np.nan, (a - 1) / 65534 * (meta["scale"]["hi"] - meta["scale"]["lo"]) + meta["scale"]["lo"])
    rng = np.random.default_rng(2)
    P = np.asarray(last_mesh.points)
    inside = np.flatnonzero((P[:, 0] >= box[0]) & (P[:, 0] <= box[1]) & (P[:, 1] >= box[2]) & (P[:, 1] <= box[3]))
    pick = rng.choice(inside, 3000, replace=False)
    p = P[pick]
    truth = np.asarray(last_mesh.point_data[f], dtype=float)[pick]
    if f == "plastic_strain":
        truth = np.clip(truth, 0, None)
    truth = np.clip(tr(truth), lo, hi)
    ix = np.clip(np.rint((p[:, 0] - box[0]) / (box[1] - box[0]) * (nx - 1)).astype(int), 0, nx - 1)
    iz = np.clip(np.rint((p[:, 1] - box[2]) / (box[3] - box[2]) * (nz - 1)).astype(int), 0, nz - 1)
    def score(arr):
        got = arr[iz, ix]; k = np.isfinite(got)
        return np.corrcoef(got[k], truth[k])[0, 1], np.mean(np.abs(got[k] - truth[k]) > 0.05 * (hi - lo))
    r, off = score(back)
    r_lr, r_ud = score(back[:, ::-1])[0], score(back[::-1, :])[0]
    good = r >= 0.95 and r > r_lr and r > r_ud
    ok_all &= good
    print(f"{label}: range {lo:.3g}..{hi:.3g}{' (log10)' if log else ''}; correlation {r:.3f} (limit 0.95), "
          f"flipped left-right {r_lr:.3f}, upside-down {r_ud:.3f}; {off*100:.1f} % of nodes off by > 5 % of range  ->  {'PASS' if good else 'FAIL'}")

json.dump([{"id": s, "label": f"{when[s]/1e6:.1f} Myr"} for s in steps], open(f"{stem}-times.json", "w"))
print("PASS" if ok_all else "FAIL")
sys.exit(0 if ok_all else 1)
