"""Copies the full record of each viewer-pilot model into volumes/records.json.

Usage:
    python fetch_records.py <out.json> [<Vulcan Level 3 README.txt>]

Sunda and Detachment are read from their pages on the live site. A model page has four tabs
(Snapshot, Science Overview, Model & Software, Metadata) plus a block of DOIs and creators. Each
tab is kept as cleaned HTML: scripts, inline styles and event attributes are removed, and
site-relative addresses are made absolute.

Vulcan is not on the live site, so its record is read from the Level 3 package README: the text
between the lines of "=" signs, one section per heading.

Mockup only. The real site renders these from each model's metadata, as it does today.
"""
import argparse
import html
import json
import re
import sys
import urllib.request

SITE = "https://mate.science/"
REPOSITORIES = "https://github.com/ModelAtlasofTheEarth/"
SCENES = {"sunda": "gollapalli-2025-sundamegathrust", "detachment": "sandiford-2021-detachment"}
TIMEOUT_S = 40


def clean(markup: str) -> str:
    """Strips a piece of the live page down to plain, self-contained HTML.

    Args:
        markup: HTML from the live page.

    Returns:
        The HTML without scripts, styling or event attributes, with absolute addresses and
        collapsed white space.
    """
    markup = re.sub(r"<script.*?</script>", "", markup, flags=re.S)
    markup = re.sub(r'\s(?:style|onclick|onerror|class|id|autoplay)="[^"]*"', "", markup)
    markup = re.sub(r"\s(?:style|onclick|onerror)='[^']*'", "", markup)
    markup = re.sub(r'(src|href)="(?!https?:|#|mailto:)/?([^"]+)"',
                    lambda match: f'{match.group(1)}="{SITE}{match.group(2)}"', markup)
    markup = re.sub(r"<video([^>]*)>", r'<video controls muted loop playsinline preload="metadata">', markup)
    return re.sub(r"\s+", " ", markup).strip()


def tab(page: str, name: str) -> str:
    """Extracts one tab of a model page.

    Args:
        page: The whole page.
        name: The tab's id suffix: "snapshot", "overview", "model" or "meta".

    Returns:
        The tab's content as cleaned HTML, or an empty string if the page has no such tab.
    """
    match = re.search(
        r'<div id="tab-' + name + r'" class="tab-panel[^"]*">(.*?)</div>\s*(?=<div id="tab-|</div>\s*</div>\s*</main>)',
        page, re.S)
    return clean(match.group(1)) if match else ""


def strip_tags(markup: str) -> str:
    """Returns the text of a piece of HTML."""
    return re.sub(r"<[^>]+>", "", markup).strip()


def live_record(slug: str) -> dict:
    """Reads one model's record from the live site.

    Args:
        slug: The model's repository name.

    Returns:
        The record.
    """
    request = urllib.request.Request(SITE + "models/" + slug, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        page = response.read().decode("utf8")
    header = re.search(r'<div class="model-meta-block">(.*?)</div>\s*<div class="tab-container">', page, re.S).group(1)
    dois = re.findall(r'badge-doi-left">([^<]+)</span><span class="badge-doi-right">([^<]+)<', header)
    overview, model, meta = tab(page, "overview"), tab(page, "model"), tab(page, "meta")
    citation = re.search(r"<blockquote[^>]*>(.*?)</blockquote>", meta, re.S)
    data_link = re.search(r'href="(https?://[^"]*(?:thredds|nci\.org)[^"]*)"', model)
    return {
        "slug": slug,
        "title": strip_tags(re.search(r'<h1 class="title">(.*?)</h1>', page, re.S).group(1)),
        "creators": re.findall(r"badge-creator'[^>]*>([^<]+)<", header),
        "dois": [{"label": label, "doi": doi} for label, doi in dois],
        "tags": re.findall(r"badge-tag'[^>]*>([^<]+)<", overview),
        "snapshot": tab(page, "snapshot"),
        "overview": overview,
        "model": model,
        "meta": meta,
        "citation": strip_tags(citation.group(1)) if citation else "",
        "data_url": data_link.group(1) if data_link else "",
        "repo": REPOSITORIES + slug,
    }


def linked(text: str) -> str:
    """Escapes text for HTML and turns web addresses in it into links."""
    return re.sub(r"(https?://[^\s<]+)", r'<a href="\1">\1</a>', html.escape(text))


def paragraphs(text: str) -> str:
    """Turns text with blank-line breaks into HTML paragraphs."""
    blocks = (block for block in re.split(r"\n\s*\n", text) if block.strip())
    return "".join(f"<p>{linked(' '.join(block.split()))}</p>" for block in blocks)


def preformatted(text: str) -> str:
    """Wraps text whose line breaks and columns matter."""
    return f'<pre class="rec">{linked(text)}</pre>'


def vulcan_record(readme_path: str) -> dict:
    """Builds the Vulcan record from the Level 3 package README.

    Args:
        readme_path: Path of README.txt in the package.

    Returns:
        The record.
    """
    with open(readme_path, encoding="utf8", errors="replace") as handle:
        parts = re.split(r"\n=+\n", handle.read())
    sections = {}
    for part in parts[1:]:
        lines = part.strip().splitlines()
        if lines:
            sections[lines[0].strip()] = "\n".join(lines[1:]).strip()
    print("vulcan | from README |", list(sections))
    return {
        "slug": "Vulcan-2022 Level 3 Model 1",
        "title": "Vulcan 2022 magnetotelluric survey, South Australia: smooth 3-D electrical resistivity model",
        "creators": ["Ben Kay", "Graham Heinson", "Goran Boren", "Ying Liu"],
        "dois": [{"label": "NCI DOI", "doi": "10.25914/arwp-q219"},
                 {"label": "Pub. DOI", "doi": "10.1080/08123985.2024.2378132"}],
        "tags": ["magnetotellurics", "electrical resistivity", "IOCG"],
        "snapshot": paragraphs(sections["ABSTRACT"].split("\n\n")[0]),
        "overview": ("<h2>Abstract</h2>" + paragraphs(sections["ABSTRACT"]) +
                     "<h2>Known limits</h2>" + preformatted(sections["KNOWN LIMITS"])),
        "model": ("<h2>Model and inversion</h2>" + preformatted(sections["MODEL AND INVERSION"]) +
                  "<h2>Contents of the package</h2>" + preformatted(sections["CONTENTS"])),
        "meta": ("<h2>Lineage</h2>" + preformatted(sections["LINEAGE"]) +
                 "<h2>Citation</h2>" + preformatted(sections["CITATION"]) +
                 "<h2>Licence</h2>" + paragraphs(sections["LICENCE"]) +
                 "<h2>Acknowledgements</h2>" + paragraphs(sections["ACKNOWLEDGEMENTS"])),
        # The model's own citation: the part of the section before the paper's.
        "citation": " ".join(sections["CITATION"].split("Paper:")[0].replace("Model:", "").split()),
        "data_url": "https://doi.org/10.25914/arwp-q219",
        "repo": "",
    }


def main() -> int:
    """Runs the script.

    Returns:
        0 when the records are written.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out", help="output .json")
    parser.add_argument("readme", nargs="?", help="README.txt of the Vulcan Level 3 package")
    args = parser.parse_args()

    records = {}
    if args.readme:
        records["vulcan"] = vulcan_record(args.readme)
    for scene, slug in SCENES.items():
        record = live_record(slug)
        records[scene] = record
        sizes = {key: len(record[key]) for key in ("snapshot", "overview", "model", "meta")}
        print(scene, "|", record["title"][:50], "| creators", len(record["creators"]),
              "| dois", [doi["label"] for doi in record["dois"]], "| chars", sizes,
              "| cite", bool(record["citation"]), "| data", bool(record["data_url"]))

    with open(args.out, "w", encoding="utf8") as handle:
        json.dump(records, handle, indent=1, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
