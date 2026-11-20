"""Turn a trimmed model VTK into a small uniform volume a browser can load.

Usage (needs PyVista, e.g. the femtic_gui env):
    python make_volume.py <model_trimmed.vtk> <out_stem> [nx ny nz]

Writes <out_stem>.u16 (log10 resistivity, uint16, x fastest then y then z) and <out_stem>.json
(grid size, spacing in km, value scaling). Viewing copy only: the grid is resampled, so it is not
for computing.

Check, run after writing and from the files on disk:
    This test fails if the original ground cells whose containing voxel differs by more than
    0.15 log10 units make up more than 1 % of the model's ground volume, or if the correlation
    between original and voxel values is below 0.95. A swapped or flipped axis fails it; so does a
    wrong scale or byte order.

    Why volume and not cell count (20 Nov 2026, Vulcan 2022 Model 1): the first criterion was
    "no more than 5 % of cells" and it failed at 7.4 %. The cause is real, not a bug: 97 of the
    model's 134 layers are thinner than one voxel (161 m at nz = 128; the thinnest is 5 m), so
    several thin near-surface cells share one voxel. Mismatch was 17 % of cells in the top 500 m,
    about 2 % from 500 m to 2 km, and 0 % below 2 km; 0.23 % by volume. The uniform volume
    therefore cannot show the top few hundred metres faithfully. The script prints the
    top-500 m figure every run so that limit stays visible.
"""
import json
import sys

import numpy as np
import pyvista as pv

src, stem = sys.argv[1], sys.argv[2]
nx, ny, nz = (int(v) for v in sys.argv[3:6]) if len(sys.argv) >= 6 else (96, 96, 128)
FIELD = "log10_resistivity"

m = pv.read(src)
x0, x1, y0, y1, z0, z1 = m.bounds
img = pv.ImageData(dimensions=(nx, ny, nz), origin=(x0, y0, z0),
                   spacing=((x1 - x0) / (nx - 1), (y1 - y0) / (ny - 1), (z1 - z0) / (nz - 1)))
# nearest original cell for every voxel: keeps the model's own values, no smoothing invented
centres = m.cell_centers()
nearest = np.asarray(m.find_closest_cell(np.asarray(img.points)))
v = np.asarray(m.cell_data[FIELD], dtype=np.float64)[nearest]
# Cells above the ground surface have no value in the source (NaN). They are written as 0, which
# is reserved for "no data"; real values use 1..65535.
air = ~np.isfinite(v)
assert air.mean() < 0.2, "more than 20 % of the volume has no value: check the source"
lo, hi = float(np.floor(v[~air].min() * 10) / 10), float(np.ceil(v[~air].max() * 10) / 10)
q = np.zeros(v.size, dtype="<u2")
q[~air] = (1 + np.round((v[~air] - lo) / (hi - lo) * 65534)).astype("<u2")
q.tofile(stem + ".u16")
meta = {
    "source": src.replace("\\", "/").split("/")[-1],
    "field": FIELD, "units": "log10(ohm.m)",
    "dims": [nx, ny, nz],
    "spacing_km": [img.spacing[0] / 1000, img.spacing[1] / 1000, img.spacing[2] / 1000],
    "extent_km": [(x1 - x0) / 1000, (y1 - y0) / 1000, (z1 - z0) / 1000],
    "origin_utm_m": [x0, y0, z0], "top_elevation_m": z1,
    "scale": {"lo": lo, "hi": hi, "dtype": "uint16-le", "nodata": 0, "value": "lo + (raw - 1) / 65534 * (hi - lo)"},
    "nodata_voxels": int(air.sum()),
}
json.dump(meta, open(stem + ".json", "w"), indent=1)

# ── check, from the written files ──
meta2 = json.load(open(stem + ".json"))
a = np.fromfile(stem + ".u16", dtype="<u2").reshape(meta2["dims"][::-1])  # [z, y, x]
back = np.where(a == 0, np.nan, (a.astype(float) - 1) / 65534 * (meta2["scale"]["hi"] - meta2["scale"]["lo"]) + meta2["scale"]["lo"])
allv = np.asarray(m.cell_data[FIELD])
g = np.isfinite(allv)                                   # ground cells only
p = np.asarray(centres.points)[g]
orig = allv[g]
vol = np.abs(np.asarray(m.compute_cell_sizes(length=False, area=False, volume=True).cell_data["Volume"]))[g]
o = np.array(meta2["origin_utm_m"]); s = np.array(meta2["spacing_km"]) * 1000
ijk = np.clip(np.rint((p - o) / s).astype(int), 0, np.array(meta2["dims"]) - 1)
got = back[ijk[:, 2], ijk[:, 1], ijk[:, 0]]
ok = np.isfinite(got)          # a ground cell landing on a no-data voxel counts as a miss
miss = ~ok | (np.abs(np.where(ok, got, 0) - orig) > 0.15)
bad = vol[miss].sum() / vol.sum()
r = np.corrcoef(got[ok], orig[ok])[0, 1]
shallow = (meta2["top_elevation_m"] - p[:, 2]) < 500
print(f"dims {nx}x{ny}x{nz}, {q.nbytes/1e6:.2f} MB, log10 range {lo}..{hi}, {int(air.sum())} no-data voxels")
print(f"check: mismatched cells hold {bad*100:.2f} % of ground volume (limit 1 %), correlation {r:.3f} (limit 0.95)")
print(f"known limit: {miss[shallow].mean()*100:.1f} % of cells in the top 500 m are not resolved by this grid")
passed = bad <= 0.01 and r >= 0.95
print("PASS" if passed else "FAIL")
sys.exit(0 if passed else 1)
