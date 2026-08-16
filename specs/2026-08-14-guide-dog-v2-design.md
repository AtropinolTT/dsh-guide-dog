# Guide Dog for DSH v2 — 设计文档

**日期**：2026-08-14（§6/§7 于 2026-08-14 晚按 Phase 1 实施教训与用户裁决全面修订；§3/§4/§6/§8 于 2026-08-16 按静态 bundle 架构升级修订）
**状态**：已与用户逐节确认（方案 A 单插件演进 + 四节设计 + 3 处契约修正）；Phase 2/3 修订版已确认；**2026-08-16 架构升级为静态 web-profile bundle（v11 全链路验证通过）**
**插件**：`dsh-guide-dog`（静态 web-profile bundle，host/client 双半，**全局单实例**；替代动态插件 + autoloader，无批准弹窗、无 per-session `gdog-*` 副本）
**范围**：语音模式硬化（硬指标）、语音输入、通话模式、无障碍模式

**架构升级说明（2026-08-16，v8-v11）**：交付形态从"动态 Cordis 插件（`cordis_define`/`cordis_run`，每会话一个 `gdog-*` 实例，需批准）"改为"**静态 web-profile bundle**"——`bundle/lib/index.js`（host，ESM `name`/`apply`/`inject`）+ `bundle/lib/client.js`（client，`window.__ModuleLoader__.load({id, factory})`），挂载于 `~/.dsh/profiles/web`（依赖 link + `bundles` 条目 + node_modules symlink），DSH 重启随 profile 自动加载。源码真源仍是 `plugin-host.js`/`plugin-client.js`（动态格式 `return { apply(ctx) {...} }`），`deploy/convert_bundle.py` 将其转换为静态格式。**本文档所有"契约/路径/部署"描述均已按静态 bundle 版本修订**；动态插件时代的历史记录见 `docs/progress.md` v1-v7。

**Phase 2/3 修订总纲（2026-08-14 晚，基于 Phase 1 实施教训）**：

1. **零 WebSocket**：host 沙箱无 socket API、无 WebSocket 全局（仅 `web.fetch`/`subprocess`），spec 原案的"host 代理 MiniMax T2A WebSocket"不可行；且 `WebRoute.handler` 持有原生 `res` 可增量写（源码确认 "may hold the response open"）。故下行改 **chunked HTTP 流**（`mmx speech synthesize --stream` 实测首字节 600ms），上行沿用 Phase 1 已验证的整段 POST。不再需要手写 RFC6455。
2. **共识优先（Consensus-first）**：通话模式/无障碍模式的核心交互范式——与用户有效交流、理解意图、**写入/修改操作与用户达成共识前不执行**；机制保证（`tools/pre-execute` 拦截）而非仅 prompt 软约束；执行前给非常简短的语音摘要 + 打断窗口。
3. **长回复全量流式朗读**（替代原"阈值自动摘要"）：摘要由用户自然回合驱动（"总结一下"），不引入二次 LLM 调用与逐字不一致。
4. **Phase 3 破坏性确认升级**：与共识优先共用同一拦截器，a11y 开启时扩大拦截面。

---

## 1. 背景与目标

Guide Dog for DSH（导盲犬，由 MiniMax 驱动）是 DSH Web GUI 的多模态助手插件。v1 已提供 `speak / image / video / vision / inspect / voices / music / text / search` 九个工具与媒体画廊。v2 的目标：

1. **语音模式成为硬指标**：把 `/audio-conversation` 的能力从"模型自觉调用工具"升级为"机制保证的自动发声"。
2. **语音输入**：输入框内增加麦克风按钮，语音转文字后插入输入框（用户可编辑再发送）。
3. **通话模式**：全双工语音对话（VAD 判断是否在说话、打断、流式 TTS），作为无障碍模式的基础。
4. **无障碍模式**：让视障用户仅凭语音操作 agent 完成任务；提供 GUI 截图 → 视觉转语音服务；充分体现人文关怀。

**总体定位**：语音输入对绝大多数用户已足够（可控制输入长度）；通话模式是无障碍的基础设施；无障碍是最终目标。

---

## 2. 范围与里程碑

| 里程碑 | 内容 | 交付判定 |
|---|---|---|
| **Phase 1** | 语音模式硬化 + 语音输入 | 三条硬指标可演示；语音输入全链路可用 |
| **Phase 2** | 通话模式 | VAD/打断/进度播报/流式 TTS/共识优先全部验收通过 |
| **Phase 3** | 无障碍模式 | 截图→描述→播报闭环 + 共识优先扩展 + 人文关怀约束落实 |

Phase 之间独立验收；Phase 3 依赖 Phase 2 的语音通道、流式 TTS 与共识优先机制。每个 Phase 产出一份独立实施计划（writing-plans），本 spec 是总设计。

**明确不做（Out of scope）**：
- ~~持久化安装~~ → **已由静态 bundle 完成**（2026-08-16：挂载于 `~/.dsh/profiles/web`，DSH 重启自动加载，见 §3 架构升级说明）。
- 语音克隆 / 自定义音色训练。
- 用户屏幕共享（getDisplayMedia）——隐私与授权弹窗对视障用户不友好；后续可选扩展。
- agent 代浏览任意网页并截图——DSH 无浏览器自动化服务，无通道。
- 流式 STT 部分结果（先做整段转写，partials 为后续增强）。
- 通话模式在非 Web 环境（终端）的使用。
- 噪声消除（调研若给出轻量方案，作为 Phase 2 增强项）。
- **WebSocket 双向通道（v1 不实现）**——上下行均有更简单的 HTTP 方案（§6.2）；如实测流式延迟/间隙不达标再升级。
- **长回复自动摘要（v1 不实现）**——全量流式朗读；摘要由用户自然回合驱动（§6.5）。

---

## 3. 总体架构

**方案 A：单插件演进**。`dsh-guide-dog` 保持唯一插件（静态 bundle，全局单实例）；host 按关注点分节组织，client 按特性分组件。

```
dsh-guide-dog (静态 web-profile bundle)
├── Host 半（bundle/lib/index.js，ESM：name/apply/inject）
│   ├── inject    —— export const inject = [shell, fs, webServer, sandboxPolicy, systemPrompt, subprocess, timer, tools]
│   │               （Cordis 服务齐备后才调 apply；无 inject 则 apply 早跑、ctx.get 全 undefined——v9 根因）
│   ├── 兼容层    —— 替代动态沙箱 harness：defineTool（JSON Schema 归一化）/ registerTool（→ tools.register 全局注册，
│   │               每会话可见）/ handle（→ webServer JSON POST 路由 /guide-dog/api/<name>）
│   ├── config   —— ~/.dsh/guide-dog/.guide-dog/config.json 读写（GLOBAL_ROOT = homedir()+'/.dsh/guide-dog'；
│   │               原子写：临时文件+rename，权限 600）
│   ├── tts      —— 现有 mmx TTS 管线 + 媒体库（~/.dsh/guide-dog/.guide-dog/media/，复用 v1）
│   ├── stt      —— faster-whisper 转写（Phase 1 起），MiniMax ASR 可配置备选
│   ├── stream   —— /guide-dog/tts-stream chunked 流式 TTS（Phase 2 起，mmx --stream）
│   ├── consensus —— tools/pre-execute 写操作拦截 + 语音摘要 + 打断窗口（Phase 2 起）
│   ├── tools    —— v1 九个工具 + 语音相关新工具（见 §5.5）
│   └── rpc      —— 兼容层 handle 注册的 JSON POST 路由（speak / transcribe / config / tts-token /
│                   describe-screen / list-media / voices / auth-status / voice-queue）
└── Client 半（bundle/lib/client.js，window.__ModuleLoader__.load({id:'dsh-guide-dog', factory})）
    ├── 兼容层    —— require('react')（平台 seed）、自建 <style> 标签替代沙箱 styles、host.call → fetch JSON POST
    ├── inject    —— 插件对象 inject: ['slots']（client Loader 支持插件级 inject；better-sidebar 先例）
    ├── voiceMode —— host 事件驱动自动发声 + 轮询 voice-queue + toast（Phase 1 已验证）
    ├── micInput  —— composer 麦克风按钮（输入框左下角群组，含实时预览/简体/音量指示）
    ├── callPanel —— 通话面板（shell.overlay）+ 状态条（dock）+ 发起按钮（header action）
    └── a11yBar   —— 无障碍面板（shell.overlay）+ 截图描述流程
```

**已验证的 API 契约（2026-08-14 实测；2026-08-16 按静态 bundle 修订）**：

| 用途 | 契约 | 要点 |
|---|---|---|
| 自动发声数据源（v2 裁决） | host `session/event`（post-commit 追加流）+ `sessionQuery.readSession` | 消息事件含回复文本（与渲染同一内容）；client 轮询 `guide-dog/voice-queue` 播放（`timerSvc.interval` 已确认可用） |
| 麦克风按钮 | `conversation.input.left`（list） | 群组 `guide-dog-voice`（order 30），Phase 1 已落地 |
| 语音模式徽章/通话状态条 | `conversation.input.dock`（list） | 现有占用 order 0/10/20 → 本插件用 **30**（语音徽章已并入 input.left 群组，dock 留给通话状态条） |
| 通话发起按钮 | `conversation.session.header.actions`（list） | 现有占用 -10/10/20 → 本插件用 **30** |
| 通话/无障碍悬浮面板 | `shell.overlay`（list） | 默认 click-through，条目自行 opt-in 指针事件 |
| 下行流式 TTS | `webServer.register` 路由 handler `(req, res)` | handler 持原生 `res`，可 `res.write` 增量写（源码确认 "may hold the response open, e.g. SSE"）；**无需 WebSocket** |
| 写操作拦截 | `tools/pre-execute`（waterfall） | 通话/a11y 模式下拦截写类工具，返回 `needs_voice_confirmation` 待语音共识 |
| 进度播报数据源 | host 事件 | `agent/status`、`tools/result`、`session/event`（持久化事件追加流，含消息落地）、`agent/error` 均存在且按 agent 作用域 emit |
| RPC（静态 bundle） | 兼容层 `harness.handle(name, handler)` → `webServer.register` JSON POST 路由 `/guide-dog/api/<name>` | 逻辑名仍为 `guide-dog/*`（如 `guide-dog/get-config`），**物理 URL 为 `/guide-dog/api/guide-dog/get-config`（name 自带前缀 + 兼容层前缀，双前缀）**；client `host.call(name)` → 同源 fetch POST 同一 URL（v11 实测 200） |
| 工具（静态 bundle） | 兼容层 `harness.defineTool`/`registerTool` → `tools.register` | **全局注册**：注册在 `tools` 服务（profile 级），每会话可见；`defineTool` 把 value-schema DSL（per-property `required:true`）归一化为标准 JSON Schema（v10 根因：JsonSchemaError） |
| 插件加载（静态 bundle） | host：`export {name, apply, inject}`；client：`window.__ModuleLoader__.load({id, factory})` | **host 必须 `export inject` 服务列表**（Cordis 等齐服务才 apply，v9 根因）；client 插件对象声明 `inject: ['slots']`；`require('react')` 为平台 seed 词，可手写、无需构建链（better-sidebar 同款） |
| 提示词注入 | `systemPrompt.section` + `systemPrompt.variable` | 会话级变量 provider 读配置返回当前状态文本 |
| 设置页 | `settings.section`（id `guide-dog`，order 30） | v1 已有，扩展 |

**关键修正（相对初稿）**：
1. 通话回合的用户消息提交**不走 `apiProxy.respond`**（那是传输层回执，不是消息注入入口）；改由 **client 端 `inputActions` 填框+提交**，与语音输入共用同一路径。
2. ~~WS 安全~~ → 流式 TTS 安全：**Origin 严格白名单 + 每会话一次性令牌**（host 签发、5 分钟有效、单连接消费），与初稿 WS 令牌同一思路，套在 `tts-stream` URL 上。
3. 无障碍自动截图触发点：**`tools/result`**（工具完成）而非静默期探测。
4. **传输层改零 WebSocket**：`mmx speech synthesize --stream`（实测首字节 600ms）+ chunked HTTP 流覆盖下行，整段 POST 覆盖上行。（2026-08-16 注：静态 bundle host 半跑在 DSH host Node 进程、非动态沙箱，理论上 Node 22+ 自带 WebSocket 客户端全局——但零 WS 决策不变：chunked HTTP 已实测达标、无新协议面、浏览器/CLI 双端复用同一管线。）

---

## 4. 配置模型

文件：`~/.dsh/guide-dog/.guide-dog/config.json`（**GLOBAL_ROOT = `homedir() + '/.dsh/guide-dog'`**，与媒体库同根；v8 起不再用 workspaceRoot/sandboxPolicy 推导——静态 bundle 全局单实例，root 恒定）。host 启动时加载到内存，写操作走原子写。client 通过 RPC `guide-dog/get-config` / `guide-dog/set-config` 读写（物理 URL：`POST /guide-dog/api/guide-dog/get-config` 等）。

```jsonc
{
  "voiceMode": {
    "default": false,          // 全局默认（两层设置的第一层）
    "sessions": {}             // { [sessionId]: boolean } 会话级 override（第二层）
  },
  "voiceInput": {
    "autoSend": false,         // 识别后是否自动发送（默认 false：插入输入框，用户编辑后发送）
    "engine": "whisper",       // "whisper"（本地 faster-whisper，现役唯一）| "sherpa"（增强）| "minimax"（保留位：MiniMax 发布公开 ASR 后启用）
    "language": "auto",        // "auto" | "zh" | "en"（UI 三档语言开关，降 zh/en 短句误判）
    "maxSeconds": 60,          // 典型 15s 内（faster-whisper 小文件延迟最优），上限 60s
    "whisper": { "python": "python3", "model": "small" }   // faster-whisper；模型 base|small
  },
  "call": {
    "mode": "vad",               // "vad"（默认，自动端点检测）| "ptt"（按住说话）
    "vad": {
      "method": "energy",        // "energy"（Phase 2 v1）→ "silero"（web-vad 浏览器 WASM，升级）| "sherpa"（VAD+ASR 一体）
      "threshold": 0.02,         // RMS 能量阈值（背景噪声大时调高）
      "silenceMs": 700,          // 静音判定说话结束（LiveKit 轮转区间 0.5–3s）
      "minSpeechMs": 300,        // 最短语音（LiveKit 建议 ~500ms）
      "maxSegmentSeconds": 60,   // 单段上限
      "interruptMinMs": 300      // 打断最短时长门槛（防误触；Ultravox 用 90ms）
    },
    "stream": {
      "format": "pcm",           // mmx --stream --format pcm（s16le 单声道）
      "sampleRate": 24000,       // 实测可用；默认 32000
      "sentenceSplit": "。！？.!?\n",  // 分句正则字符集
      "maxSentenceChars": 200    // 超长句强制截断（防单句首字节延迟失控）
    },
    "voice": "English_expressive_narrator",
    "speed": 1.0,
    "progress": true,            // 进度播报开关
    "consensus": {
      "enabled": true,           // 共识优先：写操作拦截 + 语音摘要 + 打断窗口
      "summaryWindowMs": 3000    // 摘要播报后等待用户打断的窗口
    }
  },
  "a11y": {
    "enabled": false,
    "autoNarrate": true,         // 工具完成后自动截屏描述（防抖 3s + 节流 10s）
    "visionCloud": true,         // 截图是否允许发往 MiniMax vision（关 = 仅本地 DOM 文本提取）
    "summaryFirst": true         // 渐进式披露：默认先播概要
  },
  "tts": { "voiceEn": "English_expressive_narrator", "voiceZh": "Chinese (Mandarin)_Gentle_Youth", "speed": 0.95, "format": "mp3" }
}
```

生效规则：`voiceMode 生效值 = sessions[sessionId] ?? default`；**a11y 例外**（§7.1）：`a11y.enabled=true` 时生效值强制 `true`（优先级高于会话 override 与全局默认）。

---

## 5. Phase 1 — 语音模式硬化 + 语音输入

### 5.1 语音模式（硬指标）

**硬指标定义（用户确认的三条保证）**：

1. **机制保证**：语音模式开启时，每次 assistant 回复落地**必然**触发 TTS 发声，与模型是否调用工具完全无关。
2. **文字与语音逐字一致**：TTS 输入文本 = 该回复在对话中渲染的同一份 text blocks（唯一来源）；仅按 audio-conversation 规则做朗读性变换（剥离代码块/URL/符号），语义与文字不变。
3. **失败必反馈**：TTS 失败时播放失败提示音 + 右下角即时通知（toast，显示失败原因，约 6 秒自动消失），绝不静默。

**机制实现（自动发声钩子，v2 裁决：host 事件驱动）**：

> 实施期探测证实：client 的 `useSession()` 快照为 Proxy/类实例（`Object.keys` 为空，`messages/turns/nodes` 均 undefined），`turnTail` 的 owner.turn 亦无消息文本字段——client 侧无法可靠提取回复文本。故机制改为 host 事件驱动（三条硬指标不变）：

- host 监听 `session/event`（post-commit 追加流）：命中 assistant 消息事件且该会话语音模式生效时，从事件消息内容提取文本（与对话渲染的同一份内容）→ 去重（`spokenTurns`，sessionId+seq）→ `speakImpl({text, sessionId, turnSeq, source:'voice-mode'})` → 成功入队 `voiceQueue[sessionId]`（含 url/key），失败入队错误项。
- client 在输入框左下角 VOICE 群组内以 `timerSvc.interval`（1s）轮询 RPC `guide-dog/voice-queue`（带 sessionId，host 弹出即交付一次）→ 模块级 `Audio` 播放 / 错误项显示失败 + 提示音。（静态 bundle 下 RPC 物理路径 `POST /guide-dog/api/guide-dog/voice-queue`，client `host.call` 兼容层自动拼接，代码内逻辑名不变。）
- **去重**：host 级 `Map<sessionId, Set<seq>>` 双保险（speakImpl 内已有）；队列弹出即消费，不重复播放。
- **播放（会话级语义，v2.1 用户裁决）**：client 以模块级 `Audio` 对象播放（轮询在会话组件内，播放本身脱离会话组件生命周期）——**切换会话不重播、不中断**：正在播放的音频自然播到结束；仅当出现新的播放任务（任一会话的新队列条目）时才覆盖当前播放。播放结束/失败/被浏览器阻止均清理并显示错误（绝不静默）。
- **失败反馈**：speakImpl 失败 → 队列错误项（error code + message）→ client 播放失败提示音（beep RPC data-URI）+ 右下角 toast 显示"朗读失败：<原因>"（约 6 秒自动消失）；尝试次数 ≤2，不重试循环。
- **两层设置**：
  - 全局默认：`config.json → voiceMode.default`（默认 `false`），设置页（settings.section `guide-dog`）管理。
  - 会话 override：`voiceMode.sessions[sessionId]`，由输入框左下角小喇叭按钮点击切换。
  - UI（v2.1 用户裁决）：`conversation.input.left`（order 30，id `guide-dog-voice`）常驻群组 = **[小喇叭] [语言检测下拉] [麦克风]**；小喇叭单击切换会话 override（开=成功绿/关=次级色），悬浮提示"语音模式提示：开/关 · 全局默认：开/关（点击切换）"；语言下拉（auto/zh/en）替代原三档循环按钮；麦克风用简洁 SVG 图标（feather 风格细线，录制态红色脉冲+秒数）。样式使用 DSH 主题令牌（`--dsw-alias-*`），字体继承输入行，与 DSH 设计语言一致。
- **模型感知**：`systemPrompt.variable('guide_dog_voice_mode', provider)` 按会话注入"语音模式：开。本条回复会被自动朗读，不要在回复中描述音频状态，保持文字与朗读内容一致。"（variable provider 在 host 侧读配置，随会话切换；变量名须匹配 `/^[a-z][a-z0-9_]*$/`）。
- **与 v1 工具的关系**：`guide_dog_speak` 工具保留（模型主动朗读场景，如无障碍模式主动播报），与语音模式共用 TTS 管线与去重；`source` 字段区分。

### 5.2 语音输入

- 入口：`conversation.input.left` VOICE 群组内（id `guide-dog-voice`，order 30，输入框左下角）的麦克风按钮；语言检测用群组内下拉（auto/zh/en，映射 `voiceInput.language` 语义，模块级偏好跨会话延续）。
- 流程：
  1. 点击开始录音：`getUserMedia({audio: true})` + `MediaRecorder`（优先 `audio/webm;codecs=opus`；后续可升级 AudioWorklet 裸 PCM 直采以省编解码），按钮进入红色脉冲态并计时（上限 `voiceInput.maxSeconds`，到时自动停止）。按钮旁提供语言三档开关（自动/中文/英文，映射 `voiceInput.language`）。
  2. 停止 → `blob → arrayBuffer → base64` → `host.call('guide-dog/transcribe', { audioB64, mime, sessionId, language })`。
  3. host：base64 解码 → 临时文件 `~/.dsh/guide-dog/.guide-dog/tmp/rec-<ts>.webm` → STT（§5.3）→ 返回 `{ ok, text, language, durationMs }`；成功后删除临时文件。
  4. client：文本插入 composer——`inputActions` 追加/设置文本并聚焦（具体方法名以实施期核实的 `InputActions` 契约为准）；`autoSend=false`（默认）仅插入，用户编辑后发送；`autoSend=true` 插入后立即提交。
- 状态机：`idle → recording → transcribing → idle | error`。录音中再次点击 = 停止；错误态：麦克风权限拒绝（徽章+提示"请在浏览器设置中允许麦克风"）、识别为空（"没听清，请再说一次"，语音模式开启时口播）、STT 引擎不可用（提示安装指引，见 §5.3）。延迟预算：松键后 2–4s 出字（≤15s 音频 + faster-whisper CPU 1.5–2.5s）属正常。
- 隐私：whisper 引擎下音频只写临时文件、用后即删，不出本机；minimax 引擎下音频上云，config 中明示（§9）。

### 5.3 STT 引擎（本地为主——调研已确认 MiniMax 无公开 ASR）

调研结论（2026-08，官方文档核实）：MiniMax **只有 TTS**（HTTP + WebSocket），**无公开 ASR/STT、无 realtime 语音 API、无 asr-01 模型**（官方同传 demo 的语音识别用的是 Whisper）。因此 STT 必须本地或浏览器侧。

- 首选 **whisper**（faster-whisper）：host 启动时探测 `python3 -c "import faster_whisper"`；缺失时 RPC 返回 `engine_unavailable` + 安装指引（`pip install faster-whisper`），设置页显示探测状态与一键指引。15s 音频 CPU int8 转写约 1.5–2.5s。
- 转写调用：`subprocess` 服务 spawn `python3 <plugin 内置脚本> --model small --output json`（脚本由 host 在首次启动时通过 fs 服务写入 `~/.dsh/guide-dog/.guide-dog/scripts/whisper_transcribe.py`，输入路径、输出 `{text, language, durationMs}` JSON）。模型 `base`/`small` 可配置；语言取 `voiceInput.language`（`auto` 时逐窗口自动检测，zh/en 短句偶有误判→三档开关兜底）。
- 增强 **sherpa**（`engine: "sherpa"`）：sherpa-onnx（Zipformer 中英流式 / SenseVoice 中文·粤·日·韩 VAD+ASR 一体，官方有浏览器 WASM 演示）——通话模式升级路径（§6.3），语音输入也可选。
- **降级（Phase 1 决策）**：本地引擎缺失时，语音输入回退为 **host 托管录音页**（`/guide-dog/recorder`，独立页面 MediaRecorder → 上传转写，仍走本地 whisper）——浏览器沙箱限制下也保证可用；Web Speech API（浏览器→云端识别、Chrome 系、不可控）列为后续可选降级，Phase 1 不实现。
- 保留位 **minimax**：MiniMax 发布公开 ASR 端点后启用（config 已留位）。
- 超时：转写超时 60s，超时报 `stt_timeout`。

### 5.4 Phase 1 验收

1. **硬指标 1**：语音模式开启后，构造一次"模型未调用任何 speak 类工具"的回复——回复落地自动发声（观察 VOICE 群组小喇叭状态与音频播放），证明与工具调用解耦。
2. **硬指标 2**：语音模式开启，输出含 markdown 的回复——朗读内容与可见文本语义一致（代码块/URL 按规则剥离）；关闭时无自动发声。
3. **硬指标 3**：临时断网/伪造 TTS 失败——播放失败提示音、右下角 toast 显示失败原因、不静默。
4. 两层设置：全局默认关→会话开→新会话恢复默认；小喇叭状态显示正确。
5. 语音输入：录音→识别→插入输入框（未自动发送）→编辑→发送成功；自动发送开关生效；权限拒绝与空识别错误路径可见。

---

## 6. Phase 2 — 通话模式

**总纲**（2026-08-14 晚修订）：传输层**零 WebSocket**（下行 chunked HTTP 流 + 上行整段 POST）；交互**默认 VAD 自动、可切按住说话**；新增**共识优先**交互层（§6.7，机制保证"共识前不写改"）。

### 6.1 入口与界面

- `conversation.session.header.actions`（order 30，id `guide-dog-call`）：通话开关按钮。
- `shell.overlay`（id `guide-dog-call-panel`）：通话面板——状态行（收听中/处理中/播报中）、**模式开关（VAD 自动 ↔ 按住说话）**、静音、语速调节、挂断。
- `conversation.input.dock`（order 31，id `guide-dog-call-status`）：通话状态条（简短，供语音模式小喇叭旁并排）。
- 会话切换语义沿用 v2.1 裁决：播放继续不重播；**录音中切会话 → 丢弃当前片段不误提交**（防 M9 类陈旧闭包）。

### 6.2 双通道（零 WebSocket）

**为什么放弃 WebSocket**：动态沙箱时代 host 内置符号仅 `ctx/harness/console/btoa/atob/TextEncoder/TextDecoder`——无 socket API、无 WebSocket 全局；`web.fetch` 仅 HTTP、`subprocess` 只能 spawn CLI，**host 无法直连 `wss://api.minimax.io`**（spec 初稿 §6.5 主通道不可行）。2026-08-16 静态 bundle 后 host 半跑在 DSH host Node 进程（非沙箱），Node 22+ 自带 WebSocket 客户端——但**零 WS 决策不变**：① `mmx speech synthesize --stream`（实测首字节 600ms）已达标，chunked HTTP 无新协议面；② `WebRoute.handler = (req, res)` 持原生 node:http 对象（源码确认 "may hold the response open, e.g. SSE"），`res.write` 增量写即 chunked 流，浏览器/CLI 双端复用同一管线；③ 避免 host 侧 WS 客户端生命周期（重连/心跳/代理）全部自研的新失败面。

- **上行（client→host，回合制）**：录音整段 → `POST /guide-dog/call-transcribe`（webm/opus，≤20MB，复用 Phase 1 `transcribeImpl` 与 whisper 管线）→ `{ok, text, language}`。与 Phase 1 麦克风完全同管线，无新协议。
- **下行（host→client，流式）**：`GET /guide-dog/tts-stream?token=…&sid=…&text=<句>` → host 按句 spawn `mmx speech synthesize --stream --format pcm --sample-rate 24000`，stdout 管道增量喂 `res.write` → client `fetch().body.getReader()` 读流 → Web Audio 无缝调度播放。
- **安全**：① Origin 白名单（host 侧比对 `Origin` 头）；② 每会话一次性 token（`host.call('guide-dog/tts-token', {sessionId})` 签发，5 分钟有效、单连接消费、host 内存保存——初稿 WS 令牌同一思路，套在 URL 上）；③ 流句文本必须属于该会话（token 绑定 sessionId）。
- **失败兜底（若 chunked 流实测不可靠）**：降级为逐句 mp3 文件 + `voiceQueue` 轮询播放（Phase 1 已验证模式）；以"首音频延迟 <1.5s、播放间隙 <400ms"为判据选择。

### 6.3 回合循环

```
用户说话 ──VAD──> audio-end（静音 700ms）
   └─> POST /guide-dog/call-transcribe（整段 webm）
        └─> {ok, text} → client: inputActions 填框 + 提交（与语音输入同路径）
             └─> agent 运行（DeepSeek，工具全保留）
                  ├─ 进度播报（§6.4）
                  ├─ 共识优先拦截（§6.7，写类工具）
                  └─ 回复文本落地（session/event）
                       └─> 分句 → 流式 TTS（§6.5）→ chunked HTTP 下行播放
                            └─ 播放中 VAD 检测到用户发声 → barge-in（§6.6）→ 回到顶部
```

- 采集：**MediaRecorder（webm/opus）+ 并行 AnalyserNode 能量检测**（Phase 1 已验证路径；AudioWorklet 16kHz 裸 PCM 留作升级位，免编解码直喂 VAD/STT）。
- VAD（Phase 2 v1）：`call.vad.method='energy'`——RMS 能量阈值（`call.vad.threshold`，背景噪声大时调高）、静音 700ms 判定结束、最短语音 300ms、单段上限 60s。
- VAD 升级路径（调研结论）：`call.vad.method='silero'`——**web-vad**（Silero ONNX + AudioWorklet，浏览器内跑，Pipecat 客户端同款，打断延迟最低）；`sherpa`——sherpa-onnx（VAD+ASR 一体）。参数借鉴：LiveKit 轮转区间（静默 0.5–3s）、Ultravox 分层 VAD + 打断最短 90ms 门槛（本 spec 用 `interruptMinMs: 300`）。
- **PTT 模式**（`call.mode='ptt'`）：按住面板麦克风说话、松开即发送（WhatsApp 式）；VAD 参数在 PTT 下不参与端点判定（仅做打断监测）。用户可自行决定 VAD 体验不好时切换。
- 每轮消息照常渲染进对话流（语音只是附加通道），用户可随时切回打字。

### 6.4 进度播报（不静默原则）

host 监听（按会话过滤，`this: Scoped<Agent>` 事件天然按 agent 作用域；事件存在性已实测确认）：

| 事件 | 播报短语 |
|---|---|
| `agent/status` → running | "正在处理" |
| `tools/result` | 工具名 → 短语映射：`bash`→"正在执行命令"、`read`/`grep`/`glob`→"正在查找文件"、`write`/`edit`→"正在修改文件"、`web_search`→"正在搜索网页"、`guide_dog_image/video/music/speak`→"正在生成媒体"、`skill`→"正在调用技能"，未知工具→"正在执行操作" |
| `agent/error` | "处理出错：<短原因>" |
| `session/event`（assistant 消息落地） | 触发 §6.5 回复朗读 |

播报走同一 TTS 管线（短句、可被打断），与回复朗读共用队列：播报优先、回复让路。

### 6.5 流式 TTS

- **主通道**：`mmx speech synthesize --stream --text <句> --format pcm --sample-rate 24000 --voice <call.voice> --speed <call.speed>`（spawn 于 host，stdout 管道 → `res.write`）。**实测**：中文短句首字节 600ms、全句 1s（24kHz s16le 单声道）——满足"首音频 <1.5s"验收。
- 回复文本按句切分（`。！？.!?\n`）逐句合成；`stream.maxSentenceChars=200` 超长句强制截断（防单句首字节延迟失控）；**句间预合成**（当前句播放时后台合成下一句，借鉴 LiveKit preemptive generation）——发起方为 client：当前句播放期间即提前请求下一句流（`GET tts-stream?seg=N+1`），host 合成完成即从流头开始缓冲，当前句结束无缝衔接。
- client 播放：fetch 读流 → 累积 PCM → WAV 包装 → `decodeAudioData` → `AudioBufferSourceNode` 定时队列无缝调度（验收判据以 §6.9 为准：首音频 ≤1.5s、播放间隙 ≤400ms）。
- **长回复**：**全量流式朗读**（用户裁决 A，替代初稿"阈值自动摘要"）——不设摘要分支；用户想听摘要时自然回合说"总结一下刚才的回复"即可（agent 总结 → 照常播报）。理由：①自动摘要引入二次 LLM 调用、新失败面与"播报≠渲染"的逐字不一致；②用户驱动的摘要零插件代码；③打断/语速/重复已覆盖长回复听感痛点。升级位（Phase 2 增强 backlog）：超长回复先播一句"回复较长（约 X 分钟）"提示。

### 6.6 打断（Barge-in）

- **协议照抄 Pipecat 的 InterruptionFrame 语义**：VAD 触发（≥`interruptMinMs` 300ms 防误触）→ ① 浏览器**立即停止播放并清空未播缓冲**（一个音频写周期内静音）→ ② abort 当前 `tts-stream` fetch → ③ host 终止在途 mmx 进程（`SubprocessHandle.terminate`）→ ④ 新语音自然成为下一回合。
- 参数借鉴 LiveKit adaptive 打断：最短语音 ~0.5s、误判后 2s 内无有效转写则从被中断句恢复重播。
- 静音/无声 turn：VAD 判定说话但转写为空 → 不提交空消息，播报"没听到，请再说一次"。

### 6.7 共识优先（Consensus-first，核心交互范式）

**目标**（用户裁决）：通话模式的关键是**与用户有效交流、理解用户意图、通过语音提供必要信息**（参考 grill-me 逻辑——设计树/前沿轮询/确认门）；**切忌在与用户达成共识之前执行写入以及修改操作**。

**生效范围**：仅通话模式与 a11y 模式开启时；打字模式保持 Phase 1 现状。

**双层机制**（Phase 1 教训：机制保证 > 提示约束）：

1. **prompt 层（软约束）**——`guide_dog_call_consensus` systemPrompt variable，通话模式开启时随每次模型调用注入，措辞为**聊天感**（非命令腔）：

   > 用户正通过语音和你对话，像和合作伙伴讨论一样：先理解意图，不清楚就问（问多少看实际情况，语音通道保持简洁）；主动说明关键信息；**写入/修改前先简短说明要做什么，等用户点头**；用户随时可能提问或插话，认真回应。

   - **问题数不设硬上限**：意图模糊/方案有分叉时多问几个，意图明确时直接干（grill-me 的前沿轮询精神，按语音通道裁剪为每轮最多 1–3 个关键问题，避免审讯感）。
   - **双向交流**：用户可随时提问（"什么是 X？""为什么选这个？"）——这类问题**不进语音命令表**，作为普通回合由 agent 回答；agent 提供选项时带一句通俗背景，让用户能理解后提问。

2. **机制层（硬保证）**——`tools/pre-execute` 瀑布拦截器（host 事件已确认存在，waterfall 可异步 hold）：

```
写类工具触发（write/edit + bash 破坏性命令启发式：rm/mv/cp/truncate/dd/覆盖重定向/git push 等）
   │
   ├─ 本轮无 consent ──► 拦截返回 {error:'needs_voice_confirmation'}
   │                      agent 读结果后语音提问（聊天式："接下来要修改 X，可以吗？"）
   │                      → 用户语音回答（"确定"是普通回合，命令表不截胡）
   │                      → host 内存标记 consent = {sessionId, turnSeq}
   ▼
consent 已就绪（或刚确认）
   │
   ▼
每次执行前：host 播报【非常简短的摘要】（拦截器用工具入参生成一句话：
   "接下来修改 README.md，追加一段文档"，直接 TTS，不走模型）
   │
   ▼
等待窗口（call.consensus.summaryWindowMs=3000）：VAD 监听用户发声
   ├─ 用户说话 → 中止本次执行（工具尚未启动）→ 用户语音进入新回合
   └─ 无发言 → 放行执行
```

- **确认粒度**：一次语音确认放行**本轮通话内全部写操作**（多文件任务不啰嗦）。
- **打断机会**：摘要播报后的等待窗口 + 播放中 barge-in 双保险——**窗口期内工具物理上尚未启动**，用户说话即中止，这是机制保证的"执行前打断机会"，不依赖模型自觉。
- **放行后**：`tools/post-execute`（可选）继续观察；执行结果由进度播报（§6.4）与回复朗读自然覆盖。

### 6.8 容错

- 流中断（fetch 读流 error/EOF 异常）：自动重连一次（重新申请 token）→ 失败口播"连接中断"；重连成功播报"连接恢复"。
- STT 失败：口头"没听清/转写失败"，不提交。
- TTS 失败：文字照常落地 + 失败提示音 + 面板错误状态（不静默）。
- 通话中 agent 长时间无响应（>120s 无任何事件）：播报"仍在处理，请稍候"（心跳探测）。
- 共识拦截器自身失败（无法生成摘要/窗口计时异常）：**保守放行或拒绝？**——裁决：**拒绝并口播原因**（宁可拦错不可放错，与"共识前不写改"一致）；用户可语音"继续执行"或手动重试。

### 6.9 Phase 2 验收

1. VAD：说话-停顿-说话两段分别成回合；静音判定不误切（背景噪声阈值可调）。
2. 回合循环：语音 → 转写 → 提交 → agent 执行（含工具调用）→ 回复朗读，端到端可完成一次"用语音让 agent 生成图片/搜索"。
3. 打断：播放中说话即停，下一回合正常；误打断 2s 兜底重播。
4. 进度播报：agent 执行工具期间至少播报一次阶段状态。
5. 流安全：非白名单 Origin 与无/错 token 拒绝；断流重连后恢复。
6. 全量流式：长回复完整朗读；"重复/停/慢一点"命令生效；首音频延迟 ≤1.5s、播放间隙 ≤400ms（实测）。
7. 共识优先（语音"把 README 的 X 改成 Y"）：不立即执行 → 语音确认 → 确认后每次写操作前听到简短摘要 → 摘要期间说话 → 该次执行被中止、用户语音成为新回合；未确认时 write/edit 被拦截（检查 `tools/pre-execute` 拦截路径，机制证据）。
8. 意图模糊（如"改一下那个文件"无上下文）→ agent 语音追问关键问题，不臆测执行；用户反问"为什么要改？"→ agent 语音解释。
9. PTT 模式：按住说话/松开发送；VAD 模式下模式开关切换生效。

---

## 7. Phase 3 — 无障碍模式

### 7.1 目标与联动矩阵

视障用户仅凭语音操作 agent 完成任务。叠加在 Phase 1+2 之上：语音模式自动开启、通话模式为默认交互（含共识优先）、截图→视觉转语音补齐"agent 展示了什么"的信息缺口。

**联动矩阵**（`a11y.enabled = true` 时自动生效）：

| 联动项 | 机制 |
|---|---|
| 语音模式强制开 | effectiveVoiceMode 检查加 a11y 优先级：`a11y.enabled ? true : (sessions[sid] ?? default)` |
| 通话面板常驻 | call panel overlay 在 a11y 开启时不自动收起 |
| 共识优先扩大拦截面 | §6.7 同一拦截器：从"写类工具"扩大为**所有可能破坏状态的操作**（发送/删除/覆盖等），并注入更强约束文本 |
| 自动截图播报 | `tools/result` 监听（已确认存在）→ 界面改变类工具白名单 → 防抖 3s + 节流 10s |
| systemPrompt 约束注入 | `guide_dog_a11y_constraints` variable（Phase 1 已验证机制），仅 a11y 开启时注入 |

### 7.2 截图 → 描述 → 播报

- 入口：`shell.overlay`（id `guide-dog-a11y-panel`）控制面板 + 语音命令（"看看屏幕"）+ 设置页开关。
- **捕获（本地，无第三方依赖）**：主选 `foreignObject` 方案——`<svg><foreignObject>` 序列化 `document.documentElement` **视口** → canvas → **JPEG** base64（修订：原 PNG 在 4K 屏可达 8MB+，JPEG q0.8 + maxWidth 1600px 约 200–500KB，GUI 无透明需求；同源媒体不产生 canvas 污染）；备选：host 首次运行时经 `web.fetch` 下载固定版本 html2canvas UMD 到 `~/.dsh/guide-dog/.guide-dog/lib/`，经 `/guide-dog/lib/` 同源托管，client `<script>` 加载（渲染保真度不足时启用）。不做全页滚动拼接（视障用户以当前视口为上下文）。
- 调研对照：html2canvas 零权限但保真度低（复杂 CSS/WebGL 丢失、跨域资源污染需代理）；CDP `Page.captureScreenshot` 像素级但需浏览器自动化（DSH 无此服务，out of scope）；`getDisplayMedia` 真实屏幕需授权（out of scope）。
- **描述**：`host.call('guide-dog/describe-screen', { imageB64, mode })`（优先 RPC——Phase 1 已验证 20MB 级 base64 RPC；若实测受限退 `POST /guide-dog/describe-upload`）→ host 调 MiniMax vision（复用 v1 `guide_dog_inspect` 管线）→ 返回结构化文本。三种模式：
  - `summary`：1–2 句概要——界面在做什么、关键状态、有无错误/新内容。
  - `detailed`：元素级清单（按钮/输入框/列表/媒体等，含可操作语义）。
  - `ordered`：自上而下逐块播报。
- **提示词硬约束**（写入 vision prompt）：颜色/图标/布局必须转成文字语义（"有错误提示"而非"红色的字"）；标注可交互元素与当前焦点位置；不臆测不可见内容。
- **播报**：结果经 TTS 管线朗读；`summaryFirst=true` 时默认只播概要，"详细/继续"才展开。
- **自动触发**：`a11y.autoNarrate=true` 时，host 监听 `tools/result`（本会话）→ 仅**界面改变类工具**入队列：`bash / write / edit / web_search / guide_dog_image / guide_dog_video / guide_dog_music`（read/grep/glob/skill 等静默，防轰炸）→ 防抖 3s + 节流 10s → `a11yQueue[sessionId]`（与 voiceQueue 同款轮询模式，client 1s 轮询）→ client 截屏 → describe（summary 模式）→ 播报。
- **生成媒体自动描述**：`guide_dog_image/video/music` 完成后，除界面概要外追加一句对生成物的 vision 描述（§7.3-2 的"拒绝纯视觉信息"落地，复用 `guide_dog_inspect` focus 逻辑）。
- **历史**：描述文本存入 `~/.dsh/guide-dog/.guide-dog/a11y-history/`（纯文本 md，**不存截图**）。
- **本地降级**：`a11y.visionCloud=false` 时不上云——client 本地提取可见文本（text nodes + `aria-label` + role）按 DOM 顺序拼接 → 截断 2000 字符 → 作为概要直接播报；"详细/按顺序播报"降级为同一文本概要，面板注明"本地模式"。

### 7.3 人文关怀硬约束（需求级，验收项）

> 参考实现（调研）：Be My AI（用户主动发起 + 分层详细回答 + 志愿者兜底）、Seeing AI（结构化通道模式）vs Lookout（连续实时反馈）；规范依据：WCAG 1.4.1（状态不只用颜色）、WCAG 3.3.4（破坏性操作错误预防）、ARIA Disclosure 模式（渐进披露）；交互范式参考 grill-me（设计树/前沿轮询/确认门——共识前不行动）。

| # | 约束 | 落地机制 | 机制强度 |
|---|---|---|---|
| 1 | 渐进式披露 | `summaryFirst` + "详细/继续"展开 + "按顺序播报"（ARIA Disclosure 语义） | ✅ 机制保证 |
| 2 | 拒绝纯视觉信息 | vision prompt 硬约束（颜色/图标→文字语义）+ 生成媒体自动描述 | ✅ 机制保证 |
| 3 | 状态播报 | Phase 2 进度播报 + 不静默原则（失败口播+toast） | ✅ 机制保证 |
| 4 | **破坏性/写改操作语音确认** | **共识优先机制扩展**（§6.7 同一拦截器）：a11y 开启时拦截面扩大为全部破坏状态操作（发送/删除/覆盖等）+ 更强约束文本 + 执行前摘要 + 打断窗口 | ✅ **机制保证**（升级自初稿的 prompt 软约束） |
| 5 | 节奏控制 | 语音命令"停 / 暂停 / 继续 / 重复 / 慢一点 / 快一点"（暂停/恢复播放、语速 0.8/1.2、重播当前句） | ✅ 机制保证 |
| 6 | 隐私边界 | 截图仅用于本次描述、不持久化原图；`visionCloud` 开关明示云端处理；a11y-history 纯文本；音频同 §9 | ✅ 机制保证 |
| 7 | 操作可达 | 所有功能均可语音触发（通话+语音命令），不要求任何键盘/鼠标操作 | ✅ 机制保证 |
| 8 | 错误可恢复 | 任何失败都有口头说明与重试路径，不进入死胡同 | ✅ 机制保证 |

### 7.4 无障碍模式开关与语音命令集

- 设置页 `guide-dog` 一节：`a11y.enabled` 开启时自动触发 §7.1 联动矩阵全部项。
- 语音命令集（本地匹配，命中不提交、直接执行）：

| 命令 | 动作 |
|---|---|
| 看看屏幕 | 手动截屏 → 描述（遵循 summaryFirst）→ 播报 |
| 详细 / 展开 | 当前屏幕描述从 summary 展开为 detailed |
| 按顺序播报 | ordered 模式重播 |
| 停 / 暂停 / 继续 | 播放/播报控制（继续：无播报时=展开详细，有播报时=恢复播放） |
| 重复 | 重播当前句/当前屏幕描述 |
| 慢一点 / 快一点 | 语速 0.8 / 1.2 |

- **"确定 / 取消"不进命令表**——它们必须作为普通回合内容传给 agent（破坏性确认与共识对话由 agent 主持，插件不能截胡）。

### 7.5 Phase 3 验收

1. "看看屏幕"：截图→vision 描述→播报，summary/detailed/ordered 三模式。
2. 自动播报：agent 完成一个工具步骤（界面改变类）后 10s 内自动播报界面概要（节流/防抖验证）。
3. 纯语音完成任务：全程不碰键盘鼠标，语音指示 agent 完成一个多步任务（如"生成一张图并描述它"），破坏性操作出现语音确认（共识拦截器证据）。
4. 隐私：`visionCloud=false` 时断网仍可本地文本概要；`~/.dsh/guide-dog/.guide-dog/a11y-history/` 无图片文件。
5. 节奏命令与打断在无障碍模式下全部生效。
6. 联动矩阵：a11y 开启时即使 `voiceMode.default=false` 也自动朗读；通话面板常驻。
7. 约束注入：`guide_dog_a11y_constraints` / `guide_dog_call_consensus` 变量随每次模型调用注入（可在会话日志/提示词装配中验证）。

---

## 8. 横切设计

### 8.1 媒体与文件

- 复用 v1 媒体库（`~/.dsh/guide-dog/.guide-dog/media/` + `.index.json` + `/guide-dog/media` 路由）。
- 新增目录（全部在 GLOBAL_ROOT = `~/.dsh/guide-dog` 下）：`~/.dsh/guide-dog/.guide-dog/tmp/`（录音临时文件，用后即删）、`~/.dsh/guide-dog/.guide-dog/scripts/`（whisper 转写脚本，host 启动时写入）、`~/.dsh/guide-dog/.guide-dog/lib/`（html2canvas 备选库）、`~/.dsh/guide-dog/.guide-dog/a11y-history/`（纯文本）、`~/.dsh/guide-dog/.guide-dog/models/`（faster-whisper 模型缓存，v1 起）。
- 大小上限：transcribe 音频 ≤20MB；describe-screen 图片 ≤8MB。

### 8.2 安全与隐私

1. 流式 TTS：Origin 白名单 + 每会话一次性令牌（§6.2）。
2. API key 永不进入浏览器（TTS/vision 全部 host 侧执行）。
3. 语音输入：whisper 引擎音频不落盘不出本机；minimax 引擎上云，config 明示。
4. 截图：原图不持久化；云端处理有显式开关。
5. `config.json` 权限 600；媒体路由沿用 v1 的 basename/扩展名白名单与遍历防护。
6. 共识拦截器放行窗口仅 host 内存（consent 不落盘）；会话结束/插件重启即失效。

### 8.3 错误码（统一枚举）

`bad_args / tts_failed / tts_timeout / stt_failed / stt_timeout / engine_unavailable / mic_denied / empty_speech / stream_rejected / stream_interrupted / vision_failed / config_write_failed / needs_voice_confirmation / aborted_by_user / consensus_failed`——client 统一映射为提示音 + 文案 + （语音模式开启时）口播。**零 WS 决策下不再有 `ws_rejected`/`ws_lost`**：流安全拒绝用 `stream_rejected`（token/Origin 校验失败），流中断用 `stream_interrupted`。

### 8.4 设置页扩展（settings.section `guide-dog`）

语音模式（全局默认 + 当前会话 override 说明）、STT（引擎选择 + whisper 探测状态 + 模型大小）、通话（模式 VAD/PTT、音色/语速/VAD 参数、共识开关与窗口）、无障碍（开关/自动播报/visionCloud/summaryFirst）、媒体画廊（v1 保留）。

---

## 9. 实施顺序与依赖

> **部署与验证流程（2026-08-16 静态 bundle 定案）**：每个 Phase 的代码改动都落在真源 `plugin-host.js`/`plugin-client.js` → `python3 deploy/convert_bundle.py`（重生成 `bundle/lib/`）→ `python3 deploy/publish.py`（同步 `~/.dsh/dsh-guide-dog` + 幂等注册 web profile）→ **重启 DSH**（bundles 启动时解析，重启必做）→ 按验收清单验证。无 cordis_define/cordis_run、无批准弹窗。阶段性验证用 `cordis_inspect_query`（client Slots / host Tool 只读探针）与 curl RPC 路由。

1. **Phase 1-A 语音模式**：config 层 → speak RPC 扩展（source/dedup/失败码）→ host 事件驱动自动发声 → input.left 群组 → systemPrompt.variable。✅ 已完成（2026-08-14，v6/v11 验证）
2. **Phase 1-B 语音输入**：transcribe RPC + whisper 脚本 → mic 按钮（含实时预览/音量指示）→ inputActions 插入 → 错误路径。✅ 已完成（2026-08-14，v6/v11 验证）
3. **Phase 2（技术债前置）**：M9（录音 onstop 陈旧闭包）/ M10（媒体路由 range 流式化）/ M11（会话 override 并发覆盖）→ call 配置 + 面板/状态条/发起按钮 → 上行（VAD/PTT + 转写 + 提交）→ **共识优先拦截器**（tools/pre-execute + 摘要 + 窗口）→ 进度播报 → 下行流式 TTS（mmx --stream + chunked 路由 + Web Audio）→ 打断 → 语音命令 → 容错 → §6.9 验收。
4. **Phase 3**：a11y 联动矩阵 → 捕获管线（foreignObject JPEG）→ describe-screen RPC → 播报三模式 → 自动触发（tools/result 白名单 + 防抖/节流）→ 共识拦截器扩大 → 人文关怀约束（prompt + 语音命令）→ 本地降级 → §7.5 验收。

每个 Phase 以 §5.4/§6.9/§7.5 的验收清单收尾；开源调研结论已并入附录 A（§10），全文见 `guide-dog-dsh/research/voice-accessibility-research.md`。

---

## 10. 附录 A — 开源调研结论与实现参考（2026-08 落地）

调研报告全文：`guide-dog-dsh/research/voice-accessibility-research.md`（含全部 URL）。

| 主题 | 结论 | 本 spec 采纳 |
|---|---|---|
| 通话框架 | LiveKit Agents + agent-starter-react 最完整（WebRTC 全栈）；Pipecat（WS 传输 + 浏览器 web-vad）更贴合 DSH（主机 Node 即 agent，浏览器 WS 直连） | 不引框架，抄参数体系与打断协议；**传输层零 WS**（§6.2：mmx --stream + chunked HTTP 流 + 整段 POST，无新协议面） |
| 打断 | Pipecat InterruptionFrame：停播 → 取消 LLM 在途生成 → 清 TTS 缓冲 → 冲刷未播音频，一个音频写周期内静音 | §6.6（abort fetch + 终止 mmx 进程） |
| 轮转 | LiveKit 5 种轮转模式；endpointing 静默 0.5–3s；preemptive generation（话毕即生成） | §6.3/§6.5（句间预合成） |
| VAD | 浏览器跑 Silero（web-vad / ricky0123，AudioWorklet）；Ultravox 分层 VAD（32ms 粗检 + 神经 VAD）+ 打断最短 90ms | §6.3（energy → silero 升级路径） |
| STT | sherpa-onnx（Zipformer/SenseVoice 中英流式，官方 WASM 演示）；faster-whisper CPU 15s 音频 1.5–2.5s | §5.3（whisper 现役 / sherpa 增强） |
| 语音输入 | MediaRecorder webm/opus 或 AudioWorklet 裸 PCM；zh/en 三档语言开关；Web Speech API 仅降级 | §5.2/§5.3/§6.3（MediaRecorder + AnalyserNode 并行） |
| 无障碍 UX | Be My AI（拍照问答+分层回答）、Seeing AI（结构化通道）vs Lookout（连续反馈）；WCAG 1.4.1/3.3.4；ARIA Disclosure；PaliGemma screen2words | §7.3 |
| 共识优先 | grill-me（Matt Pocock）：设计树 + 前沿轮询 + 事实/决策分离 + **确认门（共识前不行动）** | §6.7（语音版裁剪：每轮 1–3 问、机制层 tools/pre-execute 拦截 + 摘要 + 打断窗口） |
| 截图 | html2canvas/dom-to-image 零权限低保真；CDP 像素级（DSH 无，out of scope）；getDisplayMedia（out of scope） | §7.2（foreignObject 主选 + html2canvas 备选，JPEG 视口捕获） |
| MiniMax 音频 | **仅 TTS**：WS `wss://api.minimax.io/ws/v1/t2a_v2` 与 HTTP `POST /v1/t2a_v2`；**`mmx speech synthesize --stream`（实测首字节 600ms，pcm/flac/wav/opus 格式）**；模型 speech-2.8/2.6/02/01 系列；**无公开 ASR / 无 realtime API / 无 asr-01** | §5.3（STT 必须本地）/§6.5（mmx --stream 主通道；T2A WS 弃用——chunked HTTP 已达标且无新协议面） |

**关键链接**（完整列表见调研报告 §6）：[LiveKit turns](https://docs.livekit.io/agents/logic/turns.md) · [LiveKit tuning](https://docs.livekit.io/agents/logic/turns/tuning.md) · [LiveKit adaptive interruption](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling.md) · [Pipecat interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions.md) · [Pipecat speech-input](https://docs.pipecat.ai/pipecat/learn/speech-input.md) · [web-vad](https://github.com/jptaylor/web-vad) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) · [faster-whisper](https://pypi.org/project/faster-whisper/) · [MiniMax T2A WS 指南](https://platform.minimax.io/docs/guides/speech-t2a-websocket) · [MiniMax T2A WS API](https://platform.minimax.io/docs/api-reference/speech-t2a-websocket.md) · [grill-me](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me) · [grilling 机制](https://aihero.dev/skills-grilling) · [WCAG 2.2](https://www.w3.org/WAI/WCAG22/) · [ARIA Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) · [Be My AI](https://www.bemyeyes.com/business/news/introducing-be-my-ai-formerly-virtual-volunteer-for-people-who-are-blind-or-have-low-vision-powered-by-openais-gpt-4/)
