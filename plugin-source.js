// ==== HOST HALF ====
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

    console.log('[guide-dog] apply shell=' + !!shell + ' fs=' + !!fsSvc + ' webServer=' + !!webServer + ' sandboxPolicy=' + !!sandboxPolicy + ' systemPrompt=' + !!systemPrompt + ' subprocess=' + !!subprocess + ' timer=' + !!timerSvc)

    // ============ CONFIG 节（Phase 1） ============
    const CONFIG_DEFAULTS = {
      voiceMode: { default: false, sessions: {} },
      voiceInput: { autoSend: false, engine: 'whisper', language: 'auto', maxSeconds: 60, whisper: { python: 'python3', model: 'small' } },
      tts: { voiceEn: 'English_expressive_narrator', voiceZh: 'Chinese (Mandarin)_Gentle_Youth', speed: 0.95, format: 'mp3' },
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
stdout 恒为单行 JSON; exit 恒 0（调用方以 ok 字段判断）。--out-file 可选：同时把同一 JSON 写入文件（host 端读取用）。"""
import argparse, base64, json, os, sys, tempfile, time

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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', default=None)
    ap.add_argument('--audio-b64-file', default=None)
    ap.add_argument('--delete-b64', action='store_true')
    ap.add_argument('--model', default='small')
    ap.add_argument('--language', default='auto')
    ap.add_argument('--out-file', default=None)
    ap.add_argument('--output', default='json')
    args = ap.parse_args()
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
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        lang = None if args.language == 'auto' else args.language
        segments, info = model.transcribe(audio_path, language=lang, vad_filter=True)
        text = ''.join(s.text for s in segments).strip()
        if not text:
            emit({'ok': False, 'error': 'empty_speech', 'message': 'no speech recognized'}, args.out_file)
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
      const res = await runRaw(quote(py) + " -c 'import faster_whisper; print(faster_whisper.__version__)'", { timeoutMs: 15000 })
      await writeStatus({
        whisperAvailable: res.exitCode === 0 && !res.denied,
        whisperVersion: (res.stdout || '').trim(),
        whisperPython: py,
        probeAt: Date.now(),
      })
    }
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
      const model = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.model) || 'small'
      const lang = (args.language || (cfg.voiceInput && cfg.voiceInput.language) || 'auto')
      await runRaw('mkdir -p ' + quote(root + '/.guide-dog/tmp'), { timeoutMs: 10000 })
      const wrote = await writeTextFile(b64Path, args.audioB64)
      if (!wrote) return { ok: false, error: 'stt_failed', message: 'cannot write temp audio' }
      let handle = null
      try {
        await ensureWhisperScript()
        handle = subprocess.spawn({
          argv: [py, script, '--audio-b64-file', b64Path, '--delete-b64', '--model', model, '--language', lang, '--out-file', outFile, '--output', 'json'],
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
        // 精确文件名清理（审查 M13：不用通配符，quote 会阻止 glob 展开）
        await runRaw('rm -f ' + quote(b64Path) + ' ' + quote(outFile), { timeoutMs: 10000 }).catch(function () {})
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
      if (args.playOnHost) await playOnHost(abs)
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
      if (!player) return
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
      } catch (e) { /* playback is best effort */ }
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
              const bytes = await readBytes(abs, size || MAX_FILE_BYTES)
              if (!bytes) { res.writeHead(404); res.end(); return }
              const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': String(size) }
              let status = 200
              let body = bytes
              const range = req.headers && req.headers.range ? String(req.headers.range) : ''
              if (range) {
                const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
                if (m && (m[1] || m[2])) {
                  let start = 0
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
                  body = bytes.slice(start, end + 1)
                  status = 206
                  headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size
                  headers['content-length'] = String(body.length)
                }
              }
              res.writeHead(status, headers)
              res.end(req.method === 'HEAD' ? undefined : body)
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
        const seq = (typeof event.seq === 'number') ? event.seq : null // M11：缺失时不参与去重（speakImpl 对 null 不去重）
        const data = event.data || {}
        const content = Array.isArray(data.content) ? data.content : (data.message && Array.isArray(data.message.content) ? data.message.content : [])
        const text = content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join('\n').trim()
        if (!text) return
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

// ==== CLIENT HALF ====
return {
  async apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return

    const TOOL_KEYS = [
      'guide_dog_speak', 'guide_dog_image', 'guide_dog_video', 'guide_dog_vision',
      'guide_dog_inspect', 'guide_dog_music', 'guide_dog_text', 'guide_dog_search',
      'guide_dog_voices',
    ]
    const VARIANTS = {
      guide_dog_speak: 'audio', guide_dog_music: 'audio',
      guide_dog_image: 'image', guide_dog_video: 'video',
      guide_dog_vision: 'text', guide_dog_inspect: 'text', guide_dog_text: 'text',
      guide_dog_search: 'list', guide_dog_voices: 'list',
    }

    const h = React.createElement

    // ============ VOICE 群组（Phase 1 修订：输入框左下角 + 会话切换播放修复） ============
    // 播放与轮询解耦：curAudio 为模块级对象，切换会话不销毁 → 播放中的音频自然播到结束；
    // 新播放任务（任一会话的新队列条目）覆盖当前播放。语音模式开关/语言检测/麦克风整合在
    // conversation.input.left（输入框工具行左端），样式使用 DSH 主题令牌（--dsw-alias-*），
    // 字体继承输入行，不做自定义 font-family。
    const voiceState = { cfg: null, beepUri: null }
    // 右下角即时通知（toast）：语音模式失败/播放失败在此显示，6 秒自动消失
    const toastState = { text: null, at: 0 }
    function showToast(text) {
      toastState.text = String(text).slice(0, 120)
      toastState.at = Date.now()
    }
    let timerSvc = null
    try { timerSvc = ctx.get('timer') } catch (e) { timerSvc = null }
    function voiceEffective(sid) {
      if (!voiceState.cfg || !voiceState.cfg.voiceMode) return false
      const vm = voiceState.cfg.voiceMode
      return sid && vm.sessions && vm.sessions[sid] !== undefined ? !!vm.sessions[sid] : !!vm.default
    }
    function loadVoiceCfg() {
      return host.call('guide-dog/get-config', {}).then(function (r) {
        if (r && r.ok && r.config) { voiceState.cfg = r.config }
      }).catch(function () {})
    }
    function setVoiceOverride(sid, v) {
      const cur = (voiceState.cfg && voiceState.cfg.voiceMode && voiceState.cfg.voiceMode.sessions) || {}
      const sessions = Object.assign({}, cur)
      sessions[sid] = !!v // 显式布尔：全局默认开时也能用 false 覆盖关闭该会话
      return host.call('guide-dog/set-config', { patch: { voiceMode: { sessions: sessions } } }).then(function (r) {
        if (r && r.ok) return loadVoiceCfg()
      }).catch(function () {})
    }
    // ---- 模块级播放器：会话切换不中断；新播放任务覆盖旧任务 ----
    let curAudio = null
    function stopCurrent() {
      if (curAudio) {
        try { curAudio.pause() } catch (e) { /* ignore */ }
        curAudio = null
      }
    }
    function playEntry(url) {
      stopCurrent()
      if (typeof Audio !== 'function') {
        showToast('播放器不可用'); return
      }
      try {
        const a = new Audio(String(url))
        curAudio = a
        a.onended = function () { if (curAudio === a) curAudio = null }
        a.onerror = function () {
          if (curAudio === a) { curAudio = null; showToast('播放失败') }
        }
        const p = a.play()
        if (p && typeof p.catch === 'function') p.catch(function () {
          if (curAudio === a) { curAudio = null; showToast('浏览器阻止了自动播放，请先点击页面') }
        })
      } catch (e) {
        curAudio = null
        showToast('播放失败')
      }
    }
    function beepFallback() {
      // WebAudio 振荡器兜底：Audio 元素被自动播放策略拦截时使用
      var AC = null
      try { AC = AudioContext } catch (e) { AC = null }
      if (!AC) { try { AC = window.webkitAudioContext } catch (e2) { AC = null } }
      if (!AC) return
      try {
        const ctx = new AC()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.frequency.value = 880
        osc.connect(gain); gain.connect(ctx.destination)
        gain.gain.setValueAtTime(0.25, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22)
        osc.start()
        osc.stop(ctx.currentTime + 0.22)
        osc.onended = function () { try { ctx.close() } catch (e3) { /* ignore */ } }
      } catch (e) { /* ignore */ }
    }
    function playBeep() {
      const doPlay = function (uri) {
        if (typeof Audio !== 'function') { beepFallback(); return }
        try {
          const a = new Audio(uri)
          a.volume = 0.8
          const p = a.play()
          if (p && typeof p.catch === 'function') p.catch(function (err) {
            console.log('[guide-dog] beep play blocked: ' + String((err && err.message) || err))
            beepFallback()
          })
        } catch (e) { beepFallback() }
      }
      if (voiceState.beepUri) { doPlay(voiceState.beepUri); return }
      // 惰性获取：apply 时的 beep 请求若未完成/失败，错误到来时补拉
      host.call('guide-dog/beep', {}).then(function (r) {
        if (r && r.ok && r.dataUri) { voiceState.beepUri = r.dataUri; doPlay(r.dataUri) }
        else beepFallback()
      }).catch(function () { beepFallback() })
    }
    let pollBusy = false
    // ---- 麦克风（模块级状态；组件只持有 phase/seconds/lang/error） ----
    let micRec = null // {rec, stream}
    let micChunks = []
    let micSeconds = 0
    let micLang = 'auto'
    function insertText(inputActions, text) {
      const primary = inputActions && inputActions.setDraft
      if (typeof primary === 'function') { primary(text); return true }
      const set = inputActions.setValue || inputActions.setText || inputActions.replaceText || inputActions.append
      if (typeof set === 'function') { set(text); return true }
      const app = inputActions.appendText || inputActions.insert
      if (typeof app === 'function') { app(text); return true }
      return false
    }
    function submitInput(inputActions) {
      const sub = inputActions.submit || inputActions.send
      if (typeof sub === 'function') sub()
    }
    function windowCannotRecord() {
      var nav = null; try { nav = navigator } catch (e) { nav = null }
      var mr = null; try { mr = MediaRecorder } catch (e) { mr = null }
      var b64 = null; try { b64 = btoa } catch (e) { b64 = null }
      var bl = null; try { bl = Blob } catch (e) { bl = null }
      var ab = false
      try { ab = bl !== null && typeof bl.prototype.arrayBuffer === 'function' } catch (e) { ab = false }
      return !nav || !nav.mediaDevices || typeof mr !== 'function' || typeof b64 !== 'function' || typeof bl !== 'function' || !ab
    }
    function transcribe(sid, inputActions, set) {
      const parts = micChunks
      micChunks = []
      if (!parts.length) { set(function (prev) { return Object.assign({}, prev, { phase: 0, error: 'empty_speech' }) }); return }
      try {
        const blob = new Blob(parts, { type: 'audio/webm' })
        blob.arrayBuffer().then(function (buf) {
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          set(function (prev) { return Object.assign({}, prev, { phase: 2, error: null }) })
          return host.call('guide-dog/transcribe', { audioB64: btoa(bin), mime: 'audio/webm', sessionId: sid, language: micLang })
        }).then(function (r) {
          if (r && r.ok && r.text) {
            const inserted = insertText(inputActions, r.text)
            set(function (prev) { return Object.assign({}, prev, { phase: 0, error: inserted ? null : 'insert_failed' }) })
            if (inserted && voiceState.cfg && voiceState.cfg.voiceInput && voiceState.cfg.voiceInput.autoSend) submitInput(inputActions)
          } else {
            set(function (prev) { return Object.assign({}, prev, { phase: 0, error: (r && r.error) || 'stt_failed' }) })
          }
        }).catch(function () { set(function (prev) { return Object.assign({}, prev, { phase: 0, error: 'stt_failed' }) }) })
      } catch (e) { set(function (prev) { return Object.assign({}, prev, { phase: 0, error: 'stt_failed' }) }) }
    }
    // ---- 图标（feather 风格细线 SVG，currentColor 跟随主题） ----
    function svgIcon(children, extra) {
      return h('svg', Object.assign({
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, extra || {}), children)
    }
    function micIcon(recording) {
      return svgIcon([
        h('rect', { key: 'r', x: 9, y: 2, width: 6, height: 12, rx: 3 }),
        h('path', { key: 'p', d: 'M19 10v1a7 7 0 0 1-14 0v-1' }),
        h('line', { key: 'l', x1: 12, y1: 18, x2: 12, y2: 22 }),
      ], recording ? { style: { color: 'var(--dsw-alias-state-error-primary)' } } : null)
    }
    function speakerIcon(on) {
      if (on) {
        return svgIcon([
          h('path', { key: 'b', d: 'M11 5 6 9H2v6h4l5 4V5z' }),
          h('path', { key: 'w', d: 'M15.54 8.46a5 5 0 0 1 0 7.07' }),
        ], { style: { color: 'var(--dsw-alias-state-success-primary)' } })
      }
      return svgIcon([
        h('path', { key: 'b', d: 'M11 5 6 9H2v6h4l5 4V5z' }),
        h('line', { key: 'x1', x1: 22, y1: 9, x2: 16, y2: 15 }),
        h('line', { key: 'x2', x1: 16, y1: 9, x2: 22, y2: 15 }),
      ])
    }
    // ---- 主题一致样式（DSH 令牌；字体继承输入行） ----
    ctx.effect(function () {
      try {
        return styles.insert(
          '.gd-voice{display:inline-flex;align-items:center;gap:2px;line-height:1}' +
          '.gd-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
          '.gd-btn:hover{background:var(--dsw-alias-bg-layer-2)}' +
          '.gd-btn.gd-rec{animation:gd-pulse 1s ease-in-out infinite}' +
          '@keyframes gd-pulse{0%,100%{opacity:1}50%{opacity:.4}}' +
          '.gd-select{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:3px 2px;cursor:pointer;border-radius:6px}' +
          '.gd-select:hover{background:var(--dsw-alias-bg-layer-2)}' +
          '.gd-sec{font-size:11px;color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums}' +
          '.gd-err{font-size:11px;color:var(--dsw-alias-state-error-primary);white-space:nowrap}' +
          '.gd-toast{position:fixed;right:16px;bottom:16px;max-width:380px;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:auto;animation:gd-toast-in .18s ease-out}' +
          '.gd-toast-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none}' +
          '.gd-toast-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
          '@keyframes gd-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'
        )
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      loadVoiceCfg()
      host.call('guide-dog/beep', {}).then(function (r) { if (r && r.ok) voiceState.beepUri = r.dataUri }).catch(function () {})
      return slots.inject('conversation.input.left', function () {
        return slots.register(
          { name: 'conversation.input.left', id: 'guide-dog-voice', order: 30, label: function () { return 'Voice' } },
          function (props) {
            const sid = props.sessionId
            const effective = voiceEffective(sid)
            const state = React.useState({ phase: 0, seconds: 0, lang: micLang, error: null }) // mic: 0 idle / 1 recording / 2 transcribing
            const s = state[0]; const set = state[1]
            const [tick, setTick] = React.useState(0)
            React.useEffect(function () {
              // 卸载（切换会话/插件停止）时停止录音器与麦克风流，防隐私泄漏
              return function () {
                if (micRec) {
                  try { micRec.rec.stop() } catch (e) { /* ignore */ }
                  try { micRec.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ }
                  micRec = null
                }
              }
            }, [])
            React.useEffect(function () {
              if (!timerSvc || typeof timerSvc.interval !== 'function') return
              let tickCount = 0
              const stop = timerSvc.interval(function () {
                tickCount += 1
                setTick(tickCount)
                if (tickCount % 10 === 0) loadVoiceCfg() // 约每 10s 刷新配置（设置页改全局默认后同步）
              }, 1000)
              return function () { try { stop() } catch (e) { /* ignore */ } }
            }, [])
            React.useEffect(function () {
              // 语音模式生效时每秒轮询本会话队列；播放本身在模块级，不受会话切换影响
              if (!effective || !sid || pollBusy) return
              pollBusy = true
              host.call('guide-dog/voice-queue', { sessionId: sid }).then(function (r) {
                if (r && r.ok && r.entry) {
                  if (r.entry.url) playEntry(r.entry.url)
                  else if (r.entry.error) { showToast('朗读失败：' + (r.entry.message || r.entry.error)); playBeep() }
                }
              }).catch(function () {}).then(function () { pollBusy = false })
            }, [effective, sid, tick])
            const startRec = function () {
              try {
                navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
                  let rec = null
                  try { rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }) } catch (e) { rec = new MediaRecorder(stream) }
                  micChunks = []; micSeconds = 0
                  rec.ondataavailable = function (ev) {
                    if (ev.data && ev.data.size > 0) micChunks.push(ev.data)
                    micSeconds += 1
                    set(function (prev) { return Object.assign({}, prev, { seconds: micSeconds }) })
                    const max = (voiceState.cfg && voiceState.cfg.voiceInput && voiceState.cfg.voiceInput.maxSeconds) || 60
                    if (micSeconds >= max && rec.state === 'recording') { try { rec.stop() } catch (e) { /* ignore */ } }
                  }
                  rec.onstop = function () { transcribe(sid, props.inputActions, set) }
                  rec.start(1000)
                  micRec = { rec: rec, stream: stream }
                  set(function (prev) { return Object.assign({}, prev, { phase: 1, seconds: 0, error: null }) })
                }).catch(function (err) {
                  const name = err && err.name
                  set(function (prev) { return Object.assign({}, prev, { error: (name === 'NotFoundError' || name === 'OverconstrainedError') ? 'no_device' : 'mic_denied' }) })
                })
              } catch (e) { set(function (prev) { return Object.assign({}, prev, { error: 'mic_denied' }) }) }
            }
            const toggleMic = function () {
              if (s.phase === 1) {
                const r = micRec
                micRec = null
                if (r) { try { r.rec.stop() } catch (e) { /* ignore */ } try { r.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ } }
                return
              }
              if (s.phase === 2) return
              startRec()
            }
            const micErrText = {
              mic_denied: '麦克风权限被拒绝', no_device: '未检测到麦克风设备', empty_speech: '没听清，请再说一次',
              stt_failed: '转写失败', stt_timeout: '转写超时', engine_unavailable: 'STT 引擎不可用（见设置页）',
              insert_failed: '无法插入输入框',
            }[s.error] || (s.error ? '转写失败（' + s.error + '）' : null)
            const vm = (voiceState.cfg && voiceState.cfg.voiceMode) || {}
            const voiceTip = '语音模式提示：' + (effective ? '开' : '关') + ' · 全局默认：' + (vm.default ? '开' : '关') + '（点击切换）'
            const micTip = s.phase === 1 ? '停止录音' : (s.phase === 2 ? '转写中…' : '语音输入')
            return h('div', { className: 'gd-voice' },
              h('button', { className: 'gd-btn' + (effective ? ' gd-on' : ''), title: voiceTip, onClick: function () { setVoiceOverride(sid, !effective) } }, speakerIcon(effective)),
              h('select', { className: 'gd-select', value: s.lang, title: '识别语言检测', onChange: function (e) { micLang = e.target.value; set(function (prev) { return Object.assign({}, prev, { lang: e.target.value }) }) } },
                h('option', { value: 'auto' }, '自动'), h('option', { value: 'zh' }, '中文'), h('option', { value: 'en' }, '英文')),
              windowCannotRecord()
                ? h('a', { className: 'gd-btn', href: '/guide-dog/recorder', target: '_blank', title: '浏览器限制：录音需在独立页面进行' }, micIcon(false))
                : h('button', { className: 'gd-btn' + (s.phase === 1 ? ' gd-rec' : ''), title: micTip, onClick: toggleMic }, micIcon(s.phase === 1)),
              s.phase === 1 ? h('span', { className: 'gd-sec' }, s.seconds + 's') : null,
              micErrText ? h('span', { className: 'gd-err', title: micErrText }, micErrText) : null)
          })
      })
    })
    // ---- 右下角 toast（shell.overlay，root 级：切换会话也可见） ----
    ctx.effect(function () {
      return slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'guide-dog-toast', order: 99, label: function () { return 'Guide Dog toast' } },
          function () {
            const [tick, setTick] = React.useState(0)
            React.useEffect(function () {
              if (!timerSvc || typeof timerSvc.interval !== 'function') return
              const stop = timerSvc.interval(function () { setTick(Date.now() % 100000) }, 500)
              return function () { try { stop() } catch (e) { /* ignore */ } }
            }, [])
            const now = Date.now()
            const fresh = toastState.text && toastState.at && (now - toastState.at < 6000)
            if (!fresh) return null
            return h('div', { className: 'gd-toast', title: toastState.text },
              h('span', { className: 'gd-toast-dot' }),
              h('span', { className: 'gd-toast-text' }, toastState.text))
          })
      })
    })

    const cardStyle = { border: '1px solid rgba(128,128,128,.35)', borderRadius: 10, padding: 10, marginTop: 6, maxWidth: 640 }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const badgeStyle = { background: 'rgba(90,140,255,.15)', color: '#4a7dff', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }
    const mutedStyle = { color: '#888', fontSize: 12 }
    const errStyle = { color: '#c0392b', fontSize: 13 }
    const preStyle = { background: 'rgba(128,128,128,.08)', borderRadius: 6, padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 220, margin: '6px 0 0', whiteSpace: 'pre-wrap' }
    const linkStyle = { fontSize: 12, color: '#4a7dff', marginLeft: 8 }

    function parseArgs(block) {
      const raw = block.kind === 'tool-result' ? (block.call ? block.call.argsRaw : null) : block.argsRaw
      if (!raw) return {}
      try { return JSON.parse(raw) } catch (e) { return {} }
    }
    function parseResult(block) {
      if (!block.content) return null
      for (const b of block.content) {
        if (b && b.type === 'text' && b.text) {
          try { return JSON.parse(b.text) } catch (e) { return { ok: false, raw: b.text } }
        }
      }
      return null
    }
    function summarize(args) {
      for (const k of ['text', 'prompt', 'q', 'message', 'image', 'focus']) {
        if (args[k]) return String(args[k]).slice(0, 80)
      }
      const s = JSON.stringify(args)
      return s ? s.slice(0, 80) : ''
    }

    function MediaValue(toolName, value) {
      const variant = VARIANTS[toolName] || 'text'
      if (variant === 'image') {
        const urls = (value.urls && value.urls.length) ? value.urls : (value.url ? [value.url] : [])
        if (!urls.length) return h('div', { style: mutedStyle }, 'no media url')
        return h('div', null, urls.map(function (u, i) {
          return h('a', { key: i, href: u, target: '_blank', rel: 'noreferrer', style: { display: 'block', marginBottom: 6 } },
            h('img', { src: u, style: { maxWidth: '100%', maxHeight: 420, borderRadius: 8, border: '1px solid rgba(128,128,128,.35)', display: 'block' } }))
        }))
      }
      if (variant === 'audio') {
        if (!value.url) return h('div', { style: mutedStyle }, 'no media url')
        return h('div', { style: { marginTop: 6 } },
          h('audio', { src: value.url, controls: true, style: { width: '100%' } }),
          h('a', { href: value.url, target: '_blank', rel: 'noreferrer', style: linkStyle }, 'open file'))
      }
      if (variant === 'video') {
        if (!value.url) return h('div', { style: mutedStyle }, 'no media url')
        return h('div', { style: { marginTop: 6 } },
          h('video', { src: value.url, controls: true, preload: 'metadata', style: { maxWidth: '100%', maxHeight: 420, borderRadius: 8 } }))
      }
      if (variant === 'list') {
        const items = value.voices || value.results || []
        if (toolName === 'guide_dog_voices') {
          return h('div', { style: { marginTop: 4 } }, items.map(function (v, i) {
            return h('div', { key: i, style: { fontSize: 12, marginBottom: 2 } }, String(v.voice_id || '') + (v.voice_name ? ' — ' + v.voice_name : ''))
          }))
        }
        return h('div', { style: { marginTop: 4 } }, items.map(function (r, i) {
          return h('div', { key: i, style: { marginBottom: 4 } },
            h('a', { href: r.url, target: '_blank', rel: 'noreferrer', style: { color: '#4a7dff', fontSize: 13 } }, r.title || r.url),
            r.snippet ? h('div', { style: { fontSize: 12, color: '#666' } }, String(r.snippet)) : null)
        }))
      }
      const body = value.answer || value.text || value.raw || ''
      return h('pre', { style: preStyle }, String(body))
    }

    function ToolCard(props) {
      const block = props.block
      const toolName = props.toolName
      const args = parseArgs(block)
      const running = block.kind !== 'tool-result'
      if (running) {
        return h('div', { style: rowStyle },
          h('span', { style: badgeStyle }, 'Guide Dog'),
          h('span', { style: { fontSize: 13 } }, toolName + ' — ' + summarize(args)))
      }
      const value = parseResult(block)
      if (block.isError || (value && value.ok === false)) {
        const msg = (block.isError && block.error && block.error.name) ? block.error.name : ((value && value.error) || 'error')
        return h('div', { style: cardStyle },
          h('div', { style: rowStyle }, h('span', { style: badgeStyle }, 'Guide Dog'), h('span', { style: errStyle }, String(msg))))
      }
      if (!value) {
        return h('div', { style: cardStyle },
          h('div', { style: rowStyle }, h('span', { style: badgeStyle }, 'Guide Dog'), h('span', { style: mutedStyle }, toolName + ' — no result')))
      }
      return h('div', { style: cardStyle },
        h('div', { style: rowStyle }, h('span', { style: badgeStyle }, 'Guide Dog'), h('span', { style: { fontSize: 13, fontWeight: 600 } }, toolName)),
        MediaValue(toolName, value),
        h('details', { style: { marginTop: 6 } },
          h('summary', { style: mutedStyle }, 'Result JSON'),
          h('pre', { style: preStyle }, JSON.stringify(value, null, 2))))
    }

    ctx.effect(function () {
      return slots.inject('tool.call.toolview', function () {
        const ds = TOOL_KEYS.map(function (key) {
          return slots.register({ name: 'tool.call.toolview', key: key }, function (props) {
            return h(ToolCard, Object.assign({}, props, { toolName: key }))
          })
        })
        return function () { ds.forEach(function (d) { try { d() } catch (e) { /* ignore */ } }) }
      })
    })

    function AuthCard(auth) {
      if (!auth) return h('div', { style: mutedStyle }, 'Checking mmx auth…')
      if (!auth.ok) return h('div', { style: { border: '1px solid rgba(200,60,50,.4)', borderRadius: 10, padding: 12 } }, 'mmx auth problem: ' + String(auth.error || 'unknown'))
      return h('div', { style: { border: '1px solid rgba(128,128,128,.3)', borderRadius: 10, padding: 12 } },
        'mmx auth: ' + String(auth.method || '?') + ' (' + String(auth.source || '?') + ') — key ' + String(auth.keyMasked || 'set'))
    }

    function SettingsPage(props) {
      const state = React.useState({ auth: null, voices: [], media: [], text: '', voice: 'auto', busy: false, playUrl: null, error: null, cfg: null, status: null })
      const s = state[0]
      const set = state[1]
      React.useEffect(function () {
        let alive = true
        // 函数式 updater：5 个异步结果各自合并，避免基于初始闭包 s 的 last-wins 全量覆盖
        host.call('guide-dog/auth-status', {}).then(function (r) { if (alive) set(function (prev) { return Object.assign({}, prev, { auth: r }) }) }).catch(function () {})
        host.call('guide-dog/voices', {}).then(function (r) { if (alive && r && r.ok && Array.isArray(r.voices)) set(function (prev) { return Object.assign({}, prev, { voices: r.voices }) }) }).catch(function () {})
        host.call('guide-dog/list-media', { limit: 30 }).then(function (r) { if (alive && Array.isArray(r)) set(function (prev) { return Object.assign({}, prev, { media: r }) }) }).catch(function () {})
        host.call('guide-dog/get-config', {}).then(function (r) { if (alive && r && r.ok) set(function (prev) { return Object.assign({}, prev, { cfg: r.config }) }) }).catch(function () {})
        host.call('guide-dog/status', {}).then(function (r) { if (alive && r && r.ok) set(function (prev) { return Object.assign({}, prev, { status: r.status }) }) }).catch(function () {})
        return function () { alive = false }
      }, [])
      const speak = function () {
        if (!s.text.trim() || s.busy) return
        // M8：函数式 updater，避免陈旧闭包覆盖异步加载结果
        set(function (prev) { return Object.assign({}, prev, { busy: true, error: null, playUrl: null }) })
        host.call('guide-dog/speak', { text: s.text, voice: s.voice, speed: 0.95 })
          .then(function (r) {
            if (r && r.ok) set(function (prev) { return Object.assign({}, prev, { busy: false, playUrl: r.url }) })
            else set(function (prev) { return Object.assign({}, prev, { busy: false, error: (r && r.error) || 'speak failed' }) })
          })
          .catch(function (e) { set(function (prev) { return Object.assign({}, prev, { busy: false, error: String(e) }) }) })
      }
      const voiceOptions = [h('option', { key: 'auto', value: 'auto' }, 'auto (per-language)')].concat(s.voices.map(function (v, i) {
        return h('option', { key: i, value: v.voice_id }, String(v.voice_name || v.voice_id) + ' (' + v.voice_id + ')')
      }))
      const reloadCfg = function () {
        host.call('guide-dog/get-config', {}).then(function (r) { if (r && r.ok) set(function (prev) { return Object.assign({}, prev, { cfg: r.config }) }) }).catch(function () {})
      }
      const setCfg = function (patch) {
        host.call('guide-dog/set-config', { patch: patch }).then(function (r) { if (r && r.ok) reloadCfg() }).catch(function () {})
      }
      const cfgBlock = s.cfg ? h('div', { style: preStyle }, [
        h('div', { style: rowStyle },
          h('span', { style: badgeStyle }, '语音模式'),
          h('label', null, h('input', { type: 'radio', name: 'vm-global', checked: !!s.cfg.voiceMode.default, onChange: function () { setCfg({ voiceMode: { default: true } }) } }), ' 全局默认开'),
          h('label', null, h('input', { type: 'radio', name: 'vm-global', checked: !s.cfg.voiceMode.default, onChange: function () { setCfg({ voiceMode: { default: false } }) } }), ' 全局默认关')),
        h('div', { style: mutedStyle }, '会话 override：输入框左下角小喇叭按钮点击切换（当前会话生效值以小喇叭为准）。'),
        h('div', { style: rowStyle },
          h('span', { style: badgeStyle }, '语音输入'),
          h('label', null, '引擎：', h('select', { value: s.cfg.voiceInput.engine, onChange: function (e) { setCfg({ voiceInput: { engine: e.target.value } }) } },
            h('option', { value: 'whisper' }, 'whisper（本地）'), h('option', { value: 'sherpa' }, 'sherpa（增强，待装）'), h('option', { value: 'minimax' }, 'minimax（保留位）'))),
          h('label', null, ' 语言：', h('select', { value: s.cfg.voiceInput.language, onChange: function (e) { setCfg({ voiceInput: { language: e.target.value } }) } },
            h('option', { value: 'auto' }, '自动'), h('option', { value: 'zh' }, '中文'), h('option', { value: 'en' }, '英文'))),
          h('label', null, h('input', { type: 'checkbox', checked: !!s.cfg.voiceInput.autoSend, onChange: function (e) { setCfg({ voiceInput: { autoSend: e.target.checked } }) } }), ' 识别后自动发送')),
        h('div', { style: rowStyle },
          h('span', { style: badgeStyle }, 'STT'),
          s.status ? h('span', { style: mutedStyle }, 'faster-whisper: ' + (s.status.whisperAvailable ? '可用 ' + ((s.status.whisperVersion || '') + ' / ' + (s.status.whisperPython || '')) : '不可用 — 需 pip install faster-whisper')) : null,
          h('label', null, ' 模型：', h('select', { value: s.cfg.voiceInput.whisper.model, onChange: function (e) { setCfg({ voiceInput: { whisper: { model: e.target.value } } }) } },
            h('option', { value: 'base' }, 'base（快）'), h('option', { value: 'small' }, 'small（准）')))),
      ]) : null
      const mediaCells = s.media.map(function (m, i) {
        if (m.kind === 'image') {
          return h('a', { key: i, href: m.url, target: '_blank', rel: 'noreferrer', title: m.name },
            h('img', { src: m.url, style: { width: 96, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)' } }))
        }
        if (m.kind === 'video') {
          return h('video', { key: i, src: m.url, muted: true, preload: 'metadata', style: { width: 96, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)' } })
        }
        if (m.kind === 'audio') {
          return h('audio', { key: i, src: m.url, controls: true, preload: 'none', style: { width: 150 } })
        }
        return h('a', { key: i, href: m.url, target: '_blank', rel: 'noreferrer', style: { fontSize: 12 } }, m.name)
      })
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '0 4px', maxWidth: 720 } },
        h('h2', null, 'Guide Dog for DSH — MiniMax multimodal'),
        cfgBlock,
        AuthCard(s.auth),
        h('div', { style: { border: '1px solid rgba(128,128,128,.3)', borderRadius: 10, padding: 12 } },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Speak tester'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', { value: s.text, onChange: function (e) { set(Object.assign({}, s, { text: e.target.value })) }, placeholder: 'Text to speak…', style: { flex: 1, minWidth: 220 } }),
            h('select', { value: s.voice, onChange: function (e) { set(Object.assign({}, s, { voice: e.target.value })) } }, voiceOptions),
            h('button', { onClick: speak, disabled: s.busy }, s.busy ? 'Generating…' : 'Speak & play')),
          s.error ? h('div', { style: { color: '#c0392b', fontSize: 12, marginTop: 8 } }, String(s.error)) : null,
          s.playUrl ? h('audio', { src: s.playUrl, controls: true, autoPlay: true, style: { width: '100%', marginTop: 8 } }) : null),
        h('div', { style: { border: '1px solid rgba(128,128,128,.3)', borderRadius: 10, padding: 12 } },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Recent media (' + s.media.length + ')'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, mediaCells)))
    }

    ctx.effect(function () {
      return slots.inject('settings.section', function () {
        return slots.register({ name: 'settings.section', id: 'guide-dog', order: 30, label: function () { return 'Guide Dog' } }, function (props) {
          return h(SettingsPage, props)
        })
      })
    })
  },
}
