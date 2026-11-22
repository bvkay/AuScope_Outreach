"""Writes the MT site positions for the 3D viewer, in the viewer's local kilometres.

Usage (needs pyproj):
    python make_sites.py <folder of .edi files> <volume .json from make_volume.py> <out .json>

Positions come from the >HEAD LAT and LONG lines (degrees:minutes:seconds). The decimal LATITUDE
in the >INFO block is not used; NOTES.md records why.

Check:
    This test fails if fewer than 90 % of the sites fall inside the model's horizontal extent.
    The model extent comes from the model file and the sites from the EDI headers, so a wrong
    UTM zone, hemisphere, sign or swapped axis puts the sites outside and fails it.
"""
import argparse
import glob
import json
import os
import re
import sys

from pyproj import Transformer

GEOGRAPHIC = "EPSG:4326"
MODEL_CRS = "EPSG:32753"    # UTM zone 53 south, the Vulcan model's grid
HEADER_BYTES = 4000
MIN_FRACTION_INSIDE = 0.9


def dms_to_degrees(text: str) -> float:
    """Converts an angle written as degrees:minutes:seconds.

    Args:
        text: The angle, such as "-30:8:45.208". The sign applies to the whole angle.

    Returns:
        The angle in decimal degrees.
    """
    text = text.strip()
    sign = -1 if text.startswith("-") else 1
    degrees, minutes, seconds = (abs(float(part)) for part in text.lstrip("+-").split(":"))
    return sign * (degrees + minutes / 60 + seconds / 3600)


def header_value(header: str, key: str) -> str:
    """Reads one KEY = value line from an EDI header.

    Args:
        header: The start of the EDI file.
        key: Name of the entry.

    Returns:
        The value, without surrounding quotes.

    Raises:
        ValueError: If the header has no such entry.
    """
    match = re.search(r"^\s*" + key + r"\s*=\s*\"?([^\"\r\n]+)", header, re.M)
    if not match:
        raise ValueError(f"no {key} in the EDI header")
    return match.group(1)


def read_sites(edi_dir: str, origin_m: tuple[float, float]) -> list[dict]:
    """Reads every site's name and position.

    Args:
        edi_dir: Folder of .edi files.
        origin_m: Easting and northing of the model's south-west corner, in metres.

    Returns:
        One {"id", "x", "y"} entry per file, x east and y north of the corner in km.
    """
    to_model = Transformer.from_crs(GEOGRAPHIC, MODEL_CRS, always_xy=True)
    sites = []
    for path in sorted(glob.glob(os.path.join(edi_dir, "*.edi"))):
        with open(path, errors="replace") as handle:
            header = handle.read(HEADER_BYTES)
        east, north = to_model.transform(dms_to_degrees(header_value(header, "LONG")),
                                         dms_to_degrees(header_value(header, "LAT")))
        sites.append({
            "id": header_value(header, "DATAID").strip(),
            "x": round((east - origin_m[0]) / 1000, 3),
            "y": round((north - origin_m[1]) / 1000, 3),
        })
    return sites


def main() -> int:
    """Runs the script.

    Returns:
        0 if the sites pass the check, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("edi_dir", help="folder of .edi files")
    parser.add_argument("volume_json", help="volume header written by make_volume.py")
    parser.add_argument("out", help="output .json")
    args = parser.parse_args()

    with open(args.volume_json) as handle:
        meta = json.load(handle)
    x0, y0, _ = meta["origin_utm_m"]
    extent_x, extent_y, _ = meta["extent_km"]
    sites = read_sites(args.edi_dir, (x0, y0))
    if not sites:
        raise SystemExit(f"no .edi files in {args.edi_dir}")
    with open(args.out, "w") as handle:
        json.dump({"crs": "local km from model south-west corner (UTM 53S)", "sites": sites}, handle, indent=0)

    xs = [site["x"] for site in sites]
    ys = [site["y"] for site in sites]
    inside = sum(0 <= site["x"] <= extent_x and 0 <= site["y"] <= extent_y for site in sites)
    fraction = inside / len(sites)
    print(f"{len(sites)} sites, x {min(xs):.2f}..{max(xs):.2f} km, y {min(ys):.2f}..{max(ys):.2f} km; "
          f"model is {extent_x:.1f} x {extent_y:.1f} km")
    print(f"check: {fraction * 100:.0f} % of sites inside the model extent "
          f"(limit {MIN_FRACTION_INSIDE * 100:.0f} %)")
    passed = fraction >= MIN_FRACTION_INSIDE
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
