#!/usr/bin/env python3
"""专业数据图表渲染（bar / line / pie / radar），供 chart_generator 工具调用。

stdin 收 JSON：
{
  "chartType": "bar|line|pie|radar",
  "title": "...",
  "labels": ["Q1","Q2"],
  "datasets": [{"name":"同比","values":[5.3,5.0]}],   // 也接受 [[...],[...]]
  "style": "academic|transparent",
  "output": "/path/out.png",
  "width": 9.6, "height": 5.4,
  "unit": "%"
}
stdout 只吐一行 JSON：{"ok":true,"path":"...","bytes":N,"w":px,"h":px}
任何异常 → {"ok":false,"error":"..."} 并以非 0 退出。
"""
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
]

STYLES = {
    # 学术/商务：浅灰底、深蓝主色、300dpi
    "academic": {
        "bg": "#FFFFFF", "axes_bg": "#F8FAFC", "grid": "#E2E8F0",
        "palette": ["#1E3A8A", "#2563EB", "#0EA5E9", "#10B981", "#F59E0B", "#8B5CF6"],
        "text": "#0F172A", "muted": "#475569", "dpi": 300, "transparent": False,
    },
    # 透明背景：适合直接叠到 PPT 深色页
    "transparent": {
        "bg": "none", "axes_bg": "none", "grid": "#94A3B8",
        "palette": ["#38BDF8", "#818CF8", "#34D399", "#FBBF24", "#F472B6", "#A78BFA"],
        "text": "#E2E8F0", "muted": "#94A3B8", "dpi": 300, "transparent": True,
    },
}


def die(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:400]}, ensure_ascii=False))
    sys.exit(1)


def pick_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def normalize_datasets(raw, labels):
    """统一成 [(name, [float...]), ...]"""
    out = []
    if not isinstance(raw, (list, tuple)):
        return out
    for i, item in enumerate(raw):
        if isinstance(item, dict):
            name = str(item.get("name") or item.get("label") or f"系列{i+1}")
            vals = item.get("values") or item.get("data") or item.get("y") or []
            out.append((name, [float(v) for v in vals]))
        elif isinstance(item, (list, tuple)):
            out.append((f"系列{i+1}", [float(v) for v in item]))
    return [d for d in out if d[1]]


def apply_font(fp, pltmod):
    if not fp:
        return
    name = font_manager.FontProperties(fname=fp).get_name()
    pltmod.rcParams["font.sans-serif"] = [name, "DejaVu Sans"]
    pltmod.rcParams["font.family"] = "sans-serif"
    pltmod.rcParams["axes.unicode_minus"] = False


def main():
    spec_path = None
    if "--spec" in sys.argv:
        i = sys.argv.index("--spec")
        spec_path = sys.argv[i + 1] if i + 1 < len(sys.argv) else None
    try:
        raw = open(spec_path, encoding="utf-8").read() if spec_path else sys.stdin.read()
        spec = json.loads(raw or "{}")
    except Exception as e:
        die(f"spec 不是合法 JSON: {e}")

    ctype = str(spec.get("chartType") or spec.get("type") or "bar").lower()
    title = str(spec.get("title") or "").strip()
    labels = [str(x) for x in (spec.get("labels") or [])]
    datasets = normalize_datasets(spec.get("datasets") or spec.get("series") or [], labels)
    style_key = str(spec.get("style") or "academic").lower()
    sty = STYLES.get(style_key, STYLES["academic"])
    unit = str(spec.get("unit") or "")
    out = str(spec.get("output") or "").strip()
    w = float(spec.get("width") or 9.6)
    h = float(spec.get("height") or 5.4)

    if not out:
        die("缺少 output 路径")
    if ctype not in ("bar", "line", "pie", "radar"):
        die(f"chartType 只支持 bar / line / pie / radar，收到 {ctype}")
    if not datasets:
        die("datasets 为空（需要 [{\"name\":..., \"values\":[...]}]）")
    if ctype != "radar" and not labels:
        labels = [str(i + 1) for i in range(len(datasets[0][1]))]

    fp = pick_font()
    apply_font(fp, plt)

    fig, ax = plt.subplots(figsize=(w, h))
    fig.patch.set_alpha(0 if sty["transparent"] else 1)
    if not sty["transparent"]:
        fig.patch.set_facecolor(sty["bg"])
    ax.set_facecolor(sty["axes_bg"] if sty["axes_bg"] != "none" else "none")
    palette = sty["palette"]

    if ctype == "bar":
        n = len(datasets)
        width = 0.8 / max(1, n)
        idx = range(len(labels))
        for i, (name, vals) in enumerate(datasets):
            pos = [x + (i - (n - 1) / 2) * width for x in idx]
            bars = ax.bar(pos, vals, width=width, label=name, color=palette[i % len(palette)],
                          edgecolor="none", zorder=3)
            if len(vals) <= 12:
                for b, v in zip(bars, vals):
                    ax.annotate(f"{v:g}{unit}", (b.get_x() + b.get_width() / 2, b.get_height()),
                                textcoords="offset points", xytext=(0, 4), ha="center",
                                fontsize=9, color=sty["muted"])
        ax.set_xticks(list(idx))
        ax.set_xticklabels(labels, fontsize=10, color=sty["text"])
        ax.legend(frameon=False, fontsize=9, labelcolor=sty["text"])
        ax.grid(axis="y", color=sty["grid"], linewidth=0.8, alpha=0.7, zorder=0)

    elif ctype == "line":
        for i, (name, vals) in enumerate(datasets):
            xs = list(range(len(vals)))
            ax.plot(xs, vals, marker="o", markersize=6, linewidth=2.6,
                    label=name, color=palette[i % len(palette)], zorder=3,
                    markerfacecolor=palette[i % len(palette)], markeredgewidth=0)
            if len(vals) <= 14:
                for x, v in zip(xs, vals):
                    ax.annotate(f"{v:g}{unit}", (x, v), textcoords="offset points",
                                xytext=(0, 8), ha="center", fontsize=9, color=sty["muted"])
        ax.set_xticks(list(range(len(labels))))
        ax.set_xticklabels(labels, fontsize=10, color=sty["text"])
        ax.legend(frameon=False, fontsize=9, labelcolor=sty["text"])
        ax.grid(True, color=sty["grid"], linewidth=0.8, alpha=0.7, zorder=0)

    elif ctype == "pie":
        vals = datasets[0][1]
        colors = [palette[i % len(palette)] for i in range(len(vals))]
        wedges, texts, autotexts = ax.pie(
            vals, labels=labels[:len(vals)], colors=colors, autopct="%1.1f%%",
            startangle=90, pctdistance=0.78,
            wedgeprops={"width": 0.42, "edgecolor": sty["bg"] if not sty["transparent"] else "none", "linewidth": 2},
            textprops={"fontsize": 10, "color": sty["text"]},
        )
        for t in autotexts:
            t.set_color(sty["text"])
            t.set_fontsize(9)
        ax.axis("equal")

    elif ctype == "radar":
        import math
        n_axis = len(labels) or len(datasets[0][1])
        if not labels:
            labels = [f"维度{i+1}" for i in range(n_axis)]
        angles = [n / float(n_axis) * 2 * math.pi for n in range(n_axis)]
        angles += angles[:1]
        ax.remove()
        ax = fig.add_subplot(111, polar=True)
        ax.set_theta_offset(math.pi / 2)
        ax.set_theta_direction(-1)
        ax.set_xticks(angles[:-1])
        ax.set_xticklabels(labels, fontsize=10, color=sty["text"])
        for i, (name, vals) in enumerate(datasets):
            v = vals[:n_axis]
            v += v[:1]
            c = palette[i % len(palette)]
            ax.plot(angles, v, linewidth=2.2, color=c, label=name, zorder=3)
            ax.fill(angles, v, color=c, alpha=0.18)
        ax.grid(color=sty["grid"], linewidth=0.8, alpha=0.7)
        ax.tick_params(colors=sty["muted"], labelsize=8)
        ax.legend(loc="upper right", bbox_to_anchor=(1.18, 1.10), frameon=False,
                  fontsize=9, labelcolor=sty["text"])
        ax.spines["polar"].set_color(sty["grid"])

    if ctype != "pie":
        for spine in ("top", "right"):
            if spine in ax.spines:
                ax.spines[spine].set_visible(False)
        for spine in ("left", "bottom"):
            if spine in ax.spines:
                ax.spines[spine].set_color(sty["grid"])
        ax.tick_params(colors=sty["muted"], labelsize=9)

    if title:
        fig.suptitle(title, fontsize=15, color=sty["text"], y=0.97,
                     fontweight="bold" if fp else "normal")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    fig.tight_layout(rect=(0, 0, 1, 0.94) if title else None)
    fig.savefig(out, dpi=int(sty["dpi"]), bbox_inches="tight",
                transparent=sty["transparent"], facecolor=sty["bg"] if sty["transparent"] else None)
    plt.close(fig)

    if not os.path.exists(out) or os.path.getsize(out) == 0:
        die("图片写入失败")

    from PIL import Image
    with Image.open(out) as im:
        px_w, px_h = im.size

    print(json.dumps({"ok": True, "path": out, "bytes": os.path.getsize(out),
                      "w": px_w, "h": px_h, "chartType": ctype, "style": style_key,
                      "font": os.path.basename(fp) if fp else "default"},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
