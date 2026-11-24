#!/usr/bin/env python3
"""文字 / LaTeX → PNG。

标准输入 JSON:
{
  "text": "要渲染的内容，可用 $...$ 写行内公式，$$...$$ 独占一行",
  "out": os.path.join(BASE_DIR, 'gen/x.png'),
  "fontsize": 22,          # 可选
  "color": "#111111",      # 可选
  "bg": "white",           # white | transparent | #rrggbb
  "maxwidth": 1080         # 输出像素宽上限（超出等比缩小）
}

支持：
  · 纯中文/英文文本
  · 行内数学 $a^2+b^2=c^2$
  · 整段公式（单独一行 $$...$$）
  · 简单 LaTeX 命令：\\frac \\sqrt \\sum \\int \\alpha …（走 matplotlib mathtext）
不支持：需要真 LaTeX 的宏包（tikz、algorithm2e 等）。
"""
import json
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import os
import re
import sys

CJK_FONTS = [
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]


def pick_font() -> str:
    for f in CJK_FONTS:
        if os.path.exists(f):
            return f
    return ""


def main() -> int:
    try:
        cfg = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(f"stdin 不是合法 JSON: {e}", file=sys.stderr)
        return 2

    text = str(cfg.get("text") or "").strip()
    if not text:
        print("text 不能为空", file=sys.stderr)
        return 2
    out = str(cfg.get("out") or os.path.join(BASE_DIR, 'gen/render.png'))
    fontsize = float(cfg.get("fontsize") or 22)
    color = str(cfg.get("color") or "#111111")
    bg = str(cfg.get("bg") or "white")
    maxwidth = int(cfg.get("maxwidth") or 1080)

    # matplotlib 的 mathtext 只认 $...$，不认 $$...$$（那是 usetex 的写法）。
    # 顺手把「整行是裸 LaTeX」的行也包起来，用户直接贴 \frac{...} 也能渲染。
    text = re.sub(r"\$\$(.+?)\$\$", lambda m: "$" + m.group(1).strip() + "$", text, flags=re.S)
    fixed = []
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith("\\") and "$" not in s:
            fixed.append("$" + s + "$")
        else:
            fixed.append(line)
    text = "\n".join(fixed)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    font_path = pick_font()
    if font_path:
        font_manager.fontManager.addfont(font_path)
        name = font_manager.FontProperties(fname=font_path).get_name()
        matplotlib.rcParams["font.family"] = [name]
    matplotlib.rcParams["mathtext.fontset"] = "cm"
    matplotlib.rcParams["axes.unicode_minus"] = False

    # 估算画布：按字符数和行数粗算，避免文字被裁
    lines = text.split("\n")
    longest = max((len(l) for l in lines), default=10)
    width_in = min(14.0, max(3.0, longest * fontsize * 0.62 / 72))
    height_in = min(18.0, max(1.2, len(lines) * fontsize * 1.55 / 72))

    fig = plt.figure(figsize=(width_in, height_in), dpi=200)
    if bg != "transparent":
        fig.patch.set_facecolor(bg)
    fig.text(0.5, 0.5, text, ha="center", va="center", fontsize=fontsize, color=color,
             linespacing=1.6, wrap=False)

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    fig.savefig(out, dpi=200, bbox_inches="tight", pad_inches=0.25,
                transparent=(bg == "transparent"), facecolor=(None if bg == "transparent" else bg))
    plt.close(fig)

    # 超宽则等比缩到 maxwidth
    try:
        from PIL import Image
        im = Image.open(out)
        if im.width > maxwidth:
            ratio = maxwidth / im.width
            im = im.resize((maxwidth, max(1, int(im.height * ratio))), Image.LANCZOS)
            im.save(out)
        size = os.path.getsize(out)
        print(f"{out}|{im.width}x{im.height}|{size}")
    except Exception:  # noqa: BLE001
        print(f"{out}|?x?|{os.path.getsize(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
