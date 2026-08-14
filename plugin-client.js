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

    // ============ VOICE MODE 节（Phase 1，client） ============
    const voiceState = { cfg: null, lastError: null, errorAt: 0, beepUri: null }
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
      // A2（I1）：总是写显式布尔 —— 全局默认开时也能用 false 覆盖关闭该会话
      sessions[sid] = !!v
      return host.call('guide-dog/set-config', { patch: { voiceMode: { sessions: sessions } } }).then(function (r) {
        if (r && r.ok) return loadVoiceCfg()
      }).catch(function () {})
    }
    let pendingPlay = null // {url, key}
    let pollBusy = false
    ctx.effect(function () {
      loadVoiceCfg()
      host.call('guide-dog/beep', {}).then(function (r) { if (r && r.ok) voiceState.beepUri = r.dataUri }).catch(function () {})
      return slots.inject('conversation.input.dock', function () {
        return slots.register(
          { name: 'conversation.input.dock', id: 'guide-dog-voice-mode', order: 30, label: function () { return 'Voice mode' } },
          function (props) {
            const sid = props.sessionId
            const effective = voiceEffective(sid)
            const [tick, setTick] = React.useState(0)
            React.useEffect(function () {
              if (!timerSvc || typeof timerSvc.interval !== 'function') return
              let tickCount = 0
              const stop = timerSvc.interval(function () {
                tickCount += 1
                setTick(tickCount)
                if (tickCount % 10 === 0) loadVoiceCfg() // M10：约每 10s 刷新徽章 cfg（设置页改全局默认后徽章同步）
              }, 1000)
              return function () { try { stop() } catch (e) { /* ignore */ } }
            }, [])
            React.useEffect(function () {
              // 语音模式生效时每秒轮询队列（tick 每 1s 变化触发本 effect；timerSvc.interval 不可用时不启动轮询）
              if (!effective || !sid || pollBusy) return
              pollBusy = true
              host.call('guide-dog/voice-queue', { sessionId: sid }).then(function (r) {
                if (r && r.ok && r.entry) {
                  if (r.entry.url) pendingPlay = { url: r.entry.url, key: r.entry.key }
                  else if (r.entry.error) { voiceState.lastError = r.entry.error; voiceState.errorAt = typeof Date === 'function' ? Date.now() : 1 }
                }
              }).catch(function () {}).then(function () { pollBusy = false })
            }, [effective, sid, tick])
            const now = typeof Date === 'function' ? Date.now() : 0
            const err = (voiceState.errorAt && (now - voiceState.errorAt < 8000)) ? voiceState.lastError : null
            const badge = {
              display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none',
              borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 600,
              background: effective ? 'rgba(46,204,113,.15)' : 'rgba(128,128,128,.12)',
              color: effective ? '#27ae60' : '#888',
            }
            const tone = (err && voiceState.beepUri) ? h('audio', { autoPlay: true, src: voiceState.beepUri, key: 'tone-' + voiceState.errorAt, style: { display: 'none' } }) : null
            // M6：播放结束/失败后清除 pendingPlay，避免同一条音频反复重挂
            const clearPlay = function () { pendingPlay = null; setTick(Date.now() % 100000) }
            const player = pendingPlay ? h('audio', { autoPlay: true, src: pendingPlay.url, key: pendingPlay.key, onEnded: clearPlay, onError: clearPlay, style: { display: 'none' } }) : null
            return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' } },
              h('span', { style: badge, onClick: function () { setVoiceOverride(sid, !effective) } },
                effective ? '🔊 语音模式开' : '🔇 语音模式关'),
              err ? h('span', { style: { color: '#c0392b', fontSize: 12 } }, '朗读失败：' + err) : null,
              tone, player)
          })
      })
    })

    // ============ MIC INPUT 节（Phase 1） ============
    // 探测结论（Task 4 Step 7）：
    // - 录音路径 = Path A（navigator.mediaDevices / MediaRecorder / Blob / btoa / Blob.prototype.arrayBuffer 全部可用）
    // - CLIENT_BASE64 = ok（btoa 为 function）
    // - inputActions 实际方法 = ["setDraft","addImages","removeImage","pruneImages","submit"]；插入主选 = setDraft，提交主选 = submit
    //   （下方候选链是兜底；若链全部未命中必须显示 insert_failed，不得静默）
    let micRec = null // {rec, stream}
    let micChunks = []
    let micSeconds = 0
    let micLang = 'auto' // M4：模块级语言选择 —— 录音中切换语言立即生效（transcribe 不再依赖渲染闭包 s.lang）
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
    ctx.effect(function () {
      return slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'guide-dog-mic', order: 30, label: function () { return 'Voice input' } },
          function (props) {
            const sid = props.sessionId
            const state = React.useState({ phase: 0, seconds: 0, lang: 'auto', error: null }) // 0 idle / 1 recording / 2 transcribing
            const s = state[0]; const set = state[1]
            React.useEffect(function () {
              // A3（I2）：组件卸载/插件停止时停止录音器与麦克风流，防隐私泄漏
              return function () {
                if (micRec) {
                  try { micRec.rec.stop() } catch (e) { /* ignore */ }
                  try { micRec.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ }
                  micRec = null
                }
              }
            }, [])
            if (windowCannotRecord()) {
              return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('a', { href: '/guide-dog/recorder', target: '_blank', style: { fontSize: 12, color: '#4a7dff', whiteSpace: 'nowrap' } }, '🎙 打开录音页'),
                h('span', { style: { color: '#888', fontSize: 11 } }, '浏览器沙箱限制，录音需在独立页面进行'))
            }
            const startRec = function () {
              try {
                navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
                  let rec = null
                  try { rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }) } catch (e) { rec = new MediaRecorder(stream) }
                  micChunks = []; micSeconds = 0
                  rec.ondataavailable = function (ev) {
                    if (ev.data && ev.data.size > 0) micChunks.push(ev.data)
                    micSeconds += 1
                    // 秒数进 state 触发重渲染（审查 M9）；maxSeconds 强制停止
                    set(function (prev) { return Object.assign({}, prev, { seconds: micSeconds }) })
                    const max = (voiceState.cfg && voiceState.cfg.voiceInput && voiceState.cfg.voiceInput.maxSeconds) || 60
                    if (micSeconds >= max && rec.state === 'recording') { try { rec.stop() } catch (e) { /* ignore */ } }
                  }
                  rec.onstop = function () { transcribe(set, s, sid, props.inputActions) }
                  rec.start(1000)
                  micRec = { rec: rec, stream: stream }
                  set(Object.assign({}, s, { phase: 1, seconds: 0, error: null }))
                }).catch(function (err) {
                  // M4：区分"无设备"与"权限拒绝"
                  const name = err && err.name
                  set(Object.assign({}, s, { error: (name === 'NotFoundError' || name === 'OverconstrainedError') ? 'no_device' : 'mic_denied' }))
                })
              } catch (e) { set(Object.assign({}, s, { error: 'mic_denied' })) }
            }
            const toggle = function () {
              if (s.phase === 1) {
                const r = micRec
                micRec = null
                if (r) { try { r.rec.stop() } catch (e) { /* ignore */ } try { r.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ } }
                return
              }
              if (s.phase === 2) return
              startRec()
            }
            const cycLang = function () {
              const order = ['auto', 'zh', 'en']
              const i = order.indexOf(micLang)
              micLang = order[(i + 1) % order.length] // M4：同步写模块级，录音中切换也生效
              set(Object.assign({}, s, { lang: micLang }))
            }
            const micStyle = {
              border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, lineHeight: 1,
              color: s.phase === 1 ? '#e74c3c' : '#888', borderRadius: 6, padding: 4,
            }
            const errText = {
              mic_denied: '麦克风权限被拒绝', no_device: '未检测到麦克风设备', empty_speech: '没听清，请再说一次',
              stt_failed: '转写失败', stt_timeout: '转写超时', engine_unavailable: 'STT 引擎不可用（见设置页）',
              insert_failed: '无法插入输入框（输入框接口不可用）',
            }[s.error] || (s.error ? '转写失败（' + s.error + '）' : null) // M9：未知错误码不静默
            return h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' } },
              h('button', { onClick: toggle, title: s.phase === 1 ? '停止录音' : '语音输入', style: micStyle },
                s.phase === 1 ? '⏺' : (s.phase === 2 ? '⏳' : '🎙')),
              s.phase === 1 ? h('span', { style: { fontSize: 11, color: '#e74c3c' } }, s.seconds + 's') : null,
              h('button', { onClick: cycLang, title: '识别语言：' + s.lang, style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, color: '#888', padding: 2 } },
                { auto: 'AUTO', zh: '中', en: 'EN' }[s.lang]),
              errText ? h('span', { style: { fontSize: 11, color: '#c0392b' } }, errText) : null)
          })
      })
    })
    function transcribe(set, s, sid, inputActions) {
      const parts = micChunks
      micChunks = []
      if (!parts.length) { set(Object.assign({}, s, { phase: 0, error: 'empty_speech' })); return }
      try {
        const blob = new Blob(parts, { type: 'audio/webm' })
        blob.arrayBuffer().then(function (buf) {
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          set(Object.assign({}, s, { phase: 2, error: null }))
          return host.call('guide-dog/transcribe', { audioB64: btoa(bin), mime: 'audio/webm', sessionId: sid, language: micLang })
        }).then(function (r) {
          if (r && r.ok && r.text) {
            const inserted = insertText(inputActions, r.text)
            set(Object.assign({}, s, { phase: 0, error: inserted ? null : 'insert_failed' }))
            if (inserted && voiceState.cfg && voiceState.cfg.voiceInput && voiceState.cfg.voiceInput.autoSend) submitInput(inputActions)
          } else {
            set(Object.assign({}, s, { phase: 0, error: (r && r.error) || 'stt_failed' }))
          }
        }).catch(function () { set(Object.assign({}, s, { phase: 0, error: 'stt_failed' })) })
      } catch (e) { set(Object.assign({}, s, { phase: 0, error: 'stt_failed' })) }
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
        // A1：函数式 updater —— 5 个异步结果各自合并，避免基于初始闭包 s 的 last-wins 全量覆盖
        host.call('guide-dog/auth-status', {}).then(function (r) { if (alive) set(function (prev) { return Object.assign({}, prev, { auth: r }) }) }).catch(function () {})
        host.call('guide-dog/voices', {}).then(function (r) { if (alive && r && r.ok && Array.isArray(r.voices)) set(function (prev) { return Object.assign({}, prev, { voices: r.voices }) }) }).catch(function () {})
        host.call('guide-dog/list-media', { limit: 30 }).then(function (r) { if (alive && Array.isArray(r)) set(function (prev) { return Object.assign({}, prev, { media: r }) }) }).catch(function () {})
        host.call('guide-dog/get-config', {}).then(function (r) { if (alive && r && r.ok) set(function (prev) { return Object.assign({}, prev, { cfg: r.config }) }) }).catch(function () {})
        host.call('guide-dog/status', {}).then(function (r) { if (alive && r && r.ok) set(function (prev) { return Object.assign({}, prev, { status: r.status }) }) }).catch(function () {})
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
      const reloadCfg = function () {
        host.call('guide-dog/get-config', {}).then(function (r) { if (r && r.ok) set(Object.assign({}, s, { cfg: r.config })) }).catch(function () {})
      }
      const setCfg = function (patch) {
        host.call('guide-dog/set-config', { patch: patch }).then(function (r) { if (r && r.ok) reloadCfg() }).catch(function () {})
      }
      const cfgBlock = s.cfg ? h('div', { style: preStyle }, [
        h('div', { style: rowStyle },
          h('span', { style: badgeStyle }, '语音模式'),
          h('label', null, h('input', { type: 'radio', name: 'vm-global', checked: !!s.cfg.voiceMode.default, onChange: function () { setCfg({ voiceMode: { default: true } }) } }), ' 全局默认开'),
          h('label', null, h('input', { type: 'radio', name: 'vm-global', checked: !s.cfg.voiceMode.default, onChange: function () { setCfg({ voiceMode: { default: false } }) } }), ' 全局默认关')),
        h('div', { style: mutedStyle }, '会话 override：输入框上方徽章点击切换（当前会话生效值以徽章为准）。'),
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
