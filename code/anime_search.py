#!/usr/bin/env python3
"""以图搜图：ascii2d / AnimeTrace / SauceNAO / TraceMoe / 搜图bot酱 / AI鉴别。

用法:
  anime_search.py url <图片URL> [源...]
  anime_search.py file <本地路径> [源...]

源（默认全开）：ascii2d animetrace saucenao tracemoe soutubot aidefect
"""
import json
import re
import sys
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
TIMEOUT = 30
SAUCENAO_KEY = ""
MAX_ITEMS = 3


def die(msg):
    print(msg)
    return 1


def http(url, data=None, headers=None, method=None, timeout=TIMEOUT, raw=False):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return body if raw else body.decode("utf-8", "replace")


# ── ascii2d ─────────────────────────────────────────────
def _a2d_session():
    """拿一次 cookie，绕过 Cloudflare 的基础校验。"""
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPRedirectHandler(),
    )
    opener.addheaders = [
        ("User-Agent", UA),
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
        ("Accept-Language", "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7"),
    ]
    opener.open("https://ascii2d.net/", timeout=TIMEOUT).read()
    return opener


def ascii2d(img_url):
    out = []
    try:
        opener = _a2d_session()
    except Exception as e:
        return [f"[ascii2d] 打开首页失败：{str(e)[:60]}"]
    for kind, path in (("色合", "color"), ("特征", "url")):
        try:
            body = urllib.parse.urlencode({"utf8": "utf-8", "uri": img_url}).encode()
            req = urllib.request.Request(
                f"https://ascii2d.net/search/{path}", data=body,
                headers={"Referer": "https://ascii2d.net/",
                         "Content-Type": "application/x-www-form-urlencoded",
                         "Origin": "https://ascii2d.net"},
            )
            html = opener.open(req, timeout=TIMEOUT).read().decode("utf-8", "replace")
            # 结果条目：media-box 里的外链 + 名称
            hits = re.findall(r'href="(https?://[^"]+)"[^>]*>\s*([^<>]{2,60})\s*</a>', html)
            hits = [(u, t.strip()) for u, t in hits
                    if not any(x in u for x in ("ascii2d.net", "twitter.com/intent", "gravatar", "creativecommons"))]
            if not hits:
                out.append(f"[ascii2d {kind}] 没匹配到")
            else:
                out.append(f"[ascii2d {kind}] " + " ｜ ".join(f"{t} → {u}" for u, t in hits[:2]))
        except Exception as e:
            out.append(f"[ascii2d {kind}] 失败：{str(e)[:50]}")
    return out


# ── AnimeTrace ──────────────────────────────────────────
def animetrace(img_url):
    try:
        body = json.dumps({"image": img_url, "is_multi": 0, "force_one": 1}).encode()
        txt = http("https://ai.animedb.cn/api/detect?force_one=1", data=body,
                   headers={"Content-Type": "application/json", "Referer": "https://ai.animedb.cn/"})
        d = json.loads(txt)
        if not d.get("success"):
            return [f"[AnimeTrace] 无结果（{d.get('code')}）"]
        res = (d.get("data") or [])
        if not res:
            return ["[AnimeTrace] 没有识别出角色"]
        out = []
        for item in res[:MAX_ITEMS]:
            ch = (item.get("character") or [{}])[0].get("name") or "?"
            w = (item.get("work") or {}).get("name") or "?"
            out.append(f"{ch} — 出自《{w}》")
        return ["[AnimeTrace] " + " ｜ ".join(out)]
    except Exception as e:
        return [f"[AnimeTrace] 失败：{str(e)[:60]}"]


# ── SauceNAO ────────────────────────────────────────────
def saucenao(img_url):
    if not SAUCENAO_KEY:
        return ["[SauceNAO] 未配置 key，跳过"]
    try:
        q = urllib.parse.urlencode({"output_type": 2, "api_key": SAUCENAO_KEY,
                                    "numres": MAX_ITEMS, "db": 999, "url": img_url})
        d = json.loads(http("https://saucenao.com/search.php?" + q,
                            headers={"Referer": "https://saucenao.com/"}))
        if d["header"]["status"] != 0:
            return [f"[SauceNAO] 状态 {d['header']['status']}"]
        out = []
        for r in (d.get("results") or [])[:MAX_ITEMS]:
            sim = r.get("header", {}).get("similarity", 0)
            data = r.get("data", {})
            name = data.get("title") or data.get("jp_name") or data.get("eng_name") or "?"
            link = (data.get("ext_urls") or [""])[0]
            out.append(f"{sim}% {name}" + (f" → {link}" if link else ""))
        return ["[SauceNAO] " + " ｜ ".join(out)] if out else ["[SauceNAO] 无结果"]
    except Exception as e:
        return [f"[SauceNAO] 失败：{str(e)[:60]}"]


# ── TraceMoe ────────────────────────────────────────────
def tracemoe(img_url):
    try:
        d = json.loads(http("https://api.trace.moe/search?cutBorders&url=" +
                            urllib.parse.quote(img_url, safe="")))
        res = (d.get("result") or [])[:MAX_ITEMS]
        if not res:
            return ["[TraceMoe] 不是番剧截图或没匹配上"]
        out = []
        for r in res:
            name = r.get("filename") or "?"
            # 文件名 → 作品名：去掉字幕组前缀、所有方括号块、分辨率/编码尾巴
            name = re.sub(r"^\[[^\]]*\]\s*", "", name)
            name = re.sub(r"\[[^\]]*\]", "", name)
            name = re.sub(r"\.(mkv|mp4|avi|webm)$", "", name, flags=re.I)
            name = re.sub(r"(BD|WEB|HD)?\s*\d{3,4}x\d{3,4}.*$", "", name, flags=re.I)
            name = re.sub(r"\s*-\s*\d+\s*$", "", name)
            name = re.sub(r"\s+", " ", name).strip()
            ep = r.get("episode")
            at = int(r.get("from") or 0)
            sim = round((r.get("similarity") or 0) * 100, 1)
            aid = r.get("anilist")
            link = f" https://anilist.co/anime/{aid}" if isinstance(aid, int) else ""
            out.append(f"{name} 第{ep}集 {at // 60}:{at % 60:02d}（{sim}%）{link}")
        return ["[TraceMoe] " + " ｜ ".join(out)]
    except Exception as e:
        return [f"[TraceMoe] 失败：{str(e)[:60]}"]


# ── 搜图bot酱（本子来源）────────────────────────────────
def soutubot(img_url):
    try:
        body = json.dumps({"url": img_url}).encode()
        txt = http("https://api.soutubot.moe/search", data=body,
                   headers={"Content-Type": "application/json", "Referer": "https://soutubot.moe/"})
        d = json.loads(txt)
        items = d if isinstance(d, list) else (d.get("data") or [])
        if not items:
            return ["[搜图bot酱] 没找到"]
        out = []
        for it in items[:MAX_ITEMS]:
            title = it.get("title") or it.get("name") or "?"
            page = it.get("page") or ""
            out.append(f"{title} {page}".strip())
        return ["[搜图bot酱] " + " ｜ ".join(out)]
    except Exception as e:
        return [f"[搜图bot酱] 失败：{str(e)[:60]}"]


# ── AI 图鉴别（Hive） ────────────────────────────────────
def aidefect(img_url):
    try:
        # Hive 的公开 demo 端点是社区逆向的，不稳定；失败就如实说
        q = urllib.parse.urlencode({"url": img_url})
        txt = http("https://api.hivemoderation.com/api/v1/ai-generated?user_id=&" + q)
        d = json.loads(txt)
        classes = (d.get("status") or [{}])[0].get("response", {}).get("output", [{}])[0].get("classes") or {}
        if not classes:
            return ["[AI鉴别] 无结果"]
        top = max(classes.items(), key=lambda kv: kv[1])
        return [f"[AI鉴别] 最可能：{top[0]}（{round(top[1] * 100, 1)}%）"]
    except Exception as e:
        return [f"[AI鉴别] 失败：{str(e)[:60]}"]


SOURCES = {
    "ascii2d": ascii2d,
    "animetrace": animetrace,
    "saucenao": saucenao,
    "tracemoe": tracemoe,
    "soutubot": soutubot,
    "aidefect": aidefect,
}


def main():
    if len(sys.argv) < 3:
        return die("usage: anime_search.py url|file <目标> [源...]")
    mode, target = sys.argv[1], sys.argv[2]
    picks = sys.argv[3:] or list(SOURCES)

    img_url = target
    if mode == "file":
        # 本地图先上传到临时可访问地址不可行；直接说明
        return die("只支持 http(s) 图片地址；本地图请先用 image_post 上传或直接用图库 URL")

    lines = []
    for name in picks:
        fn = SOURCES.get(name)
        if not fn:
            lines.append(f"[{name}] 未知源")
            continue
        lines.extend(fn(img_url))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
