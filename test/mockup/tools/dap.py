"""Reads part of a remote array over OPeNDAP (DAP2), using the standard library and NumPy only.

Only the requested rows cross the network, which is how the viewer copies are made from NCI files
that are hundreds of megabytes each.

Example:
    rows = read_array("https://host/thredds/dodsC/path/file.h5", "data", (0, 99), (0, 0))
"""
import urllib.error
import urllib.request

import numpy as np

# DAP2 sends every value big-endian, and 16-bit integers in 32 bits.
_WIRE_TYPE = {"Float64": ">f8", "Float32": ">f4", "Int32": ">i4", "Int16": ">i4", "UInt32": ">u4"}
_TIMEOUT_S = 120


def read_array(base: str, variable: str, *ranges: tuple[int, int], tries: int = 4) -> np.ndarray:
    """Reads a block of one variable.

    Args:
        base: Address of the dataset, without the ".dods" suffix.
        variable: Name of the array in the dataset.
        *ranges: One (first, last) pair per dimension. Both ends are included, as in OPeNDAP.
        tries: How many times to ask before giving up.

    Returns:
        The block, in native byte order, shaped by the ranges.

    Raises:
        RuntimeError: If the block could not be read after the given number of tries.
    """
    query = variable + "".join(f"[{first}:1:{last}]" for first, last in ranges)
    url = f"{base}.dods?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    error = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
                payload = response.read()
            # The reply is a text description, a "Data:" line, then the binary block: the
            # element count twice (4 bytes each), then the values.
            header, body = payload.split(b"\nData:\n", 1)
            kind = header.decode("ascii", "replace").split("{", 1)[1].split()[0]
            count = int(np.frombuffer(body[:4], ">u4")[0])
            values = np.frombuffer(body[8:], _WIRE_TYPE[kind], count=count)
            shape = [last - first + 1 for first, last in ranges]
            return values.reshape(shape).astype(values.dtype.newbyteorder("="))
        except (OSError, ValueError, KeyError, IndexError) as caught:
            error = caught      # a dropped connection or a cut-off reply: ask again
    raise RuntimeError(f"could not read {url}: {error}")
