// repro/repro-cmds.js
// I5（最终审稿）：停/继续 是 host 共识确认词（CONSENT_YES_RE/NO_RE）——必须放行到 agent；
// 命令表仅保留 暂停/恢复。
function matchCallCommand(text) {
  const t = String(text || '').replace(/[，。！？\s]/g, '')
  const table = [
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
console.assert(matchCallCommand('暂停') === 'pause', 'FAIL: pause')
console.assert(matchCallCommand('恢复') === 'resume', 'FAIL: resume')
console.assert(matchCallCommand('继续') === null, 'FAIL: 继续 must pass through (consent word)')
console.assert(matchCallCommand('停') === null, 'FAIL: 停 must pass through (consent word)')
console.assert(matchCallCommand('慢一点') === 'slower', 'FAIL: slower')
console.assert(matchCallCommand('帮我写个文件') === null, 'FAIL: non-command must pass through')
console.log('PASS: call command matching')
