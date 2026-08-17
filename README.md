# Guide Dog for DSH, powered by MiniMax

A dynamic Cordis plugin that gives DeepSeek Harness multimodal superpowers through
the [mmx CLI](https://www.npmjs.com/package/mmx-cli) (MiniMax):

- **Eyes for DeepSeek** — MiniMax VLM (`guide_dog_vision` / `guide_dog_inspect`)
  describes images, so a model with no native vision input (e.g. DeepSeek) can
  still review frontend designs, figures, screenshots, and generated images.
- **Hands for generation** — images (`image-01`), video (`MiniMax-H3` / Hailuo),
  speech (MiniMax TTS), music (`music-3.0`), text (`MiniMax-M3`), and web search.
- **Web UI preview & playback** — every generated file is served same-origin at
  `/guide-dog/media/<file>` and rendered inline in the conversation tool cards
  (`<img>`, `<audio controls>`, `<video controls>`), plus a **Guide Dog**
  settings page with auth status, a speak tester, and a recent-media gallery.
- **Skill integration** — `guide_dog_speak` reuses your existing
  [`audio-conversation`](https://github.com/your/audio-conversation) and
  [`speech-mmx`](https://github.com/your/speech-mmx) skill pipelines
  (text transform, CJK auto-detect, per-language voices, host playback),
  and falls back to raw `mmx speech synthesize` when the skill scripts are absent.
- **Automatic invocation** — a mounted system-prompt section
  (`guide-dog-vision`, order 110) tells the agent to auto-invoke the inspection
  tools for any job needing visual checks, especially when the active model
  cannot see images.

## Files

| File | Purpose |
|---|---|
| `plugin-host.js` | Host half — **source of record** (tools, RPC, media route, prompt section, voice mode) |
| `plugin-client.js` | Client half — **source of record** (tool cards, settings page, voice cluster) |
| `bundle/` | Static web-profile bundle generated from the two halves (`deploy/convert_bundle.py`) |
| `deploy/` | `convert_bundle.py` (source → bundle) and `publish.py` (bundle → `~/.dsh/dsh-guide-dog` + web profile registration) |
| `README.md` | This file |

## Deploy (static web-profile bundle — current)

1. Edit the source of record: `plugin-host.js` / `plugin-client.js`.
2. `python3 deploy/convert_bundle.py` — regenerate `bundle/lib/`.
3. `python3 deploy/publish.py` — copy to `~/.dsh/dsh-guide-dog`, idempotently
   register in `~/.dsh/profiles/web` (dependency link + `bundles` entry +
   node_modules symlink), remove the superseded autoload bundle.
4. **Restart DSH** (`dsh web`) — bundles are parsed at startup.

No dynamic plugin, no approval cards, no per-session instances: after a DSH
restart the tools and voice UI come back with the profile itself. Full details
and pitfalls in the "Restart recovery" section below.

`plugin-source.js` is a legacy dynamic-era artifact (both halves concatenated);
kept for reference, not used by the current deploy flow.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `guide_dog_speak` | `text`*, `voice` (auto), `speed`, `language`, `playOnHost` | `{ok, url, voice, bytes}` mp3 |
| `guide_dog_image` | `prompt`*, `aspectRatio`, `n`, `width`, `height`, `seed`, `promptOptimizer`, `watermark` | `{ok, urls[], files[]}` |
| `guide_dog_video` | `prompt`*, `model` (MiniMax-H3 default), `image`, `subjectImage`, `duration`, `ratio` | `{ok, url, taskId}` mp4 (polls until done) |
| `guide_dog_vision` | `image`*, `prompt` | `{ok, answer}` VLM description |
| `guide_dog_inspect` | `image`*, `focus` (general/frontend/figure/screenshot/ocr), `prompt` | `{ok, answer, focus}` structured review |
| `guide_dog_voices` | `language` | `{ok, voices[]}` |
| `guide_dog_music` | `prompt`*, `lyrics`, `instrumental`, `vocals`, `genre`, `mood`, `model` | `{ok, url}` mp3 |
| `guide_dog_text` | `message`*, `system`, `model`, `maxTokens`, `temperature` | `{ok, text}` |
| `guide_dog_search` | `q`* | `{ok, results[]}` (max 10) |

\* required

## Auto-invoke contract (visual checks)

While the plugin runs, a system-prompt section instructs the agent:

- For **visual checks** (frontend design review, figure/plot/chart generation,
  screenshots, UI mockups, generated-image QA) it MUST call
  `guide_dog_inspect` (structured) or `guide_dog_vision` (general) on the
  produced image file before finalizing — never claim to have seen an image it
  has not inspected.
- Generated media is served to the user at `/guide-dog/media/<file>`; the agent
  must include the returned `url` fields so the user can preview.
- Speech requests route to `guide_dog_speak`.

Example visual-check flow on DeepSeek:

```
1. (agent) create figure/screenshot file, e.g. chart.png
2. (agent) guide_dog_inspect { image: "chart.png", focus: "figure" }
          → structured review of axes/labels/readability/encoding
3. (agent) iterate the figure, re-inspect, then finalize with the url
4. (user)   previews chart.png in the web UI card
```

## Media store & serving

- Media lives in `~/.dsh/guide-dog/.guide-dog/media` — the **global store**
  under `GLOBAL_ROOT = ~/.dsh/guide-dog` (one instance for the whole web
  profile since 2026-08-16; no longer the per-workspace sandbox root — see
  "Restart recovery" below).
- Served by a same-origin prefix route `/guide-dog/media` with:
  - extension allowlist (`jpg/jpeg/png/gif/webp/mp3/wav/m4a/ogg/mp4/webm`),
  - basename-only lookup + traversal guard,
  - `Accept-Ranges: bytes` with real byte-range responses (video seeking),
  - 404/405/413/416 as appropriate.
- `.index.json` keeps metadata (`prompt`, `voice`, `ts`, `kind`) for the
  settings gallery (`guide-dog/list-media` RPC). A corrupt index is rebuilt
  from the directory.
- Files persist across plugin restarts; stopping/removing the plugin only
  removes the runtime registrations, never the files.

## Skill integration (audio-conversation / speech-mmx)

`guide_dog_speak` honors the exact pipeline of your two skills:

1. `~/.agents/skills/audio-conversation/scripts/transform.py` — markdown/code/URL
   stripping (falls back to a built-in JS transform when absent).
2. CJK auto-detect → per-language voice defaults
   (`English_Trustworthy_Man` / `Chinese (Mandarin)_Gentle_Youth`), same as the
   skill env contract. Explicit `voice` overrides; `language` boosts accents.
3. `~/.agents/skills/speech-mmx/scripts/mmx_tts.py speak --input … --out …`
   (falls back to `mmx speech synthesize`).
4. Browser playback via the returned mp3 URL. With `playOnHost: true` the host
   speakers play it too — one file at a time (previous playback is terminated
   first), mirroring the skill's latest-only rule.

Env vars of the skills that still apply when set in the dsh process
environment: `AUDIO_CONVERSATION_VOICE(_EN/_ZH)`, `AUDIO_CONVERSATION_SPEED`,
`AUDIO_CONVERSATION_DIR`, `AUDIO_CONVERSATION_NO_PLAY`, `AUDIO_CONVERSATION_KEEP_FILES`,
`TTS_GEN`. Turn files keep the `turn-NNN.mp3` naming convention.

## Settings page

Settings → **Guide Dog** (id `guide-dog`):

- **Auth** — `mmx auth status` result with the key masked (`sk-c…xxxx`); never
  logged in full.
- **语音模式（Voice mode）** — global default on/off radios (per-session
  override lives on the small speaker button at the input's bottom-left).
- **语音输入（Voice input）** — STT engine select (whisper / sherpa / minimax),
  recognition language (auto/zh/en), and auto-send-after-recognition checkbox.
- **STT** — faster-whisper availability + version/python, and the whisper model
  select (base/small).
- **Speak tester** — text + voice selector (from `guide-dog/voices`), plays the
  mp3 in the browser.
- **Recent media** — last 30 items from the index: image thumbnails (click to
  open full size), video tiles, audio players.

## Phase 1 — voice mode & voice input

### Feature list

- **Voice mode (host event-driven)** — a host `session/event` listener watches
  `assistant/message` events, extracts the reply text
  (`event.data.content` blocks with `type === 'text'`), checks whether voice
  mode is effective for that session (session override else global default),
  and enqueues the TTS result (`{url, key}`) or error into a per-session
  `voiceQueue`. The client polls the queue every second and plays it with a
  module-level `Audio` object, or shows a bottom-right toast + beep for 6s.
- **Voice cluster** — `conversation.input.left` entry `guide-dog-voice`
  (order 30) at the input box's bottom-left, themed with DSH tokens
  (`--dsw-alias-*`), inheriting the app font:
  - small **speaker** icon — click toggles the per-session voice-mode override
    (`guide-dog/set-config` with `voiceMode.sessions`); hover tooltip shows
    "语音模式提示：开/关 · 全局默认：开/关".
  - **language dropdown** — recognition language detection (auto/zh/en).
  - **mic** icon — record → transcribe → insert (feather-style SVG; recording
    state pulses red with a second counter).
- **Session-scoped playback** — playback runs on a module-level `Audio`
  object, so switching sessions never replays or interrupts it: the current
  clip plays to the end unless a new playback task (a fresh queue entry from
  any session) overrides it.
- **Mic voice input** — the mic in the cluster: MediaRecorder with 1s
  timeslices, live second counter, maxSeconds auto-stop, language from the
  dropdown, and transcribe via `guide-dog/transcribe`. Recognized text is
  inserted into the input box with `inputActions.setDraft(text)` (auto-send
  via `inputActions.submit()` when configured). Error states: `mic_denied`,
  `no_device`, `empty_speech`, `stt_failed`, `stt_timeout`,
  `engine_unavailable`, `insert_failed` (never silent).
- **Recorder page** — sandboxed clients that cannot record in-page get a
  `🎙 打开录音页` link to the standalone `/guide-dog/recorder` page
  (GET serves a self-contained HTML recorder; POST
  `/guide-dog/transcribe-upload` accepts raw `audio/webm`, 20 MB cap, and runs
  the same `transcribeImpl`).
- **Settings controls** — the Phase 1 config blocks above, backed by
  `guide-dog/get-config` / `guide-dog/set-config` / `guide-dog/status`.

### config.json schema

Lives at `~/.dsh/guide-dog/.guide-dog/config.json` (auto-created from
defaults; all keys optional, deep-merged over the defaults):

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

- `voiceMode.sessions` maps a session id to a boolean override; `default` is
  the fallback. The speaker button at the input's bottom-left toggles the
  current session's override.
- `voiceInput.engine`: `whisper` (only engine implemented; `sherpa`/`minimax`
  are reserved — selecting them returns `engine_unavailable`).
- `voiceInput.maxSeconds` forces the mic recording to stop.

### STT engine (faster-whisper)

The `whisper` engine shells out to a bundled Python script
(`.guide-dog/scripts/whisper_transcribe.py`) using `faster-whisper`:

```
pip install faster-whisper        # needs Python 3.8+; installs torch cpu wheels
python3 -c "import faster_whisper; print(faster_whisper.__version__)"
```

The host probes availability at startup and writes the result to
`.guide-dog/status.json` (`whisperAvailable`, `whisperVersion`, `whisperPython`),
shown in the Settings → STT row. Model choices: `base` (fast) / `small`
(accurate); first run downloads the model weights.

### Verification

```
node --check plugin-host.js && node --check plugin-client.js          # syntax
curl -s http://127.0.0.1:3080/guide-dog/recorder | head -5             # recorder page serves HTML
curl -s -X POST http://127.0.0.1:3080/guide-dog/api/guide-dog/status \
  -H 'content-type: application/json' -d '{}' | head -5               # status RPC (compat layer)
cat ~/.dsh/guide-dog/.guide-dog/status.json                            # whisper probe result
```

Manual checks (after deploy): click the speaker button (voice mode on, turns
green) → send a message → the assistant reply is spoken automatically; switch
sessions mid-playback → the clip continues to the end and is NOT replayed;
use the mic button → recognized text appears in the input box; Settings →
Guide Dog shows the 语音模式 / 语音输入 / STT blocks.

## Phase 2 — call mode (通话模式)

### Feature list

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
- **共识优先（Consensus-first，核心交互范式）** — 仅通话/a11y 开启时生效，
  打字模式保持 Phase 1 现状：prompt 软约束（`guide_dog_call_consensus`
  systemPrompt variable，聊天式措辞：先理解意图、不清楚就问、写入/修改前
  说明并等用户点头）+ 机制硬保证（`tools/pre-execute` 瀑布拦截：write/edit
  与 bash 破坏性命令启发式 rm/mv/cp/truncate/dd/覆盖重定向/git push 等 →
  未确认返回 `{kind:'deny', reason:'needs_voice_confirmation'}`，模型语音
  提问；用户确认词命中 → 本轮放行；每次执行前 host 用工具入参生成一句话
  摘要直接 TTS 播报（不走模型），随后开启 `consensus.summaryWindowMs` 打断
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
  绑定 sessionId）；句间预合成（当前句播放期间 client 提前请求下一句流，解码帧
  按播放时间链无缝追加调度——前一句未播完即续接下一句，长回复完整朗读、播放
  间隙 ≤400ms）。
  实测中文短句首字节 ~600ms，满足"首音频 <1.5s"判据。
  **只播回合最终消息（RC13）**：中间步骤的 assistant 消息（带工具调用块）不入队——逐 step 播放近同文案是"同一内容反复播报"的根因；中间步骤由进度播报覆盖。终结型工具回合（最后一条消息仍带工具调用）由 turn/end 兜底播缓冲文本，不静音。
- **打断（Barge-in）** — VAD 检测到播放中用户发声（≥ `vad.interruptMinMs`
  300ms 防误触）→ 浏览器立即停止播放并清空未播缓冲 → 停播为 10ms 淡出
  （RC13）——`src.stop()` 硬切会在句切断处产生咔哒爆音。打断后的首个
  转写段经 `interrupt` RPC 直达当前回合（`agent.steer`，RC11），不排队成
  新回合 → abort 当前
  `tts-stream` fetch → 新语音自然成为下一回合（Pipecat InterruptionFrame
  语义）。
- **语音命令** — 通话转写命中命令表（暂停、恢复、重复/再说一遍、慢一点/快一点、
  看看屏幕〔Phase 3 桩〕）→ 本地执行且不提交到对话（停/继续 是共识确认词，不
  占用命令表、原样放行到 agent）；
  `guide-dog/call-command` RPC 提供 `clear-queue` 等 host 侧命令。
- **双通道互斥（RC13）** — `guide_dog_speak(playOnHost=true)` 已在本机扬声器播过的文本，不再经语音模式/通话队列通道重播（消费即删，同文本只挡一次）——消除"本机 + 浏览器双响"。
- **容错** — 流中断自动重连一次（按 (sid,text) 5s 内至多重试一次、429 不重试；每句重新取 token；失败 toast 提示
  "播放中断"）；STT 失败不提交 + 提示音 + toast；TTS 失败文字照常落地 +
  失败提示音 + 面板错误状态（绝不静默）；共识拦截器失败保守拒绝并口播原因。
  通话转写/打断/轮询的会话归属在发起通话时一次性捕获（RC13）——多会话切换不再串台。

### RC14 修复（2026-08-17）：播报内容选择 + 队列截尾 + 进度去重 + 双播定位

- **播报内容净化（`sanitizeSpeechText`，F1）** — 入队前对回复文本做一次 markdown/URL/emoji
  剥离：`[标题](url)` 保留标题去 URL；裸 URL（`https?://`、`www.`）整段移除；行首列表/引用
  标记（`-`/`+`/`*`/`>`）与行首有序列表标记（`1.` `1、` `1)`）剥除；`**加粗**`/`` ` ``/`` ``` ``
  等 markdown 标记剥除；emoji 区段（`U+1F000-U+1FAFF` 等）剥除。通话场景只朗读人话，不读
  网址/`**`/`-`/📢 等元字符，避免"thepaper/newsD/weather.com"这类 URL 碎片被打散朗读。
- **智能分句（`splitSentences`，F2）** — 默认分隔符 `'。！？.!?\n'` 中的 `.` 改为智能规则：
  仅当 `.` 后**紧跟空白+大写字母/数字/CJK** 才拆（`'Hello. Next'` 拆成 2 句；`'8.17 的上海'`
  保持 1 句；URL 内部的 `.` 不会被打断）。中文分隔集合追加 `；;`，避免 `…；` 把一句中文回复
  拆成两半。
- **队列上限 40 截尾（`VOICE_QUEUE_MAX`，F3）** — 由 10 提到 40，**丢队尾保内容**：
  超限时 `while (q.length > VOICE_QUEUE_MAX) q.pop()`（先入内容优先；旧 `splice(0, …)`
  从队头删的策略会把主内容先裁掉，保留 URL 碎片）。announce/hb 的 progress 仍用 `pop()`
  （unshift 到队首，progress 优先）。
- **进度短语 30s 去重窗口（F4）** — `announce` 的 `progressDedupe` 冷却由 4s 延长到 30s：
  web_search 多次结果间隔 ~4.3s 时不会连播 3 次「正在搜索网页」。`progressDedupe` 函数
  本体未动；`repro-progress.js` 语义保持。
- **双通道互斥按净化后文本匹配（F5）** — `wasHostSpoken` / `markHostSpoken` 统一使用
  `sanitizeSpeechText` 处理后的文本作为键：downlink、turn-end flush、voice-mode 三处
  `wasHostSpoken` 都按净化键匹配；`speakImpl` 在 `playOnHost` 成功后同时注册原始键与
  净化键（双键），下游任一通道都能正确去重。已知边界：transform.py 改写文本时两个键
  可能不完全一致（属可接受边缘）。
- **诊断埋点（F6，一次复测定位"读两遍"）** — 零行为变更，只加日志：
  - host（`[gd-host]`，DSH 终端可见）：
    `enqueue from=downlink|turnend|voice-mode|consensus|announce|heartbeat n=... qlen=...`、
    `shift key=... remain=...`、`skip host-spoken sid=... text=...`、`QUEUE-DUP text=...`。
  - client（`[gd]`，浏览器 DevTools）：
    `playStreamEntry ... times=...`（每次播放按 `entry.key || entry.text` 累加计数）、
    `PLAY-SUMMARY key=N | ...`（队列空时汇总当前所有计数后清空）。
  - 复测定标（RC15 走向依据）：`QUEUE-DUP` → host 双入队；`PLAY-SUMMARY key=2` → client 双播；
    两者皆无但仍两遍 → tts-stream 音频双写；`enqueue from=` 同源两次同文本 → 事件重放。

### config.json schema（Phase 2：call / a11y）

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

- `call.mode`: `vad`（默认，自动端点检测）| `ptt`（按住说话）。
- `call.vad.method`: `energy`（Phase 2 v1，RMS 能量阈值；背景噪声大时调高
  `threshold`）→ 升级位 `silero`（web-vad 浏览器 WASM）/ `sherpa`
  （VAD+ASR 一体）。
- `call.stream.format/sampleRate`: `mmx speech synthesize --stream` 参数
  （s16le 单声道 PCM；24000 为显式覆盖值，mmx 自身默认 32000）。
- `call.consensus`: `enabled` 开关共识优先（仅通话/a11y 生效）；
  `summaryWindowMs` 摘要播报后等待用户打断的窗口。
- `a11y`: Phase 3 无障碍模式配置（本阶段仅 `enabled` 参与通话流式/共识
  判定；`autoNarrate`/`visionCloud`/`summaryFirst` 为 Phase 3 预留）。

### Routes (Phase 2)

| Method & Path | Purpose |
|---|---|
| `POST /guide-dog/call-transcribe` | 上行：整段音频（client 以 raw `audio/webm` body 发送，`x-session-id` 头；host 对整段请求体 base64 后交 whisper），≤20MB 硬上限；host 复用 Phase 1 `transcribeImpl` → `{ok, text, language, durationMs}` |
| `GET /guide-dog/tts-stream?token=…&sid=…&text=<句>` | 下行：chunked PCM 音频流（`content-type: audio/pcm`，`cache-control: no-store`）；需 `guide-dog/tts-token` 签发的一次性 token——无/错 token → 403，该会话有在途流 → 429 |

RPC 风格接口（`tts-token` / `call-active` / `call-command`）走同一 JSON POST
兼容层，物理 URL 为 `/guide-dog/api/guide-dog/<name>`（双重前缀，同 Phase 1
`guide-dog/status` 示例）——见下方 RPC surface 表新增三行。

### Verification

```
node --check bundle/lib/index.js && node --check bundle/lib/client.js       # bundle 语法 ×2
curl -s -X POST http://127.0.0.1:3080/guide-dog/call-transcribe \
  -H 'content-type: application/json' -d '{}' | head -5                    # 上行路由可达（空音频 → 错误 JSON）
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3080/guide-dog/tts-stream?token=bad&sid=x&text=hi'      # 无有效 token → 403
```

Manual acceptance checklist（完整判据见 `specs/2026-08-14-guide-dog-v2-design.md`
§6.9，部署并重启 DSH 后逐项验证）：

1. VAD：说话-停顿-说话两段分别成回合；静音判定不误切（`threshold` 可调）。
2. 回合循环：语音 → 转写 → 提交 → agent 执行（含工具调用）→ 回复朗读，
   端到端可完成一次"用语音让 agent 生成图片/搜索"。
3. 打断：播放中说话即停，下一回合正常。
4. 进度播报：agent 执行工具期间至少播报一次阶段状态。
5. 流安全：非白名单 Origin 与无/错 token 拒绝；断流重连后恢复。
6. 全量流式：长回复完整朗读；"重复/暂停/慢一点"命令生效；首音频延迟 ≤1.5s、
   播放间隙 ≤400ms（实测）。
7. 共识优先：语音"把 README 的 X 改成 Y"→ 不立即执行 → 语音确认 → 确认后
   每次写操作前听到简短摘要 → 摘要期间说话 → 该次执行被中止、用户语音成为
   新回合；未确认时 write/edit 被拦截（检查 `tools/pre-execute` 拦截路径）。
8. 意图模糊（如"改一下那个文件"无上下文）→ agent 语音追问关键问题，不臆测
   执行；用户反问"为什么要改？"→ agent 语音解释。
9. PTT：按住说话/松开发送；VAD 模式下模式开关切换生效。

## RPC surface (Client → Host)

| Method | Args | Returns |
|---|---|---|
| `guide-dog/speak` | `{text, voice?, speed?, language?, playOnHost?}` | `{ok, url, file, voice, bytes}` |
| `guide-dog/list-media` | `{limit?}` | `[{name, kind, prompt, voice, ts, bytes, url}]` |
| `guide-dog/auth-status` | — | `{ok, method, source, keyMasked}` |
| `guide-dog/voices` | `{language?}` | `{ok, voices[]}` |
| `guide-dog/get-config` | — | `{ok, config}` (merged defaults) |
| `guide-dog/set-config` | `{patch}` | `{ok}` / `{ok:false, error}` |
| `guide-dog/status` | — | `{ok, status}` (whisper probe + probeAt) |
| `guide-dog/transcribe` | `{audioB64, mime, sessionId?, language?}` | `{ok, text, language, durationMs}` / `{ok:false, error}` |
| `guide-dog/beep` | — | `{ok, dataUri}` (WAV beep data URI) |
| `guide-dog/voice-queue` | `{sessionId}` | `{ok, entry}` — pops one entry (play/error) or `null` |
| `guide-dog/tts-token` | `{sessionId}` | `{ok, token}` — one-time stream token (5 min, single-use, bound to session) |
| `guide-dog/call-active` | `{sessionId, kind ('session'\|'speaking'), active}` | `{ok}` — session persistence vs instantaneous speaking flag (C4) |
| `guide-dog/call-command` | `{sessionId, cmd}` | `{ok}` — host-side call commands (`clear-queue` …) |

## Security notes

- Media dir inside the workspace root → no sandbox widening required.
- The route serves only plugin-owned media with allowlisted extensions.
- The MiniMax API key stays in mmx's own config (`~/.mmx/config.json`); the
  plugin never reads or forwards it.
- Host playback uses the raw `subprocess` service (players must outlive the
  sandbox's `--die-with-parent` bwrap profile); each new playback terminates the
  previous one.

## Troubleshooting

- **`mmx` not found / auth missing** — tool returns `{ok:false, error}`; the
  settings page shows the auth problem. Fix: `npm install -g mmx-cli` and
  `mmx auth login --api-key sk-…` (or `export MINIMAX_API_KEY=…`).
- **Sandbox denial** — the tool error reports `denied: true`; keep media inside
  the workspace (the plugin already does).
- **`MiniMax-H3` returns "TokenPlan 或 Credit 暂不支持 MiniMax-H3 系列模型"** —
  the account's MiniMax plan does not include the H3 model family. Use
  `model: "MiniMax-Hailuo-2.3"` (legacy V1) or upgrade the plan. The plugin
  surfaces the API error verbatim, so this is visible in the tool result.
- **Video never finishes** — the poll loop honors the call's abort signal and
  times out after 15 minutes; re-run with a shorter `duration` or different
  `model`.
- **Cards show generic JSON** — the client half did not load; check that the
  bundle client route `/plugins/dsh-guide-dog/client.js` returns 200 after a
  DSH restart, and refresh the page.
- **Stop / update** — everything (tools, route, prompt section, cards, settings
  entry) is disposed automatically; media files remain.

## mmx output-shape notes (verified against mmx 1.0.19)

- `--quiet` changes per-command JSON shapes: `speech voices` prints a flat
  array of voice-id strings, `text chat` prints only the reply content (so the
  plugin runs text chat without `--quiet`), while `auth status` / `search query`
  keep their objects.
- `video generate --async` always prints `{taskId}` (raw stdout write).
- H3 (V2) task results carry `content.url`; the plugin downloads it with
  `curl`. Legacy V1 tasks return `file_id`, downloaded via
  `mmx video download --file-id`.
- File-writing commands (`image generate --out-dir`, `music generate --out`,
  `speech synthesize --out`, `video download --out`) may print nothing
  parseable; the plugin treats exit 0 as success and verifies the file via
  `fs.stat`.

## Restart recovery (static web-profile bundle)

Since 2026-08-16 Guide Dog ships as a **static bundle** mounted in the web
profile — one global host half + one client half, exactly like the published
`dsh-better-sidebar`. No dynamic plugin, no per-session `gdog-*` instances,
no approval cards: after a DSH restart the tools and the voice UI come back
with the profile itself.

The source of record stays the two dynamic-plugin halves
(`plugin-host.js` / `plugin-client.js`); `deploy/convert_bundle.py`
regenerates `bundle/lib/` from them:

- **host half** (`bundle/lib/index.js`, ESM `name`/`apply`): a tiny
  compatibility layer replaces the dynamic sandbox's `harness` — tool
  definitions are registered via the global `tools` registry (visible to
  every session), and the former `harness.handle` RPCs (`guide-dog/*`) become
  JSON POST routes under `/guide-dog/api/`. The per-workspace sandbox root is
  replaced by the global store `~/.dsh/guide-dog/` (config, media, scripts).
- **client half** (`bundle/lib/client.js`): a
  `window.__ModuleLoader__.load({id, factory})` CJS factory like the
  published bundles; `require('react')` from the platform seed, self-managed
  `<style>` tag instead of the sandbox `styles`, and `host.call` becomes
  same-origin `fetch` against the JSON routes.

Deploy once after any plugin change:

1. `python3 deploy/convert_bundle.py` — regenerate `bundle/lib/`.
2. `python3 deploy/publish.py` — copies the bundle to `~/.dsh/dsh-guide-dog`
   (outside workspaces), **idempotently registers it in the web profile**
   (`~/.dsh/profiles/web`: dependency link + `bundles` entry + `node_modules`
   symlink) and **removes the superseded `dsh-guide-dog-autoload` bundle**
   (which otherwise keeps deploying per-session dynamic instances).
3. Restart DSH (`dsh web`) — bundles are parsed at startup, so a restart is
   required after any change.

Legacy history: the earlier auto-deployer (`autoload/`) — a host bundle that
watched `agent/created` and `define`+`run`ed a fresh `gdog-*` dynamic plugin
per session — is retained in the repo and still published to
`~/.dsh/guide-dog-deploy` / `~/.dsh/guide-dog-autoload` for rollback, but
nothing consumes it once removed from the profile.

Profile pitfall (observed 2026-08-15): `dsh web` is an alias for
`--profile web` — the GUI runs the **web** profile. Registering a bundle
only in another profile (e.g. `cc-tui`) silently does nothing for the GUI;
`deploy/publish.py` always targets `~/.dsh/profiles/web`.


Service-scope pitfall (observed 2026-08-16 — root cause #3): the
`dynamicCordisRunner` and `agents` services are registered on **agent-scoped
contexts**, not on the global/profile context a bundle's `apply(ctx)` runs in.
`ctx.get('dynamicCordisRunner')` there returns `undefined`, so an early
`if (!runner || !agents) return` in `apply` bailed out before the
`agent/created` listener was even registered — the bundle loaded fine
(verified via `dsh web --dump-default-config`) yet never deployed. The fix
resolves both services through the event payload's `agent.ctx`
(`Agent` exposes `readonly ctx: Context`; probe-verified that both services
are visible there), with a global-`ctx` fallback for hosts that register them
globally. Debugging aid: a temporary dynamic probe plugin (`inject:
['dynamicCordisRunner', 'agents']`) sees both services in its (agent-scoped)
`apply` ctx — that asymmetry is the signature of this pitfall.

The bundle shape mirrors the published `dsh-better-sidebar` precedent:
`dsh.bundle.patch` → `cordis.patch.yml` with a single `insert` row, named
exports (`export const name` + `export function apply(ctx)`), no default
export, host-only (no `dsh.client` block needed).

## Phase 2 backlog (deferred from the V4-Pro final review)

- **M9** — mic `onstop` closure holds a stale `inputActions` when switching
  sessions mid-recording; re-check recorder ownership before transcribing.
- **M10** — the media route buffers the entire file in memory to satisfy
  range requests; stream only the requested byte range (matters once Phase 2
  streaming TTS/playback lands).
- **M11** — `setVoiceOverride` rebuilds the whole `voiceMode.sessions` map
  from possibly-stale config, so concurrent session toggles can clobber each
  other; move to per-key merge (host-side patch) or refresh cfg before write.
