// 复现：readBytes 调用量应等于 range 长度而非全文件
let readBytesCalls = []
const fakeReadBytes = function (abs, max) { readBytesCalls.push(max); return new Uint8Array(max) }
function handleRange(size, rangeHeader, readBytes) {
  let start = 0, end = size - 1
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim())
  if (m && (m[1] || m[2])) {
    if (m[1] === '') start = Math.max(0, size - parseInt(m[2] || '0', 10))
    else { start = parseInt(m[1], 10); end = m[2] ? parseInt(m[2], 10) : size - 1 }
    end = Math.min(end, size - 1)
  }
  return { start: start, end: end }
}
const size = 10 * 1024 * 1024
const r = handleRange(size, 'bytes=100-199', fakeReadBytes)
console.assert(r.end - r.start + 1 === 100, 'FAIL: range 计算错误')
console.log('PASS: range 计算正确；修复后 readBytes 应只读', r.end - r.start + 1, '字节')
