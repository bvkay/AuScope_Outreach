"""Cut one card thumbnail per model from its landing image.

Usage (needs Pillow):
    python make_thumbs.py <folder of source images named <slug>.<ext>> <thumbs.json> <out folder> [review sheet .png]

thumbs.json holds one crop box per model, as fractions of the source image:
    {"<slug>": [left, top, right, bottom], ...}
Each box is trimmed about its centre to the card shape (16:10), then saved as an 800 x 500 JPEG.
The boxes were picked by eye to show a single panel without axis text where the figure allows.

Check:
    This test fails if any model in thumbs.json has no source image, if any box falls outside its
    image, or if a thumbnail is nearly blank (fewer than 2 % of its pixels differ from white), which
    is what a box placed on a margin or between panels would give.
"""
import glob
import json
import os
import sys

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
src, spec, out = sys.argv[1:4]
sheet_path = sys.argv[4] if len(sys.argv) > 4 else None
W, H = 800, 500
boxes = json.load(open(spec, encoding="utf8"))
os.makedirs(out, exist_ok=True)

ok, tiles = True, []
for slug, (l, t, r, b) in boxes.items():
    hits = glob.glob(os.path.join(src, slug + ".*"))
    if not hits:
        print("FAIL", slug, "no source image"); ok = False; continue
    im = Image.open(hits[0]).convert("RGB")
    w0, h0 = im.size
    if not (0 <= l < r <= 1 and 0 <= t < b <= 1):
        print("FAIL", slug, "box outside the image"); ok = False; continue
    x0, y0, x1, y1 = l * w0, t * h0, r * w0, b * h0
    bw, bh = x1 - x0, y1 - y0
    if bw / bh > W / H:                      # too wide: trim the sides
        cx = (x0 + x1) / 2; bw = bh * W / H; x0, x1 = cx - bw / 2, cx + bw / 2
    else:                                    # too tall: trim top and bottom
        cy = (y0 + y1) / 2; bh = bw * H / W; y0, y1 = cy - bh / 2, cy + bh / 2
    th = im.crop((round(x0), round(y0), round(x1), round(y1))).resize((W, H), Image.LANCZOS)
    small = th.resize((80, 50)).convert("L")
    inked = sum(1 for p in small.tobytes() if p < 245) / (80 * 50)
    if inked < 0.02:
        print("FAIL", slug, f"nearly blank ({inked*100:.1f} % inked)"); ok = False
    path = os.path.join(out, slug + ".jpg")
    th.save(path, "JPEG", quality=84, optimize=True, progressive=True)
    print(f"{slug}: source {w0}x{h0}, cut {round(bw)}x{round(bh)} px, {os.path.getsize(path)//1024} kB, {inked*100:.0f} % inked")
    tiles.append((slug, th))

if sheet_path and tiles:
    cols = 4; rows = -(-len(tiles) // cols)
    sheet = Image.new("RGB", (cols * 410, rows * 280), "white"); d = ImageDraw.Draw(sheet)
    for n, (slug, th) in enumerate(tiles):
        x, y = (n % cols) * 410 + 5, (n // cols) * 280 + 20
        sheet.paste(th.resize((400, 250)), (x, y)); d.text((x, y - 16), f"{n}: {slug[:44]}", fill="black")
    sheet.save(sheet_path)
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
