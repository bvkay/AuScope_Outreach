"""Cuts one card thumbnail per model from its landing image.

Usage (needs Pillow):
    python make_thumbs.py <folder of source images named <slug>.<ext>> <thumbs.json> <out folder> [review sheet .png]

thumbs.json holds one crop box per model, as fractions of the source image:
    {"<slug>": [left, top, right, bottom], ...}
Each box is trimmed about its centre to the card shape (16:10), then saved as an 800 x 500 JPEG.
The boxes were picked by eye to show a single panel without axis text where the figure allows.

Check:
    This test fails if any model in thumbs.json has no source image, if any box falls outside
    its image, or if a thumbnail is nearly blank (fewer than 2 % of its pixels differ from
    white), which is what a box placed on a margin or between panels would give.
"""
import argparse
import glob
import json
import os
import sys

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None       # some landing images are larger than Pillow's default limit

WIDTH, HEIGHT = 800, 500
JPEG_QUALITY = 84
MIN_INKED = 0.02
WHITE_LEVEL = 245
SHEET_COLUMNS = 4


def card_box(size: tuple[int, int], box: list[float]) -> tuple[int, int, int, int]:
    """Converts a fractional crop box to pixels, trimmed about its centre to the card shape.

    Args:
        size: Width and height of the source image in pixels.
        box: Left, top, right and bottom as fractions of the image.

    Returns:
        Left, top, right and bottom in pixels.

    Raises:
        ValueError: If the box is empty or falls outside the image.
    """
    left, top, right, bottom = box
    if not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
        raise ValueError("box outside the image")
    x0, y0, x1, y1 = left * size[0], top * size[1], right * size[0], bottom * size[1]
    width, height = x1 - x0, y1 - y0
    if width / height > WIDTH / HEIGHT:         # too wide: trim the sides
        centre = (x0 + x1) / 2
        width = height * WIDTH / HEIGHT
        x0, x1 = centre - width / 2, centre + width / 2
    else:                                       # too tall: trim top and bottom
        centre = (y0 + y1) / 2
        height = width * HEIGHT / WIDTH
        y0, y1 = centre - height / 2, centre + height / 2
    return round(x0), round(y0), round(x1), round(y1)


def inked_fraction(thumb: Image.Image) -> float:
    """Measures how much of a thumbnail is not white.

    Args:
        thumb: The thumbnail.

    Returns:
        The fraction of pixels darker than WHITE_LEVEL, on a 10 times smaller grey copy.
    """
    small = thumb.resize((WIDTH // 10, HEIGHT // 10)).convert("L")
    pixels = small.tobytes()
    return sum(1 for level in pixels if level < WHITE_LEVEL) / len(pixels)


def save_sheet(path: str, tiles: list[tuple[str, Image.Image]]) -> None:
    """Saves every thumbnail on one labelled sheet, for checking the boxes by eye.

    Args:
        path: Output .png.
        tiles: Slug and thumbnail, in order.
    """
    rows = -(-len(tiles) // SHEET_COLUMNS)
    sheet = Image.new("RGB", (SHEET_COLUMNS * 410, rows * 280), "white")
    draw = ImageDraw.Draw(sheet)
    for n, (slug, thumb) in enumerate(tiles):
        x, y = (n % SHEET_COLUMNS) * 410 + 5, (n // SHEET_COLUMNS) * 280 + 20
        sheet.paste(thumb.resize((400, 250)), (x, y))
        draw.text((x, y - 16), f"{n}: {slug[:44]}", fill="black")
    sheet.save(path)


def main() -> int:
    """Runs the script.

    Returns:
        0 if every thumbnail was made and passes the check, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source_dir", help="folder of source images named <slug>.<ext>")
    parser.add_argument("boxes", help="thumbs.json")
    parser.add_argument("out_dir", help="folder for the thumbnails")
    parser.add_argument("sheet", nargs="?", help="optional review sheet .png")
    args = parser.parse_args()

    with open(args.boxes, encoding="utf8") as handle:
        boxes = json.load(handle)
    os.makedirs(args.out_dir, exist_ok=True)

    passed = True
    tiles = []
    for slug, box in boxes.items():
        sources = glob.glob(os.path.join(args.source_dir, slug + ".*"))
        if not sources:
            print("FAIL", slug, "no source image")
            passed = False
            continue
        image = Image.open(sources[0]).convert("RGB")
        try:
            pixels = card_box(image.size, box)
        except ValueError as error:
            print("FAIL", slug, error)
            passed = False
            continue
        thumb = image.crop(pixels).resize((WIDTH, HEIGHT), Image.LANCZOS)
        inked = inked_fraction(thumb)
        if inked < MIN_INKED:
            print("FAIL", slug, f"nearly blank ({inked * 100:.1f} % inked)")
            passed = False
        path = os.path.join(args.out_dir, slug + ".jpg")
        thumb.save(path, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        print(f"{slug}: source {image.size[0]}x{image.size[1]}, cut {pixels[2] - pixels[0]}x{pixels[3] - pixels[1]} px, "
              f"{os.path.getsize(path) // 1024} kB, {inked * 100:.0f} % inked")
        tiles.append((slug, thumb))

    if args.sheet and tiles:
        save_sheet(args.sheet, tiles)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
