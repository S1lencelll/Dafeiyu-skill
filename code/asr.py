#!/usr/bin/env python3
"""本地中文语音识别：sherpa-onnx + Paraformer（int8）。
用法: asr.py <音频路径> [--max-seconds N]
stdout: 识别文本；stderr: 错误。
音频先经 ffmpeg 转 16kHz 单声道 16bit wav。
"""
import fcntl
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import os
import subprocess
import sys
import tempfile

MODEL_DIR = os.path.join(BASE_DIR, 'asr/paraformer')
MODEL = os.path.join(MODEL_DIR, 'model.int8.onnx')
TOKENS = os.path.join(MODEL_DIR, 'tokens.txt')

_recognizer = None


def get_recognizer():
    global _recognizer
    if _recognizer is None:
        import sherpa_onnx
        _recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=MODEL,
            tokens=TOKENS,
            num_threads=2,
            sample_rate=16000,
            feature_dim=80,
            decoding_method='greedy_search',
            debug=False,
        )
    return _recognizer


def to_wav16k(src: str) -> str:
    out = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-i', src,
         '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', out],
        check=True, timeout=120,
    )
    return out


def transcribe(wav_path: str, max_seconds: float = 300.0) -> str:
    import wave
    import numpy as np
    rec = get_recognizer()
    with wave.open(wav_path, 'rb') as f:
        sample_rate = f.getframerate()
        channels = f.getnchannels()
        n = f.getnframes()
        raw = f.readframes(n)
    if sample_rate != 16000:
        raise RuntimeError(f'采样率不是 16k: {sample_rate}')
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if max_seconds and len(samples) > sample_rate * max_seconds:
        samples = samples[: int(sample_rate * max_seconds)]
    stream = rec.create_stream()
    stream.accept_waveform(sample_rate, samples)
    rec.decode_stream(stream)
    text = getattr(stream.result, 'text', '') or ''
    return text.strip()


def main():
    if len(sys.argv) < 2:
        print('usage: asr.py <audio> [--max-seconds N]', file=sys.stderr)
        return 2
    src = sys.argv[1]
    limit = 300.0
    if '--max-seconds' in sys.argv:
        try:
            limit = float(sys.argv[sys.argv.index('--max-seconds') + 1])
        except Exception:
            pass
    if not os.path.exists(src):
        print(f'文件不存在: {src}', file=sys.stderr)
        return 2
    # 串行化：同一时刻只允许一个识别进程（模型占内存大）
    lock_fd = open('/tmp/qq-asr.lock', 'w')
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    if not os.path.exists(MODEL):
        print(f'模型缺失: {MODEL}', file=sys.stderr)
        return 3
    wav = None
    try:
        wav = to_wav16k(src)
        sys.stdout.write(transcribe(wav, limit))
        return 0
    except Exception as e:
        print(f'识别失败: {e}', file=sys.stderr)
        return 1
    finally:
        if wav and os.path.exists(wav):
            try:
                os.unlink(wav)
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
