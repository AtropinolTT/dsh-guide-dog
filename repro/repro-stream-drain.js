// repro-stream-drain.js — RC9 回归测试：mp3 条目（进度播报）不得与仍在播放的流句子重叠
//
// 背景（RC9 根因）：playStreamEntry 在 fetch 结束即 resolve（C2 预取语义），其调度到
// WebAudio 链上的音频仍在播放。callPoll 随后消费下一条 mp3（进度播报）时若直接开播，
// 播报与仍响的句子叠加 → "同时播放多条语音" + 爆音（用户 2026-08-17 11:43 复测）。
//
// 本测试从 plugin-client.js 提取真实 waitStreamDrain 实现并模拟 callPoll 消费语义：
//   - 流条目：fetch 结束 resolve，音频继续（节点在音频结束后移除）
//   - mp3 条目：必须等待流链排空后才开播
// 断言：
//   A) [流句子, mp3]：mp3 开播时间 >= 流句子音频结束时间（不重叠）
//   B) [流句子1, 流句子2]：句 2 的 fetch 在句 1 仍在播时启动（预取/无缝链保留）
// 未实现 waitStreamDrain 时（RC8）提取失败 → 测试失败。
'use strict'
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'plugin-client.js'), 'utf8')
const fnMatch = src.match(/function waitStreamDrain[\s\S]*?\n    \}/)
if (!fnMatch) {
  console.error('FAIL: plugin-client.js 未实现 waitStreamDrain（RC8 语义：mp3 直接开播，与流链重叠）')
  process.exit(1)
}

// ---- 模拟环境 ----
function run() {
  const streamPlayer = { active: false, nodes: [], fetching: false }
  // 直接 eval：waitStreamDrain 闭包引用同作用域 streamPlayer
  const waitStreamDrain = eval('(' + fnMatch[0] + ')')

  // 模拟 playStreamEntry：fetch 耗时 fetchMs 后 resolve；音频共 audioMs，结束后移除节点
  function playStreamEntryMock(entry) {
    const audioMs = entry.audioMs, fetchMs = entry.fetchMs
    streamPlayer.fetching = true
    if (!streamPlayer.active) streamPlayer.active = true // firstSentence
    const node = { id: entry.text }
    streamPlayer.nodes.push(node)
    return new Promise(function (resolve) {
      setTimeout(function () {
        streamPlayer.fetching = false
        setTimeout(function () {
          const i = streamPlayer.nodes.indexOf(node)
          if (i >= 0) streamPlayer.nodes.splice(i, 1)
          if (!streamPlayer.nodes.length && !streamPlayer.fetching && streamPlayer.active) streamPlayer.active = false
        }, Math.max(0, audioMs - fetchMs))
        resolve() // RC8/RC9 语义：fetch 结束即 resolve（音频继续）
      }, fetchMs)
    })
  }

  // 模拟 callPoll：逐条消费，await 播放承诺；mp3 条目先等流链排空
  function runScenario(queue) {
    const t0 = Date.now()
    const events = { mp3Starts: [], s2FetchStarts: [] }
    const callPoll = function () {
      return new Promise(function (resolveConsumer) {
        const step = function () {
          if (!queue.length) { resolveConsumer(); return }
          const entry = queue.shift()
          if (entry.stream) {
            if (entry.text === 's2') events.s2FetchStarts.push(Date.now() - t0)
            return playStreamEntryMock(entry).then(function () {
              if (queue.length) return step() // consumed → 立即续取
            })
          }
          return waitStreamDrain().then(function () {
            events.mp3Starts.push(Date.now() - t0)
            return new Promise(function (res) { setTimeout(res, entry.playMs) })
          })
        }
        step().then(resolveConsumer)
      })
    }
    return callPoll().then(function () { return events })
  }

  return runScenario([
    { stream: true, text: 's1', audioMs: 2000, fetchMs: 400 },
    { url: 'progress.mp3', playMs: 500 },
  ]).then(function (ev) {
    const mp3At = ev.mp3Starts[0]
    console.log('[A] mp3 开播时刻 =', mp3At, 'ms（s1 音频结束 = 2000ms）')
    if (mp3At === undefined || mp3At < 1990) {
      console.error('FAIL[A]: mp3 在流句子仍播放时开播（重叠 = 同时播放多条语音 + 爆音）')
      process.exit(1)
    }
    console.log('PASS[A]: mp3 等待流链排空后才开播')
    return runScenario([
      { stream: true, text: 's1', audioMs: 2000, fetchMs: 400 },
      { stream: true, text: 's2', audioMs: 1500, fetchMs: 400 },
    ])
  }).then(function (ev) {
    const s2At = ev.s2FetchStarts[0]
    console.log('[B] s2 fetch 启动时刻 =', s2At, 'ms（s1 仍在播放至 2000ms）')
    if (s2At === undefined || s2At >= 1990) {
      console.error('FAIL[B]: 句间预取丢失（s2 等到 s1 播完才 fetch → 句间断流）')
      process.exit(1)
    }
    console.log('PASS[B]: 句间预取保留（s2 在 s1 播放期间 fetch，链无缝续接）')
    console.log('ALL PASS')
    process.exit(0)
  })
}
run()
