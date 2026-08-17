// repro/repro-cmds.js
function matchCallCommand(text) {
  const t = String(text || '').replace(/[，。！？\s]/g, '')
  const table = [
    { re: /^(停|暂停)$/, cmd: 'pause' },
    { re: /^(继续|恢复)$/, cmd: 'resume' },
    { re: /^(重复|再说一遍)$/, cmd: 'repeat' },
    { re: /^(慢一点|慢些)$/, cmd: 'slower' },
    { re: /^(快一点|快点)$/, cmd: 'faster' },
    { re: /^(看看屏幕|看一下屏幕)$/, cmd: 'see_screen' },
  ]
  for (const row of table) { if (row.re.test(t)) return row.cmd }
  return null
}
console.assert(matchCallCommand('暂停') === 'pause', 'FAIL: pause')
console.assert(matchCallCommand('继续') === 'resume', 'FAIL: resume')
console.assert(matchCallCommand('慢一点') === 'slower', 'FAIL: slower')
console.assert(matchCallCommand('帮我写个文件') === null, 'FAIL: non-command must pass through')
console.log('PASS: call command matching')
