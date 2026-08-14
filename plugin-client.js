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
