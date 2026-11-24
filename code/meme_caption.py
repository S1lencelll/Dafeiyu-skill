#!/usr/bin/env python3
"""梗图加字工具：在图片顶部/底部添加带黑边白字的高清中文配字。"""
import argparse
import os
import textwrap
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


def pick_font_path():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def wrap_lines(text: str, max_chars: int = 12):
    out = []
    for para in (text or '').splitlines():
        para = para.strip()
        if not para:
            continue
        out.extend(textwrap.wrap(para, width=max_chars) or [para])
    return out[:4]


def draw_caption_block(draw, lines, img_w, y_start, font, stroke_w, line_gap):
    y = y_start
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_w)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        x = max(8, (img_w - tw) // 2)
        draw.text(
            (x, y),
            line,
            font=font,
            fill=(255, 255, 255, 255),
            stroke_width=stroke_w,
            stroke_fill=(0, 0, 0, 255),
        )
        y += th + line_gap


def measure_block_height(draw, lines, font, stroke_w, line_gap):
    total = 0
    for i, line in enumerate(lines):
        bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_w)
        total += (bbox[3] - bbox[1]) + (line_gap if i < len(lines) - 1 else 0)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--text', required=True)
    ap.add_argument('--position', default='bottom', choices=['bottom', 'top', 'both'])
    ap.add_argument('--bottom', default='')
    args = ap.parse_args()

    img = Image.open(args.input).convert('RGBA')
    w, h = img.size
    if w < 320:
        scale = 320 / w
        w, h = int(w * scale), int(h * scale)
        img = img.resize((w, h), Image.Resampling.LANCZOS)

    font_path = pick_font_path()
    top_lines = wrap_lines(args.text) if args.position in ('top', 'both') else []
    bot_lines = wrap_lines(args.bottom if args.position == 'both' and args.bottom else args.text) if args.position in ('bottom', 'both') else []

    longest = max([len(l) for l in (top_lines + bot_lines)] or [4])
    font_size = max(20, min(68, int(w * 0.86 / max(4, longest))))
    font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
    stroke_w = max(2, font_size // 11)
    line_gap = max(4, font_size // 5)
    pad = max(12, int(h * 0.04))

    draw = ImageDraw.Draw(img)
    if top_lines:
        draw_caption_block(draw, top_lines, w, pad, font, stroke_w, line_gap)
    if bot_lines:
        bh = measure_block_height(draw, bot_lines, font, stroke_w, line_gap)
        draw_caption_block(draw, bot_lines, w, max(pad, h - bh - pad), font, stroke_w, line_gap)

    img.convert('RGB').save(args.output, format='PNG', optimize=True)


if __name__ == '__main__':
    main()
