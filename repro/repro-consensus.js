// repro/repro-consensus.js：摘要生成与 consent 判定
// M9 修订（2026-08-16 审稿）：repro 用与实现完全相同的 DESTRUCTIVE_BASH_RE（实现见 Step 3），
// 避免测试与实现正则漂移。
const DESTRUCTIVE_BASH_RE = /(^|\s|\||;|&&)(rm|mv|cp|truncate|dd|mkfs|git\s+push)\b|>>?[\s\S]*$/m
function consensusSummary(name, args) {
  if (name === 'write') {
    const p = args && args.file_path ? String(args.file_path) : ''
    const content = args && args.content ? String(args.content) : ''
    return '写入文件 ' + p + '（' + content.length + ' 字符）'
  }
  if (name === 'edit') {
    const p = args && args.file_path ? String(args.file_path) : ''
    const oldS = args && args.old_string ? String(args.old_string) : ''
    return '修改文件 ' + p + '（替换 ' + oldS.length + ' 字符片段）'
  }
  if (name === 'bash') {
    const cmd = args && args.command ? String(args.command) : ''
    if (DESTRUCTIVE_BASH_RE.test(cmd)) return '执行命令：' + cmd.slice(0, 80)
    return ''
  }
  return ''
}
console.assert(consensusSummary('write', { file_path: 'README.md', content: 'abc' }) === '写入文件 README.md（3 字符）', 'FAIL: write summary')
console.assert(consensusSummary('bash', { command: 'rm -rf dist' }) !== '', 'FAIL: destructive bash detected')
console.assert(consensusSummary('bash', { command: 'ls -la' }) === '', 'FAIL: benign bash must not block')
console.assert(consensusSummary('bash', { command: 'echo "a > b"' }) !== '', 'FAIL: redirect-overwrite must block') // >>?[\s\S]*$ 对含 > 的命令保守拦截
console.log('PASS: consensus summary + destructive heuristic')
