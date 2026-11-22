#!/usr/bin/env python3
"""Gera os ícones padrão e splash screens do Rit para Android preservando dimensões."""

from pathlib import Path
import sys
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
RES_DIR = ROOT / "frontend" / "android" / "app" / "src" / "main" / "res"
ICON_SRC = ROOT / "frontend" / "public" / "icon-512.png"
MARK_SRC = ROOT / "frontend" / "public" / "rit-mark.png"
BG_COLOR = (12, 14, 18, 255)  # #0c0e12


def progress_bar(done: int, total: int, label: str) -> None:
    pct = int(round((done / total) * 100)) if total else 100
    filled = int(round((pct / 100) * 10))
    bar = ("█" * filled) + ("░" * (10 - filled))
    print(f"[{bar}] {pct}% ({done}/{total}) - {label}", flush=True)


def make_round_icon(src_rgba: Image.Image, size: tuple[int, int]) -> Image.Image:
    w, h = size
    base = src_rgba.resize((w, h), Image.Resampling.LANCZOS)
    scale = 4
    mask_hi = Image.new("L", (w * scale, h * scale), 0)
    draw = ImageDraw.Draw(mask_hi)
    draw.ellipse((0, 0, w * scale - 1, h * scale - 1), fill=255)
    mask = mask_hi.resize((w, h), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def make_centered_mark(
    mark_rgba: Image.Image,
    canvas_size: tuple[int, int],
    target_width: int,
    bg_color: tuple[int, int, int, int],
) -> Image.Image:
    cw, ch = canvas_size
    mw, mh = mark_rgba.size
    target_w = max(1, target_width)
    target_h = max(1, int(round((target_w * mh) / mw)))
    resized = mark_rgba.resize((target_w, target_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (cw, ch), bg_color)
    x = (cw - target_w) // 2
    y = (ch - target_h) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def main() -> int:
    if not ICON_SRC.exists() or not MARK_SRC.exists():
        print("Arquivos de origem do logo Rit não encontrados.", file=sys.stderr)
        return 1

    icon_src = Image.open(ICON_SRC).convert("RGBA")
    mark_raw = Image.open(MARK_SRC).convert("RGBA")
    bbox = mark_raw.getbbox()
    mark_crop = mark_raw.crop(bbox) if bbox else mark_raw

    densities = ["ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]
    tasks: list[tuple[str, Path]] = []

    for d in densities:
        mdir = RES_DIR / f"mipmap-{d}"
        for fname in (
            "ic_launcher.png",
            "ic_launcher_round.png",
            "ic_launcher_background.png",
            "ic_launcher_foreground.png",
        ):
            p = mdir / fname
            if p.exists():
                tasks.append((f"mipmap-{d}/{fname}", p))

    for p in sorted(RES_DIR.glob("drawable*/splash.png")):
        tasks.append((f"{p.parent.name}/{p.name}", p))

    total = len(tasks)
    if total == 0:
        print("Nenhum recurso Android padrão encontrado para atualizar.", file=sys.stderr)
        return 1

    progress_bar(0, total, "Iniciando geração dos assets Rit Android")

    for idx, (label, path) in enumerate(tasks, start=1):
        with Image.open(path) as cur:
            size = cur.size

        if path.name == "ic_launcher.png":
            out = icon_src.resize(size, Image.Resampling.LANCZOS)
        elif path.name == "ic_launcher_round.png":
            out = make_round_icon(icon_src, size)
        elif path.name == "ic_launcher_background.png":
            out = Image.new("RGBA", size, BG_COLOR)
        elif path.name == "ic_launcher_foreground.png":
            out = make_centered_mark(mark_crop, size, int(round(size[0] * 0.62)), (0, 0, 0, 0))
        elif path.name == "splash.png":
            target_w = int(round(min(size[0], size[1]) * 0.26))
            out = make_centered_mark(mark_crop, size, target_w, BG_COLOR)
        else:
            continue

        out.save(path, format="PNG")
        if idx == total or idx % 5 == 0:
            progress_bar(idx, total, f"Gerado {label}")

    print(f"Assets Rit Android atualizados com sucesso ({total} arquivos).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
