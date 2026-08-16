// repro-split.js
function splitSentences(text, splitChars, maxChars) {
  if (!text) return []
  const re = new RegExp('[' + splitChars.replace(/[\\\]]/g, '\\$&') + ']', 'g')
  const out = []
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    let seg = text.slice(last, m.index + 1).trim()
    if (seg) out.push(seg)
    last = m.index + 1
  }
  const tail = text.slice(last).trim()
  if (tail) out.push(tail)
  // 超长截断
  const res = []
  for (const s of out) {
    if (s.length <= maxChars) res.push(s)
    else { for (let i = 0; i < s.length; i += maxChars) res.push(s.slice(i, i + maxChars)) }
  }
  return res
}
const parts = splitSentences('你好。世界！这是测试。', '。！？.!?\n', 200)
console.assert(parts.length === 3, 'FAIL: expected 3 sentences, got ' + parts.length)
const long = splitSentences('啊'.repeat(500) + '。', '。！？.!?\n', 200)
console.assert(long.length === 3, 'FAIL: long split, got ' + long.length)
console.log('PASS: sentence splitting + maxChars truncation')
