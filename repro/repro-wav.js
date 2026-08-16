// repro/repro-wav.js：PCM s16le → WAV（44 字节头 + 数据）
function pcmToWav(pcm, sampleRate) {
  const n = pcm.length
  const out = new Uint8Array(44 + n)
  const dv = new DataView(out.buffer)
  const w = function (off, str) { for (let i = 0; i < str.length; i++) out[off + i] = str.charCodeAt(i) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  w(36, 'data'); dv.setUint32(40, n, true)
  out.set(pcm, 44)
  return out
}
const pcm = new Uint8Array([0x00, 0x00, 0xFF, 0x7F, 0x00, 0x80])
const wav = pcmToWav(pcm, 24000)
console.assert(wav.length === 44 + 6, 'FAIL: wav length')
console.assert(String.fromCharCode.apply(null, wav.subarray(0, 4)) === 'RIFF', 'FAIL: RIFF header')
console.assert(new DataView(wav.buffer).getUint32(24, true) === 24000, 'FAIL: sample rate')
console.log('PASS: PCM→WAV wrapper (24kHz s16le mono)')
