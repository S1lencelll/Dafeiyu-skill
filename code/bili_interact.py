#!/usr/bin/env python3
"""B站互动：拉取 @我的 / 回复我的，并支持回帖。

子命令:
  feed                     列出最近的 @ 和回复
  reply <json>             回帖：{"oid":123,"type":1,"root":0,"parent":456,"message":"…"}

依赖 bili-account.json 里的 cookie（含 bili_jct 作为 csrf）。
"""
import json
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import sys
import urllib.parse
import urllib.request

ACCOUNT_FILE = os.path.join(BASE_DIR, 'bili-account.json')
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"


def cookie() -> str:
    try:
        return json.load(open(ACCOUNT_FILE, encoding="utf-8")).get("cookie", "")
    except Exception:
        return ""


def headers() -> dict:
    return {
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
        "Cookie": cookie(),
    }


def get(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers()), timeout=20) as r:
        return json.loads(r.read())


def post(url: str, form: dict) -> dict:
    body = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=body, headers={
        **headers(),
        "Content-Type": "application/x-www-form-urlencoded",
    }, method="POST")
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read())


def csrf() -> str:
    for part in cookie().split("; "):
        if part.startswith("bili_jct="):
            return part.split("=", 1)[1]
    return ""


def norm(items: list, kind: str) -> list:
    out = []
    for it in items or []:
        item = it.get("item") or {}
        user = it.get("user") or {}
        out.append({
            "id": it.get("id"),
            "kind": kind,
            "from": user.get("nickname", ""),
            "fromMid": user.get("mid"),
            "time": it.get("at_time"),
            "business": item.get("business", ""),
            "title": item.get("title", ""),
            "uri": item.get("uri", ""),
            "content": str(item.get("source_content", ""))[:200],
            "subjectId": item.get("subject_id"),   # oid
            "rootId": item.get("root_id"),
            "sourceId": item.get("source_id"),     # parent
            "type": 17 if "动态" in str(item.get("business", "")) else 1,
        })
    return out


def cmd_feed() -> int:
    at = get("https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web")
    rp = get("https://api.bilibili.com/x/msgfeed/reply?build=0&mobi_app=web")
    if at.get("code") != 0 or rp.get("code") != 0:
        print(f"接口报错 at={at.get('code')} reply={rp.get('code')}")
        return 1
    ats = norm((at.get("data") or {}).get("items"), "at")
    reps = norm((rp.get("data") or {}).get("items"), "reply")
    if not ats and not reps:
        print("没有新的 @ 或回复。")
        return 0
    for group, label in ((ats, "@我"), (reps, "回复我")):
        if not group:
            continue
        print(f"【{label}】{len(group)} 条")
        for x in group[:8]:
            print(f"  · {x['from']}（{x['business']}）{x['title']}")
            print(f"    「{x['content']}」")
            print(f"    oid={x['subjectId']} root={x['rootId']} parent={x['sourceId']} type={x['type']}")
            print(f"    {x['uri']}")
    return 0


def cmd_reply(payload: str) -> int:
    try:
        p = json.loads(payload)
    except Exception as e:  # noqa: BLE001
        print(f"参数不是合法 JSON：{e}")
        return 2
    token = csrf()
    if not token:
        print("cookie 里没有 bili_jct，重新扫码登录")
        return 2
    oid = p.get("oid")
    rtype = int(p.get("type") or 1)
    root = int(p.get("root") or 0)
    parent = int(p.get("parent") or 0)
    message = str(p.get("message") or "").strip()
    if not oid or not message:
        print("需要 oid 和 message")
        return 2
    if len(message) > 900:
        message = message[:900]
    form = {
        "oid": oid, "type": rtype, "root": root, "parent": parent,
        "message": message, "plat": 1, "csrf": token,
    }
    res = post("https://api.bilibili.com/x/v2/reply/add", form)
    if res.get("code") == 0:
        rpid = ((res.get("data") or {}).get("rpid_str")) or ((res.get("data") or {}).get("rpid"))
        print(f"已回帖 rpid={rpid}")
        return 0
    print(f"回帖失败 code={res.get('code')} {res.get('message')}")
    return 1


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: bili_interact.py feed|reply <json>", file=sys.stderr)
        return 2
    if sys.argv[1] == "feed":
        return cmd_feed()
    if sys.argv[1] == "reply":
        return cmd_reply(sys.argv[2] if len(sys.argv) > 2 else "{}")
    print("未知子命令", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
