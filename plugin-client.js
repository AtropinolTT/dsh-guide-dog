return {
  inject: ['slots'],
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
        if (r && r.ok && r.config) {
          voiceState.cfg = r.config
          micDeviceId = (r.config.voiceInput && r.config.voiceInput.deviceId) || ''
        }
      }).catch(function () {})
    }
    function setVoiceOverride(sid, value) {
      const patch = { voiceMode: { sessions: {} } }
      patch.voiceMode.sessions[sid] = value // M11：单键 patch，不重建整表（host deepMerge 合并）
      return host.call('guide-dog/set-config', { patch: patch }).then(function (r) {
        if (r && r.ok) loadVoiceCfg()
        return r
      }).catch(function () { return null })
    }
    // ---- 模块级播放器：会话切换不中断；新播放任务覆盖旧任务 ----
    let curAudio = null
    // ---- M9：录音归属会话（修复：卸载后 onstop 校验归属，丢弃陈旧提交） ----
    let recSessionRef = null // { sid, alive }：录音归属；卸载置 alive=false → onstop 丢弃
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
    // 录音开始提示音（用户需求 2026-08-15，v2 修订）：改用 <audio> data-URI 播放（与 TTS 播放同机制，
    // 用户环境已验证可出声；WebAudio 振荡器在 RDP/Chrome 环境下不响）。1200Hz 0.3s 与失败 beep(880Hz) 区分。
    let startToneUri = null
    function makeStartToneUri() {
      try {
        const rate = 8000, ms = 300, freq = 1200
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
          // 双音：1200Hz 主音 + 开头 50ms 800Hz 预告音，更易察觉
          const f = t < 0.05 ? 800 : 1200
          bytes[44 + i] = Math.max(0, Math.min(255, Math.round(128 + 90 * env * Math.sin(2 * Math.PI * f * t))))
        }
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        startToneUri = 'data:audio/wav;base64,' + btoa(bin)
      } catch (e) { startToneUri = null }
    }
    makeStartToneUri()
    function playStartTone() {
      if (!startToneUri || typeof Audio !== 'function') return
      try {
        const a = new Audio(startToneUri)
        a.volume = 0.5
        const p = a.play()
        if (p && typeof p.catch === 'function') p.catch(function () { /* ignore */ })
      } catch (e) { /* ignore */ }
    }
    let pollBusy = false
    // ---- 麦克风（模块级状态；组件只持有 phase/seconds/lang/error） ----
    let micRec = null // {rec, stream, analyser}
    let micChunks = []
    let micSeconds = 0
    let micLang = 'auto'
    let micDeviceId = '' // 用户选择的输入设备（设置页下拉）
    let micMime = 'audio/webm' // 实际 MediaRecorder mime（wav 优先：增量切片可解码）
    let partialAcc = '' // 累积预览文本（wav 增量模式：每次只含新音频文本，需累积显示）
    // 实时预览（partial）转写状态（2026-08-15 用户需求：边说边显示识别结果于输入框）
    let partialBusy = false // 一次只跑一个 partial 转写（防止并发堆积）
    let partialIdx = 0      // micChunks 中已送入 partial 的索引（增量，避免每次都转写全量）
    let partialStale = false // 录音已停止：在途 partial 结果丢弃，防覆盖最终转写
    let partialTimer = null
    // 2026-08-15 根因修复：webm 增量切片（无 EBML/Track 头）无法解码（实测 Invalid data）→
    // 录音改用 audio/wav（PCM 可从任意偏移切片 + 自建 44B 头即可解码），partial 走增量 WAV。
    // host 侧同步：常驻 --serve worker（模型只加载一次，单次 ~0.8s），5s→3s 间隔。
    function u32le(u, o) { return (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0 }
    function u32be(u, o) { return ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0 }
    function u16le(u, o) { return u[o] | (u[o + 1] << 8) }
    function findWavDataOff(buf) {
      const u = new Uint8Array(buf)
      let off = 12
      while (off + 8 <= u.length) {
        if (u32be(u, off) === 0x64617461) return off + 8 // 'data'
        const size = u32le(u, off + 4)
        off += 8 + size + (size % 2)
      }
      return -1
    }
    function parseWavInfo(buf) {
      const u = new Uint8Array(buf)
      let off = 12
      while (off + 24 <= u.length) {
        const id = u32be(u, off)
        const size = u32le(u, off + 4)
        if (id === 0x666d7420) { // 'fmt '
          const channels = u16le(u, off + 10)
          const sampleRate = u32le(u, off + 12)
          const bits = u16le(u, off + 22)
          if (channels > 0 && sampleRate > 0 && bits > 0) return { channels: channels, sampleRate: sampleRate, bits: bits }
          return null
        }
        off += 8 + size + (size % 2)
      }
      return null
    }
    // 增量 WAV 拼接：提取新 chunks 的 PCM（跳过各自头），自建标准 44B 头 → 可解码增量音频
    function buildWavBlob(parts) {
      const bufs = []
      let chain = Promise.resolve()
      parts.forEach(function (blob) {
        chain = chain.then(function () { return blob.arrayBuffer() }).then(function (b) { bufs.push(b) })
      })
      return chain.then(function () {
        let info = null
        const pcmParts = []
        for (let i = 0; i < bufs.length; i++) {
          const u = new Uint8Array(bufs[i])
          const isRiff = u.length >= 12 && u32be(u, 0) === 0x52494646 && u32be(u, 8) === 0x57415645
          if (isRiff && !info) info = parseWavInfo(bufs[i])
          const dataOff = isRiff ? findWavDataOff(bufs[i]) : -1
          if (dataOff >= 0) pcmParts.push(u.subarray(dataOff))
          else pcmParts.push(u)
        }
        if (!info) return null
        let pcmLen = 0
        pcmParts.forEach(function (p) { pcmLen += p.length })
        const out = new Uint8Array(44 + pcmLen)
        out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46 // RIFF
        out[4] = (36 + pcmLen) & 0xFF; out[5] = ((36 + pcmLen) >> 8) & 0xFF; out[6] = ((36 + pcmLen) >> 16) & 0xFF; out[7] = ((36 + pcmLen) >> 24) & 0xFF
        out[8] = 0x57; out[9] = 0x41; out[10] = 0x56; out[11] = 0x45 // WAVE
        out[12] = 0x66; out[13] = 0x6D; out[14] = 0x74; out[15] = 0x20 // 'fmt '
        out[16] = 16; out[17] = 0; out[18] = 0; out[19] = 0 // fmt size = 16
        out[20] = 1; out[21] = 0 // PCM
        out[22] = info.channels & 0xFF; out[23] = (info.channels >> 8) & 0xFF
        out[24] = info.sampleRate & 0xFF; out[25] = (info.sampleRate >> 8) & 0xFF; out[26] = (info.sampleRate >> 16) & 0xFF; out[27] = (info.sampleRate >> 24) & 0xFF
        const byteRate = info.sampleRate * info.channels * (info.bits / 8)
        out[28] = byteRate & 0xFF; out[29] = (byteRate >> 8) & 0xFF; out[30] = (byteRate >> 16) & 0xFF; out[31] = (byteRate >> 24) & 0xFF
        const blockAlign = info.channels * (info.bits / 8)
        out[32] = blockAlign & 0xFF; out[33] = (blockAlign >> 8) & 0xFF
        out[34] = info.bits & 0xFF; out[35] = (info.bits >> 8) & 0xFF
        out[36] = 0x64; out[37] = 0x61; out[38] = 0x74; out[39] = 0x61 // 'data'
        out[40] = pcmLen & 0xFF; out[41] = (pcmLen >> 8) & 0xFF; out[42] = (pcmLen >> 16) & 0xFF; out[43] = (pcmLen >> 24) & 0xFF
        let off = 44
        pcmParts.forEach(function (p) { out.set(p, off); off += p.length })
        return new Blob([out], { type: 'audio/wav' })
      })
    }
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
    // 安全审查（2026-08-15）：外部工具结果 URL 仅允许 http/https/mailto/#/相对路径；其余视为不安全
    function safeHref(u) {
      return typeof u === 'string' && /^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(u) ? u : '#'
    }
    function safeMedia(u) {
      return typeof u === 'string' && /^(https?:\/\/|\/|\.\/|\.\.\/)/i.test(u) ? u : null
    }
    // 安全审查（2026-08-15）：工具结果 JSON 展示前脱敏（key/token/secret/auth 等字段打码）
    function maskSensitive(v) {
      if (Array.isArray(v)) return v.map(maskSensitive)
      if (v && typeof v === 'object') {
        const out = {}
        for (const k of Object.keys(v)) {
          const val = v[k]
          out[k] = /(key|token|secret|auth|password|apikey|api_key)/i.test(k) && typeof val === 'string' ? '***' : maskSensitive(val)
        }
        return out
      }
      return v
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
      const secs = micSeconds
      if (!parts.length) {
        // 诊断（2026-08-15）：区分"未收到音频数据"（client 录音未工作）与"转写无内容"（whisper 空）
        set(function (prev) { return Object.assign({}, prev, { phase: 0, error: 'empty_speech', diag: 'no-data:' + secs + 's' }) })
        console.log('[guide-dog] mic empty: chunks=0 seconds=' + secs)
        return
      }
      try {
        const blob = new Blob(parts, { type: micMime })
        blob.arrayBuffer().then(function (buf) {
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          set(function (prev) { return Object.assign({}, prev, { phase: 2, error: null }) })
          return host.call('guide-dog/transcribe', { audioB64: btoa(bin), mime: micMime, sessionId: sid, language: micLang })
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
                if (recSessionRef) recSessionRef.alive = false // M9：标记录音已死 → 迟到的 onstop 丢弃
                if (partialTimer) { try { partialTimer() } catch (e) { /* ignore */ } partialTimer = null }
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
                // 输入设备选择（设置页下拉，存 voiceInput.deviceId）；空 = 系统默认
                const audioReq = micDeviceId ? { audio: { deviceId: { exact: micDeviceId } } } : { audio: true }
                navigator.mediaDevices.getUserMedia(audioReq).then(function (stream) {
                  // 音量检测：MediaRecorder 之外并行接 AnalyserNode（2026-08-15 诊断：浏览器录 RDP 虚拟麦克风静音）
                  let analyser = null
                  let volTimer = null
                  try {
                    // AC 获取修复（2026-08-15）：沙箱里 AudioContext 以全局暴露，window.AudioContext 可能为
                    // undefined → 先前写法静默跳过音量检测（●声/○静音 永不显示）。全局优先，window 兜底。
                    var AC = null
                    try { AC = typeof AudioContext !== 'undefined' ? AudioContext : null } catch (e) { AC = null }
                    if (!AC) { try { AC = window.AudioContext || window.webkitAudioContext } catch (e2) { AC = null } }
                    if (AC) {
                      const actx = new AC()
                      const src = actx.createMediaStreamSource(stream)
                      analyser = actx.createAnalyser()
                      analyser.fftSize = 1024
                      src.connect(analyser)
                      if (typeof actx.resume === 'function') { try { actx.resume() } catch (e) { /* ignore */ } }
                      // 每 500ms 读 RMS：UI 显示"检测到声音/未检测到"；持续静音 2.5s 提示。
                      // 2026-08-15 修复：client 沙箱无全局 setInterval（Builtin 仅 ctx/React/host/styles/console，
                      // React 也仅暴露 createElement/useState/useEffect），必须用 timer Service 的 interval
                      // （返回 disposer）。旧代码 setInterval 抛 ReferenceError：volTimer 的被 try 吞掉 →
                      // 指示永不显示；partial 的 setInterval 在 try 外 → 误报 mic_denied（录音仍在跑）。
                      const buf = new Uint8Array(analyser.fftSize)
                      let silentMs = 0
                      if (timerSvc && typeof timerSvc.interval === 'function') {
                        volTimer = timerSvc.interval(function () {
                          try {
                            analyser.getByteTimeDomainData(buf)
                            let sum = 0
                            for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
                            const rms = Math.sqrt(sum / buf.length)
                            if (rms >= 0.008) {
                              silentMs = 0
                              set(function (prev) { return Object.assign({}, prev, { vol: 'voice' }) })
                            } else {
                              silentMs += 500
                              set(function (prev) { return Object.assign({}, prev, { vol: silentMs >= 2500 ? 'silent' : 'quiet' }) })
                            }
                          } catch (e) { /* ignore */ }
                        }, 500)
                      }
                    }
                  } catch (e) { analyser = null }
                  // 2026-08-15 修复：优先 audio/wav（PCM 增量切片可解码）；webm 增量切片实测无法解码。
                  // isTypeSupported 检测失败或构造失败 → 回退默认（Chrome 返回 webm/opus）。
                  micMime = 'audio/wav'
                  let rec = null
                  try {
                    if (typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/wav')) {
                      rec = new MediaRecorder(stream, { mimeType: 'audio/wav' })
                    }
                  } catch (e) { rec = null }
                  if (!rec) {
                    micMime = 'audio/webm'
                    try { rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }) } catch (e) { rec = new MediaRecorder(stream) }
                  }
                  micChunks = []; micSeconds = 0
                  rec.ondataavailable = function (ev) {
                    if (ev.data && ev.data.size > 0) micChunks.push(ev.data)
                    micSeconds += 1
                    set(function (prev) { return Object.assign({}, prev, { seconds: micSeconds }) })
                    const max = (voiceState.cfg && voiceState.cfg.voiceInput && voiceState.cfg.voiceInput.maxSeconds) || 60
                    if (micSeconds >= max && rec.state === 'recording') { try { rec.stop() } catch (e) { /* ignore */ } }
                  }
                  rec.onstop = function () {
                    if (volTimer) { try { volTimer() } catch (e) { /* ignore */ } volTimer = null }
                    if (partialTimer) { try { partialTimer() } catch (e) { /* ignore */ } partialTimer = null }
                    partialStale = true // 丢弃在途 partial 结果，防覆盖最终转写（须在守卫之前：陈旧路径上迟到的 partial 也不得 ghost 插入旧会话草稿）
                    // M9：卸载（会话切换）后 MediaRecorder.stop() 仍异步触发本闭包，而闭包里的 sid/inputActions
                    // 是录音开始时的值 → 提交前校验录音归属：不属本会话或已卸载（alive=false）→ 丢弃陈旧提交。
                    // 不能以 micRec==null 判陈旧：正常停止路径（toggleMic）也是先置 micRec=null 再 stop。
                    if (!recSessionRef || recSessionRef.sid !== sid || !recSessionRef.alive) return // M9：丢弃陈旧提交
                    transcribe(sid, props.inputActions, set)
                  }
                  recSessionRef = { sid: sid, alive: true } // M9：录音归属当前会话（onstop 提交前校验）
                  rec.start(1000)
                  micRec = { rec: rec, stream: stream, analyser: analyser, volTimer: volTimer }
                  set(function (prev) { return Object.assign({}, prev, { phase: 1, seconds: 0, error: null, vol: null }) })
                  // 音量检测不可用（AC 获取失败）：phase:1 之后再设 noana（避免被上面的 vol:null 覆盖），
                  // UI 显示"检测不可用"而非完全不显示（诊断可见）
                  if (!analyser) {
                    set(function (prev) { return Object.assign({}, prev, { vol: 'noana' }) })
                  }
                  // 实时预览：每 3s 把"上次 partial 之后"的新增音频送去转写（WAV 增量可解码，host 常驻 worker
                  // 单次 ~0.8s），结果累积进输入框 draft（预览）。webm fallback（不支持 wav 时）退化为
                  // 全量重传（chunks[0] 起，可解码）+ 覆盖显示。partialBusy 跳过保证不并发堆积。
                  // timer Service interval（沙箱无 setInterval）；disposer 存 partialTimer 供清理。
                  partialBusy = false; partialIdx = 0; partialStale = false; partialAcc = ''
                  if (timerSvc && typeof timerSvc.interval === 'function') {
                    partialTimer = timerSvc.interval(function () {
                      if (partialBusy || partialStale || !micChunks.length || micChunks.length <= partialIdx) return
                      partialBusy = true
                      const isWav = micMime.indexOf('wav') >= 0
                      // wav：增量（新 chunks）；webm fallback：全量（chunks[0] 起，含头可解码）
                      const parts = isWav ? micChunks.slice(partialIdx) : micChunks.slice(0)
                      partialIdx = micChunks.length
                      const build = isWav ? buildWavBlob(parts) : Promise.resolve(new Blob(parts, { type: micMime }))
                      build.then(function (blob) {
                        if (!blob) { partialBusy = false; return }
                        return blob.arrayBuffer().then(function (buf) {
                          const bytes = new Uint8Array(buf)
                          let bin = ''
                          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
                          return host.call('guide-dog/transcribe', { audioB64: btoa(bin), mime: micMime, sessionId: sid, language: micLang, partial: true })
                        })
                      }).then(function (r) {
                        partialBusy = false
                        if (!partialStale && r && r.ok && r.text) {
                          if (isWav) { partialAcc += (partialAcc ? ' ' : '') + r.text; insertText(inputActions, partialAcc) }
                          else { insertText(inputActions, r.text) } // webm fallback：全量重传，覆盖显示
                        }
                      }).catch(function () { partialBusy = false })
                    }, 3000)
                  }
                  playStartTone() // 录音开始提示音：确认录音通道已真正启动
                }).catch(function (err) {
                  // 防御：若 micRec 已建立（录音已在运行），说明异常发生在启动后（不应误报权限错误）
                  if (micRec) return
                  const name = err && err.name
                  set(function (prev) { return Object.assign({}, prev, { error: (name === 'NotFoundError' || name === 'OverconstrainedError') ? 'no_device' : 'mic_denied' }) })
                })
              } catch (e) { set(function (prev) { return Object.assign({}, prev, { error: 'mic_denied' }) }) }
            }
            const toggleMic = function () {
              if (s.phase === 1) {
                const r = micRec
                micRec = null
                if (r) {
                  if (r.volTimer) { try { r.volTimer() } catch (e) { /* ignore */ } }
                  try { r.rec.stop() } catch (e) { /* ignore */ } try { r.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ }
                }
                return
              }
              if (s.phase === 2) return
              startRec()
            }
            const micErrText = {
              mic_denied: '麦克风权限被拒绝', no_device: '未检测到麦克风设备',
              empty_speech: s.diag && s.diag.indexOf('no-data') === 0 ? '没听清（录音未收到数据，' + s.diag.slice(7) + '）' : '没听清，请再说一次',
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
                ? h('a', { className: 'gd-btn', href: '/guide-dog/recorder', target: '_blank', rel: 'noreferrer', title: '浏览器限制：录音需在独立页面进行' }, micIcon(false))
                : h('button', { className: 'gd-btn' + (s.phase === 1 ? ' gd-rec' : ''), title: micTip, onClick: toggleMic }, micIcon(s.phase === 1)),
              s.phase === 1 ? h('span', { className: 'gd-sec' }, s.seconds + 's') : null,
              s.phase === 1 && s.vol ? h('span', {
                className: 'gd-vol',
                title: s.vol === 'voice' ? '检测到声音输入' : (s.vol === 'noana' ? '音量检测不可用（AudioContext 受限）' : '未检测到声音输入（请检查麦克风/远程音频）'),
                style: { fontSize: 11, color: s.vol === 'voice' ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : (s.vol === 'noana' ? '#888' : 'var(--dsw-alias-state-error-primary, #c62828)') },
              }, s.vol === 'voice' ? '●声' : (s.vol === 'noana' ? '检测不可用' : '○静音')) : null,
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

    // ============ CALL PANEL 节（Phase 2，client） ============
    const callState = { active: false, mode: 'vad', phase: 'idle', muted: false, speed: 1, recording: false, error: null }
    const callSubs = []
    function setCallState(patch) {
      Object.assign(callState, patch)
      callSubs.forEach(function (fn) { try { fn(callState) } catch (e) { /* ignore */ } })
    }
    function subscribeCall(fn) { callSubs.push(fn); return function () { const i = callSubs.indexOf(fn); if (i >= 0) callSubs.splice(i, 1) } }
    // 会话切换：通话状态随会话（header action 是会话级）；切会话时 phase 回 idle 但不自动挂断音频
    let callSessionId = null

    // ---- 会话 header 发起/挂断按钮（conversation.session.header.actions，order 30） ----
    ctx.effect(function () {
      try {
        return slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'guide-dog-call-btn', order: 30, label: function () { return 'Call' } },
            function (props) {
              const sid = props.sessionId || callSessionId
              callSessionId = sid
              const [, force] = React.useState(0)
              React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
              const active = callState.active
              const style = {
                display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 8px',
                borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #ccc)',
                background: active ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : 'transparent',
                color: active ? '#fff' : 'var(--dsw-alias-label-secondary, #666)',
                fontFamily: 'inherit', fontSize: '12px',
              }
              return React.createElement('button', {
                style: style, title: active ? '挂断通话' : '发起语音通话',
                onClick: function () {
                  if (!active) {
                    setCallState({ active: true, phase: 'listening', recording: false })
                    startCall(sid) // Task 7 定义：初始化采集
                  } else {
                    stopCall() // Task 7 定义：停止采集与播放
                  }
                },
              }, active ? '📞 通话中' : '📞 通话')
            })
        })
      } catch (e) { return function () {} }
    })

    // ---- 输入框 dock 状态条（conversation.input.dock，order 31） ----
    ctx.effect(function () {
      try {
        return slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'guide-dog-call-status', order: 31, label: function () { return 'Call status' } },
            function (props) {
              const [, force] = React.useState(0)
              React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
              if (!callState.active) return null
              const text = { listening: '收听中…', processing: '处理中…', speaking: '播报中…', idle: '就绪' }[callState.phase] || ''
              const style = { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #666)', padding: '0 4px', fontFamily: 'inherit' }
              return React.createElement('span', { style: style }, text + (callState.muted ? ' · 静音' : ''))
            })
        })
      } catch (e) { return function () {} }
    })

    // ---- 通话面板（shell.overlay，order 40：模式切换/录音/静音/语速） ----
    ctx.effect(function () {
      try {
        return slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'guide-dog-call-panel', order: 40, label: function () { return 'Call panel' } },
            function () {
              const [, force] = React.useState(0)
              React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
              if (!callState.active) return null
              const panelStyle = {
                position: 'fixed', right: '16px', bottom: '64px', width: '260px', zIndex: 1000,
                background: 'var(--dsw-alias-bg-layer-2, #fff)', border: '1px solid var(--dsw-alias-border-l1, #ddd)',
                borderRadius: '10px', padding: '12px', boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                fontFamily: 'inherit', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #333)',
              }
              const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '6px 0' }
              const btnStyle = { padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1, #ccc)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px' }
              const micBtnStyle = Object.assign({}, btnStyle, callState.recording ? { background: '#c62828', color: '#fff' } : {})
              return React.createElement('div', { style: panelStyle },
                React.createElement('div', { style: rowStyle },
                  React.createElement('span', null, '语音通话'),
                  React.createElement('button', { style: btnStyle, onClick: function () { stopCall() } }, '挂断')),
                React.createElement('div', { style: rowStyle },
                  React.createElement('span', null, '模式'),
                  React.createElement('select', {
                    style: btnStyle, value: callState.mode,
                    onChange: function (ev) { setCallState({ mode: ev.target.value }) },
                  },
                    React.createElement('option', { value: 'vad' }, 'VAD 自动'),
                    React.createElement('option', { value: 'ptt' }, '按住说话'))),
                React.createElement('div', { style: rowStyle },
                  React.createElement('button', { style: micBtnStyle, title: callState.mode === 'ptt' ? '按住说话' : '点击手动结束/开始一段',
                    onPointerDown: function (ev) { if (callState.mode === 'ptt') { ev.preventDefault(); startSegment() } },
                    onPointerUp: function (ev) { if (callState.mode === 'ptt') { ev.preventDefault(); stopSegment() } },
                    onClick: function () { if (callState.mode !== 'ptt' && !callState.recording) startSegment(); else if (callState.mode !== 'ptt' && callState.recording) stopSegment() },
                  }, callState.recording ? '■ 录音中' : '🎤 说话'),
                  React.createElement('span', null, callState.mode === 'ptt' ? '按住说话' : 'VAD 自动')),
                React.createElement('div', { style: rowStyle },
                  React.createElement('button', { style: btnStyle, onClick: function () { setCallState({ muted: !callState.muted }) } }, callState.muted ? '🔇 取消静音' : '🔊 静音'),
                  React.createElement('span', null, '语速 '),
                  React.createElement('select', {
                    style: btnStyle, value: String(callState.speed),
                    onChange: function (ev) { setCallState({ speed: parseFloat(ev.target.value) }) },
                  },
                    React.createElement('option', { value: '0.8' }, '0.8x'),
                    React.createElement('option', { value: '1' }, '1x'),
                    React.createElement('option', { value: '1.2' }, '1.2x'))),
                callState.error ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c62828)', marginTop: '6px' } }, callState.error) : null)
            })
        })
      } catch (e) { return function () {} }
    })

    // ---- 采集控制接口桩（Task 7 实现真实采集与播放） ----
    function startCall(sid) { /* Task 7 */ }
    function stopCall() { /* Task 7 */ }
    function startSegment() { /* Task 7 */ }
    function stopSegment() { /* Task 7 */ }

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
        const urls = ((value.urls && value.urls.length) ? value.urls : (value.url ? [value.url] : []))
          .filter(function (u) { return safeMedia(u) !== null })
        if (!urls.length) return h('div', { style: mutedStyle }, 'no media url')
        return h('div', null, urls.map(function (u, i) {
          return h('a', { key: i, href: safeHref(u), target: '_blank', rel: 'noreferrer', style: { display: 'block', marginBottom: 6 } },
            h('img', { src: safeMedia(u), style: { maxWidth: '100%', maxHeight: 420, borderRadius: 8, border: '1px solid rgba(128,128,128,.35)', display: 'block' } }))
        }))
      }
      if (variant === 'audio') {
        const src = safeMedia(value.url)
        if (!src) return h('div', { style: mutedStyle }, 'no media url')
        return h('div', { style: { marginTop: 6 } },
          h('audio', { src: src, controls: true, style: { width: '100%' } }),
          h('a', { href: safeHref(value.url), target: '_blank', rel: 'noreferrer', style: linkStyle }, 'open file'))
      }
      if (variant === 'video') {
        const src = safeMedia(value.url)
        if (!src) return h('div', { style: mutedStyle }, 'no media url')
        return h('div', { style: { marginTop: 6 } },
          h('video', { src: src, controls: true, preload: 'metadata', style: { maxWidth: '100%', maxHeight: 420, borderRadius: 8 } }))
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
            h('a', { href: safeHref(r.url), target: '_blank', rel: 'noreferrer', style: { color: '#4a7dff', fontSize: 13 } }, r.title || r.url),
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
          h('pre', { style: preStyle }, JSON.stringify(maskSensitive(value), null, 2))))
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
      const state = React.useState({ auth: null, voices: [], media: [], text: '', voice: 'auto', busy: false, playUrl: null, error: null, cfg: null, status: null, audioInputs: [] })
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
        // 输入设备枚举（2026-08-15：远程 RDP 场景需显式选择麦克风）
        try {
          navigator.mediaDevices.enumerateDevices().then(function (devices) {
            if (!alive) return
            const inputs = (devices || []).filter(function (d) { return d.kind === 'audioinput' })
              .map(function (d) { return { id: d.deviceId, label: d.label || ('输入设备 ' + d.deviceId.slice(0, 8)) } })
            set(function (prev) { return Object.assign({}, prev, { audioInputs: inputs }) })
          }).catch(function () {})
        } catch (e) { /* ignore */ }
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
          h('label', null, ' 设备：', h('select', {
            value: (s.cfg.voiceInput.deviceId) || '',
            onChange: function (e) { setCfg({ voiceInput: { deviceId: e.target.value } }) },
          }, [h('option', { key: '', value: '' }, '默认')].concat((s.audioInputs || []).map(function (d) {
            return h('option', { key: d.id, value: d.id }, d.label)
          })))),
          h('label', null, h('input', { type: 'checkbox', checked: !!s.cfg.voiceInput.autoSend, onChange: function (e) { setCfg({ voiceInput: { autoSend: e.target.checked } }) } }), ' 识别后自动发送（误识别内容会直接发出，请谨慎开启）')),
        s.audioInputs && s.audioInputs.length === 0 ? h('div', { style: mutedStyle }, '未枚举到输入设备（远程/无头环境可能需 RDP 音频重定向）') : null,
        h('div', { style: rowStyle },
          h('span', { style: badgeStyle }, 'STT'),
          s.status ? h('span', { style: mutedStyle }, 'faster-whisper: ' + (s.status.whisperAvailable ? '可用 ' + ((s.status.whisperVersion || '') + ' / ' + (s.status.whisperPython || '')) : '不可用 — 需 pip install faster-whisper')) : null,
          h('label', null, ' 模型：', h('select', { value: s.cfg.voiceInput.whisper.model, onChange: function (e) { setCfg({ voiceInput: { whisper: { model: e.target.value } } }) } },
            h('option', { value: 'base' }, 'base（快）'), h('option', { value: 'small' }, 'small（准）')))),
      ]) : null
      const mediaCells = s.media.map(function (m, i) {
        if (m.kind === 'image') {
          const src = safeMedia(m.url)
          return src ? h('a', { key: i, href: safeHref(m.url), target: '_blank', rel: 'noreferrer', title: m.name },
            h('img', { src: src, style: { width: 96, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)' } })) : null
        }
        if (m.kind === 'video') {
          const src = safeMedia(m.url)
          return src ? h('video', { key: i, src: src, muted: true, preload: 'metadata', style: { width: 96, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)' } }) : null
        }
        if (m.kind === 'audio') {
          const src = safeMedia(m.url)
          return src ? h('audio', { key: i, src: src, controls: true, preload: 'none', style: { width: 150 } }) : null
        }
        return h('a', { key: i, href: safeHref(m.url), target: '_blank', rel: 'noreferrer', style: { fontSize: 12 } }, m.name)
      }).filter(Boolean)
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
          s.playUrl ? h('audio', { src: safeMedia(s.playUrl), controls: true, autoPlay: true, style: { width: '100%', marginTop: 8 } }) : null),
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
