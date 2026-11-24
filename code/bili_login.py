#!/usr/bin/env python3
"""B站扫码登录（独立进程，不依赖调用它的 MCP 进程）。

用法: bili_login.py <key> [--timeout 300]
  key: group:群号 或 private:QQ号 —— 二维码和结果都发到这里

成功写 bili-account.json（含 cookie / uid / uname）。
"""
import base64
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
ACCOUNT_FILE = os.path.join(BASE_DIR, 'bili-account.json')
ONEBOT_BASE = "http://127.0.0.1:3000"
ONEBOT_TOKEN = "UXv6FY05PNp4ULsj8hEh5iIfp14n5zOY"


def log(msg: str) -> None:
    print(f"[bili_login] {msg}", flush=True)


def parse_key(key: str):
    m = re.match(r"^(group|private):(\d+)$", key.strip())
    if not m:
        raise SystemExit("key 要写成 group:群号 或 private:QQ号")
    return m.group(1), m.group(2)


def onebot(action: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{ONEBOT_BASE}/{action}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {ONEBOT_TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read() or b"{}")


def send_text(kind: str, target: str, text: str) -> None:
    try:
        if kind == "group":
            onebot("send_group_msg", {"group_id": int(target), "message": text})
        else:
            onebot("send_private_msg", {"user_id": int(target), "message": text})
    except Exception as e:  # noqa: BLE001
        log(f"发消息失败: {e}")


def send_image(kind: str, target: str, png: bytes) -> None:
    seg = [{"type": "image", "data": {"file": "base64://" + base64.b64encode(png).decode()}}]
    if kind == "group":
        onebot("send_group_msg", {"group_id": int(target), "message": seg})
    else:
        onebot("send_private_msg", {"user_id": int(target), "message": seg})


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: bili_login.py <key> [--timeout N]")
    key = sys.argv[1]
    timeout = 300
    if "--timeout" in sys.argv:
        timeout = int(sys.argv[sys.argv.index("--timeout") + 1])
    kind, target = parse_key(key)

    gen = json.loads(urllib.request.urlopen(urllib.request.Request(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
        headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"},
    ), timeout=20).read())
    if gen.get("code") != 0:
        send_text(kind, target, f"拿二维码失败：{str(gen)[:120]}")
        return 1
    url = gen["data"]["url"]
    qkey = gen["data"]["qrcode_key"]

    png = subprocess.run([sys.executable, os.path.join(BASE_DIR, 'qr.py'), url],
                         capture_output=True, timeout=30).stdout
    if not png:
        send_text(kind, target, "二维码生成失败（缺 qrcode 库？）")
        return 1
    send_image(kind, target, png)
    log(f"二维码已发到 {key}，等待扫码…")

    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        time.sleep(3)
        try:
            req = urllib.request.Request(
                "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
                f"?qrcode_key={urllib.parse.quote(qkey)}&source=main-fe-header",
                headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                cookies = resp.headers.get_all("Set-Cookie") or []
                data = json.loads(resp.read())
        except Exception as e:  # noqa: BLE001
            log(f"轮询出错: {e}")
            continue

        code = (data.get("data") or {}).get("code")
        if code in (86101, 86090):
            if code != last:
                log("未扫码" if code == 86101 else "已扫码，等确认")
                last = code
            continue
        if code == 86038:
            send_text(kind, target, "二维码过期了，再发一次「登录B站」就行。")
            return 1
        if code != 0:
            continue

        jar = "; ".join(c.split(";")[0] for c in cookies if c.split(";")[0].strip())
        if not all(n in jar for n in ("SESSDATA", "bili_jct", "DedeUserID")):
            send_text(kind, target, "扫码成功但 cookie 不完整，重试一次。")
            return 1

        uid = (re.search(r"DedeUserID=([^;]+)", jar) or [None, ""])[1]
        uname = ""
        try:
            nav = json.loads(urllib.request.urlopen(urllib.request.Request(
                "https://api.bilibili.com/x/web-interface/nav",
                headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/", "Cookie": jar},
            ), timeout=20).read())
            uname = (nav.get("data") or {}).get("uname") or ""
        except Exception:  # noqa: BLE001
            pass

        with open(ACCOUNT_FILE, "w", encoding="utf-8") as f:
            json.dump({"cookie": jar, "uid": uid, "uname": uname}, f, ensure_ascii=False, indent=2)
        import os
        os.chmod(ACCOUNT_FILE, 0o600)
        log(f"登录成功 uid={uid} uname={uname}")
        send_text(kind, target, f"B站登录成功{'：' + uname if uname else ''}（uid {uid}）。之后的搜索/推荐都走这个账号。")
        return 0

    send_text(kind, target, f"等了 {timeout} 秒没扫上，二维码过期了。要登再发一次「登录B站」。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
