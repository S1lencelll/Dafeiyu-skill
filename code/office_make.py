#!/usr/bin/env python3
"""Gemini修改：生成 docx / pptx（v2 宽屏 16:9 高饱满卡片容器版）：从 stdin 读 JSON，写到指定路径。

用法: office_make.py <out.docx|out.pptx>
支持版式: cover, section, grid-2x2, cols-3, split-visual, kpi-cards, timeline, table,
         two-col, image-right, image-left, image-full, bullets
"""
import io
import json
import os
import re
import sys
import urllib.request


def die(msg: str) -> "NoReturn":
    print(msg, file=sys.stderr)
    raise SystemExit(2)


def build_docx(payload: dict, out: str) -> None:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(10.5)

    title = str(payload.get("title") or "").strip()
    sub = str(payload.get("subtitle") or "").strip()
    if title:
        h = doc.add_heading(title, level=0)
        h.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if sub:
        p = doc.add_paragraph(sub)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    for b in payload.get("blocks") or []:
        t = str(b.get("type") or "p")
        text = str(b.get("text") or "")
        if t in ("h1", "h2", "h3"):
            doc.add_heading(text, level=int(t[1]))
        elif t == "bullet":
            doc.add_paragraph(text, style="List Bullet")
        elif t == "num":
            doc.add_paragraph(text, style="List Number")
        elif t == "quote":
            p = doc.add_paragraph(text)
            p.paragraph_format.left_indent = Pt(18)
        elif t == "code":
            p = doc.add_paragraph(text)
            if p.runs:
                p.runs[0].font.name = "Consolas"
        elif t == "table":
            rows = b.get("rows") or []
            if rows:
                cols = max(len(r) for r in rows)
                table = doc.add_table(rows=len(rows), cols=cols)
                table.style = "Table Grid"
                for ri, row in enumerate(rows):
                    for ci in range(cols):
                        table.cell(ri, ci).text = str(row[ci]) if ci < len(row) else ""
        else:
            if text:
                doc.add_paragraph(text)
    doc.save(out)


# ── Gemini修改：PPTX v2 高饱满宽屏卡片引擎 ─────────────────────────────────────
def parse_rgb(hex_str: str, fallback=(30, 58, 138)):
    from pptx.dml.color import RGBColor
    s = str(hex_str or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return RGBColor(*fallback)
    try:
        return RGBColor(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return RGBColor(*fallback)


def is_dark_hex(hex_str: str) -> bool:
    s = str(hex_str or "").strip().lstrip("#")
    if len(s) != 6:
        return False
    try:
        r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
        return (0.299 * r + 0.587 * g + 0.114 * b) < 128
    except ValueError:
        return False


def mix_rgb(c1, c2, t: float):
    from pptx.dml.color import RGBColor
    r = int(c1[0] * (1 - t) + c2[0] * t)
    g = int(c1[1] * (1 - t) + c2[1] * t)
    b = int(c1[2] * (1 - t) + c2[2] * t)
    return RGBColor(max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))


def resolve_theme(raw_theme) -> dict:
    t = raw_theme if isinstance(raw_theme, dict) else {}
    bg = str(t.get("bg") or "#F8FAFC")
    dark = is_dark_hex(bg)
    surface = str(t.get("surface") or ("#132642" if dark else "#FFFFFF"))
    primary = str(t.get("primary") or ("#38BDF8" if dark else "#1E3A8A"))
    accent = str(t.get("accent") or ("#38BDF8" if dark else "#2563EB"))
    text = str(t.get("text") or ("#F8FAFC" if dark else "#0F172A"))
    muted = str(t.get("muted") or ("#94A3B8" if dark else "#475569"))

    bg_c = parse_rgb(bg, (248, 250, 252))
    surf_c = parse_rgb(surface, (255, 255, 255))
    prim_c = parse_rgb(primary, (30, 58, 138))
    acc_c = parse_rgb(accent, (37, 99, 235))
    txt_c = parse_rgb(text, (15, 23, 42))
    mut_c = parse_rgb(muted, (71, 85, 105))
    border_c = mix_rgb(surf_c, txt_c, 0.22 if dark else 0.12)
    tint_c = mix_rgb(surf_c, acc_c, 0.18 if dark else 0.08)
    zebra_c = mix_rgb(surf_c, bg_c, 0.45)

    return {
        "dark": dark,
        "bg": bg_c,
        "surface": surf_c,
        "primary": prim_c,
        "accent": acc_c,
        "text": txt_c,
        "muted": mut_c,
        "border": border_c,
        "tint": tint_c,
        "zebra": zebra_c,
        "white": parse_rgb("#FFFFFF"),
    }


# Gemini修改：增强远程图片加载（带 Referer/DataURI 支持）与流式图表直接嵌入
def load_image_stream(src):
    import base64
    import urllib.parse
    if isinstance(src, io.BytesIO):
        src.seek(0)
        return src
    s = str(src or "").strip()
    if not s:
        return None
    if s.startswith("data:image/") and ";base64," in s:
        try:
            b64 = s.split(";base64,", 1)[1]
            return io.BytesIO(base64.b64decode(b64))
        except Exception:
            return None
    if os.path.exists(s):
        with open(s, "rb") as f:
            return io.BytesIO(f.read())
    if re.match(r"^https?://", s, re.I):
        try:
            parsed = urllib.parse.urlparse(s)
            referer = f"{parsed.scheme}://{parsed.netloc}/"
            req = urllib.request.Request(s, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
                "Referer": referer,
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                return io.BytesIO(data) if data else None
        except Exception:
            return None
    return None


def pick_slide_image(s: dict, fallback=None):
    img = s.get("image")
    if not img:
        imgs = s.get("images")
        if isinstance(imgs, (list, tuple)) and imgs:
            first = imgs[0]
            img = first.get("url") or first.get("src") if isinstance(first, dict) else first
        elif isinstance(imgs, str):
            img = imgs
    return img or fallback


def add_picture_fit(slide, img_src, x: float, y: float, max_w: float, max_h: float):
    from PIL import Image
    from pptx.util import Inches
    stream = load_image_stream(img_src)
    if not stream:
        return False
    try:
        im = Image.open(stream)
        iw, ih = im.size
        if iw <= 0 or ih <= 0:
            return False
        scale = min(max_w / iw, max_h / ih)
        w = iw * scale
        h = ih * scale
        px = x + (max_w - w) / 2
        py = y + (max_h - h) / 2
        stream.seek(0)
        slide.shapes.add_picture(stream, Inches(px), Inches(py), Inches(w), Inches(h))
        return True
    except Exception:
        return False


def set_run_font(run, size_pt: float, color, bold: bool = False):
    from pptx.util import Pt
    run.font.name = "Microsoft YaHei"
    run.font.size = Pt(size_pt)
    run.font.bold = bold
    run.font.color.rgb = color


def add_rich_paragraph(tf, raw_text: str, size_pt: float, th: dict, bold_default: bool = False,
                       color=None, first: bool = False, space_after: float = 5.0, line_spacing: float = 1.3):
    from pptx.util import Pt
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.line_spacing = line_spacing
    p.space_after = Pt(space_after)
    base_color = color or th["text"]
    s = str(raw_text or "").strip()
    # 解析 **加粗**：正文
    parts = re.split(r"(\*\*[^*]+\*\*)", s)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            r = p.add_run()
            r.text = part[2:-2]
            set_run_font(r, size_pt, th["accent"] if th["dark"] else th["primary"], bold=True)
        else:
            r = p.add_run()
            r.text = part
            set_run_font(r, size_pt, base_color, bold=bold_default)
    return p


def draw_rect(slide, x: float, y: float, w: float, h: float, fill_color, border_color=None,
              rounded: bool = False, radius: float = 0.04):
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Inches, Pt
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE
    shp = slide.shapes.add_shape(shape_type, Inches(x), Inches(y), Inches(w), Inches(h))
    if rounded and len(shp.adjustments) > 0:
        shp.adjustments[0] = radius
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill_color
    if border_color is not None:
        shp.line.color.rgb = border_color
        shp.line.width = Pt(1)
    else:
        shp.line.fill.background()
    return shp


def draw_card(slide, x: float, y: float, w: float, h: float, th: dict, accent_pos: str = "top", accent_color=None):
    card = draw_rect(slide, x, y, w, h, th["surface"], border_color=th["border"], rounded=True, radius=0.04)
    ac = accent_color or th["accent"]
    if accent_pos == "top":
        draw_rect(slide, x + 0.12, y + 0.02, w - 0.24, 0.055, ac)
    elif accent_pos == "left":
        draw_rect(slide, x + 0.02, y + 0.12, 0.06, h - 0.24, ac)
    return card


def add_textbox(slide, x: float, y: float, w: float, h: float, shrink: bool = True):
    from pptx.enum.text import MSO_AUTO_SIZE
    from pptx.util import Inches
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.06)
    tf.margin_right = Inches(0.06)
    tf.margin_top = Inches(0.04)
    tf.margin_bottom = Inches(0.04)
    if shrink:
        tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    return tf


def render_chrome(slide, s: dict, idx: int, total: int, th: dict):
    # 背景
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = th["bg"]

    # 顶部装饰条
    draw_rect(slide, 0, 0, 13.333, 0.065, th["accent"])

    # 章节眉标 & 页码
    sec = str(s.get("section") or "").strip()
    if sec:
        tf_sec = add_textbox(slide, 0.55, 0.16, 9.0, 0.26, shrink=False)
        add_rich_paragraph(tf_sec, sec, 10.5, th, bold_default=True, color=th["accent"], first=True, space_after=0)

    tf_pg = add_textbox(slide, 11.4, 0.16, 1.38, 0.26, shrink=False)
    p_pg = add_rich_paragraph(tf_pg, f"{idx:02d} / {total:02d}", 10.5, th, bold_default=True, color=th["muted"], first=True, space_after=0)
    from pptx.enum.text import PP_ALIGN
    p_pg.alignment = PP_ALIGN.RIGHT

    # 结论型主标题
    title = str(s.get("title") or "").strip()
    tf_t = add_textbox(slide, 0.55, 0.42, 12.23, 0.72, shrink=True)
    title_color = th["text"] if th["dark"] else th["primary"]
    add_rich_paragraph(tf_t, title, 22, th, bold_default=True, color=title_color, first=True, space_after=0, line_spacing=1.15)

    # 细分隔线
    draw_rect(slide, 0.55, 1.18, 12.23, 0.015, th["border"])

    # 底部 takeaway 横幅
    takeaway = str(s.get("takeaway") or "").strip()
    if takeaway:
        draw_rect(slide, 0.55, 6.32, 12.23, 0.68, th["tint"], border_color=th["border"], rounded=True, radius=0.12)
        draw_rect(slide, 0.55, 6.40, 0.08, 0.52, th["accent"])
        clean_tk = re.sub(r"^(?:核心结论|核心启示|结论|小结)[:：]\s*", "", takeaway)
        tf_tk = add_textbox(slide, 0.75, 6.38, 11.90, 0.56, shrink=True)
        add_rich_paragraph(tf_tk, f"**核心结论：**{clean_tk}", 13, th, first=True, space_after=0, line_spacing=1.2)


def render_cover(slide, payload: dict, s: dict, th: dict):
    from pptx.enum.text import PP_ALIGN
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = th["bg"] if th["dark"] else th["primary"]

    cover_img = pick_slide_image(s, payload.get("cover"))
    if cover_img:
        add_picture_fit(slide, cover_img, 7.8, 0.8, 5.0, 5.9)

    draw_rect(slide, 0.75, 1.45, 0.10, 4.3, th["accent"])

    meta = str(s.get("meta") or "").strip()
    if meta:
        tf_m = add_textbox(slide, 1.10, 1.50, 10.5, 0.42, shrink=False)
        add_rich_paragraph(tf_m, meta, 13, th, bold_default=True, color=th["accent"], first=True, space_after=0)

    title = str(s.get("title") or payload.get("title") or "演示文稿")
    w_title = 6.6 if cover_img else 11.2
    tf_t = add_textbox(slide, 1.10, 2.05, w_title, 2.1, shrink=True)
    p_t = add_rich_paragraph(tf_t, title, 34, th, bold_default=True, color=th["white"], first=True, space_after=8, line_spacing=1.2)
    p_t.alignment = PP_ALIGN.LEFT

    sub = str(s.get("subtitle") or payload.get("subtitle") or "")
    if not sub and s.get("bullets"):
        sub = "  ·  ".join(str(x) for x in s["bullets"][:2])
    if sub:
        tf_s = add_textbox(slide, 1.10, 4.25, w_title, 1.3, shrink=True)
        add_rich_paragraph(tf_s, sub, 16, th, color=parse_rgb("#E2E8F0"), first=True, space_after=0, line_spacing=1.35)


def render_section(slide, s: dict, th: dict):
    from pptx.enum.text import PP_ALIGN
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = th["bg"] if th["dark"] else th["primary"]

    draw_rect(slide, 5.8, 2.15, 1.73, 0.08, th["accent"])
    tf = add_textbox(slide, 1.2, 2.45, 10.93, 2.4, shrink=True)
    p = add_rich_paragraph(tf, str(s.get("title") or ""), 32, th, bold_default=True, color=th["white"], first=True, space_after=10)
    p.alignment = PP_ALIGN.CENTER
    sub = str(s.get("subtitle") or (" ".join(s.get("bullets") or []) if s.get("bullets") else ""))
    if sub:
        p2 = add_rich_paragraph(tf, sub, 16, th, color=parse_rgb("#CBD5E1"), first=False, space_after=0)
        p2.alignment = PP_ALIGN.CENTER


def render_card_body(slide, x: float, y: float, w: float, h: float, title: str, items: list, th: dict,
                     accent_pos: str = "top", accent_color=None, title_size: float = 15.5, body_size: float = 13.5):
    draw_card(slide, x, y, w, h, th, accent_pos=accent_pos, accent_color=accent_color)
    tf = add_textbox(slide, x + 0.16, y + 0.14, w - 0.32, h - 0.24, shrink=True)
    first = True
    if title:
        t_color = th["accent"] if th["dark"] else th["primary"]
        add_rich_paragraph(tf, title, title_size, th, bold_default=True, color=t_color, first=True, space_after=7, line_spacing=1.18)
        first = False
    for it in items:
        s = str(it or "").strip()
        if not s:
            continue
        add_rich_paragraph(tf, s, body_size, th, first=first, space_after=5, line_spacing=1.32)
        first = False


# Gemini修改：统一卡片/时间轴字段别名兼容与非空正文兜底
def normalize_card(item, default_title: str = "要点"):
    if not isinstance(item, dict):
        txt = str(item or "").strip()
        return default_title, ([txt] if txt else [f"围绕「{default_title}」展开核心分析"])

    title = ""
    for k in ("title", "heading", "label", "step", "name"):
        v = str(item.get(k) or "").strip()
        if v:
            title = v
            break
    if not title:
        title = default_title

    items = []
    raw_bullets = item.get("bullets")
    if isinstance(raw_bullets, (list, tuple)):
        items = [str(x).strip() for x in raw_bullets if str(x or "").strip()]
    elif isinstance(raw_bullets, str) and raw_bullets.strip():
        items = [ln.strip() for ln in raw_bullets.splitlines() if ln.strip()]

    if not items:
        for k in ("body", "desc", "description", "text", "content", "summary", "detail"):
            v = item.get(k)
            if isinstance(v, (list, tuple)):
                items = [str(x).strip() for x in v if str(x or "").strip()]
            elif v is not None and str(v).strip():
                items = [ln.strip() for ln in str(v).splitlines() if ln.strip()]
            if items:
                break

    if not items:
        val = str(item.get("value") or item.get("metric") or "").strip()
        if val and val != title:
            items = [f"核心指标：{val}"]
        elif re.search(r"[:：—–-]", title):
            parts = re.split(r"[:：—–-]", title, maxsplit=1)
            if len(parts) > 1 and parts[1].strip():
                items = [parts[1].strip()]
        if not items:
            items = [f"围绕「{title}」展开核心分析与数据支撑"]
    return title, items


def render_grid_2x2(slide, s: dict, th: dict, max_y: float):
    cards = s.get("cards") or []
    if not cards and s.get("bullets"):
        cards = [{"title": f"要点 {i+1:02d}", "body": b} for i, b in enumerate(s["bullets"][:4])]
    cw, ch = 5.95, min(2.28, (max_y - 1.35 - 0.25) / 2)
    coords = [(0.55, 1.35), (6.83, 1.35), (0.55, 1.35 + ch + 0.25), (6.83, 1.35 + ch + 0.25)]
    for i, card in enumerate(cards[:4]):
        cx, cy = coords[i]
        ctitle, citems = normalize_card(card, f"维度 {i+1:02d}")
        render_card_body(slide, cx, cy, cw, ch, ctitle, citems, th, accent_pos="left")


def render_cols_3(slide, s: dict, th: dict, max_y: float):
    cols = s.get("cols") or s.get("cards") or []
    if not cols and s.get("bullets"):
        cols = [{"heading": f"模块 {i+1:02d}", "bullets": [b]} for i, b in enumerate(s["bullets"][:3])]
    cw = 3.90
    ch = max_y - 1.35
    gap = 0.265
    for i, col in enumerate(cols[:3]):
        cx = 0.55 + i * (cw + gap)
        draw_card(slide, cx, 1.35, cw, ch, th, accent_pos="none")
        # 顶部色块标题区
        draw_rect(slide, cx + 0.02, 1.37, cw - 0.04, 0.58, th["primary"] if not th["dark"] else th["tint"], rounded=False)
        tf_h = add_textbox(slide, cx + 0.14, 1.43, cw - 0.28, 0.46, shrink=True)
        heading, items = normalize_card(col, f"方向 {i+1:02d}")
        add_rich_paragraph(tf_h, heading, 15, th, bold_default=True, color=th["white"] if not th["dark"] else th["accent"], first=True, space_after=0)

        tf_b = add_textbox(slide, cx + 0.16, 2.08, cw - 0.32, ch - 0.85, shrink=True)
        for j, it in enumerate(items):
            add_rich_paragraph(tf_b, f"▪ {it}", 13, th, first=(j == 0), space_after=7, line_spacing=1.32)


def render_kpi_cards(slide, s: dict, th: dict, max_y: float):
    from pptx.enum.text import PP_ALIGN
    cards = s.get("cards") or []
    if not cards and s.get("bullets"):
        for b in s["bullets"][:4]:
            parts = re.split(r"[:：|]", str(b), maxsplit=2)
            cards.append({"value": parts[0].strip(), "label": parts[1].strip() if len(parts) > 1 else "", "desc": parts[2].strip() if len(parts) > 2 else ""})
    n = max(1, min(4, len(cards)))
    gap = 0.25
    cw = (12.23 - gap * (n - 1)) / n
    ch = max_y - 1.45
    for i, card in enumerate(cards[:4]):
        cx = 0.55 + i * (cw + gap)
        draw_card(slide, cx, 1.45, cw, ch, th, accent_pos="top")
        tf = add_textbox(slide, cx + 0.18, 1.70, cw - 0.36, ch - 0.40, shrink=True)
        if not isinstance(card, dict):
            card = {"label": f"指标 {i+1:02d}", "desc": str(card)}
        val = str(card.get("value") or card.get("metric") or card.get("num") or "—")
        lbl = ""
        for k in ("label", "title", "heading", "name", "step"):
            v = str(card.get(k) or "").strip()
            if v:
                lbl = v
                break
        desc_parts = []
        for k in ("desc", "body", "description", "text", "content", "summary"):
            v = card.get(k)
            if isinstance(v, (list, tuple)):
                desc_parts = [str(x).strip() for x in v if str(x or "").strip()]
            elif v is not None and str(v).strip():
                desc_parts = [str(v).strip()]
            if desc_parts:
                break
        if not desc_parts and isinstance(card.get("bullets"), (list, tuple)):
            desc_parts = [str(x).strip() for x in card["bullets"] if str(x or "").strip()]
        desc = "\n".join(desc_parts) if desc_parts else (f"核心量化指标：{lbl or val}" if (lbl or val != "—") else "")
        p1 = add_rich_paragraph(tf, val, 32, th, bold_default=True, color=th["accent"], first=True, space_after=8)
        p1.alignment = PP_ALIGN.LEFT
        if lbl:
            add_rich_paragraph(tf, lbl, 15, th, bold_default=True, color=th["primary"] if not th["dark"] else th["text"], first=False, space_after=8)
        if desc:
            add_rich_paragraph(tf, desc, 13, th, color=th["muted"], first=False, space_after=0, line_spacing=1.35)


def render_timeline(slide, s: dict, th: dict, max_y: float):
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.enum.text import PP_ALIGN
    from pptx.util import Inches
    items = s.get("cards") or s.get("steps") or []
    if not items and s.get("bullets"):
        for i, b in enumerate(s["bullets"][:5]):
            parts = re.split(r"[:：]", str(b), maxsplit=1)
            items.append({"title": parts[0].strip(), "body": parts[1].strip() if len(parts) > 1 else str(b)})
    n = max(2, min(5, len(items)))
    gap = 0.22
    cw = (12.23 - gap * (n - 1)) / n
    # 横向连接线
    draw_rect(slide, 0.55 + cw / 2, 1.82, 12.23 - cw, 0.04, th["accent"])
    ch = max_y - 2.30
    for i, it in enumerate(items[:n]):
        cx = 0.55 + i * (cw + gap)
        # 圆形编号节点
        circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(cx + cw / 2 - 0.26), Inches(1.58), Inches(0.52), Inches(0.52))
        circle.fill.solid()
        circle.fill.fore_color.rgb = th["accent"]
        circle.line.fill.background()
        tf_c = circle.text_frame
        tf_c.margin_left = tf_c.margin_right = tf_c.margin_top = tf_c.margin_bottom = 0
        pc = add_rich_paragraph(tf_c, f"{i+1:02d}", 14, th, bold_default=True, color=th["white"], first=True, space_after=0)
        pc.alignment = PP_ALIGN.CENTER

        it_title, it_items = normalize_card(it, f"阶段 {i+1}")
        render_card_body(slide, cx, 2.28, cw, ch, it_title, it_items, th, accent_pos="top", title_size=14.5, body_size=12.5)


# Gemini修改：修复 dict/Markdown 表格解析，彻底消除 headerrows 字面量渲染 Bug
def _parse_md_table_lines(lines: list) -> list:
    parsed = []
    for ln in lines:
        txt = str(ln or "").strip()
        if "|" not in txt:
            continue
        cells = [c.strip() for c in txt.strip().strip("|").split("|")]
        if cells and all(re.match(r"^:?-{2,}:?$", c or "---") for c in cells):
            continue
        if any(cells):
            parsed.append(cells)
    return parsed


def normalize_table_rows(s: dict) -> list:
    tbl = s.get("table")
    if tbl is None:
        tbl = s.get("rows")
    if tbl is None:
        return []

    rows = []
    top_headers = s.get("headerRows") or s.get("headers") or s.get("header") or s.get("columns")

    if isinstance(tbl, str):
        return _parse_md_table_lines(tbl.splitlines())

    if isinstance(tbl, dict):
        hdr = tbl.get("headerRows") or tbl.get("headers") or tbl.get("header") or tbl.get("columns") or top_headers
        body = tbl.get("rows") or tbl.get("data") or tbl.get("body") or []
        header_keys = None
        if isinstance(hdr, (list, tuple)) and hdr:
            if isinstance(hdr[0], (list, tuple)):
                for hr in hdr:
                    rows.append([str(c) for c in hr])
                header_keys = [str(c) for c in hdr[-1]]
            else:
                header_keys = [str(c) for c in hdr]
                rows.append(header_keys)
        if isinstance(body, str):
            rows.extend(_parse_md_table_lines(body.splitlines()))
        elif isinstance(body, (list, tuple)):
            for r in body:
                if isinstance(r, (list, tuple)):
                    rows.append([str(c) for c in r])
                elif isinstance(r, dict):
                    keys = header_keys or list(r.keys())
                    if not rows and keys:
                        rows.append([str(k) for k in keys])
                        header_keys = [str(k) for k in keys]
                    rows.append([str(r.get(k, "")) for k in keys])
                elif isinstance(r, str) and "|" in r:
                    rows.extend(_parse_md_table_lines([r]))
        return rows

    if isinstance(tbl, (list, tuple)):
        header_keys = None
        if isinstance(top_headers, (list, tuple)) and top_headers:
            if isinstance(top_headers[0], (list, tuple)):
                for hr in top_headers:
                    rows.append([str(c) for c in hr])
                header_keys = [str(c) for c in top_headers[-1]]
            else:
                header_keys = [str(c) for c in top_headers]
                rows.append(header_keys)
        if all(isinstance(r, str) for r in tbl):
            rows.extend(_parse_md_table_lines(list(tbl)))
            return rows
        for r in tbl:
            if isinstance(r, (list, tuple)):
                rows.append([str(c) for c in r])
            elif isinstance(r, dict):
                keys = header_keys or list(r.keys())
                if not rows and keys:
                    rows.append([str(k) for k in keys])
                    header_keys = [str(k) for k in keys]
                rows.append([str(r.get(k, "")) for k in keys])
            elif isinstance(r, str) and "|" in r:
                rows.extend(_parse_md_table_lines([r]))
            else:
                rows.append([str(r)])
    return rows


def render_table(slide, s: dict, th: dict, max_y: float):
    from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
    from pptx.util import Inches, Pt
    rows = normalize_table_rows(s)
    if not rows or not max((len(r) for r in rows), default=0):
        render_bullets_card(slide, s, th, max_y)
        return
    nrows = len(rows)
    ncols = max(len(r) for r in rows)
    th_h = min(max_y - 1.40, max(2.2, nrows * 0.68))
    draw_card(slide, 0.55, 1.35, 12.23, th_h + 0.16, th, accent_pos="none")
    tbl_shape = slide.shapes.add_table(nrows, ncols, Inches(0.67), Inches(1.43), Inches(11.99), Inches(th_h))
    table = tbl_shape.table
    for ri, row in enumerate(rows):
        for ci in range(ncols):
            cell = table.cell(ri, ci)
            val = str(row[ci]) if ci < len(row) else ""
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.margin_left = Inches(0.10)
            cell.margin_right = Inches(0.10)
            cell.margin_top = Inches(0.06)
            cell.margin_bottom = Inches(0.06)
            cell.fill.solid()
            if ri == 0:
                cell.fill.fore_color.rgb = th["primary"]
            elif ri % 2 == 1:
                cell.fill.fore_color.rgb = th["surface"]
            else:
                cell.fill.fore_color.rgb = th["zebra"]
            tf = cell.text_frame
            tf.word_wrap = True
            p = add_rich_paragraph(tf, val, 12.5 if ri > 0 else 13, th, bold_default=(ri == 0),
                                   color=th["white"] if ri == 0 else th["text"], first=True, space_after=0, line_spacing=1.15)
            p.alignment = PP_ALIGN.LEFT if ci == 0 else PP_ALIGN.CENTER


# Gemini修改：新增 matplotlib 高清数据图表自动绘制（支持 line/bar/barh 及多序列）
def _rgb_hex(rgb) -> str:
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def render_chart_stream(chart_spec: dict, th: dict, aspect: float = 1.65):
    if not isinstance(chart_spec, dict):
        return None
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.font_manager import FontProperties
    except Exception:
        return None

    labels = [str(x) for x in (chart_spec.get("labels") or chart_spec.get("categories") or chart_spec.get("x") or [])]
    raw_series = chart_spec.get("series") or []
    series_list = []

    if isinstance(raw_series, (list, tuple)) and raw_series:
        for idx, sr in enumerate(raw_series):
            if isinstance(sr, dict):
                vals = sr.get("values") or sr.get("data") or sr.get("y") or []
                series_list.append((str(sr.get("name") or sr.get("label") or f"系列{idx+1}"), [float(v) for v in vals]))
            elif isinstance(sr, (list, tuple)):
                series_list.append((f"系列{idx+1}", [float(v) for v in sr]))
    else:
        raw_data = chart_spec.get("values") if chart_spec.get("values") is not None else (chart_spec.get("data") if chart_spec.get("data") is not None else chart_spec.get("y"))
        if isinstance(raw_data, (list, tuple)) and raw_data:
            if isinstance(raw_data[0], dict):
                if not labels:
                    labels = [str(d.get("label") or d.get("name") or d.get("x") or i + 1) for i, d in enumerate(raw_data)]
                vals = [float(d.get("value") if d.get("value") is not None else (d.get("y") or 0)) for d in raw_data]
                series_list.append((str(chart_spec.get("seriesName") or chart_spec.get("unit") or "数值"), vals))
            else:
                series_list.append((str(chart_spec.get("seriesName") or chart_spec.get("unit") or "数值"), [float(v) for v in raw_data]))

    if not series_list or not series_list[0][1]:
        return None
    if not labels:
        labels = [str(i + 1) for i in range(len(series_list[0][1]))]

    fp = None
    for fpath in ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"):
        if os.path.exists(fpath):
            fp = FontProperties(fname=fpath)
            break

    fig_w = 7.6
    fig_h = max(3.6, fig_w / max(1.1, aspect))
    bg_hex = _rgb_hex(th["surface"])
    pri_hex = _rgb_hex(th["primary"])
    acc_hex = _rgb_hex(th["accent"])
    txt_hex = _rgb_hex(th["text"])
    mut_hex = _rgb_hex(th["muted"])
    palette = [acc_hex, pri_hex, "#10B981", "#F59E0B", "#8B5CF6"]

    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=200)
    fig.patch.set_facecolor(bg_hex)
    ax.set_facecolor(bg_hex)

    ctype = str(chart_spec.get("type") or chart_spec.get("kind") or "line").lower()
    show_vals = chart_spec.get("show_values", True)
    x_pos = list(range(len(labels)))

    if ctype in ("barh", "hbar", "horizontal_bar"):
        n_s = len(series_list)
        bh = 0.72 / max(1, n_s)
        for si, (sname, svals) in enumerate(series_list):
            offs = [p + (si - (n_s - 1) / 2) * bh for p in x_pos[:len(svals)]]
            bars = ax.barh(offs, svals, height=bh * 0.88, color=palette[si % len(palette)], label=sname, alpha=0.92)
            if show_vals:
                for b in bars:
                    w = b.get_width()
                    ax.text(w, b.get_y() + b.get_height() / 2, f" {w:g}", va="center", ha="left", fontsize=9.5, color=txt_hex, fontproperties=fp)
        ax.set_yticks(x_pos)
        ax.set_yticklabels(labels, fontproperties=fp, fontsize=10, color=txt_hex)
        ax.invert_yaxis()
        ax.grid(axis="x", linestyle="--", alpha=0.25, color=mut_hex)
    elif ctype in ("bar", "column", "柱状图"):
        n_s = len(series_list)
        bw = 0.72 / max(1, n_s)
        for si, (sname, svals) in enumerate(series_list):
            offs = [p + (si - (n_s - 1) / 2) * bw for p in x_pos[:len(svals)]]
            bars = ax.bar(offs, svals, width=bw * 0.88, color=palette[si % len(palette)], label=sname, alpha=0.92)
            if show_vals:
                for b in bars:
                    h = b.get_height()
                    ax.text(b.get_x() + b.get_width() / 2, h, f"{h:g}", va="bottom", ha="center", fontsize=9.5, color=txt_hex, fontproperties=fp)
        ax.set_xticks(x_pos)
        ax.set_xticklabels(labels, fontproperties=fp, fontsize=10, color=txt_hex)
        ax.grid(axis="y", linestyle="--", alpha=0.25, color=mut_hex)
    else:
        for si, (sname, svals) in enumerate(series_list):
            col = palette[si % len(palette)]
            xs = x_pos[:len(svals)]
            ax.plot(xs, svals, marker="o", linewidth=2.6, markersize=7, color=col, label=sname)
            if len(series_list) == 1:
                ax.fill_between(xs, svals, min(svals) - (max(svals) - min(svals) or 1) * 0.18, color=col, alpha=0.10)
            if show_vals:
                for xi, yi in zip(xs, svals):
                    ax.annotate(f"{yi:g}", (xi, yi), textcoords="offset points", xytext=(0, 8), ha="center", fontsize=10, fontweight="bold", color=txt_hex, fontproperties=fp)
        ax.set_xticks(x_pos)
        ax.set_xticklabels(labels, fontproperties=fp, fontsize=10, color=txt_hex)
        ax.grid(axis="y", linestyle="--", alpha=0.25, color=mut_hex)

    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color(mut_hex)
        ax.spines[spine].set_alpha(0.35)
    ax.tick_params(colors=txt_hex, labelsize=9.5)

    ctitle = str(chart_spec.get("title") or "").strip()
    if ctitle:
        ax.set_title(ctitle, fontproperties=fp, fontsize=12.5, fontweight="bold", color=txt_hex, pad=12)
    unit = str(chart_spec.get("unit") or chart_spec.get("ylabel") or "").strip()
    if unit:
        if ctype in ("barh", "hbar", "horizontal_bar"):
            ax.set_xlabel(unit, fontproperties=fp, fontsize=9.5, color=mut_hex)
        else:
            ax.set_ylabel(unit, fontproperties=fp, fontsize=9.5, color=mut_hex)
    if len(series_list) > 1:
        ax.legend(prop=fp, frameon=False, loc="best")

    plt.tight_layout(pad=1.0)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=200, facecolor=bg_hex)
    plt.close(fig)
    buf.seek(0)
    return buf


def render_chart(slide, s: dict, th: dict, max_y: float):
    ch = max_y - 1.35
    chart_spec = s.get("chart") if isinstance(s.get("chart"), dict) else s
    has_left = bool(s.get("bullets") or s.get("cards") or s.get("left") or s.get("insight"))
    if has_left:
        render_split_visual(slide, s, th, max_y)
        return
    draw_card(slide, 0.55, 1.35, 12.23, ch, th, accent_pos="top")
    buf = render_chart_stream(chart_spec, th, aspect=11.8 / max(2.5, ch - 0.35))
    if buf:
        add_picture_fit(slide, buf, 0.72, 1.50, 11.89, ch - 0.30)
    else:
        render_bullets_card(slide, s, th, max_y)


def render_split_visual(slide, s: dict, th: dict, max_y: float):
    ch = max_y - 1.35
    left_items = s.get("left") or s.get("bullets") or []
    cards = s.get("cards") or []
    if cards:
        n = min(3, len(cards))
        sub_h = (ch - 0.18 * (n - 1)) / n
        for i, c in enumerate(cards[:3]):
            ctitle, citems = normalize_card(c, f"要点 {i+1:02d}")
            render_card_body(slide, 0.55, 1.35 + i * (sub_h + 0.18), 6.30, sub_h,
                             ctitle, citems,
                             th, accent_pos="left", title_size=14.5, body_size=13)
    else:
        render_card_body(slide, 0.55, 1.35, 6.30, ch, str(s.get("leftTitle") or "核心要点拆解"),
                         [f"▪ {b}" for b in left_items], th, accent_pos="left")

    rx = 7.12
    rw = 5.66
    draw_card(slide, rx, 1.35, rw, ch, th, accent_pos="top")
    chart_spec = s.get("chart")
    if isinstance(chart_spec, dict):
        cbuf = render_chart_stream(chart_spec, th, aspect=(rw - 0.30) / max(2.2, ch - 0.30))
        if cbuf and add_picture_fit(slide, cbuf, rx + 0.15, 1.52, rw - 0.30, ch - 0.30):
            return
    img = pick_slide_image(s)
    if img and add_picture_fit(slide, img, rx + 0.15, 1.52, rw - 0.30, ch - 0.30):
        return
    right_items = s.get("right") or ([s.get("insight")] if s.get("insight") else [])
    tf_r = add_textbox(slide, rx + 0.20, 1.55, rw - 0.40, ch - 0.36, shrink=True)
    add_rich_paragraph(tf_r, str(s.get("rightTitle") or "关键洞察与数据对比"), 16, th, bold_default=True,
                       color=th["accent"] if th["dark"] else th["primary"], first=True, space_after=10)
    for it in (right_items or ["待补充核心图表或对照数据"]):
        add_rich_paragraph(tf_r, f"• {it}", 13.5, th, first=False, space_after=7, line_spacing=1.35)


def render_two_col(slide, s: dict, th: dict, max_y: float):
    ch = max_y - 1.35
    left = s.get("left") or []
    right = s.get("right") or []
    if not left and not right and s.get("bullets"):
        mid = (len(s["bullets"]) + 1) // 2
        left, right = s["bullets"][:mid], s["bullets"][mid:]
    render_card_body(slide, 0.55, 1.35, 5.95, ch, str(s.get("leftTitle") or "要点对比 · 左"), left, th, accent_pos="top")
    render_card_body(slide, 6.83, 1.35, 5.95, ch, str(s.get("rightTitle") or "要点对比 · 右"), right, th, accent_pos="top")


def render_image_layout(slide, s: dict, th: dict, max_y: float, lay: str):
    ch = max_y - 1.35
    img = pick_slide_image(s, "")
    bullets = s.get("bullets") or []
    if lay == "image-full":
        draw_card(slide, 0.55, 1.35, 12.23, ch, th, accent_pos="none")
        if not add_picture_fit(slide, img, 0.72, 1.50, 11.89, ch - 0.30) and bullets:
            render_card_body(slide, 0.55, 1.35, 12.23, ch, "", bullets, th)
        return
    if lay == "image-left":
        draw_card(slide, 0.55, 1.35, 5.75, ch, th, accent_pos="none")
        add_picture_fit(slide, img, 0.70, 1.50, 5.45, ch - 0.30)
        render_card_body(slide, 6.55, 1.35, 6.23, ch, "核心解析", [f"▪ {b}" for b in bullets], th, accent_pos="left")
    else:
        render_card_body(slide, 0.55, 1.35, 6.23, ch, "核心解析", [f"▪ {b}" for b in bullets], th, accent_pos="left")
        draw_card(slide, 7.03, 1.35, 5.75, ch, th, accent_pos="none")
        add_picture_fit(slide, img, 7.18, 1.50, 5.45, ch - 0.30)


def render_bullets_card(slide, s: dict, th: dict, max_y: float):
    bullets = [str(x) for x in (s.get("bullets") or []) if str(x).strip()]
    ch = max_y - 1.35
    if len(bullets) >= 4:
        mid = (len(bullets) + 1) // 2
        render_card_body(slide, 0.55, 1.35, 5.95, ch, "", [f"▪ {b}" for b in bullets[:mid]], th, accent_pos="left")
        render_card_body(slide, 6.83, 1.35, 5.95, ch, "", [f"▪ {b}" for b in bullets[mid:]], th, accent_pos="left")
    else:
        render_card_body(slide, 0.55, 1.35, 12.23, ch, "", [f"▪ {b}" for b in bullets], th, accent_pos="left")


def build_pptx(payload: dict, out: str) -> None:
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    th = resolve_theme(payload.get("theme"))

    slides_in = list(payload.get("slides") or [])
    if not slides_in or str(slides_in[0].get("layout") or "").lower() != "cover":
        slides_in.insert(0, {
            "layout": "cover",
            "title": str(payload.get("title") or "演示文稿"),
            "subtitle": str(payload.get("subtitle") or ""),
            "image": payload.get("cover"),
        })

    total = len(slides_in)
    for idx, s in enumerate(slides_in, 1):
        slide = prs.slides.add_slide(blank)
        lay = str(s.get("layout") or "bullets").lower()
        notes = str(s.get("notes") or "")

        if lay == "cover":
            render_cover(slide, payload, s, th)
        elif lay == "section":
            render_section(slide, s, th)
        else:
            render_chrome(slide, s, idx, total, th)
            max_y = 6.18 if str(s.get("takeaway") or "").strip() else 6.88
            if lay == "grid-2x2":
                render_grid_2x2(slide, s, th, max_y)
            elif lay == "cols-3":
                render_cols_3(slide, s, th, max_y)
            elif lay == "kpi-cards":
                render_kpi_cards(slide, s, th, max_y)
            elif lay == "timeline":
                render_timeline(slide, s, th, max_y)
            elif lay == "table" or ((s.get("table") or s.get("rows")) and lay == "bullets"):
                render_table(slide, s, th, max_y)
            elif lay == "chart" or (s.get("chart") and lay == "bullets"):
                render_chart(slide, s, th, max_y)
            elif lay == "split-visual":
                render_split_visual(slide, s, th, max_y)
            elif lay == "two-col":
                render_two_col(slide, s, th, max_y)
            elif lay in ("image-right", "image-left", "image-full"):
                render_image_layout(slide, s, th, max_y, lay)
            else:
                render_bullets_card(slide, s, th, max_y)

        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    prs.save(out)


def main() -> int:
    if len(sys.argv) < 2:
        die("usage: office_make.py <out.docx|out.pptx>")
    out = sys.argv[1]
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        die(f"stdin 不是合法 JSON: {e}")

    kind = str(payload.get("kind") or ("pptx" if out.endswith(".pptx") else "docx"))
    if kind == "pptx":
        build_pptx(payload, out)
    else:
        build_docx(payload, out)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
