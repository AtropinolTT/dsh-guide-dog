// repro/repro-rc14.js — RC14 静态契约 + 行为快照回归测试（2026-08-17）：
//   F1 sanitizeSpeechText（URL/markdown/emoji/列表标记不朗读）
//   F2 splitSentences 智能拆分（'.' 仅后跟空白+大写/CJK 才拆；小数/URL 不拆断）
//   F3 队列上限 40 + 丢队尾保内容（while pop 而非 splice head）
//   F4 进度去重冷却 30s
//   F5 双通道互斥按净化后文本匹配（turn-end flush 补检查；speakImpl 注册双键）
//   F6 host/client 诊断埋点（[gd-host] enqueue from=/shift remain=/skip host-spoken/QUEUE-DUP；
//        [gd] playStreamEntry times=/callPoll PLAY-SUMMARY）
// 模式：read 真源 → grep 静态契约断言 + grab/eval 行为快照断言（repro-progress.js 同款）。
// 行为（a-f）通过 eval 后直接调用 sanitizeSpeechText / splitSentences 验证。
// 任一缺失 → FAIL；末尾汇总 ALL PASS。
// 注意：不使用 'use strict'——direct eval 的函数声明需泄漏到 run() 作用域供断言引用。
const fs = require('fs')
const path = require('path')
const srcH = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8')
const srcC = fs.readFileSync(path.join(__dirname, '..', 'plugin-client.js'), 'utf8')

let failed = 0
function check(cond, label) {
  if (cond) console.log('PASS: ' + label)
  else { console.error('FAIL: ' + label); failed += 1 }
}

// 字符串 contains 检查（避免在正则字面量里转义中文/特殊字符）
function has(haystack, needle) { return haystack.indexOf(needle) !== -1 }

// ============================================================================
// 1. 静态契约（grep 真源）
// ============================================================================

// ---- F1 sanitizeSpeechText 函数定义 + 四个关键正则片段 ----
{
  const fn = srcH.match(/function sanitizeSpeechText\(text\) \{[\s\S]*?\n    \}/)
  const body = fn ? fn[0] : ''
  check(!!fn, 'host: sanitizeSpeechText 函数定义存在（F1）')
  check(has(body, 'https?:\\/\\/[^\\s'), 'host: sanitizeSpeechText 移除裸 URL（https?://…）')
  check(has(body, '\\[([^\\]]*)\\]\\([^)]*\\)'), 'host: sanitizeSpeechText 处理 [标题](url)（markdown 链接）')
  check(has(body, '\\u{1F000}-\\u{1FAFF}'), 'host: sanitizeSpeechText 含 emoji 区段 \\u{1F000}-\\u{1FAFF}')
  check(has(body, '^\\s*(?:[-+*]|>\\s*)\\s*'), 'host: sanitizeSpeechText 含行首列表/引用标记（^-/+*/^>\\s）')
}

// ---- F2 splitSentences 智能拆分 ----
{
  const fn = srcH.match(/function splitSentences\(text, splitChars, maxChars\) \{[\s\S]*?\n    \}/)
  const body = fn ? fn[0] : ''
  check(!!fn, 'host: splitSentences 函数定义存在（F2）')
  check(has(body, '(?:\\\\.)(?=[ \\t]+[A-Z0-9\\u4e00-\\u9fff])'), 'host: splitSentences 含 . 智能规则（空白+大写/CJK 才拆）')
}

// ---- F3 队列上限 40 + 丢队尾 ----
{
  check(has(srcH, 'const VOICE_QUEUE_MAX = 40'), 'host: VOICE_QUEUE_MAX = 40（F3 改）')
  // RC14 注释标记「丢队尾保内容」出现 ≥2 次（downlink + turn-end flush 两段）
  const popNotes = (srcH.match(/RC14：丢队尾保内容/g) || []).length
  check(popNotes >= 2, 'host: RC14 丢队尾注释 ≥2 处（downlink + turn-end flush）')
  // 旧 q.splice(0, q.length - VOICE_QUEUE_MAX)（队头裁剪）必须消失
  check(!has(srcH, 'q.splice(0, q.length - VOICE_QUEUE_MAX)'), 'host: 旧 q.splice(0, q.length - VOICE_QUEUE_MAX)（队头裁剪）已全移除')
  check(has(srcH, 'while (q.length > VOICE_QUEUE_MAX) q.pop()'), 'host: while pop 丢队尾逻辑存在')
}

// ---- F4 进度去重 30s 冷却 ----
{
  check(has(srcH, 'progressDedupe(lastProgress.get(String(sid)), text, now, 30000)'), 'host: announce 进度去重冷却 now, 30000（F4 改）')
}

// ---- F5 双通道互斥（按净化后文本匹配）----
{
  check(has(srcH, 'markHostSpoken(sid, sanitizeSpeechText(transformed))'), 'host: speakImpl 注册净化后键（markHostSpoken 双键）')
  check(has(srcH, 'wasHostSpoken(sid, sanitizeSpeechText(pend.text))'), 'host: turn-end flush wasHostSpoken 检查（净化后文本）')
  check(has(srcH, 'wasHostSpoken(sid, sanitizeSpeechText(text))'), 'host: downlink wasHostSpoken 检查（净化后文本）')
}

// ---- F6 host 诊断埋点 ----
{
  check(has(srcH, "'[gd-host] enqueue from=downlink"), 'host: [gd-host] enqueue from=downlink 埋点')
  check(has(srcH, "'[gd-host] enqueue from=turnend"), 'host: [gd-host] enqueue from=turnend 埋点')
  check(has(srcH, "'[gd-host] shift key='") && has(srcH, 'remain=\' + q.length'), 'host: [gd-host] shift ... remain= 埋点')
  check(has(srcH, "'[gd-host] skip host-spoken sid='"), 'host: [gd-host] skip host-spoken 埋点')
  check(has(srcH, "'[gd-host] QUEUE-DUP text='"), 'host: [gd-host] QUEUE-DUP 埋点')
}

// ---- F6 client 诊断埋点 ----
{
  check(has(srcC, 'const playCounts = new Map()'), 'client: playCounts 模块级 Map（F6.5）')
  const playCountsOccurrences = (srcC.match(/playCounts/g) || []).length
  check(playCountsOccurrences >= 3, 'client: playCounts 引用 ≥ 3 处（声明 + playStreamEntry + PLAY-SUMMARY + stopCall 清空）')
  check(has(srcC, 'times=\' + c'), 'client: playStreamEntry gdLog 追加 times= + c')
  check(has(srcC, "'PLAY-SUMMARY '"), 'client: PLAY-SUMMARY 队列空汇总日志')
}

// ============================================================================
// 2. 行为快照（eval 真源函数体后断言，6 项）
// ============================================================================
function run() {
  // grab 函数体（直接 eval；含 const → var 转换）
  const grab = function (re, label) {
    const m = srcH.match(re)
    if (!m) { console.error('FAIL: 提取失败 ' + label + '（RC14 语义：F1/F2 函数不存在）'); process.exit(1) }
    return m[0]
  }
  eval(grab(/function sanitizeSpeechText\(text\) \{[\s\S]*?\n    \}/, 'sanitizeSpeechText'))
  eval(grab(/function splitSentences\(text, splitChars, maxChars\) \{[\s\S]*?\n    \}/, 'splitSentences'))

  // ---- a. sanitizeSpeechText 净化样例 ----
  const sa = sanitizeSpeechText('- [澎湃新闻：雨势减弱](https://m.thepaper.cn/x.shtml) 📢 你好。')
  check(!/http/.test(sa), 'a: 净化后不含 http（URL 已移除）')
  check(!/thepaper/.test(sa), 'a: 净化后不含 thepaper（URL 域名碎片已移除）')
  check(!/📢/.test(sa), 'a: 净化后不含 📢（emoji 已移除）')
  check(!/-/.test(sa), 'a: 净化后不含 -（列表标记已移除）')
  check(/澎湃新闻：雨势减弱/.test(sa), 'a: 净化后含「澎湃新闻：雨势减弱」（链接标题保留）')
  check(/你好。/.test(sa), 'a: 净化后含「你好。」（正文保留）')

  // ---- b. sanitizeSpeechText 去星号 ----
  const sb = sanitizeSpeechText('**阵雨或雷雨**天气')
  check(!/\*/.test(sb), 'b: 净化后不含 *（markdown 加粗标记已移除）')
  check(/阵雨或雷雨/.test(sb), 'b: 净化后含「阵雨或雷雨」（正文保留）')

  // ---- c. splitSentences 中文句号 + 叹号 ----
  const sc = splitSentences('你好。世界！', '。！？.!?\n', 200)
  check(sc.length === 2, 'c: splitSentences("你好。世界！") → 2 句')

  // ---- d. splitSentences 小数不拆 ----
  const sd = splitSentences('8.17 的上海今天有雨。', '。！？.!?\n', 200)
  check(sd.length === 1, 'd: splitSentences("8.17 的上海今天有雨。") → 1 句（小数不拆）')

  // ---- e. splitSentences 英文 . + 大写 ----
  const se = splitSentences('Hello. Next step.', '。！？.!?\n', 200)
  check(se.length === 2, 'e: splitSentences("Hello. Next step.") → 2 句（. 后空白+大写才拆）')

  // ---- f. 组合：净化后单句 ----
  const sa_f = sanitizeSpeechText('- [澎湃新闻：雨势减弱](https://m.thepaper.cn/x.shtml) 📢 你好。')
  const sf = splitSentences(sa_f, '。！？.!?\n', 200)
  check(sf.length === 1, 'f: splitSentences(sanitizeSpeechText(...)) → 1 句（净化后只剩正文）')
}
run()

// ============================================================================
// 3. 汇总
// ============================================================================
if (failed > 0) { console.error(failed + ' 项未通过（RC14 语义）'); process.exit(1) }
console.log('ALL PASS')
process.exit(0)