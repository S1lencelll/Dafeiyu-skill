#!/usr/bin/env python3
"""读音频 / 视频 / MIDI 文件。

用法:
  media_read.py <文件路径> [--mode audio|video|midi] [--max-seconds N]

音频（mp3/wav/flac/ogg/m4a/aac/wma）：
  ffmpeg 统一转 16k 单声道 wav → 本地 Paraformer ASR → 文字
视频（mp4/avi/rm/rmvb/mkv/mov/flv/wmv/webm）：
  抽音轨 → 同上；顺带返回时长、分辨率、码率
MIDI（mid/midi）：
  用 mido 解析，输出调号/BPM/声部/音域/时长/音符统计（不是转录音频）
"""
import json
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import os
import subprocess
import sys
import tempfile

ASR = os.path.join(BASE_DIR, 'asr.py')
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

AUDIO_EXT = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".opus", ".aiff", ".amr"}
VIDEO_EXT = {".mp4", ".avi", ".rm", ".rmvb", ".mkv", ".mov", ".flv", ".wmv", ".webm", ".m4v", ".3gp"}
MIDI_EXT = {".mid", ".midi"}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def run(cmd, timeout=300):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def probe(path):
    code, out, _ = run([FFPROBE, "-v", "error", "-print_format", "json",
                        "-show_format", "-show_streams", path], timeout=60)
    if code != 0:
        return {}
    try:
        return json.loads(out)
    except Exception:
        return {}


def describe(path):
    """时长/分辨率/码率 + 是否有音轨。"""
    d = probe(path)
    fmt = d.get("format") or {}
    dur = float(fmt.get("duration") or 0)
    bits = []
    if dur:
        bits.append(f"{int(dur // 60)}分{int(dur % 60):02d}秒")
    for s in (d.get("streams") or []):
        if s.get("codec_type") == "video":
            w, h = s.get("width"), s.get("height")
            if w and h:
                bits.append(f"{w}×{h}")
            if s.get("r_frame_rate"):
                bits.append(f"{s['r_frame_rate']}fps")
            break
    if fmt.get("bit_rate"):
        try:
            bits.append(f"{int(fmt['bit_rate']) // 1000}kbps")
        except Exception:
            pass
    has_audio = any(s.get("codec_type") == "audio" for s in (d.get("streams") or []))
    return "｜".join(bits), dur, has_audio


def to_wav(path, out, max_seconds=600):
    """转 16k 单声道 wav；超长截断。"""
    code, _, err = run([FFMPEG, "-y", "-v", "error", "-i", path,
                        "-t", str(max_seconds), "-vn",
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], timeout=600)
    if code != 0 or not os.path.exists(out) or os.path.getsize(out) < 1000:
        raise RuntimeError(f"转码失败：{err.strip()[:200]}")
    return out


def transcribe(wav, max_seconds):
    code, out, err = run(["python3", ASR, wav, "--max-seconds", str(max_seconds)], timeout=900)
    if code != 0:
        raise RuntimeError(f"ASR 失败：{err.strip()[:200]}")
    return out.strip()


def norm_key(sharps):
    """调号：正数升号，负数降号。"""
    table = {
        0: "C 大调 / A 小调", 1: "G 大调 / E 小调", 2: "D 大调 / B 小调",
        3: "A 大调 / F# 小调", 4: "E 大调 / C# 小调", 5: "B 大调 / G# 小调",
        6: "F# 大调 / D# 小调", 7: "C# 大调 / A# 小调",
        -1: "F 大调 / D 小调", -2: "Bb 大调 / G 小调", -3: "Eb 大调 / C 小调",
        -4: "Ab 大调 / F 小调", -5: "Db 大调 / Bb 小调", -6: "Gb 大调 / Eb 小调",
        -7: "Cb 大调 / Ab 小调",
    }
    return table.get(sharps, f"{sharps:+d} 个升降号")


def midi_info(path):
    try:
        import mido
    except ImportError:
        return "服务器缺 mido 库，跑：pip install mido"

    mid = mido.MidiFile(path)
    # 合并所有轨道的 note 事件，按时间排序
    tempos = []
    keysigs = []
    notes = []
    tracks_used = set()
    for ti, track in enumerate(mid.tracks):
        tick = 0
        for msg in track:
            tick += msg.time
            if msg.type == "set_tempo":
                tempos.append(mido.tempo2bpm(msg.tempo))
            elif msg.type == "key_signature":
                keysigs.append(msg.key)
            elif msg.type == "note_on" and msg.velocity > 0:
                notes.append({"t": tick, "p": msg.note, "v": msg.velocity, "tr": ti})
                tracks_used.add(ti)

    if not notes:
        return "这个 MIDI 里没有音符。"

    pitches = [n["p"] for n in notes]
    lo, hi = min(pitches), max(pitches)
    bpm = round(tempos[0], 1) if tempos else 120.0
    secs = mid.length

    # 音域跨了几个八度
    span = (hi - lo) / 12

    # 拍号
    timesigs = []
    for track in mid.tracks:
        for msg in track:
            if msg.type == "time_signature":
                timesigs.append(f"{msg.numerator}/{msg.denominator}")

    # 每小节平均音符数（粗略）
    density = len(notes) / max(1, secs)

    def note_name(p):
        return f"{NOTE_NAMES[p % 12]}{p // 12 - 1}"

    lines = [
        f"格式 {mid.type}｜{len(mid.tracks)} 轨｜{len(notes)} 个音符｜"
        f"{int(secs // 60)}分{int(secs % 60):02d}秒",
        f"速度 {bpm} BPM" + (f"（变化 {len(set(round(t,1) for t in tempos))} 次）" if len(set(tempos)) > 1 else ""),
    ]
    if timesigs:
        lines.append("拍号 " + "、".join(sorted(set(timesigs))))
    if keysigs:
        # mido 给的是 'C' / 'F#m' 这种
        lines.append("调号 " + "、".join(sorted(set(keysigs))))
    lines.append(f"音域 {note_name(lo)} ~ {note_name(hi)}（跨 {span:.1f} 个八度）")
    lines.append(f"密度 平均每秒 {density:.1f} 个音")
    if tracks_used:
        lines.append(f"有音符的轨道：{len(tracks_used)} 条")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("usage: media_read.py <文件路径> [--max-seconds N]")
        return 2
    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"文件不存在：{path}")
        return 2
    max_seconds = 600
    if "--max-seconds" in sys.argv:
        try:
            max_seconds = int(sys.argv[sys.argv.index("--max-seconds") + 1])
        except Exception:
            pass

    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in MIDI_EXT:
            print(midi_info(path))
            return 0

        if ext not in AUDIO_EXT and ext not in VIDEO_EXT:
            print(f"不支持的格式「{ext}」，支持音频 {sorted(AUDIO_EXT)} 和视频 {sorted(VIDEO_EXT)}")
            return 2

        meta, dur, has_audio = describe(path)
        kind = "视频" if ext in VIDEO_EXT else "音频"

        if not has_audio:
            print(f"【{kind}】{ext[1:].upper()}" + (f" · {meta}" if meta else ""))
            print("这个文件没有音轨，听不出内容。" if ext in VIDEO_EXT
                  else "这个文件里没有可解析的音轨。")
            return 0

        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            to_wav(path, wav, max_seconds)
            text = transcribe(wav, max_seconds)
        finally:
            try:
                os.unlink(wav)
            except Exception:
                pass

        head = f"【{kind}】{ext[1:].upper()}" + (f" · {meta}" if meta else "")
        if dur > max_seconds:
            head += f"（只处理了前 {max_seconds // 60} 分钟）"
        print(head)
        print(text if text else "(没识别出语音)")
        return 0
    except Exception as e:
        print(f"读取失败：{str(e)[:300]}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
