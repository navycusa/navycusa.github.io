from __future__ import annotations

from pathlib import Path

from PIL import Image


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    src = root / "assets" / "navy.jpg"

    im = Image.open(src).convert("RGBA")

    sizes = [192, 512]

    # Standard icons
    for s in sizes:
        im2 = im.resize((s, s), Image.Resampling.LANCZOS)
        im2.save(root / f"android-chrome-{s}x{s}.png", format="PNG", optimize=True)

    # "Maskable": keep content away from edges to avoid clipping
    for s in sizes:
        canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        inner = int(s * 0.8)
        im_inner = im.resize((inner, inner), Image.Resampling.LANCZOS)
        offset = ((s - inner) // 2, (s - inner) // 2)
        canvas.alpha_composite(im_inner, dest=offset)
        canvas.save(
            root / f"android-chrome-{s}x{s}-maskable.png",
            format="PNG",
            optimize=True,
        )

    # Favicon ICO (multi-size)
    im.save(root / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])


if __name__ == "__main__":
    main()

