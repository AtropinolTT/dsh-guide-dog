# Guide Dog for DSH v2 — Phase 1 实施计划审查报告

**审查对象**：`guide-dog-dsh/plans/2026-08-14-phase1-voice-mode-and-voice-input.md`（下称"计划"）
**对照权威**：`guide-dog-dsh/specs/2026-08-14-guide-dog-v2-design.md`（下称"spec"）
**核对真源**：`plugin-host.js`（815 行）、`plugin-client.js`（194 行）
**审查日期**：2026-08-14

---

## 总体结论（先行）

**结论：需先修。** 计划在流程组织、spec 覆盖、TDD 与探测门控上质量较高（Path A/B 分支、探测包先行、错误码子集声明均到位），但存在 **3 处 Critical** 确定性/高风险缺陷——其中 STT 子进程路径是**确定性 bug**（转写必然失败），client 端 `inject:['timer']` 是**未验证的硬依赖**（可能阻塞整个 client 半），配置相对路径是**未验证的定位分裂**（v1 明确规避）。此外有 6 处 Important 与 13 处 Minor。**Critical/Important 未修复前，pkg-6 落地后语音模式与语音输入大概率无法按 spec §5.4 验收通过。**

按严重度分组计数：**Critical ×3、Important ×6、Minor ×13**。

---

# 一、Critical（阻断，必须先修）

## C1. STT 子进程 `cwd` 与 argv 相对路径互斥 —— 转写必然失败（确定性）
- **位置**：计划 Task 2 Step 6（subprocess.spawn 块，计划约 L369–374；`script` L366、`b64Path` L357、`outFile` L368）
- **问题**：`cwd: '.guide-dog/tmp'`，但 argv 里的 `script='.guide-dog/scripts/whisper_transcribe.py'`、`--audio-b64-file '.guide-dog/tmp/rec-*.b64'`、`--out-file '.guide-dog/tmp/whisper-*.out.json'` 全是**相对 workspace 根**的路径。以 `.guide-dog/tmp` 为 cwd 时，操作系统会把 `script` 解析为 `.guide-dog/tmp/.guide-dog/scripts/whisper_transcribe.py`（不存在），`--out-file` 写到 `.guide-dog/tmp/.guide-dog/tmp/…`，而 host 用 `readTextFile('.guide-dog/tmp/whisper-*.out.json')` 在另一处读。结果：`python3 <不存在的脚本>` 退出非零、out 文件从不出现 → host 恒返回 `stt_failed`。v1 真源里 `playOnHost` 用的是**绝对** `cwd: mediaDir` + 绝对 `abs`，本计划偏离了这一已核实模式。
- **修改建议**：与 `ensureMediaDir` 一致，先算 `root`（`sandboxPolicy.workspaceRoot`，回退 `pwd`），构造绝对路径 `root + '/.guide-dog/scripts/…'`、`root + '/.guide-dog/tmp/…'`，`cwd` 设 `root + '/.guide-dog/tmp'` 或干脆不设 cwd 而全用绝对路径。

## C2. client `inject:['timer']` + `ctx.interval` —— 未验证的硬依赖，可能阻塞整个 client 半
- **位置**：计划 Task 5 Step 3（`ctx.interval`，计划约 L827）与 Step 4（`inject:['timer']`，L862）
- **问题**：已核实事实明确"client Builtin 仅 ctx/React/host.call/styles.insert/console"，**无 timer 服务**。计划却对 client 插件声明 `inject:['timer']` 硬依赖——按 Cordis inject 语义，若该服务不存在，插件将**无限等待**，导致语音模式、麦克风、设置页全部不加载。同时代码用的是 `ctx.interval(...)`，既不是注入名 `timer` 对应的 `ctx.timer`，也不在 Builtin 清单里；`if (!ctx.interval) return` 这个降级分支在硬注入下是死代码。任务 4 的探测包**没有探测 timer 服务**，无法在 pkg-6 前验证。
- **修改建议**：二选一——(a) 用 `ctx.get('timer')` 可选获取（`const timer = ctx.get('timer')`，处理 undefined），并把 `ctx.interval` 改为 `timer.interval`（**先经 cordis_inspect_query 核实 client 端 timer 服务的确切方法与签名**）；(b) 若确认 client 无 timer，去掉 inject，改用探测确认过的 `setInterval/clearInterval` 全局（任务 4 已在探测），并保证 disposer 在 Fiber 内被 `ctx.effect` 清理。同时把探测包补一条 timer 服务形状探测。

## C3. 配置/状态/tmp/probe 相对路径 —— 与 v1 `workspaceRoot` 绝对路径分裂，未验证
- **位置**：计划 Task 1 Step 1（`refreshConfig/saveConfig/writeStatus` 内 `.guide-dog/config.json`、`.guide-dog/status.json`，L119–147）、Task 2（`.guide-dog/tmp`、`.guide-dog/scripts`）、Task 4（`.guide-dog/probe.json`）、Task 6b（媒体路由旁）
- **问题**：spec §4 定义 config 在 `~/.guide-dog/config.json`（workspaceRoot = `$HOME`），验收脚本（Task 9）读 `~/.guide-dog/config.json`。但计划新代码一律用**相对** `.guide-dog/...`，而 v1 真源 `ensureMediaDir` 明确用 `sandboxPolicy.workspaceRoot` 算出绝对 root 再拼 `/ .guide-dog/media`（恰恰因为相对路径不可靠）。相对路径经 `fsSvc.resolve()` 与 `runRaw('mkdir -p '.guide-dog')`（shell 默认 cwd）是**两套独立解析基准**，可能分别落在不同目录；若 `fsSvc.resolve` 不锚定 workspaceRoot，config.json 会与媒体库/验收脚本读取位置错位，整条两层设置与 autoSend 失效。
- **修改建议**：抽出 `guideDogRoot()`（复用 `ensureMediaDir` 的 root 计算），所有 config/status/tmp/scripts/probe 路径统一 `root + '/.guide-dog/…'` 绝对化；删除 `runRaw('mkdir -p '.guide-dog')` 的相对写法。

---

# 二、Important（高影响，须在 pkg-6 前修）

## I1. host `timerSvc.timeout(fn, ms)` 与 v1 `await timerSvc.timeout(ms)` 冲突
- **位置**：计划 Task 2 Step 6（L376 `const killer = timerSvc.timeout(function(){…}, 60000)`，L378 `killer()`）
- **问题**：已核实 v1 `sleep()` 用 `await timerSvc.timeout(ms)`（返回 Promise）。计划却按"`timeout(callback, ms)` 返回可取消句柄"调用。若真实签名只有 `timeout(ms)→Promise`，`timerSvc.timeout(fn, 60000)` 会把函数当 ms（NaN→0 立即 resolve），随后 `killer()` 对 Promise 调用即抛 TypeError → 被 catch 捕获恒返回 `stt_failed`；60s 超时与 `handle.terminate()` 全部失效。且探测包未覆盖 timer 服务签名。
- **修改建议**：先核实 host timer 服务是否提供"可取消定时器"方法（如 `timerSvc.cancelTimeout` 或 `timeout(ms)` 返回含 cancel 的对象）；否则用 `Promise.race([handle.done, sleep(60000)])` 超时 + `handle.terminate()` 实现，或把超时探测加入 Task 4。

## I2. 配置写非原子、无 600 权限 —— 违背 spec §4/§8.2.5，且计划自相矛盾
- **位置**：计划 Task 1 Step 1（`saveConfig`，L126–139）
- **问题**：spec §4 与 §8.2.5 要求"原子写（临时文件+rename）"且 `config.json` 权限 600；计划 Task 1 的 commit message（L196）也自称"atomic writes"，但代码是 `writeTextFile(base + '/config.json', …)` 直接写，无临时文件+rename、无 chmod。半写损坏会污染 config 缓存，权限可能过宽。
- **修改建议**：写 `config.json.tmp` → 成功后 `runRaw('mv -f tmp config.json')`；`runRaw('chmod 600 …')`；commit message 去掉"atomic"或落实实现。

## I3. `config.tts.*` 从未被 `speakImpl` 消费 —— 硬指标 3 的验收注入失效
- **位置**：计划 Task 3（speakImpl 扩展，host 真源 L277 `resolveVoice` 未改）+ 计划 Task 9 Step 3（L1263–1279）
- **问题**：spec §4 定义 `tts.voiceEn/voiceZh/speed/format`，但 `speakImpl` 仍走 `resolveVoice(args.voice, transformed)`（硬编码 `English_Trustworthy_Man / Chinese (Mandarin)_Gentle_Youth`），**不读** `loadConfig().tts.*`。Task 9 Step 3 把 `tts.voiceEn='Invalid_Voice_XYZ'` 当失败注入，但该字段从未进入 TTS 调用 → 注入无效，硬指标 3 实际上**无法被该用例验证**（"失败必反馈"形同未测）。
- **修改建议**：要么在 `speakImpl` 中让 `resolveVoice`/`speed` 优先读 `loadConfig().tts`（`args` 显式值仍最高优先）；要么把 Task 9 Step 3 的注入改为真正能触发 TTS 失败的手段（如给 `guide_dog_speak` 传非法 `voice` 参数、或临时清空 `MINIMAX_API_KEY`）。二者取一，并同步 spec 与验收说明。

## I4. 配置加载竞态 —— 首次 get-config 可能拿到默认缓存
- **位置**：计划 Task 1 Step 3（`refreshConfig()` fire-and-forget，L189）+ Task 5 Step 2（`loadVoiceCfg` 启动即 `get-config`）
- **问题**：`refreshConfig` 是异步 fire-and-forget，`guide-dog/get-config` 同步返回 `loadConfig()` 缓存。若 client 在 `refreshConfig` 的 `readTextFile` resolve 前调用 get-config，会拿到**默认值**（`voiceMode.default=false`），导致已持久化的"全局开"在重启后不生效（破坏验收 Step 1/4 的"重启后保持/恢复"语义）。无重试/序列化。
- **修改建议**：让 `refreshConfig()` 返回的 Promise 作为 get-config 的 gate（`await refreshConfig` 后再 `loadConfig()`），或 `loadConfig` 改为异步读盘；至少把"重启后首次加载"纳入验收的确定性判定。

## I5. 探测包 globals 用裸标识符求值 —— 缺 MediaRecorder/AudioContext 的浏览器直接抛 ReferenceError
- **位置**：计划 Task 4 Step 1（L590–599，`MediaRecorder: probeType(MediaRecorder)`、`AudioContext: probeType(AudioContext)` 等）
- **问题**：`probeType(v)` 内部虽是 `typeof v`，但调用点 `probeType(MediaRecorder)` 会**先求值实参** `MediaRecorder`；在未实现该 WebIDL 接口的浏览器里，裸标识符 `MediaRecorder` 是 ReferenceError（`typeof MediaRecorder` 才安全）。此异常发生在组件 `useEffect` 内、无 try/catch，会击穿探测包——而探测正是决定 Path A/B 的门。讽刺的是 Task 6 的 `windowCannotRecord()` 已用了正确的 `try { mr = MediaRecorder } catch`，探测包反而写错。
- **修改建议**：globals 探测统一改为 `probeType(window.MediaRecorder)` 或直接 `typeof MediaRecorder`（`window` 恒存在、`typeof` 对未声明标识符恒安全），与 Task 6 写法一致。

## I6. `inputActions` 方法名是猜测，且探测结果不回填到实现
- **位置**：计划 Task 6 Step 2（`insertText`/`submitInput` 候选链，L907–915）
- **问题**：spec §5.2 明言"具体方法名以实施期核实的 InputActions 契约为准"。计划虽在 Task 4 探测了 `inputActions.keys`，但 Task 6 的 `setValue/setText/replaceText/append/appendText/insert/submit/send` 是硬编码候选链；若真实契约不在链内，`insertText` 静默 no-op，语音输入全链路（spec 硬交付之一）无声失败，且无兜底提示。
- **修改建议**：Task 6 Step 1 增加**决策门**——按探测到的 `inputActions.keys` 显式选择方法名并写死在注释；候选链兜底若全部未命中，必须 `set({error:'stt_failed'})` 或专用错误码提示，禁止静默吞掉。

---

# 三、Minor（低影响 / 一致性瑕疵）

## M1. 转写大小上限与单位不一致
- **位置**：计划 Task 2 Step 6（`args.audioB64.length > 30*1024*1024`）、Task 6b（`total > 30*1024*1024`）
- **问题**：spec §8.1 为"transcribe 音频 ≤20MB"（二进制字节），计划用 30MB，且一处是 base64 字符串长度、一处是 raw 字节，单位不一致。
- **建议**：统一为 20MB 二进制字节；b64 侧按 20MB×(4/3)≈27MB 换算，或统一在解码后按字节判断。

## M2. 错误码枚举溢出 spec §8.3
- **位置**：计划 Global Constraints L27、Task 4 Step 2（`probe_write_failed`）、Task 1/2（`bad_args`）
- **问题**：spec §8.3 是"统一枚举"，计划新增 `bad_args`、`probe_write_failed` 不在其中；且 v1 `speakImpl` 的 `text is required`、`TTS finished but…` 仍为自由文本，未映射到 `tts_failed`。
- **建议**：把 `bad_args` 补进 spec §8.3 或复用现有码；speakImpl 所有失败出口统一走枚举。

## M3. `WHISPER_SCRIPT` 模板字面量是悬空占位符
- **位置**：计划 Task 2 Step 6（L324–325，`…将脚本全文逐字复制…`）
- **问题**：Step 2 的 60 行 Python 脚本未真正内联进 host 模板字符串，靠实施者手工复制，属 TBD/省略号悬空；`node --check` 会通过但运行时 WHISPER_SCRIPT 内容为空/占位。
- **建议**：计划里给出**完整的、与 Step 2 逐字一致**的模板字面量文本，消除手工复制步骤。

## M4. 锚点行号两处不实
- **位置**：计划 Global Constraints L18（`transformText(~230)`）、Task 7 Step 1（`行 137–142 effect`）
- **问题**：实读 `transformText` 在 host **L213**（计划写 ~230，偏 17 行）；SettingsPage 的 useEffect 实为 **L137–143**（计划写 137–142，漏了 `}, [])` 闭合行）。其余锚点（行 27 日志、272 speakImpl、287 pushIndex、764 RPC 注释、client 行 18 h、行 133 SettingsPage、行 186 注入）均属实。
- **建议**：修正两处行号。

## M5. `kind:'exact'` 与 `res.setHeader` 未验证
- **位置**：计划 Task 6b（L1074–1093）
- **问题**：v1 真源只用 `webServer.register({kind:'prefix', …})` 与 `res.writeHead(status, headers)`；计划用 `kind:'exact'` 与 `res.setHeader(...)`，均未在已核实契约中出现。
- **建议**：cordis_inspect_query 核实 webServer 路由 kind 枚举与 response 方法，或改用 `prefix` + 方法/路径自判 + `writeHead`。

## M6. Web Speech API 降级未实现
- **位置**：spec §5.3；计划 Task 6b
- **问题**：spec §5.3 将"Web Speech API"列为"无本地模型时的最后兜底"，计划用"录音页（仍走 whisper）"替代，未实现 Web Speech 降级。
- **建议**：若确认 Phase 1 不做，在计划"Out of scope"显式声明并回改 spec；否则补一个 SpeechRecognition 降级分支（明确标注隐私）。

## M7. `systemPrompt.variable` 契约与 context 形状未验证
- **位置**：计划 Task 3 Step 4（L518–528）
- **问题**：v1 只用过 `systemPrompt.section`，`systemPrompt.variable` 的注册签名与 provider 的 `context.sessionId / context.session.id` 均为猜测，spec 未给出 context 结构。
- **建议**：实施前 cordis_inspect_query 核实 variable API 与 provider context 字段；探测包可顺带打一个 variable 占位验证。

## M8. client 去重键不一致（select 早退失效）
- **位置**：计划 Task 5 Step 2（L774 `voiceState.spoken.has(':' + owner.seq)` vs L783 `sid + ':' + matched.seq`）
- **问题**：select 用 `':'+seq`，组件用 `sid+':'+seq`，两者键不同 → select 的粗筛永远不命中（死代码）。功能上组件内二次校验仍兜住，不产生重复发声，但 select 失效。
- **建议**：统一键格式；或明确 select 因拿不到 sessionId 而只做"配置已开"粗筛，删掉误导性的 `spoken.has(':'+seq)` 检查。

## M9. 录音计时显示冻结
- **位置**：计划 Task 6 Step 2（L906 `let micSeconds=0`；L981 `micSeconds + 's'`）
- **问题**：`micSeconds` 是模块变量，`ondataavailable` 递增但**不触发 React 重渲染**，故按钮旁的秒数恒显示 0（或陈旧值）；`set()` 只在 start/stop 时调用。
- **建议**：秒数进 React state（`set({seconds: micSeconds})`），或显示端每次 `ondataavailable` 手动 `set`。

## M10. speak RPC 缺 `durationMs`
- **位置**：spec §5.1（"返回 {ok,url,durationMs}"）；计划 Task 3（speakImpl 仍返回 `{ok,kind,url,file,voice,bytes}`）
- **问题**：spec 提到 `durationMs`，计划 speak 响应未提供（transcribe 响应有）。当前 client 用 `<audio>` 播放不依赖它，故仅文档/契约不一致。
- **建议**：要么 speakImpl 返回 `durationMs`（可从 mmx 结果或文件时长取得，成本高则显式从 spec 移除该字段）。

## M11. `Blob.prototype.arrayBuffer` 未探测
- **位置**：计划 Task 4 Step 1（只探测 `Blob` typeof）；Task 6 `blob.arrayBuffer()`（L994）
- **问题**：Path A 依赖 `Blob#arrayBuffer` 方法，探测只验 `Blob` 存在；老浏览器 `Blob` 在而 `arrayBuffer` 缺时，Path A 会在编码阶段抛错落入 `stt_failed`。
- **建议**：探测加 `Blob.prototype.arrayBuffer`，缺失则走 `FileReader.readAsArrayBuffer` 或强制 Path B。

## M12. 探测包依赖"已存在 turn"才会上报
- **位置**：计划 Task 4 Step 5
- **问题**：`conversation.chat.turnTail` 是逐 turn 的 chain，空会话无 turn 时组件不挂载，`probe.json` 不产生，Step 7 决策门无法执行。计划虽有"PROBE MISSING"分支但未给兜底动作。
- **建议**：探测包同时注册一个**不依赖 turn** 的 slot（如 `conversation.input.right` 或 settings.section）上报 globals/inputActions，确保空会话也能拿到关键形状。

## M13. 清理 glob 被 quote 导致不展开
- **位置**：计划 Task 2 Step 6 finally（L391 `quote('.guide-dog/tmp/whisper-*.out.json')`）
- **问题**：`quote()` 会单引号包裹，`rm -f 'whisper-*.out.json'` 中 glob 不展开 → 实际删除字面文件，out 文件泄漏（且与 C1 的相对路径问题叠加）。b64 文件已被脚本 `--delete-b64` 删，host 再删属冗余。
- **建议**：清理用精确文件名（`rm -f ` + quote(outFile)），不要通配；或让脚本自身在 finally 中删除 out-file。

---

# 四、逐项清单结论（A–F）

- **A. Spec 覆盖**：§5.1/§5.2/§5.3/§8.1 主体均有对应 Task，无重大遗漏；缺口为 Web Speech 降级（M6）、STT 引擎选择 UI（§8.4 引擎下拉未做，仅 whisper 状态+模型）、§8.1 的 20MB 上限（M1）。无过度实现。
- **B. 一致性**：配置键名一致；**矛盾点**：错误码 `bad_args/probe_write_failed` 越界（M2）、tts 配置定义未消费（I3）、原子写/600 承诺未落实（I2）、`durationMs` 字段缺失（M10）、30MB vs 20MB（M1）。
- **C. 代码级正确性**：JS 语法（`node --check`）层面各片段基本合法、无 import/JSX/useRef；**语义层**问题集中在 C1（subprocess 路径）、C2（timer）、I1（host timer 签名）、I4（竞态）、I5（裸标识符）、I6（inputActions 猜测）、M8/M9（去重键/计时）。host 辅助函数签名引用基本属实（仅 transformText 行号错，M4）。去重状态机（client Set + host Map 双保险）成立，但失败后不重试（spec 允许 ≤2，计划固定 1 次，可接受）。
- **D. 锚点真实性**：行 27/272/287/764、client 18/133/186 均属实；**不实**：`transformText(~230)` 实为 213、SettingsPage effect 实为 137–143（计划 137–142）。
- **E. 流程质量**：Task 粒度合理、TDD 有失败测试先行（Task 2 Step 1/4/5）；**pkg-5→pkg-6 决策门成立但缺 timer 服务探测与 inputActions 回填门**（C2/I6）；Path A/B 分支大体完备但 A 的 `arrayBuffer` 未探测（M11）、B 的 `kind:'exact'`/`setHeader` 未验证（M5）；人工/自动验收划分清晰（whisper 自动、UI 交互人工）；**占位符**：WHISPER_SCRIPT 悬空（M3）、Task 5/6 Step 1 的形状注释是待填占位（属正常，但需落实）。
- **F. 运行时风险**：tts/stt/config/权限失败均有兜底（错误码→徽章+提示音），但 config 失败反馈依赖 C2 的 timer 与 C3 的路径；录音 Path A 依赖的 `Blob/btoa/arrayBuffer` 中 `arrayBuffer` 未列入探测（M11）；dock 徽章 8s 过期逻辑本身成立（`errorAt` + `now-errorAt<8000`），但**依赖 `ctx.interval` 每秒 tick 重渲染**，timer 失效则 8s 过期与播放均失效（并入 C2）。

---

## 修复优先级建议

1. 先修 **C1/C2/C3**（三项直接决定 pkg-6 能否运行）。
2. 再修 **I1–I6**（否则验收硬指标 3 与语音输入全链路无法可信通过）。
3. Minor 随各 Task 顺手修，重点 M1/M2/M3/M4/M11。

修复并复跑 `node --check`（host/client/source）+ `py_compile` 后，再部署 pkg-6 并执行 Task 9 验收。
