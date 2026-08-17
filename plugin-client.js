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

    // RC14 构建标记：用户硬刷新后可在 DevTools 控制台看到此行，用于确认浏览器加载了新客户端
    // （客户端 bundle 在页面加载时注入——只重启 DSH 不会更新浏览器里的旧客户端）
    try { console.log('[guide-dog] client build rc15-20260817') } catch (e) { /* ignore */ }

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
    // ---- M9：录音归属会话（卸载后 onstop 校验归属，丢弃陈旧提交） ----
    let recSessionRef = null // { sid, alive }：录音归属；卸载置 alive=false → onstop 丢弃
    function stopCurrent() {
      if (curAudio) {
        try { curAudio.pause() } catch (e) { /* ignore */ }
        curAudio = null
      }
      // RC15：持久播放器同停（共识 mp3 抢占时不得残留语音模式音频）
      if (voicePlayer.audio) {
        try { voicePlayer.audio.pause() } catch (e) { /* ignore */ }
      }
      // RC15（F1）：中断时释放 busy 并回队——防 voicePlayer.busy 死锁吞条目（评审 Important）
      if (voicePlayer.busy || voicePlayer.current) {
        const a = voicePlayer.audio
        if (a) { a.onended = null; a.onerror = null }
        if (voicePlayer.ac) { try { voicePlayer.ac.abort() } catch (e) { /* ignore */ } voicePlayer.ac = null }
        const cur = voicePlayer.current
        if (cur && cur.objUrl) { try { URL.revokeObjectURL(cur.objUrl) } catch (e) { /* ignore */ } }
        voicePlayer.current = null
        voicePlayer.busy = false
        voicePlayer.attempts.delete(String((cur && cur.entry && (cur.entry.key || cur.entry.url)) || ''))
        if (cur) requeueVoiceEntry(cur.entry, cur.sid)
        const pend = voicePlayer.pending
        voicePlayer.pending = []
        if (pend) { for (let i = 0; i < pend.length; i++) { if (pend[i] && pend[i].entry) requeueVoiceEntry(pend[i].entry, pend[i].sid) } }
      }
    }
    // ============ RC15 播放器：语音模式/播报 mp3（持久元素 + fetch 全量下载） ============
    // 旧实现逐条目 new Audio(url)：自动播放被拦/元素被替换 → 浏览器中止下载 →
    // ERR_CONTENT_LENGTH_MISMATCH + Chrome 媒体重试风暴（同文件 10-30 次请求）。
    // 新实现：fetch 一次拿全量字节（AbortController 120s 超时）→ Blob URL → 单一持久 Audio 元素。
    const voicePlayer = { audio: null, ctx: null, busy: false, pending: [], attempts: new Map(), banner: false, current: null, ac: null }
    function ensureVoiceAudio() {
      if (!voicePlayer.audio) {
        try { voicePlayer.audio = new Audio() } catch (e) { voicePlayer.audio = null }
        if (voicePlayer.audio) voicePlayer.audio.preload = 'auto'
      }
      return voicePlayer.audio
    }
    // RC15：手势解锁——click/keydown/touchstart 后 resume AudioContext 并重试挂起条目
    function unlockVoiceAudio() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (AC) {
          voicePlayer.ctx = voicePlayer.ctx || new AC()
          if (voicePlayer.ctx.state === 'suspended') { try { voicePlayer.ctx.resume() } catch (e) { /* ignore */ } }
        }
      } catch (e) { /* ignore */ }
      const a = ensureVoiceAudio()
      // RC15-F：被拦条目已加载 → 直接续播同一 blob（不再重新 fetch，防重启 + 泄漏）
      if (voicePlayer.current && a && a.src && a.paused) {
        const p = a.play()
        if (p && typeof p.catch === 'function') p.catch(function () {})
        const ck = String(voicePlayer.current.entry && (voicePlayer.current.entry.key || voicePlayer.current.entry.url || ''))
        voicePlayer.pending = voicePlayer.pending.filter(function (q) {
          return String(q.entry && (q.entry.key || q.entry.url || '')) !== ck
        })
        return
      }
      if (!voicePlayer.busy && voicePlayer.pending && voicePlayer.pending.length) {
        const first = voicePlayer.pending.shift()
        playVoiceEntry(first.entry, first.sid)
      }
    }
    // RC15：全局手势监听（apply 时注册一次；capture 阶段捕获页面任意点击）
    function bindGestureUnlock() {
      try {
        ;['click', 'keydown', 'touchstart'].forEach(function (ev) {
          try { window.addEventListener(ev, unlockVoiceAudio, true) } catch (e) { /* ignore */ }
        })
      } catch (e) { /* ignore */ }
    }
    // RC15：单条目播放——fetch 全量 → 持久元素播放；失败回队（≤3 次/条目）；自动播放被拦 → 挂起等手势
    function playVoiceEntry(entry, sid) {
      const key = String(entry.key || entry.url || '')
      if (!key) return Promise.resolve()
      return waitStreamDrain().then(function () {
        if (voicePlayer.busy) { voicePlayer.pending.push({ entry: entry, sid: sid }); while (voicePlayer.pending.length > 40) voicePlayer.pending.shift(); return Promise.resolve() }
        // RC15-F：mp3 抢占（恢复 RC14 语义）——播报/语音条目开播前停掉流/共识播放器，防双音重叠
        stopCurrent()
        voicePlayer.busy = true
        voicePlayer.banner = false
        const attempts = (voicePlayer.attempts.get(key) || 0) + 1
        voicePlayer.attempts.set(key, attempts)
        if (attempts > 3) {
          voicePlayer.busy = false
          voicePlayer.attempts.delete(key)
          showToast('播放失败：' + String(entry.text || entry.url || '').slice(0, 24))
          return Promise.resolve()
        }
        const ac = new AbortController()
        voicePlayer.ac = ac
        const timer = setTimeout(function () { try { ac.abort() } catch (e) { /* ignore */ } }, 120000)
        return fetch(String(entry.url), { cache: 'no-store', signal: ac.signal }).then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status)
          return r.blob()
        }).then(function (blob) {
          clearTimeout(timer)
          voicePlayer.ac = null
          const a = ensureVoiceAudio()
          if (!a) throw new Error('no audio element')
          const objUrl = URL.createObjectURL(blob)
          voicePlayer.current = { entry: entry, sid: sid, objUrl: objUrl }
          const cleanup = function () {
            if (voicePlayer.current && voicePlayer.current.objUrl === objUrl) voicePlayer.current = null
            try { URL.revokeObjectURL(objUrl) } catch (e) { /* ignore */ }
          }
          a.onended = function () {
            cleanup(); a.onended = null; a.onerror = null
            voicePlayer.busy = false; voicePlayer.attempts.delete(key); nextVoiceEntry()
          }
          a.onerror = function () {
            cleanup(); a.onended = null; a.onerror = null
            voicePlayer.busy = false; requeueVoiceEntry(entry, sid); nextVoiceEntry()
          }
          a.src = objUrl
          const c = (playCounts.get(key) || 0) + 1
          playCounts.set(key, c)
          gdLog('voice play key=' + key + ' times=' + c)
          const p = a.play()
          if (p && typeof p.catch === 'function') p.catch(function () {
            // 自动播放策略拦截：不丢条目，挂起等待用户手势（unlockVoiceAudio 触发重播）
            voicePlayer.busy = false
            voicePlayer.pending.push({ entry: entry, sid: sid })
            if (!voicePlayer.banner) { voicePlayer.banner = true; showToast('点击页面任意位置开启语音播报') }
          })
          return Promise.resolve()
        }).catch(function (e) {
          clearTimeout(timer)
          if (voicePlayer.ac === ac) voicePlayer.ac = null
          voicePlayer.busy = false
          gdLog('voice fail key=' + key + ' err=' + String((e && e.message) || e).slice(0, 60))
          requeueVoiceEntry(entry, sid)
          nextVoiceEntry()
        })
      })
    }
    function requeueVoiceEntry(entry, sid) {
      host.call('guide-dog/voice-requeue', {
        sessionId: sid,
        entry: { key: entry.key, url: entry.url, text: entry.text, stream: entry.stream, consensus: entry.consensus },
      }).catch(function () {})
    }
    function nextVoiceEntry() {
      const pend = voicePlayer.pending
      if (pend && pend.length) { const first = pend.shift(); playVoiceEntry(first.entry, first.sid) }
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
    // RC16（2026-08-17 通话输入修复）：采集约束单一来源——语音模式与通话模式共用同一设备设置。
    // 旧实现通话模式硬编码 { audio: true }（忽略 deviceId）→ 该流上 recorder 不产出数据、段静默丢弃。
    function micAudioReq() {
      return micDeviceId ? { audio: { deviceId: { exact: micDeviceId } } } : { audio: true }
    }
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
              // I1（2026-08-16 审稿）：通话期间 stream 条目由通话专用轮询（callPoll）独家消费
              // ——本轮询停用，保证队列单消费者（Phase 1 的 pop 语义会丢弃无 url 的 stream 条目）
              if (!effective || callState.active || !sid || pollBusy) return
              pollBusy = true
              host.call('guide-dog/voice-queue', { sessionId: sid }).then(function (r) {
                if (r && r.ok && r.entry) {
                  // RC15：持久播放器（fetch+Blob）；错误条目照旧提示
                  if (r.entry.url) return playVoiceEntry(r.entry, sid)
                  else if (r.entry.error) { showToast('朗读失败：' + (r.entry.message || r.entry.error)); playBeep() }
                } else if (r && r.ok && !r.entry) {
                  // RC15：与 callPoll 同款播放汇总埋点（语音模式 mp3 计数；!r.ok 跳过防跨回合误归零）
                  if (playCounts.size) {
                    const summary = Array.from(playCounts.entries()).map(function (e) { return e[0] + '=' + e[1] }).join(' | ')
                    gdLog('PLAY-SUMMARY ' + summary)
                    playCounts.clear()
                  }
                }
              }).catch(function () {}).then(function () { pollBusy = false })
            }, [effective, sid, tick])
            const startRec = function () {
              try {
                // 输入设备选择（设置页下拉，存 voiceInput.deviceId）；空 = 系统默认（RC16：micAudioReq 单一来源）
                navigator.mediaDevices.getUserMedia(micAudioReq()).then(function (stream) {
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
    // RC13（三路评审定案）：通话归属（会话 + inputActions）在 startCall 时一次性捕获；
    // 渲染期不再写全局——多会话 header 渲染互相覆盖曾导致转写串台（12:33-12:35 双会话
    // 错投）与渲染期误挂断。对齐 Phase 1 M9 recSessionRef 模式。
    let callSessionRef = null // { sid: string, actions: object|null }
    function callSid() { return (callSessionRef && callSessionRef.sid) || '' }
    function callActions() { return (callSessionRef && callSessionRef.actions) || null }

    // ---- 会话 header 发起/挂断按钮（conversation.session.header.actions，order 30） ----
    ctx.effect(function () {
      try {
        return slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'guide-dog-call-btn', order: 30, label: function () { return 'Call' } },
            function (props) {
              // RC13：渲染期只读——任何会话的 header 渲染都不再写模块级全局（旧代码在渲染期
              // 覆盖全局 inputActions 与会话归属 → 多会话互相串台；渲染期自动挂断 → 切会话即误挂）
              const sid = props.sessionId || (callSessionRef && callSessionRef.sid) || ''
              // 激活态按"通话归属会话"判定：只有归属会话的按钮显示"通话中"
              const myCall = callState.active && callSessionRef && callSessionRef.sid === sid
              const [, force] = React.useState(0)
              React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
              const style = {
                display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 8px',
                borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #ccc)',
                background: myCall ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : 'transparent',
                color: myCall ? '#fff' : 'var(--dsw-alias-label-secondary, #666)',
                fontFamily: 'inherit', fontSize: '12px',
              }
              return React.createElement('button', {
                style: style, title: myCall ? '挂断通话' : '发起语音通话',
                onClick: function () {
                  if (!myCall) {
                    // RC13：仅在用户点击时切换通话会话——先挂断旧通话再开新通话（挂断动作
                    // 不再由渲染期触发）。通话跨会话切换继续存活（浮动面板可挂断）。
                    if (callState.active && callSessionRef) stopCall()
                    setCallState({ active: true, phase: 'listening', recording: false })
                    startCall(sid, props.inputActions) // RC13：归属（sid + inputActions）开播时刻捕获
                  } else {
                    stopCall()
                  }
                },
              }, myCall ? '📞 通话中' : '📞 通话')
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
              // Task 12：通话专用下行轮询（I1：stream 条目仅由 callPoll 消费；timerSvc 可选）
              React.useEffect(function () {
                if (!timerSvc || typeof timerSvc.interval !== 'function') return
                const stop = timerSvc.interval(function () { callPoll() }, 1000)
                return function () { try { stop() } catch (e) { /* ignore */ } }
              }, [])
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

    // ---- 采集控制接口（Task 7：MediaRecorder + AnalyserNode VAD + PTT + 上传提交） ----
    // 模块级采集状态（Phase 1 惯例：全部状态模块级，不用 useRef）
    let callMic = null // { stream, rec, analyser, raf, segmentStart, segmentSeconds, audioCtx }（rec：当前段 recorder，自持 gdChunks）
    let callSegmentActive = false
    let callBargeCb = null // Task 12 设置：用户发声回调（bargeIn 钩子）
    let callRms = 0 // 最新 RMS（isUserSpeaking 供 Task 8/9 共识窗口查询）

    function startCall(sid, inputActions) {
      if (callMic) return
      // RC13：通话归属开播时刻捕获——上传/打断/轮询/回退提交一律用此快照，杜绝渲染期覆盖串台
      callSessionRef = { sid: String(sid || ''), actions: inputActions || null }
      setCallState({ active: true, phase: 'listening', recording: false, error: null })
      callActiveRpc('session', true) // C4：持久通话激活（Task 10 进度播报 / Task 11 下行流式判据）
      try {
        // RC16：通话输入遵循同一设备设置（旧 { audio: true } 硬编码 → 流上 recorder 不产出数据）
        navigator.mediaDevices.getUserMedia(micAudioReq()).then(function (stream) {
          // AC 获取（Phase 1 已验证模式）：全局优先，window 兜底
          var AC = null
          try { AC = typeof AudioContext !== 'undefined' ? AudioContext : null } catch (e) { AC = null }
          if (!AC) { try { AC = window.AudioContext || window.webkitAudioContext } catch (e2) { AC = null } }
          const audioCtx = new AC()
          const src = audioCtx.createMediaStreamSource(stream)
          const analyser = audioCtx.createAnalyser()
          analyser.fftSize = 2048
          analyser.smoothingTimeConstant = 0.3
          src.connect(analyser)
          if (typeof audioCtx.resume === 'function') { try { audioCtx.resume() } catch (e) { /* ignore */ } }
          // RC4（2026-08-17 验收）：不再整通通话持有一个 MediaRecorder——旧实现 chunk0（EBML 头）
          // 总在首个段开始前到达并被 callSegmentActive 门丢弃 → 段 blob 无头 → ffmpeg 解不出
          // （用户实测 "[Errno 1094995529] Invalid data found"）。录音器改由 startSegment 每段新建，
          // 每段 chunk0 自带 EBML 头，段 blob 为完整 webm。VAD 分析只依赖 analyser，与 recorder 无关。
          callMic = { stream: stream, rec: null, analyser: analyser, raf: 0, segmentStart: 0, segmentSeconds: 0, audioCtx: audioCtx }
          // VAD 轮询：能量检测（threshold 可配）
          const cfg = voiceState.cfg || {}
          const vad = (cfg.call && cfg.call.vad) || {}
          const threshold = vad.threshold !== undefined ? vad.threshold : 0.02
          const minSpeechMs = vad.minSpeechMs !== undefined ? vad.minSpeechMs : 300
          const silenceMs = vad.silenceMs !== undefined ? vad.silenceMs : 700
          const maxSeg = (cfg.call && cfg.call.vad && cfg.call.vad.maxSegmentSeconds) || 60
          // I4（最终审稿）：打断最小连续发声时长（spec §6.6 防误触）——与 threshold/silenceMs 同处读取
          const interruptMinMs = vad.interruptMinMs !== undefined ? vad.interruptMinMs : 300
          let voicedSince = 0, silentSince = 0, lastVoiced = false, voicedStart = 0
          const sampleBuf = new Uint8Array(analyser.fftSize)
          const tick = function () {
            // 修正（Task 7）：rAF 循环须整通通话存活——仅 callMic 清空（stopCall）才终止；
            // 无活动段时保持轮询并重挂（否则首帧即死、VAD 永不工作；段结束分支同样重挂）
            if (!callMic) return
            analyser.getByteTimeDomainData(sampleBuf)
            let sum = 0
            for (let i = 0; i < sampleBuf.length; i++) { const v = (sampleBuf[i] - 128) / 128; sum += v * v }
            const rms = Math.sqrt(sum / sampleBuf.length)
            callRms = rms // isUserSpeaking 查询用
            const voiced = rms >= threshold
            const now = Date.now()
            // I4：unvoiced→voiced 跳变记时；连续发声 ≥ interruptMinMs 才允许打断（防瞬时误触）
            if (voiced && !lastVoiced) voicedStart = now
            // I7（最终审稿）：打断检查置于段空闲分支之前——PTT 无活动段时同样生效（spec §6.3）
            if (callState.phase === 'speaking' && voiced && (now - voicedStart) >= interruptMinMs && callBargeCb) callBargeCb()
            if (!callSegmentActive) {
              // VAD 自动起段（spec 6.9.1：说话-停顿-说话 两段成回合，无需点击）：
              // 无活动段且检测到语音 → 自动 startSegment；PTT 模式由 mode 门控排除；
              // barge-in 已提前执行（I7），auto-start 仅在此分支触发，互不冲突
              // RC2：播放（speaking）期间禁止自动起段——TTS 输出/环境声不得开段（回声开环）；打断由 barge-in 独占
              if (callState.mode === 'vad' && voiced && callState.phase !== 'speaking') startSegment()
              callMic.raf = requestAnimationFrame(tick)
              return
            }
            if (voiced) { voicedSince = now; lastVoiced = true }
            else if (lastVoiced) { silentSince = now; lastVoiced = false }
            // 端点：静音 ≥ silenceMs 且说过话（VAD 模式）→ 结束段
            if (callState.mode === 'vad' && voicedSince > 0 && !voiced && (now - voicedSince) >= silenceMs) {
              if (now - callMic.segmentStart >= minSpeechMs) stopSegment()
              else resetSegment() // brief 的 callMic.segments 引用是残留，去掉
              callMic.raf = requestAnimationFrame(tick)
              return
            }
            // 上限：段超 maxSeg 自动结束
            if (callSegmentActive && (now - callMic.segmentStart) >= maxSeg * 1000) {
              stopSegment()
              callMic.raf = requestAnimationFrame(tick)
              return
            }
            callMic.raf = requestAnimationFrame(tick)
          }
          callMic.raf = requestAnimationFrame(tick)
          setCallState({ phase: 'listening' })
        }).catch(function (err) {
          // I2（最终审稿）：麦克风获取失败 → 同步撤销 host 侧持久激活（否则 host 仍以为通话
          // 激活，进度/流式/心跳持续对一个已死的通话开火）
          callActiveRpc('session', false)
          setCallState({ active: false, phase: 'idle', error: '麦克风不可用：' + String((err && err.message) || err) })
        })
      } catch (e) {
        callActiveRpc('session', false)
        setCallState({ active: false, phase: 'idle', error: '麦克风初始化失败：' + String(e) })
      }
    }

    function stopCall() {
      if (callMic) {
        try { cancelAnimationFrame(callMic.raf) } catch (e) { /* ignore */ }
        // RC4：中止在途段 recorder——gdAbort 让 onstop 跳过上传（通话已结束，不提交）
        try { if (callMic.rec) { callMic.rec.gdAbort = true; if (callMic.rec.state !== 'inactive') callMic.rec.stop() } } catch (e) { /* ignore */ }
        try { callMic.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ }
        try { callMic.audioCtx.close() } catch (e) { /* ignore */ }
        callMic = null
      }
      callSegmentActive = false
      callActiveRpc('session', false) // C4：持久激活关闭
      // RC11：挂断清 host 待播队列——防陈旧条目在下次通话/页面刷新后重放
      host.call('guide-dog/call-command', { sessionId: callSid(), cmd: 'clear-queue' }).catch(function () {})
      setCallState({ active: false, phase: 'idle', recording: false })
      // Task 12：停止下行播放（函数届时落地；typeof 防御保证中间构建不崩）
      if (typeof stopStreamPlayback === 'function') stopStreamPlayback()
      callSessionRef = null // RC13：最后清归属——clear-queue/停播已完成（其 callSid() 需在清空前有效）
      playCounts.clear() // RC14：挂断即清播放计数（防跨会话错位汇总）
    }

    function resetSegment() {
      if (!callMic) return
      // RC4：chunks 归 recorder 所有（每段独立 recorder 自持 gdChunks），此处不得清空——
      // 清空会丢掉段内已采集的簇（EBML 头在 chunk0，早于首段到达，段 blob 将无头）
      callMic.segmentStart = Date.now()
      callMic.segmentSeconds = 0
    }

    function startSegment() {
      if (!callMic || callSegmentActive) return
      callSegmentActive = true
      resetSegment()
      callActiveRpc('speaking', true) // C4：瞬时发声（共识窗口中止判定用；非持久激活）
      setCallState({ recording: true })
      // RC4：每段独立 MediaRecorder——每段 chunk0 自带 EBML 头，段 blob 完整可解码
      try {
        const rec = newSegmentRecorder()
        callMic.rec = rec
        if (rec) { try { rec.start(250) } catch (e) { /* ignore */ } }
      } catch (e) { callMic.rec = null }
    }

    function stopSegment() {
      if (!callMic || !callSegmentActive) return
      callSegmentActive = false
      callActiveRpc('speaking', false)
      setCallState({ recording: false, phase: 'processing' })
      // RC4：停止段 recorder——最终 dataavailable（含剩余数据）先到，onstop 再上传；
      // 段 blob = 完整 webm（EBML 头 + 全部簇 + 收尾数据），不截尾
      const rec = callMic.rec
      let stopped = false
      if (rec) {
        try { if (rec.state !== 'inactive') { rec.stop(); stopped = true } } catch (e) { stopped = false }
      }
      if (!stopped) {
        // 防御：recorder 未运行 / stop 失败 → onstop 不会触发，按现有数据直接上传，避免卡 processing
        if (rec && rec.gdChunks.length) uploadSegmentBlob(new Blob(rec.gdChunks, { type: 'audio/webm' }))
        else {
          // RC16 诊断（仅日志）：recorder 无数据 → 记录现场（轨道状态）供 F12 排查
          try {
            const tracks = callMic && callMic.stream ? callMic.stream.getTracks().map(function (t) { return t.kind + ':' + t.readyState }).join(',') : 'no-stream'
            gdLog('call seg empty rec=' + (rec ? rec.state : 'null') + ' chunks=' + (rec ? rec.gdChunks.length : 0) + ' tracks=' + tracks)
          } catch (e) { /* ignore */ }
          setCallState({ phase: 'listening', error: null })
        }
      }
    }

    // RC4：每段独立 recorder——每段 chunk0 自带 EBML 头 → 段 blob 可解码（chrome/firefox 通用）
    function newSegmentRecorder() {
      if (!callMic || !callMic.stream) return null
      let rec = null
      try {
        if (typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          rec = new MediaRecorder(callMic.stream, { mimeType: 'audio/webm;codecs=opus' })
        }
      } catch (e) { rec = null }
      if (!rec) {
        try { rec = new MediaRecorder(callMic.stream, { mimeType: 'audio/webm;codecs=opus' }) } catch (e) { rec = new MediaRecorder(callMic.stream) }
      }
      rec.gdChunks = []
      rec.gdAbort = false
      rec.gdStopped = false
      rec.ondataavailable = function (ev) {
        if (ev.data && ev.data.size > 0 && !rec.gdAbort) rec.gdChunks.push(ev.data)
      }
      rec.onstop = function () {
        if (rec.gdStopped) return
        rec.gdStopped = true
        if (rec.gdAbort) return // stopCall 中止：不提交
        if (!rec.gdChunks.length) {
          // RC16 诊断（仅日志）：录了但零数据 → 流/recorder 异常（F12 排查）
          try { gdLog('call seg onstop no chunks rec=' + rec.state) } catch (e) { /* ignore */ }
          setCallState({ phase: 'listening', error: null }); return
        }
        uploadSegmentBlob(new Blob(rec.gdChunks, { type: 'audio/webm' }))
      }
      return rec
    }

    // 段上传 → 转写 → 插入 + 提交（与语音输入同路径；C1：raw `audio/webm` body）
    function uploadSegmentBlob(blob) {
      const sid = callSid()
      fetch('/guide-dog/call-transcribe', { method: 'POST', headers: { 'x-session-id': sid, 'content-type': 'audio/webm' }, body: blob }).then(function (r) {
        return r.json()
      }).then(function (r) {
        if (r && r.ok && r.text) {
          gdLog('transcribe ok text=' + String(r.text).slice(0, 30))
          // Task 13：语音命令拦截——命中命令则执行且不提交到对话
          const cmd = matchCallCommand(r.text)
          if (cmd) { gdLog('segment route=command'); runCallCommand(cmd); setCallState({ phase: 'listening' }); return }
          // RC11：打断直达 agent——打断后 10s 内的首个转写段走 interrupt RPC（host 侧
          // agent.steer 注入当前回合，下一个 step 边界消费），不再 submitInput 排队成新回合；
          // agent 不可用时回退原路径（插入 + 提交）。
          if (bargedAt && Date.now() - bargedAt < 10000) {
            bargedAt = 0
            gdLog('segment route=interrupt')
            host.call('guide-dog/call-command', { sessionId: callSid(), cmd: 'interrupt', text: r.text }).then(function (rr) {
              if (!(rr && rr.ok)) {
                gdLog('interrupt fallback -> submit')
                const actions = callActions()
                if (actions) { insertText(actions, r.text); submitInput(actions) }
              }
            }).catch(function () {
              gdLog('interrupt fallback -> submit (err)')
              const actions = callActions()
              if (actions) { insertText(actions, r.text); submitInput(actions) }
            })
            setCallState({ phase: 'listening' })
            return
          }
          gdLog('segment route=submit')
          const actions = callActions() // RC13：开播时刻捕获的 inputActions
          if (actions) { insertText(actions, r.text); submitInput(actions) }
          setCallState({ phase: 'listening' })
        } else {
          // RC12：空语音静默——VAD 误开段（环境声/回声）转写为空，不再报错打扰（无 toast/beep）
          gdLog('transcribe fail error=' + (r && r.error) + ' msg=' + String((r && r.message) || ''))
          const isEmpty = r && r.error === 'empty_speech'
          if (isEmpty) {
            setCallState({ phase: 'listening' })
          } else {
            const msg = (r && r.message) || '转写失败'
            setCallState({ phase: 'listening', error: msg })
            playBeep()
            showToast('通话转写失败：' + msg)
          }
        }
      }).catch(function (e) {
        setCallState({ phase: 'listening', error: '上传失败：' + String(e) })
        showToast('通话上传失败')
      })
    }

    function callActiveRpc(kind, active) {
      host.call('guide-dog/call-active', { sessionId: callSid(), kind: kind, active: active }).catch(function () {})
    }

    let consensusWindow = false
    function setConsensusWindow(on) {
      consensusWindow = !!on
      if (on && callMic) {
        // 窗口开启：**不**立即上报（C5 修复：host 端 announceAndWait 在窗口开始后清标志并监听
        // false→true 跳变；开窗即上报会自噬——host 会把"开窗瞬间的 true"当成用户发声）
        const threshold = ((voiceState.cfg || {}).call && voiceState.cfg.call.vad && voiceState.cfg.call.vad.threshold) || 0.02
        const sampleBuf = new Uint8Array(callMic.analyser.fftSize)
        const probe = function () {
          if (!consensusWindow || !callMic) return
          callMic.analyser.getByteTimeDomainData(sampleBuf)
          let sum = 0
          for (let i = 0; i < sampleBuf.length; i++) { const v = (sampleBuf[i] - 128) / 128; sum += v * v }
          const rms = Math.sqrt(sum / sampleBuf.length)
          if (rms >= threshold * 0.6) { callActiveRpc('speaking', true) } // 真实发声才上报（高灵敏，短音即报）
          setTimeout(probe, 100)
        }
        setTimeout(probe, 100)
      } else if (!on) {
        callActiveRpc('speaking', false)
      }
    }
    function notifyConsensusSpeech(started) { setConsensusWindow(started) }

    // 供 Task 8/9 共识窗口查询（brief Interfaces 产物）：当前 RMS 是否达到语音阈值
    function isUserSpeaking() {
      const cfg = voiceState.cfg || {}
      const vad = (cfg.call && cfg.call.vad) || {}
      const threshold = vad.threshold !== undefined ? vad.threshold : 0.02
      return callRms >= threshold
    }

    // ---- 通话轮询（CALL PANEL 节内；I1：不受语音模式门控） ----
    let callPollBusy = false
    const callPoll = function () {
      if (!callState.active || callPollBusy) return
      callPollBusy = true
      let consumed = false
      host.call('guide-dog/voice-queue', { sessionId: callSid() }).then(function (r) {
        if (r && r.ok && r.entry) {
          gdLog('poll ' + (r.entry.consensus ? 'consensus' : r.entry.stream ? 'stream' : r.entry.url ? 'url' : 'error') + ' key=' + (r.entry.key || '?') + ' text=' + String(r.entry.text || '').slice(0, 16))
          // RC8：全部条目类型都串行等待（consumed=true + return Promise）——进度播报 mp3 未播完
          // 不得播下一条（旧代码 url 分支不 await → 播报与回复流重叠 → "同时播报多条" + 噪声）
          if (r.entry.consensus) { consumed = true; return playEntryConsensus(r.entry.url) }
          // RC6：流条目串行——host tts-stream 每会话 busy 门（speechStreamBusy）拒绝并发合成；
          // 预合成重叠 fetch 实测第二请求 1.8ms 即 429 → '播放中断' + 句子丢失。await 本句播放
          // 结束再取下句：句 N 合成（~1-2s）通常短于播放时长，链仍无缝续接。
          // RC10：播报条目（progress/hb，key 前缀非 'stream:'）不覆盖 lastSpokenSentence——
          // 语音命令"重复"只重复回复句子，不重复播报。
          else if (r.entry.stream && r.entry.text) {
            if (!r.entry.key || r.entry.key.indexOf('stream:') === 0) lastSpokenSentence = r.entry.text
            consumed = true
            return playStreamEntry(r.entry, callSid())
          }
          else if (r.entry.url) { consumed = true; return playVoiceEntry(r.entry, callSid()) }
          else if (r.entry.error) { showToast('朗读失败：' + (r.entry.message || r.entry.error)); playBeep() }
        }
        // RC14：仅在确认本轮播放窗口结束（r.ok && !r.entry，队列空）时落汇总埋点——按 key 列出本轮播放次数
        // !r.ok 时跳过（RPC 失败/异常时跳过，避免把跨回合累积误归零）
        else if (r && r.ok && !r.entry) {
          if (playCounts.size) {
            const summary = Array.from(playCounts.entries()).map(function (e) { return e[0] + '=' + e[1] }).join(' | ')
            gdLog('PLAY-SUMMARY ' + summary)
            playCounts.clear()
          }
        }
      }).catch(function () {}).then(function () {
        callPollBusy = false
        // RC6：流条目播放完成立即续取下句（不等 1s tick）；队列空（consumed=false）时停止，
        // 由 interval tick 恢复轮询——避免空队列自旋
        if (consumed && callState.active) callPoll()
      })
    }
    // C5：共识 mp3 播放（window 关闭由 onended 触发；与 playEntry 同机制，附加回调）
    // RC7b：摘要必须抢占流播放（拦截发生在回复播放中时，摘要与在播帧叠加 → 噪声 + 听不清确认）
    // RC8：返回 Promise 供 callPoll 串行等待（摘要未播完不得播下一条）
    function playEntryConsensus(url) {
      stopStreamPlayback() // 内部 notify(false)，随后重开窗口保持 3s 窗
      notifyConsensusSpeech(true)
      stopCurrent()
      if (typeof Audio !== 'function') { showToast('播放器不可用'); return Promise.resolve() }
      return new Promise(function (resolve) {
        let settled = false
        const timer = setTimeout(function () { if (!settled) { settled = true; notifyConsensusSpeech(false); resolve() } }, 30000)
        const done = function () { if (!settled) { settled = true; clearTimeout(timer); notifyConsensusSpeech(false); resolve() } }
        try {
          const a = new Audio(String(url))
          curAudio = a
          a.onended = function () { if (curAudio === a) curAudio = null; done() }
          a.onerror = function () { if (curAudio === a) { curAudio = null; showToast('播放失败') } done() }
          const p = a.play()
          if (p && typeof p.catch === 'function') p.catch(function () { if (curAudio === a) { curAudio = null } done() })
        } catch (e) { curAudio = null; showToast('播放失败'); done() }
      })
    }
    // 挂到 CallPanel 组件的 useEffect（timerSvc.interval 1s）——Task 12 已在 guide-dog-call-panel 组件内接线

    // ============ STREAM PLAYER 节（Phase 2，client） ============
    const streamPlayer = { controller: null, nodes: [], nextTime: 0, active: false, audioCtx: null, playSeq: 0, gen: 0, fetching: false }
    // RC14：播放计数——一次复测定位「读两遍」（同一 key 播 2 次即双播铁证）
    const playCounts = new Map()
    // RC13（三路评审定案）：重试记账按 (sid,text) 维度——旧模块级单例记账：句 A 重试后
    // 5s 内句 B 失败不再重试（单例被 A 占用）。429（host 忙门）不重试（立即重试必再 429，
    // 且与在途合成并发；串行 poll 下一轮会取队列下一条）。
    const retryKeys = new Map() // 'sid|text' -> true（5s 后释放）
    // RC12 诊断日志：浏览器控制台打点（[gd] 前缀）——一次复测即可定位播放管线问题（爆音/重复/中断）
    function gdLog(msg) { try { console.log('[gd] ' + msg) } catch (e) { /* ignore */ } }
    // RC9（2026-08-17 验收）：流链排空等待——playStreamEntry 在 fetch 结束即 resolve（C2 预取
    // 语义），其调度音频仍可能在播；mp3 条目（进度播报/语音模式）开播前必须等链排空
    // （nodes 清空且 active 落回 false），否则播报与仍响的句子叠加。链空闲时立即通过。
    // 30s 兜底防死等（stopStreamPlayback 打断会使 nodes 清空 → 立即通过）。
    function waitStreamDrain(timeoutMs) {
      const limit = timeoutMs || 30000
      const start = Date.now()
      return new Promise(function (resolve) {
        const check = function () {
          if (!streamPlayer.active && !streamPlayer.nodes.length) { resolve(); return }
          if (Date.now() - start >= limit) { resolve(); return }
          setTimeout(check, 100)
        }
        check()
      })
    }
    function getTtsToken(sid) {
      return host.call('guide-dog/tts-token', { sessionId: sid }).then(function (r) {
        return (r && r.ok && r.token) ? r.token : ''
      }).catch(function () { return '' })
    }
    function ensureStreamCtx() {
      if (streamPlayer.audioCtx) return streamPlayer.audioCtx
      const AC = window.AudioContext || window.webkitAudioContext
      streamPlayer.audioCtx = new AC()
      return streamPlayer.audioCtx
    }
    function pcmToWav(pcm, sampleRate) {
      const n = pcm.length
      const out = new Uint8Array(44 + n)
      const dv = new DataView(out.buffer)
      const w = function (off, str) { for (let i = 0; i < str.length; i++) out[off + i] = str.charCodeAt(i) }
      w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ')
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
      dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
      w(36, 'data'); dv.setUint32(40, n, true)
      out.set(pcm, 44)
      return out
    }
    function scheduleChunk(audioCtx, wavBytes, gen) {
      return audioCtx.decodeAudioData(wavBytes.buffer.slice(0)).then(function (buf) {
        // RC13：解码代际守卫——`gen` 仅在 stopStreamPlayback 递增；句间同代际（前句尾帧
        // 解码晚于后句入链也正常续接，不按句级 playSeq 误弃），重试/打断后旧 decode 帧
        // （异步 decode）被代际守卫拒绝，不加入新链（防新旧链重叠重复播放 + 同相叠加削波）
        if (gen !== streamPlayer.gen || !streamPlayer.active) return
        const src = audioCtx.createBufferSource()
        src.buffer = buf
        const when = Math.max(audioCtx.currentTime + 0.05, streamPlayer.nextTime)
        // RC12：断链后淡入（5ms）；RC13：每帧恒接 GainNode（停播淡出需要），阈值收窄到 3ms
        // ——5-20ms 帧间隙同样淡入，消除小间隙咔哒
        const gapMs = Math.round((when - streamPlayer.nextTime) * 1000)
        const g = audioCtx.createGain()
        if (gapMs > 3) {
          g.gain.setValueAtTime(0.0001, when)
          g.gain.linearRampToValueAtTime(1, when + 0.005)
        }
        src._gdGain = g
        src.connect(g); g.connect(audioCtx.destination)
        src.start(when)
        streamPlayer.nextTime = when + buf.duration
        streamPlayer.nodes.push(src)
        gdLog('chunk when=' + when.toFixed(3) + ' now=' + audioCtx.currentTime.toFixed(3) + ' gap=' + gapMs + 'ms dur=' + buf.duration.toFixed(3) + ' nodes=' + streamPlayer.nodes.length)
        src.onended = function () {
          const i = streamPlayer.nodes.indexOf(src)
          if (i >= 0) streamPlayer.nodes.splice(i, 1)
          // C6（最终审稿）：链排空但仍有句子 fetch 在途时**不得**停 active——否则在途 fetch 的
          // `if (!streamPlayer.active)` 守卫会 abort 自己，catch 又因 active=false 跳过重连，
          // 该句被静默丢弃（如先于下一句首帧解码就排空的短句"好的/收到"）
          if (!streamPlayer.nodes.length && !streamPlayer.fetching && streamPlayer.active) {
            streamPlayer.active = false
            gdLog('chain drained -> listening')
            setCallState({ phase: 'listening' })
          }
        }
      }).catch(function (e) { gdLog('chunk DECODE-FAIL ' + String((e && e.message) || e).slice(0, 60)) })
    }
    async function playStreamEntry(entry, sid) {
      // R15 修复（Task 12 审稿）：每播一次递增 playSeq —— 旧播放的 abort rejection 不得拆掉新播放的状态
      const playId = ++streamPlayer.playSeq
      // RC14：入口埋点——按 key/text 维度记播放次数（一次复测定位双播）
      const k = entry.key || entry.text
      const c = (playCounts.get(k) || 0) + 1
      playCounts.set(k, c)
      const gen = streamPlayer.gen // RC13：解码代际（仅 stopStreamPlayback 递增；句间保持同代际，前句尾帧可续接）
      const rkey = sid + '|' + entry.text // RC13：重试记账键（(sid,text) 维度）
      // C2（最终审稿）：句间预合成——前一句仍在播放/排队（active）时**不再**停播覆盖（v2.1
      // 语义仅保留给非流条目 playEntry/playEntryConsensus）；本句流取来后解码帧追加调度到
      // 既有无缝链（scheduleChunk 按 streamPlayer.nextTime 续接），不重置 nextTime/active/phase，
      // 也不重开共识窗口（窗口只属于首句播放）。1s 轮询持续 shift 队列 → 每句首帧在上一句
      // 结束前即已解码入链，实现"当前句播放期间预取下一句"。
      // C3 修复（2026-08-16 审稿）：token 为**单次消费**（consumeTtsToken 即删）——每句都必须重新签发，
      // 不得缓存复用（旧代码 `if (!streamPlayer.token)` 只取一次 → 第二句起 403）。
      streamPlayer.token = await getTtsToken(sid)
      if (!streamPlayer.token) { setCallState({ phase: 'listening', error: '流式播放失败：无 token' }); showToast('流式播放失败：无 token'); return }
      const cfg = voiceState.cfg || {}
      const sr = ((cfg.call || {}).stream || {}).sampleRate || 24000
      const firstSentence = !streamPlayer.active // C2：仅在链空闲时走完整起播路径
      gdLog('playStreamEntry playId=' + playId + ' first=' + firstSentence + ' key=' + (entry.key || '?') + ' text=' + String(entry.text || '').slice(0, 16) + ' times=' + c)
      if (firstSentence) {
        stopCurrent() // RC9：反向防叠——起播新链时终止仍在播的 mp3（如 repeat 命令直接调用时）
        streamPlayer.active = true
        streamPlayer.nextTime = 0
        setCallState({ phase: 'speaking' })
        if (entry.consensus) notifyConsensusSpeech(true) // Task 9：共识摘要播报开窗口（仅首句）
      }
      const audioCtx = ensureStreamCtx()
      try { await audioCtx.resume() } catch (e) { /* ignore */ }
      // C6（最终审稿）：fetch 在途标志——追加句 fetch 期间即使既有链排空也不停 active；
      // finally 在 catch/重连逻辑之后清除，重连再入时看到的仍是 false
      streamPlayer.fetching = true
      let noRetry = false // RC13：429 不重试标记
      const controller = new AbortController()
      streamPlayer.controller = controller
      const url = '/guide-dog/tts-stream?token=' + encodeURIComponent(streamPlayer.token) + '&sid=' + encodeURIComponent(sid) + '&text=' + encodeURIComponent(entry.text)
      try {
        const resp = await fetch(url, { signal: controller.signal })
        gdLog('fetch status=' + resp.status + ' playId=' + playId)
        if (!resp.ok || !resp.body) { noRetry = resp.status === 429; throw new Error('http ' + resp.status) }
        const reader = resp.body.getReader()
        let acc = new Uint8Array(0)
        let totalBytes = 0
        let frameCount = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!streamPlayer.active) { try { controller.abort() } catch (e) { /* ignore */ } break }
          if (value && value.length) {
            totalBytes += value.length
            const merged = new Uint8Array(acc.length + value.length)
            merged.set(acc); merged.set(value, acc.length)
            acc = merged
            // 每 ~0.5s 音频（24000*2*0.5=24000 字节）解码一帧，保持播放间隙 <400ms
            if (acc.length >= 24000) {
              // RC12：帧长取偶（16bit WAV 数据须为偶数；奇长帧可能解码失败 → 跳块 → 间隙+爆音）
              const even = acc.length - (acc.length % 2)
              const frame = acc.subarray(0, even)
              acc = acc.subarray(even)
              const wav = pcmToWav(frame, sr)
              scheduleChunk(audioCtx, wav, gen)
              frameCount += 1
            }
          }
        }
        if (acc.length > 1) {
          const even = acc.length - (acc.length % 2)
          if (even > 0) { const wav = pcmToWav(acc.subarray(0, even), sr); scheduleChunk(audioCtx, wav, gen); frameCount += 1 }
        }
        gdLog('stream done playId=' + playId + ' bytes=' + totalBytes + ' frames=' + frameCount + ' nodes=' + streamPlayer.nodes.length)
      } catch (e) {
        // R15 修复：新播放已接管（playSeq 已递增）→ 旧 abort rejection 直接退出，不拆新播放状态
        if (playId !== streamPlayer.playSeq) return
        gdLog('stream FAIL playId=' + playId + ' active=' + streamPlayer.active + ' retried=' + retryKeys.has(rkey) + ' nodes=' + streamPlayer.nodes.length + ' err=' + String((e && e.message) || e).slice(0, 60))
        if (streamPlayer.active) {
          // RC11（V4-Pro 诊断确认）：重试前完整停链——stopStreamPlayback 内部递增 playSeq，
          // 重试以新代际起播，旧帧（含已 src.start 的）全部作废
          stopStreamPlayback()
          setCallState({ phase: 'listening', error: '播放中断' })
          // RC13：429 不重试（host 忙门，立即重试必再 429）；同 (sid,text) 5s 内至多重试一次。
          // 重试必须并入串行链——return 让 callPoll 等到重试结束（RC8）。
          if (!noRetry && !retryKeys.has(rkey)) {
            retryKeys.set(rkey, true)
            setTimeout(function () { retryKeys.delete(rkey) }, 5000)
            showToast('播放中断，已尝试重连')
            const retried = playStreamEntry({ stream: true, text: entry.text, consensus: entry.consensus }, sid)
            return retried
          } else {
            showToast('播放中断')
          }
        }
      } finally {
        // RC8：归属检查——重试已接管 controller/fetching 时，陈旧 finally 不得清除新状态
        gdLog('stream finally playId=' + playId + ' owner=' + (streamPlayer.controller === controller) + ' fetching=' + streamPlayer.fetching)
        if (streamPlayer.controller === controller) {
          streamPlayer.fetching = false // C6：在 catch/重连之后清除（重连再入时看到 false）
          streamPlayer.controller = null
        }
        if (entry.consensus) notifyConsensusSpeech(false)
      }
    }
    function stopStreamPlayback() {
      // RC13：双计数器递增——playSeq（fetch/abort 归属）与 gen（解码代际）都 +1，
      // 在途 fetch 的解码帧/abort 回调全部作废（catch 的 playId 归属检查直接退出）
      streamPlayer.playSeq += 1
      streamPlayer.gen += 1 // RC13：解码代际递增——旧 decode 帧作废（fetch 归属仍看 playSeq）
      if (streamPlayer.controller) { try { streamPlayer.controller.abort() } catch (e) { /* ignore */ } streamPlayer.controller = null }
      streamPlayer.active = false
      // RC13：淡出停播（10ms 线性落零再延时停源）——src.stop() 硬切在句切断处产生咔哒爆音
      const now = streamPlayer.audioCtx ? streamPlayer.audioCtx.currentTime : 0
      streamPlayer.nodes.forEach(function (src) {
        try {
          const g = src._gdGain
          if (g && streamPlayer.audioCtx) {
            g.gain.cancelScheduledValues(now)
            g.gain.setValueAtTime(g.gain.value || 1, now)
            g.gain.linearRampToValueAtTime(0.0001, now + 0.01)
            src.stop(now + 0.015)
          } else {
            src.stop()
          }
        } catch (e) { /* ignore */ }
      })
      streamPlayer.nodes = []
      streamPlayer.nextTime = 0
      streamPlayer.fetching = false // RC13：停播即清在途标志（C6 的"fetch 在途保 active"仅用于自然排空）
      notifyConsensusSpeech(false)
    }
    // Task 13：打断接线（spec §6.6）——Task 7 VAD 轮询在 phase==='speaking' 且发声时调用本回调
    let bargedAt = 0 // RC11：最近一次打断时刻——打断后窗口内的首个转写段路由到 agent 打断（steer），而非排队新回合
    callBargeCb = function () {
      bargedAt = Date.now()
      gdLog('BARGE')
      bargedAt = Date.now()
      // 打断（spec §6.6）：停播 + 清缓冲（abort fetch 由 stopStreamPlayback 完成）
      stopStreamPlayback()
      setCallState({ phase: 'listening' })
      // RC3：打断须清 host 待播队列——否则下个 poll tick 又 shift 出下一句，打断被队列复活
      host.call('guide-dog/call-command', { sessionId: callSid(), cmd: 'clear-queue' }).catch(function () {})
    }

    // ============ 语音命令节（Phase 2） ============
    function matchCallCommand(text) {
      const t = String(text || '').replace(/[，。！？\s]/g, '')
      const table = [
        // I5（最终审稿）：停/继续 是 host 共识确认词（CONSENT_YES_RE/NO_RE）——本地命中会吞掉
        // 用户的确认回答。暂停/恢复 与确认词无冲突，保留为命令。
        { re: /^暂停$/, cmd: 'pause' },
        { re: /^恢复$/, cmd: 'resume' },
        { re: /^(重复|再说一遍)$/, cmd: 'repeat' },
        { re: /^(慢一点|慢些)$/, cmd: 'slower' },
        { re: /^(快一点|快点)$/, cmd: 'faster' },
        { re: /^(看看屏幕|看一下屏幕)$/, cmd: 'see_screen' },
      ]
      for (const row of table) { if (row.re.test(t)) return row.cmd }
      return null
    }
    let lastSpokenSentence = null // repeat 用
    function runCallCommand(cmd) {
      switch (cmd) {
        case 'pause':
          if (streamPlayer.active) { stopStreamPlayback(); setCallState({ phase: 'listening' }) }
          // 清 host 待播队列（防停播后下一句仍到）
          host.call('guide-dog/call-command', { sessionId: callSid(), cmd: 'clear-queue' }).catch(function () {})
          break
        case 'resume':
          setCallState({ phase: 'listening' }) // 恢复=回到收听（无缓冲重播；Task 14 增强：恢复未播队列）
          break
        case 'repeat':
          if (lastSpokenSentence) { playStreamEntry({ stream: true, text: lastSpokenSentence, consensus: false }, callSid()) }
          break
        case 'slower': { const s = Math.min(1.2, callState.speed + 0.2); setCallState({ speed: s }) } break
        case 'faster': { const s = Math.max(0.8, callState.speed - 0.2); setCallState({ speed: s }) } break
        case 'see_screen': /* Phase 3 桩 */ break
        default: break
      }
    }

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

    // RC15：全局手势解锁监听（apply 时注册一次；capture 阶段捕获页面任意点击）
    bindGestureUnlock()
  },
}
