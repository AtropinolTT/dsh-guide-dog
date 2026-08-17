// repro/repro-progress.js — RC10 播报策略回归测试：激进精简（仅播有效信息）+ 同短语冷却去重
//
// 从 plugin-host.js 提取真实实现验证（与 repro-stream-drain.js 同法）：
//   - shouldAnnounce(name, args)：write/edit/web_search/媒体工具 → 播；bash → 仅破坏性命令；
//     read/grep/glob/skill/未知工具 → 静默（不再播"正在执行操作"）
//   - progressDedupe(last, phrase, now, cooldownMs)：同短语冷却窗口内去重
// 未实现时（RC9）progressDedupe 提取失败 → 测试失败。
// 注意：不使用 'use strict'——direct eval 的函数/var 声明需泄漏到 run() 作用域供断言引用。
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8')

function run() {
  const grab = function (re, label) {
    const m = src.match(re)
    if (!m) { console.error('FAIL: 提取失败 ' + label + '（RC9 语义：无精简策略/无去重）'); process.exit(1) }
    return m[0]
  }
  // const → var：direct eval 的 var 提升到本函数作用域，后续断言可引用
  eval(grab(/const PROGRESS_SILENT = \{[^\n]*\}/, 'PROGRESS_SILENT').replace('const ', 'var '))
  eval(grab(/const PROGRESS_MEDIA = \{[^\n]*\}/, 'PROGRESS_MEDIA').replace('const ', 'var '))
  eval(grab(/const DESTRUCTIVE_BASH_RE = [^\n]*/, 'DESTRUCTIVE_BASH_RE').replace('const ', 'var '))
  eval(grab(/function shouldAnnounce[\s\S]*?\n    \}/, 'shouldAnnounce'))
  eval(grab(/function progressDedupe[\s\S]*?\n    \}/, 'progressDedupe'))

  const assert = function (cond, msg) {
    if (!cond) { console.error('FAIL: ' + msg); process.exit(1) }
    console.log('PASS: ' + msg)
  }

  // ---- 白名单：必播 ----
  assert(shouldAnnounce('write', {}) === true, 'write → 播报（正在修改文件）')
  assert(shouldAnnounce('edit', {}) === true, 'edit → 播报（正在修改文件）')
  assert(shouldAnnounce('web_search', {}) === true, 'web_search → 播报（正在搜索网页）')
  assert(shouldAnnounce('guide_dog_image', {}) === true, 'guide_dog_image → 播报（正在生成媒体）')
  assert(shouldAnnounce('guide_dog_video', {}) === true, 'guide_dog_video → 播报（正在生成媒体）')
  assert(shouldAnnounce('guide_dog_music', {}) === true, 'guide_dog_music → 播报（正在生成媒体）')
  assert(shouldAnnounce('guide_dog_speak', {}) === true, 'guide_dog_speak → 播报（正在生成媒体）')

  // ---- bash：仅破坏性（与共识拦截同口径 DESTRUCTIVE_BASH_RE）----
  assert(shouldAnnounce('bash', { command: 'rm -rf /tmp/x' }) === true, 'bash 破坏性（rm）→ 播报（正在执行命令）')
  assert(shouldAnnounce('bash', { command: 'echo hi > /tmp/a.txt' }) === true, 'bash 写入重定向 → 播报')
  assert(shouldAnnounce('bash', { command: 'cat /etc/timezone 2>/dev/null' }) === false, 'bash 只读（含 2>/dev/null）→ 静默（用户 IN/OUT 原命令）')
  assert(shouldAnnounce('bash', { command: 'ls -la' }) === false, 'bash 只读（ls）→ 静默')
  assert(shouldAnnounce('bash', {}) === false, 'bash 无命令文本 → 静默（保守）')

  // ---- 静默类 ----
  assert(shouldAnnounce('read', {}) === false, 'read → 静默')
  assert(shouldAnnounce('grep', {}) === false, 'grep → 静默')
  assert(shouldAnnounce('glob', {}) === false, 'glob → 静默')
  assert(shouldAnnounce('skill', {}) === false, 'skill → 静默')
  assert(shouldAnnounce('unknown_tool', {}) === false, '未知工具 → 静默（不再播"正在执行操作"）')

  // ---- 去重冷却 ----
  const now = 1000000
  const last = { phrase: '正在执行命令', ts: now }
  assert(progressDedupe(last, '正在执行命令', now + 1000) === true, '同短语 1s 内 → 去重跳过')
  assert(progressDedupe(last, '正在执行命令', now + 3999) === true, '同短语 3.999s 内 → 去重跳过')
  assert(progressDedupe(last, '正在执行命令', now + 5000) === false, '同短语 5s 后 → 允许再播')
  assert(progressDedupe(last, '正在修改文件', now + 1000) === false, '不同短语 → 允许播')
  assert(progressDedupe(null, '正在处理', now) === false, '无历史 → 允许播')
  console.log('ALL PASS')
  process.exit(0)
}
run()
