#!/usr/bin/env python3
"""漫画/番剧/游戏信息查询：只返回文字元数据。

数据源优先级：
  1. Bangumi（中文资料最全，漫画/小说/游戏）—— 机房被墙，只在隧道通时用
  2. AniList（全球，番剧/漫画，中英日标题）—— 服务器可直连

用法:
  comic_info.py search <关键词> [数量]
  comic_info.py detail <条目ID> [anilist|bgm]
"""
import json
import socket
import sys
import urllib.parse
import urllib.request

UA = "qqdash/1.0"
PROXY = "http://127.0.0.1:19081"
TIMEOUT = 25

ANILIST_GQL = "https://graphql.anilist.co"
BGM_API = "https://api.bgm.tv"


def _open(url, data=None, headers=None, use_proxy=False):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST" if data else "GET")
    if use_proxy:
        op = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
        return op.open(req, timeout=TIMEOUT)
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def tunnel_ok():
    """隧道代理是否可用（用来决定能不能走 Bangumi）。"""
    try:
        _open("https://api.ipify.org", use_proxy=True).read()
        return True
    except Exception:
        return False


# ── AniList ────────────────────────────────────────────
GQL_SEARCH = """
query ($q: String, $page: Int) {
  Page(page: $page, perPage: 8) {
    media(search: $q, type: MANGA, sort: POPULARITY_DESC) {
      id title { romaji native english } format status chapters volumes
      startDate { year month day } averageScore popularity genres
      description(asHtml: false) staff(perPage: 3) { edges { role node { name { full } } } }
    }
  }
}
"""


GQL_SEARCH_ALL = """
query ($q: String, $page: Int) {
  Page(page: $page, perPage: 8) {
    media(search: $q, sort: SEARCH_MATCH) {
      id title { romaji native english } format status chapters volumes
      startDate { year month day } averageScore popularity genres
      description(asHtml: false) staff(perPage: 3) { edges { role node { name { full } } } }
    }
  }
}
"""

GQL_DETAIL = """
query ($id: Int) {
  Media(id: $id) {
    id title { romaji native english } format status chapters volumes
    startDate { year month day } averageScore popularity favourites genres
    description(asHtml: false)
    staff(perPage: 4) { edges { role node { name { full } } } }
  }
}
"""


def gql(query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode()
    with _open(ANILIST_GQL, data=body, headers={"Content-Type": "application/json"}) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    if d.get("errors"):
        raise RuntimeError(str(d["errors"])[:120])
    return d.get("data") or {}


def gql_search(kw, limit=5):
    media = ((gql(GQL_SEARCH, {"q": kw, "page": 1}).get("Page") or {}).get("media") or [])[:limit]
    if not media:
        # AniList 对中文关键词不友好，换 anime 类型再试一次
        try:
            media = ((gql(GQL_SEARCH_ALL, {"q": kw, "page": 1}).get("Page") or {}).get("media") or [])[:limit]
        except Exception:
            media = []
    if not media:
        return f"AniList 上没搜到「{kw}」。"
    lines = [f"搜「{kw}」（AniList）找到 {len(media)} 条："]
    for m in media:
        t = m.get("title") or {}
        name = t.get("native") or t.get("romaji") or "?"
        extra = " / ".join(x for x in (t.get("romaji"), t.get("english")) if x and x != name)
        score = m.get("averageScore")
        year = ((m.get("startDate") or {}).get("year"))
        lines.append(f"· {name}" + (f"（{extra}）" if extra else "") +
                     f" ｜ {m.get('format') or '?'} ｜ 评分 {score or '暂无'} ｜ {year or '年份未知'}")
        lines.append(f"  id={m.get('id')} ｜ 热度 {m.get('popularity') or 0}")
    lines.append("要看详情就用 detail 加 id。")
    return "\n".join(lines)


def gql_detail(mid):
    m = gql(GQL_DETAIL, {"id": int(mid)}).get("Media") or {}
    if not m:
        return f"AniList 上找不到 id={mid}。"
    t = m.get("title") or {}
    name = t.get("native") or t.get("romaji") or "?"
    lines = [name]
    alt = " / ".join(x for x in (t.get("romaji"), t.get("english")) if x and x != name)
    if alt:
        lines.append(alt)
    sd = m.get("startDate") or {}
    date = "-".join(str(x) for x in (sd.get("year"), sd.get("month"), sd.get("day")) if x)
    lines.append(f"id={m.get('id')} ｜ {m.get('format') or '?'} ｜ {m.get('status') or '?'}"
                 f" ｜ 评分 {m.get('averageScore') or '暂无'} ｜ {date or '日期未知'}")
    if m.get("chapters") or m.get("volumes"):
        lines.append(f"话数 {m.get('chapters') or '?'} ｜ 册数 {m.get('volumes') or '?'}")
    staff = [e.get("node", {}).get("name", {}).get("full") for e in
             ((m.get("staff") or {}).get("edges") or [])]
    staff = [s for s in staff if s]
    if staff:
        lines.append("主创：" + "、".join(staff[:4]))
    genres = m.get("genres") or []
    if genres:
        lines.append("标签：" + "、".join(genres[:8]))
    import re as _re
    desc = _re.sub(r"<[^>]+>", "", str(m.get("description") or "")).replace("\n", " ").strip()
    if desc:
        lines.append("简介：" + desc[:400])
    return "\n".join(lines)


# ── Bangumi（仅在隧道通时启用）──────────────────────────
def bgm_search(kw, limit=5):
    url = f"{BGM_API}/search/subject/{urllib.parse.quote(kw)}?type=1&responseGroup=small&max_results={limit}"
    with _open(url, use_proxy=True) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    items = d.get("results") if isinstance(d, dict) else d
    if not items:
        return None
    lines = [f"搜「{kw}」（Bangumi）找到 {len(items)} 条："]
    for it in items[:limit]:
        name = it.get("name_cn") or it.get("name") or "?"
        score = ((it.get("rating") or {}).get("score")) or 0
        lines.append(f"· {name} ｜ id={it.get('id')} ｜ 评分 {score or '暂无'}"
                     f" ｜ {it.get('air_date') or it.get('date') or '日期未知'}")
    lines.append("要看详情就用 detail 加 id。")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("usage: comic_info.py search|detail <参数>")
        return 2
    cmd = sys.argv[1]
    kw = sys.argv[2] if len(sys.argv) > 2 else ""
    if not kw:
        print("缺参数")
        return 2
    limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 5

    try:
        if cmd == "search":
            # 隧道通就先用 Bangumi（中文名更准），否则用 AniList
            if tunnel_ok():
                try:
                    out = bgm_search(kw, limit)
                    if out:
                        return print(out) or 0
                except Exception:
                    pass
            print(gql_search(kw, limit))
        elif cmd == "detail":
            # 先按 AniList id 试
            print(gql_detail(kw))
        else:
            print("未知子命令")
            return 2
    except Exception as e:
        print(f"查询失败：{str(e)[:160]}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
