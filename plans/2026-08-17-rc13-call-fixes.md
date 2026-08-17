# RC13（通话验收修复：转写串台 / 重复播报 / 双通道 / 爆音）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 RC12 复测暴露的四类根因（三路 V4-Pro 代码评审定案）：① 通话转写跨会话串台 + 渲染期误挂断；② 逐 step 播放近同文案导致"同一内容反复播报"；③ guide_dog_speak(playOnHost) 与队列通道双响；④ 停播硬切/无代际守卫导致咔哒爆音与重试双链重叠。

**Architecture:** 四个根因分属四处，全部落在真源内小步修改（无架构重构）：client 通话归属改由 `startCall` 一次性捕获（对齐 Phase 1 M9 `recSessionRef` 模式），渲染期不再写模块级全局；host 下行/语音模式两个监听按 `tool-call` 块过滤中间步骤消息（dsh-agent-loop 每 step 恰发一条 `assistant/message`，无 tool-call 块即回合最终消息），`pendingFinal` 缓冲 + `turn/end` 兜底防终结型工具回合静音；`playOnHost` 成功后登记文本哈希，队列通道消费即删；client 播放管线加代际守卫（`playSeq`）、恒接 GainNode + 10ms 淡出停播、淡入阈值收窄、按 `(sid,text)` 重试记账、429 不重试。回归用静态契约 repro（`repro/repro-rc13.js`，与 repro-rc11.js 同风格），最后全量回归 + 构建 rc13-20260817 + 部署（convert_bundle → publish → 用户重启 + 硬刷新）。

**Tech Stack:** 静态 Cordis web-profile bundle（`plugin-host.js`/`plugin-client.js` 真源，纯 JS，无 import/JSX/TS；client 模块级变量替代 useRef）；Web Audio API（GainNode 淡入淡出、decodeAudioData）；dsh-agent-loop 事件契约（`assistant/message {turn,step,message}` / `turn/end {turn,reason}`）；node 静态契约回归脚本。

**Spec:** `specs/2026-08-14-guide-dog-v2-design.md`（§6 通话模式、§6.9 验收、§8 错误码）；根因定案见台账 `.superpowers/sdd/2026-08-14-phase2-call-mode/progress.md`（RC12 + 三路评审结论，2026-08-17）。

## Global Constraints

- **部署模型**：真源 `plugin-host.js` / `plugin-client.js`（`return { apply(ctx) {...} }`，纯 JS；**禁止** import/require/TS/JSX；client 用 `React.createElement`，`useRef` 不可用——模块级变量替代；**ASI 陷阱**：括号开头语句（含 IIFE）前必须加分号）。每次改动后 `node --check plugin-client.js && node --check plugin-host.js`。
- **构建标记**：`plugin-client.js` L23 `console.log('[guide-dog] client build rc12-20260817')` → Task 5 统一改为 `rc13-20260817`。**浏览器硬刷新（Ctrl+Shift+R）是验证客户端新代码的唯一途径**（bundle 页面加载时注入；只重启 DSH 不更新浏览器）。
- **事件契约（dsh-agent-loop 源码核实，`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`）**：`assistant/message` 每 step 恰发一条，`data = {turn, step, message, usage?}`（L650）；`turn/end` 每回合 finally 必发，`data = {turn, reason:{kind}}`（L592）；step 内 `message.content` 无 `tool-call` 块 → step 返回 completed（L655-657）——**中间步骤消息必带 tool-call 块，无 tool-call 块的消息即回合最终消息**（唯一例外：max-tokens 截断，仍会被播放，属正确行为）。
- **错误码**：沿用 spec §8.3 枚举，不新增自由文本错误码。
- **队列纪律**：`voiceQueue` shift 语义（client 弹出即消费）；`VOICE_QUEUE_MAX = 10` 超限丢最旧；重试/兜底入队同样遵守。
- **双通道互斥语义**：只挡"同文本已在本机扬声器播过"（消费即删，一次）；不做长期去重（用户合法要求重复播放不受影响）。
- **回归纪律**：`repro/repro-rc13.js` 任一断言缺失 → FAIL；全量 repro 全绿才允许构建/提交；repro 只做静态契约（与 repro-rc11.js 同风格，正则提取真源）。
- **部署提权**：`deploy/publish.py` 写 `~/.dsh` 触发文件沙箱拒绝 → 原命令重试 + `sandbox_permissions: danger-full-access` + 一句话 justification（用户一贯批准）。
- **台账**：`.superpowers/` 未纳入 git；台账更新不提交。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `plugin-client.js` | Task 1：通话归属（`callSessionRef`/`callSid()`/`callActions()` + header 渲染只读）；Task 4：播放管线（代际守卫/淡出/淡入阈值/重试记账）；Task 5：构建标记 | Modify |
| `plugin-host.js` | Task 2：下行 + 语音模式监听过滤中间消息 + `pendingFinal`/`turn/end` 兜底；Task 3：`hostSpoken` 互斥登记与消费 | Modify |
| `repro/repro-rc13.js` | RC13 静态契约回归（Task 1 一次性写全 4 节，Task 2-4 逐节转绿） | Create |
| `README.md` | Phase 2 行为修订（只播最终消息/淡出停播/互斥/重试口径） | Modify（Task 5） |
| `.superpowers/sdd/2026-08-14-phase2-call-mode/progress.md` | RC13 台账（定案、各任务结果、部署记录） | Modify（Task 5/6） |
| `deploy/convert_bundle.py` / `deploy/publish.py` | 重建 bundle / 部署（Task 5 Step 4 / Task 6） | Run |

---

### Task 1: 转写会话绑定（client）

**Files:**
- Modify: `plugin-client.js`（L637 归属声明、L640-677 header 渲染、L763 删除 `gdInputActions`、L765 `startCall`、L853 `stopCall`、L865/942/957/960/965/972/995/1036/1050/1279/1304/1310 调用点）
- Create: `repro/repro-rc13.js`（全部 4 节断言一次写入；本任务只转绿第 1 节）

**Interfaces:**
- Consumes: `props.sessionId` / `props.inputActions`（`conversation.session.header.actions` slot props，R12 探测定案）；`callState`（模块级）、`callMic`、`stopCall()`、`startCall(sid)`
- Produces: `callSessionRef`（模块级 `{sid, actions}`，startCall 捕获）、`callSid()`、`callActions()`、`startCall(sid, inputActions)`——Task 2-4 不改动这些接口，仅消费其语义（所有上行 sid 均来自 callSid()）

**背景（三路评审共同确认）**：`callSessionId` 与 `gdInputActions` 是模块级全局，被**每个会话**的 header 渲染覆盖（L647-652）——用户通话中切到别的会话，该会话 header 一渲染就把全局指向新会话：后续转写段提交/打断 steer 全投错会话（实测 12:33-12:35 转写投到 b11c1a72 与 0334dc06 两个会话，主会话一个字没收到）；同时 L651 渲染期自动挂断会在切会话瞬间误挂进行中的通话。修复：归属在 `startCall` 时刻一次性捕获（对齐 Phase 1 M9 `recSessionRef` 模式），渲染期只读。

- [ ] **Step 1: 创建失败测试（repro/repro-rc13.js，全 4 节）**

创建 `repro/repro-rc13.js`，内容如下（第 2-4 节断言在本任务结束时仍为红——对应 Task 2/3/4 的测试）：

```js
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
  check(/turn-end flush/.test(srcH), 'host: turn/end 兜底入队（终结工具回合不静音）')
}

// ---- 3. 双通道互斥（Task 3，host） ----
{
  check(/function markHostSpoken/.test(srcH), 'host: markHostSpoken 存在')
  check(/function wasHostSpoken/.test(srcH), 'host: wasHostSpoken 存在（消费即删）')
  check(/markHostSpoken\(sid, transformed\)/.test(srcH), 'host: playOnHost 成功后标记文本')
  const w = (srcH.match(/wasHostSpoken\(sid, text\)/g) || []).length
  check(w >= 2, 'host: 下行 + 语音模式两个监听都跳过本机已播文本')
}

// ---- 4. 播放管线爆音（Task 4，client） ----
{
  check(/function scheduleChunk\(audioCtx, wavBytes, playId\)/.test(srcC), 'client: scheduleChunk 带 playId')
  check(/playId !== streamPlayer\.playSeq \|\| !streamPlayer\.active/.test(srcC), 'client: 解码帧代际守卫（旧 fetch 帧不加入新链）')
  check(/src\._gdGain = g/.test(srcC), 'client: 每帧恒接 GainNode（停播淡出需要）')
  check(/gapMs > 3/.test(srcC), 'client: 淡入阈值收窄到 3ms')
  const m = srcC.match(/function stopStreamPlayback\(\) \{[\s\S]*?\n    \}/)
  check(!!m && /playSeq \+= 1/.test(m[0]), 'client: stopStreamPlayback 递增代际（在途帧作废）')
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node repro/repro-rc13.js`
Expected: 第 1 节全部 FAIL（且 2/3/4 节也 FAIL——对应后续任务，属预期）。

- [ ] **Step 3: 实现归属捕获（按下列 5 处修改）**

**3a. 替换 L637 归属声明**（原 `let callSessionId = null`）：

```js
    // RC13（三路评审定案）：通话归属（会话 + inputActions）在 startCall 时一次性捕获；
    // 渲染期不再写全局——多会话 header 渲染互相覆盖曾导致转写串台（12:33-12:35 双会话
    // 错投）与渲染期误挂断。对齐 Phase 1 M9 recSessionRef 模式。
    let callSessionRef = null // { sid: string, actions: object|null }
    function callSid() { return (callSessionRef && callSessionRef.sid) || '' }
    function callActions() { return (callSessionRef && callSessionRef.actions) || null }
```

**3b. 替换 header 渲染函数体（L645-673，`function (props) { ... }` 内部）**——删除 L647/651/652 三行，激活态改按归属会话判定：

```js
            function (props) {
              // RC13：渲染期只读——任何会话的 header 渲染都不再写模块级全局（旧代码在此
              // 覆盖 gdInputActions/callSessionId → 多会话互相串台；渲染期自动挂断 → 切会话即误挂）。
              const sid = props.sessionId || (callSessionRef && callSessionRef.sid) || ''
              // 激活态按"通话归属会话"判定：只有归属会话的按钮显示"通话中"
              const myCall = callState.active && callSessionRef && callSessionRef.sid === sid
              const [, force] = React.useState(0)
              React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
              const style = {
                display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 8px',
                borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #ccc)',
                background: myCall ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : 'transparent',
                color: myCall ? '#fff' : 'var(--dsw-alias-label-secondary, #666)',
                fontFamily: 'inherit', fontSize: '12px',
              }
              return React.createElement('button', {
                style: style, title: myCall ? '挂断通话' : '发起语音通话',
                onClick: function () {
                  if (!myCall) {
                    // RC13：仅在用户点击时切换通话会话——先挂断旧通话再开新通话（挂断动作
                    // 不再由渲染期触发）。通话跨会话切换继续存活（浮动面板可挂断）。
                    if (callState.active && callSessionRef) stopCall()
                    setCallState({ active: true, phase: 'listening', recording: false })
                    startCall(sid, props.inputActions) // RC13：归属（sid + inputActions）开播时刻捕获
                  } else {
                    stopCall()
                  }
                },
              }, myCall ? '📞 通话中' : '📞 通话')
            })
```

**3c. 删除 L763**（原 `let gdInputActions = null // R12：header.actions 的 inputActions（CallButton 渲染时捕获）`）。

**3d. 修改 `startCall`（L765-768）与 `stopCall`（L853-869）**：

```js
    function startCall(sid, inputActions) {
      if (callMic) return
      // RC13：通话归属开播时刻捕获——上传/打断/轮询/回退提交一律用此快照，杜绝渲染期覆盖串台
      callSessionRef = { sid: String(sid || ''), actions: inputActions || null }
      setCallState({ active: true, phase: 'listening', recording: false, error: null })
```

`stopCall` 在末尾（`stopStreamPlayback()` 调用之后）追加：

```js
      callSessionRef = null // RC13：最后清归属——clear-queue/停播已完成（其 callSid() 需在清空前有效）
```

**3e. 替换 12 处调用点**（`callSessionId || ''` → `callSid()`；`gdInputActions` → `callActions()`）：

| 行 | 原 | 新 |
|---|---|---|
| 865 | `sessionId: callSessionId \|\| ''` | `sessionId: callSid()` |
| 942 | `const sid = callSessionId \|\| ''` | `const sid = callSid()` |
| 957 | `sessionId: callSessionId \|\| ''` | `sessionId: callSid()` |
| 960 | `const actions = gdInputActions` | `const actions = callActions()` |
| 965 | `const actions = gdInputActions` | `const actions = callActions()` |
| 972 | `const actions = gdInputActions // R12：header.actions 的 inputActions prop（非 window.__gdInputActions 通道）` | `const actions = callActions() // RC13：开播时刻捕获的 inputActions` |
| 995 | `sessionId: callSessionId \|\| ''` | `sessionId: callSid()` |
| 1036 | `sessionId: callSessionId \|\| ''` | `sessionId: callSid()` |
| 1050 | `playStreamEntry(r.entry, callSessionId \|\| '')` | `playStreamEntry(r.entry, callSid())` |
| 1279 | `sessionId: callSessionId \|\| ''` | `sessionId: callSid()` |
| 1304 | `sessionId: callSessionId \|\| ''` | `sessionId: callSid()` |
| 1310 | `playStreamEntry({ stream: true, text: lastSpokenSentence, consensus: false }, callSessionId \|\| '')` | `playStreamEntry({ stream: true, text: lastSpokenSentence, consensus: false }, callSid())` |

- [ ] **Step 4: 运行测试确认本任务转绿**

Run: `node repro/repro-rc13.js && node --check plugin-client.js`
Expected: 第 1 节全部 PASS；第 2/3/4 节仍 FAIL（对应 Task 2/3/4，属预期）；`node --check` 无输出（语法通过）。

- [ ] **Step 5: 提交**

```bash
git add repro/repro-rc13.js plugin-client.js
git commit -m "fix(phase2): RC13-T1 — 通话归属 startCall 捕获（转写不再串台/渲染期不再误挂断）"
```

---

### Task 2: 只播回合最终消息（host 下行 + 语音模式）

**Files:**
- Modify: `plugin-host.js`（L1881-1909 下行监听、其后新增 turn/end 兜底监听、L1994-2027 语音模式监听、L1606-1611 call-active 清理）

**Interfaces:**
- Consumes: `isCallActive(sid)`、`splitSentences(text, splitChars, maxChars)`、`voiceQueue`、`VOICE_QUEUE_MAX`、`streamTurnKey`/`lastStreamTurn`（均已有）
- Produces: `pendingFinal`（模块级 `Map<sid, {turn, text}>`）；turn/end 兜底监听（下行通道专用；语音模式不设兜底）

**背景（三路评审共同确认）**：`assistant/message` 每 **step** 发一条（dsh-agent-loop `step()` 循环；无 tool-call 块才返回 completed）。多 step 回合的近同文案（"收到，明白了…"→"好的，明白了 ✅…"）被逐条播放——`event.seq` 与 `(turn,step)` 去重键每事件唯一，去重永不触发 → "同一内容反复播报"（含非通话语音模式，12:40 实测）。修复：**带 `tool-call` 块的消息即中间步骤，跳过不播**（进度播报已覆盖工具动作，RC10 精简原则）；终结型工具回合（最后一条消息仍带 tool-call，`concluded` 路径）由 `pendingFinal` 缓冲 + `turn/end` 兜底播文本，防整回合静音。

- [ ] **Step 1: 运行失败测试确认本任务仍红**

Run: `node repro/repro-rc13.js`
Expected: 第 2 节 FAIL（`type === 'tool-call'` 未出现、`pendingFinal`/`turn/end` 缺失）。

- [ ] **Step 2: 实现过滤与兜底（按下列 3 处修改）**

**2a. 下行监听（L1881-1909）**——声明 `pendingFinal` 并在入队前过滤：

```js
    const lastStreamTurn = new Map() // sessionId -> 'turn:step'
    // RC13：只播回合最终消息——中间步骤（带 tool-call 块）只缓冲不播；turn/end 兜底
    const pendingFinal = new Map() // sessionId -> { turn, text }（中间文本最后一条为准）
```

在 `const text = ...` 与 `if (!text) return` 之后（`// RC11：同一 (turn,step) 只入队一次` 注释之前）插入：

```js
        // RC13（三路评审定案）：中间步骤的 assistant/message 必带 tool-call 块（dsh-agent-loop
        // step()：无 tool-call 即返回 completed）——逐 step 播放 = "同一内容反复播报"。带
        // tool-call 的消息：文本入 pendingFinal（只留最后一条），本回合最终消息缺失时由
        // turn/end 监听兜底播放（终结型工具回合不静音）。
        const hasToolCall = content.some(function (b) { return b && b.type === 'tool-call' })
        if (hasToolCall) {
          if (text) pendingFinal.set(sid, { turn: data.turn, text: text })
          return
        }
        pendingFinal.delete(sid)
```

**2b. 下行监听之后新增 turn/end 兜底监听**（接在现有 `ctx.on('session/event', ...)` 大括号之后）：

```js
    // RC13：回合结束兜底——本回合无可播最终消息（终结型工具回合：最后一条 assistant/message
    // 带 tool-call 块被过滤）时，把 pendingFinal 缓冲的中间文本播出去，避免整回合静音。
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'turn/end') return
        const sid = (typeof session === 'string' ? session : (session && session.id)) || ''
        if (!sid) return
        const cfg = loadConfig()
        if (!isCallActive(sid) && !(cfg.a11y && cfg.a11y.enabled)) return
        const turn = (typeof (event.data && event.data.turn) === 'number') ? event.data.turn : null
        if (turn === null) return
        const pend = pendingFinal.get(sid)
        if (!pend || pend.turn !== turn || !pend.text) return
        pendingFinal.delete(sid)
        const streamCfg = (cfg.call && cfg.call.stream) || {}
        const sentences = splitSentences(pend.text, streamCfg.sentenceSplit, streamCfg.maxSentenceChars || 200)
        const q = voiceQueue.get(sid) || []
        sentences.forEach(function (s) { q.push({ stream: true, text: s, key: 'stream:' + sid + ':turnend:' + turn + ':' + s.slice(0, 8) }) })
        if (q.length > VOICE_QUEUE_MAX) q.splice(0, q.length - VOICE_QUEUE_MAX)
        voiceQueue.set(sid, q)
        try { console.log('[gd-host] turn-end flush n=' + sentences.length + ' turn=' + turn) } catch (e) { /* ignore */ }
      } catch (e) { /* best effort */ }
    })
```

**2c. call-active 清理（L1606-1611）**——新通话开始清队列处同步清兜底缓冲（防跨通话陈旧文本）：

```js
            if (active) {
              callActiveSessions.add(String(sid))
              // RC11：新通话 = 新队列——清掉挂断/刷新残留的旧条目，防陈旧内容重放
              voiceQueue.delete(String(sid))
              pendingFinal.delete(String(sid)) // RC13：同清中间文本缓冲（pendingFinal 在后文声明，RPC 回调运行时已初始化）
            } else callActiveSessions.delete(String(sid))
```

**2d. 语音模式监听（L2003-2008，`if (!effective) return` 之后、`const seq = ...` 之前插入）**：

```js
        // RC13：语音模式同样只播回合最终消息——"非通话语音模式也反复播放同一内容"同根因
        // （逐 step 播近同文案）。带 tool-call 的中间消息直接跳过（语音模式终结工具回合
        // 极少见，不设 turn/end 兜底）。
        const hasToolCall = content.some(function (b) { return b && b.type === 'tool-call' })
        if (hasToolCall) return
```

注意：此监听内 `content` 变量在 L2006 才定义——把过滤插在 `const content = ...` / `const text = ...` / `if (!text) return` 之后、`const seq = ...` 之前。

- [ ] **Step 3: 运行测试确认本任务转绿**

Run: `node repro/repro-rc13.js && node --check plugin-host.js`
Expected: 第 1、2 节全部 PASS；第 3/4 节仍 FAIL（对应 Task 3/4，属预期）；`node --check` 无输出。

- [ ] **Step 4: 提交**

```bash
git add plugin-host.js
git commit -m "fix(phase2): RC13-T2 — 只播回合最终消息（下行/语音模式跳过中间步骤，turn/end 兜底）"
```

---

### Task 3: 双通道互斥（host）

**Files:**
- Modify: `plugin-host.js`（L26 后新增互斥登记/消费、L804 `speakImpl` playOnHost 调用点、L807-833 `playOnHost` 返回值、下行监听与语音模式监听各加一处消费检查）

**Interfaces:**
- Consumes: `playOnHost(abs)`（改为返回 boolean 成功）、`transformed`（speakImpl 内 transformText 结果）
- Produces: `markHostSpoken(sid, text)`、`wasHostSpoken(sid, text)`（消费即删）、`normSpeech(s)`——Task 2 已引入的两处 `wasHostSpoken(sid, text)` 调用点在本任务落地

**背景（三路评审共同确认）**：`guide_dog_speak(playOnHost=true)` 在本机扬声器（ffplay）播放后，同一文本又经语音模式/下行队列通道合成播一遍（b11c1a72 实测：host 扬声器 + 浏览器双响）。`speakImpl` 的 turnSeq 去重对工具路径（seq=null）不生效，且两条路径 sid 语境不同无法互相去重。修复：playOnHost 成功后在会话级登记规范化文本；两个监听在入队前检查，命中即消费（删）并跳过。

- [ ] **Step 1: 运行失败测试确认本任务仍红**

Run: `node repro/repro-rc13.js`
Expected: 第 3 节 FAIL（`markHostSpoken`/`wasHostSpoken` 缺失）。

- [ ] **Step 2: 实现互斥（按下列 3 处修改）**

**2a. L26（`const spokenTurns = new Map()` 之后）新增三个辅助函数**：

```js
    // RC13（三路评审定案）：双通道互斥——playOnHost 已在本机扬声器播放的文本，不得再经
    // voice-mode/downlink 队列通道播一遍（本机 + 浏览器双响）。消费即删（同文本只挡一次，
    // 用户合法要求重复播放不受影响）。
    const hostSpoken = new Map() // sessionId -> Map<normalizedText, true>
    function normSpeech(s) { return String(s || '').replace(/\s+/g, ' ').trim() }
    function markHostSpoken(sid, text) {
      const k = normSpeech(text)
      if (!k) return
      let m = hostSpoken.get(String(sid))
      if (!m) { m = new Map(); hostSpoken.set(String(sid), m) }
      m.set(k, true)
    }
    function wasHostSpoken(sid, text) {
      const m = hostSpoken.get(String(sid))
      if (!m) return false
      const k = normSpeech(text)
      if (!k || !m.has(k)) return false
      m.delete(k) // 消费一次
      if (!m.size) hostSpoken.delete(String(sid))
      return true
    }
```

**2b. `playOnHost`（L807-833）改返回 boolean + `speakImpl`（L804）成功即登记**：

`playOnHost` 三处返回：`if (!player) return` → `if (!player) return false`；spawn 成功（`players.set(abs, handle)` 之后）→ `return true`；`} catch (e) { /* playback is best effort */ }` → `} catch (e) { return false }`。

L804 原 `if (args.playOnHost) await playOnHost(abs)` 改为：

```js
      // RC13：本机扬声器播放成功后登记文本——队列通道（语音模式/下行）消费即删，防双响
      if (args.playOnHost) { const played = await playOnHost(abs); if (played) markHostSpoken(sid, transformed) }
```

**2c. 两个监听各加一处消费检查**：

下行监听（Task 2 已插入的 `pendingFinal.delete(sid)` 之后、`// RC11：同一 (turn,step)` 注释之前）：

```js
        // RC13（Task 3）：双通道互斥——本机扬声器已播（guide_dog_speak playOnHost）的文本不再入队
        if (wasHostSpoken(sid, text)) return
```

语音模式监听（Task 2 已插入的 `if (hasToolCall) return` 之后）：

```js
        // RC13（Task 3）：双通道互斥
        if (wasHostSpoken(sid, text)) return
```

- [ ] **Step 3: 运行测试确认本任务转绿**

Run: `node repro/repro-rc13.js && node --check plugin-host.js`
Expected: 第 1、2、3 节全部 PASS；第 4 节仍 FAIL（对应 Task 4，属预期）；`node --check` 无输出。

- [ ] **Step 4: 提交**

```bash
git add plugin-host.js
git commit -m "fix(phase2): RC13-T3 — playOnHost 与队列通道互斥（同文本消费即删，消除双响）"
```

---

### Task 4: 播放管线爆音（client）

**Files:**
- Modify: `plugin-client.js`（L1087 streamPlayer 声明后加重试记账、L1129-1162 `scheduleChunk`、L1163-1260 `playStreamEntry` 内 fetch/catch、L1218/1225 两处 `scheduleChunk` 调用、L1261-1268 `stopStreamPlayback`）

**Interfaces:**
- Consumes: `streamPlayer`（模块级 `{controller, nodes, nextTime, active, audioCtx, playSeq, fetching}`）、`entry`、`sid`、`callPoll` 串行消费语义
- Produces: `scheduleChunk(audioCtx, wavBytes, playId)`（新第三参）、`retryKeys`（模块级 `Map<'sid|text', true>`）、`stopStreamPlayback` 新语义（递增 playSeq、淡出、清 fetching）

**背景（三路评审共同确认，四子项）**：① 停播 `src.stop()` 硬切 → 句切断处咔哒爆音；② `scheduleChunk` 无代际守卫——重试/打断后旧 fetch 的解码帧（decodeAudioData 异步）仍会加入新链 → 同句尾帧新旧链重叠 → 重复播放 + 同相 16bit PCM 叠加削波爆音；③ 淡入阈值 20ms 过宽，5-20ms 帧间隙无淡入；④ `_retried` 模块单例（句 A 重试后 5s 内句 B 失败不重试）+ 429 重试必然再 429 + `stopStreamPlayback` 不清 `fetching`。

- [ ] **Step 1: 运行失败测试确认本任务仍红**

Run: `node repro/repro-rc13.js`
Expected: 第 4 节 FAIL（playId 参数、`_gdGain`、`gapMs > 3`、`playSeq += 1`、淡出、`retryKeys`、`noRetry` 等缺失）。

- [ ] **Step 2: 实现（按下列 4 处修改）**

**2a. L1087 后新增重试记账**：

```js
    // RC13（三路评审定案）：重试记账按 (sid,text) 维度——旧 `_retried` 模块单例：句 A 重试后
    // 5s 内句 B 失败不再重试（单例被 A 占用）。429（host 忙门）不重试（立即重试必再 429，
    // 且与在途合成并发；串行 poll 下一轮会取队列下一条）。
    const retryKeys = new Map() // 'sid|text' -> true（5s 后释放）
```

**2b. `scheduleChunk`（L1129-1162）——加 playId 参数、代际守卫、恒接 GainNode、淡入阈值收窄**：

```js
    function scheduleChunk(audioCtx, wavBytes, playId) {
      return audioCtx.decodeAudioData(wavBytes.buffer.slice(0)).then(function (buf) {
        // RC13：代际守卫——重试/打断后旧 fetch 的解码帧（异步 decode）不得加入新链，
        // 否则同句尾帧在新旧链上重叠 → 重复播放 + 同相叠加削波爆音
        if (playId !== streamPlayer.playSeq || !streamPlayer.active) return
        const src = audioCtx.createBufferSource()
        src.buffer = buf
        const when = Math.max(audioCtx.currentTime + 0.05, streamPlayer.nextTime)
        // RC12：断链后淡入（5ms）；RC13：每帧恒接 GainNode（停播淡出需要），阈值收窄到 3ms
        // ——5-20ms 帧间隙同样淡入，消除小间隙咔哒
        const gapMs = Math.round((when - streamPlayer.nextTime) * 1000)
        const g = audioCtx.createGain()
        if (gapMs > 3) {
          g.gain.setValueAtTime(0.0001, when)
          g.gain.linearRampToValueAtTime(1, when + 0.005)
        }
        src._gdGain = g
        src.connect(g); g.connect(audioCtx.destination)
        src.start(when)
        streamPlayer.nextTime = when + buf.duration
        streamPlayer.nodes.push(src)
        gdLog('chunk when=' + when.toFixed(3) + ' now=' + audioCtx.currentTime.toFixed(3) + ' gap=' + gapMs + 'ms dur=' + buf.duration.toFixed(3) + ' nodes=' + streamPlayer.nodes.length)
        src.onended = function () {
          const i = streamPlayer.nodes.indexOf(src)
          if (i >= 0) streamPlayer.nodes.splice(i, 1)
          // C6（最终审稿）：链排空但仍有句子 fetch 在途时**不得**停 active——否则在途 fetch 的
          // `if (!streamPlayer.active)` 守卫会 abort 自己，catch 又因 active=false 跳过重连，
          // 该句被静默丢弃（如先于下一句首帧解码就排空的短句"好的/收到"）
          if (!streamPlayer.nodes.length && !streamPlayer.fetching && streamPlayer.active) {
            streamPlayer.active = false
            gdLog('chain drained -> listening')
            setCallState({ phase: 'listening' })
          }
        }
      }).catch(function (e) { gdLog('chunk DECODE-FAIL ' + String((e && e.message) || e).slice(0, 60)) })
    }
```

**2c. `playStreamEntry`（L1163-1260）——rkey/noRetry/调用点/重试分支**：

L1165（`const playId = ++streamPlayer.playSeq` 之后）新增：

```js
      const rkey = sid + '|' + entry.text // RC13：重试记账键（(sid,text) 维度）
```

L1190（`streamPlayer.fetching = true` 附近）新增：

```js
      let noRetry = false // RC13：429 不重试标记
```

L1196-1197 fetch 检查改为：

```js
        if (!resp.ok || !resp.body) { noRetry = resp.status === 429; throw new Error('http ' + resp.status) }
```

L1218 与 L1225 两处 `scheduleChunk(audioCtx, wav)` → `scheduleChunk(audioCtx, wav, playId)`。

catch 分支（L1228-1250）整体替换为：

```js
      } catch (e) {
        // R15 修复：新播放已接管（playSeq 已递增）→ 旧 abort rejection 直接退出，不拆新播放状态
        if (playId !== streamPlayer.playSeq) return
        gdLog('stream FAIL playId=' + playId + ' active=' + streamPlayer.active + ' retried=' + retryKeys.has(rkey) + ' nodes=' + streamPlayer.nodes.length + ' err=' + String((e && e.message) || e).slice(0, 60))
        if (streamPlayer.active) {
          // RC11（V4-Pro 诊断确认）：重试前完整停链——stopStreamPlayback 内部递增 playSeq，
          // 重试以新代际起播，旧帧（含已 src.start 的）全部作废
          stopStreamPlayback()
          setCallState({ phase: 'listening', error: '播放中断' })
          // RC13：429 不重试（host 忙门，立即重试必再 429）；同 (sid,text) 5s 内至多重试一次。
          // 重试必须并入串行链——return 让 callPoll 等到重试结束（RC8）。
          if (!noRetry && !retryKeys.has(rkey)) {
            retryKeys.set(rkey, true)
            setTimeout(function () { retryKeys.delete(rkey) }, 5000)
            showToast('播放中断，已尝试重连')
            const retried = playStreamEntry({ stream: true, text: entry.text, consensus: entry.consensus }, sid)
            return retried
          } else {
            showToast('播放中断')
          }
        }
      } finally {
```

**2d. `stopStreamPlayback`（L1261-1268）整体替换**：

```js
    function stopStreamPlayback() {
      // RC13：代际递增——在途 fetch 的解码帧/abort 回调全部作废（catch 的 playId 归属检查直接退出）
      streamPlayer.playSeq += 1
      if (streamPlayer.controller) { try { streamPlayer.controller.abort() } catch (e) { /* ignore */ } streamPlayer.controller = null }
      streamPlayer.active = false
      // RC13：淡出停播（10ms 线性落零再延时停源）——src.stop() 硬切在句切断处产生咔哒爆音
      const now = streamPlayer.audioCtx ? streamPlayer.audioCtx.currentTime : 0
      streamPlayer.nodes.forEach(function (src) {
        try {
          const g = src._gdGain
          if (g && streamPlayer.audioCtx) {
            g.gain.cancelScheduledValues(now)
            g.gain.setValueAtTime(g.gain.value || 1, now)
            g.gain.linearRampToValueAtTime(0.0001, now + 0.01)
            src.stop(now + 0.015)
          } else {
            src.stop()
          }
        } catch (e) { /* ignore */ }
      })
      streamPlayer.nodes = []
      streamPlayer.nextTime = 0
      streamPlayer.fetching = false // RC13：停播即清在途标志（C6 的"fetch 在途保 active"仅用于自然排空）
      notifyConsensusSpeech(false)
    }
```

- [ ] **Step 3: 运行测试确认全绿**

Run: `node repro/repro-rc13.js && node --check plugin-client.js`
Expected: 第 1-4 节全部 PASS，`ALL PASS`；`node --check` 无输出。

- [ ] **Step 4: 提交**

```bash
git add plugin-client.js
git commit -m "fix(phase2): RC13-T4 — 播放管线：代际守卫/淡出停播/淡入阈值 3ms/按 (sid,text) 重试记账/429 不重试"
```

---

### Task 5: 全量回归 + 构建标记 + README + 台账 + 提交

**Files:**
- Modify: `plugin-client.js`（L23 构建标记）、`README.md`（Phase 2 行为修订）、`.superpowers/sdd/2026-08-14-phase2-call-mode/progress.md`（RC13 台账）
- Run: 全部 repro、`node --check`、`python3 deploy/convert_bundle.py`

**Interfaces:**
- Consumes: 任务 1-4 全部产物
- Produces: 可部署的 rc13 构建（`bundle/lib/index.js` + `bundle/lib/client.js`）、构建标记 `rc13-20260817`、台账记录

- [ ] **Step 1: 全量回归**

```bash
for f in repro/repro-*.js; do node "$f" || exit 1; done
bash repro/repro-stream-busy-429.sh
bash repro/repro-call-segment-webm.sh
bash repro/repro-transcribe-concurrency.sh
node --check plugin-client.js && node --check plugin-host.js
```

Expected: 全部 `ALL PASS`；脚本退出码 0；`node --check` 无输出。任一失败 → 停下修复再继续（不得带红提交）。

- [ ] **Step 2: 提升构建标记**

`plugin-client.js` L23：`[guide-dog] client build rc12-20260817` → `[guide-dog] client build rc13-20260817`（注释行 L22 同步改 `RC13`）。重新跑 `node --check plugin-client.js`。

- [ ] **Step 3: README 修订（Phase 2 节，L245-299）**

- **流式 TTS 条目（L282-288）末尾追加**："**只播回合最终消息（RC13）**：中间步骤的 assistant 消息（带工具调用块）不入队——逐 step 播放近同文案是"同一内容反复播报"的根因；中间步骤由进度播报覆盖。终结型工具回合（最后一条消息仍带工具调用）由 turn/end 兜底播缓冲文本，不静音。"
- **打断条目（L289-292）**：`VAD 检测到播放中用户发声…立即停止播放并清空未播缓冲` 后补一句："停播为 10ms 淡出（RC13）——`src.stop()` 硬切会在句切断处产生咔哒爆音。打断后的首个转写段经 `interrupt` RPC 直达当前回合（`agent.steer`，RC11），不排队成新回合。"
- **容错条目（L297-299）**："流中断自动重连一次（每句重新取 token；失败 toast 提示'播放中断'）" 改为："流中断自动重连一次（按 (sid,text) 5s 内至多重试一次、429 不重试；每句重新取 token；失败 toast 提示'播放中断'）"。
- **新增一条**（放在语音命令条目之后）："- **双通道互斥（RC13）** — `guide_dog_speak(playOnHost=true)` 已在本机扬声器播过的文本，不再经语音模式/通话队列通道重播（消费即删，同文本只挡一次）——消除"本机 + 浏览器双响"。"；并在 流式 TTS 或 容错 处补一句转写归属："通话转写/打断/轮询的会话归属在发起通话时一次性捕获（RC13）——多会话切换不再串台。"

- [ ] **Step 4: 重建 bundle 并核验产物**

```bash
python3 deploy/convert_bundle.py
grep -c "rc13-20260817" bundle/lib/client.js
grep -c "callSessionRef" bundle/lib/client.js
grep -c "pendingFinal" bundle/lib/index.js
grep -c "hostSpoken" bundle/lib/index.js
grep -c "_gdGain" bundle/lib/client.js
```

Expected: 每项 grep 计数 ≥ 1（产物包含全部 RC13 标记）。

- [ ] **Step 5: 台账更新**

向 `.superpowers/sdd/2026-08-14-phase2-call-mode/progress.md` 追加 RC13 段（含：三路评审四根因定案摘要、Task 1-4 结果、repro 全绿、构建标记 rc13-20260817、部署记录占位待 Task 6 补）。台账不入 git。

- [ ] **Step 6: 提交**

```bash
git add plugin-client.js README.md
git commit -m "fix(phase2): RC13 — 全量回归通过 + README 行为修订 + 构建 rc13-20260817"
```

---

### Task 6: 部署（publish + 用户重启 + 验收清单）

**Files:**
- Run: `python3 deploy/publish.py`（写 `~/.dsh` 需提权）
- Modify: `.superpowers/sdd/2026-08-14-phase2-call-mode/progress.md`（部署记录）

**Interfaces:**
- Consumes: Task 5 构建产物
- Produces: `~/.dsh/dsh-guide-dog` 更新（用户重启后生效）

- [ ] **Step 1: 发布（提权）**

```bash
python3 deploy/publish.py
```

Expected: 文件沙箱拒绝（写 `~/.dsh`）→ **原命令重试一次** + `sandbox_permissions: danger-full-access` + justification（"发布 guide-dog 插件 bundle 到 ~/.dsh/dsh-guide-dog，用户一贯批准"）→ 用户批准后输出同步成功。

- [ ] **Step 2: 台账补部署记录**（publish 时间、bundle 哈希、served 确认方式）

- [ ] **Step 3: 用户侧验证指令（向用户发出）**

1. **重启 DSH**（`dsh web`）。
2. **硬刷新浏览器**（Ctrl+Shift+R）——只重启不刷新不会更新客户端。
3. DevTools 控制台确认 `[guide-dog] client build rc13-20260817`。
4. 一次完整通话测试，期间采集：浏览器控制台 `[gd]` 日志 + DSH 终端 `[gd-host]` 日志（enqueue/shift/turn-end flush/skip host-spoken/DEDUPE）。

- [ ] **Step 4: 验收清单（对照 spec §6.9 + RC13 四项）**

- 转写归属：通话中切换会话后，转写/打断仍进入**当前通话会话**（不再串台）；切会话不误挂断。
- 每回合只播一次最终消息：中间"收到/明白了"等近同文案不再播报。
- 停播/打断/重连无咔哒爆音；同一内容不再重复播放（流重试不双链）。
- 打断后首个转写段直达 agent（回复被修正而非排队）。
- `guide_dog_speak(playOnHost=true)` 不再双响。
- 语音模式（非通话）不再反复播同一内容。
- §6.9 剩余项：共识流程（写操作拦截 + 摘要 + 3s 窗口 + 窗口内发声中止 + agent.turn 观察）、长回复 + 语音命令（暂停/恢复/重复/慢一点/快一点）、心跳播报。
- 任一失败 → 采集日志回传，进入 RC14 排查（本计划不再展开）。

---

## Self-Review（writing-plans 内建，已执行）

1. **Spec 覆盖**：四根因 ↔ Task 1-4 一一对应；验收 ↔ Task 6 Step 4；回归/部署纪律 ↔ Task 5/6；无遗漏。
2. **占位符扫描**：所有步骤含具体代码/命令；无"适当处理""类似上文"式表述。
3. **类型一致性**：`callSid()`/`callActions()`/`callSessionRef` 在 Task 1 定义并被 3a-3e 全量替换使用；`scheduleChunk(audioCtx, wavBytes, playId)` 在 Task 4 两处调用点同步改参；`wasHostSpoken(sid, text)` 两处消费点与 `markHostSpoken(sid, transformed)` 匹配；repro 断言与实现字符串逐一核对（`src._gdGain = g`、`gapMs > 3`、`linearRampToValueAtTime(0.0001, now + 0.01)`、`src.stop(now + 0.015)`、`playSeq += 1`、`fetching = false`、`noRetry = resp.status === 429`、`!noRetry && !retryKeys.has(rkey)`）。
