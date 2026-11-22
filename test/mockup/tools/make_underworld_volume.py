"""Makes a small viewer volume from an Underworld2 field on a structured mesh, reading only the
needed rows from NCI over OPeNDAP.

Usage:
    python make_underworld_volume.py <dodsC folder url> <mesh.h5> <field.h5> <out_stem> <label> <unit> [step_j step_k nz]

Written for gollapalli-2025-sundamegathrust: a spherical cap, nodes ordered radius fastest, then
the two angular directions. The viewer copy is "unwrapped": the two angular directions become
flat axes measured as arc length at the surface (km), and radius becomes depth (km). Curvature is
not shown. Values are stored as log10.

Check, from the written files:
    This test fails if more than 1 % of 300 randomly chosen voxels differ from the value of their
    source node, fetched again one node at a time, by more than 0.001 log10 units. The re-fetch
    uses the node number computed from (i, j, k) independently of the plane-by-plane read, so a
    wrong ordering, decimation or axis flip fails it.
"""
import argparse
import dataclasses
import math
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import volume_io  # noqa: E402  (sibling modules; the path line lets "python -I" find them)
from dap import read_array  # noqa: E402

EARTH_RADIUS_KM = 6371.0
SMALLEST_VALUE = 1e-300     # keeps log10 finite where the field is zero
RADIAL_TOLERANCE = 2e-3
N_CHECKED = 300
MAX_DIFFERENCE_LOG10 = 0.001
MAX_FRACTION_DIFFERENT = 0.01
N_READERS = 4


@dataclasses.dataclass
class Mesh:
    """The source mesh and the nodes chosen for the viewer copy.

    Attributes:
        ni: Nodes along radius.
        nj: Nodes along the first angular direction.
        nk: Nodes along the second angular direction.
        radial: Index of the radial node used for each depth level, deepest first.
        across: Indices kept along the first angular direction.
        along: Indices kept along the second angular direction.
        extent_km: Size of the copy: across, along (arc length at the surface) and depth.
    """
    ni: int
    nj: int
    nk: int
    radial: np.ndarray
    across: np.ndarray
    along: np.ndarray
    extent_km: list[float]

    def node(self, i: int, j: int, k: int) -> int:
        """Returns the number of a node in the source files, radius fastest."""
        return i + self.ni * (j + self.nj * k)


def read_attribute(das: str, key: str) -> list[float]:
    """Reads one numeric attribute from a dataset's attribute listing.

    Args:
        das: The text of the listing (the ".das" reply).
        key: The attribute, including its type where needed to tell it apart.

    Returns:
        The attribute's values.
    """
    return [float(v) for v in das.split(key, 1)[1].split(";", 1)[0].replace(",", " ").split()]


def read_mesh(base: str, mesh_file: str, step_j: int, step_k: int, nz: int) -> Mesh:
    """Reads the mesh layout and chooses the nodes to copy.

    Depth levels are uniform; each takes the radial node nearest to it.

    Args:
        base: Address of the folder holding the files, ending in "/".
        mesh_file: Name of the mesh file.
        step_j: Keep every step_j-th node along the first angular direction.
        step_k: Keep every step_k-th node along the second.
        nz: Number of depth levels.

    Returns:
        The mesh.

    Raises:
        ValueError: If radial levels differ between columns, which the unwrapped view assumes
            they do not.
    """
    with urllib.request.urlopen(base + mesh_file + ".das", timeout=60) as response:
        das = response.read().decode()
    resolution = [int(v) for v in read_attribute(das, "mesh_resolution")]
    low, high = read_attribute(das, "Float64 min"), read_attribute(das, "Float64 max")
    ni, nj, nk = resolution[0] + 1, resolution[1] + 1, resolution[2] + 1

    def radii(first_node: int) -> np.ndarray:
        column = read_array(base + mesh_file, "vertices", (first_node, first_node + ni - 1), (0, 2))
        return np.linalg.norm(column, axis=1)

    radius = radii(0)
    middle = radii(ni * (nj // 2 + nj * (nk // 2)))
    if np.abs(middle - radius).max() >= RADIAL_TOLERANCE:
        raise ValueError("radial levels differ between columns: the unwrapped view would be wrong")

    depth = (1 - radius) * EARTH_RADIUS_KM                  # km at each radial node
    levels = np.linspace(depth.max(), 0, nz)                # uniform, deepest first
    km_per_degree = math.pi * EARTH_RADIUS_KM / 180
    return Mesh(
        ni, nj, nk,
        radial=np.array([np.abs(depth - level).argmin() for level in levels]),
        across=np.arange(0, nj, step_j),
        along=np.arange(0, nk, step_k),
        extent_km=[(high[1] - low[1]) * km_per_degree, (high[2] - low[2]) * km_per_degree, float(depth.max())],
    )


def read_field(base: str, field_file: str, mesh: Mesh) -> np.ndarray:
    """Reads the field at the chosen nodes, one angular plane at a time.

    Args:
        base: Address of the folder holding the files.
        field_file: Name of the field file.
        mesh: The mesh from read_mesh().

    Returns:
        log10 of the field, indexed [depth level, along, across].
    """
    per_plane = mesh.ni * mesh.nj

    def plane(k: int) -> np.ndarray:
        first = int(k) * per_plane
        values = read_array(base + field_file, "data", (first, first + per_plane - 1), (0, 0))[:, 0]
        return values.reshape(mesh.nj, mesh.ni)[np.ix_(mesh.across, mesh.radial)]

    with ThreadPoolExecutor(N_READERS) as pool:
        planes = np.stack(list(pool.map(plane, mesh.along)))        # [along, across, depth level]
    return np.transpose(np.log10(np.maximum(planes, SMALLEST_VALUE)), (2, 0, 1))


def check(base: str, field_file: str, mesh: Mesh, stem: str) -> bool:
    """Compares voxels of the written volume with their source nodes, fetched again singly.

    Args:
        base: Address of the folder holding the files.
        field_file: Name of the field file.
        mesh: The mesh from read_mesh().
        stem: Path of the written volume, without extension.

    Returns:
        True if the volume passes the criterion in the module docstring.
    """
    stored, meta = volume_io.read_volume(stem)
    nx, ny, nz = meta["dims"]
    rng = np.random.default_rng(1)
    picks = [(int(rng.integers(nz)), int(rng.integers(ny)), int(rng.integers(nx))) for _ in range(N_CHECKED)]

    def source_value(pick: tuple[int, int, int]) -> float:
        z, y, x = pick
        node = mesh.node(int(mesh.radial[z]), int(mesh.across[x]), int(mesh.along[y]))
        return math.log10(max(read_array(base + field_file, "data", (node, node), (0, 0))[0, 0], SMALLEST_VALUE))

    with ThreadPoolExecutor(N_READERS) as pool:
        truth = np.array(list(pool.map(source_value, picks)))
    voxels = np.array([stored[pick] for pick in picks])
    different = float(np.mean(np.abs(voxels - truth) > MAX_DIFFERENCE_LOG10))
    print(f"check: {different * 100:.1f} % of {N_CHECKED} voxels differ from their source node by "
          f"> {MAX_DIFFERENCE_LOG10} log units (limit {MAX_FRACTION_DIFFERENT * 100:.0f} %)")
    return different <= MAX_FRACTION_DIFFERENT


def main() -> int:
    """Runs the script.

    Returns:
        0 if the written volume passes its check, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("base", help="dodsC address of the folder holding the files, ending in /")
    parser.add_argument("mesh", help="mesh file name")
    parser.add_argument("field", help="field file name")
    parser.add_argument("stem", help="output path without extension")
    parser.add_argument("label", help="name of the field")
    parser.add_argument("unit", help="unit of the field")
    parser.add_argument("sampling", nargs="*", type=int, default=[4, 4, 96], metavar="N", help="step_j step_k nz")
    args = parser.parse_args()
    if len(args.sampling) != 3:
        parser.error("give all of step_j step_k nz, or none")
    step_j, step_k, nz = args.sampling

    mesh = read_mesh(args.base, args.mesh, step_j, step_k, nz)
    values = read_field(args.base, args.field, mesh)
    # The range is widened to one decimal place so the header reads cleanly.
    lo = math.floor(values.min() * 10) / 10
    hi = math.ceil(values.max() * 10) / 10
    raw = volume_io.quantise(values, lo, hi)
    nx, ny = len(mesh.across), len(mesh.along)
    extent = mesh.extent_km
    volume_io.write_volume(args.stem, raw, {
        "source": args.field, "field": args.label, "units": args.unit, "log": True,
        "dims": [nx, ny, nz],
        "spacing_km": [extent[0] / (nx - 1), extent[1] / (ny - 1), extent[2] / (nz - 1)],
        "extent_km": extent,
        "axes": ["X (km)", "Y (km)", "Depth (km)"],
        "note": "Spherical cap shown unwrapped: horizontal distances are arc lengths at the surface.",
        "scale": volume_io.scale_meta(lo, hi),
        "nodata_voxels": 0,
    })
    print(f"{args.label}: dims {[nx, ny, nz]}, {raw.nbytes / 1e6:.2f} MB, log10 range {lo}..{hi}, "
          f"depth levels from {mesh.ni} radial nodes")

    passed = check(args.base, args.field, mesh, args.stem)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
