#!/usr/bin/env python3
"""faster-whisper 转写脚本（guide-dog 插件 STT 后端）。
用法:
  python3 whisper_transcribe.py --audio <path> [--model base|small] [--language auto|zh|en] [--out-file <path>] --output json
  python3 whisper_transcribe.py --audio-b64-file <path> [--delete-b64] [--model base|small] [--language auto|zh|en] [--out-file <path>] --output json
  python3 whisper_transcribe.py --prewarm <dir> [--model base|small] [--out-file <path>] --output json   # 仅下载模型到 <dir>
  python3 whisper_transcribe.py --serve [--model base|small]   # 常驻模式（2026-08-15：实时预览 worker）
    stdin 每行一个 JSON 任务: {"id":N,"b64Path":"...","model":"base","language":"zh"}
    stdout 每行一个 JSON 响应: {"id":N,"ok":true,"text":"...","language":"zh"}（模型懒加载并缓存，进程常驻）
stdout 恒为单行 JSON; exit 恒 0（调用方以 ok 字段判断）。--out-file 可选：同时把同一 JSON 写入文件（host 端读取用）。

模型来源（2026-08-14 修复：huggingface.co 网络不可达）：
  - 优先加载本地目录 ~/.guide-dog/models/faster-whisper-<model>（零网络，插件预热/预下载）
  - 缺失时回退按模型名从 HF 下载；HF_ENDPOINT 默认指向 hf-mirror.com 镜像
"""
import argparse, base64, json, os, sys, tempfile, time

# 必须在 import huggingface_hub / faster_whisper 之前设置：
# huggingface.co 在国内网络不可达（Errno 101），官方镜像 hf-mirror.com 可达（实测 ~2.2MB/s）
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')


def emit(obj, out_file):
    text = json.dumps(obj, ensure_ascii=False)
    print(text)
    if out_file:
        try:
            with open(out_file, 'w', encoding='utf-8') as f:
                f.write(text)
        except Exception:  # noqa: BLE001
            pass
    sys.exit(0)


def resolve_model_ref(model):
    """优先插件本地模型目录（~/.guide-dog/models/faster-whisper-<model>），回退模型名（镜像下载）。"""
    try:
        local = os.path.join(os.path.expanduser('~'), '.guide-dog', 'models', 'faster-whisper-' + model)
        if os.path.isfile(os.path.join(local, 'model.bin')):
            return local
    except Exception:  # noqa: BLE001
        pass
    return model


def _simplify(text, language_arg, info):
    """简体化（2026-08-15 用户需求：中文输入默认转简体）。"""
    try:
        detected_zh = (language_arg == 'zh') or (getattr(info, 'language', None) or '').startswith('zh')
        if detected_zh and text:
            from zhconv import convert as _zh_convert
            text = _zh_convert(text, 'zh-cn')
    except Exception:  # noqa: BLE001
        pass
    return text


def _transcribe_one(model, audio_path, language_arg):
    """单次转写：返回 (ok, obj)。"""
    from faster_whisper import WhisperModel
    t0 = time.time()
    model = WhisperModel(resolve_model_ref(model), device='cpu', compute_type='int8')
    lang = None if language_arg == 'auto' else language_arg
    segments, info = model.transcribe(audio_path, language=lang, vad_filter=True)
    text = ''.join(s.text for s in segments).strip()
    text = _simplify(text, language_arg, info)
    if not text:
        return False, {'error': 'empty_speech', 'message': 'no speech recognized'}
    return True, {'text': text, 'language': getattr(info, 'language', None),
                  'durationMs': int((time.time() - t0) * 1000)}


def serve_main():
    """常驻模式：模型懒加载并缓存；stdin 行 JSON 任务 → stdout 行 JSON 响应（2026-08-15）。"""
    from faster_whisper import WhisperModel
    models = {}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            mid = job.get('id')
            b64_path = job.get('b64Path')
            if not b64_path or not os.path.exists(b64_path):
                print(json.dumps({'id': mid, 'ok': False, 'error': 'bad_args', 'message': 'b64Path missing'}, ensure_ascii=False), flush=True)
                continue
            with open(b64_path, 'r', encoding='utf-8') as f:
                data = base64.b64decode(f.read().strip())
            fd, audio_path = tempfile.mkstemp(suffix='.webm')
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            try:
                model_name = job.get('model') or 'base'
                if model_name not in models:
                    models[model_name] = WhisperModel(resolve_model_ref(model_name), device='cpu', compute_type='int8')
                lang = job.get('language') or 'auto'
                segments, info = models[model_name].transcribe(audio_path, language=None if lang == 'auto' else lang, vad_filter=True)
                text = ''.join(s.text for s in segments).strip()
                text = _simplify(text, lang, info)
                if not text:
                    print(json.dumps({'id': mid, 'ok': False, 'error': 'empty_speech', 'message': 'no speech recognized'}, ensure_ascii=False), flush=True)
                else:
                    print(json.dumps({'id': mid, 'ok': True, 'text': text, 'language': getattr(info, 'language', None)}, ensure_ascii=False), flush=True)
            finally:
                try:
                    if os.path.exists(audio_path): os.unlink(audio_path)
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            print(json.dumps({'id': job.get('id') if 'job' in locals() else None, 'ok': False, 'error': 'stt_failed', 'message': str(e)[:300]}, ensure_ascii=False), flush=True)
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', default=None)
    ap.add_argument('--audio-b64-file', default=None)
    ap.add_argument('--delete-b64', action='store_true')
    ap.add_argument('--model', default='small')
    ap.add_argument('--language', default='auto')
    ap.add_argument('--out-file', default=None)
    ap.add_argument('--output', default='json')
    ap.add_argument('--prewarm', default=None)  # 仅下载模型到 <dir> 后退出（host 启动预热用）
    ap.add_argument('--no-keep-empty', action='store_true')  # 空转写结果不保留诊断副本（partial 预览用）
    ap.add_argument('--serve', action='store_true')  # 常驻 worker（2026-08-15）
    args = ap.parse_args()
    if args.serve:
        serve_main()
        return
    # 预热模式：只下载模型，不转写
    if args.prewarm:
        try:
            from huggingface_hub import snapshot_download
            os.makedirs(args.prewarm, exist_ok=True)
            snapshot_download('Systran/faster-whisper-' + args.model, local_dir=args.prewarm)
            emit({'ok': True, 'prewarm': args.prewarm}, args.out_file)
        except Exception as e:  # noqa: BLE001
            emit({'ok': False, 'error': 'stt_failed', 'message': ('prewarm failed: ' + str(e))[:300]}, args.out_file)
    audio_path = args.audio
    cleanup = []
    try:
        if args.audio_b64_file:
            with open(args.audio_b64_file, 'r', encoding='utf-8') as f:
                data = base64.b64decode(f.read().strip())
            fd, audio_path = tempfile.mkstemp(suffix='.webm')
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            cleanup.append(audio_path)
            if args.delete_b64:
                cleanup.append(args.audio_b64_file)
        if not audio_path or not os.path.exists(audio_path):
            emit({'ok': False, 'error': 'stt_failed', 'message': 'audio file missing'}, args.out_file)
        from faster_whisper import WhisperModel
        t0 = time.time()
        model = WhisperModel(resolve_model_ref(args.model), device='cpu', compute_type='int8')
        lang = None if args.language == 'auto' else args.language
        segments, info = model.transcribe(audio_path, language=lang, vad_filter=True)
        text = ''.join(s.text for s in segments).strip()
        # 简体化（2026-08-15 用户需求：中文输入默认转简体）：显式 zh 或检测为中文时，
        # 用 zhconv 繁→简；未安装时保持原样（不阻塞转写）。zh-cn 转换表对简体输入幂等。
        try:
            detected_zh = (args.language == 'zh') or (getattr(info, 'language', None) or '').startswith('zh')
            if detected_zh and text:
                from zhconv import convert as _zh_convert
                text = _zh_convert(text, 'zh-cn')
        except Exception:  # noqa: BLE001
            pass
        if not text:
            # 诊断（2026-08-15）：保留音频副本供分析（~/.guide-dog/tmp/empty-<ts>.webm），
            # message 带时长信息；副本不随 cleanup 删除（cleanup 只含 b64/原临时文件）。
            # --no-keep-empty（partial 预览转写）时不保留，避免静音片段不断累积副本。
            keep = None
            if not args.no_keep_empty:
                try:
                    import shutil
                    keep_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tmp')
                    os.makedirs(keep_dir, exist_ok=True)
                    keep = os.path.join(keep_dir, 'empty-' + str(int(time.time())) + '.webm')
                    shutil.copyfile(audio_path, keep)
                except Exception:  # noqa: BLE001
                    keep = None
            try:
                dur = round(info.duration, 2) if info and getattr(info, 'duration', None) else -1
            except Exception:  # noqa: BLE001
                dur = -1
            emit({'ok': False, 'error': 'empty_speech', 'message': 'no speech recognized (dur=%ss keep=%s)' % (dur, keep or 'none')}, args.out_file)
        emit({'ok': True, 'text': text, 'language': info.language,
              'durationMs': int((time.time() - t0) * 1000)}, args.out_file)
    except ImportError:
        emit({'ok': False, 'error': 'engine_unavailable', 'message': 'pip install faster-whisper'}, args.out_file)
    except Exception as e:  # noqa: BLE001
        emit({'ok': False, 'error': 'stt_failed', 'message': str(e)[:300]}, args.out_file)
    finally:
        for p in cleanup:
            try:
                if p and os.path.exists(p): os.unlink(p)
            except Exception:  # noqa: BLE001
                pass


if __name__ == '__main__':
    main()
