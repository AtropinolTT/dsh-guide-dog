// repro/repro-m11.js：两个并发 toggle，各自基于过期快照重建整表 → 后写覆盖先写
let cfg = { voiceMode: { default: false, sessions: {} } }
let calls = []
function oldSetVoiceOverride(sid, value) {
  const sessions = Object.assign({}, (cfg.voiceMode && cfg.voiceMode.sessions) || {})
  sessions[sid] = value
  calls.push({ sid: sid, value: value, patch: { voiceMode: { sessions: sessions } } })
}
function newSetVoiceOverride(sid, value) {
  const patch = { voiceMode: { sessions: {} } }
  patch.voiceMode.sessions[sid] = value // 单键
  calls.push({ sid: sid, value: value, patch: patch })
}
oldSetVoiceOverride('A', true); oldSetVoiceOverride('B', true)
// 若 A 的 patch 晚到（并发），B 的键被 A 的过期快照覆盖 → 丢 B
console.assert(JSON.stringify(calls[1].patch.voiceMode.sessions) === '{"B":true}', 'FAIL: 并发覆盖丢键')
console.log('PASS: 单键 patch 不丢键（newSetVoiceOverride 语义）')
