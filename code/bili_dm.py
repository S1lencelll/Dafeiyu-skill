#!/usr/bin/env python3
"""B站私信：列会话 / 读消息 / 发消息（用登录 cookie）。

用法:
  bili_dm.py sessions                 列出最近会话
  bili_dm.py msgs <talker_id> [size]  读某个对话的消息
  bili_dm.py send <receiver_id> <文本> 发一条私信
"""
import json
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import sys
import time
import urllib.parse
import urllib.request

ACCOUNT = os.path.join(BASE_DIR, 'bili-account.json')
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"


def cookie() -> str:
    return json.load(open(ACCOUNT, encoding="utf-8")).get("cookie", "")


def cookie_val(name: str) -> str:
    for part in cookie().split("; "):
        if part.startswith(name + "="):
            return part.split("=", 1)[1]
    return ""


def headers() -> dict:
    return {
        "User-Agent": UA,
        "Referer": "https://message.bilibili.com/",
        "Origin": "https://message.bilibili.com",
        "Cookie": cookie(),
    }


def get(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers()), timeout=20) as r:
        return json.loads(r.read())


def post(url: str, form: dict) -> dict:
    body = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=body, headers={
        **headers(), "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read())


def dev_id() -> str:
    # B站 IM 用 uuid 风格的 dev_id；优先用 cookie 里现成的 buvid3，否则自己造一个固定值
    b = cookie_val("buvid3")
    return b.split("infoc")[0] if b else "00000000-0000-0000-0000-000000000000"


def cmd_sessions() -> int:
    d = get("https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions"
            "?session_type=1&group_id=0&build=0&mobi_app=web")
    if d.get("code") != 0:
        print(f"拉会话失败 code={d.get('code')} {d.get('message')}")
        return 1
    sessions = (d.get("data") or {}).get("session_list") or []
    if not sessions:
        print("没有私信会话。")
        return 0
    for s in sessions[:20]:
        who = (s.get("account_info") or {}).get("name", "?")
        last = (s.get("last_msg") or {})
        try:
            content = json.loads(last.get("content", "{}")).get("content", "")
        except Exception:
            content = ""
        unread = s.get("unread_count", 0)
        print(f"· {who}（talker={s.get('talker_id')}）未读 {unread}｜{str(content)[:60]}")
    return 0


def cmd_msgs(talker: str, size: int = 20) -> int:
    d = get("https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs"
            f"?talker_id={talker}&session_type=1&size={size}&build=0&mobi_app=web")
    if d.get("code") != 0:
        print(f"拉消息失败 code={d.get('code')} {d.get('message')}")
        return 1
    msgs = (d.get("data") or {}).get("messages") or []
    self_uid = cookie_val("DedeUserID")
    for m in reversed(msgs):
        try:
            c = json.loads(m.get("content", "{}"))
            text = c.get("content", "") if isinstance(c, dict) else str(c)
        except Exception:
            text = str(m.get("content"))[:100]
        who = "我" if str(m.get("sender_uid")) == self_uid else str(m.get("sender_uid"))
        ts = time.strftime("%m-%d %H:%M", time.localtime(m.get("timestamp", 0)))
        print(f"[{ts}] {who}: {text[:120]}")
    return 0


def cmd_send(receiver: str, text: str) -> int:
    token = cookie_val("bili_jct")
    if not token:
        print("cookie 里没有 bili_jct")
        return 2
    self_uid = cookie_val("DedeUserID")
    if not self_uid:
        print("cookie 里没有 DedeUserID")
        return 2
    content = json.dumps({"content": text}, ensure_ascii=False)
    form = {
        "msg[sender_uid]": self_uid,
        "msg[receiver_id]": receiver,
        "msg[receiver_type]": 1,
        "msg[msg_type]": 1,
        "msg[msg_status]": 0,
        "msg[dev_id]": dev_id(),
        "msg[timestamp]": int(time.time()),
        "msg[new_face_version]": 0,
        "msg[content]": content,
        "csrf": token,
        "csrf_token": token,
        "build": 0,
        "mobi_app": "web",
    }
    res = post("https://api.vc.bilibili.com/web_im/v1/web_im/send_msg", form)
    if res.get("code") == 0:
        print(f"已发送 msg_key={(res.get('data') or {}).get('msg_key')}")
        return 0
    print(f"发送失败 code={res.get('code')} {res.get('message')}")
    return 1


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "sessions":
        return cmd_sessions()
    if cmd == "msgs" and len(sys.argv) > 2:
        return cmd_msgs(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 20)
    if cmd == "send" and len(sys.argv) > 3:
        return cmd_send(sys.argv[2], " ".join(sys.argv[3:]))
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
