# Guide Dog for DSH v2 — 设计文档

**日期**：2026-08-14
**状态**：已与用户逐节确认（方案 A 单插件演进 + 四节设计 + 3 处契约修正）
**插件**：`gdog-1`（动态 Cordis 插件，host/client 双半）
**范围**：语音模式硬化（硬指标）、语音输入、通话模式、无障碍模式

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
| **Phase 2** | 通话模式 | VAD/打断/进度播报/重连全部验收通过 |
| **Phase 3** | 无障碍模式 | 截图→描述→播报闭环 + 人文关怀约束落实 |

Phase 之间独立验收；Phase 3 依赖 Phase 2 的语音通道与 Phase 1 的 TTS 管线。每个 Phase 产出一份独立实施计划（writing-plans），本 spec 是总设计。

**明确不做（Out of scope）**：
- 持久化安装（host composition 装进 `~/.dsh/profiles/web/cordis.patch.yml`）——既定后续工作，不在本 spec。
- 语音克隆 / 自定义音色训练。
- 用户屏幕共享（getDisplayMedia）——隐私与授权弹窗对视障用户不友好；后续可选扩展。
- agent 代浏览任意网页并截图——DSH 无浏览器自动化服务，无通道。
- 流式 STT 部分结果（先做整段转写，partials 为后续增强）。
- 通话模式在非 Web 环境（终端）的使用。
- 噪声消除（调研若给出轻量方案，作为 Phase 2 增强项）。

---

## 3. 总体架构

**方案 A：单插件演进**。`gdog-1` 保持唯一插件；host 按关注点分节组织，client 按特性分组件。

```
gdog-1 (pluginId)
├── Host 半（Node.js，rootCtx）
│   ├── config   —— ~/.guide-dog/config.json 读写（原子写：临时文件+rename，权限 600）
│   ├── tts      —— 现有 mmx TTS 管线 + 媒体库（~/.guide-dog/media/，复用 v1）
│   ├── stt      —— faster-whisper 转写（Phase 1 起），MiniMax ASR 可配置备选
│   ├── ws       —— /guide-dog/ws WebSocket 升级路由（Phase 2 起）
│   ├── tools    —— v1 九个工具 + 语音相关新工具（见 §5.5）
│   └── rpc      —— harness.handle 私有方法（speak / transcribe / config / ws-token / describe-screen / list-media / voices / auth-status）
└── Client 半（浏览器 SPA）
    ├── voiceMode —— turnTail 自动发声钩子 + dock 状态徽章
    ├── micInput  —— composer 麦克风按钮
    ├── callPanel —— 通话面板（shell.overlay）+ 状态条（dock）+ 发起按钮（header action）
    └── a11yBar   —— 无障碍面板（shell.overlay）+ 截图描述流程
```

**已验证的 API 契约（2026-08-14 实测）**：

| 用途 | 契约 | 要点 |
|---|---|---|
| 自动发声数据源（v2 裁决） | host `session/event`（post-commit 追加流）+ `sessionQuery.readSession` | 消息事件含回复文本（与渲染同一内容）；client 轮询 `guide-dog/voice-queue` 播放（`timerSvc.interval` 已确认可用） |
| 麦克风按钮 | `conversation.input.right`（list） | 空座位；owner props `{session, input}`；标准 props 含 `inputActions: InputActions` |
| 语音模式徽章/通话状态条 | `conversation.input.dock`（list） | 现有占用 order 0/10/20 → 本插件用 **30** |
| 通话发起按钮 | `conversation.session.header.actions`（list） | 现有占用 -10/10/20 → 本插件用 **30** |
| 通话/无障碍悬浮面板 | `shell.overlay`（list） | 默认 click-through，条目自行 opt-in 指针事件 |
| WebSocket | `webServer.registerUpgrade(route: WebUpgradeRoute)` | 精确路径升级路由；**需手写 RFC6455 握手与帧解析**（无第三方库） |
| 进度播报数据源 | host 事件 | `agent/status`、`tools/result`、`session/event`（持久化事件追加流，含消息落地）、`agent/error` |
| RPC / 工具 | `harness.handle` / `harness.defineTool` / `harness.registerTool` | v1 已验证 |
| 提示词注入 | `systemPrompt.section` + `systemPrompt.variable` | 会话级变量 provider 读配置返回当前状态文本 |
| 设置页 | `settings.section`（id `guide-dog`，order 30） | v1 已有，扩展 |

**关键修正（相对初稿）**：
1. 通话回合的用户消息提交**不走 `apiProxy.respond`**（那是传输层回执，不是消息注入入口）；改由 **client 端 `inputActions` 填框+提交**，与语音输入共用同一路径。
2. WS 安全：**Origin 严格白名单 + 每会话一次性令牌**（host 签发、5 分钟有效、单连接消费）。
3. 无障碍自动截图触发点：**`tools/result`**（工具完成）而非静默期探测。

---

## 4. 配置模型

文件：`~/.guide-dog/config.json`（workspaceRoot = `$HOME`，与媒体库同根）。host 启动时加载到内存，写操作走原子写。client 通过 RPC `guide-dog/get-config` / `guide-dog/set-config` 读写。

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
    "vad": "energy",           // "energy"（Phase 2 v1）→ "silero"（web-vad 浏览器 WASM，升级）| "sherpa"（VAD+ASR 一体）
    "silenceMs": 700,          // 静音判定说话结束（LiveKit 轮转区间 0.5–3s）
    "minSpeechMs": 300,        // 最短语音（LiveKit 建议 ~500ms）
    "interruptMinMs": 300,     // 打断最短时长门槛（防误触；Ultravox 用 90ms）
    "maxSegmentSeconds": 60,
    "streamModel": "speech-2.6-turbo",   // MiniMax 流式 TTS（T2A WS；官方标注 ideal for agent）
    "voice": "English_expressive_narrator",
    "speed": 1.0
  },
  "a11y": {
    "enabled": false,
    "autoNarrate": true,       // 工具完成后自动截屏描述（节流 10s）
    "visionCloud": true,       // 截图是否允许发往 MiniMax vision（关 = 仅本地 DOM 文本提取）
    "summaryFirst": true       // 渐进式披露：默认先播概要
  },
  "tts": { "voiceEn": "English_expressive_narrator", "voiceZh": "Chinese (Mandarin)_Gentle_Youth", "speed": 0.95, "format": "mp3" }
}
```

生效规则：`voiceMode 生效值 = sessions[sessionId] ?? default`。

---

## 5. Phase 1 — 语音模式硬化 + 语音输入

### 5.1 语音模式（硬指标）

**硬指标定义（用户确认的三条保证）**：

1. **机制保证**：语音模式开启时，每次 assistant 回复落地**必然**触发 TTS 发声，与模型是否调用工具完全无关。
2. **文字与语音逐字一致**：TTS 输入文本 = 该回复在对话中渲染的同一份 text blocks（唯一来源）；仅按 audio-conversation 规则做朗读性变换（剥离代码块/URL/符号），语义与文字不变。
3. **失败必反馈**：TTS 失败时播放失败提示音 + 口头短句（"语音生成失败：原因"）+ dock 徽章显示失败状态，绝不静默。

**机制实现（自动发声钩子，v2 裁决：host 事件驱动）**：

> 实施期探测证实：client 的 `useSession()` 快照为 Proxy/类实例（`Object.keys` 为空，`messages/turns/nodes` 均 undefined），`turnTail` 的 owner.turn 亦无消息文本字段——client 侧无法可靠提取回复文本。故机制改为 host 事件驱动（三条硬指标不变）：

- host 监听 `session/event`（post-commit 追加流）：命中 assistant 消息事件且该会话语音模式生效时，从事件消息内容提取文本（与对话渲染的同一份内容）→ 去重（`spokenTurns`，sessionId+seq）→ `speakImpl({text, sessionId, turnSeq, source:'voice-mode'})` → 成功入队 `voiceQueue[sessionId]`（含 url/key），失败入队错误项。
- client 在输入框左下角 VOICE 群组内以 `timerSvc.interval`（1s）轮询 RPC `guide-dog/voice-queue`（带 sessionId，host 弹出即交付一次）→ 模块级 `Audio` 播放 / 错误项显示失败 + 提示音。
- **去重**：host 级 `Map<sessionId, Set<seq>>` 双保险（speakImpl 内已有）；队列弹出即消费，不重复播放。
- **播放（会话级语义，v2.1 用户裁决）**：client 以模块级 `Audio` 对象播放（轮询在会话组件内，播放本身脱离会话组件生命周期）——**切换会话不重播、不中断**：正在播放的音频自然播到结束；仅当出现新的播放任务（任一会话的新队列条目）时才覆盖当前播放。播放结束/失败/被浏览器阻止均清理并显示错误（绝不静默）。
- **失败反馈**：speakImpl 失败 → 队列错误项（error code）→ client 播放失败提示音（beep RPC data-URI）+ 群组内显示"朗读失败：<原因>" 8 秒；尝试次数 ≤2，不重试循环。
- **两层设置**：
  - 全局默认：`config.json → voiceMode.default`（默认 `false`），设置页（settings.section `guide-dog`）管理。
  - 会话 override：`voiceMode.sessions[sessionId]`，由输入框左下角小喇叭按钮点击切换。
  - UI（v2.1 用户裁决）：`conversation.input.left`（order 30，id `guide-dog-voice`）常驻群组 = **[小喇叭] [语言检测下拉] [麦克风]**；小喇叭单击切换会话 override（开=成功绿/关=次级色），悬浮提示"语音模式提示：开/关 · 全局默认：开/关（点击切换）"；语言下拉（auto/zh/en）替代原三档循环按钮；麦克风用简洁 SVG 图标（feather 风格细线，录制态红色脉冲+秒数）。样式使用 DSH 主题令牌（`--dsw-alias-*`），字体继承输入行，与 DSH 设计语言一致。
- **模型感知**：`systemPrompt.variable('guide-dog-voice-mode', provider)` 按会话注入"语音模式：开。本条回复会被自动朗读，不要在回复中描述音频状态，保持文字与朗读内容一致。"（variable provider 在 host 侧读配置，随会话切换）。
- **与 v1 工具的关系**：`guide_dog_speak` 工具保留（模型主动朗读场景，如无障碍模式主动播报），与语音模式共用 TTS 管线与去重；`source` 字段区分。

### 5.2 语音输入

- 入口：`conversation.input.left` VOICE 群组内（id `guide-dog-voice`，order 30，输入框左下角）的麦克风按钮；语言检测用群组内下拉（auto/zh/en，映射 `voiceInput.language` 语义，模块级偏好跨会话延续）。
- 流程：
  1. 点击开始录音：`getUserMedia({audio: true})` + `MediaRecorder`（优先 `audio/webm;codecs=opus`；后续可升级 AudioWorklet 裸 PCM 直采以省编解码），按钮进入红色脉冲态并计时（上限 `voiceInput.maxSeconds`，到时自动停止）。按钮旁提供语言三档开关（自动/中文/英文，映射 `voiceInput.language`）。
  2. 停止 → `blob → arrayBuffer → base64` → `host.call('guide-dog/transcribe', { audioB64, mime, sessionId, language })`。
  3. host：base64 解码 → 临时文件 `~/.guide-dog/tmp/rec-<ts>.webm` → STT（§5.3）→ 返回 `{ ok, text, language, durationMs }`；成功后删除临时文件。
  4. client：文本插入 composer——`inputActions` 追加/设置文本并聚焦（具体方法名以实施期核实的 `InputActions` 契约为准）；`autoSend=false`（默认）仅插入，用户编辑后发送；`autoSend=true` 插入后立即提交。
- 状态机：`idle → recording → transcribing → idle | error`。录音中再次点击 = 停止；错误态：麦克风权限拒绝（徽章+提示"请在浏览器设置中允许麦克风"）、识别为空（"没听清，请再说一次"，语音模式开启时口播）、STT 引擎不可用（提示安装指引，见 §5.3）。延迟预算：松键后 2–4s 出字（≤15s 音频 + faster-whisper CPU 1.5–2.5s）属正常。
- 隐私：whisper 引擎下音频只写临时文件、用后即删，不出本机；minimax 引擎下音频上云，config 中明示（§9）。

### 5.3 STT 引擎（本地为主——调研已确认 MiniMax 无公开 ASR）

调研结论（2026-08，官方文档核实）：MiniMax **只有 TTS**（HTTP + WebSocket），**无公开 ASR/STT、无 realtime 语音 API、无 asr-01 模型**（官方同传 demo 的语音识别用的是 Whisper）。因此 STT 必须本地或浏览器侧。

- 首选 **whisper**（faster-whisper）：host 启动时探测 `python3 -c "import faster_whisper"`；缺失时 RPC 返回 `engine_unavailable` + 安装指引（`pip install faster-whisper`），设置页显示探测状态与一键指引。15s 音频 CPU int8 转写约 1.5–2.5s。
- 转写调用：`subprocess` 服务 spawn `python3 <plugin 内置脚本> --model small --output json`（脚本由 host 在首次启动时通过 fs 服务写入 `~/.guide-dog/scripts/whisper_transcribe.py`，输入路径、输出 `{text, language, durationMs}` JSON）。模型 `base`/`small` 可配置；语言取 `voiceInput.language`（`auto` 时逐窗口自动检测，zh/en 短句偶有误判→三档开关兜底）。
- 增强 **sherpa**（`engine: "sherpa"`）：sherpa-onnx（Zipformer 中英流式 / SenseVoice 中文·粤·日·韩 VAD+ASR 一体，官方有浏览器 WASM 演示）——通话模式升级路径（§6.3），语音输入也可选。
- **降级（Phase 1 决策）**：本地引擎缺失时，语音输入回退为 **host 托管录音页**（`/guide-dog/recorder`，独立页面 MediaRecorder → 上传转写，仍走本地 whisper）——浏览器沙箱限制下也保证可用；Web Speech API（浏览器→云端识别、Chrome 系、不可控）列为后续可选降级，Phase 1 不实现。
- 保留位 **minimax**：MiniMax 发布公开 ASR 端点后启用（config 已留位）。
- 超时：转写超时 60s，超时报 `stt_timeout`。

### 5.4 Phase 1 验收

1. **硬指标 1**：语音模式开启后，构造一次"模型未调用任何 speak 类工具"的回复——回复落地自动发声（观察 dock 徽章与音频播放），证明与工具调用解耦。
2. **硬指标 2**：语音模式开启，输出含 markdown 的回复——朗读内容与可见文本语义一致（代码块/URL 按规则剥离）；关闭时无自动发声。
3. **硬指标 3**：临时断网/伪造 TTS 失败——播放失败提示音、dock 徽章显示失败原因、不静默。
4. 两层设置：全局默认关→会话开→新会话恢复默认；徽章显示正确。
5. 语音输入：录音→识别→插入输入框（未自动发送）→编辑→发送成功；自动发送开关生效；权限拒绝与空识别错误路径可见。

---

## 6. Phase 2 — 通话模式

### 6.1 入口与界面

- `conversation.session.header.actions`（order 30，id `guide-dog-call`）：通话开关按钮。
- `shell.overlay`（id `guide-dog-call-panel`）：通话面板——状态行（收听中/处理中/播报中）、静音、语速调节、挂断。
- `conversation.input.dock`（order 31，id `guide-dog-call-status`）：通话状态条（简短，供语音模式徽章旁并排）。

### 6.2 WebSocket 通道

- 端点：`/guide-dog/ws`（`webServer.registerUpgrade`，精确路径）。
- 握手安全：① Origin 必须等于 GUI 来源（`window.location.origin` 于 client 校验 + host 侧白名单比对）；② 查询参数 `?token=`——token 由 `host.call('guide-dog/ws-token', { sessionId })` 签发，5 分钟有效、每连接单次消费、host 内存保存（插件重启即失效，client 重连时重新申请）。
- 协议（JSON 文本帧 + 音频二进制帧，RFC6455 服务端实现：握手、掩码客户端帧解析、服务端无掩码帧、ping/pong、close）：
  - client→host：`{type:'audio-start'}`、`{type:'audio-chunk', audioB64}`、`{type:'audio-end'}`、`{type:'interrupt'}`、`{type:'speed', value}`、`{type:'pause'|'resume'}`、`{type:'close'}`
  - host→client：`{type:'transcript', text, language}`、`{type:'status', phase: 'listening'|'processing'|'speaking', detail?}`、`{type:'tts-start', sentence}`、`{type:'tts-chunk', audioB64, mime, seq}`、`{type:'tts-end'}`、`{type:'error', code, message}`
- **失败兜底**（RFC6455 手写若不可靠）：下行改 `POST /guide-dog/tts`（fetch ReadableStream 流式读取分块），上行改 `POST /guide-dog/transcribe`（轮询）。实施期以"首音频延迟 <1.5s、播放间隙 <400ms"为判据选择。

### 6.3 回合循环

```
用户说话 ──VAD──> audio-end（静音 700ms）
   └─> host STT（whisper，整段）
        └─> WS: transcript
             └─> client: inputActions 填框 + 提交（与语音输入同路径）
                  └─> agent 运行（DeepSeek，工具全保留）
                       ├─ 进度播报（§6.4）
                       └─ 回复文本落地（session/event）
                            └─> 分句 → 流式 TTS（§6.5）→ WS 下行播放
                                 └─ 播放中 VAD 检测到用户发声 → barge-in（§6.6）→ 回到顶部
```

- 采集：`getUserMedia` + **AudioWorklet 16kHz 单声道裸 PCM**（免编解码，直喂 VAD/STT；语音输入仍用 MediaRecorder 不分家）。PCM 块经 WS 上行（`audio-chunk`，base64，每块约 100ms）。
- VAD（Phase 2 v1）：`call.vad='energy'`——AudioContext `AnalyserNode` RMS 能量阈值，静音 700ms 判定结束、最短语音 300ms、单段上限 60s。
- VAD 升级路径（调研结论）：`call.vad='silero'`——**web-vad**（Silero ONNX + AudioWorklet，浏览器内跑，Pipecat 客户端同款，打断延迟最低）；`call.vad='sherpa'`——sherpa-onnx（VAD+ASR 一体）。参数借鉴：LiveKit 轮转区间（静默 0.5–3s）、Ultravox 分层 VAD（32ms 帧粗检 + 神经 VAD 判"话已说完"）+ 打断最短 90ms 门槛（本 spec 用 `interruptMinMs: 300`）。
- 每轮消息照常渲染进对话流（语音只是附加通道），用户可随时切回打字。

### 6.4 进度播报（不静默原则）

host 监听（按会话过滤，`this: Scoped<Agent>` 事件天然按 agent 作用域）：

| 事件 | 播报短语 |
|---|---|
| `agent/status` → running | "正在处理" |
| `tools/result` | 工具名 → 短语映射：`bash`→"正在执行命令"、`read`/`grep`/`glob`→"正在查找文件"、`write`/`edit`→"正在修改文件"、`web_search`→"正在搜索网页"、`guide_dog_image/video/music/speak`→"正在生成媒体"、`skill`→"正在调用技能"，未知工具→"正在执行操作" |
| `agent/error` | "处理出错：<短原因>" |
| `session/event`（assistant 消息落地） | 触发 §6.5 回复朗读 |

播报走同一 TTS 管线（短句、可被打断），与回复朗读共用队列：播报优先、回复让路。

### 6.5 流式 TTS

- **主通道（调研确认可用）**：host 代理 MiniMax WebSocket TTS——`wss://api.minimax.io/ws/v1/t2a_v2`（`task_start` 带 model/voice/audio_setting → `task_continue` 发文本 → 服务端流式回 `data.audio` hex 块与 `is_final` → `task_finish`；单次 ≤10000 字；模型 `speech-2.6-turbo`，官方标注 ideal for agent）。API key 只在 host。
- 备选：`mmx speech synthesize --stream --text <句> --format opus（或 pcm）--voice <call.voice>`（流式到 stdout）。
- 回复文本按句切分（`。！？.!?\n`）逐句合成，**句间预合成**（当前句播放时后台合成下一句，借鉴 LiveKit preemptive generation）；host 切块 → WS `tts-chunk` → client 播放：MediaSource（webm/opus 连续拼接）或 `decodeAudioData` + 顺序队列（实施期定，判据：首包 <500ms、播放间隙 <400ms）。
- 长回复：累计时长 >60s 时播报"回复较长，已播报摘要"，随后朗读首段摘要（渐进式披露的语音版）；"重复"可重播当前句。

### 6.6 打断（Barge-in）

- **协议照抄 Pipecat 的 InterruptionFrame 语义**：VAD 触发（≥`interruptMinMs` 300ms 防误触）→ ① 浏览器**立即停止播放并清空未播缓冲**（一个音频写周期内静音）→ ② `{type:'interrupt'}` 上行 → ③ host 取消在途 TTS 合成（终止 mmx 进程 / 关闭 T2A WS 当前任务）→ ④ 新语音自然成为下一回合。
- 参数借鉴 LiveKit adaptive 打断：最短语音 ~0.5s、误判后 2s 内无有效转写则从被中断句恢复重播。
- 静音/无声 turn：VAD 判定说话但转写为空 → 不提交空消息，播报"没听到，请再说一次"。

### 6.7 容错

- WS 断线重连：退避 1/2/5/10s，重连后重新申请 token；重连成功播报"连接恢复"。
- STT 失败：口头"没听清/转写失败"，不提交。
- TTS 失败：文字照常落地 + 失败提示音 + 面板错误状态。
- 通话中 agent 长时间无响应（>120s 无任何事件）：播报"仍在处理，请稍候"（心跳探测）。

### 6.8 Phase 2 验收

1. VAD：说话-停顿-说话两段分别成回合；静音判定不误切（背景噪声阈值可调）。
2. 回合循环：语音 → 转写 → 提交 → agent 执行（含工具调用）→ 回复朗读，端到端可完成一次"用语音让 agent 生成图片/搜索"。
3. 打断：播放中说话即停，下一回合正常；误打断 2s 兜底重播。
4. 进度播报：agent 执行工具期间至少播报一次阶段状态。
5. WS 安全：非白名单 Origin 与无/错 token 拒绝连接；重连后恢复。
6. 长回复摘要与"重复/停/慢一点"命令生效。

---

## 7. Phase 3 — 无障碍模式

### 7.1 目标

视障用户仅凭语音操作 agent 完成任务。叠加在 Phase 1+2 之上：语音模式自动开启、通话模式为默认交互、截图→视觉转语音补齐"agent 展示了什么"的信息缺口。

### 7.2 截图 → 描述 → 播报

- 入口：`shell.overlay`（id `guide-dog-a11y-panel`）控制面板 + 语音命令（"看看屏幕"）+ 设置页开关。
- **捕获（本地，无第三方依赖）**：主选 `foreignObject` 方案——`<svg><foreignObject>` 序列化 `document.documentElement` 视口 → canvas → PNG base64（同源媒体不产生 canvas 污染）；备选：host 首次运行时经 `web.fetch` 下载固定版本 html2canvas UMD 到 `~/.guide-dog/lib/`，经 `/guide-dog/lib/` 同源托管，client `<script>` 加载（渲染保真度不足时启用）。
- 调研对照：html2canvas 零权限但保真度低（复杂 CSS/WebGL 丢失、跨域资源污染需代理）；CDP `Page.captureScreenshot` 像素级但需浏览器自动化（DSH 无此服务，out of scope）；`getDisplayMedia` 真实屏幕需授权（out of scope）。本 spec 走"页面内零权限"路线，foreignObject 保真不足时启用 html2canvas。
- **描述**：`host.call('guide-dog/describe-screen', { imageB64, mode })` → host 调 MiniMax vision（复用 v1 `guide_dog_inspect` 管线）→ 返回结构化文本。三种模式：
  - `summary`：1–2 句概要——界面在做什么、关键状态、有无错误/新内容。
  - `detailed`：元素级清单（按钮/输入框/列表/媒体等，含可操作语义）。
  - `ordered`：自上而下逐块播报。
- **提示词硬约束**（写入 vision prompt）：颜色/图标/布局必须转成文字语义（"有错误提示"而非"红色的字"）；标注可交互元素与当前焦点位置；不臆测不可见内容。
- **播报**：结果经 TTS 管线朗读；`summaryFirst=true` 时默认只播概要，"详细/继续"才展开。
- **自动触发**：`a11y.autoNarrate=true` 时，host 监听 `tools/result`（本会话）→ 3s 防抖 + 10s 节流 → WS/事件推送 → client 捕获+描述（summary 模式）→ 播报。
- **历史**：描述文本存入 `~/.guide-dog/a11y-history/`（纯文本 md，**不存截图**）。
- **本地降级**：`a11y.visionCloud=false` 时不上云——client 本地提取可见文本（text nodes + `aria-label` + role）生成文本概要，质量较低但完全本地。

### 7.3 人文关怀硬约束（需求级，验收项）

> 参考实现（调研）：Be My AI（用户主动发起 + 分层详细回答 + 志愿者兜底）、Seeing AI（结构化通道模式）vs Lookout（连续实时反馈）；规范依据：WCAG 1.4.1（状态不只用颜色）、WCAG 3.3.4（破坏性操作错误预防）、ARIA Disclosure 模式（渐进披露）。

1. **渐进式披露**：默认只播概要；"详细/继续"按需展开；"按顺序播报"自上而下。所有播报可被打断。
2. **拒绝纯视觉信息**：一切颜色/图标/布局判断转文字语义（vision prompt 强制）；agent 生成的图片在无障碍模式下自动用 vision 描述（复用 `guide_dog_inspect` 的 focus 逻辑）。
3. **状态播报**：加载/完成/失败/需确认的时刻必须口头通知一次，不静默、不重复轰炸。
4. **破坏性动作语音确认**：无障碍模式下 systemPrompt 注入约束——删除/覆盖/发送/支付等破坏性操作必须先语音确认（"确定要删除 X 吗？请说确定或取消"），用户未确认不得执行；通话通道天然支持该对话。
5. **节奏控制**：语音命令"停 / 暂停 / 继续 / 重复 / 慢一点 / 快一点"（暂停/恢复播放、语速 0.8/1.2、重播当前句）。
6. **隐私边界**：截图仅用于本次描述，不持久化原图；`visionCloud` 开关明示云端处理；音频同 §9。
7. **操作可达**：所有功能均可语音触发（通话+语音命令），不要求任何键盘/鼠标操作。
8. **错误可恢复**：任何失败都有口头说明与重试路径，不进入死胡同。

### 7.4 无障碍模式开关

- 设置页 `guide-dog` 一节：`a11y.enabled` 开启时自动：语音模式生效值强制 true（会话 override）、通话面板常驻、注入 §7.3-4 的 systemPrompt 约束、激活自动截图播报。
- 语音命令集（通话模式识别后匹配）："看看屏幕 / 详细 / 继续 / 按顺序播报 / 停 / 暂停 / 继续 / 重复 / 慢一点 / 快一点 / 确定 / 取消"。

### 7.5 Phase 3 验收

1. "看看屏幕"：截图→vision 描述→播报，summary/detailed/ordered 三模式。
2. 自动播报：agent 完成一个工具步骤后 10s 内自动播报界面概要（节流验证）。
3. 纯语音完成任务：全程不碰键盘鼠标，语音指示 agent 完成一个多步任务（如"生成一张图并描述它"），破坏性操作出现语音确认。
4. 隐私：`visionCloud=false` 时断网仍可本地文本概要；`~/.guide-dog/a11y-history/` 无图片文件。
5. 节奏命令与打断在无障碍模式下全部生效。

---

## 8. 横切设计

### 8.1 媒体与文件

- 复用 v1 媒体库（`~/.guide-dog/media/` + `.index.json` + `/guide-dog/media` 路由）。
- 新增目录：`~/.guide-dog/tmp/`（录音临时文件，用后即删）、`~/.guide-dog/scripts/`（whisper 转写脚本，host 启动时写入）、`~/.guide-dog/lib/`（html2canvas 备选库）、`~/.guide-dog/a11y-history/`（纯文本）。
- 大小上限：transcribe 音频 ≤20MB；describe-screen 图片 ≤8MB。

### 8.2 安全与隐私

1. WS：Origin 白名单 + 每会话一次性令牌（§6.2）。
2. API key 永不进入浏览器（TTS/vision 全部 host 侧执行）。
3. 语音输入：whisper 引擎音频不落盘不出本机；minimax 引擎上云，config 明示。
4. 截图：原图不持久化；云端处理有显式开关。
5. `config.json` 权限 600；媒体路由沿用 v1 的 basename/扩展名白名单与遍历防护。

### 8.3 错误码（统一枚举）

`bad_args / tts_failed / tts_timeout / stt_failed / stt_timeout / engine_unavailable / mic_denied / empty_speech / ws_rejected / ws_lost / vision_failed / config_write_failed`——client 统一映射为提示音 + 文案 + （语音模式开启时）口播。

### 8.4 设置页扩展（settings.section `guide-dog`）

语音模式（全局默认 + 当前会话 override 说明）、STT（引擎选择 + whisper 探测状态 + 模型大小）、通话（音色/语速/VAD 参数）、无障碍（开关/自动播报/visionCloud）、媒体画廊（v1 保留）。

---

## 9. 实施顺序与依赖

1. **Phase 1-A 语音模式**：config 层 → speak RPC 扩展（source/dedup/失败码）→ turnTail 钩子 → dock 徽章 → systemPrompt.variable。
2. **Phase 1-B 语音输入**：transcribe RPC + whisper 脚本 → mic 按钮 → inputActions 插入 → 错误路径。
3. **Phase 2**：WS 升级路由 + RFC6455 → token 签发 → VAD → 回合循环 → 进度播报 → 流式 TTS → 打断 → 容错。
4. **Phase 3**：捕获管线 → describe-screen RPC → 播报三模式 → 自动触发 → 人文关怀约束（prompt + 语音命令）→ 本地降级。

每个 Phase 以 §5.4/§6.8/§7.5 的验收清单收尾；开源调研结论已并入附录 A（§10），全文见 `guide-dog-dsh/research/voice-accessibility-research.md`。

---

## 10. 附录 A — 开源调研结论与实现参考（2026-08 落地）

调研报告全文：`guide-dog-dsh/research/voice-accessibility-research.md`（含全部 URL）。

| 主题 | 结论 | 本 spec 采纳 |
|---|---|---|
| 通话框架 | LiveKit Agents + agent-starter-react 最完整（WebRTC 全栈）；Pipecat（WS 传输 + 浏览器 web-vad）更贴合 DSH（主机 Node 即 agent，浏览器 WS 直连） | 不引框架，抄参数体系与打断协议 |
| 打断 | Pipecat InterruptionFrame：停播 → 取消 LLM 在途生成 → 清 TTS 缓冲 → 冲刷未播音频，一个音频写周期内静音 | §6.6 |
| 轮转 | LiveKit 5 种轮转模式；endpointing 静默 0.5–3s；preemptive generation（话毕即生成） | §6.3/§6.5 |
| VAD | 浏览器跑 Silero（web-vad / ricky0123，AudioWorklet）；Ultravox 分层 VAD（32ms 粗检 + 神经 VAD）+ 打断最短 90ms | §6.3（energy → silero 升级路径） |
| STT | sherpa-onnx（Zipformer/SenseVoice 中英流式，官方 WASM 演示）；faster-whisper CPU 15s 音频 1.5–2.5s | §5.3（whisper 现役 / sherpa 增强） |
| 语音输入 | MediaRecorder webm/opus 或 AudioWorklet 裸 PCM；zh/en 三档语言开关；Web Speech API 仅降级 | §5.2/§5.3 |
| 无障碍 UX | Be My AI（拍照问答+分层回答）、Seeing AI（结构化通道）vs Lookout（连续反馈）；WCAG 1.4.1/3.3.4；ARIA Disclosure；PaliGemma screen2words | §7.3 |
| 截图 | html2canvas/dom-to-image 零权限低保真；CDP 像素级（DSH 无，out of scope）；getDisplayMedia（out of scope） | §7.2（foreignObject 主选 + html2canvas 备选） |
| MiniMax 音频 | **仅 TTS**：WS `wss://api.minimax.io/ws/v1/t2a_v2`（task_start/continue/finish，hex 音频块 + is_final，≤1 万字）与 HTTP `POST /v1/t2a_v2`；模型 speech-2.8/2.6/02/01 系列；**无公开 ASR / 无 realtime API / 无 asr-01** | §5.3（STT 必须本地）/§6.5（T2A WS 主通道） |

**关键链接**（完整列表见调研报告 §6）：[LiveKit turns](https://docs.livekit.io/agents/logic/turns.md) · [LiveKit tuning](https://docs.livekit.io/agents/logic/turns/tuning.md) · [LiveKit adaptive interruption](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling.md) · [Pipecat interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions.md) · [Pipecat speech-input](https://docs.pipecat.ai/pipecat/learn/speech-input.md) · [web-vad](https://github.com/jptaylor/web-vad) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) · [faster-whisper](https://pypi.org/project/faster-whisper/) · [MiniMax T2A WS 指南](https://platform.minimax.io/docs/guides/speech-t2a-websocket) · [MiniMax T2A WS API](https://platform.minimax.io/docs/api-reference/speech-t2a-websocket.md) · [WCAG 2.2](https://www.w3.org/WAI/WCAG22/) · [ARIA Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) · [Be My AI](https://www.bemyeyes.com/business/news/introducing-be-my-ai-formerly-virtual-volunteer-for-people-who-are-blind-or-have-low-vision-powered-by-openais-gpt-4/)
