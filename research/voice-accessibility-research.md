# 导盲犬（Guide Dog for DSH）语音与无障碍功能调研报告

> 调研目的：为 DSH 浏览器端 AI 助手的四个功能提供可落地的开源方案与架构参考——①语音模式加固 ②语音输入（麦克风→STT→输入框）③全双工语音 CALL（VAD/打断/流式TTS）④视障无障碍模式（截图→VLM→TTS 播报）。
> 方法：`web_search` + curl 官方文档/仓库 README（未安装任何软件）。英文项目/API 名保留原文，其余为中文。

---

## 1. 实时语音通话 / 全双工语音 Agent（重点）

### 1.1 项目速览

| 项目 | 开源 | 主要运行位置 | 传输 | 一句话定位 |
|---|---|---|---|---|
| [LiveKit Agents](https://docs.livekit.io/agents/logic/turns.md) | ✅ | 服务端（agent）+ 浏览器 SDK | WebRTC | 最完整的"网页内 LLM 语音通话"框架 |
| [Pipecat](https://github.com/pipecat-ai/pipecat) | ✅ | 服务端 pipeline，客户端 SDK | WebSocket / WebRTC(Daily/LiveKit) | 最模块化的语音 agent 编排框架 |
| [Vocode](https://docs.vocode.dev/open-source/conversation-mechanics) | ✅ | 服务端 StreamingConversation | WebRTC/电话/WebSocket | 电话级对话引擎，可调旋钮多 |
| [Ultravox](https://www.ultravox.ai/) | 模型开源/服务托管 | 服务端（speech-to-speech） | WebSocket/WebRTC | 端到端语音模型，自带多级 VAD |
| [Sesame CSM-1B](https://huggingface.co/sesame/csm-1b) | ✅ | 本地 GPU | —（需自拼 STT/LLM） | 开源对话语音生成模型 |
| [Moonshine](https://github.com/moonshine-ai/moonshine) | ✅ | 端侧（含 WASM） | — | 流式端侧 STT，边听边出字 |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | ✅ | 端侧/服务器/WASM 浏览器 | WebSocket/HTTP | 流式 ASR（Zipformer/Paraformer/SenseVoice）+ VAD，中英最佳 |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | ✅ | 本地/服务器 | HTTP(OpenAI 风格) | whisper 的 C++ 移植，含 server/stream |
| [Silero VAD](https://github.com/snakers4/silero-vad) | ✅ | 任意（含浏览器 ONNX） | — | 事实标准的 VAD 模型 |
| [web-vad](https://github.com/jptaylor/web-vad)（ricky0123/vad 衍生） | ✅ | **浏览器** AudioWorklet | — | 浏览器内跑 Silero VAD（Pipecat 客户端在用） |

### 1.2 关键机制拆解（VAD/轮转、打断、流式 STT、流式 TTS、延迟）

**LiveKit Agents**（推荐重点学习）— AgentSession 是大脑，默认自带 Silero VAD + [Turn Detector 模型](https://docs.livekit.io/agents/logic/turns.md)：
- (a) **轮转**：5 种模式——turn detector 模型（默认，VAD 之上再按语义/声学判"话已说完"）、realtime 模型自带检测、纯 VAD、STT endpointing（AssemblyAI/Deepgram Flux）、手动 push-to-talk。endpointing 延迟 `min_delay=0.5s / max_delay=3.0s`，可动态自适应。
- (b) **打断**：两种模式——`vad`（检测到人声即停，需 `min_duration≈0.5s`、`min_words`）与 `adaptive`（[自适应打断模型](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling.md)：用声学特征区分**真打断 vs 附和声**"uh-huh/okay"，需 STT 支持词级对齐时间戳；`backchannel_boundary=(1.0,1.0)` 是回合首尾的冷却窗口，防止把开场 1 秒内的纠正误判为附和；误判后 `false_interruption_timeout=2.0s` 可恢复被中断的话）。
- (c) **流式 STT**：插件化（Deepgram/AssemblyAI/Google STT v2/Silero 等），流式 interim 结果。
- (d) **流式 TTS**：插件化；关键技巧是 **preemptive generation**（默认开启：最终稿一到就开始 LLM 生成，甚至 `preemptive_tts` 提前合成，代价是打断时浪费算力）。
- (e) **延迟**：官方建议端到端"听完即答"，从 [turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning.md) 的参数默认值可反推预算：VAD 后 0.5s 静默即收尾 + 流式 STT 首字 ≈ 数百 ms + LLM 首 token + TTS 首包，业界目标 500ms–1s 内开口。
- **浏览器侧**：LiveKit JS SDK 用 `getUserMedia` 采麦克风、Opus 编码经 WebRTC 上行；agent 音频下行用 `<audio>`/`AudioContext` 播放；**VAD/STT/LLM/TTS 全在服务端**。React 前端模板：[livekit-examples/agent-starter-react](https://github.com/livekit-examples/agent-starter-react)（Next.js + Agents UI，含连接控制/波形/字幕）。

**Pipecat**：
- 一切是 pipeline 里的 processor + Frame。VAD 用 `SileroVADAnalyzer`，轮转由 [Speech Input & Turn Detection](https://docs.pipecat.ai/pipecat/learn/speech-input.md) 的"user turn start/stop strategy"决定。
- (b) **打断机制最值得抄**：[Interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions.md)——VAD 检测到用户开口且 `enable_interruptions=True` 时广播一个 `InterruptionFrame`（SystemFrame，**不排队、立即处理**）：每个 processor 取消当前任务、丢弃排队帧；LLM 中断生成（`cancel_on_interruption` 的函数调用发取消帧）；TTS 清空文本聚合与词级时间戳；传输层**冲刷未播放的音频队列**——"bot goes silent within roughly one audio write"（约一个音频写周期内静音）。
- (c) STT 服务支持流式 interim（Deepgram/AssemblyAI/Cartesia/Speechmatics/Google V2）；(d) TTS 有 `InterruptibleTTSService` 基类，Neuphonic/Deepdub/Rime/LMNT/Cartesia 均继承它实现 WebSocket 流式+打断。
- (e) 有专门的 [STT Latency Tuning](https://docs.pipecat.ai/pipecat/fundamentals/stt-latency-tuning.md) 页；中文社区文称其可做到 ~500ms 级端到端。传输支持 WebSocket（FastAPI）与 WebRTC（Daily/LiveKit/SmallWebRTC）。

**Vocode**（电话/客服场景成熟）：
- `StreamingConversation` 内三个 worker：`TranscriptionsWorker` / `AgentsWorker` / `SynthesizersWorker`。
- (a) endpointing 两种范式：**时间式**（静默 X 秒）与**标点式**（标点后静默 X 秒）；`DeepgramEndpointingConfig` 默认 `vad_threshold_ms=500, utterance_cutoff_ms=1000`。
- (b) `interrupt_sensitivity`：low（默认，忽略 "sure/uh-huh" 附和）vs high（任何词都算打断）——与 LiveKit adaptive 思路同源但更朴素。
- (e) `conversation_speed`/`speed_coefficient`：按用户语速（WPM）动态缩放应答等待时间，语速快则更快接话。

**Ultravox**（端到端语音模型，托管 API）：
- (a) **多级 VAD**：[官方文档](https://docs.ultravox.ai/noise/understanding-vad) 描述 32ms 帧的"激进传统 VAD"（低阈值捕人声）+ **神经 VAD**（按对话流/停顿模式判断是否说完）+ 降噪/回声消除。参数：`turnEndpointDelay` 默认 **0.384s**（12 帧）、`minimumTurnDuration=0s`、`minimumInterruptionDuration=0.09s`（打断最短时长）、`frameActivationThreshold=0.1`。
- 全部服务端，浏览器只推音频流。思想价值：**VAD 分层**（粗检+语义判完）与**打断最短时长门槛**（防误触）可直接借鉴。

**Sesame CSM-1B**：开源对话语音生成模型（文本+音频→音频，~1B 参数，需 GPU/MLX）。只解决"像人一样说话"这一环，STT/LLM/调度都要自拼；价值在于"高自然度合成"的模型侧参考，不适合作为 DSH 主路径（DSH 已有 MiniMax TTS）。

**Moonshine**：端侧 STT（Python/JS-WASM/iOS/Android），模型从 tiny 1MB 到超越 Whisper Large V3 的旗舰；核心卖点"**在用户说话时就开始工作**"（流式预计算），隐私好、无密钥。适合 DSH 的本地离线兜底 STT。

**sherpa-onnx**（中英流式 ASR 首选）：
- 流式模型：Zipformer（中英双语，14M 起）、Paraformer、**SenseVoice**（阿里面向中文/粤/日/韩，VAD+ASR 一体）、Moonshine；全部 ONNX，可在 C++/Python/JS。
- 提供 WebSocket 流式 server（官方 C++ 示例 + 社区 Go 版 [stt-server](https://github.com/mawwalker/stt-server)），且有一批**浏览器 WASM 实时演示**（Hugging Face spaces：[中英 Zipformer 流式](https://huggingface.co/spaces/k2-fsa/web-assembly-asr-sherpa-onnx-zh-en)、[SenseVoice VAD+ASR](https://huggingface.co/spaces/k2-fsa/web-assembly-asr-sherpa-onnx-zh-en-ko-ja-yue-sense-voice)）——即"流式 ASR 可以整体跑在浏览器里"的现成证明。

**whisper.cpp**：`whisper-server`（OpenAI 风格 HTTP 转写）、`whisper-stream`（`--step 500 --length 5000`：每 0.5s 采样、5s 滑动窗口连续转写）、`stream.wasm`（浏览器实时转写）。适合 DSH 主机侧作为 STT 后端。

**Silero VAD / WebRTC VAD**：Silero 是 ONNX 小模型（16kHz、30ms 窗口），在浏览器里用 `onnxruntime-web` 跑在 AudioWorklet 中——即 [web-vad](https://github.com/jptaylor/web-vad) / [ricky0123/vad](https://github.com/ricky0123/vad)（Pipecat 客户端用它做**客户端 VAD**）。这是"**VAD 放浏览器**"的参考实现。

**流式 TTS**：要点是**句子级流式 + 边播边合成**（下一句后台预合成）：[RealtimeTTS](https://www.blog.brightcoding.dev/2025/09/10/realtimetts-the-open-source-powerhouse-for-instant-low-latency-text-to-speech)（OpenAI/ElevenLabs/Piper/Kokoro 等 12 引擎，句子流式+chunk 播放+后台预合成+引擎失败回退链）；本地可跑 [Kokoro](https://github.com/neosun100/kokoro-tts/blob/main/docs/STREAMING_OPTIMIZATION.md)。云端流式 TTS 首包（TTF）行业量级：WebSocket 流式 API 普遍 100–300ms（如 Cartesia/OpenAI Realtime 系）。

### 1.3 浏览器侧 vs 服务端分工（对 DSH 最关键的一张图）

- **麦克风采集**：浏览器 `getUserMedia`（必选）。
- **编码上行**：WebRTC（Opus，帧级低延迟）> MediaRecorder（webm/opus，按 timeslice 出块）> AudioWorklet 裸 PCM（16kHz 单声道，最省，直喂 VAD/STT）。
- **VAD**：可浏览器（web-vad/Silero WASM，响应最快，打断延迟最低）可服务端（LiveKit 默认）。
- **STT**：服务端（faster-whisper/whisper.cpp/sherpa-onnx ws）或浏览器（transformers.js / sherpa-onnx WASM）。
- **LLM 与轮转逻辑**：服务端（DSH 主进程）。
- **TTS 合成**：服务端（MiniMax T2A WS），**播放**在浏览器（append 音频块到 `<audio>` 或用 AudioContext 写 PCM buffer）。
- **打断执行**：浏览器立刻停播（清空播放 buffer），同时通知服务端取消在途生成（Pipecat 的 InterruptionFrame 思路）。

### 1.4 纯浏览器演示（无需自建服务）

- [xenova/whisper-web](https://github.com/xenova/whisper-web)：transformers.js 把 whisper tiny/base 跑在浏览器，`getUserMedia` 录音→转写（有 WebGPU 分支提速）。
- sherpa-onnx 的 HF spaces：上述中英流式 ASR / VAD+SenseVoice 演示。
- LiveKit [agent-starter-react](https://github.com/livekit-examples/agent-starter-react)：完整"网页内与 agent 打电话"UI 模板（前端 React + 服务端 agent）。

### 1.5 "网页里跟 LLM 打电话"最接近的项目 & 对 DSH 的启示

最接近的完整开源组合：**LiveKit Agents（服务端会话/轮转/打断）+ agent-starter-react（浏览器端）**；其次是 **Pipecat（WebSocket 传输 + 客户端 web-vad）**，它不强制 WebRTC 基建，更贴合 DSH（主机侧 Node 进程即可当 agent，浏览器经 WebSocket 直连）。

**可直接抄的三件事**：① LiveKit 的"VAD 检测 + 打断最小时长(0.5s) + 真打断/附和判别 + 误判恢复(2s)"参数体系；② Pipecat 的打断帧语义（取消 LLM 在途生成、清 TTS 缓冲、冲刷未播音频，一个音频写周期内静音）；③ LiveKit 的 preemptive generation（最终稿一到就开始生成，TTS 可提前）。

---

## 2. 语音输入（录音→STT→文本进输入框）

**录音**：[MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) + webm/opus 是默认路径；`timeslice` 参数可分块。注意：whisper 系 STT 需要 16kHz 单声道 PCM——要么用 `AudioContext.decodeAudioData` 解码 webm，要么**用 AudioWorklet 直接抓裸 PCM**（省去编解码，<15s 片段更省时）。录制结束→一次上传→STT→把文本插入聊天输入框（插件客户端可直接写 composer 输入）。

**STT 选项与延迟**（针对 <15s 小文件）：

| 方案 | 位置 | 典型延迟 | 备注 |
|---|---|---|---|
| [faster-whisper](https://pypi.org/project/faster-whisper/)（CTranslate2） | 主机 | 15s 音频 CPU int8 ≈ **1.5–2.5s**（16s 实测：100ms 块 2.35s / 300ms 块 1.89s / 500ms 块 1.65s，[来源](https://theneuralbase.com/faster-whisper/learn/advanced/streaming-chunk-size-vs-latency/)）；GPU 快 10 倍级 | 流式时**块不要小于 250–300ms**，否则推理开销反超 |
| [whisper.cpp server](https://github.com/ggml-org/whisper.cpp) | 主机 | 同量级，CPU 友好 | OpenAI 兼容 API，好接 |
| [transformers.js](https://github.com/xenova/whisper-web)（浏览器内） | 浏览器 | tiny/base 数秒级（CPU），WebGPU 显著提速 | 隐私最好，首次要下载模型 |
| [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) | 浏览器→Google 服务 | 实时流式 | **局限**：服务端识别、依赖网络、Chrome 系为主、grammar 已移除、不可控模型/隐私。**不建议作为主路径**，可作降级兜底 |
| sherpa-onnx 流式 | 主机/浏览器 | 块级流式，数百 ms 级首字 | 中英流式首选（见 §1） |

**中英自动检测**：whisper 系列默认自动检测（faster-whisper `language=None` 逐窗口检测；whisper.cpp `-l auto`），zh/en 短句在小模型上偶有误判——对策：① UI 提供"自动/中文/英文"三档强制；② 中文优先场景用 **SenseVoice**（sherpa-onnx 内，zh/en/yue/ja/ko）；③ 混合中英用 medium+ 或分段检测。**先 VAD 切句再 STT** 可显著降成本与延迟（sherpa-onnx 的 VAD+ASR 示例即此模式）。

**延迟预算**：按录音 N 秒 + STT 1.5–3s + 上传/解码 ≈ 用户松键后 2–4s 内出字属正常；WebSocket 流式可把首字提前到数百 ms。

---

## 3. 无障碍 / 视觉转语音（视障用户操作 AI agent）

**Be My Eyes / Be My AI**：[Be My AI](https://www.bemyeyes.com/business/news/introducing-be-my-ai-formerly-virtual-volunteer-for-people-who-are-blind-or-have-low-vision-powered-by-openais-gpt-4/)（2023，OpenAI GPT-4V，现 GPT-4o）让盲人用户**举着手机摄像头对准物体/场景提问，AI 用自然语言详细描述**；志愿者热线保留给复杂情形（人机协作兜底）。UX 原则：用户主动发起（拍照/录像流）+ 开放式提问 + 详细但分层的回答。

**Seeing AI vs Google Lookout**（[对比分析](https://houstonlighthouse.org/news-insights/seeing-ai-vs-lookout-what-actually-matters-in-apps/)）：
- **Seeing AI**（微软，iOS/Android）：**结构化通道模式**——Short Text / Document / Product / Person / Currency / Scene 各司其职，适合"明确任务 + 叙述"（读信、识别商品、辨认钞票）。
- **Lookout**（Google，Android 优先）：**连续实时反馈**——Explore / Shopping / Quick Read 模式，边走边报环境，弱化模式切换。
- 共同点：**把视觉信息翻译成可听信息**（描述/朗读/识别），且都强调"先告诉用户这是什么，再给细节"。

**屏幕阅读器 UX 惯例（TalkBack / VoiceOver）**：焦点按 DOM 顺序移动并朗读"类型+状态"；实时变化用 live region 播报；操作靠手势（双击激活、左右滑动切焦点）。对 DSH 的启示：
- **渐进披露**：先一句总述（"页面上方是设置区，中间是对话列表"），用户要细节再展开（对应 [ARIA Disclosure 模式](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)：`aria-expanded` / `aria-controls`，Enter/Space 切换）。
- **避免纯视觉信息**：WCAG [1.4.1 颜色](https://www.w3.org/WAI/WCAG22/)——状态不能只靠颜色/图标/布局表达，必须附文字或语音；每个图标给可读名（`aria-label`/`name,role,value`，4.1.2）。
- **破坏性操作先确认**：WCAG 3.3.4 错误预防（法律/财务/数据类操作要可逆、可确认）——"删除/发送/付费"前语音确认。
- **稳定的叙述顺序**：按固定、可预期的顺序播报（DOM/逻辑序），不随视觉布局跳变；字幕/转写同步可选。
- 大按钮、可调语速、可中断（"停/重读"）是视障用户的硬需求。

**截图→VLM→TTS 流水线**（DSH 无障碍模式 = 截屏 → VLM 描述 → MiniMax TTS 播报）：
- **开源 VLM 截图理解**：[PaliGemma screen2words](https://huggingface.co/google/paligemma-3b-ft-screen2words-448)（Google，UI 屏幕摘要微调，3B）、Pix2Struct widget captioning；生产级可换任意云 VLM（DSH 已有 `guide_dog_vision/inspect` 走 MiniMax VLM，直接复用）。
- **浏览器截图方案对比**：

| 方案 | 保真 | 适用/限制 |
|---|---|---|
| [html2canvas](https://github.com/niklasvh/html2canvas) | 低（重绘 DOM） | 跨域资源会被 canvas 污染，需代理；复杂 CSS/WebGL 丢失；**无需权限，页面内可用** |
| [dom-to-image](https://github.com/tsayen/dom-to-image) | 中（SVG foreignObject） | 同上有跨域与样式限制 |
| CDP [Page.captureScreenshot](https://developer.chrome.com/docs/devtools/protocol/) | **高（像素级）** | 需 DevTools 协议（Puppeteer/Playwright 或带 remote-debugging 的浏览器）；支持 full-page |
| [getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) | 高（真实屏幕） | 用户需手动选窗口/屏幕并授权；随后 drawImage→toDataURL |
| [chrome.tabs.captureVisibleTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab) | 高 | 仅扩展内可用（`activeTab`/`<all_urls>`），只截可见区 |

  对 DSH：页面内插件用 **html2canvas/dom-to-image** 零权限可行（够 VLM 看懂布局与文本）；要像素级/整页/含 WebGL 时，由主机侧拉起 **Puppeteer/Playwright CDP** 截图；真实屏幕内容用 `getDisplayMedia`（需用户确认）。
- **播报**：MiniMax TTS（已有 `guide_dog_speak`）＋ 可中断/可重读控件。

---

## 4. MiniMax 音频 API 现状（2026-08 核实自官方文档）

**官方文档索引**：[platform.minimax.io/docs/llms.txt](https://platform.minimax.io/docs/llms.txt)（全文 22KB，grep `asr/transcri/realtime` **0 命中**）。结论先行：**官方只提供 TTS（含流式）与音色管理，没有公开 ASR/STT 端点，也没有 realtime speech-to-speech API。**

- **流式 TTS（WebSocket，可用）**：`wss://api.minimax.io/ws/v1/t2a_v2`（[指南](https://platform.minimax.io/docs/guides/speech-t2a-websocket) / [API 参考](https://platform.minimax.io/docs/api-reference/speech-t2a-websocket.md)）。事件协议：`task_start`（带 model/voice_setting/audio_setting，默认 32kHz）→ `task_continue`（发文本）→ 服务端流式回 `data.audio`（hex 音频块）与 `is_final` → `task_finish`。单次 ≤10,000 字；示例用 mpv 边收边播——**这就是 DSH CALL 模式的现成流式 TTS 通道**。
- **TTS（HTTP 同步）**：`POST https://api.minimax.io/v1/t2a_v2`（美西另址 `api-uw.minimax.io`，[参考](https://platform.minimax.io/docs/api-reference/speech-t2a-http.md)），一次性返回音频。
- **长文本异步 TTS**：Async T2A（≤1M 字，任务式）。另有 Voice Clone / Voice Design / Voice 列表端点。
- **模型名**：最新 `speech-2.8-hd/turbo`、`speech-2.6-hd/turbo`、`speech-02-hd/turbo`；MCP 仓库还列出旧名 `speech-01-hd/turbo`、`speech-01-240228`、`speech-01-turbo-240228`（[MiniMax-MCP-JS](https://github.com/MiniMax-AI/MiniMax-MCP-JS)）。**不存在公开的 `asr-01` 模型**。
- **mmx CLI 现状**（npm `mmx-cli@1.0.19`）：命令覆盖 text/image/video/speech/music/vision/search/auth；`mmx speech synthesize --stream` 走流式；**无任何 transcribe/ASR 子命令**——即 mmx 只包了 TTS 侧。
- **ASR 佐证**：MiniMax 官方[同声传译示例](https://github.com/mm-demo-collection/minimax_simultaneous_interpretation)的"语音识别"用的是 **Whisper**（前端 WebSocket + FastAPI + Whisper + VAD），并非 MiniMax ASR API；第三方文章称 MiniMax Speech 2.5 模型家族含 ASR/语音转语音，但**官方文档没有对应端点**，不可依赖。

**对 DSH 的含义**：STT 必须外接（faster-whisper / whisper.cpp / sherpa-onnx 本地，或浏览器 transformers.js）；TTS 流式可完全依赖 MiniMax T2A WS。

---

## 5. 落地建议（四个功能各 2–4 条）

**① 语音模式加固**：a) 播放与生成串行化，新回合先停旧播放（已有 latest-only 语义，保持）；b) 引入**播放中断**：用户新语音输入或新回合到达时，浏览器立刻 `pause`/清缓冲，主机取消在途 `mmx speech` 进程；c) 支持语速/音量/跳过按钮（无障碍也需要）；d) 失败降级：TTS 出错时回退纯文本并语音播报"抱歉，语音不可用"。

**② 语音输入（录音→STT→输入框）**：a) `getUserMedia` + MediaRecorder(webm/opus) 录 ≤15s，上传主机；b) 主机跑 **faster-whisper**（small，`language=auto`，中文优先可 SenseVoice），~1.5–3s 出稿；c) 结果直接写入聊天输入框（客户端注入 composer）；d) UI 三档语言（自动/中/英）+ 录音波形 + 可取消；Web Speech API 仅作无本地模型时的降级。

**③ 全双工 CALL 模式**：a) 浏览器 AudioWorklet 采集 16kHz PCM + **web-vad（Silero WASM）做客户端 VAD**（打断延迟最低）；b) WebSocket 直连主机：语音块→主机 sherpa-onnx/faster-whisper 流式 STT；c) **打断协议照抄 Pipecat**：VAD 触发→浏览器停播+清缓冲→发打断消息→主机取消 LLM 在途与 TTS 缓冲；加"打断最短时长 0.3–0.5s + 静默 0.5s 收尾"参数；d) 应答 TTS 走 MiniMax `wss://api.minimax.io/ws/v1/t2a_v2` 流式合成、浏览器边收边播（AudioContext 写 buffer），首包目标 <500ms；e) 回合间"预生成"（用户话毕即开始 LLM）。

**④ 无障碍模式（截图→VLM→TTS）**：a) 渐进披露：先 1–2 句总述页面/截图，再按需"详细"（ARIA disclosure 语义）；b) 复用 `guide_dog_inspect`（MiniMax VLM）做截图理解，`guide_dog_speak` 播报，加"重读/停止/慢速"；c) 截图默认页面内 html2canvas（零权限），需要像素级/整页时主机走 CDP；d) 遵循 WCAG：破坏性操作前语音确认、状态不只靠颜色、稳定叙述顺序（总述→要点→细节→操作提示）。

---

## 6. 关键参考资料

- LiveKit：<https://docs.livekit.io/agents/logic/turns.md> · <https://docs.livekit.io/agents/logic/turns/tuning.md> · <https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling.md> · <https://docs.livekit.io/frontends/start/starter-apps/react.md> · <https://github.com/livekit-examples/agent-starter-react>
- Pipecat：<https://github.com/pipecat-ai/pipecat> · <https://docs.pipecat.ai/pipecat/fundamentals/interruptions.md> · <https://docs.pipecat.ai/pipecat/learn/speech-input.md> · <https://docs.pipecat.ai/pipecat/fundamentals/stt-latency-tuning.md>
- Vocode：<https://docs.vocode.dev/open-source/conversation-mechanics> · <https://deepwiki.com/vocodedev/vocode-core/1.1-architecture>
- Ultravox：<https://docs.ultravox.ai/noise/understanding-vad> · Sesame CSM-1B：<https://huggingface.co/sesame/csm-1b>
- Moonshine：<https://github.com/moonshine-ai/moonshine> · sherpa-onnx：<https://github.com/k2-fsa/sherpa-onnx> · whisper.cpp：<https://github.com/ggml-org/whisper.cpp>
- VAD：<https://github.com/snakers4/silero-vad> · <https://github.com/jptaylor/web-vad> · <https://github.com/ricky0123/vad>
- 浏览器 STT 演示：<https://github.com/xenova/whisper-web> · <https://huggingface.co/spaces/k2-fsa/web-assembly-asr-sherpa-onnx-zh-en>
- 流式 TTS：<https://www.blog.brightcoding.dev/2025/09/10/realtimetts-the-open-source-powerhouse-for-instant-low-latency-text-to-speech> · OpenAI Realtime VAD：<https://developers.openai.com/api/docs/guides/realtime-vad>
- faster-whisper 延迟：<https://theneuralbase.com/faster-whisper/learn/advanced/streaming-chunk-size-vs-latency/> · <https://pypi.org/project/faster-whisper/>
- Web 录音：<https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder> · Web Speech：<https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition>
- 无障碍：<https://www.bemyeyes.com/business/news/introducing-be-my-ai-formerly-virtual-volunteer-for-people-who-are-blind-or-have-low-vision-powered-by-openais-gpt-4/> · <https://houstonlighthouse.org/news-insights/seeing-ai-vs-lookout-what-actually-matters-in-apps/> · <https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/> · <https://www.w3.org/WAI/WCAG22/> · <https://huggingface.co/google/paligemma-3b-ft-screen2words-448>
- 截图：<https://github.com/niklasvh/html2canvas> · <https://github.com/tsayen/dom-to-image> · <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia> · <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab>
- MiniMax：<https://platform.minimax.io/docs/llms.txt> · <https://platform.minimax.io/docs/guides/speech-t2a-websocket> · <https://platform.minimax.io/docs/api-reference/speech-t2a-websocket.md> · <https://platform.minimax.io/docs/api-reference/speech-t2a-http.md> · <https://github.com/MiniMax-AI/MiniMax-MCP-JS> · <https://github.com/mm-demo-collection/minimax_simultaneous_interpretation> · <https://www.npmjs.com/package/mmx-cli>
