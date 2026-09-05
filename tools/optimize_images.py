#!/usr/bin/env python3
"""Generate web-ready images for Urban Flame.

Reads the camera-resolution originals (5000px+, 3-12 MB each) from
media/originals/ and writes what the site actually serves into
public/assets/img/: a cropped, resized, progressive JPEG plus a WebP twin.

The sources live outside public/ on purpose. They are 47 MB of input to this
script, not assets, so nothing that publishes public/ can ever ship them.

Usage:  python tools/optimize_images.py      (npm run images)
"""

from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
ORIGINALS = ROOT / "media" / "originals"
IMAGES = ROOT / "public" / "assets" / "img"

# source filename -> (output basename, target width, aspect ratio w/h)
GALLERY_RATIO = 3 / 2
TARGETS = {
    "background.jpg": ("background", 1920, 16 / 9),
    "interior1.jpg": ("interior-bar", 1200, GALLERY_RATIO),
    "interior2.jpg": ("interior-dining", 1200, GALLERY_RATIO),
    "biriyani.jpg": ("biryani", 1200, GALLERY_RATIO),
    "chicken_manchurian.jpg": ("chicken-manchurian", 1200, GALLERY_RATIO),
    "veg.jpg": ("paneer-naan", 1200, GALLERY_RATIO),
    "veg1.jpg": ("mushroom-curry", 1200, GALLERY_RATIO),
}

JPEG_QUALITY = 78
WEBP_QUALITY = 74


def kb(path: Path) -> str:
    return f"{path.stat().st_size / 1024:.0f} KB"


def center_crop(img: Image.Image, ratio: float) -> Image.Image:
    width, height = img.size
    if width / height > ratio:
        new_width = round(height * ratio)
        left = (width - new_width) // 2
        return img.crop((left, 0, left + new_width, height))
    new_height = round(width / ratio)
    top = (height - new_height) // 2
    return img.crop((0, top, width, top + new_height))


def build(source: Path, basename: str, width: int, ratio: float) -> None:
    with Image.open(source) as raw:
        img = ImageOps.exif_transpose(raw)
        img = center_crop(img.convert("RGB"), ratio)
        img = img.resize((width, round(width / ratio)), Image.LANCZOS)

        jpeg = IMAGES / f"{basename}.jpg"
        webp = IMAGES / f"{basename}.webp"
        img.save(jpeg, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        img.save(webp, "WEBP", quality=WEBP_QUALITY, method=6)

    before = kb(source)
    print(f"  {source.name:<26} {before:>9}  ->  {jpeg.name} {kb(jpeg):>8} | {webp.name} {kb(webp):>8}")


def main() -> None:
    if not ORIGINALS.is_dir():
        raise SystemExit(
            f"No sources found at {ORIGINALS.relative_to(ROOT)}/ - it is gitignored, so a "
            "fresh clone has to be given the camera originals before this can run."
        )

    IMAGES.mkdir(parents=True, exist_ok=True)

    print(f"Building {IMAGES.relative_to(ROOT).as_posix()}/ from {ORIGINALS.relative_to(ROOT).as_posix()}/")
    missing = []
    for name, (basename, width, ratio) in TARGETS.items():
        source = ORIGINALS / name
        if not source.exists():
            missing.append(name)
            continue
        build(source, basename, width, ratio)

    if missing:
        raise SystemExit("\nMissing sources: " + ", ".join(missing))

    served = sorted(p for p in IMAGES.glob("*") if p.is_file())
    total = sum(p.stat().st_size for p in served) / 1024
    print(f"\nServed from {IMAGES.relative_to(ROOT).as_posix()}/: {len(served)} files, {total:.0f} KB total")


if __name__ == "__main__":
    main()
