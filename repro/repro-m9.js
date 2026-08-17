// repro-m9.js — 技术债 M9：录音 onstop 陈旧闭包（会话切换后仍提交旧会话）
// 场景：会话 A 开始录音 → 切到会话 B（卸载 A 的组件）→ 录音 stop → 不得调用 transcribe
//
// 说明（与 brief 的差异，理由见 task-0-report.md）：
// 1. plugin-client.js 是 Cordis 插件（顶层 return，无法 require），故本脚本用「源码锚点 +
//    闭包行为模拟」双保险：锚点断言真实源码已含 M9 机制（修复前缺失 → 本脚本失败，修复后通过）。
// 2. brief 原稿在 fakeUnmount() 置 micRec=null 后执行 micRec.rec.stop() → 必然 TypeError（真实
//    代码是卸载清理里先 rec.stop() 后置 micRec=null，且 MediaRecorder.stop() 异步派发 onstop），
//    本脚本先取 recorder 句柄再卸载，忠实模拟真实时序。
// 3. 守卫不含 micRec 判空：正常停止路径（toggleMic）也先置 micRec=null 再 stop，按 micRec 判空
//    会把正常提交也丢弃；真实修复以 recSessionRef.alive / sid 作为归属判据。
'use strict'
const fs = require('fs')
const path = require('path')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin-client.js'), 'utf8')
let failed = false
function check(cond, msg) { if (!cond) { failed = true; console.error('Assertion failed: ' + msg) } }

// ---- 结构锚点：真实源码必须含 M9 机制（录音归属声明 + 启动时赋值 + onstop 校验 + 卸载置死） ----
check(SRC.indexOf('let recSessionRef = null') >= 0, 'FAIL: plugin-client.js 缺少 recSessionRef 录音归属声明')
check(SRC.indexOf('recSessionRef = { sid: sid, alive: true }') >= 0, 'FAIL: plugin-client.js startRec 未在启动时设置录音归属')
check(SRC.indexOf('!recSessionRef.alive') >= 0 && SRC.indexOf('recSessionRef.sid !== sid') >= 0,
  'FAIL: plugin-client.js onstop 缺少录音归属校验（alive / sid）')
check(SRC.indexOf('recSessionRef.alive = false') >= 0, 'FAIL: plugin-client.js 卸载清理未置 alive=false')

// ---- 行为模拟：镜像 onstop 闭包结构（守卫与真实修复一致） ----
let transcribeCalls = []
let micRec = null
let recSessionRef = null // 修复后：录音归属
function fakeStart(sid, onstop) {
  recSessionRef = { sid: sid, alive: true }
  micRec = { rec: { stop: function () { onstop() } } }
}
function fakeUnmount() { micRec = null; if (recSessionRef) recSessionRef.alive = false }
function fixedOnstop(sid, inputActions) {
  if (!recSessionRef || recSessionRef.sid !== sid || !recSessionRef.alive) return // 丢弃陈旧提交
  transcribeCalls.push(sid)
}

// 场景 1（M9）：会话 A 录音中 → 卸载（切到会话 B）→ stop → 不得提交
fakeStart('A', function () { fixedOnstop('A', {}) })
const recA = micRec.rec // 真实 MediaRecorder.stop() 异步触发 onstop：先取句柄，卸载后再 stop
fakeUnmount()
recA.stop() // 卸载后 stop 触发
check(transcribeCalls.length === 0, 'FAIL: 陈旧闭包仍提交')

// 场景 2（回归防护）：正常停止（无会话切换）→ 仍须提交；正常路径 toggleMic 也是先置 micRec=null 再 stop
transcribeCalls = []; micRec = null; recSessionRef = null
fakeStart('B', function () { fixedOnstop('B', {}) })
const recB = micRec.rec
micRec = null // 模拟 toggleMic：正常停止先置 null 再 stop
recB.stop()
check(transcribeCalls.length === 1 && transcribeCalls[0] === 'B', 'FAIL: 正常停止被丢弃')

// 场景 3（跨会话迟到）：旧录音 stop 在会话 C 新录音开始后才触发 → 按 sid 不匹配丢弃
transcribeCalls = []; micRec = null; recSessionRef = null
fakeStart('A2', function () { fixedOnstop('A2', {}) })
const recOld = micRec.rec
fakeStart('C', function () { fixedOnstop('C', {}) }) // 会话 C 新录音开始，归属改写为 C
recOld.stop() // 旧录音 stop 迟到
check(transcribeCalls.length === 0, 'FAIL: 跨会话迟到 stop 仍提交')

if (failed) { console.error('RESULT: FAIL'); process.exit(1) }
console.log('PASS: 卸载后丢弃')
