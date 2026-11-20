"""Copy the full record of each viewer-pilot model from the live site into volumes/records.json.

Usage:  python fetch_records.py <out.json> [<Vulcan Level 3 README.txt>]

Vulcan is not on the live site (the Kay-2024-Vulcan repository was gone on 20 Nov 2026), so its
record is read from the Level 3 package README: the text between the lines of "=" signs, one
section per heading.

The live model page has four tabs (Snapshot, Science Overview, Model & Software, Metadata) plus a
block of DOIs and creators. Each is kept as cleaned HTML: scripts, inline styles and event
attributes are removed, and site-relative image addresses are made absolute. Mockup only; the real
site would render these from the model's metadata, as it does today.
"""
import json
import re
import sys
import urllib.request

SCENES = {"sunda": "gollapalli-2025-sundamegathrust", "detachment": "sandiford-2021-detachment"}
SITE = "https://mate.science/"


def clean(html):
    html = re.sub(r"<script.*?</script>", "", html, flags=re.S)
    html = re.sub(r'\s(?:style|onclick|onerror|class|id|autoplay)="[^"]*"', "", html)
    html = re.sub(r"\s(?:style|onclick|onerror)='[^']*'", "", html)
    html = re.sub(r'(src|href)="(?!https?:|#|mailto:)/?([^"]+)"', lambda m: f'{m.group(1)}="{SITE}{m.group(2)}"', html)
    html = re.sub(r"<video([^>]*)>", r'<video controls muted loop playsinline preload="metadata">', html)
    return re.sub(r"\s+", " ", html).strip()


def panel(page, name):
    m = re.search(r'<div id="tab-' + name + r'" class="tab-panel[^"]*">(.*?)</div>\s*(?=<div id="tab-|</div>\s*</div>\s*</main>)', page, re.S)
    return clean(m.group(1)) if m else ""


out = {}
for scene, slug in SCENES.items():
    page = urllib.request.urlopen(urllib.request.Request(SITE + "models/" + slug, headers={"User-Agent": "curl/8"}), timeout=40).read().decode("utf8")
    head = re.search(r'<div class="model-meta-block">(.*?)</div>\s*<div class="tab-container">', page, re.S).group(1)
    dois = [{"label": a, "doi": b} for a, b in re.findall(r'badge-doi-left">([^<]+)</span><span class="badge-doi-right">([^<]+)<', head)]
    meta = panel(page, "meta")
    cite = re.search(r"<blockquote[^>]*>(.*?)</blockquote>", meta, re.S)
    model = panel(page, "model")
    data = re.search(r'href="(https?://[^"]*(?:thredds|nci\.org)[^"]*)"', model)
    out[scene] = {
        "slug": slug,
        "title": re.sub(r"<[^>]+>", "", re.search(r'<h1 class="title">(.*?)</h1>', page, re.S).group(1)).strip(),
        "creators": re.findall(r"badge-creator'[^>]*>([^<]+)<", head),
        "dois": dois,
        "tags": re.findall(r"badge-tag'[^>]*>([^<]+)<", panel(page, "overview")),
        "snapshot": panel(page, "snapshot"),
        "overview": panel(page, "overview"),
        "model": model,
        "meta": meta,
        "citation": re.sub(r"<[^>]+>", "", cite.group(1)).strip() if cite else "",
        "data_url": data.group(1) if data else "",
        "repo": "https://github.com/ModelAtlasofTheEarth/" + slug,
    }
    r = out[scene]
    print(scene, "|", r["title"][:50], "| creators", len(r["creators"]), "| dois", [d["label"] for d in dois],
          "| chars", {k: len(r[k]) for k in ("snapshot", "overview", "model", "meta")}, "| cite", bool(r["citation"]), "| data", bool(r["data_url"]))

if len(sys.argv) > 2:
    import html
    txt = open(sys.argv[2], encoding="utf8", errors="replace").read()
    parts = re.split(r"\n=+\n", txt)
    sec = {p.strip().splitlines()[0].strip(): "\n".join(p.strip().splitlines()[1:]).strip() for p in parts[1:] if p.strip()}
    link = lambda t: re.sub(r"(https?://[^\s<]+)", r'<a href="\1">\1</a>', html.escape(t))
    paras = lambda t: "".join("<p>" + link(" ".join(x.split())) + "</p>" for x in re.split(r"\n\s*\n", t) if x.strip())
    pre = lambda t: '<pre class="rec">' + link(t) + "</pre>"
    cite = " ".join(sec["CITATION"].split("Paper:")[0].replace("Model:", "").split())
    out = {"vulcan": {
        "slug": "Vulcan-2022 Level 3 Model 1",
        "title": "Vulcan 2022 magnetotelluric survey, South Australia: smooth 3-D electrical resistivity model",
        "creators": ["Ben Kay", "Graham Heinson", "Goran Boren", "Ying Liu"],
        "dois": [{"label": "NCI DOI", "doi": "10.25914/arwp-q219"}, {"label": "Pub. DOI", "doi": "10.1080/08123985.2024.2378132"}],
        "tags": ["magnetotellurics", "electrical resistivity", "IOCG"],
        "snapshot": paras(sec["ABSTRACT"].split("\n\n")[0]),
        "overview": "<h2>Abstract</h2>" + paras(sec["ABSTRACT"]) + "<h2>Known limits</h2>" + pre(sec["KNOWN LIMITS"]),
        "model": "<h2>Model and inversion</h2>" + pre(sec["MODEL AND INVERSION"]) + "<h2>Contents of the package</h2>" + pre(sec["CONTENTS"]),
        "meta": "<h2>Lineage</h2>" + pre(sec["LINEAGE"]) + "<h2>Citation</h2>" + pre(sec["CITATION"]) + "<h2>Licence</h2>" + paras(sec["LICENCE"]) + "<h2>Acknowledgements</h2>" + paras(sec["ACKNOWLEDGEMENTS"]),
        "citation": cite, "data_url": "https://doi.org/10.25914/arwp-q219", "repo": "",
    }, **out}
    print("vulcan | from README |", list(sec))

json.dump(out, open(sys.argv[1], "w", encoding="utf8"), indent=1, ensure_ascii=False)
