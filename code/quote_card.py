#!/usr/bin/env python3
"""Gemini修改：群聊「立 Flag 与名场面档案馆」语录卡片 & 月度语录海报生成。"""
import argparse
import json
import os
import textwrap
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]

KIND_META = {
    'flag': ('[立Flag现场]', (253, 203, 110)),
    'busted': ('[Flag 破功处刑]', (255, 118, 117)),
    'typo': ('[离谱错别字]', (116, 185, 255)),
    'quote': ('[群聊神金句]', (217, 128, 250)),
}


def pick_font(size: int):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def draw_single_card(item: dict, out_path: str):
    w = 720
    kind = 'busted' if item.get('busted') else item.get('kind', 'quote')
    badge, accent = KIND_META.get(kind, KIND_META['quote'])
    quote = str(item.get('quote') or '').strip()
    speaker = str(item.get('speaker') or '某群友').strip()
    date = str(item.get('date') or '').strip()

    f_badge = pick_font(22)
    f_quote = pick_font(32)
    f_meta = pick_font(20)
    f_foot = pick_font(16)

    lines = []
    for para in quote.splitlines():
        para = para.strip()
        if para:
            lines.extend(textwrap.wrap(para, width=18) or [para])
    lines = lines[:8]

    line_h = 46
    h = max(300, 150 + len(lines) * line_h + 90)
    img = Image.new('RGB', (w, h), (30, 27, 58))
    draw = ImageDraw.Draw(img)

    # 边框与星光装饰线
    draw.rectangle([(12, 12), (w - 13, h - 13)], outline=accent, width=3)
    draw.rectangle([(20, 20), (w - 21, h - 21)], outline=(108, 92, 231), width=1)

    draw.text((42, 36), badge, font=f_badge, fill=accent)
    draw.line([(42, 74), (w - 42, 74)], fill=(75, 68, 130), width=2)

    y = 98
    for ln in lines:
        draw.text((46, y), ln, font=f_quote, fill=(245, 246, 250))
        y += line_h

    meta_text = f"—— {speaker} · {date}"
    draw.text((46, h - 82), meta_text, font=f_meta, fill=(200, 196, 235))
    draw.text((w - 220, h - 42), "★ 星光猫娘档案馆", font=f_foot, fill=(140, 134, 190))

    img.save(out_path, format='PNG', optimize=True)


def draw_monthly_poster(items: list, month: str, out_path: str):
    w = 820
    f_title = pick_font(32)
    f_sub = pick_font(18)
    f_item = pick_font(22)
    f_meta = pick_font(17)

    blocks = []
    for idx, it in enumerate(items[:10], 1):
        kind_tag = '[破功]' if it.get('busted') else {'flag': '[Flag]', 'typo': '[错字]', 'quote': '[金句]'}.get(it.get('kind', 'quote'), '[金句]')
        wrapped = textwrap.wrap(f"{idx}. {kind_tag} {str(it.get('quote') or '').strip()}", width=30)[:3]
        meta = f"    —— {it.get('speaker', '某群友')} ({it.get('date', '')})"
        blocks.append((wrapped, meta, bool(it.get('busted'))))

    total_lines = sum(len(b[0]) + 1 for b in blocks)
    h = max(360, 150 + total_lines * 32 + len(blocks) * 16 + 60)
    img = Image.new('RGB', (w, h), (26, 23, 50))
    draw = ImageDraw.Draw(img)

    draw.rectangle([(12, 12), (w - 13, h - 13)], outline=(217, 128, 250), width=3)
    draw.text((40, 34), f"《本群 {month} 月度发疯语录图》", font=f_title, fill=(253, 203, 110))
    draw.text((44, 78), f"共收录 {len(items)} 条高光名场面（展示前 {len(blocks)} 条）", font=f_sub, fill=(180, 175, 220))
    draw.line([(40, 110), (w - 40, 110)], fill=(108, 92, 231), width=2)

    y = 130
    for wrapped, meta, busted in blocks:
        color = (255, 138, 128) if busted else (245, 246, 250)
        for ln in wrapped:
            draw.text((42, y), ln, font=f_item, fill=color)
            y += 32
        draw.text((42, y), meta, font=f_meta, fill=(170, 165, 210))
        y += 38

    draw.text((w - 230, h - 38), "★ 星光猫娘档案馆", font=f_sub, fill=(140, 134, 190))
    img.save(out_path, format='PNG', optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=['single', 'monthly'], required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--month', default='')
    args = ap.parse_args()

    payload = json.loads(args.data)
    if args.mode == 'single':
        draw_single_card(payload, args.output)
    else:
        draw_monthly_poster(payload, args.month, args.output)


if __name__ == '__main__':
    main()
