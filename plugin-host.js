return {
  apply(ctx) {
    const shell = ctx.get('shell')
    const fsSvc = ctx.get('fs')
    const webServer = ctx.get('webServer')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const systemPrompt = ctx.get('systemPrompt')
    const subprocess = ctx.get('subprocess')
    const timerSvc = ctx.get('timer')

    const MEDIA_ROUTE = '/guide-dog/media'
    const EXT_MIME = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
    }
    const MAX_FILE_BYTES = 512 * 1024 * 1024
    const INDEX_MAX = 200

    let mediaDir = null
    let indexCache = []
    let speakChain = Promise.resolve()
    let indexChain = Promise.resolve()
    const players = new Map()
    const spokenTurns = new Map() // sessionId -> Set<turnSeq>
    // RC13（三路评审定案）：双通道互斥——playOnHost 已在本机扬声器播放的文本，不得再经
    // voice-mode/downlink 队列通道播一遍（本机 + 浏览器双响）。消费即删（同文本只挡一次，
    // 用户合法要求重复播放不受影响）。
    const hostSpoken = new Map() // sessionId -> Map<normalizedText, true>
    function normSpeech(s) { return String(s || '').replace(/\s+/g, ' ').trim() }
    function markHostSpoken(sid, text) {
      const k = normSpeech(text)
      if (!k) return
      let m = hostSpoken.get(String(sid))
      if (!m) { m = new Map(); hostSpoken.set(String(sid), m) }
      m.set(k, true)
    }
    function wasHostSpoken(sid, text) {
      const m = hostSpoken.get(String(sid))
      if (!m) return false
      const k = normSpeech(text)
      if (!k || !m.has(k)) return false
      m.delete(k) // 消费一次
      if (!m.size) hostSpoken.delete(String(sid))
      return true
    }

    console.log('[guide-dog] apply shell=' + !!shell + ' fs=' + !!fsSvc + ' webServer=' + !!webServer + ' sandboxPolicy=' + !!sandboxPolicy + ' systemPrompt=' + !!systemPrompt + ' subprocess=' + !!subprocess + ' timer=' + !!timerSvc)

    // ============ CONFIG 节（Phase 1） ============
    const CONFIG_DEFAULTS = {
      voiceMode: { default: false, sessions: {} },
      voiceInput: { autoSend: false, engine: 'whisper', language: 'auto', maxSeconds: 60, whisper: { python: 'python3', model: 'small' } },
      tts: { voiceEn: 'English_expressive_narrator', voiceZh: 'Chinese (Mandarin)_Gentle_Youth', speed: 0.95, format: 'mp3' },
      call: {
        mode: 'vad',
        vad: { method: 'energy', threshold: 0.02, silenceMs: 700, minSpeechMs: 300, maxSegmentSeconds: 60, interruptMinMs: 300 },
        stream: { format: 'pcm', sampleRate: 24000, sentenceSplit: '。！？.!?\n', maxSentenceChars: 200 },
        voice: 'English_expressive_narrator',
        speed: 1.0,
        progress: true,
        consensus: { enabled: true, summaryWindowMs: 3000 },
      },
      a11y: { enabled: false, autoNarrate: true, visionCloud: true, summaryFirst: true },
    }
    function deepMerge(base, over) {
      if (over === null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
      const out = {}
      for (const k of Object.keys(base)) out[k] = deepMerge(base[k], (k in over) ? over[k] : base[k])
      for (const k of Object.keys(over)) if (!(k in base)) out[k] = over[k]
      return out
    }
    let guideRoot = ''
    async function guideDogRoot() {
      if (guideRoot) return guideRoot
      let root = ''
      if (sandboxPolicy && sandboxPolicy.workspaceRoot) root = sandboxPolicy.workspaceRoot
      if (!root) {
        const p = await runRaw('pwd', { timeoutMs: 10000 })
        root = (p.stdout || '').trim()
      }
      guideRoot = root
      return root
    }
    let configCache = deepMerge(CONFIG_DEFAULTS, {})
    let configReady = Promise.resolve()
    let configWriteChain = Promise.resolve() // A4（I3）：并发 set-config 串行化，防后写覆盖先写
    async function readTextFile(abs) {
      if (!fsSvc) return null
      try {
        const t = await fsSvc.resolve(abs)
        const info = await fsSvc.stat(t)
        if (!info) return null
        return await fsSvc.readText(t)
      } catch (e) { return null }
    }
    async function doRefreshConfig() {
      const root = await guideDogRoot()
      const raw = await readTextFile(root + '/.guide-dog/config.json')
      let parsed = null
      if (raw) { try { parsed = JSON.parse(raw) } catch (e) { console.error('[guide-dog] config parse error, trying .bak', e) } }
      if (!parsed) {
        const bak = await readTextFile(root + '/.guide-dog/config.json.bak')
        if (bak) { try { parsed = JSON.parse(bak) } catch (e2) { parsed = null } }
      }
      configCache = deepMerge(CONFIG_DEFAULTS, parsed || {})
      if (!raw) await saveConfig({})
    }
    function refreshConfig() { configReady = doRefreshConfig(); return configReady }
    function loadConfig() { return configCache }
    async function doSaveConfig(patch) {
      const root = await guideDogRoot()
      const next = deepMerge(configCache, patch || {})
      const dir = root + '/.guide-dog'
      try {
        await runRaw('mkdir -p ' + quote(dir), { timeoutMs: 10000 })
        // 原子写：tmp → mv → chmod 600；写前保留 .bak 供解析失败回退
        const okTmp = await writeTextFile(dir + '/config.json.tmp', JSON.stringify(next, null, 2))
        if (!okTmp) return { ok: false, error: 'config_write_failed' }
        const mv = await runRaw('cp -f ' + quote(dir + '/config.json') + ' ' + quote(dir + '/config.json.bak') + ' 2>/dev/null; mv -f ' + quote(dir + '/config.json.tmp') + ' ' + quote(dir + '/config.json') + '; ' + 'chmod 600 ' + quote(dir + '/config.json'), { timeoutMs: 10000 })
        if (mv.exitCode !== 0) return { ok: false, error: 'config_write_failed' } // M2：shell 链失败不得假成功
        configCache = next
        return { ok: true }
      } catch (e) {
        console.error('[guide-dog] config write failed', e)
        return { ok: false, error: 'config_write_failed' }
      }
    }
    function saveConfig(patch) {
      // A4（I3）：串行化 —— 同一时刻只允许一个写，后续 patch 从前一结果合并
      const p = configWriteChain.then(function () { return doSaveConfig(patch) })
      configWriteChain = p.then(function () {}, function () {})
      return p
    }
    async function writeStatus(patch) {
      try {
        const root = await guideDogRoot()
        const curRaw = await readTextFile(root + '/.guide-dog/status.json')
        let cur = {}
        if (curRaw) { try { cur = JSON.parse(curRaw) } catch (e) { /* ignore */ } }
        await runRaw('mkdir -p ' + quote(root + '/.guide-dog'), { timeoutMs: 10000 })
        await writeTextFile(root + '/.guide-dog/status.json', JSON.stringify(Object.assign({}, cur, patch), null, 2))
      } catch (e) { console.error('[guide-dog] status write failed', e) }
    }

    // ============ STT 节（Phase 1） ============
    const WHISPER_SCRIPT = `#!/usr/bin/env python3
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
`
    let sttProbeDone = false
    async function ensureWhisperScript() {
      const root = await guideDogRoot()
      await runRaw('mkdir -p ' + quote(root + '/.guide-dog/scripts'), { timeoutMs: 10000 })
      const p = root + '/.guide-dog/scripts/whisper_transcribe.py'
      if (!(await statFile(p))) await writeTextFile(p, WHISPER_SCRIPT)
    }
    async function probeWhisper() {
      if (sttProbeDone) return
      sttProbeDone = true
      const cfg = loadConfig()
      const py = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.python) || 'python3'
      const model = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.model) || 'small'
      const res = await runRaw(quote(py) + " -c 'import faster_whisper; print(faster_whisper.__version__)'", { timeoutMs: 15000 })
      // 模型缓存检查（2026-08-14 修复：hf.co 不可达 → 本地模型目录 + 镜像预热）
      const localDir = (await guideDogRoot()) + '/.guide-dog/models/faster-whisper-' + model
      const cached = !!(await statFile(localDir + '/model.bin'))
      await writeStatus({
        whisperAvailable: res.exitCode === 0 && !res.denied,
        whisperVersion: (res.stdout || '').trim(),
        whisperPython: py,
        whisperModelCached: cached,
        probeAt: Date.now(),
      })
      // 模型缺失 → 后台预热（hf-mirror.com 镜像，subprocess 非沙箱可写 ~/.guide-dog/models；不阻塞插件激活）
      if (res.exitCode === 0 && !cached && subprocess) {
        try {
          await ensureWhisperScript()
          const script = (await guideDogRoot()) + '/.guide-dog/scripts/whisper_transcribe.py'
          const handle = subprocess.spawn({
            argv: [py, script, '--prewarm', localDir, '--model', model, '--output', 'json'],
            cwd: (await guideDogRoot()) + '/.guide-dog',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
            graceMs: 3000,
          })
          handle.done.then(function (r) {
            writeStatus({ whisperModelCached: true, whisperPrewarmAt: Date.now() }).catch(function () {})
          }).catch(function () { /* prewarm failed; whisper 转写时脚本回退镜像下载 */ })
        } catch (e) { /* best effort */ }
      }
    }
    // ---------- whisper 常驻 worker（2026-08-15：partial 预览提速，模型只加载一次） ----------
    // 根因：partial 每次调用都重新加载模型（base 单次 3.3-3.9s，其中模型加载 ~2s）+ spawn 开销，
    // 5s 间隔 + busy 串行 → 预览节奏远慢于实时。方案：常驻 --serve 进程（模型懒加载并缓存），
    // stdin 行 JSON 任务 → stdout 行 JSON 响应，单次增量转写 ~0.8s。
    let whisperWorker = null // { handle, dead, nextId, offset }
    let workerChain = Promise.resolve() // RC1：whisper worker 总线单工 → 请求串行链
    async function ensureWhisperWorker() {
      if (whisperWorker && !whisperWorker.dead) return whisperWorker
      const root = await guideDogRoot()
      const script = root + '/.guide-dog/scripts/whisper_transcribe.py'
      const cfg = loadConfig()
      const py = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.python) || 'python3'
      await ensureWhisperScript()
      const h = subprocess.spawn({
        argv: [py, script, '--serve'],
        cwd: root + '/.guide-dog/tmp',
        stdio: { stdin: 'pipe', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
        graceMs: 3000,
      })
      const w = { handle: h, dead: false, nextId: 1, offset: 0 }
      whisperWorker = w
      h.done.then(function () { if (whisperWorker === w) whisperWorker.dead = true }).catch(function () { if (whisperWorker === w) whisperWorker.dead = true })
      return w
    }
    async function workerTranscribe(b64Path, model, language, timeoutMs) {
      // RC1：worker 总线单工（共享 stdin/stdout/offset）——并发请求必须串行，
      // 否则败者的响应行被他人轮询消费 → 60s 超时 → worker 被杀 → exited 级联。
      const run = workerChain.then(function () { return doWorkerRequest(b64Path, model, language, timeoutMs) })
      workerChain = run.then(function () {}, function () {})
      return run
    }
    async function doWorkerRequest(b64Path, model, language, timeoutMs) {
      const w = await ensureWhisperWorker()
      const id = w.nextId++
      try { w.handle.stdin.write(JSON.stringify({ id: id, b64Path: b64Path, model: model, language: language }) + '\n') } catch (e) { throw e }
      const deadline = Date.now() + (timeoutMs || 45000)
      while (Date.now() < deadline) {
        if (w.dead) throw new Error('whisper worker exited')
        try {
          const read = w.handle.collected.stdout.readFrom(w.offset)
          if (read && read.text) {
            w.offset = read.nextOffset
            const lines = read.text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              const t = lines[i].trim()
              if (!t) continue
              let obj = null
              try { obj = JSON.parse(t) } catch (e) { continue }
              if (obj && obj.id === id) return obj
            }
          }
        } catch (e) { throw e }
        await sleep(150)
      }
      // 超时：杀掉 worker（下次调用自动重启）
      try { w.handle.terminate() } catch (e) { /* ignore */ }
      w.dead = true
      throw new Error('whisper worker timeout')
    }
    ctx.effect(function () {
      return function () {
        if (whisperWorker && whisperWorker.handle) {
          try { whisperWorker.handle.terminate() } catch (e) { /* ignore */ }
        }
      }
    })
    async function transcribeImpl(args) {
      const cfg = loadConfig()
      const engine = cfg.voiceInput && cfg.voiceInput.engine
      if (engine && engine !== 'whisper') {
        return { ok: false, error: 'engine_unavailable', message: '当前仅支持 whisper 引擎（MiniMax 无公开 ASR）' }
      }
      if (!args || typeof args.audioB64 !== 'string' || !args.audioB64) {
        return { ok: false, error: 'bad_args', message: 'audioB64 required' }
      }
      if (args.audioB64.length > 27 * 1024 * 1024) { // 20MB 二进制 ≈ 26.7MB base64（spec §8.1）
        return { ok: false, error: 'bad_args', message: 'audioB64 too large' }
      }
      const root = await guideDogRoot()
      const b64Path = root + '/.guide-dog/tmp/rec-' + Date.now() + '.b64'
      const outFile = root + '/.guide-dog/tmp/whisper-' + Date.now() + '.out.json'
      const script = root + '/.guide-dog/scripts/whisper_transcribe.py'
      const py = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.python) || 'python3'
      // partial（实时预览转写）：用 base 模型加速（约 2-3x 实时，预览用途精度足够），
      // 且不保留空结果诊断副本（避免静音片段累积 empty-*.webm）
      const model = args.partial ? 'base' : ((cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.model) || 'small')
      const lang = (args.language || (cfg.voiceInput && cfg.voiceInput.language) || 'auto')
      await runRaw('mkdir -p ' + quote(root + '/.guide-dog/tmp'), { timeoutMs: 10000 })
      const wrote = await writeTextFile(b64Path, args.audioB64)
      if (!wrote) return { ok: false, error: 'stt_failed', message: 'cannot write temp audio' }
      // 优先常驻 worker（2026-08-15：模型已加载，单次 ~0.8s；崩溃/超时自动 fallback 一次性 spawn）
      if (subprocess) {
        try {
          const wr = await workerTranscribe(b64Path, model, lang, args.partial ? 20000 : 60000)
          if (wr && typeof wr.ok === 'boolean') {
            return { ok: wr.ok === true, text: wr.text, language: wr.language, error: wr.error, message: wr.message, durationMs: wr.durationMs }
          }
        } catch (e) {
          console.log('[guide-dog] whisper worker failed, fallback one-shot: ' + String((e && e.message) || e))
        }
      }
      let handle = null
      try {
        await ensureWhisperScript()
        const argvBase = [py, script, '--audio-b64-file', b64Path, '--delete-b64', '--model', model, '--language', lang, '--out-file', outFile, '--output', 'json']
        if (args.partial) argvBase.push('--no-keep-empty')
        handle = subprocess.spawn({
          argv: argvBase,
          cwd: root + '/.guide-dog/tmp',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
          graceMs: 3000,
        })
        // 超时竞速：只用 v1 已验证的 sleep(ms) Promise 形式（审查 I1 修复）
        let timedOut = false
        const done = handle.done
        const timer = sleep(60000).then(function () {
          timedOut = true
          try { handle.terminate() } catch (e) { /* ignore */ }
        })
        await Promise.race([done, timer])
        if (timedOut) return { ok: false, error: 'stt_timeout', message: 'STT timed out after 60s' }
        // 输出读取定案：脚本已把 JSON 写入 outFile，用已验证的 readTextFile 读取
        const raw = await readTextFile(outFile)
        let parsed = null
        if (raw) { try { parsed = JSON.parse(raw.trim().split('\n').pop()) } catch (e) { /* fallthrough */ } }
        if (!parsed || parsed.ok !== true) {
          return { ok: false, error: (parsed && parsed.error) || 'stt_failed', message: (parsed && parsed.message) || 'STT failed' }
        }
        return { ok: true, text: parsed.text, language: parsed.language, durationMs: parsed.durationMs }
      } catch (e) {
        return { ok: false, error: 'stt_failed', message: String((e && e.message) || e).slice(0, 200) }
      } finally {
        // 精确文件名清理（M13：不用通配符；2026-08-15 修复：runRaw 的 rm 走沙箱 shell 被拒（home 只读）→ 改 subprocess 非沙箱删除）
        if (subprocess) {
          try {
            const h = subprocess.spawn({
              argv: ['rm', '-f', b64Path, outFile],
              cwd: root + '/.guide-dog/tmp',
              stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
              graceMs: 3000,
            })
            h.done.catch(function () { /* ignore */ })
          } catch (e) { /* ignore */ }
        } else {
          await runRaw('rm -f ' + quote(b64Path) + ' ' + quote(outFile), { timeoutMs: 10000 }).catch(function () {})
        }
      }
    }

    function quote(s) {
      return "'" + String(s).replace(/'/g, "'\\''") + "'"
    }
    function pick(obj, keys, fallback) {
      if (obj && typeof obj === 'object') {
        for (const k of keys) {
          const v = obj[k]
          if (v !== undefined && v !== null && v !== '') return v
        }
      }
      return fallback
    }
    async function sleep(ms) {
      if (!timerSvc) return
      await timerSvc.timeout(ms)
    }
    function serialSpeak(fn) {
      const p = speakChain.then(fn, fn)
      speakChain = p.then(function () {}, function () {})
      return p
    }
    function serialIndex(fn) {
      const p = indexChain.then(fn, fn)
      indexChain = p.then(function () {}, function () {})
      return p
    }

    // ---------- shell / mmx runners ----------
    async function runRaw(command, opts) {
      opts = opts || {}
      if (!shell) return { exitCode: 1, stdout: '', stderr: 'shell service unavailable' }
      const spec = shell.resolve({
        command: command,
        timeoutMs: opts.timeoutMs || 120000,
        signal: opts.signal,
        workdir: opts.workdir,
      })
      const res = await shell.run(spec)
      return {
        exitCode: res.exitCode,
        stdout: (res.stdout && res.stdout.text) || '',
        stderr: (res.stderr && res.stderr.text) || '',
        timedOut: !!res.timedOut,
        aborted: !!res.aborted,
        denied: !!(res.sandbox && res.sandbox.denied),
        mode: res.sandbox ? res.sandbox.mode : undefined,
      }
    }
    async function mmx(args, opts) {
      opts = opts || {}
      const parts = ['mmx'].concat(args.map(quote))
      parts.push('--output', 'json', '--no-color')
      if (opts.quiet !== false) parts.push('--quiet')
      const res = await runRaw(parts.join(' '), opts)
      const out = res.stdout.trim()
      let json = null
      if (out) {
        try { json = JSON.parse(out) } catch (e) { json = null }
        if (json === null) {
          const lines = out.split('\n')
          for (let i = lines.length - 1; i >= 0; i--) {
            try { json = JSON.parse(lines[i]); break } catch (e2) { /* keep looking */ }
          }
        }
      }
      if (res.exitCode !== 0) {
        return { ok: false, exitCode: res.exitCode, error: ((res.stderr || out || ('exit ' + res.exitCode))).slice(0, 2000), denied: res.denied, json: json, raw: out }
      }
      // File-writing commands may print nothing parseable; exit 0 is success.
      return { ok: true, json: json, raw: out }
    }

    // ---------- media store ----------
    async function ensureMediaDir() {
      if (mediaDir) return mediaDir
      let root = ''
      if (sandboxPolicy && sandboxPolicy.workspaceRoot) root = sandboxPolicy.workspaceRoot
      if (!root) {
        const p = await runRaw('pwd', { timeoutMs: 10000 })
        root = (p.stdout || '').trim()
      }
      const dir = root + '/.guide-dog/media'
      const mk = await runRaw('mkdir -p ' + quote(dir), { timeoutMs: 10000 })
      if (mk.exitCode !== 0) throw new Error('cannot create media dir ' + dir + ': ' + mk.stderr)
      mediaDir = dir
      console.log('[guide-dog] media dir: ' + mediaDir)
      return dir
    }
    async function statFile(abs) {
      if (!fsSvc) return null
      try {
        const t = await fsSvc.resolve(abs)
        const info = await fsSvc.stat(t)
        return info && info.type === 'file' ? info : null
      } catch (e) { return null }
    }
    async function readBytes(abs, maxBytes) {
      if (!fsSvc) return null
      try {
        const t = await fsSvc.resolve(abs)
        return await fsSvc.readBytes(t, undefined, maxBytes)
      } catch (e) { return null }
    }
    // M10: fsSvc.readBytes 无 offset，只读文件开头 maxBytes；
    // readRange 经 shell (dd + head/tail + base64) 只读 [start, start+len)。
    async function readRange(abs, start, len) {
      if (!runRaw || !quote) return null
      const r = await runRaw('dd if=' + quote(abs) + ' bs=4096 skip=' + Math.floor(start / 4096) + ' 2>/dev/null | head -c ' + (len + (start % 4096)) + ' | tail -c +' + ((start % 4096) + 1) + ' | base64 -w0', { timeoutMs: 30000 })
      if (r.exitCode !== 0 || !r.stdout) return null
      try { return Buffer.from(r.stdout.trim(), 'base64') } catch (e) { return null }
    }
    async function listDir(abs) {
      if (!fsSvc) return null
      try {
        const t = await fsSvc.resolve(abs)
        return await fsSvc.listDir(t)
      } catch (e) { return null }
    }
    async function writeTextFile(abs, content) {
      if (!fsSvc) return false
      try {
        const t = await fsSvc.resolve(abs)
        await fsSvc.writeText(t, content)
        return true
      } catch (e) { return false }
    }
    async function loadIndex() {
      if (!fsSvc || !mediaDir) return []
      try {
        const t = await fsSvc.resolve(mediaDir + '/.index.json')
        const text = await fsSvc.readText(t)
        const arr = JSON.parse(text)
        if (Array.isArray(arr)) { indexCache = arr; return arr }
      } catch (e) { /* rebuild */ }
      indexCache = []
      return indexCache
    }
    function pushIndex(entry) {
      return serialIndex(async function () {
        if (!fsSvc || !mediaDir) return
        try {
          const arr = indexCache.length ? indexCache : await loadIndex()
          arr.unshift(entry)
          indexCache = arr.slice(0, INDEX_MAX)
          await writeTextFile(mediaDir + '/.index.json', JSON.stringify(indexCache, null, 2))
        } catch (e) { /* best effort */ }
      })
    }
    async function newFiles(before) {
      const after = await listDir(mediaDir)
      if (!after) return []
      return after.filter(function (e) {
        return e.type === 'file' && !e.name.startsWith('.') && !before.has(e.name)
      }).map(function (e) { return { name: e.name, bytes: e.size || 0 } })
    }
    async function listMedia(limit) {
      if (!mediaDir) return []
      const arr = indexCache.length ? indexCache : await loadIndex()
      const out = []
      for (const e of arr) {
        const st = await statFile(mediaDir + '/' + e.name)
        if (!st) continue
        out.push({
          name: e.name,
          kind: e.kind || kindOf(e.name),
          prompt: e.prompt || '',
          voice: e.voice || '',
          ts: e.ts || 0,
          bytes: st.size || e.bytes || 0,
          url: MEDIA_ROUTE + '/' + e.name,
        })
        if (limit && out.length >= limit) break
      }
      return out
    }
    function kindOf(name) {
      const dot = name.lastIndexOf('.')
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
      const mime = EXT_MIME[ext]
      if (!mime) return 'file'
      if (mime.indexOf('image/') === 0) return 'image'
      if (mime.indexOf('video/') === 0) return 'video'
      if (mime.indexOf('audio/') === 0) return 'audio'
      return 'file'
    }

    // ---------- speech pipeline (audio-conversation + speech-mmx integration) ----------
    async function skillScript(name) {
      const p = '$HOME/.agents/skills/' + name
      const r = await runRaw('test -f ' + p + ' && echo yes || echo no', { timeoutMs: 10000 })
      return r.exitCode === 0 && r.stdout.trim() === 'yes' ? p : null
    }
    async function transformText(text) {
      const py = await skillScript('audio-conversation/scripts/transform.py')
      if (py && shell) {
        try {
          const spec = shell.resolve({ command: 'python3 ' + py, timeoutMs: 30000, stdin: text })
          const res = await shell.run(spec)
          if (res.exitCode === 0 && res.stdout && res.stdout.text) {
            const t = res.stdout.text.trim()
            if (t) return t
          }
        } catch (e) { /* fall through */ }
      }
      return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*_~#>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }
    function hasCJK(text) {
      for (const ch of text) {
        const o = ch.codePointAt(0)
        if ((o >= 0x4E00 && o <= 0x9FFF) || (o >= 0x3400 && o <= 0x4DBF) ||
            (o >= 0x20000 && o <= 0x2A6DF) || (o >= 0x3040 && o <= 0x30FF) ||
            (o >= 0xAC00 && o <= 0xD7AF)) return true
      }
      return false
    }
    function resolveVoice(voice, transformed) {
      if (voice && voice !== 'auto') return String(voice)
      return hasCJK(transformed) ? 'Chinese (Mandarin)_Gentle_Youth' : 'English_Trustworthy_Man'
    }
    async function nextTurnNumber() {
      let max = 0
      const dir = await listDir(mediaDir)
      if (dir) {
        for (const e of dir) {
          const m = /^turn-(\d+)\.mp3$/.exec(e.name)
          if (m) max = Math.max(max, parseInt(m[1], 10))
        }
      }
      return max + 1
    }
    async function generateTts(text, voice, speed, lang, abs) {
      const wrap = await skillScript('speech-mmx/scripts/mmx_tts.py')
      if (wrap) {
        const cmd = 'python3 ' + wrap + ' speak --input ' + quote(text) + ' --voice ' + quote(voice) + ' --speed ' + String(speed) + (lang ? ' --language ' + quote(lang) : '') + ' --out ' + quote(abs)
        const r = await runRaw(cmd, { timeoutMs: 120000 })
        if (r.exitCode !== 0) return { ok: false, error: (r.stderr || r.stdout || ('exit ' + r.exitCode)).slice(0, 800) }
        return { ok: true }
      }
      const a = ['speech', 'synthesize', '--text', text, '--voice', voice, '--speed', String(speed)]
      if (lang) a.push('--language', lang)
      a.push('--out', abs)
      const r = await mmx(a, { timeoutMs: 120000 })
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
    async function speakImpl(args) {
      const source = args.source === 'voice-mode' ? 'voice-mode' : 'tool'
      const sid = typeof args.sessionId === 'string' ? args.sessionId : ''
      const seq = typeof args.turnSeq === 'number' ? args.turnSeq : null
      const spoken = (sid && seq !== null) ? (spokenTurns.get(sid) || new Set()) : null
      if (spoken) {
        if (spoken.has(seq)) return { ok: true, skipped: true }
        spoken.add(seq) // 预占去重（防同 turn 并发双 TTS）；任何失败路径释放（M1）
        spokenTurns.set(sid, spoken)
      }
      const release = function () { if (spoken) spoken.delete(seq) }
      const text = String(args.text || '').trim()
      if (!text) { release(); return { ok: false, error: 'bad_args', message: 'text is required' } }
      await ensureMediaDir()
      const transformed = await transformText(text)
      const ttsCfg = (loadConfig().tts) || {}
      const cfgVoice = hasCJK(transformed) ? (ttsCfg.voiceZh || '') : (ttsCfg.voiceEn || '')
      const voice = resolveVoice(args.voice || cfgVoice || 'auto', transformed)
      const speed = typeof args.speed === 'number' ? args.speed : (ttsCfg.speed || 0.95)
      const lang = args.language || (hasCJK(transformed) ? 'zh' : '')
      const next = await nextTurnNumber()
      const name = 'turn-' + String(next).padStart(3, '0') + '.mp3'
      const abs = mediaDir + '/' + name
      const tts = await generateTts(transformed, voice, speed, lang, abs)
      if (!tts.ok) {
        release()
        const msg = String(tts.error || '')
        return { ok: false, error: /timeout/i.test(msg) ? 'tts_timeout' : 'tts_failed', message: msg.slice(0, 300) }
      }
      const st = await statFile(abs)
      if (!st) { release(); return { ok: false, error: 'tts_failed', message: 'TTS finished but the mp3 is missing' } }
      await pushIndex({ name: name, kind: 'audio', prompt: text.slice(0, 200), voice: voice, ts: Date.now(), bytes: st.size || 0, source: source, turnSeq: seq, spoken: transformed.slice(0, 160) })
      // RC13：本机扬声器播放成功后登记文本——队列通道（语音模式/下行）消费即删，防双响
      if (args.playOnHost) { const played = await playOnHost(abs); if (played) markHostSpoken(sid, transformed) }
      return { ok: true, kind: 'audio', url: MEDIA_ROUTE + '/' + name, file: abs, voice: voice, bytes: st.size || 0 }
    }
    async function playOnHost(abs) {
      if (!subprocess) return
      for (const h of players.values()) { try { h.terminate() } catch (e) { /* ignore */ } }
      players.clear()
      const probe = await runRaw('command -v afplay; command -v play; command -v ffplay', { timeoutMs: 10000 })
      const found = (probe.stdout || '').split('\n').map(function (s) { return s.trim() }).filter(Boolean)
      let player = null
      for (const p of ['afplay', 'play', 'ffplay']) {
        if (found.some(function (f) { return f.endsWith('/' + p) })) { player = p; break }
      }
      if (!player) return false
      const argv = player === 'ffplay'
        ? ['ffplay', '-nodisp', '-autoexit', '-hide_banner', '-loglevel', 'warning', abs]
        : [player, abs]
      try {
        const handle = subprocess.spawn({
          argv: argv,
          cwd: mediaDir,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
          graceMs: 3000,
        })
        players.set(abs, handle)
        handle.done.catch(function () {}).then(function () {
          if (players.get(abs) === handle) players.delete(abs)
        })
        return true
      } catch (e) { return false }
    }

    // ---------- vision ----------
    const FOCUS_PROMPTS = {
      general: 'Describe the image in detail, including content, style, colors, and any text visible.',
      frontend: 'You are reviewing a frontend UI design. Describe the layout, colors, contrast, spacing, typography, and alignment. List concrete visual issues and improvement suggestions.',
      figure: 'You are reviewing a data figure or chart. State what it shows, verify axis labels, legends, titles, readability, and the correctness of the visual encoding. List any issues.',
      screenshot: 'Describe everything visible in this screenshot, element by element from top to bottom, then list any visual problems or missing content.',
      ocr: 'Extract all text from the image verbatim, preserving order and line breaks.',
    }
    async function describeImage(image, prompt, signal) {
      const a = ['vision', 'describe', '--image', String(image)]
      if (prompt) a.push('--prompt', String(prompt))
      const res = await mmx(a, { timeoutMs: 120000, signal: signal })
      if (!res.ok) return { ok: false, error: res.error }
      const j = res.json
      let answer
      if (typeof j === 'string') answer = j
      else if (j !== null) answer = pick(j, ['description', 'answer', 'text', 'content', 'result'], null) || JSON.stringify(j)
      else answer = res.raw || ''
      if (!answer) return { ok: false, error: 'vision returned no answer' }
      return { ok: true, answer: String(answer) }
    }
    async function voicesImpl(args) {
      const a = ['speech', 'voices']
      if (args && args.language) a.push('--language', String(args.language))
      const res = await mmx(a, { timeoutMs: 60000 })
      if (!res.ok) return { ok: false, error: res.error }
      const list = Array.isArray(res.json) ? res.json : ((res.json && res.json.voices) || [])
      const voices = list.map(function (v) {
        if (typeof v === 'string') return { voice_id: v, voice_name: v }
        return { voice_id: v.voice_id || v.id || '', voice_name: v.voice_name || v.name || '' }
      }).filter(function (v) { return !!v.voice_id })
      if (!voices.length && res.json === null) return { ok: false, error: 'voices returned no parseable JSON: ' + res.raw.slice(0, 300) }
      return { ok: true, voices: voices }
    }

    // ---------- static media route ----------
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'prefix',
          path: MEDIA_ROUTE,
          handler: async function (req, res) {
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
              const raw = String(req.url || '/').split('?')[0]
              const name = raw.slice(MEDIA_ROUTE.length + 1)
              if (!name || name.indexOf('/') !== -1 || name.indexOf('..') !== -1 || name.indexOf('%') !== -1) {
                res.writeHead(404); res.end(); return
              }
              const dot = name.lastIndexOf('.')
              const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
              const mime = EXT_MIME[ext]
              if (!mime || !fsSvc || !mediaDir) { res.writeHead(404); res.end(); return }
              const abs = mediaDir + '/' + name
              const st = await statFile(abs)
              if (!st) { res.writeHead(404); res.end(); return }
              const size = st.size || 0
              if (size > MAX_FILE_BYTES) { res.writeHead(413); res.end(); return }
              const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': String(size) }
              let status = 200
              let rangeLen = -1 // -1 = 全量
              let start = -1 // range 起点（rangeLen >= 0 时有效）
              const range = req.headers && req.headers.range ? String(req.headers.range) : ''
              if (range) {
                const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
                if (m && (m[1] || m[2])) {
                  let end = size - 1
                  if (m[1] === '') {
                    start = Math.max(0, size - parseInt(m[2] || '0', 10))
                  } else {
                    start = parseInt(m[1], 10)
                    end = m[2] ? parseInt(m[2], 10) : size - 1
                  }
                  if (start >= size || start > end) {
                    res.writeHead(416, { 'content-range': 'bytes */' + size }); res.end(); return
                  }
                  end = Math.min(end, size - 1)
                  rangeLen = end - start + 1
                  status = 206
                  headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size
                  headers['content-length'] = String(rangeLen)
                }
              }
              // M10：只读所需区段，不全量缓冲（fsSvc.readBytes 无 offset，range 走 readRange）
              const bytes = rangeLen >= 0 ? await readRange(abs, start, rangeLen) : await readBytes(abs, size || MAX_FILE_BYTES)
              if (!bytes) { res.writeHead(404); res.end(); return }
              res.writeHead(status, headers)
              res.end(req.method === 'HEAD' ? undefined : bytes)
            } catch (e) {
              try { res.writeHead(500); res.end() } catch (e2) { /* ignore */ }
            }
          },
        })
      } catch (e) {
        console.error('[guide-dog] route registration failed: ' + String(e))
        return function () {}
      }
    })

    // ============ RECORDER 页（Phase 1，Task 6b） ============
    const RECORDER_HTML = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>Guide Dog 录音转写</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;text-align:center}
button{font-size:18px;padding:14px 28px;border-radius:10px;border:none;background:#4a7dff;color:#fff;cursor:pointer;margin:8px}
#status{color:#888;margin:12px 0}#out{white-space:pre-wrap;background:#f4f4f4;border-radius:8px;padding:14px;min-height:60px;text-align:left;display:none}
.err{color:#c0392b}</style></head><body>
<h2>🎙 Guide Dog 录音转写</h2>
<p>点击录音，说完后停止，文字会自动转写。</p>
<button id="rec">开始录音</button><button id="cp" style="display:none">复制文本</button>
<div id="status">空闲</div><div id="out"></div>
<script>
const b=document.getElementById('rec'),st=document.getElementById('status'),out=document.getElementById('out'),cp=document.getElementById('cp');
let mr=null,chunks=[],recTimer=null;
b.onclick=async()=>{
  if(mr){mr.stop();return}
  try{
    const s=await navigator.mediaDevices.getUserMedia({audio:true});
    mr=new MediaRecorder(s);chunks=[];
    mr.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    mr.onstop=async()=>{
      clearTimeout(recTimer);recTimer=null;
      const blob=new Blob(chunks,{type:'audio/webm'});
      st.textContent='转写中…';
      try{
        const r=await fetch('/guide-dog/transcribe-upload',{method:'POST',body:blob});
        const j=await r.json();
        if(j.ok&&j.text){out.style.display='block';out.textContent=j.text;cp.style.display='inline-block';st.textContent='完成（'+(j.language||'')+'）'}
        else{st.className='err';st.textContent=(j.message||j.error||'转写失败')}
      }catch(e){st.className='err';st.textContent='网络错误：'+e}
      s.getTracks().forEach(t=>t.stop());mr=null;b.textContent='开始录音';
    };
    mr.start(1000);b.textContent='停止';st.textContent='录音中…';st.className='';
    recTimer=setTimeout(function(){if(mr){mr.stop()}},60000);
  }catch(e){st.className='err';st.textContent='无法访问麦克风：'+e}
};
cp.onclick=async()=>{try{await navigator.clipboard.writeText(out.textContent);cp.textContent='已复制'}catch(e){out.select();document.execCommand('copy');cp.textContent='已复制'}};
</script></body></html>`
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'prefix',
          path: '/guide-dog/recorder',
          handler: async function (req, res) {
            try {
              const raw = String(req.url || '/').split('?')[0]
              if (raw === '/guide-dog/recorder' && (req.method === 'GET' || req.method === 'HEAD')) {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                res.end(RECORDER_HTML)
                return
              }
              if (raw === '/guide-dog/transcribe-upload' && req.method === 'POST') {
                const chunks = []
                let total = 0
                for await (const c of req) {
                  chunks.push(c)
                  total += c.length
                  if (total > 20 * 1024 * 1024) { req.resume(); res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"bad_args","message":"audio too large"}'); return }
                }
                const all = new Uint8Array(total)
                let off = 0
                for (const c of chunks) { all.set(c, off); off += c.length }
                const bin = new TextDecoder('latin1').decode(all)
                const r = await transcribeImpl({ audioB64: btoa(bin), mime: 'audio/webm', sessionId: '', language: 'auto' })
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify(r))
                return
              }
              res.writeHead(404); res.end(); return
            } catch (e) {
              // M12：上传路径异常保护，绝不悬挂响应
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: 'stt_failed', message: String((e && e.message) || e).slice(0, 200) }))
              } catch (e2) { /* ignore */ }
            }
          },
        })
      } catch (e) { return function () {} }
    })

    // ============ CALL 上行（Phase 2，host） ============
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'exact',
          path: '/guide-dog/call-transcribe',
          handler: async function (req, res) {
            try {
              if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
              // 同源校验（M5 修订 2026-08-16）：Origin 必须等于 GUI 来源——按 Host 头推导
              // （'http://' + req.headers.host，GUI 由 dsh web 同源托管）；无 Origin 头（curl）放行，
              // 便于本地验收。不再用 guideDogRoot() 作 truthy 占位。
              const origin = req.headers && req.headers.origin ? String(req.headers.origin) : ''
              const hostHdr = req.headers && req.headers.host ? String(req.headers.host) : ''
              if (origin && hostHdr && origin !== 'http://' + hostHdr) { res.writeHead(403); res.end(); return }
              // 收集 body（≤20MB 硬上限）
              const chunks = []
              let total = 0
              for await (const chunk of req) {
                chunks.push(chunk)
                total += chunk.length
                if (total > 20 * 1024 * 1024) { res.writeHead(413); res.end(); return }
              }
              const b64 = Buffer.concat(chunks).toString('base64')
              const r = await transcribeImpl({ audioB64: b64, mime: 'audio/webm', sessionId: req.headers && req.headers['x-session-id'] ? String(req.headers['x-session-id']) : '' })
              if (r.ok) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, text: r.text, language: r.language, durationMs: r.durationMs }))
              } else {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: r.error, message: r.message || '' }))
              }
            } catch (e) {
              try { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'stt_failed', message: String(e).slice(0, 200) })) } catch (e2) { /* ignore */ }
            }
          },
        })
      } catch (e) { return function () {} }
    })

    // ---------- prompt section: automatic invocation ----------
    ctx.effect(function () {
      if (!systemPrompt) return function () {}
      try {
        return systemPrompt.section({
          name: 'guide-dog-vision',
          order: 110,
          text: [
            '## Guide Dog for DSH (MiniMax multimodal)',
            'This harness runs Guide Dog, a MiniMax-powered multimodal plugin. The active model may not have native image input (e.g. DeepSeek), so Guide Dog is the eyes for anything visual:',
            '- VISUAL CHECKS (frontend design review, figure/plot/chart generation, screenshots, UI mockups, generated-image QA): always inspect the produced image file with guide_dog_inspect (structured review) or guide_dog_vision (general description) before finalizing an answer. Never claim to have seen an image you have not inspected.',
            '- GENERATION: use guide_dog_image (images), guide_dog_video (video), guide_dog_music (music), guide_dog_speak (speech).',
            '- All generated media is also visible to the user in the web UI at /guide-dog/media/<file>; always include the returned url fields in your reply so the user can preview.',
            '- When the user asks to hear text spoken aloud, use guide_dog_speak.',
          ].join('\n'),
        })
      } catch (e) {
        console.error('[guide-dog] prompt section failed: ' + String(e))
        return function () {}
      }
    })
    if (systemPrompt && systemPrompt.variable) {
      try {
        const disp = systemPrompt.variable('guide_dog_voice_mode', function (context) {
          const cfg = loadConfig()
          const sid = (context && (context.sessionId || (context.session && context.session.id))) || ''
          const vm = cfg.voiceMode || {}
          const effective = sid ? (vm.sessions[sid] !== undefined ? vm.sessions[sid] : vm.default) : vm.default
          if (!effective) return undefined
          return '语音模式：开。本条回复会被自动朗读。保持回复文字与朗读内容一致，不要在回复中描述音频状态，不要重复播报。'
        })
        if (typeof disp === 'function') ctx.effect(function () { return disp }) // M3：纳入生命周期
      } catch (e) {
        console.error('[guide-dog] voice mode variable failed: ' + String(e))
      }
    }
    // ---- 共识优先 prompt 变量（Task 8 Step 4） ----
    // 接线说明（实证）：cordis ctx.effect(execute) 会立即调用 execute 并把其返回的函数作为
    // 生命周期 disposer；systemPrompt.variable() 本身已即时注册并返回 exact effect disposer，
    // 若直接 ctx.effect(disp) 会立刻调用 disp → 变量被即刻注销。故沿用上方 M3 同款接线
    // （ctx.effect(function () { return disp })）：disp 仅在 scope 注销时被调用。
    if (systemPrompt && systemPrompt.variable) {
      try {
        const disp1 = systemPrompt.variable('guide_dog_call_consensus', function (context) {
          const cfg = loadConfig()
          const sid = context && context.sessionId ? String(context.sessionId) : ''
          const callOn = cfg.call && cfg.call.consensus && cfg.call.consensus.enabled
          const a11yOn = cfg.a11y && cfg.a11y.enabled
          // C3（最终审稿）：与 consensusEnabled 同门——仅通话激活中的会话注入语音聊天措辞
          if (!((callOn && isCallActive(sid)) || a11yOn)) return undefined
          const a11yExtra = a11yOn ? '无障碍模式已开启：所有可能改变状态的操作（发送、删除、覆盖等）执行前都必须先简短说明并得到你的语音确认。' : ''
          return '用户正通过语音和你对话，像和合作伙伴讨论一样：先理解意图，不清楚就问（问多少看实际情况，语音通道保持简洁）；主动说明关键信息；写入/修改前先简短说明要做什么，等用户点头；用户随时可能提问或插话，认真回应。' + a11yExtra
        })
        if (typeof disp1 === 'function') ctx.effect(function () { return disp1 })
      } catch (e) { /* ignore */ }
      try {
        const disp2 = systemPrompt.variable('guide_dog_a11y_constraints', function () {
          const cfg = loadConfig()
          if (!(cfg.a11y && cfg.a11y.enabled)) return undefined
          return '无障碍模式：①破坏性操作必须先语音确认（"将删除 X，确定吗？请说确定或取消"）；②颜色/图标/布局一律用文字描述；③重要状态变化必须口头通知。'
        })
        if (typeof disp2 === 'function') ctx.effect(function () { return disp2 })
      } catch (e) { /* ignore */ }
    }

    // ---------- tools ----------
    function registerTool(definition) {
      ctx.effect(function () {
        try {
          return harness.registerTool(ctx, harness.defineTool(definition))
        } catch (e) {
          console.error('[guide-dog] tool registration failed: ' + definition.name + ' ' + String(e))
          return function () {}
        }
      })
    }
    // Value-schema DSL: root `required` is forbidden; requiredness is per-property.
    const OUT_SCHEMA = {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean', required: true },
        kind: { type: 'string' },
        error: { type: 'string' },
        url: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
        file: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        answer: { type: 'string' },
        text: { type: 'string' },
        results: { type: 'array' },
        voices: { type: 'array' },
      },
    }
    const renderJson = function (args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    }
    function params(props, required) {
      return { type: 'object', properties: props, required: required || [] }
    }
    function base(name, description, parameters, execute, timeoutMs) {
      return {
        name: name,
        description: description,
        parameters: parameters,
        output: { schema: OUT_SCHEMA, render: renderJson },
        execute: execute,
        timeoutMs: timeoutMs || 120000,
      }
    }

    registerTool(base('guide_dog_speak',
      'Speak text aloud using MiniMax TTS (reuses the audio-conversation / speech-mmx skill pipeline: text transform, CJK auto-detect, per-language voices). Returns an mp3 url playable in the web UI.',
      params({
        text: { type: 'string', description: 'The exact text to speak (the same words that appear in chat).' },
        voice: { type: 'string', description: 'Voice id, or "auto" for per-language defaults (English_Trustworthy_Man / Chinese (Mandarin)_Gentle_Youth).' },
        speed: { type: 'number', description: 'Speed multiplier (default 0.95).' },
        language: { type: 'string', description: 'Optional language boost code (en, zh, ja, ...).' },
        playOnHost: { type: 'boolean', description: 'Also play on the host machine speakers, one file at a time (default false — the browser plays it).' },
      }, ['text']),
      function (args, exec) {
        return serialSpeak(function () { return speakImpl(args || {}) })
      },
      120000))

    registerTool(base('guide_dog_image',
      'Generate images with MiniMax (image-01). Saves to the Guide Dog media store and returns preview urls for the web UI.',
      params({
        prompt: { type: 'string', description: 'Image description.' },
        aspectRatio: { type: 'string', enum: ['16:9', '1:1', '9:16', '4:3', '3:4', '21:9'], description: 'Aspect ratio (ignored when width/height are both set).' },
        n: { type: 'integer', description: 'Number of images to generate (default 1).' },
        width: { type: 'integer', description: 'Custom width in px (512-2048, multiple of 8, image-01 only).' },
        height: { type: 'integer', description: 'Custom height in px (512-2048, multiple of 8, image-01 only).' },
        seed: { type: 'integer', description: 'Random seed for reproducible generation.' },
        promptOptimizer: { type: 'boolean', description: 'Automatically optimize the prompt before generation.' },
        watermark: { type: 'boolean', description: 'Embed an AI-generated content watermark.' },
      }, ['prompt']),
      async function (args, exec) {
        try {
          args = args || {}
          await ensureMediaDir()
          const before = new Set((await listDir(mediaDir) || []).filter(function (e) { return e.type === 'file' }).map(function (e) { return e.name }))
          const a = ['image', 'generate', '--prompt', String(args.prompt || '')]
          if (args.aspectRatio) a.push('--aspect-ratio', String(args.aspectRatio))
          if (args.n) a.push('--n', String(args.n))
          if (args.width) a.push('--width', String(args.width))
          if (args.height) a.push('--height', String(args.height))
          if (args.seed !== undefined && args.seed !== null) a.push('--seed', String(args.seed))
          if (args.promptOptimizer) a.push('--prompt-optimizer')
          if (args.watermark) a.push('--aigc-watermark')
          a.push('--out-dir', mediaDir, '--out-prefix', 'image-' + Date.now())
          const res = await mmx(a, { timeoutMs: 300000, signal: exec && exec.signal })
          if (!res.ok) return { ok: false, error: res.error }
          const files = await newFiles(before)
          if (!files.length) return { ok: false, error: 'generation finished but no file appeared in ' + mediaDir, raw: res.raw || '' }
          for (const f of files) await pushIndex({ name: f.name, kind: 'image', prompt: String(args.prompt).slice(0, 200), ts: Date.now(), bytes: f.bytes })
          return { ok: true, kind: 'image', urls: files.map(function (f) { return MEDIA_ROUTE + '/' + f.name }), files: files.map(function (f) { return mediaDir + '/' + f.name }) }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      300000))

    registerTool(base('guide_dog_video',
      'Generate videos with MiniMax (MiniMax-H3 or Hailuo). Waits for the task and returns an mp4 url playable in the web UI.',
      params({
        prompt: { type: 'string', description: 'Video description.' },
        model: { type: 'string', enum: ['MiniMax-H3', 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast'], description: 'Model (default MiniMax-H3).' },
        image: { type: 'string', description: 'Input image path or url for image-to-video.' },
        subjectImage: { type: 'string', description: 'Subject reference image path or url (switches to S2V-01).' },
        duration: { type: 'integer', description: 'Output duration in seconds, 4-15 (H3 only, default 5).' },
        ratio: { type: 'string', enum: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], description: 'Aspect ratio (H3 only).' },
      }, ['prompt']),
      async function (args, exec) {
        try {
          args = args || {}
          await ensureMediaDir()
          const model = args.model || 'MiniMax-H3'
          const a = ['video', 'generate', '--model', model, '--prompt', String(args.prompt || '')]
          if (args.image) a.push('--image', String(args.image))
          if (args.subjectImage) a.push('--subject-image', String(args.subjectImage))
          if (args.duration) a.push('--duration', String(args.duration))
          if (args.ratio) a.push('--ratio', String(args.ratio))
          a.push('--async')
          const res = await mmx(a, { timeoutMs: 60000, signal: exec && exec.signal })
          if (!res.ok) return { ok: false, error: res.error }
          const taskId = pick(res.json, ['task_id', 'taskId', 'id', 'file_id', 'fileId'], null)
          if (!taskId) return { ok: false, error: 'no task id in mmx response: ' + JSON.stringify(res.json).slice(0, 400) }
          const deadline = Date.now() + 15 * 60 * 1000
          let fileId = null
          let url = null
          let status = ''
          while (Date.now() < deadline) {
            if (exec && exec.signal && exec.signal.aborted) return { ok: false, error: 'cancelled' }
            const t = await mmx(['video', 'task', 'get', '--task-id', String(taskId)]
              .concat(model === 'MiniMax-H3' ? ['--model', model] : []), { timeoutMs: 30000, signal: exec && exec.signal, quiet: false })
            if (!t.ok) { status = t.error; await sleep(5000); continue }
            const j = t.json
            if (j === null) { await sleep(5000); continue }
            status = String(j.status || j.state || '').toLowerCase()
            if (status === 'failed' || status === 'error' || status === 'cancelled' || status.indexOf('fail') === 0) {
              return { ok: false, error: 'video generation failed: ' + JSON.stringify(j).slice(0, 400) }
            }
            url = pick(j, ['url', 'file_url', 'video_url', 'download_url'], null)
            fileId = pick(j, ['file_id', 'fileId'], null)
            if (status.indexOf('success') === 0 || status === 'succeeded' || status === 'completed' || url || fileId) break
            await sleep(5000)
          }
          if (!url && !fileId) return { ok: false, error: 'video task did not finish within 15 minutes (last status: ' + status + ')' }
          const name = 'video-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.mp4'
          const abs = mediaDir + '/' + name
          let dl
          if (url) {
            const r = await runRaw('curl -sSL --fail -o ' + quote(abs) + ' ' + quote(String(url)), { timeoutMs: 600000, signal: exec && exec.signal })
            dl = r.exitCode === 0 ? { ok: true } : { ok: false, error: (r.stderr || 'curl failed with exit ' + r.exitCode).slice(0, 800) }
          } else {
            dl = await mmx(['video', 'download', '--file-id', String(fileId), '--out', abs], { timeoutMs: 600000, signal: exec && exec.signal })
          }
          if (!dl.ok) return { ok: false, error: dl.error }
          const st = await statFile(abs)
          if (!st || !st.size) return { ok: false, error: 'video downloaded but the file is missing or empty' }
          await pushIndex({ name: name, kind: 'video', prompt: String(args.prompt).slice(0, 200), ts: Date.now(), bytes: st.size || 0 })
          return { ok: true, kind: 'video', url: MEDIA_ROUTE + '/' + name, file: abs, taskId: String(taskId) }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      900000))

    registerTool(base('guide_dog_vision',
      'Describe or answer questions about an image using the MiniMax vision model (VLM). The eyes for DeepSeek when the model cannot see images.',
      params({
        image: { type: 'string', description: 'Local image path or URL.' },
        prompt: { type: 'string', description: 'Question about the image (default: describe the image).' },
      }, ['image']),
      async function (args, exec) {
        try {
          args = args || {}
          const r = await describeImage(args.image, args.prompt, exec && exec.signal)
          if (!r.ok) return { ok: false, error: r.error }
          return { ok: true, answer: r.answer, image: String(args.image) }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      120000))

    registerTool(base('guide_dog_inspect',
      'Structured visual review of an image (frontend design, figure/plot, screenshot, OCR). Auto-invoke for visual checks: it is the only way a non-vision model can QA generated visuals.',
      params({
        image: { type: 'string', description: 'Local image path or URL to inspect.' },
        focus: { type: 'string', enum: ['general', 'frontend', 'figure', 'screenshot', 'ocr'], description: 'Review focus (default general).' },
        prompt: { type: 'string', description: 'Custom review prompt (overrides focus).' },
      }, ['image']),
      async function (args, exec) {
        try {
          args = args || {}
          const focus = args.focus || 'general'
          const prompt = args.prompt || FOCUS_PROMPTS[focus] || FOCUS_PROMPTS.general
          const r = await describeImage(args.image, prompt, exec && exec.signal)
          if (!r.ok) return { ok: false, error: r.error }
          return { ok: true, kind: 'review', answer: r.answer, focus: focus, image: String(args.image) }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      120000))

    registerTool(base('guide_dog_voices',
      'List MiniMax TTS voices (optionally filtered by language) for guide_dog_speak.',
      params({
        language: { type: 'string', description: 'Optional language filter (english, chinese, japanese, korean, ...).' },
      }, []),
      async function (args, exec) {
        try {
          return await voicesImpl(args || {})
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      60000))

    registerTool(base('guide_dog_music',
      'Generate music/songs with MiniMax (music-3.0). Returns an mp3 url playable in the web UI.',
      params({
        prompt: { type: 'string', description: 'Music style description (e.g. "cinematic orchestral, building tension").' },
        lyrics: { type: 'string', description: 'Song lyrics with structure tags ([Verse], [Chorus], ...).' },
        instrumental: { type: 'boolean', description: 'Generate instrumental music (no vocals).' },
        vocals: { type: 'string', description: 'Vocal style (e.g. "warm male baritone").' },
        genre: { type: 'string', description: 'Music genre.' },
        mood: { type: 'string', description: 'Mood or emotion.' },
        model: { type: 'string', enum: ['music-3.0', 'music-2.6', 'music-2.6-free', 'music-2.5+', 'music-2.5'], description: 'Model (default music-3.0).' },
      }, ['prompt']),
      async function (args, exec) {
        try {
          args = args || {}
          await ensureMediaDir()
          const name = 'music-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.mp3'
          const abs = mediaDir + '/' + name
          const a = ['music', 'generate', '--prompt', String(args.prompt || '')]
          if (args.instrumental) a.push('--instrumental')
          if (args.lyrics) a.push('--lyrics', String(args.lyrics))
          if (!args.instrumental && !args.lyrics) a.push('--lyrics-optimizer')
          if (args.vocals) a.push('--vocals', String(args.vocals))
          if (args.genre) a.push('--genre', String(args.genre))
          if (args.mood) a.push('--mood', String(args.mood))
          if (args.model) a.push('--model', String(args.model))
          a.push('--out', abs)
          const res = await mmx(a, { timeoutMs: 300000, signal: exec && exec.signal })
          if (!res.ok) return { ok: false, error: res.error }
          const st = await statFile(abs)
          if (!st) return { ok: false, error: 'music generation finished but the file is missing' }
          await pushIndex({ name: name, kind: 'audio', prompt: String(args.prompt).slice(0, 200), ts: Date.now(), bytes: st.size || 0 })
          return { ok: true, kind: 'audio', url: MEDIA_ROUTE + '/' + name, file: abs }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      300000))

    registerTool(base('guide_dog_text',
      'Chat with a MiniMax text model (default MiniMax-M3). Use when a second model opinion or MiniMax-specific behavior is needed.',
      params({
        message: { type: 'string', description: 'The message to send.' },
        system: { type: 'string', description: 'Optional system prompt.' },
        model: { type: 'string', description: 'Model id (default MiniMax-M3).' },
        maxTokens: { type: 'integer', description: 'Maximum tokens (default 4096).' },
        temperature: { type: 'number', description: 'Sampling temperature (0, 1].' },
      }, ['message']),
      async function (args, exec) {
        try {
          args = args || {}
          const a = ['text', 'chat', '--message', String(args.message || '')]
          if (args.system) a.push('--system', String(args.system))
          if (args.model) a.push('--model', String(args.model))
          if (args.maxTokens) a.push('--max-tokens', String(args.maxTokens))
          if (args.temperature !== undefined && args.temperature !== null) a.push('--temperature', String(args.temperature))
          const res = await mmx(a, { timeoutMs: 180000, signal: exec && exec.signal, quiet: false })
          if (!res.ok) return { ok: false, error: res.error }
          const j = res.json
          let text = null
          if (typeof j === 'string') text = j
          else if (j) {
            const c = j.content
            if (Array.isArray(c) && c[0] && (c[0].text !== undefined || c[0].content !== undefined)) {
              text = c[0].text || c[0].content
            } else {
              text = pick(j, ['text', 'content', 'answer'], null)
            }
            if (text === null && j.choices && j.choices[0]) {
              const ch = j.choices[0]
              text = (ch.message && ch.message.content) || ch.text || null
            }
            if (text === null) text = JSON.stringify(j)
          }
          if (text === null) text = res.raw || ''
          return { ok: true, text: String(text) }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      180000))

    registerTool(base('guide_dog_search',
      'Search the web via MiniMax (at most 10 results per call).',
      params({
        q: { type: 'string', description: 'Search query.' },
      }, ['q']),
      async function (args, exec) {
        try {
          args = args || {}
          const res = await mmx(['search', 'query', '--q', String(args.q || '')], { timeoutMs: 60000, signal: exec && exec.signal })
          if (!res.ok) return { ok: false, error: res.error }
          const j = res.json
          const list = Array.isArray(j) ? j : (pick(j, ['results', 'items', 'data', 'hits', 'organic'], null) || [])
          const results = list.map(function (r) {
            return {
              title: r.title || r.name || '',
              url: r.url || r.link || '',
              snippet: r.snippet || r.summary || r.description || r.content || '',
            }
          })
          return { ok: true, results: results }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      60000))

    // ---------- Phase 1 RPC (config / status) ----------
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/get-config', async function () {
          await configReady
          return { ok: true, config: loadConfig() }
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/set-config', async function (args) {
          if (!args || typeof args.patch !== 'object' || args.patch === null) return { ok: false, error: 'bad_args' }
          const r = await saveConfig(args.patch)
          if (r.ok) await refreshConfig()
          return r
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/status', async function () {
          let status = {}
          const raw = await readTextFile((await guideDogRoot()) + '/.guide-dog/status.json')
          if (raw) { try { status = JSON.parse(raw) } catch (e) { /* ignore */ } }
          return { ok: true, status: status }
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/transcribe', async function (args) { return await transcribeImpl(args || {}) })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/tts-token', async function (args) {
          const sid = args && args.sessionId ? String(args.sessionId) : ''
          if (!sid) return { ok: false, error: 'bad_args', message: 'sessionId required' }
          const token = await issueTtsToken(sid)
          return { ok: true, token: token }
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/beep', async function () {
          const rate = 8000, ms = 150, freq = 880
          const n = Math.floor(rate * ms / 1000)
          const bytes = new Uint8Array(44 + n)
          const dv = new DataView(bytes.buffer)
          const w = function (off, str) { for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i) }
          w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ')
          dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
          dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true)
          w(36, 'data'); dv.setUint32(40, n, true)
          for (let i = 0; i < n; i++) {
            const t = i / rate
            const env = 1 - (i / n)
            bytes[44 + i] = Math.max(0, Math.min(255, Math.round(128 + 100 * env * Math.sin(2 * Math.PI * freq * t))))
          }
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          return { ok: true, dataUri: 'data:audio/wav;base64,' + btoa(bin) }
        })
      } catch (e) { return function () {} }
    })
    // ============ CALL 节（Phase 2，host） ============
    const ttsTokens = new Map() // token -> { sessionId, exp }
    const consent = new Map() // sessionId -> turnSeq（本轮已语音确认）
    // C1 修复（2026-08-16 审稿）：consentPending 记录"用户刚说过确认词"的会话；
    // 由 user 消息监听器（Task 8 Step 3b）置位，下一次 pre-execute 消费并 grantConsent。
    const consentPending = new Set() // sessionId（等待写入放行）
    const callActiveSessions = new Set() // sessionId（持久通话激活，startCall/stopCall 时置位，C4 修复）
    async function issueTtsToken(sessionId) {
      const token = 'gd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
      ttsTokens.set(token, { sessionId: String(sessionId), exp: Date.now() + 5 * 60 * 1000 })
      return token
    }
    function consumeTtsToken(token, sessionId) {
      if (!token || typeof token !== 'string') return false
      const rec = ttsTokens.get(token)
      if (!rec) return false
      ttsTokens.delete(token) // 单次消费
      if (rec.sessionId !== String(sessionId)) return false
      if (rec.exp < Date.now()) return false
      return true
    }
    function grantConsent(sid, turnSeq) { consent.set(String(sid), turnSeq) }
    function hasConsent(sid, turnSeq) {
      const v = consent.get(String(sid))
      return typeof turnSeq === 'number' ? v === turnSeq : v !== undefined
    }
    // M10 语义说明（2026-08-16 审稿）：一次确认放行"本轮"全部写操作——grantConsent 在首次
    // pre-execute 时以该 exec 的 turnSeq 授予；同一 assistant turn 内后续写工具共享同一
    // exec.agent.turn → hasConsent 精确匹配通过。若 exec.agent.turn 为 null（探测未发现 turn），
    // hasConsent 退化为"已授予即可"（v !== undefined），新用户回合前 clearConsent 兜底。
    function clearConsent(sid) { consent.delete(String(sid)) }
    function markConsentPending(sid) { consentPending.add(String(sid)) }
    function consumeConsentPending(sid) { return consentPending.delete(String(sid)) }
    function isCallActive(sid) { return callActiveSessions.has(String(sid)) }
    // 定期清理过期 token（30s 检查，防泄漏）
    // I3（2026-08-16 审稿）：host 侧 timerSvc.interval（callback 形式）未验证——
    // 若 Task 4 探测确认 host interval 不可用，则改为 sleep 轮询（见下方注释替代）。
    const tokenTimer = timerSvc && typeof timerSvc.interval === 'function'
      ? timerSvc.interval(function () {
          const now = Date.now()
          ttsTokens.forEach(function (rec, tok) { if (rec.exp < now) ttsTokens.delete(tok) })
        }, 30000)
      : null
    if (tokenTimer) ctx.effect(tokenTimer)
    // R2（2026-08-16 控制器裁定）：双路径清扫——interval 不可用时启动 sleep 轮询，
    // 与上方 interval 分支互斥（仅一条路径运行）。
    if (!tokenTimer) {
      // 替代：sleep 轮询（Promise 形式，已验证）
      ;(function tokenSweeper() {
        sleep(30000).then(function () {
          const now = Date.now()
          ttsTokens.forEach(function (rec, tok) { if (rec.exp < now) ttsTokens.delete(tok) })
          tokenSweeper()
        })
      })()
    }
    // ---- 共识优先（spec §6.7） ----
    const WRITE_TOOL_NAMES = ['write', 'edit']
    // RC5（2026-08-17 验收）：`>>?` 分支误伤无害重定向——`2>/dev/null`、`>&`（2>&1 等）也被判为
    // 破坏性写入 → 只读命令（如 cat /etc/timezone 2>/dev/null）被 needs_voice_confirmation 拦截。
    // 排除 /dev/null 目标与 & 合并重定向；`echo x > file`、`>> file` 等真实写入仍拦截。
    const DESTRUCTIVE_BASH_RE = /(^|\s|\||;|&&)(rm|mv|cp|truncate|dd|mkfs|git\s+push)\b|>>?(?!\s*(?:\/dev\/null\b|&))[\s\S]*$/m
    function consensusSummary(name, args) {
      try {
        if (name === 'write') {
          const p = args && args.file_path ? String(args.file_path) : '?'
          const content = args && args.content ? String(args.content) : ''
          return '写入文件 ' + p + '（' + content.length + ' 字符）'
        }
        if (name === 'edit') {
          const p = args && args.file_path ? String(args.file_path) : '?'
          const oldS = args && args.old_string ? String(args.old_string) : ''
          return '修改文件 ' + p + '（替换 ' + oldS.length + ' 字符片段）'
        }
        if (name === 'bash') {
          const cmd = args && args.command ? String(args.command) : ''
          if (DESTRUCTIVE_BASH_RE.test(cmd)) return '执行命令：' + cmd.slice(0, 80)
          return ''
        }
        return ''
      } catch (e) { return '' }
    }
    const callActiveFlags = new Map() // sessionId -> boolean（瞬时：用户正在发声，Task 9 窗口期高灵敏上报）
    ctx.effect(function () {
      try {
        // C4 修复（2026-08-16 审稿）：call-active RPC 拆两用——
        //   {active:true, kind:'session'} → callActiveSessions.add（持久激活，Task 7 startCall/stopCall 上报）
        //   {active:true/false, kind:'speaking'} → callActiveFlags.set（瞬时发声，Task 9 共识窗口上报）
        return harness.handle('guide-dog/call-active', async function (args) {
          const sid = args && args.sessionId ? String(args.sessionId) : ''
          if (!sid) return { ok: false, error: 'bad_args' }
          const kind = args && args.kind === 'session' ? 'session' : 'speaking'
          const active = !!(args && args.active)
          if (kind === 'session') {
            if (active) {
              callActiveSessions.add(String(sid))
              // RC11：新通话 = 新队列——清掉挂断/刷新残留的旧条目，防陈旧内容重放
              voiceQueue.delete(String(sid))
              pendingFinal.delete(String(sid)) // RC13：同清中间文本缓冲（pendingFinal 在后文声明，RPC 回调运行时已初始化）
            } else callActiveSessions.delete(String(sid))
          } else {
            callActiveFlags.set(String(sid), active)
          }
          return { ok: true }
        })
      } catch (e) { return function () {} }
    })
    async function announceAndWait(sid, text) {
      // 播报摘要（走同一 TTS 管线，source:'consensus'）；等待窗口；期间用户发声（speaking 置位）→ aborted
      // C5 修复（2026-08-16 审稿）：① 摘要必须入 voiceQueue 且**带 consensus 标记**（speakImpl 只生成 mp3
      //   不排队，旧代码直接 speakImpl → client 轮询取不到 → 用户听不到摘要、窗口永不开启）；
      //   ② 只在生成完成后推最终条目（占位条目会被 client 先弹出——队列是 shift 语义）；
      //   ③ 窗口在**摘要生成完成**后开始计时（client 播放到它需要 ~1-2s，窗口覆盖播放尾声与之后）；
      //   ④ 窗口期监听 speaking 标志从 false 变 true（Task 9 开窗即上报的旧语义自噬，已改为仅真实发声上报）。
      await serialSpeak(function () {
        return speakImpl({ text: text, sessionId: sid, turnSeq: null, source: 'consensus' }).then(function (r) {
          const q2 = voiceQueue.get(String(sid)) || []
          if (r && r.ok && r.url) {
            q2.push({ url: r.url, key: 'consensus:' + sid + ':' + Date.now(), consensus: true })
          } else {
            q2.push({ error: (r && r.error) || 'tts_failed', message: (r && r.message) || '' })
          }
          if (q2.length > VOICE_QUEUE_MAX) q2.shift()
          voiceQueue.set(String(sid), q2)
        }).catch(function (e) {
          const q3 = voiceQueue.get(String(sid)) || []
          q3.push({ error: 'tts_failed', message: String(e).slice(0, 200) })
          if (q3.length > VOICE_QUEUE_MAX) q3.shift()
          voiceQueue.set(String(sid), q3)
        })
      })
      const cfg = loadConfig()
      const winMs = (cfg.call && cfg.call.consensus && cfg.call.consensus.summaryWindowMs) || 3000
      const start = Date.now()
      // 窗口开始：清瞬时标志，之后任何发声都会置 true → aborted
      callActiveFlags.set(String(sid), false)
      while (Date.now() - start < winMs) {
        if (callActiveFlags.get(String(sid)) === true) return 'aborted'
        await sleep(100)
      }
      return 'proceed'
    }
    function consensusEnabled(sid) {
      const cfg = loadConfig()
      const a11yOn = cfg.a11y && cfg.a11y.enabled
      const callOn = cfg.call && cfg.call.consensus && cfg.call.consensus.enabled
      // C3（最终审稿）：共识拦截仅对**通话激活中**的会话生效（spec §6.7 打字模式保持 Phase 1
      // 现状）——write/edit/破坏性 bash 不再被未开通话的普通会话拦截
      return !!(((callOn) && isCallActive(sid)) || a11yOn)
    }
    // C1 修复（2026-08-16 审稿）：user 确认词监听器——用户回复"确定/确认/可以/好"（普通回合内容）
    // → markConsentPending(sid)；下一次 pre-execute 消费该 pending 并 grantConsent。
    // 注意：监听 user 消息事件（Phase 1 的 session/event 监听的是 assistant/message，此处是 user 消息分支）。
    const CONSENT_YES_RE = /^(确定|确认|可以|好的?|行|就这么办|继续)$/
    const CONSENT_NO_RE = /^(取消|不行|不要|算了|停)$/
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'user/message') return
        const sid = (typeof session === 'string' ? session : (session && session.id)) || ''
        if (!sid || !consensusEnabled(sid)) return
        const data = event.data || {}
        const content = Array.isArray(data.content) ? data.content : (data.message && Array.isArray(data.message.content) ? data.message.content : [])
        const text = content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join(' ').trim()
        if (!text) return
        const t = text.replace(/[，。！？\s]/g, '')
        if (CONSENT_YES_RE.test(t)) markConsentPending(sid)
        else if (CONSENT_NO_RE.test(t)) { clearConsent(sid); callActiveFlags.set(String(sid), false) }
      } catch (e) { /* best effort */ }
    })
    ctx.on('tools/pre-execute', async function (exec, next) {
      try {
        // ⚠️ agent→sessionId 推导依赖 Task 4 探测（agent.session.id 形状待定案；
        // 若 agent 无 session 字段，改从 exec.agent 的会话属性或 agents 服务推导）
        // sessionId 推导：agent.session.id（T4 探针实证待确认；若证伪改为 agents 服务推导）
        const sid = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id || '') : ''
        if (!sid || !consensusEnabled(sid)) return next()
        const name = exec && exec.name ? String(exec.name) : ''
        const args = exec && exec.arguments ? exec.arguments : {}
        const isWrite = WRITE_TOOL_NAMES.indexOf(name) >= 0
        const isDestructiveBash = name === 'bash' && DESTRUCTIVE_BASH_RE.test(String((args && args.command) || ''))
        if (!isWrite && !isDestructiveBash) return next()
        // 摘要：写工具强制；bash 仅破坏性命令
        const summary = consensusSummary(name, args)
        if (!summary) return next()
        const turnSeq = exec.agent ? exec.agent.turn : null
        // C1 修复：未共识但用户刚说过确认词 → 消费 pending 并授予本轮 consent（不拦截）
        if (!hasConsent(sid, turnSeq) && consumeConsentPending(sid)) {
          grantConsent(sid, turnSeq) // 原样存储：null → hasConsent 退化为"已授予"；数字 → 精确匹配
        }
        if (hasConsent(sid, turnSeq)) {
          // 已共识：执行前摘要 + 打断窗口
          const verdict = await announceAndWait(sid, '接下来' + summary)
          if (verdict === 'aborted') return { kind: 'deny', reason: 'aborted_by_user' }
          return next()
        }
        // 未共识：拦截，让模型语音提问
        return { kind: 'deny', reason: 'needs_voice_confirmation' }
      } catch (e) {
        // spec §6.8：宁可拦错不可放错；口播原因（不静默）
        try {
          const sid = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id || '') : ''
          if (sid) serialSpeak(function () { return speakImpl({ text: '共识检查失败，已阻止本次操作', sessionId: sid, turnSeq: null, source: 'consensus' }).catch(function () { return null }) })
        } catch (e2) { /* ignore */ }
        return { kind: 'deny', reason: 'consensus_failed' }
      }
    })
    // ---- 进度播报（spec §6.4；RC10 激进精简：仅播有效信息） ----
    function progressPhrase(name) {
      const map = { bash: '正在执行命令', read: '正在查找文件', grep: '正在查找文件', glob: '正在查找文件',
        write: '正在修改文件', edit: '正在修改文件', web_search: '正在搜索网页',
        guide_dog_image: '正在生成媒体', guide_dog_video: '正在生成媒体', guide_dog_music: '正在生成媒体', guide_dog_speak: '正在生成媒体',
        skill: '正在调用技能' }
      return map[name] || '正在执行操作'
    }
    const PROGRESS_SILENT = { read: 1, grep: 1, glob: 1, skill: 1 } // 静默类（Phase 3 自动播报同白名单基础）
    const PROGRESS_MEDIA = { guide_dog_image: 1, guide_dog_video: 1, guide_dog_music: 1, guide_dog_speak: 1 } // RC10：生成媒体（耗时长，值得播）
    // RC10（2026-08-17 验收）：激进精简——只播有意义的步骤：
   //   write/edit（修改文件）、web_search（搜索）、媒体工具（生成媒体）、bash 仅破坏性命令
    //   （与共识拦截同口径 DESTRUCTIVE_BASH_RE）；read/grep/glob/skill/未知工具静默——
    //   不再播"正在执行操作"，多步任务不再连珠炮式播报。
    function shouldAnnounce(name, args) {
      if (PROGRESS_SILENT[name]) return false
      if (name === 'write' || name === 'edit' || name === 'web_search') return true
      if (PROGRESS_MEDIA[name]) return true
      if (name === 'bash') return DESTRUCTIVE_BASH_RE.test(String((args && args.command) || ''))
      return false // 未知工具静默
    }
    // RC10：同短语冷却去重——cooldownMs 内同短语不重复播（多步同类操作只报一次）
    function progressDedupe(last, phrase, now, cooldownMs) {
      if (last && last.phrase === phrase && now - last.ts < (cooldownMs || 4000)) return true
      return false
    }
    const lastProgress = new Map() // sessionId -> {phrase, ts}：播报去重冷却状态
    function callOrA11yActive(sid) {
      const cfg = loadConfig()
      // C4 修复：读持久 callActiveSessions（isCallActive），不再读瞬时 callActiveFlags
      return !!((cfg.call && cfg.call.progress && isCallActive(sid)) || (cfg.a11y && cfg.a11y.enabled))
    }
    // RC10（2026-08-17 验收）：播报从 mp3 并入流式通道——不再 speakImpl 合成 mp3，
    // 直接 unshift {stream:true} 条目：与回复句子同走唯一 WebAudio PCM 链、同一时间线 →
    // 单播放器构造性串行（一条接一条，不可能重叠/爆音）；合成延迟由 client 播放时承担。
    // 去重：同短语冷却窗口内跳过（出错文本唯一，天然不冲突）。
    function announce(sid, text) {
      const now = Date.now()
      if (progressDedupe(lastProgress.get(String(sid)), text, now)) {
        try { console.log('[gd-host] announce DEDUPE ' + text) } catch (e) { /* ignore */ }
        return
      }
      lastProgress.set(String(sid), { phrase: text, ts: now })
      const q2 = voiceQueue.get(String(sid)) || []
      q2.unshift({ stream: true, text: text, key: 'progress:' + String(sid) + ':' + text })
      if (q2.length > VOICE_QUEUE_MAX) q2.pop()
      voiceQueue.set(String(sid), q2)
      try { console.log('[gd-host] announce ' + text + ' qlen=' + q2.length) } catch (e) { /* ignore */ }
    }
    // ⚠️ agent→sessionId 推导依赖 Task 4 探测（agent.session.id 形状待定案；
    // 若 agent 无 session 字段，改从 exec.agent 的会话属性或 agents 服务推导）
    // sessionId 推导：agent.session.id（T4 探针实证待确认；若证伪改为 agents 服务推导）
    ctx.on('agent/status', function (payload) {
      try {
        const agent = payload && payload.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (!sid || !callOrA11yActive(sid)) return
        if (payload.status === 'running') announce(sid, '正在处理')
      } catch (e) { /* best effort */ }
    })
    ctx.on('tools/result', function (exec, result) {
      try {
        const agent = exec && exec.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        const name = exec && exec.name ? String(exec.name) : ''
        const args = exec && exec.arguments ? exec.arguments : {}
        if (!sid || !callOrA11yActive(sid) || !shouldAnnounce(name, args)) return
        const phrase = progressPhrase(name)
        announce(sid, phrase)
      } catch (e) { /* best effort */ }
    })
    ctx.on('agent/error', function (payload) {
      try {
        const agent = payload && payload.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (!sid || !callOrA11yActive(sid)) return
        const err = payload.error || {}
        announce(sid, '处理出错：' + String((err && err.message) || err).slice(0, 60))
      } catch (e) { /* best effort */ }
    })
    // ---- 下行流式 TTS（spec §6.5，零 WebSocket） ----
    function splitSentences(text, splitChars, maxChars) {
      if (!text) return []
      const chars = splitChars || '。！？.!?\n'
      const esc = chars.replace(/[\\\]]/g, '\\$&')
      const re = new RegExp('[' + esc + ']', 'g')
      const out = []
      let last = 0, m
      while ((m = re.exec(text)) !== null) {
        const seg = text.slice(last, m.index + 1).trim()
        if (seg) out.push(seg)
        last = m.index + 1
      }
      const tail = text.slice(last).trim()
      if (tail) out.push(tail)
      const res = []
      for (const s of out) {
        if (s.length <= maxChars) res.push(s)
        else for (let i = 0; i < s.length; i += maxChars) res.push(s.slice(i, i + maxChars))
      }
      return res
    }
    const speechStreamBusy = new Map() // sessionId -> bool
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'exact',
          path: '/guide-dog/tts-stream',
          handler: async function (req, res) {
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
              const url = new URL(String(req.url || '/'), 'http://local')
              const token = url.searchParams.get('token') || ''
              const sid = url.searchParams.get('sid') || ''
              const text = url.searchParams.get('text') || ''
              if (!sid || !text || !consumeTtsToken(token, sid)) { res.writeHead(403); res.end(); return }
              if (speechStreamBusy.get(sid)) { res.writeHead(429); res.end(); return }
              speechStreamBusy.set(sid, true)
              const cfg = loadConfig()
              const streamCfg = (cfg.call && cfg.call.stream) || {}
              const format = streamCfg.format || 'pcm'
              const sampleRate = streamCfg.sampleRate || 24000
              // RC7（2026-08-17 验收）：默认 call.voice 为英文音色——中文文本用英文音色输出近削波
              // 爆音（实测 peak 31358/rms 6006 vs 中文音色 5609/928）。与 speakImpl 同款 CJK 判定：
              // 中文走 voiceZh，非中文走 call.voice。
              const ttsCfg = loadConfig().tts || {}
              const voice = hasCJK(text) ? (ttsCfg.voiceZh || 'Chinese (Mandarin)_Gentle_Youth') : ((cfg.call && cfg.call.voice) || 'English_expressive_narrator')
              const speed = (cfg.call && cfg.call.speed) || 1.0
              res.writeHead(200, { 'content-type': 'audio/' + format, 'cache-control': 'no-store' })
              let handle = null
              try {
                handle = subprocess.spawn({
                  argv: ['mmx', 'speech', 'synthesize', '--stream', '--text', text, '--format', format, '--sample-rate', String(sampleRate), '--voice', voice, '--speed', String(speed)],
                  cwd: (await guideDogRoot()) + '/.guide-dog',
                  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 * 1024 } },
                  graceMs: 3000,
                })
                let first = true
                handle.stdout.on('data', function (chunk) {
                  if (first) { first = false; if (req.method === 'HEAD') { try { handle.terminate() } catch (e) { /* ignore */ } } }
                  if (req.method === 'HEAD') return
                  try { res.write(chunk) } catch (e) { try { handle.terminate() } catch (e2) { /* ignore */ } }
                })
                await handle.done
                try { res.end() } catch (e) { /* ignore */ }
              } catch (e) {
                // I1（最终审稿）：writeHead(200) 已发出时 spawn 失败 → 再 writeHead(500) 抛
                // ERR_HTTP_HEADERS_SENT（被吞）且响应永不 end → client fetch 挂死。加
                // headersSent 守卫并保证响应一定结束。
                try { if (!res.headersSent) res.writeHead(500); res.end() } catch (e2) { /* ignore */ }
              } finally {
                speechStreamBusy.delete(sid)
              }
            } catch (e) {
              try { if (!res.headersSent) res.writeHead(500); res.end() } catch (e2) { /* ignore */ }
            }
          },
        })
      } catch (e) { return function () {} }
    })
    // 下行主通道：assistant 消息 → 分句 → 流条目入队列（client 播放器识别 stream 条目走 GET）
    // RC11：按 (turn,step) 去重——同一事件重复/重放时不重复入队
    const lastStreamTurn = new Map() // sessionId -> 'turn:step'
    // RC13：只播回合最终消息——中间步骤（带 tool-call 块）只缓冲不播；turn/end 兜底
    const pendingFinal = new Map() // sessionId -> { turn, text }（中间文本最后一条为准）
    function streamTurnKey(turn, step) { return String(turn) + ':' + String(step) }
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'assistant/message') return
        const sid = (typeof session === 'string' ? session : (session && session.id)) || ''
        if (!sid) return
        const cfg = loadConfig()
        const callActive = isCallActive(sid) // C4 修复：持久激活（Task 7 startCall/stopCall 上报）
        const a11yOn = cfg.a11y && cfg.a11y.enabled
        if (!callActive && !a11yOn) return // 仅通话/a11y 会话走流式；语音模式走 Phase 1 队列
        const data = event.data || {}
        const content = Array.isArray(data.content) ? data.content : (data.message && Array.isArray(data.message.content) ? data.message.content : [])
        const text = content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join('\n').trim()
        if (!text) return
        // RC13（三路评审定案）：中间步骤的 assistant/message 必带 tool-call 块（dsh-agent-loop
        // step()：无 tool-call 即返回 completed）——逐 step 播放 = "同一内容反复播报"。带
        // tool-call 的消息：文本入 pendingFinal（只留最后一条），本回合最终消息缺失时由
        // turn/end 监听兜底播放（终结型工具回合不静音）。
        const hasToolCall = content.some(function (b) { return b && b.type === 'tool-call' })
        if (hasToolCall) {
          if (text) pendingFinal.set(sid, { turn: data.turn, text: text })
          return
        }
        pendingFinal.delete(sid)
        // RC13（Task 3）：双通道互斥——本机扬声器已播（guide_dog_speak playOnHost）的文本不再入队
        if (wasHostSpoken(sid, text)) return
        // RC11：同一 (turn,step) 只入队一次——防重复事件/重放把同一内容多次入队（"同一内容重复播放"贡献因子）
        const tkey = streamTurnKey(data.turn, data.step)
        if (tkey !== 'undefined:undefined' && lastStreamTurn.get(sid) === tkey) return
        lastStreamTurn.set(sid, tkey)
        const streamCfg = (cfg.call && cfg.call.stream) || {}
        const sentences = splitSentences(text, streamCfg.sentenceSplit, streamCfg.maxSentenceChars || 200)
        const q = voiceQueue.get(sid) || []
        sentences.forEach(function (s) { q.push({ stream: true, text: s, key: 'stream:' + sid + ':' + event.seq + ':' + s.slice(0, 8) }) })
        if (q.length > VOICE_QUEUE_MAX) q.splice(0, q.length - VOICE_QUEUE_MAX)
        voiceQueue.set(sid, q)
        // RC12 诊断日志（DSH 终端可见）
        try { console.log('[gd-host] enqueue n=' + sentences.length + ' qlen=' + q.length + ' text=' + text.slice(0, 20)) } catch (e) { /* ignore */ }
      } catch (e) { /* best effort */ }
    })
    // RC13：回合结束兜底——本回合无可播最终消息（终结型工具回合：最后一条 assistant/message
    // 带 tool-call 块被过滤）时，把 pendingFinal 缓冲的中间文本播出去，避免整回合静音。
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'turn/end') return
        const sid = (typeof session === 'string' ? session : (session && session.id)) || ''
        if (!sid) return
        const cfg = loadConfig()
        if (!isCallActive(sid) && !(cfg.a11y && cfg.a11y.enabled)) return
        const turn = (typeof (event.data && event.data.turn) === 'number') ? event.data.turn : null
        if (turn === null) return
        const pend = pendingFinal.get(sid)
        if (!pend || pend.turn !== turn || !pend.text) return
        pendingFinal.delete(sid)
        const streamCfg = (cfg.call && cfg.call.stream) || {}
        const sentences = splitSentences(pend.text, streamCfg.sentenceSplit, streamCfg.maxSentenceChars || 200)
        const q = voiceQueue.get(sid) || []
        sentences.forEach(function (s) { q.push({ stream: true, text: s, key: 'stream:' + sid + ':turnend:' + turn + ':' + s.slice(0, 8) }) })
        if (q.length > VOICE_QUEUE_MAX) q.splice(0, q.length - VOICE_QUEUE_MAX)
        voiceQueue.set(sid, q)
        try { console.log('[gd-host] turn-end flush n=' + sentences.length + ' turn=' + turn) } catch (e) { /* ignore */ }
      } catch (e) { /* best effort */ }
    })
    // ---- 容错（spec §6.8） ----
    const lastAgentEvent = new Map() // sessionId -> ts
    ctx.on('agent/status', function (payload) {
      try {
        const agent = payload && payload.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (sid) lastAgentEvent.set(sid, Date.now())
      } catch (e) { /* ignore */ }
    })
    ctx.on('tools/result', function (exec) {
      try {
        const agent = exec && exec.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (sid) lastAgentEvent.set(sid, Date.now())
      } catch (e) { /* ignore */ }
    })
    function heartbeatCheck() {
      const now = Date.now()
      // C4 修复：遍历持久激活集合（callActiveSessions），不再读瞬时 callActiveFlags
      callActiveSessions.forEach(function (sid) {
        const last = lastAgentEvent.get(String(sid)) || now
        if (now - last > 120000) {
          lastAgentEvent.set(String(sid), now) // 防重复轰炸
          // RC10：与 announce 同机制——流条目（单通道串行），不再 speakImpl 合成 mp3
          const q2 = voiceQueue.get(String(sid)) || []
          q2.unshift({ stream: true, text: '仍在处理，请稍候', key: 'hb:' + String(sid) })
          if (q2.length > VOICE_QUEUE_MAX) q2.pop()
          voiceQueue.set(String(sid), q2)
        }
      })
    }
    // R2（2026-08-16 控制器裁定）：双路径心跳——interval 可用走 timerSvc.interval
    // （disposer 挂 ctx.effect），否则 sleep 递归清扫；两条路径互斥，仅一条运行。
    // T3 守护：timerSvc 为 null 时 sleep 路径绝不启动（sleep 早退 → Promise 立即 resolve → 忙循环）。
    function startSleepSweeper() {
      // 前置分号防 ASI 合并（IIFE 语句）
      ;(function hb() {
        sleep(30000).then(function () {
          heartbeatCheck()
          hb()
        })
      })()
    }
    const heartbeatTimer = timerSvc && typeof timerSvc.interval === 'function'
      ? timerSvc.interval(heartbeatCheck, 30000)
      : (timerSvc ? startSleepSweeper() : null)
    if (heartbeatTimer) ctx.effect(heartbeatTimer)
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/call-command', async function (args) {
          const sid = args && args.sessionId ? String(args.sessionId) : ''
          const cmd = args && args.cmd ? String(args.cmd) : ''
          if (!sid || !cmd) return { ok: false, error: 'bad_args' }
          if (cmd === 'clear-queue') { voiceQueue.delete(sid); return { ok: true } }
          // RC11：打断直达 agent——steer 作为 next-step 输入注入运行中的回合（下一个 step
          // 边界消费；DSH 无 step-only abort）。消息形状对齐 dsh-llm UserMessage。
          if (cmd === 'interrupt') {
            const text = args && typeof args.text === 'string' ? args.text.trim() : ''
            if (!text) return { ok: false, error: 'bad_args' }
            const agentsSvc = ctx.get('agents')
            const agent = agentsSvc && typeof agentsSvc.get === 'function' ? agentsSvc.get(sid) : null
            if (agent && typeof agent.steer === 'function') {
              try {
                const msg = { id: 'gd-interrupt:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'user' } }
                await agent.steer(msg)
                return { ok: true, delivered: true }
              } catch (e) {
                return { ok: false, error: 'steer_failed', message: String(e).slice(0, 200) }
              }
            }
            return { ok: false, error: 'agent_unavailable' }
          }
          return { ok: true }
        })
      } catch (e) { return function () {} }
    })
    // ============ VOICE MODE 节（Phase 1，host） ============
    // 事件形状（决策门 probe2.json 回填）：
    //   - assistant/message 事件键: [type, seq, time, data, ...] → 判定字段 event.type === 'assistant/message'
    //   - 文本提取: const data = event.data || {}；content 取 data.content（或 data.message.content）blocks；
    //     text = content 中 type==='text' 的 b.text 拼接
    //   - seq = event.seq；sessionId = session 参数（对象时 session.id）
    const VOICE_QUEUE_MAX = 10 // M5：每会话队列上限（防 voiceQueue 无界增长；超限丢最旧）
    const voiceQueue = new Map() // sessionId -> Array<{url,key} | {error,message}>
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'assistant/message') return
        const sid = (typeof session === 'string' ? session : (session && session.id)) || ''
        if (!sid) return
        const cfg = loadConfig()
        const vm = cfg.voiceMode || {}
        const effective = vm.sessions && vm.sessions[sid] !== undefined ? vm.sessions[sid] : vm.default
        if (!effective) return
        if (isCallActive(sid) || (loadConfig().a11y && loadConfig().a11y.enabled)) return // Phase 2：通话/a11y 由流式通道接管，防双播
        const seq = (typeof event.seq === 'number') ? event.seq : null // M11：缺失时不参与去重（speakImpl 对 null 不去重）
        const data = event.data || {}
        const content = Array.isArray(data.content) ? data.content : (data.message && Array.isArray(data.message.content) ? data.message.content : [])
        const text = content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join('\n').trim()
        if (!text) return
        // RC13：语音模式同样只播回合最终消息——"非通话语音模式也反复播放同一内容"同根因
        // （逐 step 播近同文案）。带 tool-call 的中间消息直接跳过（语音模式终结工具回合
        // 极少见，不设 turn/end 兜底）。
        const hasToolCall = content.some(function (b) { return b && b.type === 'tool-call' })
        if (hasToolCall) return
        // RC13（Task 3）：双通道互斥
        if (wasHostSpoken(sid, text)) return
        // 异步串行 TTS，不阻塞事件循环
        serialSpeak(function () {
          return speakImpl({ text: text, sessionId: sid, turnSeq: seq, source: 'voice-mode' }).then(function (r) {
            const q = voiceQueue.get(sid) || []
            if (r && r.ok && r.url && !r.skipped) q.push({ url: r.url, key: sid + ':' + seq })
            // M6：错误项统一 { error: <码>, message: <人读文本> }，client 优先显示 message
            else if (r && !r.ok) q.push({ error: (r.error || 'tts_failed'), message: (r.message || '') })
            if (q.length > VOICE_QUEUE_MAX) q.shift()
            voiceQueue.set(sid, q)
          }).catch(function (e) {
            // M8：绝不静默 —— speakImpl reject 也入错误项（重新取 map，避免陈旧引用）
            const q = voiceQueue.get(sid) || []
            q.push({ error: 'tts_failed', message: String((e && e.message) || e).slice(0, 200) })
            if (q.length > VOICE_QUEUE_MAX) q.shift()
            voiceQueue.set(sid, q)
          })
        })
      } catch (e) { /* listener is best effort */ }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/voice-queue', async function (args) {
          const sid = args && args.sessionId ? String(args.sessionId) : ''
          if (!sid) return { ok: true, entry: null }
          const q = voiceQueue.get(sid) || []
          const entry = q.length ? q.shift() : null
          if (!q.length) voiceQueue.delete(sid)
          if (entry) { try { console.log('[gd-host] shift key=' + String(entry.key || '?')) } catch (e) { /* ignore */ } }
          return { ok: true, entry: entry }
        })
      } catch (e) { return function () {} }
    })

    // ---------- RPC handlers (client -> host) ----------
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/speak', async function (args) {
          return serialSpeak(function () { return speakImpl(args || {}) })
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/list-media', async function (args) {
          try {
            if (!mediaDir) await ensureMediaDir()
            return await listMedia((args && args.limit) || 50)
          } catch (e) { return [] }
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/auth-status', async function () {
          try {
            const r = await mmx(['auth', 'status'], { timeoutMs: 15000 })
            if (!r.ok) return { ok: false, error: r.error }
            const j = r.json || {}
            const key = j.key || ''
            const masked = key.length > 10 ? key.slice(0, 4) + '…' + key.slice(-4) : (key ? 'set' : '')
            return { ok: true, method: j.method || '', source: j.source || '', keyMasked: masked }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/voices', async function (args) {
          try {
            return await voicesImpl(args || {})
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        })
      } catch (e) { return function () {} }
    })

    refreshConfig().catch(function (e) { console.error('[guide-dog] config init failed: ' + String(e)) })
    ensureWhisperScript().catch(function (e) { console.error('[guide-dog] whisper script init failed: ' + String(e)) })
    probeWhisper().catch(function (e) { console.error('[guide-dog] whisper probe failed: ' + String(e)) })

    // eager, non-blocking media dir init
    ensureMediaDir().catch(function (e) {
      console.error('[guide-dog] media dir init failed: ' + String(e))
    })
  },
}
