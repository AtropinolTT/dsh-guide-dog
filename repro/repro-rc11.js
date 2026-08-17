// repro/repro-rc11.js — RC11 回归测试（V4-Pro 子代理诊断结论落地）：
//   1. 流重试前完整停链（防同句双链重叠 → 重复播放 + 削波爆音）
//   2. 挂断清 host 队列（防陈旧条目重放）
//   3. 打断直达 agent：client 打断转写段走 interrupt RPC（steer），不再排队新回合
//   4. host 提供 interrupt 命令（agent.steer）
//   5. 新通话开始清队列（host call-active）
//   6. host 回复入队按 (turn,step) 去重
// 静态契约检查（与 publish.py verify_sources 同风格）；任一缺失 → FAIL（RC10 语义）。
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

// ---- 1. playStreamEntry catch 分支在重试递归前调用 stopStreamPlayback ----
{
  const m = srcC.match(/function playStreamEntry[\s\S]*?\n    function stopStreamPlayback/)
  const region = m ? m[0] : ''
  const between = region.match(/} catch \(e\) \{[\s\S]*?return retried/)
  check(!!between && /stopStreamPlayback\(\)/.test(between[0]), 'client: 流重试前完整停链（catch → stopStreamPlayback → retry）')
}
// ---- 2. stopCall 清 host 队列 ----
{
  const m = srcC.match(/function stopCall\(\) \{[\s\S]*?\n    \}/)
  check(!!m && /clear-queue/.test(m[0]), 'client: 挂断发送 clear-queue')
}
// ---- 3. 打断直达 agent：bargedAt + interrupt RPC 路由 ----
{
  check(/bargedAt = Date\.now\(\)/.test(srcC), 'client: callBargeCb 记录打断时刻')
  check(/cmd: 'interrupt'/.test(srcC), 'client: 打断转写段路由到 interrupt RPC（而非 submitInput）')
}
// ---- 4. host interrupt 命令（steer 注入当前回合） ----
{
  const m = srcH.match(/guide-dog\/call-command[\s\S]*?\n    \}\)/)
  const region = m ? m[0] : ''
  check(/'interrupt'/.test(region), 'host: call-command 支持 interrupt 命令')
  check(/\.steer\(/.test(region), 'host: interrupt 经 agent.steer 注入')
}
// ---- 5. 新通话开始清队列 ----
{
  const m = srcH.match(/guide-dog\/call-active[\s\S]*?\n    \}\)/)
  const region = m ? m[0] : ''
  check(/voiceQueue\.delete/.test(region), 'host: call-active 激活时清队列（防陈旧重放）')
}
// ---- 6. host 回复入队 (turn,step) 去重 ----
{
  check(/function streamTurnKey/.test(srcH), 'host: streamTurnKey 存在')
  check(/lastStreamTurn/.test(srcH), 'host: 同 (turn,step) 只入队一次')
}

if (failed > 0) { console.error(failed + ' 项未通过（RC10 语义）'); process.exit(1) }
console.log('ALL PASS')
process.exit(0)
