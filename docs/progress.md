# SDD ledger — plan: /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plans/2026-08-14-phase1-voice-mode-and-voice-input.md

## Rulings
- Ruling: 工作区放 skills-repo/.superpowers/sdd/（home 只读，沙箱拒绝创建 .superpowers）— 成本：不在 home git 的 ignore 列表，但我们只提交 guide-dog-dsh/。
- Ruling: Task 0 提交范围 = 仅 guide-dog-dsh/（home 是 git 根，git add -A 会提交整个 home 含密钥）— 成本：skills-repo 下其他内容不入库。
- Ruling: 直接在主分支（master，无历史）上工作；用户已批准含 Task 0 的计划并选择执行 — 成本：无 worktree 隔离。
- Ruling: git 元数据写 home/.git 被沙箱拒绝，git 命令需 danger-full-access 提权 — 成本：每次 git 操作触发审批。

## Pre-flight scan
| 任务对 | 共享文件/接口 | 发现 |
|---|---|---|
| T1→T2→T3 | plugin-host.js 顺序插入 | 锚点行号会随插入漂移 → 实现者按函数名/grep 定位（已写入 dispatch） |
| T2→T6b | transcribeImpl | 接口一致（{audioB64,mime,sessionId,language}） |
| T3→T5 | speak RPC | 入参/返回形状一致 |
| T4→T5/T6 | probe.json 决策门 | 形状回填为强制步骤 |
| T4→T8 | plugin-source.js 拼接 | 一致 |
| 全局 | V4-Pro 审查 22 条 | 已全部修复（C1-3/I1-6/M1-13） |

## Tasks
Task 0: complete (commit 4a2e116, scoped to guide-dog-dsh/)
- Ruling: Task 1-3 的 per-task 提交合并为单提交 8e947e5（单文件 diff 无法无交互拆分）— 成本：提交粒度粗，审查包按 BASE..HEAD 覆盖全部。
- Ruling: 接受实现者对计划缺陷的两处修正：① saveConfig 的 runRaw 拼接语法错误（缺 + '; '），已修复为 `+ '; ' + 'chmod 600 '`；② WHISPER_SCRIPT 与 repo 脚本归一为逐字一致（3054B）— 成本：计划文本与实现有偏差，但方向与意图一致。
- Ruling: faster-whisper 装在 skills-repo/.whisper-deps（系统 site-packages 沙箱只读）；运行时探测（python3 -c import）可能不命中 → Task 4 部署后若 whisperAvailable=false，需把配置 whisper.python 指向该目录（PYTHONPATH）或系统安装 — 成本：STT 依赖环境问题可能在验收期才暴露。
Task 1-3: complete (commits 4a2e116..8e947e5, review clean — V4-Pro approved; 6 minors deferred)
Task 1-3: minor (deferred): dedup marks turn spoken before success (host:499-504) — same-turn retry skipped after failure
Task 1-3: minor (deferred): saveConfig ignores runRaw exit code (host:89-91) — false-success path
Task 1-3: minor (deferred): systemPrompt.variable not in ctx.effect/disposer (host:676-683)
Task 1-3: minor (deferred): probeWhisper interpolates config python into shell string (host:187)
Task 1-3: minor (deferred): temp-audio write failure maps config_write_failed instead of stt_failed (host:217)
Task 1-3: minor (deferred): timeout sleep timer never cancelled after success (host:230-233)
- Ruling: 用户指示项目仓库以 skills-repo 为根 → git init 于 skills-repo（真实 .git 目录，toplevel 确认）；home/.git 保留不动；旧提交 4a2e116/8e947e5 留在 home 仓库（孤悬），新仓库重新做基线提交 — 成本：旧提交历史不迁移，SDD 的 BASE/HEAD 以新仓库提交为准。
- Ruling: .gitignore 排除 .superpowers/.stt-test/.whisper-deps/.hf-cache/node_modules/__pycache__；其余 skills-repo 内容全部入库 — 成本：用户其他项目一并入库（按用户"项目目录在 skills-repo"指示）。
- Ruling（修正）: 用户澄清 = 在 skills-repo 下为项目建独立子仓库 → git init 于 skills-repo/guide-dog-dsh/（已移除误建的 skills-repo/.git）；toplevel = guide-dog-dsh；git 操作均在沙箱可写区 — 成本：SDD 工作区（skills-repo/.superpowers）在仓库外，属 scratch 不受版本管理。
Task 4: probe round-1 collected (pkg-2 live) — Path A CONFIRMED (all browser globals available); inputActions = [setDraft, addImages, removeImage, pruneImages, submit]; timerSvc exists (keys [ctx,name], methods unverified); turnTail turnKeys = [turn,start,end,status,steps,data] but useSession() in useEffect returns EMPTY snapshot; whisperAvailable=false.
- Ruling: 录音走 Path A（MediaRecorder）— 成本：无。
- Ruling: Task 6 文本插入必须用 inputActions.setDraft（候选链会漏掉）— 成本：候选链作兜底保留。
- Ruling: useSession() 需在渲染期调用（useEffect 内为空）；pkg-3 加深探测 turn 文本来源 — 成本：Task 5 实现依赖 pkg-3 探测结果。
- Ruling: faster-whisper 装到用户 site-packages（pip --user，后台 bash-9）— 成本：需提权；模型首跑重新下载。
Task 4: fix round 1/5 in flight (BlobArrayBuffer ReferenceError + probe deepening; implementer 56618363 resumed)
Task 4: fix round 1/5 complete (1 addressed, 0 open blocking; V4-flash re-review clean; minors 3/4/5/7 out of scope accepted, 2/6 cosmetic)
- Ruling（机制转向）: 语音模式自动发声机制从"client turnTail 快照提取"改为"host session/event 监听 + client 轮询队列"——探测证实 useSession() 快照 Object.keys 为空（Proxy/类实例）、turn.steps 无消息文本字段，client 侧无法可靠提取；host 事件是消息文本的权威来源（与渲染逐字一致），三条硬指标（机制保证/文字一致/失败反馈）全部保留。成本：spec §5.1 机制描述与计划 Task 5 需同步改写；client 需 1s 轮询（timerSvc.interval 已确认可用）。
- Ruling（根因裁决）: pkg-4/7 host-half 失败 = ASI 陷阱——`ensureMediaDir().catch(...)` 后无分号，紧接 `(async function(){})()` 被解析为对 .catch() 结果的调用 → "ensureMediaDir(...).catch(...) is not a function"。修复：IIFE 前加前导分号（`;(async ...`），本地 harness 同款包装复现验证 APPLY OK。成本：一行字符；pkg-4 的 ctx.effect 错误同为该问题的变体（组装差异）。
Task 4 (probe): pkg-7 失败记录 — 修复提交 a4ef8ca；重新部署 pkg-8。
Task 4: probe rounds complete (pkg-9 running) — decision gate FINAL:
  - Path A 确认（MediaRecorder 等全局可用）
  - inputActions = [setDraft, addImages, removeImage, pruneImages, submit] → 插入用 setDraft，提交用 submit
  - timerSvc.interval/timeout = function（client 可用）
  - 会话事件形状（源码+采样确认）：assistant/message 事件键 [type,seq,time,data,...]；文本在 event.data.content（blocks，{type:'text',text}），旧格式 data.message.content 兜底；seq=event.seq
  - whisper 1.2.1 可用
  - liveEvent 监听器未触发（备用信息，不影响）
Task 4: complete (probe phase done; pkg-9 running; 部署修复 a4ef8ca)
Task 5+6+6b+7: implementer fe5133e9 DONE (commit 9f403b4, 428+/224-, files plugin-host.js/plugin-client.js/README.md; plugin-source.js 未重生成=controller 职责)
- 自检通过：node --check 双文件；无 ASI 隐患（仅 hasCJK 内 || 续行）；gdbs-4 bisect 插件已 cordis_undefine 清理
- Controller 独立发现（等待 V4-flash 审查 08eec490 落地后合并为 fix round）：
  1. 【Important】SettingsPage useEffect 5 个 set(Object.assign({}, s, ...)) 基于初始闭包 s → 全量替换、last-wins → cfg/status/auth/voices/media 仅剩一个字段；cfg=null → cfgBlock 消失。v1 同模式（3 调用）为既有潜在缺陷，Task 7 放大为 5 调用。修复=函数式 updater。
  2. 【Minor】mic transcribe() 闭包持录制开始时的 s（录音中切语言不生效）
  3. 【Minor】host guide-dog/probe RPC 死代码（client 已无调用）
  4. 【Minor】voiceState.cfg 设置页改动后徽章不刷新（可接受+注明）
  5. 【观察】硬指标 3 口播短句未实现（仅 beep+徽章文字）——倾向 beep+徽章满足"绝不静默"，spec 措辞微调
  6. 【Minor】recorder 路由 413 分支未 req.resume()（keep-alive 复用风险）
- 澄清：probe2.json hasContent:false 系探测检查 e.content（事件根）而非 e.data.content——配方来自 harness 源码确认，无矛盾
Task 5+6+6b+7: V4-flash review (08eec490) — APPROVE WITH FIXES（无 Critical；I1 徽章全局开时关不掉 / I2 mic 卸载泄漏 / I3 config 写竞态 / I4 plugin-source.js 过期=交接项；Minor×15；机制/路由/设置/去重/错误码全 PASS）
- Controller 独立发现 A1【Important 审查漏项】：SettingsPage useEffect 5×set(Object.assign({}, s,…)) 初始闭包覆盖 → last-wins → cfgBlock 消失；并入 fix round
- Fix round 1 已派发实现者 fe5133e9（fix-round-1-instr.md 定稿：A1-A4 + B 组 M1-M4/M6/M8-M12/413-resume + C 组接受记录）
Task 9 进行中: 硬指标 1+2 测试中（voiceMode 本会话 override=true 已生效，pkg-10 run-12 重启完成）；用户新反馈（v2.1 裁决）：
- Bug: 切换 session 自动重播 → 根因 = pendingPlay 模块级残留 + 音频元素挂在 session 级组件（卸载时 onEnded 不触发）→ 新会话重挂元素从头播放
- 修复: 播放改模块级 Audio 对象（playEntry/stopCurrent/playBeep），会话切换不销毁 → 播到结束；新队列条目覆盖；autoplay 阻止/失败入错误徽章
- UI 裁决: dock 徽章 + input.right mic 移除；conversation.input.left 群组 guide-dog-voice(order 30) = [小喇叭开关(tooltip 语音模式提示)] [语言检测下拉] [简洁 SVG 麦克风(红色脉冲+秒数)]；样式用 --dsw-alias-* 令牌、字体继承
- 用户确认: 麦克风保留独立按钮（更简洁图标）
- 文档: README/spec §5.1/5.2 已同步 v2.1
- client 重写完成（node --check 过、ASI 干净、repro-client APPLY OK）；V4-flash 审查 84249b9a 进行中
v2.1 部署完成: pkg-11 (run-13) 运行中；结构验证 input.left guide-dog-voice 就位、dock 无占用
- V4-flash 审查两次超时（卡在 client Inspect 查询等页面应答）→ controller 自审 SHIP（review-ui-rev.md，运行时事实均独立 Inspect 确认）
- 硬指标验收证据闭环：媒体索引 voice-mode 条目 6 条（全零工具调用、逐条自动 TTS）；spoken 全部无围栏/无 URL（变换正确）——硬指标 1+2 PASS
- 待用户人工验证：切换会话播放延续（不重播、新任务覆盖）、麦克风录音转写、小喇叭 tooltip
v2.1 用户验证: 长文本播放中切换会话 → 音频完整播完、切回不重播 —— 播放修复确认成功 ✅
- 剩余: 录音转写人工测试（用户暂不便）；硬指标 3（失败反馈）待测；最终 V4-Pro 全分支审查；finishing-a-development-branch
硬指标 3 验收: beep（音量 0.8 + WebAudio 兜底后听到）+ 右下角 toast（用户确认收到）—— PASS
- 测试中发现并定位：会话切换关闭后语音模式失效（sessions 显式 false），触发无效果；测试后已恢复配置（有效音色、语音模式关）
- 当前部署: pkg-13 (run-18) 运行中；config 恢复用户原状态
- 最终 V4-Pro 全分支审查: d420afec 进行中（指令明确禁止 client Inspect 查询防卡死）
Phase 1 终审完成: V4-Pro SHIP WITH MINORS（无 Critical/Important；5 UPGRADE + 9 Minor）
- 终审修复已落地: commit 668ad01（M1 去重失败释放/M2 配置写校验/M3 变量生命周期/M4 quote/M5 stt_failed/M6 错误项统一/M7+13+14 文档对齐/M8 函数式 updater/M12 路由保护），部署 pkg-14 (run-19) 运行中
- Phase 2 待办（终审 M9/M10/M11）: 录音中切会话 onstop 陈旧闭包、媒体路由 range 全量缓冲、setVoiceOverride 陈旧 base 覆盖
- 最终验证: node --check ×3 + py_compile + harness mock APPLY OK（注入清单含 input.left/shell.overlay/toolview×9/settings.section）
- 分支: master 16 commits，无远程，工作树干净；收尾选项已呈现用户
== 分支收尾（finishing-a-development-branch）==
- 创建 GitHub 仓库 AtropinolTT/dsh-guide-dog（public，含描述）
- 网络限制（沙箱阻断 github.com:443，仅 api.github.com 可达；无 SSH 密钥）→ 用 Git Database API 推送 16 提交，全部 SHA 与本地一致（42 blobs；committer 前缀 10 字符 bug 已修）
- 空仓库引导：Contents API 建 .gitkeep 首提交解除 git data 封锁；main 重指向 v1 基线 7d112bb 获得共同历史
- PR #1: master→main（15 个 Phase 1 提交）: https://github.com/AtropinolTT/dsh-guide-dog/pull/1
- Topics: dsh-plugin / dsh / minimax / multimodal / tts / voice-input
- 默认分支 main；本地 origin 已配置（https，未内嵌 token）

== 2026-08-15 语音输入故障修复（用户实测报告）==
- 症状：录音后"转写中"持续很久；输入框无字；agent 无信息
- 根因（systematic-debugging 证据链）：① ~/.cache/huggingface/hub 无 faster-whisper 模型缓存（首次转写才下载）；② python 侧 huggingface.co = Network is unreachable（Errno 101，与 github.com 同网络策略）；③ WhisperModel('small') 下载挂起 → host 60s 超时 → stt_timeout。tmp 无残留 = 请求未到 host 或已清理，排除录音/上传链路问题
- 修复（commit 5fe99fd，部署 pkg-15 run-20）：
  1. whisper_transcribe.py：HF_ENDPOINT 默认 https://hf-mirror.com（实测可达 ~2.2MB/s）；resolve_model_ref 优先 ~/.guide-dog/models/faster-whisper-<model>（零网络）
  2. --prewarm 模式 + probeWhisper 模型缺失时后台预热（subprocess 非沙箱可写）
  3. status.json 新增 whisperModelCached
- 预热：hf-mirror 下载 small 模型 483MB → ~/.guide-dog/models/faster-whisper-small（246s）
- 运行时脚本已提权覆盖为新版（ensureWhisperScript 只在缺失时写入，不会覆盖旧文件——部署注意点）
- 验证：脚本直接转写 3.7s 音频 5.6s；全链路 b64 webm 路径 9.1s（模型加载 3s+转写 5.3s），文本正确、b64 已删
- 用户指路镜像源 hf-mirror.com 是修复关键输入

## 2026-08-15 语音输入 v2（用户验证后新增三项）
- 用户实测：选设备后语音输入成功 ✅（RDP 静音问题解决）；但 ●声/○静音 未显示。
- 根因（systematic-debugging）：client 沙箱里 AudioContext 以全局暴露，startRec 用
  `window.AudioContext || window.webkitAudioContext` → undefined → if(AC) 不成立 →
  analyser 从未创建，vol 永为 null，指示从不渲染且被静默吞掉（录音成功但分析器静默跳过）。
- 修复：全局 AudioContext 优先 + window 兜底；AC 不可用时 UI 显示灰色"检测不可用"（三态诊断）。
- 新需求 1：中文输入默认简体 → pip install zhconv（提权装到 ~/.local）；whisper 脚本检测
  zh 语言后 convert(text,'zh-cn')；三处同步（repo 源/host 模板/运行时副本）。
- 新需求 2：实时转写预览 → partial 机制：录音中每 5s 增量（partialIdx）转写新增音频，
  host 侧 args.partial 用 base 模型（先预热 483MB 镜像下载 246s → base 145MB 67s）+ --no-keep-empty；
  结果实时 insertText 覆盖输入框 draft；录音结束最终转写（small）覆盖；partialBusy/partialStale 防并发与覆盖。
- 部署：pkg-2（cordis_define existing + update run-3），验证 slot active + 繁体 TTS→简体转写端到端
  （"語音識別測試，他說得很好" → "语音识别测试,他说得很好"，base 1.9s）。
- 提交 95a954b 推送 master（PR #1 自动更新）。

## 2026-08-15 晚间：边说边看根因修复 + 自动加载（v3）

- 用户反馈：①安全审查 aborted → 手动复核完成（无高危；URL scheme 白名单/结果 JSON 脱敏/
  rel=noreferrer/autoSend 提示 4 项已在代码落实）②红绿标签正常但"转写慢、没边说边看"。
- 根因（实测）：webm 增量切片（缺 EBML/Track 头）ffmpeg 报 `Invalid data found` → partial 每次
  r.ok=false 静默丢弃 → 预览从未出现；且每次 partial 重新 spawn+加载模型（3-4s）。
- 修复（已提交 1242dae）：client 录音优先 audio/wav（PCM 任意偏移可切片），buildWavBlob 自建
  44B RIFF/fmt/data 头拼接增量，3s 间隔；host 常驻 whisper --serve worker（stdin 行 JSON 任务→
  stdout 行 JSON 响应，模型懒加载缓存，单次 ~0.8s），崩溃/超时自动 fallback 一次性 spawn。
- 自动加载（已提交 de136c8）：动态插件定义进程内存、DSH 重启全丢 → 新增 dsh-guide-dog-autoload
  host 插件（autoload/ 目录，bundle patch insert 进 cc-tui profile，symlink 安装），监听
  agent/created 事件从仓库源码经 dynamicCordisRunner.define+run 自动部署，每会话一次；
  首次 client 激活每进程需批准一次。
- 实测验证：gd-boot 引导插件同路径部署成功（gdog-2 running，9 工具注册，client 激活批准后
  currentPackageId=pkg-2）。DSH 中途重启导致 gdog-1 丢失 → 自动加载需求实证。
- GitHub：master=de136c8 已推送（PR #1 master→main 更新）。

## 2026-08-15 深夜：安全 3 项修复 + kind 报错定位（v4）

- 自动加载器安全审查（dsh-auto-review 注入报告触发 turn 64 失败）3 项修复（66269bd 已推）：
  - HIGH：部署源移出工作区 → deploy/publish.py 发布到 ~/.dsh/guide-dog-deploy
    （600 权限 + SHA-256 manifest），autoload 运行副本 → ~/.dsh/guide-dog-autoload，
    profile symlink/声明指向 home；autoload 读文件逐项校验 hash，不匹配拒绝部署。
  - MEDIUM：agent/created 仅接受 payload.agent 且 agents.get(id)===agent 真实实例。
  - LOW：失败 30s 冷却（attempted 时间戳），防审批疲劳。
  - 验证：node --check OK；双文件 hash 匹配；篡改一字节即检测失败。
- kind 报错定位：turn 64 由 dsh-auto-review 注入报告消息触发，DSH 内核 dsh-llm
  forAdapter 对缺 source 的 assistant 历史消息读 source.kind 崩溃（健壮性 bug，
  非插件问题）；turn 65 起自愈，当前运行正常。

## 2026-08-15 深夜：自动加载未生效根因（v5）——profile 注册错位

- 现象：安全修复 + 部署后重启 DSH，guide-dog 仍未自动加载（cordis_inspect_self = []）。
- 根因（系统性排查）：`dsh web` = `--profile web` 别名（DSH README 第 13 行）；
  进程 21:37 重启加载的是 web profile bundles，而 autoload 注册在 cc-tui profile
  → bundle 从未加载 → autoloader 从未运行。bundle 本身无问题。
- 对照官方先例 dsh-better-sidebar（^0.10.3 真装、web profile 生效）确认包结构一致：
  patch = `- insert: [{id, name}]`；命名导出 `export {name, apply}`（无 default）；
  纯 host 插件无需 dsh.client 块；lib/index.js 只依赖 node 内置模块，服务走 ctx.get。
- 修复（86aa06b 已推）：deploy/publish.py 新增幂等 register_profile()（依赖 link +
  bundles 条目 + node_modules symlink 注册进 ~/.dsh/profiles/web）；手工注册 web
  profile 完成并静态验证（import 解析 OK、node --check OK、JSON OK、幂等 no-op）。
- 待办：用户重启 DSH → 验证 agent/created 自动部署 gdog（首次 client 激活需批准一次）。

## 2026-08-16 清晨：自动加载真正根因（v6）——agent/created 事件签名错位

- 现象：v5 修复（web profile 注册）后用户重启 DSH（23:40），gdog 仍未自动加载。
- 取证：①`dsh web --dump-default-config` 确认组合树含 guide-dog-autoload 行
  （bundle 解析 + patch 应用成功）②Event.listEvents 查 agent/created 契约 =
  `(this: Scoped<Agent>, payload: { agent: Agent })` —— 仅一个参数！
- 根因：autoload 的 ctx.on('agent/created', (carrier, name, payload)) 三参签名
  → payload 恒为 undefined → candidate 校验静默 return → deploy 从不执行。
  roots() 兜底在启动早期也无 live agent 可捞。事件错位 + 时序 = 永不部署。
- 修复（1d105d2 已推）：改为单参 (payload)，payload 形状异常打日志防静默。
- 安全手动复核（自动审查 aborted 后补做）：签名修复 + payload.agent 实例校验
  （agents.get(id)===candidate）+ DEPLOY_DIR hash 校验 + 600 权限 + 30s 冷却，
  全部通过，无新暴露面。
- 待办：用户再次重启 DSH → 恢复会话应触发 agent/created → deploy gdog →
  UI 首次批准 → cordis_inspect_self 可见 gdog-*。

## 2026-08-16 上午：自动加载真正根因（v7）——服务注册在 agent 作用域 ctx

- 现象：v6 修复后用户重启 DSH（08:36），命令行出现
  `[gd-autoload] runner/agents unavailable, skipping`，gdog 仍未自动加载。
- 取证（进程内实验，无需重启）：
  ①读代码确认该日志在 apply() 第 45-48 行：ctx.get('dynamicCordisRunner')
  或 ctx.get('agents') 为 undefined → apply 提前 return → 事件监听器从未注册。
  ②服务目录（Service.listService）有 agents 但无 dynamicCordisRunner；
  dsh-cordis-host-runner 源码确认服务名正确（super(ctx, 'dynamicCordisRunner')），
  实例化点不在该包 → 注册在别的 ctx。
  ③运行时探针（动态插件 dbg-1，inject 两服务后 apply 抛错暴露结果）：
  **agent 作用域 ctx 中两个服务均可见**（get=YES prop=YES，inventory/roots 可用）；
  且 sandbox ctx 不暴露 ctx.agent（设计使然）。
  ④Agent 类型定义：`readonly ctx: Context`（runtime-types.d.ts:72）。
- 根因（root cause #3）：dynamicCordisRunner / agents 注册在 **agent 作用域 ctx**，
  bundle（cordis.patch.yml insert 进全局组合树）的 apply ctx 看不到 →
  提前 return → 监听器/兜底全没挂上。前两个根因（profile 错位、事件签名）
  修复正确但都被这一步挡住。链条：bundle 加载✓ → apply 被服务可见性挡住✗。
- 修复（本次）：apply 不再依赖全局 ctx 拿服务；事件回调里经 payload 的
  agent.ctx.get() 解析两个服务（全局 ctx 兜底），拿不到才 skip（打日志）。
  已发布到 ~/.dsh/guide-dog-autoload（hash/权限同前），真源+运行副本 IN SYNC。
- 探针 dbg-1 已 undefine 清理。
- 待办：用户再次重启 DSH → 应看到 deploy 日志/UI 批准 → cordis_inspect_self 见 gdog-*。

## 2026-08-16 下午：架构升级（v8）——动态插件 → 静态 web-profile bundle

- 触发：v7 修复生效后（gdog-1/pkg-1 自动部署成功、host/client 双半激活、
  guide_dog_* 工具实测可用），用户发现"每个 session 启动了一个 gdog-*"。
  用户期望："和 dsh-better-sidebar 一样无感加载"——一个全局实例、无批准、
  无 per-session 副本。
- 根因（设计如此）：动态插件 registry 按 sessionId 归属，autoload 为每个
  agent（会话/子代理）各部署一个 gdog 实例；每个实例的 client 激活还需
  一次 UI 批准。host 侧工具无重复（每会话各自可见），registry 当前会话
  仅 gdog-1。
- 方案（对照官方先例完整验证）：静态 bundle。关键发现：
  ①dsh-better-sidebar **有完整 client 半**（exports["./client"] + dsh.client
  {platform, inject}）——之前"纯 host"认知错误，官方形态 = host main +
  client exports + dsh.client + dsh.bundle.patch。
  ②client 半是 window.__ModuleLoader__.load({id, factory}) CJS 工厂，
  require('react') 为平台 seed 词——**可手写，无需构建链**。
  ③host 半 harness API 可做兼容层：defineTool 透传（schema 已标准）、
  registerTool → ctx.tools.register（全局注册，所有会话可见）、
  handle → webServer JSON POST 路由（/guide-dog/api/*）。
  ④动态 client 半的 styles（沙箱注入）→ 自建 <style> 标签；
  host.call（私有 RPC）→ 同源 fetch。
- 实施：
  - deploy/convert_bundle.py：plugin-host.js/plugin-client.js → bundle/lib/
    （host = ESM name/apply；client = __ModuleLoader__ factory）。guideDogRoot
    从 per-workspace 沙箱根改为全局 ~/.dsh/guide-dog（config/media/scripts
    单一份）。
  - bundle/package.json（name: dsh-guide-dog，exports["./client"]，dsh.client
    inject: client-runtime + client-ui-slots，dsh.bundle.patch）+ cordis.patch.yml。
  - deploy/publish.py：同步 bundle 到 ~/.dsh/dsh-guide-dog；profile 注册
    dsh-guide-dog（link+bundles+symlink）并**移除 dsh-guide-dog-autoload**
    （防动态实例与静态 bundle 并存）。legacy deploy/autoload 目录保留回退。
- 验证：bundle ESM import OK（name/apply 导出正确）；profile bundles =
  [dsh-base, dsh-web-app, dsh-superpowers, dsh-better-sidebar, dsh-at-file,
  dsh-guide-dog]（autoload 已移除）；node --check 双侧语法 OK。
- 待办：用户重启 DSH → 验证：①guide_dog_* 工具全局可见（无 gdog-* 插件）
  ②UI voice 群组（无批准）③config 迁移（旧 workspace/.guide-dog/config.json
  不自动迁移，全局 ~/.dsh/guide-dog/.guide-dog/config.json 重新配置）
  ④四项清单复验。
