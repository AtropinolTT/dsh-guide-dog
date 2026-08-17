// repro/repro-rc13.js — RC13 回归测试（三路 V4-Pro 评审定案，2026-08-17）：
//   1. 转写会话绑定：通话归属（sid + inputActions）在 startCall 捕获，渲染期不再写全局
//   2. host 只播回合最终消息（带 tool-call 的中间消息跳过；turn/end 兜底）
//   3. 双通道互斥（playOnHost 已播文本不再经队列通道重播）
//   4. client 播放管线：代际守卫 + 淡出停播 + 淡入阈值 + 按 (sid,text) 重试记账 + 429 不重试
// 静态契约检查（与 repro-rc11.js 同风格）；任一缺失 → FAIL。
'use strict'
const fs = require('fs')
const path = require('path')
const srcC = fs.readFileSync(path.join(__dirname, '..', 'plugin-client.js'), 'utf8')
const srcH = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8')

let failed = 0
function check(cond, label) {
  if (cond) console.log('PASS: ' + label)
  else { console.error('FAIL: ' + label); failed += 1 }
}

// ---- 1. 转写会话绑定（Task 1） ----
{
  check(/let callSessionRef = null/.test(srcC), 'client: 通话归属 callSessionRef（startCall 捕获）')
  check(/function callSid\(\)/.test(srcC), 'client: callSid() helper')
  check(/function callActions\(\)/.test(srcC), 'client: callActions() helper')
  check(!/gdInputActions/.test(srcC), 'client: gdInputActions 模块级全局已移除（渲染期覆盖源）')
  check(!/callSessionId/.test(srcC), 'client: callSessionId 全局已整体移除（无渲染期覆盖）')
  check(/function startCall\(sid, inputActions\)/.test(srcC), 'client: startCall 接收 inputActions')
  check(/callSessionRef = \{ sid: String\(sid \|\| ''\), actions: inputActions \|\| null \}/.test(srcC), 'client: startCall 捕获归属（sid+actions）')
  check(/const myCall = callState\.active && callSessionRef && callSessionRef\.sid === sid/.test(srcC), 'client: 按钮激活态按归属会话判定')
  check(/if \(callState\.active && callSessionRef\) stopCall\(\)/.test(srcC), 'client: 切会话开新通话先挂断（仅点击时，非渲染期）')
  check(/sessionId: callSid\(\)/.test(srcC), 'client: 上行 RPC/轮询使用 callSid()')
  check(/const sid = callSid\(\)/.test(srcC), 'client: uploadSegmentBlob 使用 callSid()')
  check(/const actions = callActions\(\)/.test(srcC), 'client: 提交回退使用 callActions()')
}

// ---- 2. 只播回合最终消息（Task 2，host） ----
{
  const toolCallSkips = (srcH.match(/type === 'tool-call'/g) || []).length
  check(toolCallSkips >= 2, 'host: 下行 + 语音模式两个监听都跳过带 tool-call 的中间消息')
  check(/pendingFinal/.test(srcH), 'host: pendingFinal 缓冲中间文本（turn/end 兜底用）')
  check(/'turn\/end'/.test(srcH), 'host: turn/end 兜底监听存在')
  // RC14-T3 重命名：[gd-host] turn-end flush → enqueue from=turnend（带源标签更清晰）
  check(/enqueue from=turnend/.test(srcH), 'host: turn/end 兜底入队（终结工具回合不静音）')
}

// ---- 3. 双通道互斥（Task 3，host） ----
{
  check(/function markHostSpoken/.test(srcH), 'host: markHostSpoken 存在')
  check(/function wasHostSpoken/.test(srcH), 'host: wasHostSpoken 存在（消费即删）')
  check(/markHostSpoken\(sid, transformed\)/.test(srcH), 'host: playOnHost 成功后标记文本')
  // RC14-T1/T3：wasHostSpoken 改为按净化后文本匹配（downlink/turn-end/voice-mode 三处）
  const w = (srcH.match(/wasHostSpoken\(sid, sanitizeSpeechText\(/g) || []).length
  check(w >= 2, 'host: 下行 + 语音模式（或 turn-end）两个监听按净化后文本匹配本机已播')
}

// ---- 4. 播放管线爆音（Task 4，client） ----
{
  check(/function scheduleChunk\(audioCtx, wavBytes, gen\)/.test(srcC), 'client: scheduleChunk 带 gen 代际参数')
  check(/gen !== streamPlayer\.gen \|\| !streamPlayer\.active/.test(srcC), 'client: 解码帧代际守卫（旧 fetch 帧不加入新链）')
  check(/const gen = streamPlayer\.gen/.test(srcC), 'client: playStreamEntry 捕获解码代际 gen')
  check(/src\._gdGain = g/.test(srcC), 'client: 每帧恒接 GainNode（停播淡出需要）')
  check(/gapMs > 3/.test(srcC), 'client: 淡入阈值收窄到 3ms')
  const m = srcC.match(/function stopStreamPlayback\(\) \{[\s\S]*?\n    \}/)
  check(!!m && /playSeq \+= 1/.test(m[0]), 'client: stopStreamPlayback 递增代际（在途帧作废）')
  check(!!m && /gen \+= 1/.test(m[0]), 'client: stopStreamPlayback 递增解码代际 gen（旧解码帧作废）')
  check(!!m && /linearRampToValueAtTime\(0\.0001, now \+ 0\.01\)/.test(m[0]), 'client: 停播 10ms 淡出（防硬切咔哒）')
  check(!!m && /src\.stop\(now \+ 0\.015\)/.test(m[0]), 'client: 淡出后延时停源')
  check(!!m && /fetching = false/.test(m[0]), 'client: stopStreamPlayback 清在途标志')
  check(/const retryKeys = new Map\(\)/.test(srcC), 'client: 重试记账按 (sid,text) 维度')
  check(/noRetry = resp\.status === 429/.test(srcC), 'client: 429 标记不重试')
  check(/!noRetry && !retryKeys\.has\(rkey\)/.test(srcC), 'client: 429/重复键跳过重试')
  check(!/_retried/.test(srcC), 'client: `_retried` 单例已移除')
}

if (failed > 0) { console.error(failed + ' 项未通过（RC13 语义）'); process.exit(1) }
console.log('ALL PASS')
process.exit(0)
