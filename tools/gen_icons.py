"""Generate Arima Player's icon set.

Arima Kishi's mark: a graphite slab with a ghoul-red kakugan eye.

Everything is rendered at 4x and downsampled with LANCZOS so the ring stays
clean at 32px. Every PNG is written as RGBA on purpose — Tauri's
`include_image!` macro panics the build on non-RGBA input.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
SS = 4  # supersample factor

BASE = 512
S = BASE * SS

GRAPHITE_TOP = (28, 28, 34)
GRAPHITE_BOTTOM = (10, 10, 12)
ACCENT = (230, 57, 70)
ACCENT_DEEP = (109, 17, 25)
PUPIL = (5, 5, 6)


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel(
            (0, y),
            tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return grad.resize((size, size), Image.BILINEAR)


def radial(size: int, center, radius: float, color, peak_alpha: int) -> Image.Image:
    """A soft radial glow, drawn small and scaled up for a smooth falloff."""
    small = 256
    layer = Image.new("RGBA", (small, small), (0, 0, 0, 0))
    px = layer.load()
    cx, cy = center
    for y in range(small):
        for x in range(small):
            dx = (x / small) - cx
            dy = (y / small) - cy
            d = (dx * dx + dy * dy) ** 0.5
            if d >= radius:
                continue
            t = 1.0 - (d / radius)
            px[x, y] = (*color, int(peak_alpha * (t**2.2)))
    return layer.resize((size, size), Image.BICUBIC)


def build_master() -> Image.Image:
    # --- slab -------------------------------------------------------------
    bg = vertical_gradient(S, GRAPHITE_TOP, GRAPHITE_BOTTOM).convert("RGBA")

    # Faint arterial bleed toward the lower-left.
    bleed = radial(S, (0.22, 0.84), 0.62, ACCENT, 70)
    bg = Image.alpha_composite(bg, bleed)

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=255
    )

    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)

    cx = cy = S / 2
    outer_r = S * 0.325
    ring_w = int(S * 0.052)

    # --- glow behind the ring --------------------------------------------
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r),
        outline=(*ACCENT, 220),
        width=ring_w,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.035))
    canvas = Image.alpha_composite(canvas, glow)

    # --- iris -------------------------------------------------------------
    iris_r = outer_r - ring_w / 2
    iris = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(iris).ellipse(
        (cx - iris_r, cy - iris_r, cx + iris_r, cy + iris_r),
        fill=(*ACCENT_DEEP, 255),
    )
    canvas = Image.alpha_composite(canvas, iris)

    # --- the ring itself --------------------------------------------------
    ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse(
        (cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r),
        outline=(*ACCENT, 255),
        width=ring_w,
    )
    canvas = Image.alpha_composite(canvas, ring)

    # --- pupil ------------------------------------------------------------
    pupil_r = S * 0.115
    pupil = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(pupil).ellipse(
        (cx - pupil_r, cy - pupil_r, cx + pupil_r, cy + pupil_r),
        fill=(*PUPIL, 255),
    )
    canvas = Image.alpha_composite(canvas, pupil)

    # --- specular glint ---------------------------------------------------
    glint = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gx, gy = cx - S * 0.055, cy - S * 0.062
    gr = S * 0.030
    ImageDraw.Draw(glint).ellipse((gx - gr, gy - gr, gx + gr, gy + gr), fill=(255, 255, 255, 190))
    glint = glint.filter(ImageFilter.GaussianBlur(S * 0.006))
    canvas = Image.alpha_composite(canvas, glint)

    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = build_master()

    icon = master.resize((BASE, BASE), Image.LANCZOS)
    icon.save(OUT / "icon.png")

    for size, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")):
        master.resize((size, size), Image.LANCZOS).save(OUT / name)

    master.resize((256, 256), Image.LANCZOS).save(
        OUT / "icon.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    for f in sorted(OUT.iterdir()):
        with Image.open(f) as im:
            print(f"{f.name:<16} {im.size[0]}x{im.size[1]} mode={im.mode}")


if __name__ == "__main__":
    main()
