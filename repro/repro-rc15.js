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
ok(client.includes("else if (r && r.ok && !r.entry) {"), 'client poll summary branch')
ok(count(client, 'function playEntry(') === 0, 'client playEntry removed')
ok(count(client, 'function playEntryNow(') === 0, 'client playEntryNow removed')
ok(count(client, 'new Audio(String(url))') === 1, 'client per-entry Audio only in playEntryConsensus')

process.exit(fail === 0 ? 0 : 1)
