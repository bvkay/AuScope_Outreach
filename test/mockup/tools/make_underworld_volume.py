"""Make a small viewer volume from an Underworld2 field on a structured (possibly deformed) mesh,
reading only the needed rows from NCI over OPeNDAP.

Usage:
    python make_underworld_volume.py <dodsC folder url> <mesh.h5> <field.h5> <out_stem> <label> <unit> [step_j step_k nz]

Written for gollapalli-2025-sundamegathrust: a spherical cap, nodes ordered radius fastest, then the
two angular directions. The viewer copy is "unwrapped": the two angular directions become flat
axes measured as arc length at the surface (km), and radius becomes depth (km). Curvature is not
shown. Values are stored as log10.

Check, from the written files:
    This test fails if more than 1 % of 300 randomly chosen voxels differ from the value of their
    source node, fetched again one node at a time, by more than 0.001 log10 units. The re-fetch
    uses the node number computed from (i, j, k) independently of the plane-by-plane read, so a
    wrong ordering, decimation or axis flip fails it.
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from dap import get

base, mesh, field, stem, label, unit = sys.argv[1:7]
sj, sk, nz = (int(v) for v in sys.argv[7:10]) if len(sys.argv) >= 10 else (4, 4, 96)
R_EARTH = 6371.0

# mesh size and angular extent come from the mesh file's own attributes
das = __import__("urllib.request").request.urlopen(base + mesh + ".das", timeout=60).read().decode()
grab = lambda key: [float(v) for v in das.split(key, 1)[1].split(";", 1)[0].replace(",", " ").split()]
res = [int(v) for v in grab("mesh_resolution")]
mn, mx = grab("Float64 min"), grab("Float64 max")
NI, NJ, NK = res[0] + 1, res[1] + 1, res[2] + 1

# radius of every node along the first radial line; depth levels are taken from it
line = get(base + mesh, "vertices", (0, NI - 1), (0, 2))
r = np.linalg.norm(line, axis=1)
other = np.linalg.norm(get(base + mesh, "vertices", (NI * (NJ // 2 + NJ * (NK // 2)), NI * (NJ // 2 + NJ * (NK // 2)) + NI - 1), (0, 2)), axis=1)
assert np.abs(other - r).max() < 2e-3, "radial levels differ between columns: the unwrapped view would be wrong"
depth = (1 - r) * R_EARTH                                   # km, deepest first
target = np.linspace(depth.max(), 0, nz)                    # uniform depth levels, deepest first
ii = np.array([np.abs(depth - t).argmin() for t in target])
jj = np.arange(0, NJ, sj)
kk = np.arange(0, NK, sk)

def plane(k):
    a = get(base + field, "data", (int(k) * NI * NJ, int(k) * NI * NJ + NI * NJ - 1), (0, 0))[:, 0]
    return a.reshape(NJ, NI)[np.ix_(jj, ii)]               # [j, i]

with ThreadPoolExecutor(4) as ex:
    planes = list(ex.map(plane, kk))
v = np.stack(planes)                                        # [k, j, i]
v = np.log10(np.maximum(v, 1e-300))
vol = np.transpose(v, (2, 0, 1))                            # [z = depth level, y = k, x = j]
lo, hi = float(np.floor(vol.min() * 10) / 10), float(np.ceil(vol.max() * 10) / 10)
q = (1 + np.round((vol - lo) / (hi - lo) * 65534)).astype("<u2")
q.tofile(stem + ".u16")

km_per_deg = np.pi * R_EARTH / 180
ext = [(mx[1] - mn[1]) * km_per_deg, (mx[2] - mn[2]) * km_per_deg, float(depth.max())]
meta = {
    "source": field, "field": label, "units": unit, "log": True,
    "dims": [len(jj), len(kk), nz],
    "spacing_km": [ext[0] / (len(jj) - 1), ext[1] / (len(kk) - 1), ext[2] / (nz - 1)],
    "extent_km": ext,
    "axes": ["Across (km at surface)", "Along (km at surface)", "Depth (km)"],
    "note": "Spherical cap shown unwrapped: horizontal distances are arc lengths at the surface.",
    "scale": {"lo": lo, "hi": hi, "dtype": "uint16-le", "nodata": 0, "value": "lo + (raw - 1) / 65534 * (hi - lo)"},
    "nodata_voxels": 0,
}
json.dump(meta, open(stem + ".json", "w"), indent=1)

# ── check, from the written files, against single nodes fetched again ──
m2 = json.load(open(stem + ".json"))
a = np.fromfile(stem + ".u16", dtype="<u2").reshape(m2["dims"][::-1])     # [z, y, x]
back = (a.astype(float) - 1) / 65534 * (m2["scale"]["hi"] - m2["scale"]["lo"]) + m2["scale"]["lo"]
rng = np.random.default_rng(1)
picks = [(int(rng.integers(nz)), int(rng.integers(len(kk))), int(rng.integers(len(jj)))) for _ in range(300)]
def one(p):
    z, y, x = p
    node = int(ii[z]) + NI * (int(jj[x]) + NJ * int(kk[y]))
    return np.log10(max(get(base + field, "data", (node, node), (0, 0))[0, 0], 1e-300))
with ThreadPoolExecutor(4) as ex:
    truth = np.array(list(ex.map(one, picks)))
got = np.array([back[p] for p in picks])
bad = np.mean(np.abs(got - truth) > 0.001)
print(f"{label}: dims {m2['dims']}, {q.nbytes/1e6:.2f} MB, log10 range {lo}..{hi}, depth levels from {NI} radial nodes")
print(f"check: {bad*100:.1f} % of 300 voxels differ from their source node by > 0.001 log units (limit 1 %)")
print("PASS" if bad <= 0.01 else "FAIL")
sys.exit(0 if bad <= 0.01 else 1)
