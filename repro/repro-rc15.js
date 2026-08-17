// repro-rc15.js —— RC15 断言（静态契约 + 行为）
// 运行：node repro/repro-rc15.js   （退出码 0 = 全过）
'use strict'
const fs = require('fs')
const path = require('path')
const host = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8')
let fail = 0
function ok(cond, msg) { if (cond) { console.log('PASS ' + msg) } else { fail++; console.log('FAIL ' + msg) } }
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

process.exit(fail === 0 ? 0 : 1)
