"""Read part of a remote array over OPeNDAP (DAP2) with nothing but the standard library + numpy.

    get(url_without_suffix, "data", (start, stop), (0, 0)) -> numpy array

Ranges are inclusive, as in OPeNDAP. Only the requested rows cross the network, which is how the
viewer copies are made from NCI files that are hundreds of megabytes each.
"""
import urllib.request

import numpy as np

DT = {"Float64": ">f8", "Float32": ">f4", "Int32": ">i4", "Int16": ">i4", "UInt32": ">u4"}


def get(base, var, *ranges, tries=4):
    q = var + "".join(f"[{a}:1:{b}]" for a, b in ranges)
    url = base + ".dods?" + q
    err = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8"}), timeout=120) as r:
                raw = r.read()
            head, body = raw.split(b"\nData:\n", 1)
            kind = head.decode("ascii", "replace").split("{", 1)[1].split()[0]
            n = int(np.frombuffer(body[:4], ">u4")[0])
            a = np.frombuffer(body[8:], DT[kind], count=n)
            return a.reshape([b - s + 1 for s, b in ranges]).astype(a.dtype.newbyteorder("="))
        except Exception as e:      # network hiccup: try again
            err = e
    raise RuntimeError(f"could not read {url}: {err}")
