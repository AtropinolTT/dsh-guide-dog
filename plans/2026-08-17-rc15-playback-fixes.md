# RC15 语音播报链路修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复语音模式/播报 mp3 的浏览器播放链路——消除 ERR_CONTENT_LENGTH_MISMATCH 重试风暴、自动播放被拦丢条目、事件重放/同文本导致的重复播报。

**Architecture:** 客户端把"每个条目新建 Audio 元素"改为"fetch 全量下载 + Blob URL + 单一持久 Audio 元素"，配全局手势解锁与失败回队；主机端新增 `voice-requeue` RPC，并给通话下行与语音模式两条监听各加"同净化文本短窗口去重"。

**Tech Stack:** 纯 JS（plugin-host.js / plugin-client.js，无 TS/JSX/import）、Node 断言脚本（repro/）、python3 deploy/convert_bundle.py 构建。

**Spec:** 本计划自含规格（无独立 spec 文档）。根因来自 2026-08-17 现场取证（见下节）。

## 根因记录（Spec，2026-08-17 取证）

1. **重试风暴 + 截断误报**：旧实现 `playEntry` 每个条目 `new Audio(url)`。浏览器媒体加载器在自动播放被拦/元素被替换时中止下载 → 控制台 `ERR_CONTENT_LENGTH_MISMATCH`；Chrome 对失败媒体源自动重试（每 ~5s 一次）→ 同文件 10-30 次请求（实测 turn-090 两分钟 25 次）。服务端五种请求方式（全量/Range/浏览器头/gzip/12 并发）全部字节完整——服务端无缺陷。
2. **自动播放策略拦截即丢**：`a.play()` 被拒（无 user gesture）→ 条目已被主机 shift 消费 → 永久丢失。用户全程听不到任何回复。
3. **事件重放绕过去重（男声 7 遍根因）**：通话下行监听 L1960-1962 `streamTurnKey(data.turn, data.step)` 在 turn/step 缺失时为 `'undefined:undefined'`，`tkey !== 'undefined:undefined'` 判假 → 去重被绕过 → 同句反复入队。该会话处于通话激活态，用通话男声（English_expressive_narrator）流式合成（不落文件）。
4. **语音模式无文本级去重**：同净化文本重复出现（事件重放/agent 复述）会重复入队。
5. **播放计数缺口**：RC14 的 `playCounts` 只统计 stream 条目，语音模式 mp3 条目无计数（PLAY-SUMMARY 覆盖不到）。

## Global Constraints

- 插件源码为纯 JS：`return { apply(ctx) {...} }`；禁止 TS 类型、import/require、JSX；React 一律 `React.createElement`/`h(...)`；语句以分号结尾。
- 客户端环境可用：`window`、`Audio`、`fetch`、`AbortController`、`Blob`、`URL`、`navigator`（已有代码在用）；不假设 `document`（手势监听挂 `window.addEventListener(..., true)`）。
- 保留既有诊断日志前缀 `[gd]`（client console）与 `[gd-host]`（DSH 终端）。
- 保留 `VOICE_QUEUE_MAX = 40`；队列语义"截尾不截头"不变。
- repro 断言字符串必须与源码逐字一致（大小写/空格），改代码即同步改断言。
- 构建：`python3 deploy/convert_bundle.py` → `bundle/lib/index.js` + `bundle/lib/client.js`（TRACKED，独立 commit）。
- 发布：`python3 deploy/publish.py`（写 `~/.dsh`，需 danger-full-access 审批；被拒后须用户明确同意才重试）。
- 分支 phase2-call-mode 原地开发，master 为名义基线从不合并。

---

### Task 1: 主机 `voice-requeue` RPC + 回队纯函数

**Files:**
- Modify: `plugin-host.js:2149-2168`（voice-queue handler 所在 ctx.effect 块内追加第二个 harness.handle）
- Modify: `plugin-host.js`（新增 `requeueEntry` 纯函数，置于 `voiceQueue` 定义 L2100 之后）
- Create: `repro/repro-rc15.js`（本任务先建宿主侧断言）

**Interfaces:**
- Produces: `requeueEntry(q, entry, max)` → `{ q, dup }`（q 为条目数组，entry 含 `key`，max 为队列上限；同 key 已在队则不重复插入，超出 max 从队尾 pop）；RPC `guide-dog/voice-requeue`，入参 `{ sessionId, entry }`，返回 `{ ok, dup }`。

- [ ] **Step 1: 写失败断言**

创建 `repro/repro-rc15.js`（本任务只含宿主导航部分；后续任务追加）：

```js
// repro-rc15.js —— RC15 断言（静态契约 + 行为）
// 运行：node repro/repro-rc15.js   （退出码 0 = 全过）
'use strict'
const fs = require('fs')
const path = require('path')
const host = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8')
let fail = 0
function ok(cond, msg) { if (cond) { console.log('PASS ' + msg) } else { fail++; console.log('FAIL ' + msg) } }
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) return null
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  return null
}

// ---- 静态契约（Task 1：回队 RPC） ----
ok(host.includes("harness.handle('guide-dog/voice-requeue'"), 'host RPC voice-requeue')
ok(host.includes('function requeueEntry('), 'host requeueEntry pure fn')
ok(host.includes("'[gd-host] requeue sid='"), 'host requeue log')

// ---- 行为（Task 1：回队去重 + 截尾） ----
const requeueSrc = extractFn(host, 'requeueEntry')
ok(!!requeueSrc, 'extract requeueEntry')
if (requeueSrc) {
  const requeueEntry = new Function('return ' + requeueSrc)()
  const r1 = requeueEntry([], { key: 'a', url: 'u1' }, 40)
  ok(r1.q.length === 1 && r1.dup === false, 'requeue insert new')
  const r2 = requeueEntry(r1.q, { key: 'a', url: 'u1' }, 40)
  ok(r2.q.length === 1 && r2.dup === true, 'requeue dup skipped')
  const r3 = requeueEntry([{ key: 'x' }, { key: 'y' }], { key: 'z' }, 2)
  ok(r3.q.length === 2 && r3.q[0].key === 'z' && r3.q[2] === undefined, 'requeue tail pop')
}

process.exit(fail === 0 ? 0 : 1)
```

- [ ] **Step 2: 运行确认失败**

Run: `node repro/repro-rc15.js`
Expected: FAIL（RPC/函数不存在，多数断言 FAIL；`extract requeueEntry` FAIL）

- [ ] **Step 3: 实现**

在 `plugin-host.js` L2100 `const voiceQueue = new Map() // ...` 之后插入纯函数：

```js
    // RC15：回队核心（纯函数，供 RPC 与 repro 复用）——同 key 已在队则不重复插入；超出上限截尾
    function requeueEntry(q, entry, max) {
      const dup = q.some(function (e) { return e.key === entry.key })
      if (!dup) q.unshift(entry)
      while (q.length > max) q.pop()
      return { q: q, dup: dup }
    }
```

在 L2149-2168 的 voice-queue ctx.effect 块内（`harness.handle('guide-dog/voice-queue', ...)` 之后）追加第二个 handler：

```js
        // RC15：播放失败回队（不丢内容）——client 播放失败时把条目放回队头
        return harness.handle('guide-dog/voice-requeue', async function (args) {
          try {
            const sid = args && args.sessionId ? String(args.sessionId) : ''
            const entry = args && args.entry
            if (!sid || !entry || !entry.key) return { ok: false, error: 'bad_args' }
            const q = voiceQueue.get(sid) || []
            const out = requeueEntry(q, entry, VOICE_QUEUE_MAX)
            voiceQueue.set(sid, out.q)
            try { console.log('[gd-host] requeue sid=' + sid + ' key=' + String(entry.key).slice(0, 24) + ' dup=' + out.dup) } catch (e) { /* ignore */ }
            return { ok: true, dup: out.dup }
          } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
        })
```

注意：该 effect 块当前以 `return harness.handle('guide-dog/voice-queue', ...)` 开头，追加时改为先注册 requeue 再 return voice-queue（或两个 handle 顺序任意，但 `return` 语句只能有一个——把 requeue 放 voice-queue 之前即可）。

- [ ] **Step 4: 运行确认通过**

Run: `node repro/repro-rc15.js`
Expected: 全部 PASS，exit 0

- [ ] **Step 5: Commit**

```bash
git add plugin-host.js repro/repro-rc15.js
git commit -m "fix(phase2): RC15-T1 — host voice-requeue RPC + requeueEntry 纯函数（播放失败回队不丢内容）"
```

---

### Task 2: 客户端持久语音播放器（fetch+Blob+单元素+手势解锁+回队）

**Files:**
- Modify: `plugin-client.js:64-108`（替换 stopCurrent 内联部分 + 删除 playEntry/playEntryNow，改为 RC15 播放器）
- Modify: `plugin-client.js:426-439`（语音模式轮询改用 playVoiceEntry + PLAY-SUMMARY 分支）
- Modify: `plugin-client.js:1060`（callPoll url 分支改用 playVoiceEntry）
- Modify: `repro/repro-rc15.js`（追加客户端断言）

**Interfaces:**
- Consumes: `guide-dog/voice-requeue` RPC（Task 1）；`waitStreamDrain()`（已存在 L1117）；`playCounts` Map（已存在 L1106）；`gdLog`（已存在 L1112）；`showToast`（已存在）。
- Produces: `playVoiceEntry(entry, sid)` → Promise（entry: {url,key,text?}，sid: string）；`unlockVoiceAudio()`（手势解锁，无参）；`bindGestureUnlock()`（apply 时调用一次）。

- [ ] **Step 1: 写失败断言**

追加到 `repro/repro-rc15.js`（把 `const host = ...` 行改为同时读 client，并在行为段前插入）：

```js
const client = fs.readFileSync(path.join(__dirname, '..', 'plugin-client.js'), 'utf8')
```
（在 `const host = ...` 之后加一行）

```js
// ---- 静态契约（Task 2：持久播放器） ----
ok(client.includes('function playVoiceEntry('), 'client playVoiceEntry')
ok(client.includes('function unlockVoiceAudio('), 'client unlockVoiceAudio')
ok(client.includes('function bindGestureUnlock('), 'client bindGestureUnlock')
ok(client.includes("window.addEventListener('click', unlockVoiceAudio, true)"), 'client gesture click')
ok(client.includes("window.addEventListener('keydown', unlockVoiceAudio, true)"), 'client gesture keydown')
ok(client.includes("window.addEventListener('touchstart', unlockVoiceAudio, true)"), 'client gesture touchstart')
ok(client.includes('URL.createObjectURL(blob)'), 'client blob object url')
ok(client.includes('voicePlayer.attempts'), 'client attempts map')
ok(client.includes('attempts > 3'), 'client attempt cap 3')
ok(client.includes("'guide-dog/voice-requeue'"), 'client requeue rpc')
ok(client.includes('waitStreamDrain()'), 'client drain wait')
ok(client.includes('voice play key='), 'client voice play count log')
ok(client.includes("else if (r && r.ok && !r.entry) {"), 'client poll summary branch')
ok(count(client, 'function playEntry(') === 0, 'client playEntry removed')
ok(count(client, 'function playEntryNow(') === 0, 'client playEntryNow removed')
ok(count(client, 'new Audio(String(url))') === 1, 'client per-entry Audio only in playEntryConsensus')
```
（`count` 辅助函数需在文件顶部定义：`function count(hay, needle) { return hay.split(needle).length - 1 }`）

- [ ] **Step 2: 运行确认失败**

Run: `node repro/repro-rc15.js`
Expected: Task 2 断言 FAIL（playVoiceEntry 不存在、playEntry 仍在）

- [ ] **Step 3: 实现**

3a. 替换 `plugin-client.js` L64-108 的 `stopCurrent` + `playEntry` + `playEntryNow` 整段为：

```js
    // ---- 模块级播放器：会话切换不中断；新播放任务覆盖旧任务 ----
    let curAudio = null
    // ---- M9：录音归属会话（卸载后 onstop 校验归属，丢弃陈旧提交） ----
    let recSessionRef = null // { sid, alive }：录音归属；卸载置 alive=false → onstop 丢弃
    function stopCurrent() {
      if (curAudio) {
        try { curAudio.pause() } catch (e) { /* ignore */ }
        curAudio = null
      }
      // RC15：持久播放器同停（共识 mp3 抢占时不得残留语音模式音频）
      if (voicePlayer.audio) {
        try { voicePlayer.audio.pause() } catch (e) { /* ignore */ }
      }
    }
    // ============ RC15 播放器：语音模式/播报 mp3（持久元素 + fetch 全量下载） ============
    // 旧实现逐条目 new Audio(url)：自动播放被拦/元素被替换 → 浏览器中止下载 →
    // ERR_CONTENT_LENGTH_MISMATCH + Chrome 媒体重试风暴（同文件 10-30 次请求）。
    // 新实现：fetch 一次拿全量字节（AbortController 120s 超时）→ Blob URL → 单一持久 Audio 元素。
    const voicePlayer = { audio: null, ctx: null, busy: false, pending: null, attempts: new Map(), banner: false }
    function ensureVoiceAudio() {
      if (!voicePlayer.audio) {
        try { voicePlayer.audio = new Audio() } catch (e) { voicePlayer.audio = null }
        if (voicePlayer.audio) voicePlayer.audio.preload = 'auto'
      }
      return voicePlayer.audio
    }
    // RC15：手势解锁——click/keydown/touchstart 后 resume AudioContext 并重试挂起条目
    function unlockVoiceAudio() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (AC) {
          voicePlayer.ctx = voicePlayer.ctx || new AC()
          if (voicePlayer.ctx.state === 'suspended') { try { voicePlayer.ctx.resume() } catch (e) { /* ignore */ } }
        }
      } catch (e) { /* ignore */ }
      const a = ensureVoiceAudio()
      if (a && a.src && a.paused) { const p = a.play(); if (p && typeof p.catch === 'function') p.catch(function () {}) }
      const pend = voicePlayer.pending
      if (pend) { voicePlayer.pending = null; playVoiceEntry(pend.entry, pend.sid) }
    }
    // RC15：全局手势监听（apply 时注册一次；capture 阶段捕获页面任意点击）
    function bindGestureUnlock() {
      try {
        ;['click', 'keydown', 'touchstart'].forEach(function (ev) {
          try { window.addEventListener(ev, unlockVoiceAudio, true) } catch (e) { /* ignore */ }
        })
      } catch (e) { /* ignore */ }
    }
    // RC15：单条目播放——fetch 全量 → 持久元素播放；失败回队（≤3 次/条目）；自动播放被拦 → 挂起等手势
    function playVoiceEntry(entry, sid) {
      const key = String(entry.key || entry.url || '')
      if (!key) return Promise.resolve()
      const attempts = (voicePlayer.attempts.get(key) || 0) + 1
      voicePlayer.attempts.set(key, attempts)
      if (attempts > 3) {
        voicePlayer.attempts.delete(key)
        showToast('播放失败：' + String(entry.text || entry.url || '').slice(0, 24))
        return Promise.resolve()
      }
      return waitStreamDrain().then(function () {
        if (voicePlayer.busy) { voicePlayer.pending = { entry: entry, sid: sid }; return Promise.resolve() }
        voicePlayer.busy = true
        voicePlayer.banner = false
        const ac = new AbortController()
        const timer = setTimeout(function () { try { ac.abort() } catch (e) { /* ignore */ } }, 120000)
        return fetch(String(entry.url), { cache: 'no-store', signal: ac.signal }).then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status)
          return r.blob()
        }).then(function (blob) {
          clearTimeout(timer)
          const a = ensureVoiceAudio()
          if (!a) throw new Error('no audio element')
          const objUrl = URL.createObjectURL(blob)
          const cleanup = function () { try { URL.revokeObjectURL(objUrl) } catch (e) { /* ignore */ } }
          a.onended = function () {
            cleanup(); a.onended = null; a.onerror = null
            voicePlayer.busy = false; voicePlayer.attempts.delete(key); nextVoiceEntry()
          }
          a.onerror = function () {
            cleanup(); a.onended = null; a.onerror = null
            voicePlayer.busy = false; requeueVoiceEntry(entry, sid); nextVoiceEntry()
          }
          a.src = objUrl
          const c = (playCounts.get(key) || 0) + 1
          playCounts.set(key, c)
          gdLog('voice play key=' + key + ' times=' + c)
          const p = a.play()
          if (p && typeof p.catch === 'function') p.catch(function () {
            // 自动播放策略拦截：不丢条目，挂起等待用户手势（unlockVoiceAudio 触发重播）
            voicePlayer.busy = false
            voicePlayer.pending = { entry: entry, sid: sid }
            if (!voicePlayer.banner) { voicePlayer.banner = true; showToast('点击页面任意位置开启语音播报') }
          })
          return Promise.resolve()
        }).catch(function (e) {
          clearTimeout(timer)
          voicePlayer.busy = false
          gdLog('voice fail key=' + key + ' err=' + String((e && e.message) || e).slice(0, 60))
          requeueVoiceEntry(entry, sid)
          nextVoiceEntry()
        })
      })
    }
    function requeueVoiceEntry(entry, sid) {
      host.call('guide-dog/voice-requeue', {
        sessionId: sid,
        entry: { key: entry.key, url: entry.url, text: entry.text, stream: entry.stream, consensus: entry.consensus },
      }).catch(function () {})
    }
    function nextVoiceEntry() {
      const pend = voicePlayer.pending
      if (pend) { voicePlayer.pending = null; playVoiceEntry(pend.entry, pend.sid) }
    }
```

3b. 语音模式轮询（L426-439）改为：

```js
            React.useEffect(function () {
              // 语音模式生效时每秒轮询本会话队列；播放本身在模块级，不受会话切换影响
              // I1（2026-08-16 审稿）：通话期间 stream 条目由通话专用轮询（callPoll）独家消费
              // ——本轮询停用，保证队列单消费者（Phase 1 的 pop 语义会丢弃无 url 的 stream 条目）
              if (!effective || callState.active || !sid || pollBusy) return
              pollBusy = true
              host.call('guide-dog/voice-queue', { sessionId: sid }).then(function (r) {
                if (r && r.ok && r.entry) {
                  // RC15：持久播放器（fetch+Blob）；错误条目照旧提示
                  if (r.entry.url) return playVoiceEntry(r.entry, sid)
                  else if (r.entry.error) { showToast('朗读失败：' + (r.entry.message || r.entry.error)); playBeep() }
                } else if (r && r.ok && !r.entry) {
                  // RC15：与 callPoll 同款播放汇总埋点（语音模式 mp3 计数；!r.ok 跳过防跨回合误归零）
                  if (playCounts.size) {
                    const summary = Array.from(playCounts.entries()).map(function (e) { return e[0] + '=' + e[1] }).join(' | ')
                    gdLog('PLAY-SUMMARY ' + summary)
                    playCounts.clear()
                  }
                }
              }).catch(function () {}).then(function () { pollBusy = false })
            }, [effective, sid, tick])
```

3c. callPoll url 分支（L1060）改为：

```js
          else if (r.entry.url) { consumed = true; return playVoiceEntry(r.entry, callSid()) }
```

3d. 在 client `apply(ctx)` 的末尾（`ctx.effect(...)` 注册之后、`},` 之前）调用一次 `bindGestureUnlock()`（放在 `return { apply(ctx) {...} }` 的 apply 函数体内合适位置，确保 `waitStreamDrain`/`showToast` 等函数已提升定义）。

- [ ] **Step 4: 运行确认通过**

Run: `node repro/repro-rc15.js`
Expected: Task 1 + Task 2 断言全部 PASS，exit 0

- [ ] **Step 5: Commit**

```bash
git add plugin-client.js repro/repro-rc15.js
git commit -m "fix(phase2): RC15-T2 — 客户端持久语音播放器（fetch+Blob+手势解锁+失败回队+url 播放计数）"
```

---

### Task 3: 事件重放去重（通话下行 + 语音模式，10s 文本窗口）

**Files:**
- Modify: `plugin-host.js:2100` 附近（新增两个 Map）
- Modify: `plugin-host.js:1959-1962`（downlink tkey 去重修复）
- Modify: `plugin-host.js:2116-2127` 附近（语音模式监听加文本去重）
- Modify: `repro/repro-rc15.js`（追加断言）

**Interfaces:**
- Consumes: `sanitizeSpeechText`（已存在）；`lastStreamTurn` Map（已存在）。
- Produces: 纯函数 `replayDup(prev, text, now, windowMs)` → boolean；`lastStreamText` / `lastVoiceText` Map（sessionId → {text, at}）。

- [ ] **Step 1: 写失败断言**

追加到 `repro/repro-rc15.js`：

```js
// ---- 静态契约（Task 3：去重） ----
ok(host.includes('function replayDup('), 'host replayDup pure fn')
ok(host.includes('const lastStreamText = new Map()'), 'host lastStreamText map')
ok(host.includes('const lastVoiceText = new Map()'), 'host lastVoiceText map')
ok(host.includes("'[gd-host] skip replay text='"), 'host replay skip log')
ok(host.includes("'[gd-host] skip voice-dup text='"), 'host voice-dup skip log')
ok(host.includes('lastStreamText.set(sid, { text: pc, at: now3 })'), 'host replay window set')
ok(host.includes('lastVoiceText.set(sid, { text: clean, at: now4 })'), 'host voice-dup window set')

// ---- 行为（Task 3：窗口去重判定） ----
const replaySrc = extractFn(host, 'replayDup')
ok(!!replaySrc, 'extract replayDup')
if (replaySrc) {
  const replayDup = new Function('return ' + replaySrc)()
  ok(replayDup(null, 'x', 0, 10000) === false, 'replayDup no prev')
  ok(replayDup({ text: 'x', at: 0 }, 'x', 5000, 10000) === true, 'replayDup same within window')
  ok(replayDup({ text: 'x', at: 0 }, 'x', 15000, 10000) === false, 'replayDup same after window')
  ok(replayDup({ text: 'y', at: 0 }, 'x', 5000, 10000) === false, 'replayDup different text')
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node repro/repro-rc15.js`
Expected: Task 3 断言 FAIL

- [ ] **Step 3: 实现**

3a. `plugin-host.js` L2100 附近（`const voiceQueue = new Map() ...` 之后）新增：

```js
    const lastStreamText = new Map() // sessionId -> {text, at}（RC15：turn/step 缺失时的事件重放去重）
    const lastVoiceText = new Map() // sessionId -> {text, at}（RC15：语音模式同文本短窗口去重）
```

3b. 纯函数（置于 requeueEntry 之后）：

```js
    // RC15：事件重放去重判定（纯函数，供两处监听与 repro 复用）——同文本且在窗口内 → true（应跳过）
    function replayDup(prev, text, now, windowMs) {
      return !!(prev && prev.text === text && (now - prev.at) < windowMs)
    }
```

3c. downlink 去重修复（L1959-1962 原代码替换）：

```js
        // RC11：同一 (turn,step) 只入队一次——防重复事件/重放把同一内容多次入队
        const tkey = streamTurnKey(data.turn, data.step)
        const now3 = Date.now()
        if (tkey !== 'undefined:undefined') {
          if (lastStreamTurn.get(sid) === tkey) return
          lastStreamTurn.set(sid, tkey)
        } else {
          // RC15：turn/step 缺失 → 按净化文本短窗口去重（事件重放防御：同句 10s 内不重复入队）
          const pc = sanitizeSpeechText(text)
          if (pc && replayDup(lastStreamText.get(sid), pc, now3, 10000)) {
            try { console.log('[gd-host] skip replay text=' + String(pc).slice(0, 20)) } catch (e) { /* ignore */ }
            return
          }
          if (pc) lastStreamText.set(sid, { text: pc, at: now3 })
        }
```

3d. 语音模式监听（`const clean = sanitizeSpeechText(text)` 与 `if (!clean) return` 之后、wasHostSpoken 检查之前）插入：

```js
        // RC15：语音模式同文本短窗口去重（事件重放/agent 复述 → 复读机防御；10s 窗口）
        const now4 = Date.now()
        if (replayDup(lastVoiceText.get(sid), clean, now4, 10000)) {
          try { console.log('[gd-host] skip voice-dup text=' + String(clean).slice(0, 20)) } catch (e) { /* ignore */ }
          return
        }
        lastVoiceText.set(sid, { text: clean, at: now4 })
```

- [ ] **Step 4: 运行确认通过**

Run: `node repro/repro-rc15.js`
Expected: 全部 PASS，exit 0

- [ ] **Step 5: Commit**

```bash
git add plugin-host.js repro/repro-rc15.js
git commit -m "fix(phase2): RC15-T3 — 事件重放/同文本 10s 窗口去重（通话下行 + 语音模式；男声 7 遍根因）"
```

---

### Task 4: 全量回归 + bundle 重建 + README + 台账

**Files:**
- Run: `repro/repro-rc13.js`、`repro/repro-rc14.js`、`repro/repro-rc15.js`、`repro/repro-progress.js`（如存在）
- Run: `python3 deploy/convert_bundle.py`（重建 `bundle/lib/index.js` + `bundle/lib/client.js`）
- Modify: `README.md`（追加 RC15 节）
- Create: `.superpowers/sdd/2026-08-17-rc15-playback-fixes/progress.md`（SDD 脚本生成，含部署记录）

- [ ] **Step 1: 全量回归**

Run: `node repro/repro-rc13.js && node repro/repro-rc14.js && node repro/repro-rc15.js && node repro/repro-progress.js 2>/dev/null || true`
Expected: rc13/rc14/rc15 全部 PASS，exit 0。若 rc13/rc14 有断言字符串被本计划改动破坏（例如引用了 `playEntry`），把该断言改为等价新语义（如 `playVoiceEntry`）并在 commit message 注明。

- [ ] **Step 2: 重建 bundle**

Run: `python3 deploy/convert_bundle.py`
Expected: 成功，输出 `bundle/lib/index.js` / `bundle/lib/client.js`；`node --check` 两个文件均通过。

- [ ] **Step 3: 静态复核**

Run:
```bash
grep -c 'voice-requeue' bundle/lib/index.js bundle/lib/client.js
grep -c 'playVoiceEntry' bundle/lib/client.js
grep -c 'skip replay text=' bundle/lib/index.js
grep -c 'skip voice-dup text=' bundle/lib/index.js
grep -c 'function playEntry(' bundle/lib/client.js || true
```
Expected: 各标记 ≥1（playEntry 为 0）。随后更新 build tag（沿用 RC14 做法）：

```bash
sed -i 's/rc14-20260817/rc15-20260817/g' bundle/lib/client.js bundle/lib/index.js
node --check bundle/lib/client.js && node --check bundle/lib/index.js
grep -c 'rc15-20260817' bundle/lib/client.js
```
Expected: 两个 bundle `node --check` 通过；tag 计数 ≥1。

- [ ] **Step 4: 更新 README**

追加 RC15 节（F1-F5 要点）：F1 持久播放器（fetch+Blob+单元素，消灭 mismatch 重试风暴）；F2 手势解锁 + 被拦挂起重试（不再丢条目）；F3 失败回队 RPC（≤3 次/条目）；F4 事件重放 10s 文本窗口去重（通话下行 + 语音模式）；F5 url 条目播放计数（PLAY-SUMMARY 覆盖语音模式）。

- [ ] **Step 5: 台账 + 提交**

```bash
bash /home/tt-wsl-ubuntu/.dsh/profiles/web/node_modules/dsh-superpowers/skills/subagent-driven-development/scripts/sdd-workspace plans/2026-08-17-rc15-playback-fixes.md
git add bundle/ README.md
git commit -m "chore(phase2): RC15-T4 — 全量回归 + bundle rc15 + README + 台账"
```

- [ ] **Step 6: 提交计划文件**

```bash
git add plans/2026-08-17-rc15-playback-fixes.md
git commit -m "docs(phase2): RC15 实施计划"
```
（计划文件在本任务末尾提交，确保它是最终定稿）

---

### Task 5: 发布 + 复测指引

**Files:**
- Run: `python3 deploy/publish.py`（写 `~/.dsh`，需要 `danger-full-access` 升级审批；若被拒，须用户明确同意后重试同一命令）
- 验证：`~/.dsh/dsh-guide-dog/lib/` 与仓库 `bundle/lib/` sha256 一致；部署目录标记 grep（voice-requeue/playVoiceEntry/skip replay/skip voice-dup/rc15 tag）
- 台账补部署记录（时间、哈希、标记核验、下一步）

- [ ] **Step 1: 发布**

Run: `python3 deploy/publish.py`
Expected: 输出 sha256 清单；复制 `bundle/lib/*` 到 `~/.dsh/dsh-guide-dog/lib/`；注册 web profile。

- [ ] **Step 2: 部署哈希核验**

Run:
```bash
sha256sum ~/.dsh/dsh-guide-dog/lib/index.js ~/.dsh/dsh-guide-dog/lib/client.js bundle/lib/index.js bundle/lib/client.js
curl -s 'http://127.0.0.1:3080/plugins/dsh-guide-dog/client.js' | sha256sum
```
Expected: 四处两两一致（部署 = 仓库 = 服务端）。

- [ ] **Step 3: 台账补部署记录**

progress.md「部署记录」节：发布时刻、sha256、标记核验结果、复测步骤。

- [ ] **Step 4: 提交收尾**

```bash
git add .superpowers/sdd/2026-08-17-rc15-playback-fixes/progress.md
git commit -m "docs(phase2): RC15 — 部署记录回填"
```

## 验收清单（用户侧，Task 5 后）

- [ ] 重启 DSH + 硬刷新（Ctrl+Shift+R），控制台确认 `[guide-dog] client build rc15-<日期>`
- [ ] 页面任意位置点击一次后，语音模式回复**完整可听**，且**只播一遍**
- [ ] F12 不再出现 `ERR_CONTENT_LENGTH_MISMATCH` 刷屏（同文件请求 ≤2 次）
- [ ] 关掉其他会话的通话面板/语音模式后，不再出现男声重复播报
- [ ] 播放失败（如临时断网）后条目不丢失（回队自动重试）
- [ ] 无爆音、无 URL/`**`/📢 碎片（RC14 回归项）
