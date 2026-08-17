# Guide Dog for DSH，由 MiniMax 驱动

[![dsh-recommend](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2FAtropinolTT__dsh-guide-dog.certified.json)](https://github.com/zp-home/dsh-recommend)
[![dsh score](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2FAtropinolTT__dsh-guide-dog.json)](https://github.com/zp-home/dsh-recommend)

[English](https://github.com/AtropinolTT/dsh-guide-dog/blob/main/README.md) | **简体中文**

一个动态 Cordis 插件，通过 [mmx CLI](https://www.npmjs.com/package/mmx-cli)（MiniMax）
为 DeepSeek Harness 赋予多模态超能力：

- **DeepSeek 的眼睛** — MiniMax VLM（`guide_dog_vision` / `guide_dog_inspect`）
  描述图片，让没有原生视觉输入的模型（如 DeepSeek）也能审查前端设计、图表、
  截图和生成的图片。
- **生成的双手** — 图片（`image-01`）、视频（`MiniMax-H3` / Hailuo）、
  语音（MiniMax TTS）、音乐（`music-3.0`）、文本（`MiniMax-M3`）与联网搜索。
- **Web UI 预览与播放** — 每个生成的文件都以同源方式在
  `/guide-dog/media/<file>` 提供，并内联渲染在对话工具卡片中
  （`<img>`、`<audio controls>`、`<video controls>`）；另有 **Guide Dog**
  设置页（认证状态 + 朗读测试器）。
- **技能集成** — `guide_dog_speak` 复用你现有的
  [`audio-conversation`](https://github.com/your/audio-conversation) 与
  [`speech-mmx`](https://github.com/your/speech-mmx) 技能管线
  （文本转换、中日韩自动检测、分语言音色、宿主机播放）；技能脚本缺失时
  回退到原生 `mmx speech synthesize`。
- **自动调用** — 挂载的系统提示词段（`guide-dog-vision`，order 110）指示
  智能体对任何需要视觉检查的任务自动调用检查工具，尤其是当活动模型无法
  看图时。
- **通话模式（Phase 2，已上线）** — Web UI 中的免提实时语音对话：
  VAD / 按住说话（PTT）回合制、逐句流式 TTS + 打断（barge-in）、写入命令的
  共识优先保护、进度播报，以及输入框旁统一悬浮双 pill UI（支持中/英双语，
  详见下方「Phase 2 — 通话模式」）。
- **无障碍模式（Phase 3，规划中）** — 已预留 `a11y` 配置块（自动朗读 /
  视觉云端 / 摘要优先）；无障碍功能是下一步路线图，将在通话模式稳定后
  测试并上线。

## 精选收录

Guide Dog 已被 [dsh-recommend](https://github.com/zp-home/dsh-recommend)
收录——这是一个社区精选的 DSH 插件目录。本项目通过了其认证评审，并在本
README 顶部挂着金色 **精选认证（certified）** 徽章；分数徽章随每次
registry 数据同步自动更新。

## 文件

| 文件 | 用途 |
|---|---|
| `plugin-host.js` | Host 半区 — **唯一事实来源**（工具、RPC、媒体路由、提示词段、语音模式） |
| `plugin-client.js` | Client 半区 — **唯一事实来源**（工具卡片、设置页、语音集群） |
| `bundle/` | 由两半区生成的静态 web-profile 包（`deploy/convert_bundle.py`） |
| `deploy/` | `convert_bundle.py`（源码 → 包）与 `publish.py`（包 → `~/.dsh/dsh-guide-dog` + web profile 注册） |
| `README.md` | 本文件（英文版） |
| `README.zh-CN.md` | 本 README 的简体中文版 |

## 部署（静态 web-profile 包 — 当前方式）

1. 编辑唯一事实来源：`plugin-host.js` / `plugin-client.js`。
2. `python3 deploy/convert_bundle.py` — 重新生成 `bundle/lib/`。
3. `python3 deploy/publish.py` — 复制到 `~/.dsh/dsh-guide-dog`，幂等地注册
   到 `~/.dsh/profiles/web`（依赖链接 + `bundles` 条目 + node_modules 符号
   链接），并移除被取代的 autoload 包。
4. **重启 DSH**（`dsh web`）— 包在启动时解析。

没有动态插件、没有审批卡片、没有每会话实例：DSH 重启后，工具与语音 UI
随 profile 一起恢复。完整细节与坑见下文「重启恢复」一节。

`plugin-source.js` 是动态时代的遗留产物（两半区拼接）；仅作参考保留，
当前部署流程不使用。

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `guide_dog_speak` | `text`*、`voice`（auto）、`speed`、`language`、`playOnHost` | `{ok, url, voice, bytes}` mp3 |
| `guide_dog_image` | `prompt`*、`aspectRatio`、`n`、`width`、`height`、`seed`、`promptOptimizer`、`watermark` | `{ok, urls[], files[]}` |
| `guide_dog_video` | `prompt`*、`model`（默认 MiniMax-H3）、`image`、`subjectImage`、`duration`、`ratio` | `{ok, url, taskId}` mp4（轮询直到完成） |
| `guide_dog_vision` | `image`*、`prompt` | `{ok, answer}` VLM 描述 |
| `guide_dog_inspect` | `image`*、`focus`（general/frontend/figure/screenshot/ocr）、`prompt` | `{ok, answer, focus}` 结构化评审 |
| `guide_dog_voices` | `language` | `{ok, voices[]}` |
| `guide_dog_music` | `prompt`*、`lyrics`、`instrumental`、`vocals`、`genre`、`mood`、`model` | `{ok, url}` mp3 |
| `guide_dog_text` | `message`*、`system`、`model`、`maxTokens`、`temperature` | `{ok, text}` |
| `guide_dog_search` | `q`* | `{ok, results[]}`（最多 10 条） |

\* 必填

## 自动调用契约（视觉检查）

插件运行时，系统提示词段指示智能体：

- 对 **视觉检查**（前端设计评审、图表/绘图生成、截图、UI 原型、生成图片
  质检），在定稿前 **必须** 对生成的图片文件调用 `guide_dog_inspect`
  （结构化）或 `guide_dog_vision`（通用）——绝不能声称看过没有检查过的图。
- 生成的媒体以 `/guide-dog/media/<file>` 提供给用户；智能体必须附带返回的
  `url` 字段，方便用户预览。
- 语音请求路由到 `guide_dog_speak`。

在 DeepSeek 上的视觉检查示例流程：

```
1. (agent) 生成图表/截图文件，如 chart.png
2. (agent) guide_dog_inspect { image: "chart.png", focus: "figure" }
          → 对坐标轴/标签/可读性/编码做结构化评审
3. (agent) 迭代图表、重新检查，最后附上 url 定稿
4. (user)  在 Web UI 卡片中预览 chart.png
```

## 媒体存储与提供

- 媒体位于 `~/.dsh/guide-dog/.guide-dog/media` — 即
  `GLOBAL_ROOT = ~/.dsh/guide-dog` 下的**全局存储**（自 2026-08-16 起整个
  web profile 只有一个实例；不再是每工作区沙箱根——见下文「重启恢复」）。
- 由同源前缀路由 `/guide-dog/media` 提供，具备：
  - 扩展名白名单（`jpg/jpeg/png/gif/webp/mp3/wav/m4a/ogg/mp4/webm`），
  - 仅按文件名查找 + 目录穿越防护，
  - `Accept-Ranges: bytes` 与真实的字节范围响应（视频拖动进度），
  - 按需返回 404/405/413/416。
- `.index.json` 保存元数据（`prompt`、`voice`、`ts`、`kind`），供设置页画廊
  （`guide-dog/list-media` RPC）使用；索引损坏时从目录重建。
- 文件跨插件重启持久存在；停止/移除插件只会移除运行时注册，绝不删除文件。

## 技能集成（audio-conversation / speech-mmx）

`guide_dog_speak` 严格遵循你的两个技能的管线：

1. `~/.agents/skills/audio-conversation/scripts/transform.py` — 剥离
   markdown/代码/URL（缺失时回退到内置 JS 转换）。
2. 中日韩自动检测 → 分语言默认音色
   （`English_Trustworthy_Man` / `Chinese (Mandarin)_Gentle_Youth`），与技能
   env 契约一致。显式 `voice` 覆盖；`language` 增强口音。
3. `~/.agents/skills/speech-mmx/scripts/mmx_tts.py speak --input … --out …`
   （回退到 `mmx speech synthesize`）。
4. 通过返回的 mp3 URL 在浏览器播放。`playOnHost: true` 时宿主机扬声器也会
   播放——一次一个文件（先终止上一个播放），与技能的 latest-only 规则一致。

在 dsh 进程环境中仍生效的技能环境变量：`AUDIO_CONVERSATION_VOICE(_EN/_ZH)`、
`AUDIO_CONVERSATION_SPEED`、`AUDIO_CONVERSATION_DIR`、`AUDIO_CONVERSATION_NO_PLAY`、
`AUDIO_CONVERSATION_KEEP_FILES`、`TTS_GEN`。回合文件沿用 `turn-NNN.mp3`
命名规范。

## 设置页

设置 → **Guide Dog**（id `guide-dog`）：

- **认证（Auth）** — `mmx auth status` 结果，密钥打码（`sk-c…xxxx`）；
  绝不完整打印。
- **语音模式（Voice mode）** — 全局默认开/关单选（每会话覆盖在输入框
  左下角的小喇叭按钮上）。
- **语音输入（Voice input）** — STT 引擎选择（whisper / sherpa / minimax）、
  识别语言（auto/zh/en）、输入设备选择（默认跟随系统默认设备），以及
  识别后自动发送复选框。
- **STT** — faster-whisper 可用性 + 版本/python，以及 whisper 模型选择
  （base/small）。
- **朗读测试器（Speak tester）** — 文本 + 音色选择器（来自
  `guide-dog/voices`），在浏览器中播放 mp3。

## Phase 1 — 语音模式与语音输入

### 功能列表

- **语音模式（host 事件驱动）** — host 的 `session/event` 监听器监视
  `assistant/message` 事件，提取回复文本（`event.data.content` 中
  `type === 'text'` 的块），检查该会话语音模式是否生效（会话覆盖优先，
  否则全局默认），并把 TTS 结果（`{url, key}`）或错误入队到该会话的
  `voiceQueue`。client 每秒轮询队列并用模块级 `Audio` 对象播放，或显示
  右下角 toast + 提示音 6 秒。
- **语音集群** — `conversation.input.left` 条目 `guide-dog-voice`
  （order 30），位于输入框左下角，使用 DSH 令牌主题（`--dsw-alias-*`），
  继承应用字体：
  - 小**喇叭**图标 — 点击切换该会话的语音模式覆盖
    （`guide-dog/set-config` 配合 `voiceMode.sessions`）；悬停提示
    "语音模式：开/关 · 全局默认：开/关"。
  - **语言下拉框** — 识别语言检测（auto/zh/en）。
  - **麦克风**图标 — 录音 → 转写 → 插入（feather 风格 SVG；录音中红色
    脉冲 + 秒数计数）。
- **会话级播放** — 播放运行在模块级 `Audio` 对象上，切换会话不会重播或
  打断：当前片段播完为止，除非新的播放任务（任意会话的新队列条目）覆盖。
- **麦克风语音输入** — 集群中的麦克风：MediaRecorder 1s timeslice、实时
  秒数计数、maxSeconds 自动停止、语言取自下拉框，经 `guide-dog/transcribe`
  转写。识别文本通过 `inputActions.setDraft(text)` 插入输入框（配置后可
  用 `inputActions.submit()` 自动发送）。错误状态：`mic_denied`、
  `no_device`、`empty_speech`、`stt_failed`、`stt_timeout`、
  `engine_unavailable`、`insert_failed`（绝不静默）。
- **录音页** — 无法在页面内录音的沙箱客户端会得到 `🎙 打开录音页` 链接，
  指向独立页面 `/guide-dog/recorder`（GET 提供自包含 HTML 录音器；POST
  `/guide-dog/transcribe-upload` 接受原始 `audio/webm`，上限 20 MB，走同一
  `transcribeImpl`）。
- **设置控制** — 上述 Phase 1 配置块，由 `guide-dog/get-config` /
  `guide-dog/set-config` / `guide-dog/status` 支撑。

### config.json 结构

位于 `~/.dsh/guide-dog/.guide-dog/config.json`（由默认值自动创建；所有键
可选，在默认值之上深合并）：

```json
{
  "voiceMode": { "default": false, "sessions": { "<sessionId>": true } },
  "voiceInput": {
    "autoSend": false,
    "engine": "whisper",
    "language": "auto",
    "maxSeconds": 60,
    "whisper": { "python": "python3", "model": "small" }
  },
  "tts": {
    "voiceEn": "English_expressive_narrator",
    "voiceZh": "Chinese (Mandarin)_Gentle_Youth",
    "speed": 0.95,
    "format": "mp3"
  }
}
```

- `voiceMode.sessions` 把会话 id 映射为布尔覆盖；`default` 是回退值。
  输入框左下角的喇叭按钮切换当前会话的覆盖。
- `voiceInput.engine`：`whisper`（唯一已实现的引擎；`sherpa`/`minimax`
  为预留——选中会返回 `engine_unavailable`）。
- `voiceInput.maxSeconds` 强制麦克风录音停止。

### STT 引擎（faster-whisper）

`whisper` 引擎调用随附的 Python 脚本
（`.guide-dog/scripts/whisper_transcribe.py`），基于 `faster-whisper`：

```
pip install faster-whisper        # 需要 Python 3.8+；会安装 torch cpu wheels
python3 -c "import faster_whisper; print(faster_whisper.__version__)"
```

host 在启动时探测可用性，并把结果写入 `.guide-dog/status.json`
（`whisperAvailable`、`whisperVersion`、`whisperPython`），显示在
设置 → STT 行。模型选择：`base`（快）/ `small`（准）；首次运行会下载
模型权重。

### 验证

```
node --check plugin-host.js && node --check plugin-client.js          # 语法检查
curl -s http://127.0.0.1:3080/guide-dog/recorder | head -5             # 录音页返回 HTML
curl -s -X POST http://127.0.0.1:3080/guide-dog/api/guide-dog/status \
  -H 'content-type: application/json' -d '{}' | head -5               # status RPC（兼容层）
cat ~/.dsh/guide-dog/.guide-dog/status.json                            # whisper 探测结果
```

手动检查（部署后）：点喇叭按钮（语音模式开，变绿）→ 发消息 → 助手回复
自动朗读；播放中切换会话 → 片段播完且不会重播；用麦克风按钮 → 识别文本
出现在输入框；设置 → Guide Dog 显示 语音模式 / 语音输入 / STT 三个区块。

## Phase 2 — 通话模式

### 功能列表

- **零 WebSocket 双通道** — 上行整段 POST `/guide-dog/call-transcribe`
  （webm/opus，≤20MB，复用 Phase 1 `transcribeImpl` 与本地 whisper 管线）
  → `{ok, text, language, durationMs}`；下行 `GET /guide-dog/tts-stream`
  走 chunked HTTP 流（host 按句 spawn `mmx speech synthesize --stream
  --format pcm --sample-rate 24000`，stdout 管道增量喂 `res.write`；client
  用 `fetch().body.getReader()` 读流 → PCM→WAV → Web Audio 无缝调度）。
  传输层无 WebSocket 新协议面，浏览器与 CLI 复用同一管线。
- **VAD 自动 + 按住说话（PTT）** — 默认 VAD（`call.mode='vad'`）：
  MediaRecorder（`audio/webm;codecs=opus`，250ms timeslice 整通录音）+
  并行 AnalyserNode 能量检测（RMS ≥ `vad.threshold`、静音 `vad.silenceMs`
  判定说话结束、`vad.minSpeechMs` 最短语音、`vad.maxSegmentSeconds` 单段
  上限）——说话-停顿-说话自动成两段回合；面板可切换 `ptt` 按住说话
  （按住麦克风说话、松开即发送；VAD 参数不参与端点判定，仅做打断监测）。
- **共识优先（核心交互范式）** — 仅通话/a11y 开启时生效，打字模式保持
  Phase 1 现状：prompt 软约束（`guide_dog_call_consensus` systemPrompt
  variable，聊天式措辞：先理解意图、不清楚就问、写入/修改前说明并等用户
  点头）+ 机制硬保证（`tools/pre-execute` 瀑布拦截：write/edit 与 bash
  破坏性命令启发式 rm/mv/cp/truncate/dd/覆盖重定向/git push 等 → 未确认
  返回 `{kind:'deny', reason:'needs_voice_confirmation'}`，模型语音提问；
  用户确认词命中 → 本轮放行；每次执行前 host 用工具入参生成一句话摘要
  直接 TTS 播报（不走模型），随后开启 `consensus.summaryWindowMs` 打断
  窗口，窗口内用户发声即中止本次执行——工具物理上尚未启动）。拦截器自身
  失败 → 拒绝并口播"共识检查失败"（宁可拦错不可放错，spec §6.8）。
- **进度播报（精简原则，RC10）** — 仅播有效信息：`agent/status`
  （running → "正在处理"）、`tools/result`（工具名→短语：write/edit→
  "正在修改文件"、web_search→"正在搜索网页"、
  guide_dog_image/video/music/speak→"正在生成媒体"、
  bash 仅破坏性命令（与共识拦截同口径 DESTRUCTIVE_BASH_RE）→"正在执行命令"；
  read/grep/glob/skill/非破坏性 bash/未知工具静默）、`agent/error`
  （"处理出错：<短原因>"）；同短语 4s 冷却去重（多步同类操作只报一次）；
  通话中 >120s 无任何事件 → 心跳播报"仍在处理，请稍候"。播报与回复朗读
  共用队列：播报优先（队首）、回复让路；播报走**流式通道**
  （与回复同一 WebAudio PCM 链）→ 单播放器构造性串行，一条接一条，不可能重叠。
- **流式 TTS** — 回复文本按句切分（`stream.sentenceSplit` 字符集
  `。！？.!?\n`；`stream.maxSentenceChars` 超长句强制截断）逐句合成；每句
  经 `guide-dog/tts-token` 重新签发一次性 token（单次消费、5 分钟有效、
  绑定 sessionId）；句间预合成（当前句播放期间 client 提前请求下一句流，
  解码帧按播放时间链无缝追加调度——前一句未播完即续接下一句，长回复完整
  朗读、播放间隙 ≤400ms）。实测中文短句首字节 ~600ms，满足"首音频 <1.5s"
  判据。**只播回合最终消息（RC13）**：中间步骤的 assistant 消息（带工具
  调用块）不入队——逐 step 播放近同文案是"同一内容反复播报"的根因；中间
  步骤由进度播报覆盖。终结型工具回合（最后一条消息仍带工具调用）由
  turn/end 兜底播缓冲文本，不静音。
- **打断（Barge-in）** — VAD 检测到播放中用户发声（≥ `vad.interruptMinMs`
  300ms 防误触）→ 浏览器立即停止播放并清空未播缓冲 → 停播为 10ms 淡出
  （RC13）——`src.stop()` 硬切会在句切断处产生咔哒爆音。打断后的首个转写
  段经 `interrupt` RPC 直达当前回合（`agent.steer`，RC11），不排队成新回合
  → abort 当前 `tts-stream` fetch → 新语音自然成为下一回合（Pipecat
  InterruptionFrame 语义）。
- **语音命令** — 通话转写命中命令表（暂停、恢复、重复/再说一遍、
  慢一点/快一点、看看屏幕〔Phase 3 桩〕）→ 本地执行且不提交到对话
  （停/继续 是共识确认词，不占用命令表、原样放行到 agent）；
  `guide-dog/call-command` RPC 提供 `clear-queue` 等 host 侧命令。
- **双通道互斥（RC13）** — `guide_dog_speak(playOnHost=true)` 已在本机
  扬声器播过的文本，不再经语音模式/通话队列通道重播（消费即删，同文本
  只挡一次）——消除"本机 + 浏览器双响"。
- **容错** — 流中断自动重连一次（按 (sid,text) 5s 内至多重试一次、429
  不重试；每句重新取 token；失败 toast 提示"播放中断"）；STT 失败不提交
  + 提示音 + toast；TTS 失败文字照常落地 + 失败提示音 + 面板错误状态
  （绝不静默）；共识拦截器失败保守拒绝并口播原因。通话转写/打断/轮询的
  会话归属在发起通话时一次性捕获（RC13）——多会话切换不再串台。

### RC14 修复（2026-08-17）：播报内容选择 + 队列截尾 + 进度去重 + 双播定位

- **播报内容净化（`sanitizeSpeechText`，F1）** — 入队前对回复文本做一次
  markdown/URL/emoji 剥离：`[标题](url)` 保留标题去 URL；裸 URL
  （`https?://`、`www.`）整段移除；行首列表/引用标记（`-`/`+`/`*`/`>`）
  与行首有序列表标记（`1.` `1、` `1)`）剥除；`**加粗**`/反引号等
  markdown 标记剥除；emoji 区段（`U+1F000-U+1FAFF` 等）剥除。通话场景
  只朗读人话，不读网址/`**`/`-`/📢 等元字符，避免 "thepaper/newsD/
  weather.com" 这类 URL 碎片被打散朗读。
- **智能分句（`splitSentences`，F2）** — 默认分隔符 `'。！？.!?\n'` 中的
  `.` 改为智能规则：仅当 `.` 后**紧跟空白+大写字母/数字/CJK** 才拆
  （`'Hello. Next'` 拆成 2 句；`'8.17 的上海'` 保持 1 句；URL 内部的 `.`
  不会被打断）。中文分隔集合追加 `；;`，避免 `…；` 把一句中文回复拆成两半。
- **队列上限 40 截尾（`VOICE_QUEUE_MAX`，F3）** — 由 10 提到 40，
  **丢队尾保内容**：超限时 `while (q.length > VOICE_QUEUE_MAX) q.pop()`
  （先入内容优先；旧 `splice(0, …)` 从队头删的策略会把主内容先裁掉，
  保留 URL 碎片）。announce/hb 的 progress 仍用 `pop()`（unshift 到队首，
  progress 优先）。
- **进度短语 30s 去重窗口（F4）** — `announce` 的 `progressDedupe` 冷却
  由 4s 延长到 30s：web_search 多次结果间隔 ~4.3s 时不会连播 3 次
  「正在搜索网页」。`progressDedupe` 函数本体未动；`repro-progress.js`
  语义保持。
- **双通道互斥按净化后文本匹配（F5）** — `wasHostSpoken` /
  `markHostSpoken` 统一使用 `sanitizeSpeechText` 处理后的文本作为键：
  downlink、turn-end flush、voice-mode 三处 `wasHostSpoken` 都按净化键
  匹配；`speakImpl` 在 `playOnHost` 成功后同时注册原始键与净化键（双键），
  下游任一通道都能正确去重。已知边界：transform.py 改写文本时两个键可能
  不完全一致（属可接受边缘）。
- **诊断埋点（F6，一次复测定位"读两遍"）** — 零行为变更，只加日志：
  - host（`[gd-host]`，DSH 终端可见）：
    `enqueue from=downlink|turnend|voice-mode|consensus|announce|heartbeat n=... qlen=...`、
    `shift key=... remain=...`、`skip host-spoken sid=... text=...`、
    `QUEUE-DUP text=...`。
  - client（`[gd]`，浏览器 DevTools）：
    `playStreamEntry ... times=...`（每次播放按 `entry.key || entry.text`
    累加计数）、`PLAY-SUMMARY key=N | ...`（队列空时汇总当前所有计数后
    清空）。
  - 复测定标（RC15 走向依据）：`QUEUE-DUP` → host 双入队；
    `PLAY-SUMMARY key=2` → client 双播；两者皆无但仍两遍 → tts-stream
    音频双写；`enqueue from=` 同源两次同文本 → 事件重放。

### RC15 修复（2026-08-17）：持久播放器 + 手势解锁 + 失败回队 + 事件重放去重

- **持久语音播放器（`playVoiceEntry`，F1）** — 语音模式播放从「每次
  new Audio() + 临时 URL」改为 **fetch + Blob + 单元素复用**：整段音频
  一次 fetch 到 `Blob`，经 `URL.createObjectURL` 绑定到**唯一** `<audio>`
  元素，后续条目只替换 `src` 与播放回调，不再反复创建/销毁 Audio 对象
  ——消灭 `ERR_CONTENT_LENGTH_MISMATCH` 引起的重试风暴（每次重建 Audio
  都会重放 mismatch 前的部分内容，长音频时表现为「反复重播 + 卡顿」）。
- **手势解锁 + 被拦挂起重试（F2）** — 浏览器自动播放策略下首次播放可能
  被拦（`play()` rejected）：进入「待播放挂起」状态，绑定首次用户手势
  （`click`/`keydown`/`touchstart`，capture 阶段、常驻监听）后自动继续；
  被拦条目不再丢弃，手势后重放。`stopCurrent` 中断时正确释放 `busy` 并
  回队（防 busy 死锁吞条目）。
- **失败回队 RPC（`voice-requeue`，F3）** — 播放失败（解码/网络/被拦）时
  client 调 host `voice-requeue` RPC 把该条目重新入队（`requeueEntry` 纯
  函数：新文本插队、重复文本跳过、队尾 pop 截断），每条目最多重试 3 次
  （`attempts` map）——不再丢内容。
- **事件重放 10s 文本窗口去重（`replayDup`，F4）** — host 对「通话下行 +
  语音模式」两通道的 enqueue 增加 10s 窗口的 last-text 去重
  （`lastStreamText`/`lastVoiceText` 双 map）：同文本 10s 内再次入队直接
  跳过（`[gd-host] skip replay text=` / `[gd-host] skip voice-dup text=`
  埋点）。根因：语音模式 + 通话下行的事件重放会让同一文本入队两次——
  男声回复「7 遍」即该窗口缺失所致。
- **url 条目播放计数（F5）** — `PLAY-SUMMARY` 汇总日志覆盖语音模式条目
  （`playCounts` 按 `entry.key || entry.url` 计数，队列空时汇总清空）——
  url 条目的播放次数可追踪，复测定位不再靠猜。
- **构建标记** — 客户端 build tag 当时升级为 `rc15-20260817`
  （`plugin-client.js` 源与 `bundle/lib/client.js` 同步；硬刷新后 DevTools
  控制台可见该行；已被后续版本取代——当前标记为 `rc20-20260817`）。

### config.json 结构（Phase 2：call / a11y）

Phase 1 的 config（`~/.dsh/guide-dog/.guide-dog/config.json`）基础上新增，
全部可选、深合并默认值（spec §4 复制）：

```json
{
  "call": {
    "mode": "vad",
    "vad": {
      "method": "energy",
      "threshold": 0.02,
      "silenceMs": 700,
      "minSpeechMs": 300,
      "maxSegmentSeconds": 60,
      "interruptMinMs": 300
    },
    "stream": {
      "format": "pcm",
      "sampleRate": 24000,
      "sentenceSplit": "。！？.!?\n",
      "maxSentenceChars": 200
    },
    "voice": "English_expressive_narrator",
    "speed": 1.0,
    "progress": true,
    "consensus": { "enabled": true, "summaryWindowMs": 3000 }
  },
  "a11y": {
    "enabled": false,
    "autoNarrate": true,
    "visionCloud": true,
    "summaryFirst": true
  }
}
```

- `call.mode`：`vad`（默认，自动端点检测）| `ptt`（按住说话）。
- `call.vad.method`：`energy`（Phase 2 v1，RMS 能量阈值；背景噪声大时调高
  `threshold`）→ 升级位 `silero`（web-vad 浏览器 WASM）/ `sherpa`
  （VAD+ASR 一体）。
- `call.stream.format/sampleRate`：`mmx speech synthesize --stream` 参数
  （s16le 单声道 PCM；24000 为显式覆盖值，mmx 自身默认 32000）。
- `call.consensus`：`enabled` 开关共识优先（仅通话/a11y 生效）；
  `summaryWindowMs` 摘要播报后等待用户打断的窗口。
- `a11y`：Phase 3 无障碍模式配置（本阶段仅 `enabled` 参与通话流式/共识
  判定；`autoNarrate`/`visionCloud`/`summaryFirst` 为 Phase 3 预留）。

### 路由（Phase 2）

| 方法与路径 | 用途 |
|---|---|
| `POST /guide-dog/call-transcribe` | 上行：整段音频（client 以 raw `audio/webm` body 发送，`x-session-id` 头；host 对整段请求体 base64 后交 whisper），≤20MB 硬上限；host 复用 Phase 1 `transcribeImpl` → `{ok, text, language, durationMs}` |
| `GET /guide-dog/tts-stream?token=…&sid=…&text=<句>` | 下行：chunked PCM 音频流（`content-type: audio/pcm`，`cache-control: no-store`）；需 `guide-dog/tts-token` 签发的一次性 token——无/错 token → 403，该会话有在途流 → 429 |

RPC 风格接口（`tts-token` / `call-active` / `call-command`）走同一 JSON
POST 兼容层，物理 URL 为 `/guide-dog/api/guide-dog/<name>`（双重前缀，
同 Phase 1 `guide-dog/status` 示例）——见下方 RPC surface 表新增三行。

### 验证

```
node --check bundle/lib/index.js && node --check bundle/lib/client.js       # bundle 语法 ×2
curl -s -X POST http://127.0.0.1:3080/guide-dog/call-transcribe \
  -H 'content-type: application/json' -d '{}' | head -5                    # 上行路由可达（空音频 → 错误 JSON）
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3080/guide-dog/tts-stream?token=bad&sid=x&text=hi'      # 无有效 token → 403
```

手动验收清单（完整判据见 `specs/2026-08-14-guide-dog-v2-design.md`
§6.9，部署并重启 DSH 后逐项验证）：

1. VAD：说话-停顿-说话两段分别成回合；静音判定不误切（`threshold` 可调）。
2. 回合循环：语音 → 转写 → 提交 → agent 执行（含工具调用）→ 回复朗读，
   端到端可完成一次"用语音让 agent 生成图片/搜索"。
3. 打断：播放中说话即停，下一回合正常。
4. 进度播报：agent 执行工具期间至少播报一次阶段状态。
5. 流安全：非白名单 Origin 与无/错 token 拒绝；断流重连后恢复。
6. 全量流式：长回复完整朗读；"重复/暂停/慢一点"命令生效；首音频延迟
   ≤1.5s、播放间隙 ≤400ms（实测）。
7. 共识优先：语音"把 README 的 X 改成 Y"→ 不立即执行 → 语音确认 →
   确认后每次写操作前听到简短摘要 → 摘要期间说话 → 该次执行被中止、
   用户语音成为新回合；未确认时 write/edit 被拦截（检查
   `tools/pre-execute` 拦截路径）。
8. 意图模糊（如"改一下那个文件"无上下文）→ agent 语音追问关键问题，
   不臆测执行；用户反问"为什么要改？"→ agent 语音解释。
9. PTT：按住说话/松开发送；VAD 模式下模式开关切换生效。

## RPC surface（Client → Host）

| 方法 | 参数 | 返回 |
|---|---|---|
| `guide-dog/speak` | `{text, voice?, speed?, language?, playOnHost?}` | `{ok, url, file, voice, bytes}` |
| `guide-dog/list-media` | `{limit?}` | `[{name, kind, prompt, voice, ts, bytes, url}]` |
| `guide-dog/auth-status` | — | `{ok, method, source, keyMasked}` |
| `guide-dog/voices` | `{language?}` | `{ok, voices[]}` |
| `guide-dog/get-config` | — | `{ok, config}`（合并默认值） |
| `guide-dog/set-config` | `{patch}` | `{ok}` / `{ok:false, error}` |
| `guide-dog/status` | — | `{ok, status}`（whisper 探测 + probeAt） |
| `guide-dog/transcribe` | `{audioB64, mime, sessionId?, language?}` | `{ok, text, language, durationMs}` / `{ok:false, error}` |
| `guide-dog/beep` | — | `{ok, dataUri}`（WAV 提示音 data URI） |
| `guide-dog/voice-queue` | `{sessionId}` | `{ok, entry}` — 弹出一个条目（播放/错误）或 `null` |
| `guide-dog/tts-token` | `{sessionId}` | `{ok, token}` — 一次性流 token（5 分钟、单次使用、绑定会话） |
| `guide-dog/call-active` | `{sessionId, kind ('session'\|'speaking'), active}` | `{ok}` — 会话持久 vs 瞬时说话标记（C4） |
| `guide-dog/call-command` | `{sessionId, cmd}` | `{ok}` — host 侧通话命令（`clear-queue` …） |

## 安全说明

- 媒体目录在工作区根内 → 无需扩宽沙箱。
- 该路由只提供插件自有媒体且扩展名白名单。
- MiniMax API 密钥留在 mmx 自己的配置（`~/.mmx/config.json`）；插件从不
  读取或转发它。
- 宿主播放使用原生 `subprocess` 服务（播放器必须比沙箱的
  `--die-with-parent` bwrap profile 活得更久）；每次新播放会终止上一个。

## 故障排查

- **`mmx` 未找到 / 认证缺失** — 工具返回 `{ok:false, error}`；设置页显示
  认证问题。修复：`npm install -g mmx-cli` 并 `mmx auth login --api-key
  sk-…`（或 `export MINIMAX_API_KEY=…`）。
- **沙箱拒绝** — 工具错误报告 `denied: true`；把媒体留在工作区内
  （插件已经这么做）。
- **`MiniMax-H3` 返回 "TokenPlan 或 Credit 暂不支持 MiniMax-H3 系列模型"**
  — 账号的 MiniMax 套餐不含 H3 模型族。改用 `model: "MiniMax-Hailuo-2.3"`
  （旧版 V1）或升级套餐。插件原样透传 API 错误，因此在工具结果中可见。
- **视频永不完成** — 轮询循环尊重调用的 abort 信号，15 分钟后超时；
  用更短的 `duration` 或不同的 `model` 重跑。
- **卡片显示通用 JSON** — client 半区未加载；检查 DSH 重启后 bundle
  client 路由 `/plugins/dsh-guide-dog/client.js` 是否返回 200，并刷新页面。
- **停止 / 更新** — 一切（工具、路由、提示词段、卡片、设置项）都会自动
  释放；媒体文件保留。

## mmx 输出形态说明（对照 mmx 1.0.19 验证）

- `--quiet` 会改变各命令的 JSON 形态：`speech voices` 打印扁平字符串数组，
  `text chat` 只打印回复内容（因此插件不带 `--quiet` 跑文本对话），而
  `auth status` / `search query` 保持对象形态。
- `video generate --async` 总是打印 `{taskId}`（原始 stdout 写入）。
- H3（V2）任务结果带 `content.url`；插件用 `curl` 下载。旧版 V1 任务返回
  `file_id`，经 `mmx video download --file-id` 下载。
- 写文件的命令（`image generate --out-dir`、`music generate --out`、
  `speech synthesize --out`、`video download --out`）可能打印不出可解析的
  内容；插件把退出码 0 视为成功，并用 `fs.stat` 验证文件。

## 重启恢复（静态 web-profile 包）

自 2026-08-16 起，Guide Dog 以**静态包**形态挂在 web profile 中——一个
全局 host 半区 + 一个 client 半区，与已发布的 `dsh-better-sidebar` 完全
一致。没有动态插件、没有每会话 `gdog-*` 实例、没有审批卡片：DSH 重启后
工具与语音 UI 随 profile 一起恢复。

唯一事实来源仍是两个动态插件半区（`plugin-host.js` / `plugin-client.js`）；
`deploy/convert_bundle.py` 从中重新生成 `bundle/lib/`：

- **host 半区**（`bundle/lib/index.js`，ESM `name`/`apply`）：一个小型兼容
  层取代动态沙箱的 `harness` —— 工具定义通过全局 `tools` 注册表注册
  （每个会话可见），原来的 `harness.handle` RPC（`guide-dog/*`）变成
  `/guide-dog/api/` 下的 JSON POST 路由。每工作区沙箱根被全局存储
  `~/.dsh/guide-dog/`（config、media、scripts）取代。
- **client 半区**（`bundle/lib/client.js`）：像已发布的包一样的
  `window.__ModuleLoader__.load({id, factory})` CJS factory；
  `require('react')` 来自平台 seed，用自管理的 `<style>` 标签代替沙箱
  `styles`，`host.call` 变成对 JSON 路由的同源 `fetch`。

任何插件变更后部署一次：

1. `python3 deploy/convert_bundle.py` — 重新生成 `bundle/lib/`。
2. `python3 deploy/publish.py` — 把包复制到 `~/.dsh/dsh-guide-dog`
   （工作区之外），**幂等地注册到 web profile**（`~/.dsh/profiles/web`：
   依赖链接 + `bundles` 条目 + `node_modules` 符号链接），并**移除被取代的
   `dsh-guide-dog-autoload` 包**（否则它会继续按会话部署动态实例）。
3. 重启 DSH（`dsh web`）— 包在启动时解析，因此任何变更后都需要重启。

历史沿革：早期的自动部署器（`autoload/`）——一个监视 `agent/created` 并
按会话 `define`+`run` 全新 `gdog-*` 动态插件的 host 包——保留在仓库中，
仍发布到 `~/.dsh/guide-dog-deploy` / `~/.dsh/guide-dog-autoload` 以备回滚，
但从 profile 移除后没有任何东西消费它。

Profile 坑（2026-08-15 观察）：`dsh web` 是 `--profile web` 的别名——GUI
运行的是 **web** profile。只在其他 profile（如 `cc-tui`）注册包对 GUI
静默无效；`deploy/publish.py` 始终目标 `~/.dsh/profiles/web`。

服务作用域坑（2026-08-16 观察——根因 #3）：`dynamicCordisRunner` 与
`agents` 服务注册在**智能体作用域上下文**上，而不是包的 `apply(ctx)`
运行的全局/profile 上下文上。那里的 `ctx.get('dynamicCordisRunner')` 返回
`undefined`，因此 `apply` 里过早的 `if (!runner || !agents) return` 在
`agent/created` 监听器注册之前就退出了——包加载正常（经 `dsh web
--dump-default-config` 验证）却从未部署。修复方案：通过事件载荷的
`agent.ctx` 解析两个服务（`Agent` 暴露 `readonly ctx: Context`；已用探针
验证两个服务在那里可见），并为在全局注册它们的 host 提供全局 `ctx`
回退。调试辅助：临时动态探针插件（`inject: ['dynamicCordisRunner',
'agents']`）在其（智能体作用域）`apply` ctx 中能看到两个服务——这种
不对称性正是该坑的特征。

包形态沿用已发布的 `dsh-better-sidebar` 先例：`dsh.bundle.patch` →
`cordis.patch.yml` 单 `insert` 行、具名导出（`export const name` +
`export function apply(ctx)`）、无默认导出、仅 host（无需 `dsh.client` 块）。

## Phase 2 积压（V4-Pro 终审延后项）

- **M9** — 录音中途切换会话时，mic `onstop` 闭包持有过期的
  `inputActions`；转写前需重新校验录音器归属。
- **M10** — 媒体路由为满足范围请求会把整个文件缓冲在内存中；只流式提供
  请求的字节范围（Phase 2 流式 TTS/播放上线后重要）。
- **M11** — `setVoiceOverride` 用可能过期的 config 重建整个
  `voiceMode.sessions` 映射，并发会话切换可能互相覆盖；改为按键合并
  （host 侧 patch）或写入前刷新 cfg。
