"""Writes the model-fit file for the viewer from a Geotools (RLM-3D) inversion package.

Usage (plain Python, no extra packages):
    python make_fit.py <package folder> <sites .json from make_sites.py> <out .json>

Reads, from the Level 3 package layout:
    inputs/EDI_used/<site>_ObsUsed.edi             observed Z with the floored variances the run used
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
pairing of sites, a wrong variance convention, a period-order flip or a mixed-up component fails
them.
    1. This test fails if any site's RMS recomputed from the EDIs differs from the code's table
       by more than 0.02 (the table is rounded to 0.01).
    2. This test fails if any site-and-period RMS recomputed from the EDIs differs from the code's
       table by more than 0.02 or 1 %.
    3. This test fails if the overall RMS recomputed from every datum differs from the final nRMS
       in the iteration log by more than 0.005.
    4. This test fails if sqrt((Zxy^2 + Zyx^2) / 2) of the per-component RMS worked out here
       differs from the code's off-diagonal column by more than 0.02 at any site (same for the
       diagonal).
    5. This test fails if any site in the fit has no position in the sites file, or if two sites
       share a name. Names are compared with repeated underscores collapsed; NOTES.md records why.
"""
import argparse
import dataclasses
import glob
import json
import math
import os
import re
import sys

COMPONENTS = ["zxx", "zxy", "zyx", "zyy"]
RMS_TOLERANCE = 0.02
OVERALL_TOLERANCE = 0.005
FREQUENCY_TOLERANCE = 2e-3


@dataclasses.dataclass
class CodeTables:
    """What the inversion code reports about its own fit.

    Attributes:
        per_site: Site file name to the columns of the RMS table (TOTAL, Zxy+Zyx, Zxx+Zyy, ncZ ...).
        per_site_period: Site file name to RMS at each frequency.
        freqs: Frequencies of the per-period table, in Hz.
        nrms_by_iteration: Normalised RMS after each iteration, starting model first.
        floors: Error floor per impedance component, in percent.
        version: Version of the inversion code.
    """
    per_site: dict[str, dict[str, float]]
    per_site_period: dict[str, list[float]]
    freqs: list[float]
    nrms_by_iteration: list[float]
    floors: dict[str, float]
    version: str


@dataclasses.dataclass
class SiteMisfit:
    """Misfit of one site, recomputed from its observed and predicted EDIs.

    Attributes:
        by_component: RMS per impedance component.
        by_period: RMS at each frequency; None where the site has no data.
        total: RMS over all data.
        sum_squares: Sum of squared, variance-normalised residuals.
        count: Number of real and imaginary parts that went into the sum.
    """
    by_component: dict[str, float]
    by_period: list[float | None]
    total: float
    sum_squares: float
    count: int


def find_one(package: str, pattern: str, skip: tuple[str, ...] = ()) -> str:
    """Finds the single file in the package that matches a pattern.

    Args:
        package: The package folder.
        pattern: Glob pattern relative to the package.
        skip: Files whose name contains any of these are ignored.

    Returns:
        The path of the file.

    Raises:
        FileNotFoundError: If no file, or more than one, matches.
    """
    hits = [path for path in glob.glob(os.path.join(package, pattern))
            if not any(part in os.path.basename(path) for part in skip)]
    if len(hits) != 1:
        raise FileNotFoundError(f"expected one file for {pattern}, found {hits}")
    return hits[0]


def read_table(path: str) -> list[list[str]]:
    """Reads a tab-separated text file.

    Args:
        path: The file.

    Returns:
        One list of cells per line.
    """
    with open(path) as handle:
        return [line.rstrip("\n").split("\t") for line in handle]


def read_code_tables(package: str) -> CodeTables:
    """Reads the fit tables and settings the inversion code wrote.

    Args:
        package: The package folder.

    Returns:
        The tables.
    """
    rows = read_table(find_one(package, "outputs/misfit/*_MT_tab.rms"))
    columns = [name.strip() for name in rows[0]]
    per_site = {row[0].strip(): dict(zip(columns[1:], (float(v) for v in row[1:])))
                for row in rows[1:] if row[0].strip()}

    rows = read_table(find_one(package, "outputs/misfit/*_MT_tab.Zrms"))
    freqs = [float(v) for v in rows[0][1:] if re.match(r"\s*[\d.]+E", v)]
    per_site_period = {row[0].strip(): [float(v) for v in row[1:1 + len(freqs)]]
                       for row in rows[1:] if row[0].strip()}

    rows = read_table(find_one(package, "outputs/misfit/*_tab.log"))
    nrms = [float(row[3]) for row in rows[1:] if len(row) > 3]

    with open(find_one(package, "outputs/misfit/*.log", skip=("_tab",))) as handle:
        log = handle.read()
    floors = {c: float(re.search(c.capitalize() + r" percentage error floor:\s*([\d.]+)", log).group(1))
              for c in COMPONENTS}
    version = re.search(r"Version:\s*(\S+)", log).group(1)
    return CodeTables(per_site, per_site_period, freqs, nrms, floors, version)


def read_edi(path: str) -> tuple[str, dict[str, list[float | None]]]:
    """Reads the data blocks of an EDI file.

    Args:
        path: The EDI file.

    Returns:
        The DATAID, and each ">NAME // N" block as a list of numbers with None for empty values.

    Raises:
        ValueError: If a block does not hold the number of values its header gives.
    """
    with open(path, errors="replace") as handle:
        text = handle.read()
    data_id = re.search(r'DATAID\s*=\s*"?([^"\r\n]+)', text).group(1).strip()
    empty = float(re.search(r"EMPTY\s*=\s*(\S+)", text).group(1))
    blocks = {}
    for match in re.finditer(r"^>([A-Z.]+)[^\n]*//\s*(\d+)\s*\n([^>]*)", text, re.M):
        name, count = match.group(1), int(match.group(2))
        values = [float(v) for v in match.group(3).split()]
        if len(values) != count:
            raise ValueError(f"{path}: {name} has {len(values)} values, header says {count}")
        blocks[name] = [None if abs(v) >= empty * 0.99 else v for v in values]
    return data_id, blocks


def site_misfit(observed: dict, predicted: dict) -> SiteMisfit:
    """Recomputes one site's misfit from its EDI blocks.

    Args:
        observed: Blocks of the observed EDI, including the variances the run used.
        predicted: Blocks of the predicted EDI.

    Returns:
        The misfit by component, by period and in total.
    """
    n_freqs = len(observed["FREQ"])
    squares = {c: 0.0 for c in COMPONENTS}
    counts = {c: 0 for c in COMPONENTS}
    squares_by_period = [0.0] * n_freqs
    counts_by_period = [0] * n_freqs
    for c in COMPONENTS:
        key = c.upper()
        for k in range(n_freqs):
            obs_re, obs_im, variance = observed[key + "R"][k], observed[key + "I"][k], observed[key + ".VAR"][k]
            prd_re, prd_im = predicted[key + "R"][k], predicted[key + "I"][k]
            if None in (obs_re, obs_im, variance, prd_re, prd_im) or variance <= 0:
                continue
            residual = ((obs_re - prd_re) ** 2 + (obs_im - prd_im) ** 2) / variance
            squares[c] += residual
            counts[c] += 2          # the real and the imaginary part each count as one datum
            squares_by_period[k] += residual
            counts_by_period[k] += 2
    sum_squares, count = sum(squares.values()), sum(counts.values())
    return SiteMisfit(
        by_component={c: math.sqrt(squares[c] / counts[c]) for c in COMPONENTS},
        by_period=[math.sqrt(s / n) if n else None for s, n in zip(squares_by_period, counts_by_period)],
        total=math.sqrt(sum_squares / count),
        sum_squares=sum_squares,
        count=count,
    )


def significant(value: float | None, digits: int = 5) -> float | None:
    """Rounds to a number of significant figures, to keep the output file small.

    Args:
        value: The number, or None.
        digits: Significant figures to keep.

    Returns:
        The rounded number, or None.
    """
    return None if value is None else float(f"{value:.{digits}g}")


def collapse_underscores(name: str) -> str:
    """Returns a site name with repeated underscores reduced to one."""
    return re.sub(r"_+", "_", name)


def main() -> int:
    """Runs the script.

    Returns:
        0 if the fit file passes all five checks, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("package", help="Level 3 package folder")
    parser.add_argument("sites_json", help="site positions written by make_sites.py")
    parser.add_argument("out", help="output .json")
    args = parser.parse_args()

    tables = read_code_tables(args.package)
    with open(args.sites_json) as handle:
        position_id = {collapse_underscores(site["id"]): site["id"] for site in json.load(handle)["sites"]}

    sites = {}
    unplaced = []
    freqs = None
    rotation = None
    all_squares, all_count = 0.0, 0
    worst_site = worst_period = worst_pair = 0.0

    for name in sorted(tables.per_site):
        data_id, observed = read_edi(os.path.join(args.package, "inputs", "EDI_used", name + "_ObsUsed.edi"))
        predicted_id, predicted = read_edi(
            os.path.join(args.package, "outputs", "responses", "EDI_predicted", name + "_prd.edi"))
        if data_id != predicted_id:
            raise ValueError(f"{name}: observed DATAID {data_id} but predicted {predicted_id}")
        if observed["FREQ"] != predicted["FREQ"]:
            raise ValueError(f"{name}: observed and predicted frequencies differ")
        if observed["ZROT"] != predicted["ZROT"]:
            raise ValueError(f"{name}: observed and predicted rotations differ")
        if freqs is None:
            freqs = observed["FREQ"]
            rotation = observed["ZROT"][0]
            if not all(abs(a - b) / b < FREQUENCY_TOLERANCE for a, b in zip(freqs, tables.freqs)):
                raise ValueError("EDI and Zrms table frequencies differ")
        if observed["FREQ"] != freqs:
            raise ValueError(f"{name}: frequencies differ from the first site")

        key = collapse_underscores(data_id)
        if key not in position_id or position_id[key] in sites:
            unplaced.append(data_id)
        site_id = position_id.get(key, data_id)         # the name the sites file uses

        misfit = site_misfit(observed, predicted)
        all_squares += misfit.sum_squares
        all_count += misfit.count
        reported = tables.per_site[name]
        mine = misfit.by_component
        worst_site = max(worst_site, abs(misfit.total - reported["TOTAL"]))
        for a, b in zip(misfit.by_period, tables.per_site_period[name]):
            worst_period = max(worst_period, min(abs(a - b), abs(a - b) / b * 2))   # 0.02 or 1 %, whichever is looser
        worst_pair = max(
            worst_pair,
            abs(math.sqrt((mine["zxy"] ** 2 + mine["zyx"] ** 2) / 2) - reported["Zxy+Zyx"]),
            abs(math.sqrt((mine["zxx"] ** 2 + mine["zyy"] ** 2) / 2) - reported["Zxx+Zyy"]))

        sites[site_id] = {
            "file": name, "label": site_id.split("_")[0],
            "rms": {"total": reported["TOTAL"], "offdiag": reported["Zxy+Zyx"], "diag": reported["Zxx+Zyy"],
                    **{c: round(mine[c], 2) for c in COMPONENTS}},
            "n": int(reported["ncZ"]),
            "by_period": tables.per_site_period[name],
            "obs": {c: {"re": [significant(v) for v in observed[c.upper() + "R"]],
                        "im": [significant(v) for v in observed[c.upper() + "I"]],
                        "var": [significant(v, 4) for v in observed[c.upper() + ".VAR"]]} for c in COMPONENTS},
            "prd": {c: {"re": [significant(v) for v in predicted[c.upper() + "R"]],
                        "im": [significant(v) for v in predicted[c.upper() + "I"]]} for c in COMPONENTS},
        }

    if not sites:
        raise SystemExit("the RMS table lists no sites")
    nrms = tables.nrms_by_iteration
    overall = math.sqrt(all_squares / all_count)
    fit = {
        "code": "RLM-3D " + tables.version + " (Geotools)",
        "inverted": "complex impedance Z",
        "units": "Z in mV/km/nT (EDI field units); apparent resistivity = 0.2 / f * |Z|^2",
        "rms_definition": "sqrt(mean over real and imaginary parts of (observed - predicted)^2 / variance)",
        "error_floors_percent": tables.floors,
        "errors": "observed errors plus error floors",
        "nrms_final": nrms[-1], "iterations": len(nrms) - 1, "nrms_by_iteration": nrms,
        "n_sites": len(sites), "n_data": all_count,
        "freqs_hz": freqs, "rotation_deg": rotation,
        "component_rms_source": "zxx, zxy, zyx, zyy worked out from the EDIs by make_fit.py; total, offdiag, "
                                "diag and by_period are the inversion code's own tables",
        "sites": sites,
    }
    with open(args.out, "w") as handle:
        json.dump(fit, handle, separators=(",", ":"))
    print(f"{len(sites)} sites, {len(freqs)} frequencies, {all_count} data; "
          f"file {os.path.getsize(args.out) / 1024:.0f} kB")

    checks = [
        ("1 per-site RMS, EDIs vs code table: worst difference", worst_site, RMS_TOLERANCE),
        ("2 per-site-and-period RMS, EDIs vs code table: worst difference (0.02 or 1 %)", worst_period, RMS_TOLERANCE),
        (f"3 overall RMS from every datum {overall:.4f} vs log {nrms[-1]:.4f}: difference",
         abs(overall - nrms[-1]), OVERALL_TOLERANCE),
        ("4 component pairs vs code's diagonal / off-diagonal columns: worst difference", worst_pair, RMS_TOLERANCE),
        (f"5 sites without a position: {unplaced or 'none'}", len(unplaced), 0.5),
    ]
    passed = True
    for label, value, limit in checks:
        good = value <= limit
        passed = passed and good
        print(f"check {label} = {value:.4f} (limit {limit}) {'PASS' if good else 'FAIL'}")
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
