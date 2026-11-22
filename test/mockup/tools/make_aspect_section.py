"""Makes small viewer sections from a 2D ASPECT run: one file per field per time step.

Usage (needs PyVista):
    python make_aspect_section.py <folder with solution-NNNNN.pvtu + pieces and solution.pvd> <out_stem> [nx nz [xmin_km xmax_km depth_km]]

The optional crop keeps x between xmin and xmax and the top depth_km of the model, measured down
from the highest point the surface reaches in any time step.

The adaptive mesh is sampled onto a uniform nx by nz grid that holds every time step. Each field
uses one value range for all time steps, so colours mean the same thing as time moves. Viewing
copy only.

Check, from the written files, for every field at the last time step:
    This test fails if the correlation between 3000 randomly chosen mesh nodes and the voxels
    that contain them is below 0.95, or if the same comparison with the section flipped
    left-right or upside-down scores higher than the unflipped one. A wrong axis order or
    orientation fails it. The share of nodes that differ by more than 5 % of the field's range
    is printed, not tested: the mesh is refined to finer than a voxel along the faults, so some
    loss there is expected.

NOTES.md records why the grid spans all time steps and not only the first.
"""
import argparse
import dataclasses
import glob
import json
import os
import re
import sys

import numpy as np
import pyvista as pv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import volume_io  # noqa: E402  (sibling module; the path line lets "python -I" find it)

SMALLEST_VALUE = 1e-300             # keeps log10 finite where a field is zero
RANGE_PERCENTILES = (0.1, 99.9)
N_CHECKED = 3000
MIN_CORRELATION = 0.95
OFF_FRACTION_OF_RANGE = 0.05


@dataclasses.dataclass(frozen=True)
class Field:
    """One field to copy.

    Attributes:
        name: Name of the array in the ASPECT files.
        label: Name shown in the viewer.
        unit: Unit shown in the viewer.
        log: Store log10 of the values.
        non_negative: Raise negative values to zero; they are numerical overshoot.
    """
    name: str
    label: str
    unit: str
    log: bool
    non_negative: bool = False

    def stored(self, values: np.ndarray) -> np.ndarray:
        """Converts values from the files to the values the viewer stores."""
        if self.non_negative:
            values = np.clip(values, 0, None)
        return np.log10(np.maximum(values, SMALLEST_VALUE)) if self.log else values


FIELDS = [
    Field("strain_rate", "Strain rate", "1/s", log=True),
    Field("viscosity", "Viscosity", "Pa s", log=True),
    Field("T", "Temperature", "K", log=False),
    Field("plastic_strain", "Plastic strain", "", log=False, non_negative=True),
]


@dataclasses.dataclass
class Grid:
    """The uniform grid the sections are sampled on.

    Attributes:
        nx: Points across.
        nz: Points up.
        box: x minimum, x maximum, height minimum, height maximum, in metres.
    """
    nx: int
    nz: int
    box: tuple[float, float, float, float]

    @property
    def width(self) -> float:
        """Width of the grid in metres."""
        return self.box[1] - self.box[0]

    @property
    def height(self) -> float:
        """Height of the grid in metres."""
        return self.box[3] - self.box[2]

    def image(self) -> pv.ImageData:
        """Returns the grid as a PyVista image, for sampling a mesh onto."""
        return pv.ImageData(dimensions=(self.nx, self.nz, 1), origin=(self.box[0], self.box[2], 0),
                            spacing=(self.width / (self.nx - 1), self.height / (self.nz - 1), 1))

    def index(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Finds the grid point nearest to each mesh point.

        Args:
            points: Mesh points, x in column 0 and height in column 1, in metres.

        Returns:
            Row (from the bottom) and column of the nearest grid point for each.
        """
        column = np.rint((points[:, 0] - self.box[0]) / self.width * (self.nx - 1)).astype(int)
        row = np.rint((points[:, 1] - self.box[2]) / self.height * (self.nz - 1)).astype(int)
        return np.clip(row, 0, self.nz - 1), np.clip(column, 0, self.nx - 1)


def read_times(folder: str) -> dict[str, float]:
    """Reads the model time of every step from solution.pvd.

    Args:
        folder: Folder holding solution.pvd.

    Returns:
        Step number (as written in the file names) to time in years.
    """
    with open(os.path.join(folder, "solution.pvd")) as handle:
        index = handle.read()
    found = re.findall(r'timestep="([^"]+)"[^>]*file="solution/solution-(\d+)\.pvtu"', index)
    return {step: float(time) for time, step in found}


def sample(mesh: pv.DataSet, grid: Grid) -> dict[str, np.ndarray]:
    """Samples every field of one time step onto the grid.

    Args:
        mesh: The time step's mesh.
        grid: The grid.

    Returns:
        Field name to values indexed [row from the bottom, column], NaN outside the mesh.
    """
    sampled = grid.image().sample(mesh)
    valid = np.asarray(sampled.point_data["vtkValidPointMask"]).astype(bool)
    sections = {}
    for field in FIELDS:
        values = np.asarray(sampled.point_data[field.name], dtype=float).copy()
        values[~valid] = np.nan
        sections[field.name] = values.reshape(grid.nz, grid.nx)
    return sections


def check(field: Field, mesh: pv.DataSet, grid: Grid, stem: str) -> bool:
    """Compares a written section with nodes of the mesh it was sampled from.

    Args:
        field: The field.
        mesh: The mesh of the same time step.
        grid: The grid.
        stem: Path of the written section, without extension.

    Returns:
        True if the section passes the criterion in the module docstring.
    """
    stored, meta = volume_io.read_volume(stem)
    section = stored[:, 0, :]
    lo, hi = meta["scale"]["lo"], meta["scale"]["hi"]
    points = np.asarray(mesh.points)
    box = grid.box
    inside = np.flatnonzero((points[:, 0] >= box[0]) & (points[:, 0] <= box[1]) &
                            (points[:, 1] >= box[2]) & (points[:, 1] <= box[3]))
    picks = np.random.default_rng(2).choice(inside, N_CHECKED, replace=False)
    truth = np.clip(field.stored(np.asarray(mesh.point_data[field.name], dtype=float)[picks]), lo, hi)
    row, column = grid.index(points[picks])

    def score(candidate: np.ndarray) -> tuple[float, float]:
        """Returns the correlation with the nodes, and the share that are far off."""
        voxels = candidate[row, column]
        known = np.isfinite(voxels)
        far_off = np.abs(voxels[known] - truth[known]) > OFF_FRACTION_OF_RANGE * (hi - lo)
        return np.corrcoef(voxels[known], truth[known])[0, 1], float(np.mean(far_off))

    correlation, far_off = score(section)
    flipped_across = score(section[:, ::-1])[0]
    flipped_up = score(section[::-1, :])[0]
    passed = bool(correlation >= MIN_CORRELATION and correlation > flipped_across and correlation > flipped_up)
    print(f"{field.label}: range {lo:.3g}..{hi:.3g}{' (log10)' if field.log else ''}; "
          f"correlation {correlation:.3f} (limit {MIN_CORRELATION}), flipped left-right {flipped_across:.3f}, "
          f"upside-down {flipped_up:.3f}; {far_off * 100:.1f} % of nodes off by > 5 % of range  ->  "
          f"{'PASS' if passed else 'FAIL'}")
    return passed


def main() -> int:
    """Runs the script.

    Returns:
        0 if every field passes its check, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", help="folder with solution-NNNNN.pvtu, their pieces and solution.pvd")
    parser.add_argument("stem", help="output path stem")
    parser.add_argument("numbers", nargs="*", type=float, metavar="N", help="nx nz [xmin_km xmax_km depth_km]")
    args = parser.parse_args()
    if len(args.numbers) not in (0, 2, 5):
        parser.error("give nx nz, or nx nz xmin_km xmax_km depth_km, or neither")
    nx, nz = (int(v) for v in args.numbers[:2]) if args.numbers else (800, 200)
    crop = args.numbers[2:5] or None

    times = read_times(args.source)
    steps = sorted(re.search(r"solution-(\d+)\.pvtu", path).group(1)
                   for path in glob.glob(os.path.join(args.source, "solution-*.pvtu")))
    if not steps:
        raise SystemExit(f"no solution-*.pvtu files in {args.source}")
    meshes = {step: pv.read(os.path.join(args.source, f"solution-{step}.pvtu")) for step in steps}

    # The grid must hold every time step: the surface rises as the model evolves.
    bounds = np.array([mesh.bounds[:4] for mesh in meshes.values()])
    box = (bounds[:, 0].min(), bounds[:, 1].max(), bounds[:, 2].min(), bounds[:, 3].max())
    if crop:
        box = (crop[0] * 1000, crop[1] * 1000, box[3] - crop[2] * 1000, box[3])
    grid = Grid(nx, nz, box)

    sections = {}
    for step in steps:
        for name, values in sample(meshes[step], grid).items():
            sections[(name, step)] = values
        outside = np.isnan(sections[(FIELDS[0].name, step)]).mean()
        print("sampled step", step, f"t = {times[step] / 1e6:.2f} Myr", f"{outside * 100:.1f} % outside the mesh")

    passed = True
    for field in FIELDS:
        every_step = np.concatenate([sections[(field.name, step)].ravel() for step in steps])
        every_step = field.stored(every_step[np.isfinite(every_step)])
        lo = float(np.percentile(every_step, RANGE_PERCENTILES[0]))
        hi = float(np.percentile(every_step, RANGE_PERCENTILES[1]))
        for step in steps:
            values = field.stored(sections[(field.name, step)])
            volume_io.write_volume(f"{args.stem}-{field.name}-{step}", volume_io.quantise(values, lo, hi), {
                "source": f"solution-{step}.pvtu", "field": field.label, "units": field.unit, "log": field.log,
                "time_yr": times[step],
                "dims": [nx, 1, nz],
                "spacing_km": [grid.width / (nx - 1) / 1000, 1, grid.height / (nz - 1) / 1000],
                "extent_km": [grid.width / 1000, 0, grid.height / 1000],
                "axes": ["Distance (km)", "", "Depth (km)"],
                "x_origin_km": box[0] / 1000, "crop": "central part of the model" if crop else "whole model",
                "scale": volume_io.scale_meta(lo, hi, clipped=(
                    "values outside the 0.1 to 99.9 percentile range of all time steps are shown at the ends "
                    "of the scale")),
                "nodata_voxels": int((~np.isfinite(values)).sum()),
            })
        last = steps[-1]
        passed &= check(field, meshes[last], grid, f"{args.stem}-{field.name}-{last}")

    with open(f"{args.stem}-times.json", "w") as handle:
        json.dump([{"id": step, "label": f"{times[step] / 1e6:.1f} Myr"} for step in steps], handle)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
