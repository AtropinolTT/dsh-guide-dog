# RC14 修复计划：播报内容选择 + 队列丢弃 + 进度去重 + 双播埋点定位（2026-08-17）

执行方式：SDD（fresh implementer per task + 评审门禁）。本文件为唯一事实来源，实施者无会话上下文，
所有精确代码/断言/验收都写在这里。工作分支 `phase2-call-mode`（项目 12 轮惯例，原地执行）。

## 背景（RC13 验收失败，用户实测证据）

用户复测（会话 session-b97161d1，turn 5 = 天气回复，最终消息 seq 24280）后报告四项：

1. **每一次回复还是读两遍**（爆音已消失 = 串行两遍，非叠加）
2. **URL 被拆开读**（"thepaper" / "cn/newsD" / "weather." / "com." 等碎片）
3. **实际关键消息没有有效朗读**（只听到 URL 碎片 + 📢 说明，主内容缺失）
4. **进度播报重复**（"正在搜索网页" 连播 3 次）

### 已完成的根因调查（控制器取证，勿重复调查）

- 会话日志（~/.dsh/sessions/.../session-b97161d1*/session.jsonl.zstd）：turn 5 只有一个最终
  assistant/message（seq 24280，content=[reasoning, text]，**无 tool-call**）；turn/end 在 seq 24282。
  → host 的 downlink 监听器对该回合**只可能入队一次**。
- 该会话 agent **从未调用 guide_dog_speak**（工具调用仅 bash/read/grep/web_search/skill/job_* 等）→
  排除「agent 主动朗读」双通道。
- `~/.dsh/profiles/web/package.json` bundles = [dsh-base, dsh-web-app, dsh-superpowers,
  dsh-better-sidebar, dsh-at-file, dsh-guide-dog]，cordis.patch.yml 无 autoload 行；dsh-core 源码无
  `*-autoload` 目录自动扫描 → **排除双插件实例**（guide-dog-autoload 未加载）。
- 部署产物 = 源码（bundle 含 rc13-20260817 标记、turn-end flush、gen 守卫）✓。
- tts-stream handler 单次 spawn mmx --stream → 单次写回 res → 排除「音频内容自带两遍」。
- client 播放器：单 fetch、scheduleChunk 每帧一次、重试仅 fetch 错误且 stopStreamPlayback 先行
  → 排除 client 常规双播。
- **队列上限丢弃**（实证）：`enqueue n=20 qlen=10` + `VOICE_QUEUE_MAX=10` +
  `q.splice(0, q.length - VOICE_QUEUE_MAX)`（**从队头删**）→ 20 句中前 10 句（主内容）被删，
  保留 s11-s20（参考来源 URL 碎片 + 📢 说明）。用户听到的 shift 序列（澎湃新闻/thepaper/cn/newsD/
  上海天气网/weather/com/cn/gdtp/shtml)/📢…）与 s11-s20 逐条吻合 → **RC-A 内容丢失根因**。
- **URL 拆读**（实证）：splitSentences 默认分隔符 `'。！？.!?\n'` 含 `.`，在 URL 内部拆断；
  markdown 链接 `- [标题](url)` 与 `**加粗**`、`📢` emoji 未净化直接进 TTS → **RC-B**。
- **进度重复**（实证）：3 次 web_search 的 tool/result 间隔 ~4.3s（1786949904016 - 1786949899743），
  大于 progressDedupe 默认 4s 冷却 → 每次结果都 announce → **RC-C**。
- **双播**（RC-D，未定位）：上述全部排除后，剩 client 播放路径（fetch 重试/重复 poll/双页面）
  或 host 队列跨回合滞留。**本次加入诊断埋点，一次复测定位**（判定表见 Task 4）。

## 修复设计

### F1 sanitizeSpeechText（host 新增同步函数）

播报文本净化（入队前统一调用；纯函数，无 IO）：

```js
// RC14：播报文本净化——URL/markdown/emoji/列表标记不朗读（通话模式不读网址）
function sanitizeSpeechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [标题](url) → 标题
    .replace(/https?:\/\/[^\s，。！？!?）)]+/g, ' ') // 裸 URL（中文标点收尾）
    .replace(/www\.[^\s，。！？!?）)]+/g, ' ')
    .replace(/^\s*(?:[-+*]|>\s*)\s*/gm, ' ') // 行首列表/引用标记
    .replace(/^\s*\d{1,3}[.、)]\s*/gm, ' ') // 行首有序列表标记
    .replace(/[*_~#|]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{00A9}\u{00AE}]/gu, ' ') // emoji 区段
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+$/g, '')
    .trim()
}
```

行为示例：`'- [澎湃新闻：雨势减弱](https://m.thepaper.cn/x.shtml) 📢 你好。'`
→ `'澎湃新闻：雨势减弱 你好。'`（- 与链接 URL 移除、📢 移除）。

### F2 splitSentences 智能拆分（host 修改）

保留签名 `splitSentences(text, splitChars, maxChars)`。`.` 永远走智能规则
（后跟空白+大写/CJK 才拆），数字点（8.17 / 3.5）不拆；主分隔集合加 `；;`：

```js
function splitSentences(text, splitChars, maxChars) {
  if (!text) return []
  const max = maxChars || 200
  // RC14：'.' 不再按字符类拆分（URL/小数拆断）——智能规则：后跟空白+大写/CJK 才拆
  const extra = String(splitChars || '').replace(/[\\\]]/g, '\\$&').replace(/[.\s]/g, '')
  const re = new RegExp('[。！？!?；;' + extra + '][ \t]*|\\n+|(?:\\.)(?=[ \\t]+[A-Z0-9\\u4e00-\\u9fff])', 'g')
  const out = []
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    const seg = text.slice(last, m.index + m[0].length).trim()
    if (seg) out.push(seg)
    last = m.index + m[0].length
  }
  const tail = text.slice(last).trim()
  if (tail) out.push(tail)
  const res = []
  for (const s of out) {
    if (s.length <= max) res.push(s)
    else for (let i = 0; i < s.length; i += max) res.push(s.slice(i, i + max))
  }
  return res
}
```

行为：`'你好。世界！'` → 2 句；`'8.17 的上海'` → 1 句；`'Hello. Next'` → 2 句；
`sanitizeSpeechText` 后 URL 碎片不再存在（'thepaper/cn' 等不会出现）。

### F3 队列上限策略（host 修改）

- `VOICE_QUEUE_MAX`：10 → 40。
- downlink 与 turn-end flush 的裁剪：`q.splice(0, q.length - VOICE_QUEUE_MAX)` → `while (q.length > VOICE_QUEUE_MAX) q.pop()`（**丢队尾保内容**：先入内容优先，超长回复截尾不截头）。
- announce/hb 的 `q2.pop()` 保持（unshift 到队首的 progress 优先）。

### F4 progress 去重（host 修改）

announce 冷却 4s → 30s（函数签名已支持显式 cooldownMs；progressDedupe 本体不动，
repro-progress.js 语义保持）：

```js
if (progressDedupe(lastProgress.get(String(sid)), text, now, 30000)) {
```

### F5 双通道互斥补全（host 修改）

- downlink 的 wasHostSpoken 检查改为净化后文本：`if (wasHostSpoken(sid, sanitizeSpeechText(text))) return`
- turn-end flush 补检查（RC13 deferred minor）：`pendingFinal.delete(sid)` 之后
  `if (wasHostSpoken(sid, sanitizeSpeechText(pend.text))) return`
- speakImpl playOnHost 成功后注册两个键：
  `markHostSpoken(sid, transformed); markHostSpoken(sid, sanitizeSpeechText(transformed))`
- 已知局限（写入代码注释）：transform.py 改写文本时净化键可能不完全一致，属可接受边缘。

### F6 诊断埋点（本次核心诉求：定位「读两遍」）

host（[gd-host] 前缀，只加日志不改行为）：
1. downlink enqueue：`console.log('[gd-host] enqueue from=downlink n=... qlen=... text=...')`
   （from=downlink|turnend|voice-mode|consensus|announce|heartbeat）
2. shift：`console.log('[gd-host] shift key=... remain=' + q.length)`（shift 后剩余）
3. wasHostSpoken 命中（downlink/voice-mode/turn-end 三处）：
   `console.log('[gd-host] skip host-spoken sid=' + sid + ' text=' + text.slice(0, 30))`
4. 入队前重复检测（downlink 与 turn-end flush 内，仅日志不丢弃）：
   ```js
   const dup = q.some(function (e) { return e.text === s })
   if (dup) { try { console.log('[gd-host] QUEUE-DUP text=' + String(s).slice(0, 20)) } catch (e) { /* ignore */ } }
   ```

client（[gd] 前缀，只加日志不改行为）：
5. playStreamEntry 计数：模块级 `const playCounts = new Map()`；入口处
   ```js
   const k = entry.key || entry.text
   const c = (playCounts.get(k) || 0) + 1
   playCounts.set(k, c)
   ```
   并在现有 gdLog 行追加 `' times=' + c`。
6. 队列空时汇总（callPoll 中 r.entry 为 null 分支）：
   ```js
   if (playCounts.size) {
     const summary = Array.from(playCounts.entries()).map(function (e) { return e[0] + '=' + e[1] }).join(' | ')
     gdLog('PLAY-SUMMARY ' + summary)
     playCounts.clear()
   }
   ```
   （playCounts 定义在 streamPlayer 附近模块级。）

## 任务划分（每 Task 段自包含全部精确代码；评审门禁逐任务）

### Task 1：F1 + F2（净化 + 智能拆分）

以下代码为唯一事实，逐字实现（F1/F2 完整函数见上「修复设计」节，照抄）：

1. **plugin-host.js**：在 `splitSentences` 函数（L1823）之前新增 `sanitizeSpeechText`
   （F1 完整函数体，注释 `// RC14：播报文本净化——URL/markdown/emoji/列表标记不朗读（通话模式不读网址）`）。
2. **替换 `splitSentences`**（L1823-1843 整函数）为 F2 版本（含 `// RC14：'.' 不再按字符类拆分...` 注释）。
3. **downlink 监听器**（约 L1938-1941）：原代码
   `const sentences = splitSentences(text, streamCfg.sentenceSplit, streamCfg.maxSentenceChars || 200)`
   改为
   `const clean = sanitizeSpeechText(text)` + `if (!clean) return` +
   `const sentences = splitSentences(clean, streamCfg.sentenceSplit, streamCfg.maxSentenceChars || 200)`
   入队的句子文本即净化后句子（`q.push({ stream: true, text: s, ... })` 不变，s 已是净化句）。
   注意：wasHostSpoken 检查行（Task 3 改）暂保持现状即可（本任务不改），但 `text` 变量已被
   `clean` 替代后，wasHostSpoken 仍用原始 `text`（本任务保持原样，Task 3 统一改）。
4. **turn-end flush**（约 L1962-1965）：同样
   `const clean = sanitizeSpeechText(pend.text)` + `if (!clean) return` +
   `splitSentences(clean, ...)`。
5. **voice-mode 监听器**（约 L2067-2079）：`const text = ...` 提取之后、
   `if (!text) return` 之后加 `const clean = sanitizeSpeechText(text)` + `if (!clean) return`；
   `hasToolCall` 判定用原始 content（不变）；`wasHostSpoken(sid, clean)`；serialSpeak 内
   `speakImpl({ text: clean, ... })`。
6. **announce**（约 L1778）：`const clean = sanitizeSpeechText(text)`；`progressDedupe` 与
   `lastProgress.set` 用原始 `text`（短语去重不变）；unshift 与日志用 `clean`。

验证（本任务交付前必须跑）：
- `node --check plugin-host.js` 通过。
- 用 node 直接求值新函数验证行为快照：
  `sanitizeSpeechText('- [澎湃新闻：雨势减弱](https://m.thepaper.cn/x.shtml) 📢 你好。')`
  不含 http/thepaper/📢/'-'，含 '澎湃新闻：雨势减弱'；
  `splitSentences('8.17 的上海今天有雨。', '。！？.!?\n', 200).length === 1`；
  `splitSentences('Hello. Next step.', '。！？.!?\n', 200).length === 2`。
- 不动其他文件。提交信息：`fix(phase2): RC14-T1 — 播报文本净化（URL/markdown/emoji/列表标记）+ 智能分句（'.' 数字不拆）`。

### Task 2：F3 + F4（队列上限 + 进度去重）

1. **VOICE_QUEUE_MAX**（L2053）：`const VOICE_QUEUE_MAX = 10` → `const VOICE_QUEUE_MAX = 40`
   （注释加 `// RC14：40 上限（净化后句子数骤减；超长回复截尾不截头）`）。
2. **downlink 裁剪**（约 L1942）：原
   `if (q.length > VOICE_QUEUE_MAX) q.splice(0, q.length - VOICE_QUEUE_MAX)`
   改为
   `// RC14：丢队尾保内容——先入内容优先（旧 splice 从队头删 → 主内容被裁）`
   `while (q.length > VOICE_QUEUE_MAX) q.pop()`。
3. **turn-end flush 裁剪**（约 L1966）：同上替换（同一 while pop 逻辑）。
4. **announce**（约 L1780）：`progressDedupe(lastProgress.get(String(sid)), text, now)` →
   `progressDedupe(lastProgress.get(String(sid)), text, now, 30000)`
   （注释：`// RC14：30s 短语窗口——web_search 结果间隔 ~4.3s > 旧 4s → 连播 3 次`）。
5. announce/hb 的 `q2.pop()` 保持不动。

验证：
- `node --check plugin-host.js` 通过。
- 静态断言：downlink/turn-end 段不再含 `q.splice(0, q.length - VOICE_QUEUE_MAX)`；
  `VOICE_QUEUE_MAX = 40` 存在；`progressDedupe(lastProgress.get(String(sid)), text, now, 30000)` 存在。
- `node repro/repro-progress.js` 仍 PASS（函数本体未动）。
- 提交信息：`fix(phase2): RC14-T2 — 队列上限 40 截尾保内容 + 进度短语去重窗口 30s`。

### Task 3：F5 + host 埋点（互斥补全 + [gd-host] 日志）

1. **downlink wasHostSpoken**（约 L1933）：`if (wasHostSpoken(sid, text)) return` →
   `if (wasHostSpoken(sid, sanitizeSpeechText(text))) return`。
2. **turn-end flush**（约 L1959-1961 后）：`pendingFinal.delete(sid)` 之后加
   `// RC14：本机已播（guide_dog_speak playOnHost）不再兜底入队`
   `if (wasHostSpoken(sid, sanitizeSpeechText(pend.text))) return`。
3. **voice-mode wasHostSpoken**（约 L2076）：`if (wasHostSpoken(sid, text)) return` →
   `if (wasHostSpoken(sid, clean)) return`（Task 1 已引入 clean）。
4. **speakImpl**（约 L826）：`if (args.playOnHost) { const played = await playOnHost(abs); if (played) markHostSpoken(sid, transformed) }`
   改为
   `if (args.playOnHost) { const played = await playOnHost(abs); if (played) { markHostSpoken(sid, transformed); markHostSpoken(sid, sanitizeSpeechText(transformed)) } }`
   （注释：`// RC14：注册双键——净化后文本与 downlink 匹配（markdown/URL 文本互斥生效）；transform.py 改写文本时净化键可能不完全一致，属可接受边缘`）。
5. **enqueue 埋点**（downlink，约 L1945）：`console.log('[gd-host] enqueue n=' + sentences.length + ...)`
   → `console.log('[gd-host] enqueue from=downlink n=' + sentences.length + ' qlen=' + q.length + ' text=' + text.slice(0, 20))`
   （turn-end flush 的 `'[gd-host] turn-end flush n=...'` → `'[gd-host] enqueue from=turnend n=...'`）。
6. **shift 埋点**（约 L2104）：`console.log('[gd-host] shift key=' + String(entry.key || '?'))` →
   `console.log('[gd-host] shift key=' + String(entry.key || '?') + ' remain=' + q.length)`。
7. **skip host-spoken 埋点**（三处 wasHostSpoken 命中处，downlink/turn-end/voice-mode）：
   return 前加 `try { console.log('[gd-host] skip host-spoken sid=' + sid + ' text=' + String(text).slice(0, 30)) } catch (e) { /* ignore */ }`
   （voice-mode 处用 clean；downlink/turn-end 处用 text/原始，加 sanitize 调用点可打印原始 text）。
8. **QUEUE-DUP 埋点**（downlink 与 turn-end flush 的 sentences.forEach 内、push 前）：
   ```js
   const dup = q.some(function (e) { return e.text === s })
   if (dup) { try { console.log('[gd-host] QUEUE-DUP text=' + String(s).slice(0, 20)) } catch (e) { /* ignore */ } }
   ```

验证：
- `node --check plugin-host.js` 通过。
- 静态断言（grep）：`'from=downlink'`、`'remain='`、`'skip host-spoken'`、`'QUEUE-DUP'`、
  `markHostSpoken(sid, sanitizeSpeechText(transformed))`、turn-end flush 段含
  `wasHostSpoken(sid, sanitizeSpeechText(pend.text))` 各 1 处。
- 提交信息：`fix(phase2): RC14-T3 — 双通道互斥补全（净化文本匹配 + turn-end 检查）+ [gd-host] 诊断埋点`。

### Task 4：client 埋点（F6.5-6.6）+ 复测定标

1. **playCounts**（plugin-client.js，streamPlayer 定义 L1094 附近）：
   `// RC14：播放计数——一次复测定位「读两遍」（同一 key 播 2 次即双播铁证）`
   `const playCounts = new Map()`。
2. **playStreamEntry 入口**（约 L1178-1181）：`const playId = ++streamPlayer.playSeq` 之后加
   ```js
   const k = entry.key || entry.text
   const c = (playCounts.get(k) || 0) + 1
   playCounts.set(k, c)
   ```
   现有 gdLog 行（L1194）追加 `' times=' + c`。
3. **PLAY-SUMMARY**（callPoll 的 `.then(function (r) {...})` 内，r 无 entry 时；约 L1044 分支）：
   在 `if (r && r.ok && r.entry) {...}` 之后（entry 为 null 场景）加
   ```js
   else if (!r || !r.entry) {
     if (playCounts.size) {
       const summary = Array.from(playCounts.entries()).map(function (e) { return e[0] + '=' + e[1] }).join(' | ')
       gdLog('PLAY-SUMMARY ' + summary)
       playCounts.clear()
     }
   }
   ```
   （注意保留现有 `.catch`/`.then` 链结构；入口 `if (r && r.ok && r.entry)` 分支不动。
   「队列空」= r.ok && !r.entry；!r.ok 时跳过。）
4. **不改任何播放行为**（fetch/重试/stop 逻辑零改动）。

验证：
- `node --check plugin-client.js` 通过。
- 静态断言（grep）：`playCounts`（≥2 处）、`'times=' + c`、`'PLAY-SUMMARY '` 各 1 处；
  确认无 `stopStreamPlayback`/`playSeq` 相关改动（git diff 只含新增行）。
- **复测定标**（写入任务报告，供验收对照）：
  - host 日志 `QUEUE-DUP` 出现 → host 双入队（事件重复/滞留）→ RC15：enqueue 幂等。
  - `[gd] PLAY-SUMMARY` 出现 `key=2` → client 双播（fetch 重试/重复 poll）→ RC15：重试链核查。
  - 两处无重复但用户仍听到两遍 → 音频内容双写 → 取证 tts-stream 响应 bytes（'stream done' 行）。
  - host `enqueue from=` 同一来源两次相同文本 → 事件重放 → RC15：lastStreamTurn 窗口扩展。
- 提交信息：`fix(phase2): RC14-T4 — client 播放计数埋点（times/PLAY-SUMMARY，零行为变更）`。

### Task 5：回归 + 构建 + 台账

1. **新增 `repro/repro-rc14.js`**（模式仿 repro-rc13.js：read 源码文件 → grab 函数/片段 →
   eval 求值断言 + grep 静态断言；文件头注释写明「RC14 静态契约 + 行为快照」）。断言清单：
   - 静态：`sanitizeSpeechText` 函数体含 `https?:\\/\\/[^\\s，。！？!?）)]+`、
     `\\[([^\\]]*)\\]\\([^)]*\\)`、`\\u{1F000}-\\u{1FAFF}`、`^\\s*(?:[-+*]|>\\s*)\\s*`；
     `splitSentences` 含 `(?:\\.)(?=[ \\t]+[A-Z0-9\\u4e00-\\u9fff])`；
     `VOICE_QUEUE_MAX = 40`；downlink 段含 `while (q.length > VOICE_QUEUE_MAX) q.pop()`
     且不含 `q.splice(0, q.length - VOICE_QUEUE_MAX)`；
     announce 段含 `now, 30000`；turn-end 段含 `wasHostSpoken(sid, sanitizeSpeechText(pend.text))`；
     speakImpl 段含 `markHostSpoken(sid, sanitizeSpeechText(transformed))`；
     `'from=downlink'`、`'remain='`、`'skip host-spoken'`、`'QUEUE-DUP'`、
     client 段含 `'times='`、`'PLAY-SUMMARY '`。
   - 行为（eval 后直接调用）：
     a. `sanitizeSpeechText('- [澎湃新闻：雨势减弱](https://m.thepaper.cn/x.shtml) 📢 你好。')`
        → 不含 'http'、'thepaper'、'📢'、'-'，含 '澎湃新闻：雨势减弱'、'你好。'
     b. `sanitizeSpeechText('**阵雨或雷雨**天气')` → 不含 '*'
     c. `splitSentences('你好。世界！', '。！？.!?\n', 200).length === 2`
     d. `splitSentences('8.17 的上海今天有雨。', '。！？.!?\n', 200).length === 1`
     e. `splitSentences('Hello. Next step.', '。！？.!?\n', 200).length === 2`
     f. `splitSentences(sanitizeSpeechText('- [澎湃新闻：雨势减弱](https://m.thepaper.cn/x.shtml) 📢 你好。'), '。！？.!?\n', 200).length === 1`
   - 断言方式：console.assert + 末尾打印 PASS/FAIL 汇总（与 repro-rc13.js 同款）。
2. **全量回归**（逐条执行并记录结果）：
   `node repro/repro-rc14.js`、`node repro/repro-rc13.js`、`node repro/repro-rc11.js`、
   `node repro/repro-m9.js`、`repro-m10.js`、`repro-m11.js`、`repro-wav.js`、`repro-split.js`、
   `repro-progress.js`、`repro-stream-drain.js`、`repro-cmds.js`、`repro-consensus.js`；
   `bash repro/repro-stream-busy-429.sh`、`repro-call-segment-webm.sh`、`repro-transcribe-concurrency.sh`；
   `node --check plugin-host.js plugin-client.js`（注意：`repro && node --check` 会短路，
   分开跑）。
3. **bundle 重建**：`python3 deploy/convert_bundle.py` 后确认 `bundle/lib/index.js` 与
   `bundle/lib/client.js` 更新；构建标记 `rc14-20260817`（plugin-client.js 注释行
   `// [guide-dog] client build rc13-20260817` → `rc14-20260817`，Tag 行同步）；
   提交 bundle（项目惯例：bundle 每轮单独提交，`chore(phase2): rebuild bundle rc14-20260817 (generated)`）。
4. **README**（Phase 2 通话模式节）追加/修订：
   - 播报内容净化：URL、markdown（**、链接、列表标记）、emoji 不朗读；
   - 智能分句：'.' 仅后跟空白+大写/CJK 拆分（小数/日期不拆）；
   - 队列上限 40、超长回复截尾；进度短语 30s 去重窗口；
   - 诊断埋点：[gd-host] enqueue from=/shift remain=/skip host-spoken/QUEUE-DUP；
     [gd] times=/PLAY-SUMMARY。
5. **台账**：`.superpowers/sdd/2026-08-17-rc14-call-fixes/progress.md` 初始化（背景、四根因、
   T1-T5 记录表、复测定标判定表、已知边界）+ 父台账 `plans/2026-08-14-phase2-call-mode.md`
   追加 RC14 节（标题 + 摘要 + 提交链）。
6. **清理取证文件**：删除仓库根 `.sdd-call-session.jsonl`、`.sdd-main-session.jsonl`
   （调查取证已完成，结论已固化进本计划与台账；如想保留先确认 .gitignore 覆盖再移入
   .superpowers/ —— 二选一，报告写明选择）。
7. 提交信息：`docs(phase2): RC14-T5 — repro-rc14 + 全量回归 + bundle rc14 + README + 台账`。

## 验收（用户侧，Task 5 部署后）

1. 重启 DSH + 硬刷新（Ctrl+Shift+R）+ 确认 `[guide-dog] client build rc14-20260817`。
2. 一次完整通话测试（问天气类问题，agent 会贴链接）：
   - 播报内容 = 纯正文：无 URL/网址碎片、无 `**`/`-`/📢、无「参考来源」行
   - 关键内容（天气/气温）完整朗读（不再被队列丢弃）
   - 回复只播一遍（「读两遍」消失或日志明确指向）
   - 多步搜索只听到一次「正在搜索网页」（不再连播 3 次）
   - 打断/停播无爆音（RC13 已确认项保持）
3. 采集：浏览器控制台 `[gd]` 行（poll/playStreamEntry times=/PLAY-SUMMARY）+ DSH 终端 `[gd-host]`
   行（enqueue from=/shift remain=/skip host-spoken/QUEUE-DUP）→ 回传控制器归档。

## 已知边界（本计划不修，写台账）

- transform.py 改写文本时 host-spoken 净化键可能不完全一致（F5 局限）。
- 长回复截尾策略（cap 40）可能截掉超长回复尾部（比 RC13 截头好两个数量级）。
- 「读两遍」若定位到 client 重试/事件重放，本计划只埋点不修，RC15 按判定表方向修。
