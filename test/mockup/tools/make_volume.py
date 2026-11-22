"""Turns a trimmed model VTK into a small uniform volume a browser can load.

Usage (needs PyVista):
    python make_volume.py <model_trimmed.vtk> <out_stem> [nx ny nz]

Writes <out_stem>.u16 and <out_stem>.json (see volume_io.py). Values are log10 resistivity. This
is a viewing copy only: the grid is resampled, so it is not for computing.

Check, run from the files on disk after writing:
    This test fails if the original ground cells whose containing voxel differs by more than
    0.15 log10 units make up more than 1 % of the model's ground volume, or if the correlation
    between original and voxel values is below 0.95. A swapped or flipped axis fails it; so does
    a wrong scale or byte order.

The uniform grid cannot resolve layers thinner than a voxel, so the script also prints the share
of unresolved cells in the top 500 m. NOTES.md records why the criterion is by volume.
"""
import argparse
import math
import os
import sys

import numpy as np
import pyvista as pv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import volume_io  # noqa: E402  (sibling module; the path line lets "python -I" find it)

FIELD = "log10_resistivity"
MAX_AIR_FRACTION = 0.2
MAX_MISMATCH_LOG10 = 0.15
MAX_MISMATCH_VOLUME = 0.01
MIN_CORRELATION = 0.95
SHALLOW_M = 500


def resample(mesh: pv.DataSet, dims: tuple[int, int, int]) -> tuple[np.ndarray, pv.ImageData]:
    """Samples the model onto a uniform grid spanning its bounds.

    Each voxel takes the value of the nearest original cell, so the model's own values are kept
    and no smoothing is invented.

    Args:
        mesh: The model, with FIELD as cell data. Cells above the ground surface are NaN.
        dims: Voxels along x, y and z.

    Returns:
        The value at every voxel, in file order (NaN above the ground), and the uniform grid.
    """
    x0, x1, y0, y1, z0, z1 = mesh.bounds
    nx, ny, nz = dims
    grid = pv.ImageData(dimensions=dims, origin=(x0, y0, z0),
                        spacing=((x1 - x0) / (nx - 1), (y1 - y0) / (ny - 1), (z1 - z0) / (nz - 1)))
    nearest = np.asarray(mesh.find_closest_cell(np.asarray(grid.points)))
    return np.asarray(mesh.cell_data[FIELD], dtype=np.float64)[nearest], grid


def check(mesh: pv.DataSet, stem: str) -> bool:
    """Compares the written volume with the original cells.

    Args:
        mesh: The original model.
        stem: Path of the written volume, without extension.

    Returns:
        True if the volume passes the criterion in the module docstring.
    """
    stored, meta = volume_io.read_volume(stem)
    original = np.asarray(mesh.cell_data[FIELD])
    ground = np.isfinite(original)
    centres = np.asarray(mesh.cell_centers().points)[ground]
    original = original[ground]
    sizes = mesh.compute_cell_sizes(length=False, area=False, volume=True)
    volume = np.abs(np.asarray(sizes.cell_data["Volume"]))[ground]

    origin = np.array(meta["origin_utm_m"])
    spacing = np.array(meta["spacing_km"]) * 1000
    ijk = np.clip(np.rint((centres - origin) / spacing).astype(int), 0, np.array(meta["dims"]) - 1)
    voxel = stored[ijk[:, 2], ijk[:, 1], ijk[:, 0]]
    has_value = np.isfinite(voxel)      # a ground cell landing on a no-value voxel counts as a miss
    miss = ~has_value | (np.abs(np.where(has_value, voxel, 0) - original) > MAX_MISMATCH_LOG10)
    mismatch = volume[miss].sum() / volume.sum()
    correlation = np.corrcoef(voxel[has_value], original[has_value])[0, 1]
    shallow = (meta["top_elevation_m"] - centres[:, 2]) < SHALLOW_M

    print(f"check: mismatched cells hold {mismatch * 100:.2f} % of ground volume "
          f"(limit {MAX_MISMATCH_VOLUME * 100:.0f} %), correlation {correlation:.3f} (limit {MIN_CORRELATION})")
    print(f"known limit: {miss[shallow].mean() * 100:.1f} % of cells in the top {SHALLOW_M} m "
          "are not resolved by this grid")
    return bool(mismatch <= MAX_MISMATCH_VOLUME and correlation >= MIN_CORRELATION)


def main() -> int:
    """Runs the script.

    Returns:
        0 if the written volume passes its check, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", help="trimmed model VTK")
    parser.add_argument("stem", help="output path without extension")
    parser.add_argument("dims", nargs="*", type=int, default=[96, 96, 128], metavar="N", help="nx ny nz")
    args = parser.parse_args()
    if len(args.dims) != 3:
        parser.error("give all of nx ny nz, or none")
    nx, ny, nz = args.dims

    mesh = pv.read(args.source)
    values, grid = resample(mesh, (nx, ny, nz))
    air = ~np.isfinite(values)
    if air.mean() >= MAX_AIR_FRACTION:
        raise SystemExit(f"more than {MAX_AIR_FRACTION:.0%} of the volume has no value: check the source")
    # The range is widened to one decimal place so the header reads cleanly.
    lo = math.floor(values[~air].min() * 10) / 10
    hi = math.ceil(values[~air].max() * 10) / 10
    raw = volume_io.quantise(values, lo, hi)

    x0, x1, y0, y1, z0, z1 = mesh.bounds
    volume_io.write_volume(args.stem, raw, {
        "source": args.source.replace("\\", "/").split("/")[-1],
        "field": FIELD, "units": "log10(ohm.m)",
        "dims": [nx, ny, nz],
        "spacing_km": [grid.spacing[0] / 1000, grid.spacing[1] / 1000, grid.spacing[2] / 1000],
        "extent_km": [(x1 - x0) / 1000, (y1 - y0) / 1000, (z1 - z0) / 1000],
        "origin_utm_m": [x0, y0, z0], "top_elevation_m": z1,
        "scale": volume_io.scale_meta(lo, hi),
        "nodata_voxels": int(air.sum()),
    })
    print(f"dims {nx}x{ny}x{nz}, {raw.nbytes / 1e6:.2f} MB, log10 range {lo}..{hi}, "
          f"{int(air.sum())} no-value voxels")

    passed = check(mesh, args.stem)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
