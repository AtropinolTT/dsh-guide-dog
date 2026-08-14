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
    function probeKeys(o) { try { return o ? Object.keys(o).slice(0, 40) : [] } catch (e) { return [] } }
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
    async function saveConfig(patch) {
      const root = await guideDogRoot()
      const next = deepMerge(configCache, patch || {})
      const dir = root + '/.guide-dog'
      try {
        await runRaw('mkdir -p ' + quote(dir), { timeoutMs: 10000 })
        // 原子写：tmp → mv → chmod 600；写前保留 .bak 供解析失败回退
        const okTmp = await writeTextFile(dir + '/config.json.tmp', JSON.stringify(next, null, 2))
        if (!okTmp) return { ok: false, error: 'config_write_failed' }
        await runRaw('cp -f ' + quote(dir + '/config.json') + ' ' + quote(dir + '/config.json.bak') + ' 2>/dev/null; mv -f ' + quote(dir + '/config.json.tmp') + ' ' + quote(dir + '/config.json') + '; ' + 'chmod 600 ' + quote(dir + '/config.json'), { timeoutMs: 10000 })
        configCache = next
        return { ok: true }
      } catch (e) {
        console.error('[guide-dog] config write failed', e)
        return { ok: false, error: 'config_write_failed' }
      }
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
      const res = await runRaw(py + " -c 'import faster_whisper; print(faster_whisper.__version__)'", { timeoutMs: 15000 })
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
      if (!wrote) return { ok: false, error: 'config_write_failed', message: 'cannot write temp audio' }
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
      if (sid && seq !== null) {
        const spoken = spokenTurns.get(sid) || new Set()
        if (spoken.has(seq)) return { ok: true, skipped: true }
        spoken.add(seq)
        spokenTurns.set(sid, spoken)
      }
      const text = String(args.text || '').trim()
      if (!text) return { ok: false, error: 'bad_args', message: 'text is required' }
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
        const msg = String(tts.error || '')
        return { ok: false, error: /timeout/i.test(msg) ? 'tts_timeout' : 'tts_failed', message: msg.slice(0, 300) }
      }
      const st = await statFile(abs)
      if (!st) return { ok: false, error: 'tts_failed', message: 'TTS finished but the mp3 is missing' }
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
      systemPrompt.variable('guide_dog_voice_mode', function (context) {
        const cfg = loadConfig()
        const sid = (context && (context.sessionId || (context.session && context.session.id))) || ''
        const vm = cfg.voiceMode || {}
        const effective = sid ? (vm.sessions[sid] !== undefined ? vm.sessions[sid] : vm.default) : vm.default
        if (!effective) return undefined
        return '语音模式：开。本条回复会被自动朗读。保持回复文字与朗读内容一致，不要在回复中描述音频状态，不要重复播报。'
      })
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
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/probe', async function (args) {
          try {
            const root = await guideDogRoot()
            let cur = {}
            const raw = await readTextFile(root + '/.guide-dog/probe.json')
            if (raw) { try { cur = JSON.parse(raw) } catch (e) { /* ignore */ } }
            await runRaw('mkdir -p ' + quote(root + '/.guide-dog'), { timeoutMs: 10000 })
            const next = Object.assign({}, cur, (args && args.report) || {})
            // pkg-4: host-side session log shape probe (client probe reports sessionId)
            const sid = (args && args.report && args.report.sessionId) ? String(args.report.sessionId) : ''
            if (sid && !cur.sessionEvents) {
              const sq = ctx.get('sessionQuery')
              if (!sq || typeof sq.readSession !== 'function') {
                next.sessionEvents = { error: 'no sessionQuery' }
              } else {
                try {
                  const snap = await sq.readSession(sid)
                  const events = (snap && Array.isArray(snap.events)) ? snap.events : []
                  const sample = events.slice(-3).map(function (e) {
                    return {
                      keys: probeKeys(e),
                      type: (typeof e.type === 'string') ? e.type : (typeof e.kind === 'string' ? e.kind : String(typeof e.type)),
                      hasMessage: !!e.message,
                      messageKeys: probeKeys(e.message),
                      hasContent: !!e.content,
                      contentKeys: Array.isArray(e.content) ? probeKeys(e.content[0] || {}) : probeKeys(e.content),
                      textSample: (function () {
                        if (e.message && typeof e.message.content === 'string') return e.message.content.slice(0, 80)
                        if (e.message && Array.isArray(e.message.content) && e.message.content[0] && typeof e.message.content[0].text === 'string') return e.message.content[0].text.slice(0, 80)
                        if (typeof e.content === 'string') return e.content.slice(0, 80)
                        return ''
                      })(),
                    }
                  })
                  next.sessionEvents = { snapshotKeys: probeKeys(snap), eventCount: events.length, sample: sample }
                } catch (e) { next.sessionEvents = { error: String(e).slice(0, 200) } }
              }
            }
            await writeTextFile(root + '/.guide-dog/probe.json', JSON.stringify(next, null, 2))
            return { ok: true }
          } catch (e) { return { ok: false, error: 'config_write_failed', message: String(e).slice(0, 200) } }
        })
      } catch (e) { return function () {} }
    })
    // pkg-4: live session/event scalar dump (once) — registers directly via ctx.effect
    let liveEventDumped = false
    ctx.effect(function () {
      return ctx.on('session/event', async function (session, event) {
        if (liveEventDumped) return
        try {
          liveEventDumped = true
          const root = await guideDogRoot()
          if (!root) return
          const ev = event || {}
          const content = Array.isArray(ev.content) ? ev.content : []
          const b0 = content[0] || {}
          const dump = {
            eventKeys: probeKeys(ev),
            eventType: (typeof ev.type === 'string') ? ev.type : String(typeof ev.type),
            eventKind: (typeof ev.kind === 'string') ? ev.kind : undefined,
            hasMessage: !!ev.message,
            messageKeys: probeKeys(ev.message),
            hasText: typeof ev.text === 'string',
            contentKeys: probeKeys(b0),
            b0Type: b0.type,
            textSample: String(b0.text !== undefined ? b0.text : (b0.content !== undefined ? b0.content : '')).slice(0, 80),
            sessionIdSample: (typeof session === 'string' ? session : (session && session.id)) || null,
          }
          readTextFile(root + '/.guide-dog/probe2.json').then(function (raw) {
            let cur = {}
            if (raw) { try { cur = JSON.parse(raw) } catch (e) { /* ignore */ } }
            cur.liveEvent = dump
            return writeTextFile(root + '/.guide-dog/probe2.json', JSON.stringify(cur, null, 2))
          }).catch(function () {})
        } catch (e) { /* best effort */ }
      })
    })
    // variable context 形状探测：下次提示词组装时把 context 键列表并入 probe.json（审查 M7）
    if (systemPrompt && systemPrompt.variable) {
      systemPrompt.variable('guide_dog_probe_context', function (context) {
        const root = guideRoot || ''
        if (root) {
          try {
            readTextFile(root + '/.guide-dog/probe.json').then(function (raw) {
              let cur = {}
              if (raw) { try { cur = JSON.parse(raw) } catch (e) { /* ignore */ } }
              cur.variableContextKeys = probeKeys(context)
              return writeTextFile(root + '/.guide-dog/probe.json', JSON.stringify(cur, null, 2))
            }).catch(function () {})
          } catch (e) { /* ignore */ }
        }
        return undefined
      })
    }

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

    // pkg-4: eager session-log shape probe (best effort; client-triggered probe covers it if this fails)
    ;(async function () {
      try {
        const ssvc = ctx.get('sessions')
        const list = ssvc && typeof ssvc.list === 'function' ? await ssvc.list() : []
        if (list && list.length) {
          const sid = list[0].id || String(list[0])
          const sq = ctx.get('sessionQuery')
          if (sq && typeof sq.readSession === 'function') {
            const snap = await sq.readSession(sid)
            const events = (snap && Array.isArray(snap.events)) ? snap.events : []
            const sample = events.slice(-3).map(function (e) {
              return {
                keys: probeKeys(e),
                type: (typeof e.type === 'string') ? e.type : String(typeof e.type),
                hasMessage: !!e.message,
                messageKeys: probeKeys(e.message),
                contentKeys: Array.isArray(e.content) ? probeKeys(e.content[0] || {}) : probeKeys(e.content),
                textSample: (e.message && typeof e.message.content === 'string') ? e.message.content.slice(0, 80) : '',
              }
            })
            const root = await guideDogRoot()
            await runRaw('mkdir -p ' + quote(root + '/.guide-dog'), { timeoutMs: 10000 })
            const cur = {}
            const raw = await readTextFile(root + '/.guide-dog/probe2.json')
            if (raw) { try { cur.sessionEvents = JSON.parse(raw).sessionEvents } catch (e) { /* ignore */ } }
            if (!cur.sessionEvents) cur.sessionEvents = { snapshotKeys: probeKeys(snap), eventCount: events.length, sample: sample }
            await writeTextFile(root + '/.guide-dog/probe2.json', JSON.stringify(cur, null, 2))
          }
        }
      } catch (e) { /* best effort */ }
    })()
  },
}

// ==== CLIENT HALF ====
return {
  async apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return

    // ============ PROBE 节（Task 4，pkg-5 专用；Task 5/6 实现后删除） ============
    function probeKeys(o) { try { return o ? Object.keys(o).slice(0, 40) : [] } catch (e) { return [] } }
    function reportGlobals() {
      // 内联 typeof：对未声明标识符恒安全（审查 I5：不得先求值实参）
      return {
        window: typeof window, navigator: typeof navigator,
        mediaDevices: typeof navigator !== 'undefined' && typeof navigator.mediaDevices,
        MediaRecorder: typeof MediaRecorder, AudioContext: typeof AudioContext,
        WebSocket: typeof WebSocket, fetch: typeof fetch, document: typeof document,
        Blob: typeof Blob,
        BlobArrayBuffer: (typeof Blob === 'function') ? typeof Blob.prototype.arrayBuffer : 'n/a',
        btoa: typeof btoa, URL: typeof URL, setInterval: typeof setInterval, clearInterval: typeof clearInterval,
        Date: typeof Date, JSON: typeof JSON, Promise: typeof Promise, Object: typeof Object, String: typeof String,
      }
    }
    function probeTimer() {
      var t = null
      try { t = ctx.get('timer') } catch (e) { t = null }
      var timeoutType = 'n/a'
      var intervalType = 'n/a'
      if (t) {
        try { timeoutType = typeof t.timeout } catch (e) { timeoutType = 'n/a' }
        try { intervalType = typeof t.interval } catch (e) { intervalType = 'n/a' }
      }
      return { exists: !!t, keys: probeKeys(t), timeoutType: timeoutType, intervalType: intervalType }
    }
    function scalarText(v) {
      if (v === undefined || v === null) return ''
      if (typeof v === 'string') return v.slice(0, 80)
      if (typeof v === 'object') {
        try {
          if (typeof v.text === 'string') return v.text.slice(0, 80)
          if (typeof v.content === 'string') return v.content.slice(0, 80)
        } catch (e) { /* ignore */ }
      }
      return ''
    }
    // (a) 常驻探测：input.right 挂载即上报 globals/inputActions/timer（空会话可用）
    ctx.effect(function () {
      return slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'guide-dog-probe', order: 99, label: function () { return 'probe' } },
          function (props) {
            React.useEffect(function () {
              let inputState = null
              try { inputState = props.useInput() } catch (e) { inputState = null }
              host.call('guide-dog/probe', {
                report: {
                  sessionId: props.sessionId,
                  globals: reportGlobals(),
                  inputActions: { keys: probeKeys(props.inputActions) },
                  inputStateKeys: { keys: probeKeys(inputState) },
                  timerSvc: probeTimer(),
                },
              }).catch(function () {})
            }, [])
            return null
          })
      })
    })
    // (b) 形状探测：turnTail 挂载即上报 turn/快照形状（需会话已有 turn）
    ctx.effect(function () {
      return slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          { name: 'conversation.chat.turnTail', select: function (owner) {
              if (!owner || !owner.turn) return null
              const turn = owner.turn
              const steps = Array.isArray(turn.steps) ? turn.steps : []
              const s0 = steps[0] || {}
              return {
                turnKeys: probeKeys(turn), seq: owner.seq,
                turnStepsIsArray: Array.isArray(turn.steps),
                steps0Keys: probeKeys(s0),
                steps0HasMessage: s0.message !== undefined,
                steps0HasContent: s0.content !== undefined,
                steps0HasText: s0.text !== undefined,
                textSample: scalarText(s0.message) || scalarText(turn.data) || '',
              }
            } },
          function (props) {
            // 渲染期调用 useSession()（审查：useEffect 内调用导致 snapshotKeys 为空）
            let snap = null
            try { snap = props.useSession() } catch (e) { snap = null }
            React.useEffect(function () {
              const m = props.matched || {}
              const list = snap ? (snap.messages || snap.turns || snap.nodes || []) : []
              const first = list[0] || {}
              const firstMsgKeys = probeKeys(first)
              let contentKeys = []
              let snapshotText = ''
              if (Array.isArray(first.content)) {
                const b0 = first.content[0] || {}
                contentKeys = probeKeys(b0)
                snapshotText = String(b0.text !== undefined ? b0.text : (b0.content !== undefined ? b0.content : '')).slice(0, 80)
              }
              host.call('guide-dog/probe', {
                report: {
                  turnTail: {
                    turnKeys: m.turnKeys || [],
                    seq: m.seq !== undefined ? m.seq : null,
                    snapshotKeys: probeKeys(snap), messagesKeys: probeKeys(list),
                    firstMessageKeys: firstMsgKeys, contentKeys: contentKeys,
                    textSample: m.textSample || snapshotText,
                    turnStepsIsArray: m.turnStepsIsArray === true,
                    steps0Keys: m.steps0Keys || [],
                    steps0HasMessage: m.steps0HasMessage === true,
                    steps0HasContent: m.steps0HasContent === true,
                    steps0HasText: m.steps0HasText === true,
                  },
                },
              }).catch(function () {})
            }, [])
            return null
          })
      })
    })

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
      const state = React.useState({ auth: null, voices: [], media: [], text: '', voice: 'auto', busy: false, playUrl: null, error: null })
      const s = state[0]
      const set = state[1]
      React.useEffect(function () {
        let alive = true
        host.call('guide-dog/auth-status', {}).then(function (r) { if (alive) set(Object.assign({}, s, { auth: r })) }).catch(function () {})
        host.call('guide-dog/voices', {}).then(function (r) { if (alive && r && r.ok && Array.isArray(r.voices)) set(Object.assign({}, s, { voices: r.voices })) }).catch(function () {})
        host.call('guide-dog/list-media', { limit: 30 }).then(function (r) { if (alive && Array.isArray(r)) set(Object.assign({}, s, { media: r })) }).catch(function () {})
        return function () { alive = false }
      }, [])
      const speak = function () {
        if (!s.text.trim() || s.busy) return
        set(Object.assign({}, s, { busy: true, error: null, playUrl: null }))
        host.call('guide-dog/speak', { text: s.text, voice: s.voice, speed: 0.95 })
          .then(function (r) {
            if (r && r.ok) set(Object.assign({}, s, { busy: false, playUrl: r.url }))
            else set(Object.assign({}, s, { busy: false, error: (r && r.error) || 'speak failed' }))
          })
          .catch(function (e) { set(Object.assign({}, s, { busy: false, error: String(e) })) })
      }
      const voiceOptions = [h('option', { key: 'auto', value: 'auto' }, 'auto (per-language)')].concat(s.voices.map(function (v, i) {
        return h('option', { key: i, value: v.voice_id }, String(v.voice_name || v.voice_id) + ' (' + v.voice_id + ')')
      }))
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
