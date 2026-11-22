"""Turns a trimmed model VTK into a VTK ImageData file (.vti) on a uniform grid, for the viewer.

Usage (needs PyVista):
    python make_vti.py <model_trimmed.vtk> <out.vti> [nx ny nz]

The file holds log10 resistivity as 32-bit floats, NaN above the ground surface, with the grid's
origin and spacing in the model's own coordinates (metres). ParaView, PyVista and vtk.js read it
as it is. This is a viewing copy only: the grid is resampled, so it is not for computing.

Check, from the file read back from disk:
    This test fails if the original ground cells whose containing voxel differs by more than
    0.15 log10 units make up more than 1 % of the model's ground volume, or if the correlation
    between original and voxel values is below 0.95. A swapped or flipped axis fails it; so does
    a wrong origin, spacing or byte order.

The uniform grid cannot resolve layers thinner than a voxel, so the script also prints the share
of unresolved cells in the top 500 m. NOTES.md records why the criterion is by volume.
"""
import argparse
import os
import sys

import numpy as np
import pyvista as pv

FIELD = "log10_resistivity"
UNITS = "log10(ohm.m)"
MAX_AIR_FRACTION = 0.2
MAX_MISMATCH_LOG10 = 0.15
MAX_MISMATCH_VOLUME = 0.01
MIN_CORRELATION = 0.95
SHALLOW_M = 500


def resample(mesh: pv.DataSet, dims: tuple[int, int, int]) -> pv.ImageData:
    """Samples the model onto a uniform grid spanning its bounds.

    Each voxel takes the value of the nearest original cell, so the model's own values are kept
    and no smoothing is invented.

    Args:
        mesh: The model, with FIELD as cell data. Cells above the ground surface are NaN.
        dims: Voxels along x, y and z.

    Returns:
        The uniform grid, with FIELD as 32-bit point data (NaN above the ground).
    """
    x0, x1, y0, y1, z0, z1 = mesh.bounds
    nx, ny, nz = dims
    grid = pv.ImageData(dimensions=dims, origin=(x0, y0, z0),
                        spacing=((x1 - x0) / (nx - 1), (y1 - y0) / (ny - 1), (z1 - z0) / (nz - 1)))
    nearest = np.asarray(mesh.find_closest_cell(np.asarray(grid.points)))
    grid.point_data[FIELD] = np.asarray(mesh.cell_data[FIELD], dtype=np.float32)[nearest]
    return grid


def check(mesh: pv.DataSet, path: str) -> bool:
    """Compares the written file with the original cells.

    Args:
        mesh: The original model.
        path: The written .vti file.

    Returns:
        True if the file passes the criterion in the module docstring.
    """
    grid = pv.read(path)
    nx, ny, nz = grid.dimensions
    stored = np.asarray(grid.point_data[FIELD], dtype=np.float64).reshape(nz, ny, nx)

    original = np.asarray(mesh.cell_data[FIELD])
    ground = np.isfinite(original)
    centres = np.asarray(mesh.cell_centers().points)[ground]
    original = original[ground]
    sizes = mesh.compute_cell_sizes(length=False, area=False, volume=True)
    volume = np.abs(np.asarray(sizes.cell_data["Volume"]))[ground]

    ijk = np.rint((centres - np.array(grid.origin)) / np.array(grid.spacing)).astype(int)
    ijk = np.clip(ijk, 0, np.array(grid.dimensions) - 1)
    voxel = stored[ijk[:, 2], ijk[:, 1], ijk[:, 0]]
    has_value = np.isfinite(voxel)      # a ground cell landing on a no-value voxel counts as a miss
    miss = ~has_value | (np.abs(np.where(has_value, voxel, 0) - original) > MAX_MISMATCH_LOG10)
    mismatch = volume[miss].sum() / volume.sum()
    correlation = np.corrcoef(voxel[has_value], original[has_value])[0, 1]
    shallow = (mesh.bounds[5] - centres[:, 2]) < SHALLOW_M

    print(f"check: mismatched cells hold {mismatch * 100:.2f} % of ground volume "
          f"(limit {MAX_MISMATCH_VOLUME * 100:.0f} %), correlation {correlation:.3f} (limit {MIN_CORRELATION})")
    print(f"known limit: {miss[shallow].mean() * 100:.1f} % of cells in the top {SHALLOW_M} m "
          "are not resolved by this grid")
    return bool(mismatch <= MAX_MISMATCH_VOLUME and correlation >= MIN_CORRELATION)


def main() -> int:
    """Runs the script.

    Returns:
        0 if the written file passes its check, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", help="trimmed model VTK")
    parser.add_argument("out", help="output .vti file")
    parser.add_argument("dims", nargs="*", type=int, default=[96, 96, 128], metavar="N", help="nx ny nz")
    args = parser.parse_args()
    if len(args.dims) != 3:
        parser.error("give all of nx ny nz, or none")

    mesh = pv.read(args.source)
    grid = resample(mesh, tuple(args.dims))
    air = ~np.isfinite(grid.point_data[FIELD])
    if air.mean() >= MAX_AIR_FRACTION:
        raise SystemExit(f"more than {MAX_AIR_FRACTION:.0%} of the volume has no value: check the source")
    grid.field_data["units"] = [UNITS]
    grid.field_data["source"] = [os.path.basename(args.source)]
    grid.save(args.out)
    print(f"dims {'x'.join(map(str, args.dims))}, {os.path.getsize(args.out) / 1e6:.2f} MB, "
          f"{int(air.sum())} no-value voxels")

    passed = check(mesh, args.out)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
