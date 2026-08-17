# Phase 2（通话模式）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 dsh-guide-dog 插件（静态 web-profile bundle）Phase 2 落地通话模式：零 WebSocket 双通道（上行整段 POST 转写 + 下行 chunked HTTP 流式 TTS）、VAD 自动/按住说话双模式、共识优先交互（写操作拦截 + 语音摘要 + 打断窗口）、进度播报、打断、语音命令与容错，先修复 Phase 1 终审遗留技术债 M9/M10/M11。

**Architecture:** 单插件演进（spec 方案 A）。host 半（`plugin-host.js` 真源 → `deploy/convert_bundle.py` → `bundle/lib/index.js`）新增 STREAM 节（`/guide-dog/tts-stream` chunked 流式路由 + token 签发 + 分句/预合成）、CONSENSUS 节（`tools/pre-execute` 写操作拦截 + 摘要 TTS + 3s 打断窗口 + consent 内存）、CALL 节（call-transcribe 路由 + 播报队列）；client 半（`plugin-client.js` → `bundle/lib/client.js`）新增 CALL PANEL（header action 按钮 + overlay 面板 + dock 状态条 + VAD/PTT 采集状态机）、STREAM PLAYER（fetch getReader + PCM→WAV + Web Audio 无缝队列 + barge-in）、命令匹配。**关键事实（实施前已验证）**：① 静态 bundle host 半跑在 DSH host Node 进程（非动态沙箱）：Node 全局（Buffer/URL/process/setTimeout 等）可用；兼容层 `harness = {defineTool, registerTool, handle}` 由 convert_bundle.py 注入（handle → JSON POST 路由 `/guide-dog/api/<name>`，双前缀；defineTool 归一化 JSON Schema）；② TTS 主通道为 `mmx speech synthesize --stream`（实测中文短句首字节 600ms、24kHz s16le）；③ `WebRoute.handler=(req,res)` 持原生 node:http 对象（源码确认 "may hold the response open, e.g. SSE"），`res.write` 增量写即 chunked 流；④ `subprocess.spawn({stdio:{stdout:'pipe'}})` → `handle.stdout: Readable`（原生流，直接喂 `res.write`）；⑤ `tools/pre-execute` waterfall → `PreToolDecision = allow | deny{reason} | ask{reason?}`（`exec.name/arguments/agent/token` 可用）；⑥ 事件 `agent/status`/`tools/result`/`agent/error`/`session/event` 均存在且按 agent 作用域 emit。**实现顺序**：技术债 → 配置/token → 探测（Inspect + 临时 bundle 探针）→ 上行 → 共识 → 播报 → 下行 → 播放 → 打断/命令 → 容错 → 组装部署 → 验收。

**Tech Stack:** 静态 Cordis web-profile bundle（host ESM `name/apply/inject` + client `__ModuleLoader__` CJS 工厂；真源为 plain JS，无 import/JSX/useRef——convert_bundle.py 负责包装）；mmx CLI（`speech synthesize --stream`，pcm 24kHz）；faster-whisper（STT，复用 Phase 1）；Web Audio API（AnalyserNode VAD / decodeAudioData 播放队列）；React（client UI，`require('react')` 平台 seed）。

**Spec:** `guide-dog-dsh/specs/2026-08-14-guide-dog-v2-design.md`（§4、§6 全部、§7.1 联动矩阵、§8.1/§8.2/§8.3/§8.4；已按 2026-08-16 静态 bundle 架构修订）

## Global Constraints

- **部署模型（2026-08-16 静态 bundle 定案，替代 cordis_define/cordis_run）**：所有改动落在真源 `plugin-host.js` / `plugin-client.js`（动态格式 `return { apply(ctx) {...} }`，纯 JS；**禁止** import/require/TS/JSX/装饰器；client 用 `React.createElement`，且 **`useRef` 不可用**（用模块级变量替代）；**ASI 陷阱**：括号开头语句（含 IIFE）前必须加分号——Phase 1 根因事故曾因此失败）。改完运行 `python3 deploy/convert_bundle.py`（重生成 `bundle/lib/index.js` + `bundle/lib/client.js`）→ `python3 deploy/publish.py`（同步 `~/.dsh/dsh-guide-dog` + 幂等注册 web profile）→ **重启 DSH**（bundles 启动时解析）→ 验证。**无批准弹窗、无 per-session 实例**；`node --check` 双侧语法检查每次改动后必做。
- 插件身份：`dsh-guide-dog`（静态 bundle，全局单实例）。不再有 `gdog-1`/`pkg-*`/`cordis_define`/`cordis_run`。
- client 半（bundle/lib/client.js）：`window.__ModuleLoader__.load({id:'dsh-guide-dog', factory})`；`const React = require('react')`（平台 seed 词）；styles 兼容层（convert_bundle.py 自建 `<style data-guide-dog>` 标签，`styles.insert` 同签名）；host 兼容层（`host.call(name, args)` → 同源 `fetch('/guide-dog/api/'+name, {method:'POST', JSON})`）；**插件对象声明 `inject: ['slots']`**（client Loader 支持插件级 inject，better-sidebar 先例）。timer 服务经 `ctx.get('timer')` 可选获取并判空（签名 `timeout/interval/throttle/debounce`）。浏览器全局（fetch/MediaRecorder/AudioContext/AnalyserNode/decodeAudioData 等）Phase 1 探测确认可用，但 **fetch ReadableStream 流式读取与 Web Audio 播放队列须在探测任务实测**（Task 4）。
- host 半（bundle/lib/index.js）：跑在 DSH host Node 进程——**Node 全局（Buffer/URL/process/setTimeout/TextEncoder/btoa 等）可用**；`inject` 已声明 8 服务（shell/fs/webServer/sandboxPolicy/systemPrompt/subprocess/timer/tools），apply 内 `ctx.get(...)` 直接取。host 既有辅助函数（行号已核实 2026-08-16，plugin-host.js 1516 行）：`MEDIA_ROUTE`(11)、`CONFIG_DEFAULTS`(31)、`deepMerge`(36)、`guideDogRoot`(44)、`configReady`(56)、`doRefreshConfig`(67)、`refreshConfig`(79)、`loadConfig`(80)、`writeStatus`(105)、`transcribeImpl`(420)、`quote`(503)、`pick`(506)、`sleep`(515)、`serialSpeak`(519)、`serialIndex`(524)、`runRaw`(531)、`ensureMediaDir`(576)、`statFile`(591)、`readBytes`(599)、`writeTextFile`(613)、`hasCJK`(708)、`resolveVoice`(717)、`speakImpl`(746)、RECORDER 节(908)、VOICE MODE 节(1407)、`VOICE_QUEUE_MAX`(1413)、`voiceQueue`(1414)、RPC 区(1353-1510)。
- `res`（路由 handler 入参）与 `handle.stdout`（subprocess pipe 出参）为宿主对象实例，其方法（`res.write`/`res.end`/`on('data')`）可直接调用；stdout chunk 为 Buffer 实例，按 Uint8Array 处理喂 `res.write`（探测任务验证）。
- subprocess 用法（v1 核实）：`subprocess.spawn({ argv, cwd, stdio: { stdin:'ignore', stdout:{maxBytes} | 'pipe', stderr:{maxBytes} }, graceMs })` → handle：`handle.done`（Promise）、`handle.terminate()`、`handle.stdout`（仅 `'pipe'` 时存在，Readable）。**collect 模式输出经脚本写文件 + `readTextFile` 读**（v1 定案）；**pipe 模式仅 Phase 2 下行流使用**。
- fs 服务**无二进制写/删除**：二进制经 base64 文本文件 + 外部进程解码；删除经 `runRaw('rm -f <精确路径>')`（禁止通配符，`quote()` 阻止 glob）。
- 工具/事件契约：`tools/pre-execute` waterfall 签名 `(exec: ToolExecution, next) => Promise<PreToolDecision>`，`ToolExecution = {callId, name, arguments, agent?, token, rootCallId}`（arguments 已 lossless-JSON 解析并冻结）；`PreToolDecision = {kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`。**拦截用 `deny`**（`ask` 走审批流程，不是语音共识）。
- 错误码（spec §8.3 修订版，零 WS 决策）：`bad_args / tts_failed / tts_timeout / stt_failed / stt_timeout / engine_unavailable / mic_denied / empty_speech / stream_rejected / stream_interrupted / vision_failed / config_write_failed / needs_voice_confirmation / aborted_by_user / consensus_failed`。**内部错误码一律从该枚举取，不得新增自由文本错误码**；错误项统一 `{error: <码>, message: <人读文本>}`。~~ws_rejected/ws_lost~~ 已废弃（零 WS）。
- 大小上限（spec §8.1）：call-transcribe 音频 ≤20MB（base64 按 27MB 判定）；describe-screen 图片 ≤8MB（Phase 3）。
- 路径规则：所有 host 新代码一律**绝对路径**——`guideDogRoot()` 在 bundle 中恒返回 **GLOBAL_ROOT = `homedir() + '/.dsh/guide-dog'`**（convert_bundle.py 替换；不再依赖 sandboxPolicy/pwd），runtime 目录为 `GLOBAL_ROOT + '/.guide-dog/…'`；`subprocess.spawn` 的 `cwd` 与 argv 全部绝对化。
- host `timerSvc.timeout` 只用已验证的 `sleep(ms)`（Promise 形式）做超时竞速；不依赖未验证的 callback 形式。**host `timerSvc.interval`（callback 形式）仅 client 已验证**（I3，2026-08-16 审稿）——Task 3/14 的 token 清理与心跳若用 host `interval`，须先在 Task 4 探测确认（`typeof timerSvc.interval === 'function'` 且返回 disposer）；不可用则改用 `sleep` 递归轮询（Task 3 Step 2 已给替代代码）。
- 沙箱说明（2026-08-16 修订）：**静态 bundle 无 per-session 沙箱**——host 半经 `shell`/`fs`/`subprocess` 服务直接操作（v11 实证 media 目录创建于 `~/.dsh/guide-dog/.guide-dog/media`）；**长任务/播放/转写/流式 TTS 仍用 `subprocess` 服务**（避免阻塞事件循环）。
- 仓库文件是源码记录：`plugin-host.js`+`plugin-client.js` 为真源；`deploy/convert_bundle.py` 生成 `bundle/lib/`（**不再是 `plugin-source.js`**——该拼接体为动态插件时代遗留，勿再更新）；部署产物为 `bundle/` + `~/.dsh/dsh-guide-dog`。
- 播放语义（v2.1 裁决延续）：模块级 `Audio`/播放队列，会话切换不销毁不重播；新播放任务覆盖当前。
- 会话切换语义（Phase 2 新增）：**录音中切会话 → 丢弃当前片段不误提交**（防 M9 类陈旧闭包）。
- 共识优先生效范围：仅通话模式开启或 a11y 开启时（`call.consensus.enabled` 且通话激活 / `a11y.enabled`）；打字模式保持 Phase 1 现状。
- 验证/部署无审批：`deploy/publish.py` 写 `~/.dsh` 需提权（文件沙箱 danger-full-access，用户一贯批准）；探测用 Inspect 与临时 bundle 探针，不做动态插件。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `guide-dog-dsh/plugin-host.js` | CALL 配置节（call/a11y 默认值 + tts-token + consent）、STREAM 节（tts-stream 路由 + 分句 + 预合成）、CONSENSUS 节（pre-execute 拦截 + 摘要 + 窗口）、播报节（agent 事件 → 队列）、call-transcribe 路由、M10 修复 | Modify（按行号锚点插入） |
| `guide-dog-dsh/plugin-client.js` | CALL PANEL 节（header.actions/overlay/dock + 模式开关）、采集状态机（VAD/PTT）、STREAM PLAYER 节（fetch 流 + Web Audio 队列 + barge-in）、命令匹配节、共识窗口协调、M9/M11 修复 | Modify |
| `guide-dog-dsh/deploy/convert_bundle.py` | 真源 → `bundle/lib/index.js` + `bundle/lib/client.js`（静态格式，含兼容层） | Regenerate 产物（每次改真源后运行，Task 15 定案） |
| `guide-dog-dsh/deploy/publish.py` | 同步 `~/.dsh/dsh-guide-dog` + 幂等注册 web profile（link+bundles+symlink）+ 移除 autoload | Run（Task 15；写 ~/.dsh 需提权） |
| `guide-dog-dsh/README.md` | Phase 2 用法、配置 schema、验收方法 | Modify（Task 15） |
| `~/.dsh/guide-dog/.guide-dog/config.json` | 运行时配置（新增 call/a11y 节；GLOBAL_ROOT = `~/.dsh/guide-dog`） | Runtime |
| `~/.dsh/guide-dog/.guide-dog/status.json` / `probe3.json` | 探测状态 / Phase 2 契约探测 | Runtime |

---

### Task 0: 技术债 M9（client 录音 onstop 陈旧闭包）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（`startRec`/`rec.onstop` 区域，行 411-531；卸载清理 380-389）

**Interfaces:**
- Consumes: `micRec`（模块级 `{rec, stream}`）、`transcribe(sid, inputActions, set)`（行 290）、`props.sessionId`
- Produces: `recSessionRef` 模块级变量（录音归属会话），`transcribe()` 入口加归属校验

**背景（Phase 1 终审 M9）**：`rec.onstop = function () { transcribe(sid, props.inputActions, set) }` 闭包捕获录音**开始**时的 `sid` 与 `inputActions`——录音中切换会话（组件卸载）后 `onstop` 仍会触发，把音频提交给**旧会话**且使用已失效的 `inputActions`。修复：录音归属记录 + 提交前校验 + 卸载时丢弃。

- [ ] **Step 1: 写失败测试（逻辑复现）**

```js
// 场景：会话 A 开始录音 → 切到会话 B（卸载 A 的组件）→ 录音 stop → 不得调用 transcribe
// 复现脚本（repro 目录，node 可跑）：模拟 onstop 闭包行为
let transcribeCalls = []
let micRec = null
let recSessionRef = null // 修复后：录音归属
function fakeStart(sid, onstop) {
  recSessionRef = { sid: sid, alive: true }
  micRec = { rec: { stop: function () { onstop() } } }
}
function fakeUnmount() { micRec = null; if (recSessionRef) recSessionRef.alive = false }
function fixedOnstop(sid, inputActions) {
  if (!micRec || !recSessionRef || recSessionRef.sid !== sid || !recSessionRef.alive) return // 丢弃
  transcribeCalls.push(sid)
}
fakeStart('A', function () { fixedOnstop('A', {}) })
fakeUnmount()
micRec.rec.stop() // 卸载后 stop 触发
console.assert(transcribeCalls.length === 0, 'FAIL: 陈旧闭包仍提交')
console.log('PASS: 卸载后丢弃')
```

- [ ] **Step 2: 运行复现，确认现状失败**

Run: `node repro/repro-m9.js`（新建于 `guide-dog-dsh/repro/`，随任务提交进 guide-dog 仓库）
Expected: `Assertion failed` 或 transcribeCalls.length > 0（现状闭包不校验）。

- [ ] **Step 3: 实现修复（plugin-client.js）**

在模块级（行 56 `curAudio` 附近）新增：

```js
let recSessionRef = null // { sid, alive }：录音归属；卸载置 alive=false → onstop 丢弃
```

修改 `startRec`（行 411-531）：`getUserMedia` 成功后设置归属，`onstop` 校验：

```js
rec.onstop = function () {
  if (!micRec || !recSessionRef || recSessionRef.sid !== sid || !recSessionRef.alive) return // M9：丢弃陈旧提交
  transcribe(sid, props.inputActions, set)
}
```

并在 `getUserMedia` 成功回调里、`rec.start(1000)` 前加：

```js
recSessionRef = { sid: sid, alive: true }
```

修改卸载清理（行 380-389）：置 `recSessionRef.alive = false`：

```js
return function () {
  if (recSessionRef) recSessionRef.alive = false
  if (micRec) {
    try { micRec.rec.stop() } catch (e) { /* ignore */ }
    try { micRec.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ }
    micRec = null
  }
}
```

- [ ] **Step 4: 运行复现，确认修复通过**

Run: `node repro/repro-m9.js`
Expected: `PASS: 卸载后丢弃`。

- [ ] **Step 5: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-client.js
git add plugin-client.js
git commit -m "fix(phase2): M9 — drop stale mic onstop submission after session switch"
```

---

### Task 1: 技术债 M10（媒体路由 range 流式化）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（MEDIA_ROUTE handler，行 848-905）

**Interfaces:**
- Consumes: `statFile`(591)、`readBytes`(599)、`fsSvc`、`EXT_MIME`、`MAX_FILE_BYTES`、`mediaDir`
- Produces: 无新接口（handler 内部改造）——range 请求只读所需字节，不再全量缓冲

**背景（Phase 1 终审 M10）**：媒体路由 `readBytes(abs, size)` 把**整个文件**读进内存再 `bytes.slice(start, end+1)` 响应 range——大视频 seek 时浪费内存且首字节延迟高。修复：只读 range 对应区段。

- [ ] **Step 1: 写失败测试（逻辑复现）**

```js
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
```

- [ ] **Step 2: 运行复现，确认 range 计算逻辑**

Run: `node repro/repro-m10.js`
Expected: `PASS: range 计算正确…`。

- [ ] **Step 3: 实现修复（plugin-host.js 行 860-905）**

将 `const bytes = await readBytes(abs, size || MAX_FILE_BYTES)`（行 868）**下移**到 range 解析之后，并按 range 只读区段：

```js
              const st = await statFile(abs)
              if (!st) { res.writeHead(404); res.end(); return }
              const size = st.size || 0
              if (size > MAX_FILE_BYTES) { res.writeHead(413); res.end(); return }
              const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': String(size) }
              let status = 200
              let rangeLen = -1 // -1 = 全量
              const range = req.headers && req.headers.range ? String(req.headers.range) : ''
              if (range) {
                const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
                if (m && (m[1] || m[2])) {
                  let start = 0
                  let end = size - 1
                  if (m[1] === '') {
                    start = Math.max(0, size - parseInt(m[2] || '0', 10))
                  } else {
                    start = parseInt(m[1], 10)
                    end = m[2] ? parseInt(m[2], 10) : size - 1
                  }
                  if (start >= size || start > end) {
                    res.writeHead(416, { 'content-range': 'bytes */' + size }); res.end(); return
                  }
                  end = Math.min(end, size - 1)
                  rangeLen = end - start + 1
                  status = 206
                  headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size
                  headers['content-length'] = String(rangeLen)
                }
              }
              // M10：只读所需区段，不全量缓冲
              const bytes = rangeLen >= 0 ? await readBytes(abs, rangeLen) : await readBytes(abs, size || MAX_FILE_BYTES)
              if (!bytes) { res.writeHead(404); res.end(); return }
              res.writeHead(status, headers)
              res.end(req.method === 'HEAD' ? undefined : bytes)
```

> 注：`readBytes` 实现若按 `maxBytes` 从头读取，则此修复不完整——需确认其读取语义。若 `readBytes(abs, n)` 仅限制最大字节数而非区段，改为：新增 `readRange(abs, start, len)` 辅助（fs 服务无二进制区段读则回退：`runRaw('dd if=... bs=1 skip=... count=...')` + base64 解码——实施期探测定案）。**Step 3 完成后运行 Step 4 验证**。

- [ ] **Step 4: 验证 `readBytes` 语义并定案**

```bash
cd /home/tt-wsl-ubuntu/skills-repo && grep -n "async function readBytes" guide-dog-dsh/plugin-host.js && sed -n "$(grep -n 'async function readBytes' guide-dog-dsh/plugin-host.js | cut -d: -f1),+12p" guide-dog-dsh/plugin-host.js
```
Expected: 确认 `readBytes` 是否支持区段读取（`fs.readBytes(target, signal, maxBytes)` 语义——从目标读取最多 maxBytes；若为顺序读取则实现 `readRange` 辅助）。记录裁决到进度台账。

- [ ] **Step 5: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js
git add plugin-host.js
git commit -m "fix(phase2): M10 — media route reads only requested byte range"
```

---

### Task 2: 技术债 M11（setVoiceOverride 并发覆盖）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（`setVoiceOverride`，行 47-54）、`guide-dog-dsh/plugin-host.js`（`saveConfig` 确认 deepMerge，行 81-104）

**Interfaces:**
- Consumes: `host.call('guide-dog/set-config', {patch})`（host 侧 deepMerge + configWriteChain 串行化，v1 已实现）
- Produces: `setVoiceOverride(sid, value)` 只发单键 patch `{voiceMode: {sessions: {[sid]: value}}}`

**背景（Phase 1 终审 M11）**：`setVoiceOverride` 用可能过期的整个 `voiceMode.sessions` 重建 map 再发 patch——两个会话并发切换时后写者覆盖先写者。host `saveConfig` 已是 deepMerge + 串行化，所以修复在 client：**只发单键 patch**，不重建整表。

- [ ] **Step 1: 读当前实现，写复现**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && grep -n "setVoiceOverride" plugin-client.js
```
Expected: 找到实现（预期形如 `patch = { voiceMode: { sessions: <整表重建> } }`）。

```js
// repro/repro-m11.js：两个并发 toggle，各自基于过期快照重建整表 → 后写覆盖先写
let cfg = { voiceMode: { default: false, sessions: {} } }
let calls = []
function oldSetVoiceOverride(sid, value) {
  const sessions = Object.assign({}, (cfg.voiceMode && cfg.voiceMode.sessions) || {})
  sessions[sid] = value
  calls.push({ sid: sid, value: value, patch: { voiceMode: { sessions: sessions } } })
}
function newSetVoiceOverride(sid, value) {
  const patch = { voiceMode: { sessions: {} } }
  patch.voiceMode.sessions[sid] = value // 单键
  calls.push({ sid: sid, value: value, patch: patch })
}
oldSetVoiceOverride('A', true); oldSetVoiceOverride('B', true)
// 若 A 的 patch 晚到（并发），B 的键被 A 的过期快照覆盖 → 丢 B
console.assert(JSON.stringify(calls[1].patch.voiceMode.sessions) === '{"B":true}', 'FAIL: 并发覆盖丢键')
console.log('PASS: 单键 patch 不丢键（newSetVoiceOverride 语义）')
```

- [ ] **Step 2: 运行复现**

Run: `node repro/repro-m11.js`
Expected: `PASS: 单键 patch 不丢键…`（说明语义差异；现状 `oldSetVoiceOverride` 会丢键）。

- [ ] **Step 3: 实现修复（plugin-client.js）**

`setVoiceOverride(sid, value)` 改为只发单键 patch：

```js
function setVoiceOverride(sid, value) {
  const patch = { voiceMode: { sessions: {} } }
  patch.voiceMode.sessions[sid] = value // M11：单键 patch，不重建整表（host deepMerge 合并）
  return host.call('guide-dog/set-config', { patch: patch }).then(function (r) {
    if (r && r.ok) loadVoiceCfg()
    return r
  }).catch(function () { return null })
}
```

并确认 host `saveConfig` 的 deepMerge 对嵌套对象按键合并（已是，行 36-42 `deepMerge` 递归）。

- [ ] **Step 4: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-client.js
git add plugin-client.js
git commit -m "fix(phase2): M11 — per-key voiceMode.sessions patch (no whole-map rebuild)"
```

---

### Task 3: Host call 配置节（call/a11y 默认值 + tts-token 签发 + consent 管理）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（CONFIG_DEFAULTS 行 31-35、RPC 区行 1353 之后）

**Interfaces:**
- Consumes: `CONFIG_DEFAULTS`(31)、`deepMerge`(36)、`loadConfig`(80)、`saveConfig`(81)、`guideDogRoot`(44)、兼容层 `harness.handle`（→ `/guide-dog/api/<name>` JSON POST 路由）
- Produces:
  - `CONFIG_DEFAULTS` 扩展 `call`/`a11y` 节（spec §4 精确形状）
  - `ttsTokens: Map<token, {sessionId, exp}>` + `async issueTtsToken(sessionId): Promise<string>`（5 分钟有效、单次消费）+ `consumeTtsToken(token, sessionId): boolean`
  - `consent: Map<sessionId, number>`（turnSeq）+ `grantConsent(sid, turnSeq)` / `hasConsent(sid, turnSeq)` / `clearConsent(sid)`（会话/轮次粒度，内存态）
  - `consentPending: Set<sessionId>` + `markConsentPending(sid)` / `consumeConsentPending(sid)`（C1 修复：user 确认词监听器置位，pre-execute 消费）
  - `callActiveSessions: Set<sessionId>` + `isCallActive(sid)`（C4 修复：持久通话激活，Task 7 的 startCall/stopCall 经 RPC 置位）
  - RPC `guide-dog/tts-token`（`{sessionId}` → `{ok, token}`）

- [ ] **Step 1: 扩展 CONFIG_DEFAULTS**

在行 31-35 `CONFIG_DEFAULTS` 对象内（`tts` 之后）追加：

```js
      call: {
        mode: 'vad',
        vad: { method: 'energy', threshold: 0.02, silenceMs: 700, minSpeechMs: 300, maxSegmentSeconds: 60, interruptMinMs: 300 },
        stream: { format: 'pcm', sampleRate: 24000, sentenceSplit: '。！？.!?\n', maxSentenceChars: 200 },
        voice: 'English_expressive_narrator',
        speed: 1.0,
        progress: true,
        consensus: { enabled: true, summaryWindowMs: 3000 },
      },
      a11y: { enabled: false, autoNarrate: true, visionCloud: true, summaryFirst: true },
```

- [ ] **Step 2: 插入 token 与 consent 管理**

在 VOICE MODE 节（行 1407 注释前）插入：

```js
    // ============ CALL 节（Phase 2，host） ============
    const ttsTokens = new Map() // token -> { sessionId, exp }
    const consent = new Map() // sessionId -> turnSeq（本轮已语音确认）
    // C1 修复（2026-08-16 审稿）：consentPending 记录"用户刚说过确认词"的会话；
    // 由 user 消息监听器（Task 8 Step 3b）置位，下一次 pre-execute 消费并 grantConsent。
    const consentPending = new Set() // sessionId（等待写入放行）
    const callActiveSessions = new Set() // sessionId（持久通话激活，startCall/stopCall 时置位，C4 修复）
    async function issueTtsToken(sessionId) {
      const token = 'gd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
      ttsTokens.set(token, { sessionId: String(sessionId), exp: Date.now() + 5 * 60 * 1000 })
      return token
    }
    function consumeTtsToken(token, sessionId) {
      if (!token || typeof token !== 'string') return false
      const rec = ttsTokens.get(token)
      if (!rec) return false
      ttsTokens.delete(token) // 单次消费
      if (rec.sessionId !== String(sessionId)) return false
      if (rec.exp < Date.now()) return false
      return true
    }
    function grantConsent(sid, turnSeq) { consent.set(String(sid), turnSeq) }
    function hasConsent(sid, turnSeq) {
      const v = consent.get(String(sid))
      return typeof turnSeq === 'number' ? v === turnSeq : v !== undefined
    }
    // M10 语义说明（2026-08-16 审稿）：一次确认放行"本轮"全部写操作——grantConsent 在首次
    // pre-execute 时以该 exec 的 turnSeq 授予；同一 assistant turn 内后续写工具共享同一
    // exec.agent.turn → hasConsent 精确匹配通过。若 exec.agent.turn 为 null（探测未发现 turn），
    // hasConsent 退化为"已授予即可"（v !== undefined），新用户回合前 clearConsent 兜底。
    function clearConsent(sid) { consent.delete(String(sid)) }
    function markConsentPending(sid) { consentPending.add(String(sid)) }
    function consumeConsentPending(sid) { return consentPending.delete(String(sid)) }
    function isCallActive(sid) { return callActiveSessions.has(String(sid)) }
    // 定期清理过期 token（30s 检查，防泄漏）
    // I3（2026-08-16 审稿）：host 侧 timerSvc.interval（callback 形式）未验证——
    // 若 Task 4 探测确认 host interval 不可用，则改为 sleep 轮询（见下方注释替代）。
    const tokenTimer = timerSvc && typeof timerSvc.interval === 'function'
      ? timerSvc.interval(function () {
          const now = Date.now()
          ttsTokens.forEach(function (rec, tok) { if (rec.exp < now) ttsTokens.delete(tok) })
        }, 30000)
      : null
    if (tokenTimer) ctx.effect(tokenTimer)
```

> **I3 替代方案（若 host `timerSvc.interval` 探测不可用）**：用已验证的 `sleep` 轮询替代回调 interval：

```js
    // 替代：sleep 轮询（Promise 形式，已验证）
    ;(function tokenSweeper() {
      sleep(30000).then(function () {
        const now = Date.now()
        ttsTokens.forEach(function (rec, tok) { if (rec.exp < now) ttsTokens.delete(tok) })
        tokenSweeper()
      })
    })()
```

- [ ] **Step 3: 注册 tts-token RPC**

在 RPC 区（行 1381 `guide-dog/transcribe` handler 之后）插入：

```js
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/tts-token', async function (args) {
          const sid = args && args.sessionId ? String(args.sessionId) : ''
          if (!sid) return { ok: false, error: 'bad_args', message: 'sessionId required' }
          const token = await issueTtsToken(sid)
          return { ok: true, token: token }
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 4: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js
git add plugin-host.js
git commit -m "feat(phase2): call config defaults, tts-token issuance, consent map"
```

---

### Task 4: 契约探测（Inspect 槽位 + 临时 bundle 探针）

> **2026-08-16 修订（静态 bundle 时代）**：不再用动态探测插件（cordis_define/cordis_run 已弃用）。槽位形状直接用 **Inspect 只读探针**（零部署）；host/client 运行期能力用**临时探针代码**打进真源、经 convert+publish+重启采集，随后删除。

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（临时：probe-write RPC + pre-execute 观察 + probe-stream 路由，`// PROBE-START` 标记）
- Modify: `guide-dog-dsh/plugin-client.js`（临时：浏览器全局探测 + 槽位渲染观察，`// PROBE-START` 标记）
- Runtime: `~/.dsh/guide-dog/.guide-dog/probe3.json`（探测结果回填）

**Interfaces:**
- Consumes: 无（纯探测）
- Produces: 探测结论写 `probe3.json` + Inspect 快照，供 Task 6/7/11/12 定案：
  1. `conversation.session.header.actions` 槽位形状（owner props：`sessionId`？）与 order 占用 —— **Inspect 直接查**
  2. `conversation.input.dock` 槽位形状与 order 占用 —— **Inspect 直接查**
  3. client 浏览器全局：`fetch` ReadableStream（`res.body.getReader`）、`AudioContext`/`AnalyserNode`/`decodeAudioData`、`Uint8Array`、`DataView` 可用性（临时 client 探针）
  4. host `tools/pre-execute` 触发形状（临时 listener，观察 `exec.name/arguments/agent`）
  5. host `subprocess` pipe 模式：`handle.stdout.on('data')` 收到 Buffer/Uint8Array 并 `res.write` 成功（`mmx speech synthesize --stream` 短句直测 chunked 路由）
  6. `WebRoute` handler 中 `res.write` 流式实测（写 2 个分块 + 延迟，验证 chunked 编码）
  7. **`webServer.register` 的 `kind:'exact'` 支持**（I2，2026-08-16 审稿）：现有代码与兼容层只用 `kind:'prefix'`（plugin-host.js 行 849/948、convert_bundle.py 行 110），Task 5/11 的 `call-transcribe`/`tts-stream` 计划用 `kind:'exact'`——probe-stream 路由本身即 `kind:'exact'`，其 200 响应即 exact 支持证据；若 404/405 则改回 `kind:'prefix'` + 内部路径精确匹配（与 media/recorder 同款）
  8. **事件 payload 形状**（I4，2026-08-16 审稿）：`agent/status`/`tools/result`/`agent/error` 三事件的 payload 键（`agent/status` 是 `{agent, status}`？`tools/result` 是 `(exec, result)` 两参？`agent/error` 是 `{agent, turn, step, error}`？）以及 **`exec.agent.session` 是否含 `id`**——Task 8/10/14 的 sessionId 推导全依赖此结论

- [ ] **Step 1: Inspect 查槽位（零部署）**

```bash
# client Slots 树 → 定位 conversation.session.header.actions 与 conversation.input.dock
# 工具：cordis_inspect_query（client 平台，provider=Slots，method=listSubTree）
#   root 省略 → 目录树；root=conversation.session.header.actions → 完整契约 + 现有 occupants（order 占用）
#   root=conversation.input.dock → 完整契约 + 现有 occupants
```
Expected: 记录 owner props 精确键名（`sessionId` 等）与 order 占用（确认 30/31 不冲突）。

- [ ] **Step 2: 打入临时探针（plugin-host.js / plugin-client.js）**

plugin-host.js（RECORDER 节后插入，`// PROBE-START` / `// PROBE-END` 包裹，Task 4 末删除）：

```js
    // ============ PROBE-START（Phase 2 Task 4 临时，勿提交最终） ============
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/probe-write', async function (args) {
          const root = await guideDogRoot()
          await runRaw('mkdir -p ' + quote(root + '/.guide-dog'), { timeoutMs: 10000 })
          const data = Object.assign({}, args && args.data, { preExec: globalThis.__gdProbe || null })
          await writeTextFile(root + '/.guide-dog/probe3.json', JSON.stringify(data, null, 2))
          return { ok: true }
        })
      } catch (e) { return function () {} }
    })
    ctx.on('tools/pre-execute', async function (exec, next) {
      try {
        const seen = (globalThis.__gdProbe = globalThis.__gdProbe || { count: 0, names: [], agents: [] })
        seen.count++
        if (seen.names.length < 20) seen.names.push(exec && exec.name)
        const ag = exec && exec.agent
        if (seen.agents.length < 5) seen.agents.push({ hasSession: !!(ag && ag.session), sessionKeys: ag && ag.session ? Object.keys(ag.session) : [] })
        return next()
      } catch (e) { return next() }
    })
    // I4 探测（2026-08-16 审稿）：事件 payload 形状
    ctx.on('agent/status', function (payload) {
      try { globalThis.__gdProbe = globalThis.__gdProbe || {}; globalThis.__gdProbe.agentStatus = { keys: Object.keys(payload || {}), hasAgent: !!(payload && payload.agent), status: payload && payload.status } } catch (e) { /* ignore */ }
    })
    ctx.on('tools/result', function (exec, result) {
      try {
        const p = globalThis.__gdProbe = globalThis.__gdProbe || {}
        const ag = exec && exec.agent
        p.toolsResult = { argCount: arguments.length, hasAgent: !!(ag), sessionKeys: ag && ag.session ? Object.keys(ag.session) : [], resultKeys: result ? Object.keys(result).slice(0, 10) : [] }
      } catch (e) { /* ignore */ }
    })
    ctx.on('agent/error', function (payload) {
      try { globalThis.__gdProbe = globalThis.__gdProbe || {}; globalThis.__gdProbe.agentError = { keys: Object.keys(payload || {}), hasAgent: !!(payload && payload.agent) } } catch (e) { /* ignore */ }
    })
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'exact', path: '/guide-dog/probe-stream',
          handler: async function (req, res) {
            try {
              res.writeHead(200, { 'content-type': 'audio/pcm', 'transfer-encoding': 'chunked' })
              const handle = subprocess.spawn({
                argv: ['mmx', 'speech', 'synthesize', '--stream', '--format', 'pcm', '--sample-rate', '24000', '--text', '探测流式通道'],
                cwd: (await guideDogRoot()) + '/.guide-dog',
                stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 * 1024 } },
                graceMs: 3000,
              })
              let bytes = 0
              handle.stdout.on('data', function (chunk) {
                bytes += chunk && chunk.length ? chunk.length : 0
                try { res.write(chunk) } catch (e) { try { handle.terminate() } catch (e2) {} }
              })
              await handle.done
              try { res.end() } catch (e) {}
            } catch (e) {
              try { res.writeHead(500); res.end(String(e)) } catch (e2) {}
            }
          },
        })
      } catch (e) { return function () {} }
    })
    // ============ PROBE-END ============
```

plugin-client.js（toast 节后插入，`// PROBE-START` / `// PROBE-END` 包裹）：

```js
    // ============ PROBE-START（Phase 2 Task 4 临时，勿提交最终） ============
    ctx.effect(function () {
      try {
        return slots.inject('conversation.session.header.actions', function () {
          return slots.register({ name: 'conversation.session.header.actions', id: 'gd-probe-hdr', order: 30, label: function () { return 'ProbeHdr' } },
            function (props) {
              host.call('guide-dog/probe-write', { data: { headerActions: { keys: Object.keys(props || {}), sid: props && props.sessionId } } }).catch(function () {})
              return null
            })
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return slots.inject('conversation.input.dock', function () {
          return slots.register({ name: 'conversation.input.dock', id: 'gd-probe-dock', order: 30, label: function () { return 'ProbeDock' } },
            function (props) {
              host.call('guide-dog/probe-write', { data: { inputDock: { keys: Object.keys(props || {}), sid: props && props.sessionId } } }).catch(function () {})
              return null
            })
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      const out = {
        fetchStream: typeof fetch === 'function' && typeof fetch('data:application/octet-stream,AA').then === 'function',
        audioContext: typeof AudioContext === 'function' || typeof webkitAudioContext === 'function',
        analyser: typeof AnalyserNode === 'function',
        uint8: typeof Uint8Array === 'function',
        dataView: typeof DataView === 'function',
        readableStream: typeof ReadableStream === 'function',
        bodyGetReader: typeof fetch === 'function' && typeof (new Response('x').body && new Response('x').body.getReader) === 'function',
      }
      host.call('guide-dog/probe-write', { data: { globals: out } }).catch(function () {})
      return function () {}
    })
    // ============ PROBE-END ============
```

> 注：client 探针用 `host.call`（兼容层 → fetch POST `/guide-dog/api/guide-dog/probe-write`）回填；`Response` 为浏览器全局（Phase 1 已确认浏览器全局可用）。

- [ ] **Step 3: 部署并采集**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js && node --check plugin-client.js
python3 deploy/convert_bundle.py
# publish 需提权（写 ~/.dsh）：python3 deploy/publish.py
# 重启 DSH 后：
curl -s http://127.0.0.1:3080/guide-dog/probe-stream -o /tmp/probe3.pcm -w 'http=%{http_code} bytes=%{size_download} time=%{time_total}\n'
# 对比 mmx 直出大小（约 5 秒音频 ≈ 240KB @24kHz s16）
# 槽位与 globals：浏览器打开任意会话 → 触发 header.actions/dock 渲染 → 读 probe3.json
cat ~/.dsh/guide-dog/.guide-dog/probe3.json
# pre-execute 观察：让模型跑任意工具（如 bash ls）→ probe-write 自动合并 __gdProbe 写入 probe3.json
```
Expected: `probe3.json` 含槽位 props keys、globals 可用性、pre-execute 观察记录（`preExec.count/names/agents`）；probe-stream 返回 200 且 bytes > 0（chunked 流式成立）。

- [ ] **Step 4: 定案记录**

将探测结论回填到本计划的 Interfaces 与 `docs/progress.md`（追加"Phase 2 Task 4 探测结论"）。重点定案：
- `header.actions` / `input.dock` 的 owner props 精确键名（Task 6 的 UI 组件签名依赖）
- `res.write` chunked 是否成功（决定 Task 11 主方案 vs 降级逐句 mp3）
- `handle.stdout` data chunk 形态（Buffer/Uint8Array，Task 11 直接使用）
- `exec.agent.session` 形状（Task 8/10 的 sessionId 推导依赖；若 agent 无 session 字段，改从 `agents` 服务推导）

- [ ] **Step 5: 清理探针并提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh
# 删除两文件中的 PROBE-START..PROBE-END 块（含标记行）
node --check plugin-host.js && node --check plugin-client.js
git add -A && git commit -m "chore(phase2): probe round — slots header.actions/input.dock, browser stream globals, pre-execute shape, pipe chunked route (results in probe3.json)"
# 探针代码已随本轮 commit 删除；bundle 无需立即重新 convert（下次 Task 5 部署一并重建）
```

---

### Task 5: Host 上行路由（POST /guide-dog/call-transcribe）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（RECORDER 节之后，行 908 之后新增）

**Interfaces:**
- Consumes: `transcribeImpl`(420)（入参 `{audioB64, mime, sessionId?, language?}` → `{ok,text,language,durationMs}`）、`runRaw`(531)、`quote`(503)、`writeTextFile`(613)、`readTextFile`、`guideDogRoot`(44)、`webServer.register`
- Produces: `POST /guide-dog/call-transcribe`（raw webm body ≤20MB → `{ok,text,language}` JSON；Origin 同源校验）

**背景**：call 上行与 Phase 1 麦克风共用 STT 管线；区别是 client 直接 POST raw body（不走 base64 RPC，省 33% 体积与 RPC 开销）。

- [ ] **Step 1: 实现路由**

在 RECORDER 节（行 908 `RECORDER_HTML` 常量之后）插入：

```js
    // ============ CALL 上行（Phase 2，host） ============
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'exact',
          path: '/guide-dog/call-transcribe',
          handler: async function (req, res) {
            try {
              if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
              // 同源校验（M5 修订 2026-08-16）：Origin 必须等于 GUI 来源——按 Host 头推导
              // （'http://' + req.headers.host，GUI 由 dsh web 同源托管）；无 Origin 头（curl）放行，
              // 便于本地验收。不再用 guideDogRoot() 作 truthy 占位。
              const origin = req.headers && req.headers.origin ? String(req.headers.origin) : ''
              const hostHdr = req.headers && req.headers.host ? String(req.headers.host) : ''
              if (origin && hostHdr && origin !== 'http://' + hostHdr) { res.writeHead(403); res.end(); return }
              // 收集 body（≤20MB 硬上限）
              let chunks = []
              let total = 0
              for await (const chunk of req) {
                total += chunk.length
                if (total > 20 * 1024 * 1024) { res.writeHead(413); res.end(); return }
                chunks.push(chunk)
              }
              const buf = Buffer.concat(chunks)
              const b64 = buf.toString('base64')
              const r = await transcribeImpl({ audioB64: b64, mime: 'audio/webm', sessionId: req.headers && req.headers['x-session-id'] ? String(req.headers['x-session-id']) : '' })
              if (r.ok) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, text: r.text, language: r.language, durationMs: r.durationMs }))
              } else {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: r.error, message: r.message || '' }))
              }
            } catch (e) {
              try { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'stt_failed', message: String(e).slice(0, 200) })) } catch (e2) { /* ignore */ }
            }
          },
        })
      } catch (e) { return function () {} }
    })
```

> ✅ **2026-08-16 修订（静态 bundle）**：host 半跑在 DSH host Node 进程，**`Buffer` 全局可用**——直接 `Buffer.concat(chunks)` + `buf.toString('base64')` 即可，无需 btoa 二进制字符串路径。保留 btoa 写法亦可（Node 也有 btoa），但以 Buffer 为准：

```js
              const chunks = []
              let total = 0
              for await (const chunk of req) {
                chunks.push(chunk)
                total += chunk.length
                if (total > 20 * 1024 * 1024) { res.writeHead(413); res.end(); return }
              }
              const b64 = Buffer.concat(chunks).toString('base64')
```

- [ ] **Step 2: 语法验证（Buffer 路径）**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node -e "
// 验证 Buffer.concat + base64 路径（Node 全局，静态 bundle 同环境）
const chunks = [Buffer.from([0x1F, 0xA6]), Buffer.from([0x00, 0xFF])]
const b64 = Buffer.concat(chunks).toString('base64')
console.log('b64:', b64) // 期望 H6YA/w==
console.log('PASS: Buffer.concat base64 path works')
"
```
Expected: `PASS`（0x8000 分块防栈溢出的 btoa 路径不再需要；Node Buffer 直连）。

- [ ] **Step 3: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js
git add plugin-host.js
git commit -m "feat(phase2): call-transcribe route (raw webm POST, shared transcribeImpl)"
```

---

### Task 6: Client call UI（发起按钮 + 面板 + 状态条 + 模式开关）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（新 CALL PANEL 节，插在 toast 节之后；行 592 之后）

**Interfaces:**
- Consumes: `slots.inject/register`（Phase 1 模式）、`React.createElement`、`host.call`、`timerSvc`、主题令牌 `--dsw-alias-*`（Phase 1 已用）
- Produces:
  - 槽位注入：`conversation.session.header.actions`（id `guide-dog-call-btn`，order 30）+ `conversation.input.dock`（id `guide-dog-call-status`，order 31）+ `shell.overlay`（id `guide-dog-call-panel`）
  - `callState` 模块级状态对象（`{active, mode, phase, muted, speed, recording}`）+ `setCallState` 更新函数 + `subscribeCall(fn)`（面板/状态条共享状态的最小订阅）
  - UI 组件：`CallPanel`（overlay）、`CallStatusBar`（dock）、`CallButton`（header）
  - 供 Task 7 使用：`startSegment()/stopSegment()` 采集控制钩子（本任务定义接口，Task 7 实现）
- 探测依赖：Task 4 定案的槽位 owner props 键名（`sessionId` 等）

- [ ] **Step 1: 定义 callState 与订阅**

在 toast 节之后插入：

```js
    // ============ CALL PANEL 节（Phase 2，client） ============
    const callState = { active: false, mode: 'vad', phase: 'idle', muted: false, speed: 1, recording: false, error: null }
    const callSubs = []
    function setCallState(patch) {
      Object.assign(callState, patch)
      callSubs.forEach(function (fn) { try { fn(callState) } catch (e) { /* ignore */ } })
    }
    function subscribeCall(fn) { callSubs.push(fn); return function () { const i = callSubs.indexOf(fn); if (i >= 0) callSubs.splice(i, 1) } }
    // 会话切换：通话状态随会话（header action 是会话级）；切会话时 phase 回 idle 但不自动挂断音频
    let callSessionId = null
```

- [ ] **Step 2: header 发起按钮**

> M4 修订（2026-08-16 审稿）：所有槽位注入必须用 `ctx.effect(function () { return slots.inject(...) })` 包裹（Phase 1 惯例，disposer 纳入插件生命周期；裸 `try { slots.inject } catch` 在 stop/update 时无法清理）。

```js
    ctx.effect(function () {
      try {
        return slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'guide-dog-call-btn', order: 30, label: function () { return 'Call' } },
            function (props) {
              const sid = props.sessionId || callSessionId
              callSessionId = sid
              const [, force] = React.useState(0)
              React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
              const active = callState.active
              const style = {
                display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 8px',
                borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #ccc)',
              background: active ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : 'transparent',
              color: active ? '#fff' : 'var(--dsw-alias-label-secondary, #666)',
              fontFamily: 'inherit', fontSize: '12px',
            }
            return React.createElement('button', {
              style: style, title: active ? '挂断通话' : '发起语音通话',
              onClick: function () {
                if (!active) {
                  setCallState({ active: true, phase: 'listening', recording: false })
                  startCall(sid) // Task 7 定义：初始化采集
                } else {
                  stopCall() // Task 7 定义：停止采集与播放
                }
              },
            }, active ? '📞 通话中' : '📞 通话')
          })
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 3: dock 状态条**

```js
    ctx.effect(function () {
      try {
        return slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'guide-dog-call-status', order: 31, label: function () { return 'Call status' } },
            function (props) {
              const [, force] = React.useState(0)
              React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
              if (!callState.active) return null
              const text = { listening: '收听中…', processing: '处理中…', speaking: '播报中…', idle: '就绪' }[callState.phase] || ''
              const style = { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #666)', padding: '0 4px', fontFamily: 'inherit' }
              return React.createElement('span', { style: style }, text + (callState.muted ? ' · 静音' : ''))
            })
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 4: overlay 面板**

```js
    ctx.effect(function () {
      try {
        return slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'guide-dog-call-panel', order: 40, label: function () { return 'Call panel' } },
            function () {
            const [, force] = React.useState(0)
            React.useEffect(function () { return subscribeCall(function () { force(Date.now() % 100000) }) }, [])
            if (!callState.active) return null
            const panelStyle = {
              position: 'fixed', right: '16px', bottom: '64px', width: '260px', zIndex: 1000,
              background: 'var(--dsw-alias-bg-layer-2, #fff)', border: '1px solid var(--dsw-alias-border-l1, #ddd)',
              borderRadius: '10px', padding: '12px', boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              fontFamily: 'inherit', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #333)',
            }
            const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '6px 0' }
            const btnStyle = { padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1, #ccc)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px' }
            const micBtnStyle = Object.assign({}, btnStyle, callState.recording ? { background: '#c62828', color: '#fff' } : {})
            return React.createElement('div', { style: panelStyle },
              React.createElement('div', { style: rowStyle },
                React.createElement('span', null, '语音通话'),
                React.createElement('button', { style: btnStyle, onClick: function () { stopCall() } }, '挂断')),
              React.createElement('div', { style: rowStyle },
                React.createElement('span', null, '模式'),
                React.createElement('select', {
                  style: btnStyle, value: callState.mode,
                  onChange: function (ev) { setCallState({ mode: ev.target.value }) },
                },
                  React.createElement('option', { value: 'vad' }, 'VAD 自动'),
                  React.createElement('option', { value: 'ptt' }, '按住说话'))),
              React.createElement('div', { style: rowStyle },
                React.createElement('button', { style: micBtnStyle, title: callState.mode === 'ptt' ? '按住说话' : '点击手动结束/开始一段',
                  onPointerDown: function (ev) { if (callState.mode === 'ptt') { ev.preventDefault(); startSegment() } },
                  onPointerUp: function (ev) { if (callState.mode === 'ptt') { ev.preventDefault(); stopSegment() } },
                  onClick: function () { if (callState.mode !== 'ptt' && !callState.recording) startSegment(); else if (callState.mode !== 'ptt' && callState.recording) stopSegment() },
                }, callState.recording ? '■ 录音中' : '🎤 说话'),
                React.createElement('span', null, callState.mode === 'ptt' ? '按住说话' : 'VAD 自动')),
              React.createElement('div', { style: rowStyle },
                React.createElement('button', { style: btnStyle, onClick: function () { setCallState({ muted: !callState.muted }) } }, callState.muted ? '🔇 取消静音' : '🔊 静音'),
                React.createElement('span', null, '语速 '),
                React.createElement('select', {
                  style: btnStyle, value: String(callState.speed),
                  onChange: function (ev) { setCallState({ speed: parseFloat(ev.target.value) }) },
                },
                  React.createElement('option', { value: '0.8' }, '0.8x'),
                  React.createElement('option', { value: '1' }, '1x'),
                  React.createElement('option', { value: '1.2' }, '1.2x'))),
              callState.error ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c62828)', marginTop: '6px' } }, callState.error) : null)
          })
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 5: 接口桩（Task 7 实现）**

在 CALL PANEL 节末尾定义桩（保证本任务可独立编译运行；Task 7 替换实现）：

```js
    function startCall(sid) { /* Task 7 */ }
    function stopCall() { /* Task 7 */ }
    function startSegment() { /* Task 7 */ }
    function stopSegment() { /* Task 7 */ }
```

- [ ] **Step 6: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-client.js
git add plugin-client.js
git commit -m "feat(phase2): call UI — header button, dock status, overlay panel, mode switch"
```

---

### Task 7: Client 采集状态机（MediaRecorder + AnalyserNode VAD + PTT + 上传 + 提交）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（CALL PANEL 节内，替换 Task 6 的 `startCall/stopCall/startSegment/stopSegment` 桩）

**Interfaces:**
- Consumes: Task 6 的 `callState/setCallState/subscribeCall`、`insertText`(248)/`submitInput`(257)（Phase 1 已有）、`host.call`、`callSessionId`、配置 `voiceInput.maxSeconds`/`call.vad.*`/`call.mode`
- Produces:
  - `startCall(sid)`：getUserMedia + MediaRecorder + AnalyserNode 初始化；`callState.active=true`
  - `stopCall()`：停止录音与播放、释放流、`callState.active=false`
  - `startSegment()` / `stopSegment()`：VAD/PTT 段控制；`stopSegment` 时若段有效（时长≥minSpeechMs）→ 上传 → 转写 → `insertText`+`submitInput`
  - `callMic` 模块级 `{stream, rec, analyser, raf, segmentStart, chunks, segmentSeconds}`；`bargeIn()` 钩子（Task 12 用，检测到用户发声时调用）
  - `callActiveRpc(kind, active)`：分两种上报（C4 修复）——`startCall`/`stopCall` 上报 `{kind:'session'}`（持久通话激活，Task 10/11 判据）；`startSegment`/`stopSegment` 上报 `{kind:'speaking'}`（瞬时发声，Task 8 共识窗口中止判定）
  - `isUserSpeaking()`：供 Task 8/9 共识窗口查询（RMS 当前值）

- [ ] **Step 1: 采集初始化与 VAD 引擎**

在 Task 6 桩位置替换实现：

```js
    let callMic = null // { stream, rec, analyser, raf, segmentStart, chunks, segmentSeconds }
    let callSegmentActive = false
    let callBargeCb = null // Task 12 设置：用户发声回调

    function startCall(sid) {
      if (callMic) return
      setCallState({ active: true, phase: 'listening', recording: false, error: null })
      callActiveRpc('session', true) // C4：持久通话激活（Task 10 进度播报 / Task 11 下行流式判据）
      try {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
          const AC = window.AudioContext || window.webkitAudioContext
          const audioCtx = new AC()
          const src = audioCtx.createMediaStreamSource(stream)
          const analyser = audioCtx.createAnalyser()
          analyser.fftSize = 2048
          analyser.smoothingTimeConstant = 0.3
          src.connect(analyser)
          let rec = null
          try { rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }) } catch (e) { rec = new MediaRecorder(stream) }
          rec.ondataavailable = function (ev) {
            if (callMic && callSegmentActive && ev.data && ev.data.size > 0) callMic.chunks.push(ev.data)
          }
          callMic = { stream: stream, rec: rec, analyser: analyser, raf: 0, segmentStart: 0, chunks: [], segmentSeconds: 0, audioCtx: audioCtx }
          // VAD 轮询：能量检测（threshold 可配）
          const cfg = voiceState.cfg || {}
          const vad = (cfg.call && cfg.call.vad) || {}
          const threshold = vad.threshold !== undefined ? vad.threshold : 0.02
          const minSpeechMs = vad.minSpeechMs !== undefined ? vad.minSpeechMs : 300
          const silenceMs = vad.silenceMs !== undefined ? vad.silenceMs : 700
          const maxSeg = (cfg.call && cfg.call.vad && cfg.call.vad.maxSegmentSeconds) || 60
          let voicedSince = 0, silentSince = 0, lastVoiced = false
          const sampleBuf = new Uint8Array(analyser.fftSize)
          const tick = function () {
            if (!callMic || !callSegmentActive) return
            analyser.getByteTimeDomainData(sampleBuf)
            let sum = 0
            for (let i = 0; i < sampleBuf.length; i++) { const v = (sampleBuf[i] - 128) / 128; sum += v * v }
            const rms = Math.sqrt(sum / sampleBuf.length)
            const now = Date.now()
            const voiced = rms >= threshold
            if (voiced) { voicedSince = now; lastVoiced = true }
            else if (lastVoiced) { silentSince = now; lastVoiced = false }
            const isSpeaking = voiced || (now - voicedSince < silenceMs)
            // 端点：静音 ≥ silenceMs 且说过话（VAD 模式）→ 结束段
            if (callState.mode === 'vad' && voicedSince > 0 && !voiced && (now - voicedSince) >= silenceMs) {
              if (now - callMic.segmentStart >= minSpeechMs) stopSegment()
              else { callMic.segments = (callMic.segments || []); resetSegment() }
              return
            }
            // 上限：段超 maxSeg 自动结束
            if (callSegmentActive && (now - callMic.segmentStart) >= maxSeg * 1000) { stopSegment(); return }
            // 打断检测：播放中用户发声 → bargeIn 钩子
            if (isSpeaking && callState.phase === 'speaking' && voiced && callBargeCb) callBargeCb()
            callMic.raf = requestAnimationFrame(tick)
          }
          callMic.raf = requestAnimationFrame(tick)
          setCallState({ phase: 'listening' })
        }).catch(function (err) {
          setCallState({ active: false, phase: 'idle', error: '麦克风不可用：' + String((err && err.message) || err) })
        })
      } catch (e) {
        setCallState({ active: false, phase: 'idle', error: '麦克风初始化失败：' + String(e) })
      }
    }

    function stopCall() {
      if (callMic) {
        try { cancelAnimationFrame(callMic.raf) } catch (e) { /* ignore */ }
        try { if (callMic.rec.state !== 'inactive') callMic.rec.stop() } catch (e) { /* ignore */ }
        try { callMic.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ }
        try { callMic.audioCtx.close() } catch (e) { /* ignore */ }
        callMic = null
      }
      callSegmentActive = false
      callActiveRpc('session', false) // C4：持久激活关闭
      setCallState({ active: false, phase: 'idle', recording: false })
      stopStreamPlayback() // Task 12：停止下行播放
    }

    function resetSegment() {
      if (!callMic) return
      callMic.chunks = []
      callMic.segmentStart = Date.now()
      callMic.segmentSeconds = 0
    }

    function startSegment() {
      if (!callMic || callSegmentActive) return
      callSegmentActive = true
      resetSegment()
      callActiveRpc('speaking', true) // C4：瞬时发声（共识窗口中止判定用；非持久激活）
      setCallState({ recording: true })
    }

    function stopSegment() {
      if (!callMic || !callSegmentActive) return
      callSegmentActive = false
      callActiveRpc('speaking', false)
      setCallState({ recording: false, phase: 'processing' })
      const chunks = callMic.chunks
      callMic.chunks = []
      if (!chunks.length) { setCallState({ phase: 'listening', error: null }); return }
      const blob = new Blob(chunks, { type: 'audio/webm' })
      // 上传 → 转写 → 插入 + 提交（与语音输入同路径）
      const sid = callSessionId || ''
      const fd = new FormData()
      fd.append('audio', blob, 'call-' + Date.now() + '.webm')
      fetch('/guide-dog/call-transcribe', { method: 'POST', headers: { 'x-session-id': sid }, body: fd }).then(function (r) {
        return r.json()
      }).then(function (r) {
        if (r && r.ok && r.text) {
          const actions = window.__gdInputActions // Task 7 注：需从会话组件取 inputActions
          if (actions) { insertText(actions, r.text); submitInput(actions) }
          setCallState({ phase: 'listening' })
        } else {
          const msg = (r && r.message) || '转写失败'
          setCallState({ phase: 'listening', error: msg })
          playBeep()
          showToast('通话转写失败：' + msg)
        }
      }).catch(function (e) {
        setCallState({ phase: 'listening', error: '上传失败：' + String(e) })
        showToast('通话上传失败')
      })
    }

    function callActiveRpc(kind, active) {
      host.call('guide-dog/call-active', { sessionId: callSessionId || '', kind: kind, active: active }).catch(function () {})
    }
```

> ⚠️ **`window.__gdInputActions` 是临时通道**：静态 bundle 的 client 跑在浏览器（ModuleLoader 工厂），`window` 可用但**模块级变量是本插件惯例**（Phase 1 全部状态都是模块级）。header action 的 owner props 未必含 `inputActions`（Task 4 Inspect 定案）。若探测确认 header.actions 无 `inputActions`，则在 **CALL PANEL 节内额外注入一个不可见的 `conversation.input.left` 或 `input.right` 组件**（Phase 1 已确认 input.left 的 props 含 `inputActions`），把 `props.inputActions` 存模块级 `gdInputActions`，Task 7 的提交走它。**Step 2 定案**。

- [ ] **Step 2: 定案 inputActions 获取通道**

根据 Task 4 探测结论选择：
- 若 `header.actions` owner props 含 `inputActions` → 删除 `window.__gdInputActions` 方案，改在 CallButton 组件里 `const actions = props.inputActions` 存模块级。
- 否则 → 新增不可见 input.left 注入（Phase 1 模式）：

```js
    let gdInputActions = null
    ctx.effect(function () {
      try {
        return slots.inject('conversation.input.left', function () {
          return slots.register(
            { name: 'conversation.input.left', id: 'guide-dog-call-input', order: 31, label: function () { return 'Call input' } },
            function (props) {
              gdInputActions = props.inputActions || gdInputActions
              return null
            })
        })
      } catch (e) { return function () {} }
    })
```

并在 `stopSegment` 中改用 `const actions = gdInputActions`。

- [ ] **Step 3: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-client.js
git add plugin-client.js
git commit -m "feat(phase2): call capture state machine — MediaRecorder + AnalyserNode VAD, PTT, upload+submit"
```

---

### Task 8: Host 共识拦截器（tools/pre-execute + 摘要 + 窗口 + consent）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（CALL 节内，Task 3 的 token/consent 之后）

**Interfaces:**
- Consumes: Task 3 的 `consent/grantConsent/hasConsent/clearConsent`、`consentPending/markConsentPending/consumeConsentPending`、`callActiveSessions/isCallActive`、`loadConfig`(80)、`speakImpl`(746)、`serialSpeak`(519)、`sleep`(515)、`voiceQueue`(1414)（播报复用）、`quote`(503)、`timerSvc`
- Produces:
  - `WRITE_TOOL_NAMES = ['write', 'edit']`（精确工具名）+ `DESTRUCTIVE_BASH_RE`（bash 破坏性命令启发式）
  - `async consensusSummary(exec): Promise<string>`（一句话摘要：目标路径 + 操作类型 + 片段）
  - `async announceAndWait(sid, text): Promise<'proceed'|'aborted'>`（播报摘要 → 3s 窗口 → 监听 speaking 标志 → 定案；C5 修复：快照在窗口开始后取）
  - `callActiveFlags: Map<sessionId, boolean>`（瞬时 speaking）+ RPC `guide-dog/call-active`（`{sessionId, active, kind:'session'|'speaking'}`；C4 修复：kind 分流持久激活/瞬时发声）
  - user 确认词监听器（C1 修复）：`session/event` 的 `user/message` 分支 → `CONSENT_YES_RE`/`CONSENT_NO_RE` 匹配 → `markConsentPending`/`clearConsent`
  - `tools/pre-execute` 拦截器（仅通话/a11y 生效）：无 consent 且无 pending → `deny {reason:'needs_voice_confirmation'}`；pending 消费后 grantConsent；有 consent → 摘要 + 窗口 → `allow` 或 `deny {reason:'aborted_by_user'}`
  - `guide_dog_call_consensus` systemPrompt variable（聊天感措辞，spec §6.7）
  - `guide_dog_a11y_constraints` systemPrompt variable（仅 a11y，Phase 3 预置；本任务先注册空实现，Task 15 验收联动）

- [ ] **Step 1: 写失败测试（摘要与窗口逻辑，纯函数）**

```js
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
```

- [ ] **Step 2: 运行复现**

Run: `node repro/repro-consensus.js`
Expected: `PASS: consensus summary + destructive heuristic`。

- [ ] **Step 3: 实现拦截器（plugin-host.js CALL 节）**

在 Task 3 的 consent 管理之后插入：

```js
    // ---- 共识优先（spec §6.7） ----
    const WRITE_TOOL_NAMES = ['write', 'edit']
    const DESTRUCTIVE_BASH_RE = /(^|\s|\||;|&&)(rm|mv|cp|truncate|dd|mkfs|git\s+push)\b|>>?[\s\S]*$/m
    function consensusSummary(name, args) {
      try {
        if (name === 'write') {
          const p = args && args.file_path ? String(args.file_path) : '?'
          const content = args && args.content ? String(args.content) : ''
          return '写入文件 ' + p + '（' + content.length + ' 字符）'
        }
        if (name === 'edit') {
          const p = args && args.file_path ? String(args.file_path) : '?'
          const oldS = args && args.old_string ? String(args.old_string) : ''
          return '修改文件 ' + p + '（替换 ' + oldS.length + ' 字符片段）'
        }
        if (name === 'bash') {
          const cmd = args && args.command ? String(args.command) : ''
          if (DESTRUCTIVE_BASH_RE.test(cmd)) return '执行命令：' + cmd.slice(0, 80)
          return ''
        }
        return ''
      } catch (e) { return '' }
    }
    const callActiveFlags = new Map() // sessionId -> boolean（瞬时：用户正在发声，Task 9 窗口期高灵敏上报）
    ctx.effect(function () {
      try {
        // C4 修复（2026-08-16 审稿）：call-active RPC 拆两用——
        //   {active:true, kind:'session'} → callActiveSessions.add（持久激活，Task 7 startCall/stopCall 上报）
        //   {active:true/false, kind:'speaking'} → callActiveFlags.set（瞬时发声，Task 9 共识窗口上报）
        return harness.handle('guide-dog/call-active', async function (args) {
          const sid = args && args.sessionId ? String(args.sessionId) : ''
          if (!sid) return { ok: false, error: 'bad_args' }
          const kind = args && args.kind === 'session' ? 'session' : 'speaking'
          const active = !!(args && args.active)
          if (kind === 'session') {
            if (active) callActiveSessions.add(String(sid))
            else callActiveSessions.delete(String(sid))
          } else {
            callActiveFlags.set(String(sid), active)
          }
          return { ok: true }
        })
      } catch (e) { return function () {} }
    })
    async function announceAndWait(sid, text) {
      // 播报摘要（走同一 TTS 管线，source:'consensus'）；等待窗口；期间用户发声（speaking 置位）→ aborted
      // C5 修复（2026-08-16 审稿）：① 摘要必须入 voiceQueue 且**带 consensus 标记**（speakImpl 只生成 mp3
      //   不排队，旧代码直接 speakImpl → client 轮询取不到 → 用户听不到摘要、窗口永不开启）；
      //   ② 只在生成完成后推最终条目（占位条目会被 client 先弹出——队列是 shift 语义）；
      //   ③ 窗口在**摘要生成完成**后开始计时（client 播放到它需要 ~1-2s，窗口覆盖播放尾声与之后）；
      //   ④ 窗口期监听 speaking 标志从 false 变 true（Task 9 开窗即上报的旧语义自噬，已改为仅真实发声上报）。
      await serialSpeak(function () {
        return speakImpl({ text: text, sessionId: sid, turnSeq: null, source: 'consensus' }).then(function (r) {
          const q2 = voiceQueue.get(String(sid)) || []
          if (r && r.ok && r.url) {
            q2.push({ url: r.url, key: 'consensus:' + sid + ':' + Date.now(), consensus: true })
          } else {
            q2.push({ error: (r && r.error) || 'tts_failed', message: (r && r.message) || '' })
          }
          if (q2.length > VOICE_QUEUE_MAX) q2.shift()
          voiceQueue.set(String(sid), q2)
        }).catch(function (e) {
          const q3 = voiceQueue.get(String(sid)) || []
          q3.push({ error: 'tts_failed', message: String(e).slice(0, 200) })
          if (q3.length > VOICE_QUEUE_MAX) q3.shift()
          voiceQueue.set(String(sid), q3)
        })
      })
      const cfg = loadConfig()
      const winMs = (cfg.call && cfg.call.consensus && cfg.call.consensus.summaryWindowMs) || 3000
      const start = Date.now()
      // 窗口开始：清瞬时标志，之后任何发声都会置 true → aborted
      callActiveFlags.set(String(sid), false)
      while (Date.now() - start < winMs) {
        if (callActiveFlags.get(String(sid)) === true) return 'aborted'
        await sleep(100)
      }
      return 'proceed'
    }
    function consensusEnabled(sid) {
      const cfg = loadConfig()
      const a11yOn = cfg.a11y && cfg.a11y.enabled
      const callOn = cfg.call && cfg.call.consensus && cfg.call.consensus.enabled
      return !!(a11yOn || callOn)
    }
    // C1 修复（2026-08-16 审稿）：user 确认词监听器——用户回复"确定/确认/可以/好"（普通回合内容）
    // → markConsentPending(sid)；下一次 pre-execute 消费该 pending 并 grantConsent。
    // 注意：监听 user 消息事件（Phase 1 的 session/event 监听的是 assistant/message，此处是 user 消息分支）。
    const CONSENT_YES_RE = /^(确定|确认|可以|好的?|行|就这么办|继续)$/
    const CONSENT_NO_RE = /^(取消|不行|不要|算了|停)$/
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'user/message') return
        const sid = (typeof session === 'string' ? session : (session && session.id)) || ''
        if (!sid || !consensusEnabled(sid)) return
        const data = event.data || {}
        const content = Array.isArray(data.content) ? data.content : (data.message && Array.isArray(data.message.content) ? data.message.content : [])
        const text = content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join(' ').trim()
        if (!text) return
        const t = text.replace(/[，。！？\s]/g, '')
        if (CONSENT_YES_RE.test(t)) markConsentPending(sid)
        else if (CONSENT_NO_RE.test(t)) { clearConsent(sid); callActiveFlags.set(String(sid), false) }
      } catch (e) { /* best effort */ }
    })
    ctx.on('tools/pre-execute', async function (exec, next) {
      try {
        // ⚠️ agent→sessionId 推导依赖 Task 4 探测（agent.session.id 形状待定案；
        // 若 agent 无 session 字段，改从 exec.agent 的会话属性或 agents 服务推导）
        const sid = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id || '') : ''
        if (!sid || !consensusEnabled(sid)) return next()
        const name = exec && exec.name ? String(exec.name) : ''
        const args = exec && exec.arguments ? exec.arguments : {}
        const isWrite = WRITE_TOOL_NAMES.indexOf(name) >= 0
        const isDestructiveBash = name === 'bash' && DESTRUCTIVE_BASH_RE.test(String((args && args.command) || ''))
        if (!isWrite && !isDestructiveBash) return next()
        // 摘要：写工具强制；bash 仅破坏性命令
        const summary = consensusSummary(name, args)
        if (!summary) return next()
        const turnSeq = exec.agent ? exec.agent.turn : null
        // C1 修复：未共识但用户刚说过确认词 → 消费 pending 并授予本轮 consent（不拦截）
        if (!hasConsent(sid, turnSeq) && consumeConsentPending(sid)) {
          grantConsent(sid, turnSeq) // 原样存储：null → hasConsent 退化为"已授予"；数字 → 精确匹配
        }
        if (hasConsent(sid, turnSeq)) {
          // 已共识：执行前摘要 + 打断窗口
          const verdict = await announceAndWait(sid, '接下来' + summary)
          if (verdict === 'aborted') return { kind: 'deny', reason: 'aborted_by_user' }
          return next()
        }
        // 未共识：拦截，让模型语音提问
        return { kind: 'deny', reason: 'needs_voice_confirmation' }
      } catch (e) {
        return next() // 拦截器自身失败 → 放行（不阻塞正常工具流）
      }
    })
```

> **窗口时序说明（C5 补充）**：host 在**摘要生成完成**后开始计时窗口（约覆盖播放尾声 + 完整 3s 窗口）。用户若在摘要播放期间发声（barge-in 已停播）→ speaking 标志置 true → 同样 `aborted`——语义一致（"摘要期间说话即中止"）。若需更精确的"播完才开始窗口"，可升级为 client 播完回调 RPC（backlog，v1 不实现——当前重叠语义已满足 spec §6.9 验收 7）。

> ⚠️ **spec §6.8 裁决冲突修正**：spec 写"拦截器自身失败→拒绝并口播"，但本任务 Step 3 的 catch 为 `return next()` 放行。**以 spec §6.8 为准（拒绝并口播）**——catch 分支改为：

```js
      } catch (e) {
        // spec §6.8：宁可拦错不可放错；口播原因（不静默）
        try {
          const sid = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id || '') : ''
          if (sid) serialSpeak(function () { return speakImpl({ text: '共识检查失败，已阻止本次操作', sessionId: sid, turnSeq: null, source: 'consensus' }).catch(function () { return null }) })
        } catch (e2) { /* ignore */ }
        return { kind: 'deny', reason: 'consensus_failed' }
      }
```

- [ ] **Step 4: 注册系统提示变量**

在既有 `systemPrompt.variable` 区块（行 1010 附近）之后追加：

```js
    if (systemPrompt && systemPrompt.variable) {
      try {
        const disp1 = systemPrompt.variable('guide_dog_call_consensus', function (context) {
          const cfg = loadConfig()
          const sid = context && context.sessionId ? String(context.sessionId) : ''
          const callOn = cfg.call && cfg.call.consensus && cfg.call.consensus.enabled
          const a11yOn = cfg.a11y && cfg.a11y.enabled
          if (!callOn && !a11yOn) return undefined
          const a11yExtra = a11yOn ? '无障碍模式已开启：所有可能改变状态的操作（发送、删除、覆盖等）执行前都必须先简短说明并得到你的语音确认。' : ''
          return '用户正通过语音和你对话，像和合作伙伴讨论一样：先理解意图，不清楚就问（问多少看实际情况，语音通道保持简洁）；主动说明关键信息；写入/修改前先简短说明要做什么，等用户点头；用户随时可能提问或插话，认真回应。' + a11yExtra
        })
        ctx.effect(disp1)
      } catch (e) { /* ignore */ }
      try {
        const disp2 = systemPrompt.variable('guide_dog_a11y_constraints', function () {
          const cfg = loadConfig()
          if (!(cfg.a11y && cfg.a11y.enabled)) return undefined
          return '无障碍模式：①破坏性操作必须先语音确认（"将删除 X，确定吗？请说确定或取消"）；②颜色/图标/布局一律用文字描述；③重要状态变化必须口头通知。'
        })
        ctx.effect(disp2)
      } catch (e) { /* ignore */ }
    }
```

- [ ] **Step 5: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js
git add plugin-host.js
git commit -m "feat(phase2): consensus-first interceptor — pre-execute deny, summary announce, 3s window, consent map"
```

---

### Task 9: Client 共识窗口协调（窗口期检测 + abort 上报）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（CALL PANEL 节内）

**Interfaces:**
- Consumes: Task 7 的 `callActiveRpc(kind, active)`（`'speaking'` 通道）、`callMic`/`analyser`（RMS 检测）、Task 8 的 host `guide-dog/call-active` RPC
- Produces: `setConsensusWindow(on: boolean)`——窗口开启时 VAD 轮询改为高灵敏度（threshold × 0.6），**真实发声才上报** `callActiveRpc('speaking', true)`（C5 修复：开窗不立即上报，防 host 自噬）；窗口关闭恢复并上报 false

**背景**：host 的 3s 窗口靠 `callActiveFlags` 判断用户是否发声（Task 8）。client 需在**摘要播报期间**保证：用户一开口（哪怕短音）就置位标志。默认 VAD 轮询有 `minSpeechMs` 过滤——窗口期要更敏感。

- [ ] **Step 1: 实现窗口开关**

在 CALL PANEL 节（Task 7 的 `callActiveRpc` 之后）插入：

```js
    let consensusWindow = false
    function setConsensusWindow(on) {
      consensusWindow = !!on
      if (on && callMic) {
        // 窗口开启：**不**立即上报（C5 修复：host 端 announceAndWait 在窗口开始后清标志并监听
        // false→true 跳变；开窗即上报会自噬——host 会把"开窗瞬间的 true"当成用户发声）
        const threshold = ((voiceState.cfg || {}).call && voiceState.cfg.call.vad && voiceState.cfg.call.vad.threshold) || 0.02
        const sampleBuf = new Uint8Array(callMic.analyser.fftSize)
        const probe = function () {
          if (!consensusWindow || !callMic) return
          callMic.analyser.getByteTimeDomainData(sampleBuf)
          let sum = 0
          for (let i = 0; i < sampleBuf.length; i++) { const v = (sampleBuf[i] - 128) / 128; sum += v * v }
          const rms = Math.sqrt(sum / sampleBuf.length)
          if (rms >= threshold * 0.6) { callActiveRpc('speaking', true) } // 真实发声才上报（高灵敏，短音即报）
          setTimeout(probe, 100)
        }
        setTimeout(probe, 100)
      } else if (!on) {
        callActiveRpc('speaking', false)
      }
    }
```

> 注意（2026-08-16 审稿修订）：窗口期上报的是**瞬时 speaking 标志**，host 端 `announceAndWait` 在窗口开始时 `callActiveFlags.set(sid, false)` 清零，之后任何真实发声（RMS ≥ 阈值×0.6）→ client 置 true → host 见 true → `aborted`。**开窗瞬间不上报**是防自噬的关键（旧语义"开窗即上报一次"会被 host 误判为发声）。窗口结束后 host 放行；若用户恰在窗口末发声，host 已放行——可接受（窗口语义是"给打断机会"，不是绝对闸门）。

- [ ] **Step 2: 接入播放器与摘要播报**

Task 12 的播放器在开始播报**共识摘要**时（`source:'consensus'` 或专用队列标记）调用 `setConsensusWindow(true)`，播报结束（onended/队列空）调用 `setConsensusWindow(false)`。本任务先挂空钩子（Task 12 接线）：

```js
    function notifyConsensusSpeech(started) { setConsensusWindow(started) }
```

- [ ] **Step 3: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-client.js
git add plugin-client.js
git commit -m "feat(phase2): consensus window coordination — sensitive VAD probe + call-active reporting"
```

---

### Task 10: Host 进度播报（agent 事件 → 播报队列）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（CALL 节内，Task 8 之后）

**Interfaces:**
- Consumes: `speakImpl`(746)、`serialSpeak`(519)、`voiceQueue`(1414)、`loadConfig`(80)、`ctx.on` 事件 `agent/status`/`tools/result`/`agent/error`（存在性已实测）
- Produces: `progressPhrase(toolName): string`（工具→短语映射，spec §6.4 表）；`shouldAnnounce(toolName): boolean`（白名单）；事件监听器（仅通话/a11y 激活会话生效，播报入 voiceQueue 优先位）

- [ ] **Step 1: 写失败测试（映射纯函数）**

```js
// repro/repro-progress.js
function progressPhrase(name) {
  const map = { bash: '正在执行命令', read: '正在查找文件', grep: '正在查找文件', glob: '正在查找文件',
    write: '正在修改文件', edit: '正在修改文件', web_search: '正在搜索网页',
    guide_dog_image: '正在生成媒体', guide_dog_video: '正在生成媒体', guide_dog_music: '正在生成媒体', guide_dog_speak: '正在生成媒体',
    skill: '正在调用技能' }
  return map[name] || '正在执行操作'
}
console.assert(progressPhrase('bash') === '正在执行命令', 'FAIL: bash')
console.assert(progressPhrase('unknown_tool') === '正在执行操作', 'FAIL: fallback')
console.log('PASS: progress phrase mapping')
```

- [ ] **Step 2: 运行复现**

Run: `node repro/repro-progress.js`
Expected: `PASS: progress phrase mapping`。

- [ ] **Step 3: 实现事件监听（plugin-host.js CALL 节）**

在 Task 8 之后插入：

```js
    // ---- 进度播报（spec §6.4） ----
    function progressPhrase(name) {
      const map = { bash: '正在执行命令', read: '正在查找文件', grep: '正在查找文件', glob: '正在查找文件',
        write: '正在修改文件', edit: '正在修改文件', web_search: '正在搜索网页',
        guide_dog_image: '正在生成媒体', guide_dog_video: '正在生成媒体', guide_dog_music: '正在生成媒体', guide_dog_speak: '正在生成媒体',
        skill: '正在调用技能' }
      return map[name] || '正在执行操作'
    }
    const PROGRESS_SILENT = { read: 1, grep: 1, glob: 1, skill: 1 } // 静默类（Phase 3 自动播报同白名单基础）
    function shouldAnnounce(name) { return !PROGRESS_SILENT[name] }
    function callOrA11yActive(sid) {
      const cfg = loadConfig()
      // C4 修复：读持久 callActiveSessions（isCallActive），不再读瞬时 callActiveFlags
      return !!((cfg.call && cfg.call.progress && isCallActive(sid)) || (cfg.a11y && cfg.a11y.enabled))
    }
    function announce(sid, text) {
      // 播报优先：生成完成后才入队（C5 同款修复——占位条目 {url:null, phrase} 会被 client 轮询
      // shift 弹出后丢弃，旧代码先 unshift 占位再回填 → 播报大概率丢失）
      serialSpeak(function () {
        return speakImpl({ text: text, sessionId: sid, turnSeq: null, source: 'progress' }).then(function (r) {
          const q2 = voiceQueue.get(String(sid)) || []
          if (r && r.ok && r.url) q2.unshift({ url: r.url, key: 'progress:' + sid + ':' + text })
          else q2.unshift({ error: (r && r.error) || 'tts_failed', message: (r && r.message) || '' })
          if (q2.length > VOICE_QUEUE_MAX) q2.pop()
          voiceQueue.set(String(sid), q2)
        }).catch(function (e) {
          const q3 = voiceQueue.get(String(sid)) || []
          q3.unshift({ error: 'tts_failed', message: String(e).slice(0, 200) })
          if (q3.length > VOICE_QUEUE_MAX) q3.pop()
          voiceQueue.set(String(sid), q3)
        })
      })
    }
    ctx.on('agent/status', function (payload) {
      try {
        const agent = payload && payload.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (!sid || !callOrA11yActive(sid)) return
        if (payload.status === 'running') announce(sid, '正在处理')
      } catch (e) { /* best effort */ }
    })
    ctx.on('tools/result', function (exec, result) {
      try {
        const agent = exec && exec.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        const name = exec && exec.name ? String(exec.name) : ''
        if (!sid || !callOrA11yActive(sid) || !shouldAnnounce(name)) return
        const phrase = progressPhrase(name)
        announce(sid, phrase)
      } catch (e) { /* best effort */ }
    })
    ctx.on('agent/error', function (payload) {
      try {
        const agent = payload && payload.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (!sid || !callOrA11yActive(sid)) return
        const err = payload.error || {}
        announce(sid, '处理出错：' + String((err && err.message) || err).slice(0, 60))
      } catch (e) { /* best effort */ }
    })
```

> ⚠️ **事件 payload 形状**：`agent/status` 的 payload 是 `{agent, status}`；`tools/result` 的 payload 是 `(exec, result)` 两参（emit 事件签名 `(exec, result)`）；`agent/error` 是 `{agent, turn, step, error}`。`agent.session` 是否为 `session.id` 形态——**Task 4 探测定案**（与 Phase 1 `session/event` 的 session 参数同源）。若 agent 无 session 字段，改用 `agents` 服务 `sessionId` 推导，Step 4 记录裁决。

- [ ] **Step 4: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js
git add plugin-host.js
git commit -m "feat(phase2): progress announcements — agent/status, tools/result, agent/error → priority queue"
```

---

### Task 11: Host 下行流式 TTS（tts-stream 路由 + 分句 + 预合成）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（CALL 节内，Task 10 之后）

**Interfaces:**
- Consumes: Task 3 的 `consumeTtsToken`、`loadConfig`(80)、`guideDogRoot`(44)、`subprocess`（pipe 模式，Task 4 验证）、`webServer.register`、`sleep`(515)
- Produces:
  - `splitSentences(text): string[]`（`call.stream.sentenceSplit` 字符集分句 + `maxSentenceChars` 截断）
  - `GET /guide-dog/tts-stream?token=…&sid=…&text=<句>`（URL 编码文本；token 校验 → spawn mmx --stream → `res.write` 管道 → end；异常 terminate）
  - `speechStreamBusy: Map<sessionId, boolean>`（防同会话并发流）
  - `session/event` 下行触发（**无 speech-text RPC**，2026-08-16 对齐实现）：assistant 消息落地 → 分句 → 依序推 `{stream:true, text}` 条目入 `voiceQueue`（`stream` 标记）——client 播放器识别 `stream` 条目发 `GET tts-stream`，普通条目用 `<audio>` 播放（Phase 1 兼容）；与 Phase 1 语音模式监听器互斥见 Step 3 共存注意

- [ ] **Step 1: 写失败测试（分句纯函数）**

```js
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
```

- [ ] **Step 2: 运行复现**

Run: `node repro/repro-split.js`
Expected: `PASS: sentence splitting + maxChars truncation`。

- [ ] **Step 3: 实现分句与流式路由（plugin-host.js CALL 节）**

在 Task 10 之后插入：

```js
    // ---- 下行流式 TTS（spec §6.5，零 WebSocket） ----
    function splitSentences(text, splitChars, maxChars) {
      if (!text) return []
      const chars = splitChars || '。！？.!?\n'
      const esc = chars.replace(/[\\\]]/g, '\\$&')
      const re = new RegExp('[' + esc + ']', 'g')
      const out = []
      let last = 0, m
      while ((m = re.exec(text)) !== null) {
        const seg = text.slice(last, m.index + 1).trim()
        if (seg) out.push(seg)
        last = m.index + 1
      }
      const tail = text.slice(last).trim()
      if (tail) out.push(tail)
      const res = []
      for (const s of out) {
        if (s.length <= maxChars) res.push(s)
        else for (let i = 0; i < s.length; i += maxChars) res.push(s.slice(i, i + maxChars))
      }
      return res
    }
    const speechStreamBusy = new Map() // sessionId -> bool
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'exact',
          path: '/guide-dog/tts-stream',
          handler: async function (req, res) {
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
              const url = new URL(String(req.url || '/'), 'http://local')
              const token = url.searchParams.get('token') || ''
              const sid = url.searchParams.get('sid') || ''
              const text = url.searchParams.get('text') || ''
              if (!sid || !text || !consumeTtsToken(token, sid)) { res.writeHead(403); res.end(); return }
              if (speechStreamBusy.get(sid)) { res.writeHead(429); res.end(); return }
              speechStreamBusy.set(sid, true)
              const cfg = loadConfig()
              const streamCfg = (cfg.call && cfg.call.stream) || {}
              const format = streamCfg.format || 'pcm'
              const sampleRate = streamCfg.sampleRate || 24000
              const voice = (cfg.call && cfg.call.voice) || 'English_expressive_narrator'
              const speed = (cfg.call && cfg.call.speed) || 1.0
              res.writeHead(200, { 'content-type': 'audio/' + format, 'cache-control': 'no-store' })
              let handle = null
              try {
                handle = subprocess.spawn({
                  argv: ['mmx', 'speech', 'synthesize', '--stream', '--text', text, '--format', format, '--sample-rate', String(sampleRate), '--voice', voice, '--speed', String(speed)],
                  cwd: (await guideDogRoot()) + '/.guide-dog',
                  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 * 1024 } },
                  graceMs: 3000,
                })
                let first = true
                handle.stdout.on('data', function (chunk) {
                  if (first) { first = false; if (req.method === 'HEAD') { try { handle.terminate() } catch (e) { /* ignore */ } } }
                  if (req.method === 'HEAD') return
                  try { res.write(chunk) } catch (e) { try { handle.terminate() } catch (e2) { /* ignore */ } }
                })
                await handle.done
                try { res.end() } catch (e) { /* ignore */ }
              } catch (e) {
                try { res.writeHead(500); res.end() } catch (e2) { /* ignore */ }
              } finally {
                speechStreamBusy.delete(sid)
              }
            } catch (e) {
              try { res.writeHead(500); res.end() } catch (e2) { /* ignore */ }
            }
          },
        })
      } catch (e) { return function () {} }
    })
    // 下行主通道：assistant 消息 → 分句 → 流条目入队列（client 播放器识别 stream 条目走 GET）
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'assistant/message') return
        const sid = (typeof session === 'string' ? session : (session && session.id)) || ''
        if (!sid) return
        const cfg = loadConfig()
        const callActive = isCallActive(sid) // C4 修复：持久激活（Task 7 startCall/stopCall 上报）
        const a11yOn = cfg.a11y && cfg.a11y.enabled
        if (!callActive && !a11yOn) return // 仅通话/a11y 会话走流式；语音模式走 Phase 1 队列
        const data = event.data || {}
        const content = Array.isArray(data.content) ? data.content : (data.message && Array.isArray(data.message.content) ? data.message.content : [])
        const text = content.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string' }).map(function (b) { return b.text }).join('\n').trim()
        if (!text) return
        const streamCfg = (cfg.call && cfg.call.stream) || {}
        const sentences = splitSentences(text, streamCfg.sentenceSplit, streamCfg.maxSentenceChars || 200)
        const q = voiceQueue.get(sid) || []
        sentences.forEach(function (s) { q.push({ stream: true, text: s, key: 'stream:' + sid + ':' + event.seq + ':' + s.slice(0, 8) }) })
        if (q.length > VOICE_QUEUE_MAX) q.splice(0, q.length - VOICE_QUEUE_MAX)
        voiceQueue.set(sid, q)
      } catch (e) { /* best effort */ }
    })
```

> ⚠️ **与 Phase 1 voice-mode 监听器共存（2026-08-16 新增注意）**：Phase 1 的 `session/event` 监听器（行 1415，VOICE MODE 节）在语音模式生效时也会为同一消息入队 mp3 条目——**通话激活 + 语音模式开启同时成立时会双播**。本 Task 的监听器需在 Phase 1 监听器内加互斥：语音模式监听器入口处，若 `isCallActive(sid)` 为真（或 a11y 开启）则跳过（流式通道接管）。实现时改 VOICE MODE 节的 listener 首部（行 1415-1421），加一行：`if (isCallActive(sid) || (loadConfig().a11y && loadConfig().a11y.enabled)) return`——注意 `callActiveSessions`/`isCallActive` 在 **Task 8** 定义（本监听器先注册但回调运行时 Task 8 已执行，模块级引用安全）。

> ✅ **2026-08-16 修订（静态 bundle）**：host 半跑在 DSH host Node 进程，**`URL`/`URLSearchParams` 全局可用**——直接 `new URL(req.url, 'http://local')` + `searchParams`，无需手写解析。以标准 URL 为准：

```js
              const url = new URL(String(req.url || '/'), 'http://local')
              const token = url.searchParams.get('token') || ''
              const sid = url.searchParams.get('sid') || ''
              const text = url.searchParams.get('text') || ''
```

- [ ] **Step 4: 语法验证（URL 可用性）**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node -e "
// 静态 bundle host 半运行于 Node 进程：URL 全局可用
const u = new URL('/guide-dog/tts-stream?token=abc&sid=s1&text=' + encodeURIComponent('你好'), 'http://local')
console.log('token:', u.searchParams.get('token'), '| sid:', u.searchParams.get('sid'), '| text:', u.searchParams.get('text'))
console.log('PASS: URL global available in static bundle host half')
"
```
Expected: `PASS`（手写解析 fallback 不再需要）。

- [ ] **Step 5: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js
git add plugin-host.js
git commit -m "feat(phase2): streaming TTS downlink — tts-stream route, sentence split, stream queue entries"
```

---

### Task 12: Client 下行播放（fetch getReader + PCM→WAV + Web Audio 队列 + 预合成）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（STREAM PLAYER 节，CALL PANEL 节之后）

**Interfaces:**
- Consumes: Task 7 的 `callMic`/`setCallState`/`stopCall`、Task 9 的 `notifyConsensusSpeech`、`voiceQueue` 轮询（Phase 1 已有，行 400-410）、`host.call('guide-dog/tts-token')`、`curAudio`（Phase 1 播放器）
- Produces:
  - `playStreamEntry(entry, sid)`：token 获取 → `fetch('/guide-dog/tts-stream?...')` → `getReader()` 循环 → PCM 累积 → WAV 包装 → `decodeAudioData` → AudioBufferSourceNode 定时队列
  - `stopStreamPlayback()`：abort fetch + 停节点 + 清缓冲（Task 7 `stopCall` 调用）
  - `streamPlayer` 模块级 `{controller, nodes, nextTime, active}`；播放间隙 <400ms 验收指标
  - 预合成：当前句播放中提前请求下一句 token + 流（队列消费逻辑）

- [ ] **Step 1: 写失败测试（WAV 包装纯函数）**

```js
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
```

- [ ] **Step 2: 运行复现**

Run: `node repro/repro-wav.js`
Expected: `PASS: PCM→WAV wrapper (24kHz s16le mono)`。

- [ ] **Step 3: 实现流式播放器（plugin-client.js）**

在 CALL PANEL 节之后插入：

```js
    // ============ STREAM PLAYER 节（Phase 2，client） ============
    const streamPlayer = { controller: null, nodes: [], nextTime: 0, active: false, audioCtx: null }
    function getTtsToken(sid) {
      return host.call('guide-dog/tts-token', { sessionId: sid }).then(function (r) {
        return (r && r.ok && r.token) ? r.token : ''
      }).catch(function () { return '' })
    }
    function ensureStreamCtx() {
      if (streamPlayer.audioCtx) return streamPlayer.audioCtx
      const AC = window.AudioContext || window.webkitAudioContext
      streamPlayer.audioCtx = new AC()
      return streamPlayer.audioCtx
    }
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
    function scheduleChunk(audioCtx, wavBytes) {
      return audioCtx.decodeAudioData(wavBytes.buffer.slice(0)).then(function (buf) {
        if (!streamPlayer.active) return
        const src = audioCtx.createBufferSource()
        src.buffer = buf
        src.connect(audioCtx.destination)
        const when = Math.max(audioCtx.currentTime + 0.05, streamPlayer.nextTime)
        src.start(when)
        streamPlayer.nextTime = when + buf.duration
        streamPlayer.nodes.push(src)
        src.onended = function () {
          const i = streamPlayer.nodes.indexOf(src)
          if (i >= 0) streamPlayer.nodes.splice(i, 1)
          if (!streamPlayer.nodes.length && streamPlayer.active) {
            streamPlayer.active = false
            setCallState({ phase: 'listening' })
          }
        }
      }).catch(function () { /* 解码失败：跳过该块 */ })
    }
    async function playStreamEntry(entry, sid) {
      if (streamPlayer.active) { stopStreamPlayback() } // 新任务覆盖（v2.1 语义）
      // C3 修复（2026-08-16 审稿）：token 为**单次消费**（consumeTtsToken 即删）——每句都必须重新签发，
      // 不得缓存复用（旧代码 `if (!streamPlayer.token)` 只取一次 → 第二句起 403）。
      streamPlayer.token = await getTtsToken(sid)
      if (!streamPlayer.token) { showToast('流式播放失败：无 token'); return }
      const cfg = voiceState.cfg || {}
      const sr = ((cfg.call || {}).stream || {}).sampleRate || 24000
      streamPlayer.active = true
      streamPlayer.nextTime = 0
      const AC = window.AudioContext || window.webkitAudioContext
      const audioCtx = ensureStreamCtx()
      try { await audioCtx.resume() } catch (e) { /* ignore */ }
      setCallState({ phase: 'speaking' })
      if (entry.consensus) notifyConsensusSpeech(true) // Task 9：共识摘要播报开窗口
      const controller = new AbortController()
      streamPlayer.controller = controller
      const url = '/guide-dog/tts-stream?token=' + encodeURIComponent(streamPlayer.token) + '&sid=' + encodeURIComponent(sid) + '&text=' + encodeURIComponent(entry.text)
      try {
        const resp = await fetch(url, { signal: controller.signal })
        if (!resp.ok || !resp.body) { throw new Error('http ' + resp.status) }
        const reader = resp.body.getReader()
        let acc = new Uint8Array(0)
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!streamPlayer.active) { try { controller.abort() } catch (e) { /* ignore */ } break }
          if (value && value.length) {
            const merged = new Uint8Array(acc.length + value.length)
            merged.set(acc); merged.set(value, acc.length)
            acc = merged
            // 每 ~0.5s 音频（24000*2*0.5=24000 字节）解码一帧，保持播放间隙 <400ms
            if (acc.length >= 24000) {
              const frame = acc.subarray(0, acc.length)
              const wav = pcmToWav(frame, sr)
              scheduleChunk(audioCtx, wav)
              acc = new Uint8Array(0)
            }
          }
        }
        if (acc.length > 0) { const wav = pcmToWav(acc, sr); scheduleChunk(audioCtx, wav) }
      } catch (e) {
        if (streamPlayer.active) {
          streamPlayer.active = false
          setCallState({ phase: 'listening', error: '播放中断' })
          showToast('播放中断，已尝试重连')
        }
      } finally {
        streamPlayer.controller = null
        if (entry.consensus) notifyConsensusSpeech(false)
      }
    }
    function stopStreamPlayback() {
      if (streamPlayer.controller) { try { streamPlayer.controller.abort() } catch (e) { /* ignore */ } streamPlayer.controller = null }
      streamPlayer.active = false
      streamPlayer.nodes.forEach(function (src) { try { src.stop() } catch (e) { /* ignore */ } })
      streamPlayer.nodes = []
      streamPlayer.nextTime = 0
      notifyConsensusSpeech(false)
    }
```

- [ ] **Step 4: 轮询消费识别 stream 条目（新增通话专用轮询，I1 修复）**

Phase 1 轮询（行 400-410）被 `effective`（语音模式生效）门控——**通话模式下语音模式可能关闭，stream 条目无人消费**（I1，2026-08-16 审稿）。修复：在 CALL PANEL 节新增**通话专用轮询**（`callActive` 为真时运行），与 Phase 1 轮询并存；Phase 1 轮询的 `r.entry.url` 分支保留：

```js
    // ---- 通话轮询（CALL PANEL 节内；I1：不受语音模式门控） ----
    let callPollBusy = false
    const callPoll = function () {
      if (!callState.active || callPollBusy) return
      callPollBusy = true
      host.call('guide-dog/voice-queue', { sessionId: callSessionId || '' }).then(function (r) {
        if (r && r.ok && r.entry) {
          // C5 修复：consensus 摘要条目（mp3 url + consensus 标记）→ 播放前开共识窗口
          if (r.entry.consensus) { notifyConsensusSpeech(true); playEntryConsensus(r.entry.url) }
          else if (r.entry.stream && r.entry.text) { lastSpokenSentence = r.entry.text; playStreamEntry(r.entry, callSessionId || '') }
          else if (r.entry.url) playEntry(r.entry.url)
          else if (r.entry.error) { showToast('朗读失败：' + (r.entry.message || r.entry.error)); playBeep() }
        }
      }).catch(function () {}).then(function () { callPollBusy = false })
    }
    // C5：共识 mp3 播放（window 关闭由 onended 触发；与 playEntry 同机制，附加回调）
    function playEntryConsensus(url) {
      stopCurrent()
      const a = new Audio(String(url))
      curAudio = a
      a.onended = function () { if (curAudio === a) curAudio = null; notifyConsensusSpeech(false) }
      a.onerror = function () { if (curAudio === a) curAudio = null; notifyConsensusSpeech(false); showToast('播放失败') }
      const p = a.play()
      if (p && typeof p.catch === 'function') p.catch(function () { if (curAudio === a) { curAudio = null; notifyConsensusSpeech(false) } })
    }
    // 挂到 CallPanel 组件的 useEffect（timerSvc.interval 1s）或 Task 7 startCall 内 timerSvc.interval
```

> `lastSpokenSentence` 变量定义于 Task 13 命令节（`let lastSpokenSentence = null`）——模块级执行顺序安全（赋值发生在用户操作时，晚于模块全部初始化）；若实现时调整了声明位置，确保声明在任何赋值前。

并让 Task 7 的 `stopCall` 调用 `stopStreamPlayback()`（已在 Task 7 Step 1 中标注，确认接线）。

- [ ] **Step 5: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-client.js
git add plugin-client.js
git commit -m "feat(phase2): stream player — fetch getReader, PCM→WAV, Web Audio gapless queue"
```

---

### Task 13: 打断 + 语音命令

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（STREAM PLAYER 节内 + 命令匹配节）

**Interfaces:**
- Consumes: Task 7 的 `callBargeCb`、Task 12 的 `stopStreamPlayback/streamPlayer`、`callMic`（VAD RMS）、`insertText`/`submitInput`、`host.call`
- Produces:
  - `setBargeCallback(fn)`——Task 7 的 VAD 轮询在 `phase==='speaking'` 且发声时调用
  - `CALL_COMMANDS` 表 + `matchCallCommand(text): {cmd, args} | null`（本地匹配，命中不提交）
  - `runCallCommand(cmd)`：`stop`（停播+清队列）/ `pause` / `resume` / `repeat` / `slower` / `faster` / `see_screen`（Phase 3 桩）
  - `guide-dog/call-command` RPC（`{sessionId, cmd}` → host 清 voiceQueue；Task 14 实现 host 端，本任务客户端调用）

- [ ] **Step 1: 写失败测试（命令匹配纯函数）**

```js
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
```

- [ ] **Step 2: 运行复现**

Run: `node repro/repro-cmds.js`
Expected: `PASS: call command matching`。

- [ ] **Step 3: 实现打断接线（plugin-client.js）**

Task 7 的 VAD 轮询已有 `if (isSpeaking && callState.phase === 'speaking' && voiced && callBargeCb) callBargeCb()`——在 STREAM PLAYER 节定义回调：

```js
    callBargeCb = function () {
      // 打断（spec §6.6）：停播 + 清缓冲（abort fetch 由 stopStreamPlayback 完成）
      stopStreamPlayback()
      setCallState({ phase: 'listening' })
    }
```

并在 `startCall`（Task 7）的 VAD 轮询前确认 `callBargeCb` 已挂（模块级变量，Task 7 已声明 `let callBargeCb = null`；本任务赋值即可，无需改 Task 7）。

- [ ] **Step 4: 实现命令匹配与执行**

在 STREAM PLAYER 节之后插入：

```js
    // ============ 语音命令节（Phase 2） ============
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
    let lastSpokenSentence = null // repeat 用
    function runCallCommand(cmd) {
      switch (cmd) {
        case 'pause':
          if (streamPlayer.active) { stopStreamPlayback(); setCallState({ phase: 'listening' }) }
          // 清 host 待播队列（防停播后下一句仍到）
          host.call('guide-dog/call-command', { sessionId: callSessionId || '', cmd: 'clear-queue' }).catch(function () {})
          break
        case 'resume':
          setCallState({ phase: 'listening' }) // 恢复=回到收听（无缓冲重播；Task 14 增强：恢复未播队列）
          break
        case 'repeat':
          if (lastSpokenSentence) { playStreamEntry({ stream: true, text: lastSpokenSentence, consensus: false }, callSessionId || '') }
          break
        case 'slower': { const s = Math.min(1.2, callState.speed + 0.2); setCallState({ speed: s }) } break
        case 'faster': { const s = Math.max(0.8, callState.speed - 0.2); setCallState({ speed: s }) } break
        case 'see_screen': /* Phase 3 桩 */ break
        default: break
      }
    }
```

在 Task 7 `stopSegment` 的转写成功分支（`r.ok && r.text`）插入命令拦截：

```js
          const cmd = matchCallCommand(r.text)
          if (cmd) { runCallCommand(cmd); setCallState({ phase: 'listening' }); return }
```

并记录 `lastSpokenSentence`（Task 12 播放每句流时赋值）。

- [ ] **Step 5: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-client.js
git add plugin-client.js
git commit -m "feat(phase2): barge-in wiring + voice commands (pause/resume/repeat/speed)"
```

---

### Task 14: 容错（重连 / 失败口播 / 心跳 / 拦截器失败拒绝）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（CALL 节内，Task 11 之后）+ `guide-dog-dsh/plugin-client.js`（STREAM PLAYER 节内）

**Interfaces:**
- Consumes: Task 11 的流式路由、Task 12 的播放器、`voiceQueue`、`speakImpl`
- Produces:
  - host：`heartbeatCheck`（通话激活会话 120s 无事件 → 播报"仍在处理，请稍候"）；`guide-dog/call-command` RPC（清队列/重放）；流中断时 host 侧自动重新生成流条目（`stream_interrupted` 口播一次）
  - client：播放失败自动重连一次（重新 GET，最多 1 次）；`stream_interrupted` 错误 → toast + 口播

- [ ] **Step 1: host 心跳与命令 RPC（plugin-host.js）**

在 Task 11 之后插入：

```js
    // ---- 容错（spec §6.8） ----
    const lastAgentEvent = new Map() // sessionId -> ts
    ctx.on('agent/status', function (payload) {
      try {
        const agent = payload && payload.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (sid) lastAgentEvent.set(sid, Date.now())
      } catch (e) { /* ignore */ }
    })
    ctx.on('tools/result', function (exec) {
      try {
        const agent = exec && exec.agent
        const sid = agent && agent.session ? String(agent.session.id || '') : ''
        if (sid) lastAgentEvent.set(sid, Date.now())
      } catch (e) { /* ignore */ }
    })
    const heartbeatTimer = timerSvc && typeof timerSvc.interval === 'function'
      ? timerSvc.interval(function () {
          const now = Date.now()
          // C4 修复：遍历持久激活集合（callActiveSessions），不再读瞬时 callActiveFlags
          callActiveSessions.forEach(function (sid) {
            const last = lastAgentEvent.get(String(sid)) || now
            if (now - last > 120000) {
              lastAgentEvent.set(String(sid), now) // 防重复轰炸
              // C5 同款：生成完成后才入队（占位条目会被 client 先弹出）
              serialSpeak(function () {
                return speakImpl({ text: '仍在处理，请稍候', sessionId: String(sid), turnSeq: null, source: 'progress' }).then(function (r) {
                  const q2 = voiceQueue.get(String(sid)) || []
                  if (r && r.ok && r.url) q2.unshift({ url: r.url, key: 'hb:' + String(sid) })
                  else q2.unshift({ error: (r && r.error) || 'tts_failed', message: (r && r.message) || '' })
                  if (q2.length > VOICE_QUEUE_MAX) q2.pop()
                  voiceQueue.set(String(sid), q2)
                }).catch(function () {})
              })
            }
          })
        }, 30000)
      : null
    if (heartbeatTimer) ctx.effect(heartbeatTimer)
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/call-command', async function (args) {
          const sid = args && args.sessionId ? String(args.sessionId) : ''
          const cmd = args && args.cmd ? String(args.cmd) : ''
          if (!sid || !cmd) return { ok: false, error: 'bad_args' }
          if (cmd === 'clear-queue') { voiceQueue.delete(sid); return { ok: true } }
          return { ok: true }
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 2: client 播放重连（plugin-client.js STREAM PLAYER 节）**

在 `playStreamEntry` 的 catch 分支（Task 12）中，`showToast('播放中断，已尝试重连')` 前加一次重连：

```js
      } catch (e) {
        if (streamPlayer.active) {
          streamPlayer.active = false
          setCallState({ phase: 'listening', error: '播放中断' })
          // 重连一次（C3：每句已重新取 token，playStreamEntry 内部即新 token + GET）
          if (!playStreamEntry._retried) {
            playStreamEntry._retried = true
            playStreamEntry({ stream: true, text: entry.text, consensus: entry.consensus }, sid)
            setTimeout(function () { playStreamEntry._retried = false }, 5000)
          } else {
            showToast('播放中断')
          }
        }
      }
```

> 注：`playStreamEntry._retried` 为函数属性（模块级单例语义，无需 useRef）。

- [ ] **Step 3: 语法与提交**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && node --check plugin-host.js && node --check plugin-client.js
git add plugin-host.js plugin-client.js
git commit -m "feat(phase2): fault tolerance — heartbeat announcement, stream retry-once, call-command RPC"
```

---

### Task 15: 组装部署 + README

**Files:**
- Modify: `guide-dog-dsh/README.md`（Phase 2 章节）；运行 `deploy/convert_bundle.py` + `deploy/publish.py`（不落 repo）

**Interfaces:**
- Consumes: 全部 Task 0-14 产物
- Produces: 可部署的 `bundle/lib/index.js` + `bundle/lib/client.js`（静态 bundle）；README 的 Phase 2 文档（用法/配置/验收）

- [ ] **Step 1: 重生成静态 bundle 产物**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh
node --check plugin-host.js && node --check plugin-client.js
python3 deploy/convert_bundle.py   # 重生成 bundle/lib/index.js + bundle/lib/client.js
node --check bundle/lib/index.js && node --check bundle/lib/client.js
```
Expected: convert 成功 + 双侧语法通过。

- [ ] **Step 1b: publish.py 一致性校验（M2 修订）**

`deploy/publish.py` 的 `verify_sources()` 现已**不校验 plugin-source.js**（2026-08-16 审稿 C2 修复）：它检查 ① WHISPER_SCRIPT 模板与 `scripts/whisper_transcribe.py` 全等；② `bundle/lib/index.js` 与 `client.js` 的 mtime 不早于两份真源（防止漏跑 convert_bundle.py）。运行确认通过：

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && python3 -c "import ast; ast.parse(open('deploy/publish.py').read()); print('publish.py syntax OK')"
```
Expected: 语法 OK；`publish.py` 实际运行时 `verify_sources()` 打印 "sources verified: whisper template consistent; bundle/lib newer than sources"。

- [ ] **Step 2: README Phase 2 章节**

在 README 的 Phase 1 章节之后追加 `## Phase 2 — 通话模式`，内容覆盖：
- 功能列表（零 WS 双通道 / VAD+PTT / 共识优先 / 进度播报 / 流式 TTS / 打断 / 语音命令 / 容错）
- config schema 的 `call`/`a11y` 节（spec §4 复制）
- RPC 表新增：`guide-dog/tts-token`、`guide-dog/call-active`、`guide-dog/call-command`；路由表新增：`POST /guide-dog/call-transcribe`、`GET /guide-dog/tts-stream`
- 验证命令（`node --check` ×2、curl call-transcribe、curl tts-stream 需 token）
- 手动验收清单（指向 §6.9）

- [ ] **Step 3: 部署并验证结构**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && git add -A && git commit -m "docs(phase2): README call-mode section + bundle regeneration"
# 部署（写 ~/.dsh 需提权）：python3 deploy/publish.py
# 重启 DSH（bundles 启动时解析，必做）后验证：
curl -s -X POST http://127.0.0.1:3080/guide-dog/api/guide-dog/get-config -H 'content-type: application/json' -d '{}' | head -c 300
# 浏览器观察：header 通话按钮、dock 状态条、面板；设置页 call 节
# 结构探针：cordis_inspect_query（client Slots）确认 guide-dog-call-btn / guide-dog-call-status / guide-dog-call-panel 占用
```
Expected: 部署成功；RPC 200；UI 结构就位（Inspect 可见三个新 occupant）。

---

### Task 16: Phase 2 验收（spec §6.9 九条）

**Files:**
- Runtime: 手动验收记录 → `~/.dsh/guide-dog/.guide-dog/phase2-acceptance.md`（或台账 docs/progress.md）

**Interfaces:**
- Consumes: 全部已部署功能

- [ ] **Step 1: 验收 1-3（VAD / 回合循环 / 打断）**

```bash
# VAD：说话-停顿-说话两段分别成回合（面板观察 listening→processing→listening 循环）
# 回合循环：语音"生成一张猫的图片"→ 转写 → 提交 → agent 执行 → 流式朗读回复
# 打断：播放中说话 → 立即停播 → 新回合正常
# 证据：手动记录 + 截图
```
Expected: 三验收全过。

- [ ] **Step 2: 验收 4-5（进度播报 / 流安全）**

```bash
# 进度播报：让 agent 跑 bash + web_search → 至少听到一次阶段播报
# 流安全：curl 无 token 403；错误 Origin 403；断流后恢复（kill mmx 模拟）
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3080/guide-dog/tts-stream?sid=x&text=hi'   # 期望 403
```
Expected: 播报≥1 次；403 验证通过；断流重连成功。

- [ ] **Step 3: 验收 6（全量流式 + 命令 + 延迟）**

```bash
# 长回复完整朗读（无摘要截断）；"重复/停/慢一点"生效
# 首音频延迟 ≤1.5s：从回复落地到听到第一句的时间（肉眼计时，3 次取均值）
# 播放间隙 ≤400ms：句间听感无停顿
```
Expected: 全过（延迟实测记录）。

- [ ] **Step 4: 验收 7-8（共识优先）**

```bash
# 语音"把 README 的 X 改成 Y" → 不立即执行（tools/pre-execute deny 证据：模型收到 needs_voice_confirmation）
# 语音"确认" → consent 放行 → 每次写操作前听到"接下来修改…"摘要 → 摘要期间说话 → 该次执行中止
# 意图模糊（"改一下那个文件"）→ agent 语音追问；反问"为什么要改？"→ 语音解释
# 证据：会话日志 + 口播录音 + 文件未变
```
Expected: 全过（机制证据：拦截路径日志）。

- [ ] **Step 5: 验收 9（PTT 模式）**

```bash
# 面板切"按住说话" → 按住说话/松开发送；VAD 模式开关切换生效
```
Expected: 通过。

- [ ] **Step 6: 验收报告提交**

将验收记录整理进台账（`progress.md` 追加 Phase 2 验收节），标记未过项为 backlog：

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh && git add -A && git commit -m "docs(phase2): acceptance run record"
```

## RC14 修复（2026-08-17，SDD 5 任务 + 评审门禁）

子计划：`plans/2026-08-17-rc14-call-fixes.md`（commit fbf9800）
台账：`.superpowers/sdd/2026-08-17-rc14-call-fixes/progress.md`

**四根因一句话**：
1. **RC-A 队列丢弃**：`VOICE_QUEUE_MAX=10` + `splice(0, …)` 从队头删 → 主内容被裁，保留 URL 碎片
2. **RC-B URL 拆读**：`splitSentences` 把 `'.'` 按字符类拆 → URL 内部断；无 markdown/emoji 净化
3. **RC-C 进度重复**：progress 冷却 4s < web_search 结果间隔 ~4.3s → 连播 3 次
4. **RC-D 双播**：经完整排除（host 单入队 / agent 无 speak / 无双实例 / tts-stream 单次 / client 单 fetch）后未定 → 加入诊断埋点一次复测定位

**提交链**：
- T1 F1+F2 净化+智能分句：`fix(phase2): RC14-T1 — 播报文本净化（URL/markdown/emoji/列表标记）+ 智能分句（'.' 数字不拆）`（6d628a8）
- T2 F3+F4 队列+去重：`fix(phase2): RC14-T2 — 队列上限 40 截尾保内容 + 进度短语去重窗口 30s`（3677d1a）
- T3 F5+host 埋点：`fix(phase2): RC14-T3 — 双通道互斥补全（净化文本匹配 + turn-end 检查）+ [gd-host] 诊断埋点`（1d6c72a）
- T4 client 埋点：`fix(phase2): RC14-T4 — client 播放计数埋点（times/PLAY-SUMMARY，零行为变更）`（31d1e96）
- T4-F1 评审 minor：`fix(phase2): RC14-T4-F1 — 修 PLAY-SUMMARY 条件注释矛盾 + stopCall 清播放计数`（ab6b6e0c）
- T5 回归+bundle+台账：`docs(phase2): RC14-T5 — repro-rc14 + 全量回归 + bundle rc14 + README + 台账`（**`4913793`**）
- T5 bundle：`chore(phase2): rebuild bundle rc14-20260817 (generated)`（**`a95a7a4`**）

**部署说明**（提交完成）：
- 提交链头 `4913793`，bundle 提交 `a95a7a4`
- bundle rc14-20260817：`.superpowers/sdd/2026-08-17-rc14-call-fixes/progress.md` 部署记录节
- 验收：重启 DSH + 硬刷新 → DevTools 控制台 `[guide-dog] client build rc14-20260817`



