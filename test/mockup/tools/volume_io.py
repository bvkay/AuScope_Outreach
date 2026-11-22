"""Shared reading and writing of the two-file viewer volumes (Underworld and ASPECT models).

A viewer volume is two files: <stem>.u16 holds unsigned 16-bit values, x fastest, then y, then z;
<stem>.json describes the grid and how the values are scaled. Raw 0 means "no value"; raw 1 to
65535 span the stored range lo to hi.
"""
import json

import numpy as np

RAW_STEPS = 65534
"""Number of steps between raw 1 and raw 65535."""

SCALE_FORMULA = "lo + (raw - 1) / 65534 * (hi - lo)"
"""How a reader turns a raw value back into a stored value; written into every header."""


def quantise(values: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Converts stored values to raw 16-bit values.

    Args:
        values: Stored values. NaN marks "no value".
        lo: Stored value written as raw 1.
        hi: Stored value written as raw 65535.

    Returns:
        Little-endian uint16 array of the same shape. NaN becomes 0; values outside lo to hi
        are placed at the nearer end.
    """
    raw = np.zeros(values.shape, dtype="<u2")
    finite = np.isfinite(values)
    clipped = np.clip(values[finite], lo, hi)
    raw[finite] = (1 + np.round((clipped - lo) / (hi - lo) * RAW_STEPS)).astype("<u2")
    return raw


def scale_meta(lo: float, hi: float, **extra: str) -> dict:
    """Builds the "scale" block of a volume header.

    Args:
        lo: Stored value written as raw 1.
        hi: Stored value written as raw 65535.
        **extra: Further notes to add to the block.

    Returns:
        The block, ready to place in the header.
    """
    return {"lo": lo, "hi": hi, "dtype": "uint16-le", "nodata": 0, "value": SCALE_FORMULA, **extra}


def write_volume(stem: str, raw: np.ndarray, meta: dict) -> None:
    """Writes a volume's two files.

    Args:
        stem: Output path without extension.
        raw: Raw values from quantise(), in file order.
        meta: The header.
    """
    raw.tofile(stem + ".u16")
    with open(stem + ".json", "w") as handle:
        json.dump(meta, handle, indent=1)


def read_volume(stem: str) -> tuple[np.ndarray, dict]:
    """Reads a volume back from its two files.

    Args:
        stem: Path without extension.

    Returns:
        The stored values as a float array indexed [z, y, x], with NaN where there is no value,
        and the header.
    """
    with open(stem + ".json") as handle:
        meta = json.load(handle)
    raw = np.fromfile(stem + ".u16", dtype="<u2").reshape(meta["dims"][::-1]).astype(float)
    lo, hi = meta["scale"]["lo"], meta["scale"]["hi"]
    return np.where(raw == 0, np.nan, (raw - 1) / RAW_STEPS * (hi - lo) + lo), meta
