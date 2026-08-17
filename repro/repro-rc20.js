// repro-rc20.js —— RC20 断言（静态契约：UI 悬浮搬迁 / i18n / Recent media 移除 / 提示词优化）
// 运行：node repro/repro-rc20.js   （退出码 0 = 全过）
'use strict'
const fs = require('fs')
const path = require('path')
const host = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8')
const client = fs.readFileSync(path.join(__dirname, '..', 'plugin-client.js'), 'utf8')
let fail = 0
function ok(cond, msg) { if (cond) { console.log('PASS ' + msg) } else { fail++; console.log('FAIL ' + msg) } }
function count(hay, needle) { return hay.split(needle).length - 1 }

// ---- RC20 A：统一悬浮 dock（RC20-F：通话 pill 上缘/语音 pill 下缘对齐输入框，右缘 7px，同宽） ----
ok(client.includes('client build rc20-20260817'), 'client build tag rc20')
ok(count(client, "'guide-dog-call-btn'") === 0, 'client header call btn removed')
ok(count(client, "'guide-dog-call-panel'") === 0, 'client right call panel removed')
ok(count(client, "'guide-dog-call-status'") === 0, 'client old dock status removed')
ok(count(client, "'guide-dog-voice'") === 0, 'client old input.left voice row id removed')
ok(count(client, "'conversation.session.header.actions'") === 0, 'client no session header actions seat')
ok(client.includes("id: 'guide-dog-call-dock'"), 'client unified dock widget id')
ok(client.includes("querySelector('[data-slot=\"conversation.composer.bar\"]')"), 'client bar slot measure')
ok(client.includes("querySelector('[data-composer-seat]')"), 'client seat fallback measure')
ok(client.includes('gd-float-dock'), 'client float dock class')
ok(client.includes('gd-panel-up'), 'client upward panel class (call)')
ok(client.includes('gd-panel-left'), 'client leftward panel class (voice)')
ok(client.includes('function toggleCall('), 'client mic toggles call (start/hangup)')
ok(client.includes('callOpen'), 'client call panel open state')
ok(client.includes('voiceOpen'), 'client voice panel open state')
ok(count(client, 'callPoll()') === 2, 'client call poll kept in dock (def + interval)')
ok(client.includes('[effective, sid, tick, locTick]'), 'client voice poll re-triggers on tick')
ok(client.includes('toggleCall(sid, props.inputActions)'), 'client dock toggleCall with inputActions')
ok(client.includes("'📞'"), 'client handset icon restored')
ok(count(client, 'const PILL_W = 104') === 1, 'client pill shared width const')
ok(client.includes('cardLeft - 7'), 'client pill right edge 7px from card')
ok(client.includes('callTop: top'), 'client call pill top aligned to card top')
ok(client.includes('voiceTop: bottom - PILL_H'), 'client voice pill bottom aligned to card bottom')
ok(count(client, "'conversation.input.left'") === 2, 'client input.left seat restored (mic row)')
ok(client.includes("id: 'guide-dog-mic'"), 'client record mic back inside input')

// ---- RC20 D：i18n 简体中文/英文（跟随 DSH 应用语言） ----
ok(client.includes("ctx.get('locale')"), 'client locale service access')
ok(count(client, "localeSvc.register('guide-dog', 'zh'") === 1, 'client zh dictionary')
ok(count(client, "localeSvc.register('guide-dog', 'en'") === 1, 'client en dictionary')
ok(client.includes("localeSvc.bind('guide-dog')"), 'client t bind')
ok(client.includes('localeSvc.subscribe('), 'client locale reactive subscribe')
ok(client.includes("'call.listening': '收听中…'"), 'client zh dict listening')
ok(client.includes("'call.listening': 'Listening…'"), 'client en dict listening')
ok(client.includes("t('call.listening')"), 'client t usage in status')
ok(client.includes("t('call.modeVad')"), 'client t usage in panel select')
ok(client.includes("t('voice.transcribeFailed')"), 'client t usage in voice error')
ok(client.includes("t('toast.speakFailed')"), 'client t usage in toast')

// ---- RC20 C：设置页移除 Recent media ----
ok(count(client, 'Recent media') === 0, 'client recent media block removed')
ok(count(client, "'guide-dog/list-media'") === 0, 'client list-media fetch removed')

// ---- RC20 B：提示词优化（host） ----
ok(host.includes('回复要简短、口语化'), 'host call consensus spoken style')
ok(count(host, '像和合作伙伴讨论一样') === 0, 'host old consensus wording removed')
ok(host.includes('调用 audio-conversation、speech-mmx、mmx'), 'host voice guidance kept (rc18)')
ok(count(host, '沙箱权限扩展或运行本地脚本') === 0, 'host vision bullet trimmed')

process.exit(fail === 0 ? 0 : 1)
