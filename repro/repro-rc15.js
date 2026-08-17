// repro-rc15.js —— RC15 断言（静态契约 + 行为）
// 运行：node repro/repro-rc15.js   （退出码 0 = 全过）
'use strict'
const fs = require('fs')
const path = require('path')
const host = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8')
const client = fs.readFileSync(path.join(__dirname, '..', 'plugin-client.js'), 'utf8')
let fail = 0
function ok(cond, msg) { if (cond) { console.log('PASS ' + msg) } else { fail++; console.log('FAIL ' + msg) } }
function count(hay, needle) { return hay.split(needle).length - 1 }
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) return null
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  return null
}

// ---- 静态契约（Task 1：回队 RPC） ----
ok(host.includes("harness.handle('guide-dog/voice-requeue'"), 'host RPC voice-requeue')
ok(host.includes('function requeueEntry('), 'host requeueEntry pure fn')
ok(host.includes("'[gd-host] requeue sid='"), 'host requeue log')

// ---- 行为（Task 1：回队去重 + 截尾） ----
const requeueSrc = extractFn(host, 'requeueEntry')
ok(!!requeueSrc, 'extract requeueEntry')
if (requeueSrc) {
  const requeueEntry = new Function('return ' + requeueSrc)()
  const r1 = requeueEntry([], { key: 'a', url: 'u1' }, 40)
  ok(r1.q.length === 1 && r1.dup === false, 'requeue insert new')
  const r2 = requeueEntry(r1.q, { key: 'a', url: 'u1' }, 40)
  ok(r2.q.length === 1 && r2.dup === true, 'requeue dup skipped')
  const r3 = requeueEntry([{ key: 'x' }, { key: 'y' }], { key: 'z' }, 2)
  ok(r3.q.length === 2 && r3.q[0].key === 'z' && r3.q[2] === undefined, 'requeue tail pop')
}

// ---- 静态契约（Task 2：持久播放器） ----
ok(client.includes('function playVoiceEntry('), 'client playVoiceEntry')
ok(client.includes('function unlockVoiceAudio('), 'client unlockVoiceAudio')
ok(client.includes('function bindGestureUnlock('), 'client bindGestureUnlock')
ok(client.includes("['click', 'keydown', 'touchstart']"), 'client gesture events')
ok(client.includes('window.addEventListener(ev, unlockVoiceAudio, true)'), 'client gesture capture bind')
ok(client.includes('URL.createObjectURL(blob)'), 'client blob object url')
ok(client.includes('voicePlayer.attempts'), 'client attempts map')
ok(client.includes('attempts > 3'), 'client attempt cap 3')
ok(client.includes("'guide-dog/voice-requeue'"), 'client requeue rpc')
ok(client.includes('waitStreamDrain()'), 'client drain wait')
ok(client.includes('voice play key='), 'client voice play count log')
ok(client.includes('playVoiceEntry(r.entry, sid)'), 'client poll voice entry')
ok(client.includes('pending: []'), 'client pending fifo init')
ok(client.includes('voicePlayer.pending.push'), 'client pending stash push')
ok(client.includes('voicePlayer.pending.shift'), 'client pending drain shift')
ok(client.includes('voicePlayer.current && a && a.src && a.paused'), 'client resume loaded only')
ok(count(client, 'function playEntry(') === 0, 'client playEntry removed')
ok(count(client, 'function playEntryNow(') === 0, 'client playEntryNow removed')
ok(count(client, 'new Audio(String(url))') === 1, 'client per-entry Audio only in playEntryConsensus')

// ---- 静态契约（Task 2 F1：stopCurrent 中断释放 busy 并回队） ----
ok(client.includes('requeueVoiceEntry(cur.entry, cur.sid)'), 'client stop requeue current')
ok(client.includes('requeueVoiceEntry(pend[i].entry, pend[i].sid)'), 'client stop requeue all pending')

// ---- 静态契约（Task 3：去重） ----
ok(host.includes('function replayDup('), 'host replayDup pure fn')
ok(host.includes('const lastStreamText = new Map()'), 'host lastStreamText map')
ok(host.includes('const lastVoiceText = new Map()'), 'host lastVoiceText map')
ok(host.includes("'[gd-host] skip replay text='"), 'host replay skip log')
ok(host.includes("'[gd-host] skip voice-dup text='"), 'host voice-dup skip log')
ok(host.includes('lastStreamText.set(sid, { text: pc, at: now3 })'), 'host replay window set')
ok(host.includes('lastVoiceText.set(sid, { text: clean, at: now4 })'), 'host voice-dup window set')

// ---- 行为（Task 3：窗口去重判定） ----
const replaySrc = extractFn(host, 'replayDup')
ok(!!replaySrc, 'extract replayDup')
if (replaySrc) {
  const replayDup = new Function('return ' + replaySrc)()
  ok(replayDup(null, 'x', 0, 10000) === false, 'replayDup no prev')
  ok(replayDup({ text: 'x', at: 0 }, 'x', 5000, 10000) === true, 'replayDup same within window')
  ok(replayDup({ text: 'x', at: 0 }, 'x', 15000, 10000) === false, 'replayDup same after window')
  ok(replayDup({ text: 'y', at: 0 }, 'x', 5000, 10000) === false, 'replayDup different text')
}

// ---- 静态契约（RC16：通话输入遵循同一设备设置） ----
ok(count(client, 'getUserMedia(micAudioReq())') === 2, 'voice + call share mic constraint')
ok(count(client, 'getUserMedia({ audio: true })') === 0, 'no hardcoded audio-only gUM')

// ---- 静态契约（RC17：回声拒收/回声尾抑制/回声地板） ----
ok(host.includes('const lastAgentSpeech = new Map()'), 'host echo speech buffer')
ok(host.includes('function pushAgentSpeech('), 'host push agent speech')
ok(host.includes('function echoMatch('), 'host echoMatch pure fn')
ok(host.includes('function echoGuard('), 'host echo guard fn')
ok(host.includes("'echo_reject'"), 'host echo reject code')
ok(host.includes("'[gd-host] echo_reject sid='"), 'host echo reject log')
ok(client.includes('playbackEndedAt'), 'client echo tail window')
ok(client.includes('echoFloor'), 'client echo floor')
ok(client.includes('callVoiced'), 'client voiced flag')
ok(client.includes('!echoFloor'), 'client barge-in echo guard')
ok(client.includes('> echoTailMs'), 'client echo tail gate')
ok(client.includes("r.error === 'echo_reject'"), 'client echo reject silent')
ok(client.includes('segment echo_reject'), 'client echo reject log')

// ---- 行为（RC17：回声匹配判定） ----
const echoSrc = extractFn(host, 'echoMatch')
ok(!!echoSrc, 'extract echoMatch')
if (echoSrc) {
  const echoMatch = new Function('return ' + echoSrc)()
  ok(echoMatch('', []) === false, 'echoMatch empty')
  ok(echoMatch('abcdef', []) === false, 'echoMatch no recent')
  ok(echoMatch('abc', [{ t: 'xyz', at: 0 }]) === false, 'echoMatch short no hit')
  ok(echoMatch('今天天气不错', [{ t: '今天天气不错', at: 0 }]) === true, 'echoMatch exact')
  ok(echoMatch('abcdef', [{ t: 'xxabcdefyy', at: 0 }]) === true, 'echoMatch contain >=6')
  ok(echoMatch('天气不错', [{ t: '今天天气不错', at: 0 }]) === false, 'echoMatch short contain no hit')
}

// ---- 静态契约（RC17-F：缓冲补全 + 起播作废段 + 窗口诊断） ----
ok(host.includes("pushAgentSpeech(String(sid), clean, Date.now())"), 'host progress echo buffer')
ok(host.includes("pushAgentSpeech(String(sid), '仍在处理，请稍候', Date.now())"), 'host hb echo buffer')
ok(host.includes("pushAgentSpeech(String(sid), text, Date.now())"), 'host consensus echo buffer')
ok(client.includes('RC17-F：起播瞬间若有活动段'), 'client abort segment at speak start')
ok(client.includes('windowLogged'), 'client echo window diag')

// ---- 行为（RC17-F：模糊匹配） ----
if (echoSrc) {
  const echoMatch = new Function('return ' + echoSrc)()
  ok(echoMatch('原码变更正在处理', [{ t: '源码变更正在处理中，请稍候', at: 0 }]) === true, 'echoMatch fuzzy bigram')
  ok(echoMatch('今天上海有雨明天放晴', [{ t: '明天北京下雪', at: 0 }]) === false, 'echoMatch different text no hit')
}

// ---- 静态契约（RC18：流播放 HTMLAudio 直出——RDP/Chrome 环境 WebAudio AudioContext 输出无声） ----
ok(client.includes('client build rc18-20260817'), 'client build tag rc18')
ok(client.includes('function ensureStreamAudio('), 'client stream audio element')
ok(client.includes('function playStreamWav('), 'client stream wav player')
ok(client.includes('function waitStreamFree('), 'client stream serial wait')
ok(client.includes('function settleStreamWaiters('), 'client stream waiter settle')
ok(client.includes('streamAudio play playId='), 'client stream audio play log')
ok(client.includes('streamAudio block playId='), 'client stream audio block log')
ok(client.includes("err.name === 'NotAllowedError'"), 'client autoplay block detection')
ok(client.includes('streamAudio play-err playId='), 'client play non-block error log')
ok(client.includes('function handleStreamAudioError('), 'client stream error handler')
ok(client.includes('Date.now() >= limit'), 'client stream wait timeout')
ok(client.includes('playId === streamPlayer.playSeq) notifyConsensusSpeech(false)'), 'client consensus close ownership guard')
ok(client.includes("type: 'audio/wav'"), 'client wav blob type')
ok(client.includes('chain drained -> listening'), 'client chain drain log')
ok(client.includes('audio outputs '), 'client output device diag')
ok(count(client, 'createBufferSource(') === 0, 'client webaudio source removed')
ok(count(client, 'decodeAudioData(') === 0, 'client webaudio decode removed')
ok(count(client, 'scheduleChunk(') === 0, 'client scheduleChunk removed')
ok(client.includes('streamAudio.el.src && streamAudio.el.paused'), 'client gesture resume stream')

// ---- 静态契约（RC18：agent 不得自调音频技能——语音由插件自动播报） ----
ok(host.includes('调用 audio-conversation、speech-mmx、mmx'), 'host voice auto guidance')

process.exit(fail === 0 ? 0 : 1)
