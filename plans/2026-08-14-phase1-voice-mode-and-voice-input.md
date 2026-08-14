# Phase 1（语音模式硬化 + 语音输入）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 gdog-1 插件 v2 的 Phase 1 落地三条硬指标（机制保证自动发声 / 文字语音一致 / 失败必反馈）+ 语音输入（麦克风→STT→输入框），并补齐两层语音模式设置与设置页。

**Architecture:** 单插件演进（spec 方案 A）：host 半新增 CONFIG/STT 节并扩展 `speakImpl`（source/dedup/错误码/config 接线）；client 半新增 VOICE MODE（turnTail 自动发声钩子 + dock 徽章）与 MIC INPUT（composer 麦克风按钮）。**关键约束**：client Builtin 仅 `ctx/React(createElement,useState,useEffect)/host/styles/console`——录音、自动播放、失败提示音必须走"运行时能力探测 + React 自管 `<audio>` + host RPC"实现。**实现顺序**：先部署探测包 pkg-5 收集 client 形状与全局可用性，再实现 pkg-6。本版已吸收独立审查（V4-Pro）的 C1–C3/I1–I6/M1–M13 全部修复。

**Tech Stack:** 动态 Cordis 插件（plain JS，无 import/JSX/useRef）；mmx CLI（TTS）；faster-whisper（Python，STT）；v1 既有辅助函数；React（client UI）。

**Spec:** `guide-dog-dsh/specs/2026-08-14-guide-dog-v2-design.md`（§4、§5.1–5.4、§8.1/§8.3/§8.4）

## Global Constraints

- 动态插件：`code.host`/`code.client` 为纯 JS 函数体；**禁止** import/require/TS/JSX/装饰器；client 用 `React.createElement`，且 **`useRef` 不可用**（用模块级变量替代）。
- 插件身份：`gdog-1`（现 running，currentPackageId=pkg-4）。新包 `cordis_define` kind `existing` 追加；激活 `cordis_run` mode `update`。
- client Builtin 仅：`ctx`、`React`（createElement/useState/useEffect）、`host.call`、`styles.insert`、`console`。**client 端不得声明 `inject`**（client 服务经 `ctx.get` 可选获取并判空；timer 服务确实存在于 client 目录，签名 `timeout/interval/throttle/debounce`，但以 `ctx.get('timer')` 使用并判空，见 Task 5）。探测用 `typeof X` 或 `typeof X.Y` 内联表达式（对未声明标识符恒安全，**禁止**先求值实参再传入函数）。
- host Builtin：`ctx/harness/console/btoa/atob/TextEncoder/TextDecoder`。host 既有辅助函数（行号已核实）：`quote`(29)、`pick`(32)、`sleep`(41)→`timerSvc.timeout(ms)`、`serialSpeak`(45)、`serialIndex`(50)、`runRaw`(57)→`{exitCode,stdout,stderr,timedOut,aborted,denied,mode}`、`mmx`(77)、`ensureMediaDir`(102)、`statFile`(117)→FsInfo|null、`readBytes`(125)、`listDir`(132)、`writeTextFile`(139)、`loadIndex`(147)、`pushIndex`(158)、`transformText`(**213**)、`hasCJK`(234)、`resolveVoice`(243)、`nextTurnNumber`(247)、`generateTts`(258)、`speakImpl`(272)、`MEDIA_ROUTE`(11)。
- **路径规则（审查 C1/C3 修复）**：所有 host 新代码一律用**绝对路径**——新增 `guideDogRoot()`（复用 `ensureMediaDir` 的 root 计算：`sandboxPolicy.workspaceRoot`，回退 `pwd`），config/status/tmp/scripts/probe 均以 `root + '/.guide-dog/…'` 拼写；`subprocess.spawn` 的 `cwd` 与 argv 全部绝对化（v1 `playOnHost` 模式）。
- subprocess 用法（v1 核实）：`subprocess.spawn({ argv, cwd, stdio: { stdin:'ignore', stdout:{maxBytes}, stderr:{maxBytes} }, graceMs })` → handle：`handle.done`（Promise）、`handle.terminate()`。**无 `handle.exit`/`handle.stdout.text()`**；stdout 读取形态未验证 → 输出一律经脚本写文件 + `readTextFile` 读。
- fs 服务**无二进制写/删除**：二进制经 base64 文本文件 + 外部进程解码；删除经 `runRaw('rm -f <精确路径>')`（**禁止带通配符**，`quote()` 会阻止 glob 展开）。
- host `timerSvc.timeout` 目录签名含 `timeout(callback, delay)→disposer` 与 `timeout(delay)→Promise` 两种；本计划**只用 v1 已验证的 `sleep(ms)`（Promise 形式）**做超时竞速，不依赖未验证的 callback 形式（审查 I1 修复）。
- 工具输出 schema 用 value schema DSL：根级禁 `required` 数组，属性级 `required: true`，`additionalProperties` 显式布尔（v1 已验证）。
- mmx 运行器宽容模式（v1 `mmx()`：exit 0 即成功，json 可 null，默认 `--quiet`）。
- 沙箱 workspace-write：shell 写入限 `workspaceRoot=/home/tt-wsl-ubuntu`（`~/.guide-dog/` 合规）；**长任务/播放/转写用 `subprocess` 服务（非沙箱）**。
- 审批策略 ask：client 变更的 `cordis_run update` 需用户批准；被拒不得自动重试。
- 仓库文件是源码记录：`plugin-host.js`+`plugin-client.js` 为真源，`plugin-source.js` 由两者拼接（`// ==== HOST HALF ====` / `// ==== CLIENT HALF ====` 分隔），部署用。
- 媒体索引向后兼容：`pushIndex` 条目新增字段（source/turnSeq/spoken），不得破坏 v1 画廊（`list-media` 结构不变）。
- 错误码（spec §8.3 修订版）：`bad_args / tts_failed / tts_timeout / stt_failed / stt_timeout / engine_unavailable / mic_denied / empty_speech / config_write_failed`。**内部错误码一律从该枚举取，不得新增自由文本错误码**（审查 M2 修复；speakImpl 原有自由文本失败出口映射进枚举）。
- 大小上限（spec §8.1）：transcribe 音频 **20MB 二进制字节**（base64 文本按 `20MB×4/3 ≈ 27MB` 判定）；截图 8MB（Phase 3）。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `guide-dog-dsh/plugin-host.js` | CONFIG 节（guideDogRoot/config/status）、STT 节（whisper 脚本+探测+transcribe）、speak 扩展（dedup/source/错误码/config 接线）、beep RPC、probe RPC、systemPrompt.variable | Modify（按行号锚点插入） |
| `guide-dog-dsh/plugin-client.js` | PROBE 节（pkg-5 专用）→ VOICE MODE 节 + MIC INPUT 节 + 设置页扩展 | Modify |
| `guide-dog-dsh/scripts/whisper_transcribe.py` | faster-whisper 转写脚本（repo 真源；host 内嵌同一内容写入 `~/.guide-dog/scripts/`） | Create |
| `guide-dog-dsh/plugin-source.js` | 部署用拼接体 | Regenerate（Task 4/8） |
| `guide-dog-dsh/README.md` | Phase 1 用法、配置 schema、whisper 安装、验证方法 | Modify（Task 7） |
| `~/.guide-dog/config.json` | 运行时配置（绝对路径 root/.guide-dog/config.json） | Runtime |
| `~/.guide-dog/status.json` / `probe.json` | 探测状态 / client 形状探测 | Runtime |

---

### Task 0: 基线提交（git 首次 commit）

**Files:** 无（git 操作）

**Interfaces:** Consumes: 无；Produces: 首个 commit

- [ ] **Step 1: 确认仓库状态**

```bash
cd /home/tt-wsl-ubuntu/skills-repo && git status --short | head -20 && git log --oneline 2>&1 | head -3
```
Expected: 有未跟踪文件；`fatal: ... does not have any commits yet`。

- [ ] **Step 2: 提交基线**

```bash
cd /home/tt-wsl-ubuntu/skills-repo && git add -A && git commit -m "chore: guide-dog v1 baseline (plugin halves, media pipeline, v2 spec, research)"
```
Expected: commit 成功（若用户明确拒绝入库则跳过并注明）。

- [ ] **Step 3: 验证**

```bash
git log --oneline | head -3
```
Expected: 至少 1 条 commit。

---

### Task 1: Host 配置层（guideDogRoot / config / status / RPC）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（CONFIG 节插入在行 27 日志之后；3 个 RPC handler 插入在行 764 RPC 注释之前）

**Interfaces:**
- Consumes: `runRaw`(57)、`writeTextFile`(139)、`statFile`(117)、`readBytes`(125)、`fsSvc`、`sandboxPolicy`
- Produces:
  - `async guideDogRoot(): Promise<string>`——`sandboxPolicy.workspaceRoot` 或 `pwd` 回退，**所有新路径的基准**（审查 C3 修复）
  - `CONFIG_DEFAULTS`；`configCache`（同步缓存）；`configReady`（Promise gate，审查 I4 修复）
  - `async doRefreshConfig()` / `refreshConfig()`；`loadConfig()`（同步）；`async saveConfig(patch)`（**tmp+mv+chmod 600+.bak 回退**，审查 I2 修复）
  - `async writeStatus(patch)`；`readTextFile(abs)`（v1 同款，绝对路径）
  - RPC `guide-dog/get-config`（**await configReady**）/ `set-config` / `status`

- [ ] **Step 1: 插入 CONFIG 节**

在行 27 之后插入：

```js
    // ============ CONFIG 节（Phase 1） ============
    const CONFIG_DEFAULTS = {
      voiceMode: { default: false, sessions: {} },
      voiceInput: { autoSend: false, engine: 'whisper', language: 'auto', maxSeconds: 60, whisper: { python: 'python3', model: 'small' } },
      tts: { voiceEn: 'English_expressive_narrator', voiceZh: 'Chinese (Mandarin)_Gentle_Youth', speed: 0.95, format: 'mp3' },
    }
    function deepMerge(base, over) {
      if (over === null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
      const out = {}
      for (const k of Object.keys(base)) out[k] = deepMerge(base[k], (k in over) ? over[k] : base[k])
      for (const k of Object.keys(over)) if (!(k in base)) out[k] = over[k]
      return out
    }
    let guideRoot = ''
    async function guideDogRoot() {
      if (guideRoot) return guideRoot
      let root = ''
      if (sandboxPolicy && sandboxPolicy.workspaceRoot) root = sandboxPolicy.workspaceRoot
      if (!root) {
        const p = await runRaw('pwd', { timeoutMs: 10000 })
        root = (p.stdout || '').trim()
      }
      guideRoot = root
      return root
    }
    let configCache = deepMerge(CONFIG_DEFAULTS, {})
    let configReady = Promise.resolve()
    async function readTextFile(abs) {
      if (!fsSvc) return null
      try {
        const t = await fsSvc.resolve(abs)
        const info = await fsSvc.stat(t)
        if (!info) return null
        return await fsSvc.readText(t)
      } catch (e) { return null }
    }
    async function doRefreshConfig() {
      const root = await guideDogRoot()
      const raw = await readTextFile(root + '/.guide-dog/config.json')
      let parsed = null
      if (raw) { try { parsed = JSON.parse(raw) } catch (e) { console.error('[guide-dog] config parse error, trying .bak', e) } }
      if (!parsed) {
        const bak = await readTextFile(root + '/.guide-dog/config.json.bak')
        if (bak) { try { parsed = JSON.parse(bak) } catch (e2) { parsed = null } }
      }
      configCache = deepMerge(CONFIG_DEFAULTS, parsed || {})
      if (!raw) await saveConfig({})
    }
    function refreshConfig() { configReady = doRefreshConfig(); return configReady }
    function loadConfig() { return configCache }
    async function saveConfig(patch) {
      const root = await guideDogRoot()
      const next = deepMerge(configCache, patch || {})
      const dir = root + '/.guide-dog'
      try {
        await runRaw('mkdir -p ' + quote(dir), { timeoutMs: 10000 })
        // 原子写：tmp → mv → chmod 600；写前保留 .bak 供解析失败回退
        const okTmp = await writeTextFile(dir + '/config.json.tmp', JSON.stringify(next, null, 2))
        if (!okTmp) return { ok: false, error: 'config_write_failed' }
        await runRaw('cp -f ' + quote(dir + '/config.json') + ' ' + quote(dir + '/config.json.bak') + ' 2>/dev/null; mv -f ' + quote(dir + '/config.json.tmp') + ' ' + quote(dir + '/config.json'); ' + 'chmod 600 ' + quote(dir + '/config.json'), { timeoutMs: 10000 })
        configCache = next
        return { ok: true }
      } catch (e) {
        console.error('[guide-dog] config write failed', e)
        return { ok: false, error: 'config_write_failed' }
      }
    }
    async function writeStatus(patch) {
      try {
        const root = await guideDogRoot()
        const curRaw = await readTextFile(root + '/.guide-dog/status.json')
        let cur = {}
        if (curRaw) { try { cur = JSON.parse(curRaw) } catch (e) { /* ignore */ } }
        await runRaw('mkdir -p ' + quote(root + '/.guide-dog'), { timeoutMs: 10000 })
        await writeTextFile(root + '/.guide-dog/status.json', JSON.stringify(Object.assign({}, cur, patch), null, 2))
      } catch (e) { console.error('[guide-dog] status write failed', e) }
    }
```

- [ ] **Step 2: 插入 3 个 RPC handler**

在行 764 `// ---------- RPC handlers (client -> host) ----------` 之前插入：

```js
    // ---------- Phase 1 RPC (config / status) ----------
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/get-config', async function () {
          await configReady
          return { ok: true, config: loadConfig() }
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/set-config', async function (args) {
          if (!args || typeof args.patch !== 'object' || args.patch === null) return { ok: false, error: 'bad_args' }
          const r = await saveConfig(args.patch)
          if (r.ok) await refreshConfig()
          return r
        })
      } catch (e) { return function () {} }
    })
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/status', async function () {
          let status = {}
          const raw = await readTextFile((await guideDogRoot()) + '/.guide-dog/status.json')
          if (raw) { try { status = JSON.parse(raw) } catch (e) { /* ignore */ } }
          return { ok: true, status: status }
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 3: 启动时异步刷新配置**

在行 810 `// eager, non-blocking media dir init` 之前插入：

```js
    refreshConfig().catch(function (e) { console.error('[guide-dog] config init failed: ' + String(e)) })
```

- [ ] **Step 4: 语法校验 + Commit**

```bash
node --check /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plugin-host.js
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/plugin-host.js && git commit -m "feat(phase1): host config layer (guideDogRoot absolute paths, atomic writes+600, configReady gate)"
```
Expected: exit 0，commit 成功。

---

### Task 2: Whisper STT 脚本（独立 TDD）+ 启动探测 + transcribe RPC

**Files:**
- Create: `guide-dog-dsh/scripts/whisper_transcribe.py`
- Modify: `guide-dog-dsh/plugin-host.js`（STT 节插入在 CONFIG 节之后；transcribe RPC 插入在 `guide-dog/status` handler 之后）

**Interfaces:**
- Consumes: Task 1 的 `guideDogRoot/loadConfig/saveConfig/writeStatus/readTextFile`；`runRaw`(57)；`sleep`(41)；`subprocess`；`fsSvc`
- Produces:
  - 脚本 CLI：`--audio <path>` 或 `--audio-b64-file <path> [--delete-b64]`，`--model`、`--language`、`--out-file <path>`、`--output json` → stdout 单行 JSON **且**（指定时）写入 out-file；exit 恒 0
  - host `WHISPER_SCRIPT` 常量（**完整内联**，审查 M3 修复）
  - `ensureWhisperScript()` / `probeWhisper()`（绝对路径）
  - RPC `guide-dog/transcribe`：入参 `{audioB64, mime?, sessionId?, language?}` → `{ok, text?, language?, durationMs?, error?, message?}`；20MB 二进制上限（b64 27MB）；超时 60s → `stt_timeout`

- [ ] **Step 1: 写失败测试（脚本不存在）**

```bash
test -f /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/scripts/whisper_transcribe.py && echo EXISTS || echo MISSING
```
Expected: `MISSING`。

- [ ] **Step 2: 实现脚本**

创建 `guide-dog-dsh/scripts/whisper_transcribe.py`：

```python
#!/usr/bin/env python3
"""faster-whisper 转写脚本（guide-dog 插件 STT 后端）。
用法:
  python3 whisper_transcribe.py --audio <path> [--model base|small] [--language auto|zh|en] [--out-file <path>] --output json
  python3 whisper_transcribe.py --audio-b64-file <path> [--delete-b64] [--model base|small] [--language auto|zh|en] [--out-file <path>] --output json
stdout 恒为单行 JSON; exit 恒 0（调用方以 ok 字段判断）。--out-file 可选：同时把同一 JSON 写入文件（host 端读取用）。"""
import argparse, base64, json, os, sys, tempfile, time

def emit(obj, out_file):
    text = json.dumps(obj, ensure_ascii=False)
    print(text)
    if out_file:
        try:
            with open(out_file, 'w', encoding='utf-8') as f:
                f.write(text)
        except Exception:  # noqa: BLE001
            pass
    sys.exit(0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', default=None)
    ap.add_argument('--audio-b64-file', default=None)
    ap.add_argument('--delete-b64', action='store_true')
    ap.add_argument('--model', default='small')
    ap.add_argument('--language', default='auto')
    ap.add_argument('--out-file', default=None)
    ap.add_argument('--output', default='json')
    args = ap.parse_args()
    audio_path = args.audio
    cleanup = []
    try:
        if args.audio_b64_file:
            with open(args.audio_b64_file, 'r', encoding='utf-8') as f:
                data = base64.b64decode(f.read().strip())
            fd, audio_path = tempfile.mkstemp(suffix='.webm')
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            cleanup.append(audio_path)
            if args.delete_b64:
                cleanup.append(args.audio_b64_file)
        if not audio_path or not os.path.exists(audio_path):
            emit({'ok': False, 'error': 'stt_failed', 'message': 'audio file missing'}, args.out_file)
        from faster_whisper import WhisperModel
        t0 = time.time()
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        lang = None if args.language == 'auto' else args.language
        segments, info = model.transcribe(audio_path, language=lang, vad_filter=True)
        text = ''.join(s.text for s in segments).strip()
        if not text:
            emit({'ok': False, 'error': 'empty_speech', 'message': 'no speech recognized'}, args.out_file)
        emit({'ok': True, 'text': text, 'language': info.language,
              'durationMs': int((time.time() - t0) * 1000)}, args.out_file)
    except ImportError:
        emit({'ok': False, 'error': 'engine_unavailable', 'message': 'pip install faster-whisper'}, args.out_file)
    except Exception as e:  # noqa: BLE001
        emit({'ok': False, 'error': 'stt_failed', 'message': str(e)[:300]}, args.out_file)
    finally:
        for p in cleanup:
            try:
                if p and os.path.exists(p): os.unlink(p)
            except Exception:  # noqa: BLE001
                pass

if __name__ == '__main__':
    main()
```

- [ ] **Step 3: 确保依赖**

```bash
python3 -c "import faster_whisper; print(faster_whisper.__version__)" || pip install faster-whisper 2>&1 | tail -3
```
Expected: 版本号或安装成功。（small 模型首跑自动下载 ≈460MB；可预热：`python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"`。）

- [ ] **Step 4: 生成测试音频并转写（TDD 通过判定）**

```bash
cd /tmp && mmx speech synthesize --text "语音识别测试，你好" --voice "Chinese (Mandarin)_Gentle_Youth" --format wav --out stt-test.wav --quiet 2>/dev/null; ls -la stt-test.wav
python3 /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/scripts/whisper_transcribe.py --audio /tmp/stt-test.wav --model small --language zh --output json
```
Expected: `{"ok": true, "text": "...", ...}` 且 text 含"语音"或"识别"（允许个别字差异，必须非空）。

- [ ] **Step 5: 失败路径验证**

```bash
python3 /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/scripts/whisper_transcribe.py --audio /nonexistent.wav --model small --output json
```
Expected: `{"ok": false, "error": "stt_failed", ...}`，exit 0。

- [ ] **Step 6: host 嵌入脚本（完整内联）+ 探测 + transcribe RPC**

在 CONFIG 节之后插入。`WHISPER_SCRIPT` 与 Step 2 的脚本**逐字一致**（模板字面量；脚本内无反引号、无 `${`，安全）。**所有路径绝对化**（审查 C1/C3 修复）：

```js
    // ============ STT 节（Phase 1） ============
    const WHISPER_SCRIPT = `#!/usr/bin/env python3
"""faster-whisper 转写脚本（guide-dog 插件 STT 后端）。
用法:
  python3 whisper_transcribe.py --audio <path> [--model base|small] [--language auto|zh|en] [--out-file <path>] --output json
  python3 whisper_transcribe.py --audio-b64-file <path> [--delete-b64] [--model base|small] [--language auto|zh|en] [--out-file <path>] --output json
stdout 恒为单行 JSON; exit 恒 0（调用方以 ok 字段判断）。--out-file 可选：同时把同一 JSON 写入文件（host 端读取用）。"""
import argparse, base64, json, os, sys, tempfile, time

def emit(obj, out_file):
    text = json.dumps(obj, ensure_ascii=False)
    print(text)
    if out_file:
        try:
            with open(out_file, 'w', encoding='utf-8') as f:
                f.write(text)
        except Exception:
            pass
    sys.exit(0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', default=None)
    ap.add_argument('--audio-b64-file', default=None)
    ap.add_argument('--delete-b64', action='store_true')
    ap.add_argument('--model', default='small')
    ap.add_argument('--language', default='auto')
    ap.add_argument('--out-file', default=None)
    ap.add_argument('--output', default='json')
    args = ap.parse_args()
    audio_path = args.audio
    cleanup = []
    try:
        if args.audio_b64_file:
            with open(args.audio_b64_file, 'r', encoding='utf-8') as f:
                data = base64.b64decode(f.read().strip())
            fd, audio_path = tempfile.mkstemp(suffix='.webm')
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            cleanup.append(audio_path)
            if args.delete_b64:
                cleanup.append(args.audio_b64_file)
        if not audio_path or not os.path.exists(audio_path):
            emit({'ok': False, 'error': 'stt_failed', 'message': 'audio file missing'}, args.out_file)
        from faster_whisper import WhisperModel
        t0 = time.time()
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        lang = None if args.language == 'auto' else args.language
        segments, info = model.transcribe(audio_path, language=lang, vad_filter=True)
        text = ''.join(s.text for s in segments).strip()
        if not text:
            emit({'ok': False, 'error': 'empty_speech', 'message': 'no speech recognized'}, args.out_file)
        emit({'ok': True, 'text': text, 'language': info.language,
              'durationMs': int((time.time() - t0) * 1000)}, args.out_file)
    except ImportError:
        emit({'ok': False, 'error': 'engine_unavailable', 'message': 'pip install faster-whisper'}, args.out_file)
    except Exception as e:
        emit({'ok': False, 'error': 'stt_failed', 'message': str(e)[:300]}, args.out_file)
    finally:
        for p in cleanup:
            try:
                if p and os.path.exists(p): os.unlink(p)
            except Exception:
                pass

if __name__ == '__main__':
    main()`
    let sttProbeDone = false
    async function ensureWhisperScript() {
      const root = await guideDogRoot()
      await runRaw('mkdir -p ' + quote(root + '/.guide-dog/scripts'), { timeoutMs: 10000 })
      const p = root + '/.guide-dog/scripts/whisper_transcribe.py'
      if (!(await statFile(p))) await writeTextFile(p, WHISPER_SCRIPT)
    }
    async function probeWhisper() {
      if (sttProbeDone) return
      sttProbeDone = true
      const cfg = loadConfig()
      const py = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.python) || 'python3'
      const res = await runRaw(py + " -c 'import faster_whisper; print(faster_whisper.__version__)'", { timeoutMs: 15000 })
      await writeStatus({
        whisperAvailable: res.exitCode === 0 && !res.denied,
        whisperVersion: (res.stdout || '').trim(),
        whisperPython: py,
        probeAt: Date.now(),
      })
    }
    async function transcribeImpl(args) {
      const cfg = loadConfig()
      const engine = cfg.voiceInput && cfg.voiceInput.engine
      if (engine && engine !== 'whisper') {
        return { ok: false, error: 'engine_unavailable', message: '当前仅支持 whisper 引擎（MiniMax 无公开 ASR）' }
      }
      if (!args || typeof args.audioB64 !== 'string' || !args.audioB64) {
        return { ok: false, error: 'bad_args', message: 'audioB64 required' }
      }
      if (args.audioB64.length > 27 * 1024 * 1024) { // 20MB 二进制 ≈ 26.7MB base64（spec §8.1）
        return { ok: false, error: 'bad_args', message: 'audioB64 too large' }
      }
      const root = await guideDogRoot()
      const b64Path = root + '/.guide-dog/tmp/rec-' + Date.now() + '.b64'
      const outFile = root + '/.guide-dog/tmp/whisper-' + Date.now() + '.out.json'
      const script = root + '/.guide-dog/scripts/whisper_transcribe.py'
      const py = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.python) || 'python3'
      const model = (cfg.voiceInput && cfg.voiceInput.whisper && cfg.voiceInput.whisper.model) || 'small'
      const lang = (args.language || (cfg.voiceInput && cfg.voiceInput.language) || 'auto')
      await runRaw('mkdir -p ' + quote(root + '/.guide-dog/tmp'), { timeoutMs: 10000 })
      const wrote = await writeTextFile(b64Path, args.audioB64)
      if (!wrote) return { ok: false, error: 'config_write_failed', message: 'cannot write temp audio' }
      let handle = null
      try {
        await ensureWhisperScript()
        handle = subprocess.spawn({
          argv: [py, script, '--audio-b64-file', b64Path, '--delete-b64', '--model', model, '--language', lang, '--out-file', outFile, '--output', 'json'],
          cwd: root + '/.guide-dog/tmp',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
          graceMs: 3000,
        })
        // 超时竞速：只用 v1 已验证的 sleep(ms) Promise 形式（审查 I1 修复）
        let timedOut = false
        const done = handle.done
        const timer = sleep(60000).then(function () {
          timedOut = true
          try { handle.terminate() } catch (e) { /* ignore */ }
        })
        await Promise.race([done, timer])
        if (timedOut) return { ok: false, error: 'stt_timeout', message: 'STT timed out after 60s' }
        // 输出读取定案：脚本已把 JSON 写入 outFile，用已验证的 readTextFile 读取
        const raw = await readTextFile(outFile)
        let parsed = null
        if (raw) { try { parsed = JSON.parse(raw.trim().split('\n').pop()) } catch (e) { /* fallthrough */ } }
        if (!parsed || parsed.ok !== true) {
          return { ok: false, error: (parsed && parsed.error) || 'stt_failed', message: (parsed && parsed.message) || 'STT failed' }
        }
        return { ok: true, text: parsed.text, language: parsed.language, durationMs: parsed.durationMs }
      } catch (e) {
        return { ok: false, error: 'stt_failed', message: String((e && e.message) || e).slice(0, 200) }
      } finally {
        // 精确文件名清理（审查 M13：不用通配符，quote 会阻止 glob 展开）
        await runRaw('rm -f ' + quote(b64Path) + ' ' + quote(outFile), { timeoutMs: 10000 }).catch(function () {})
      }
    }
```

- [ ] **Step 7: 注册 RPC**

在 `guide-dog/status` handler 之后插入：

```js
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/transcribe', async function (args) { return await transcribeImpl(args || {}) })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 8: 启动探测挂接**

在行 810 区域追加（`refreshConfig` 调用之后）：

```js
    ensureWhisperScript().catch(function (e) { console.error('[guide-dog] whisper script init failed: ' + String(e)) })
    probeWhisper().catch(function (e) { console.error('[guide-dog] whisper probe failed: ' + String(e)) })
```

- [ ] **Step 9: 语法校验 + Commit**

```bash
node --check /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plugin-host.js && python3 -m py_compile /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/scripts/whisper_transcribe.py
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/plugin-host.js guide-dog-dsh/scripts/whisper_transcribe.py && git commit -m "feat(phase1): whisper STT (absolute paths, out-file reads, sleep-race timeout, 20MB cap)"
```
Expected: 全部 exit 0，commit 成功。

---

### Task 3: speak 扩展（config 接线 / voice-mode 源 / 去重 / 错误码 / 索引元数据）+ beep RPC + systemPrompt.variable

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（`speakImpl` 行 272 顶部与 `pushIndex` 调用行 287 与失败出口；模块变量区行 25 旁；systemPrompt 节 ~420；RPC 区）

**Interfaces:**
- Consumes: `speakImpl`(272)、`pushIndex`(158)、`transformText`(213)、`hasCJK`(234)、`resolveVoice`(243)、`generateTts`(258)、`statFile`(117)、`MEDIA_ROUTE`(11)、`loadConfig`（Task 1）
- Produces:
  - `spokenTurns = new Map()`（sessionId → Set<turnSeq>）
  - `speakImpl(args)` 入参扩展 `{text, sessionId?, turnSeq?, source?}`；**TTS 音色/语速接线 `loadConfig().tts`**（审查 I3 修复：`args.voice` 显式值 > config voiceEn/voiceZh（按 CJK 判定）> `resolveVoice` 默认）；去重命中 `{ok:true, skipped:true}`；**全部失败出口映射枚举**（`text is required` → `bad_args`；`TTS finished but the mp3 is missing` → `tts_failed`；`generateTts` error 含 timeout → `tts_timeout`，否则 `tts_failed`）
  - `pushIndex` 条目新增：`source`、`turnSeq`、`spoken`（transform 后文本前 160 字符）
  - RPC `guide-dog/beep` → `{ok, dataUri}`（150ms 880Hz 8bit PCM 8kHz WAV，Uint8Array+btoa）
  - `systemPrompt.variable('guide_dog_voice_mode', provider)`：按会话生效值返回约束文本或 undefined（context 形状以 Task 4 探测为准，provider 内防御式取 sessionId）

- [ ] **Step 1: 声明去重表**

在行 25 `const players = new Map()` 之后插入：

```js
    const spokenTurns = new Map() // sessionId -> Set<turnSeq>
```

- [ ] **Step 2: 扩展 speakImpl**

在行 272 `async function speakImpl(args) {` 的函数体顶部（`const text = ...` 之前）插入：

```js
      const source = args.source === 'voice-mode' ? 'voice-mode' : 'tool'
      const sid = typeof args.sessionId === 'string' ? args.sessionId : ''
      const seq = typeof args.turnSeq === 'number' ? args.turnSeq : null
      if (sid && seq !== null) {
        const spoken = spokenTurns.get(sid) || new Set()
        if (spoken.has(seq)) return { ok: true, skipped: true }
        spoken.add(seq)
        spokenTurns.set(sid, spoken)
      }
```

将行 273–278 替换为（config 接线 + 参数解析 + 空文本映射 `bad_args`）：

```js
      const text = String(args.text || '').trim()
      if (!text) return { ok: false, error: 'bad_args', message: 'text is required' }
      await ensureMediaDir()
      const transformed = await transformText(text)
      const ttsCfg = (loadConfig().tts) || {}
      const cfgVoice = hasCJK(transformed) ? (ttsCfg.voiceZh || '') : (ttsCfg.voiceEn || '')
      const voice = resolveVoice(args.voice || cfgVoice || 'auto', transformed)
      const speed = typeof args.speed === 'number' ? args.speed : (ttsCfg.speed || 0.95)
      const lang = args.language || (hasCJK(transformed) ? 'zh' : '')
```

将行 284 `if (!tts.ok) return { ok: false, error: tts.error }` 替换为：

```js
      if (!tts.ok) {
        const msg = String(tts.error || '')
        return { ok: false, error: /timeout/i.test(msg) ? 'tts_timeout' : 'tts_failed', message: msg.slice(0, 300) }
      }
```

将行 286 `if (!st) return { ok: false, error: 'TTS finished but the mp3 is missing' }` 替换为：

```js
      if (!st) return { ok: false, error: 'tts_failed', message: 'TTS finished but the mp3 is missing' }
```

将行 287 `pushIndex` 调用替换为：

```js
      await pushIndex({ name: name, kind: 'audio', prompt: text.slice(0, 200), voice: voice, ts: Date.now(), bytes: st.size || 0, source: source, turnSeq: seq, spoken: transformed.slice(0, 160) })
```

- [ ] **Step 3: beep RPC**

在 `guide-dog/status` handler 之后插入：

```js
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/beep', async function () {
          const rate = 8000, ms = 150, freq = 880
          const n = Math.floor(rate * ms / 1000)
          const bytes = new Uint8Array(44 + n)
          const dv = new DataView(bytes.buffer)
          const w = function (off, str) { for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i) }
          w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ')
          dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
          dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true)
          w(36, 'data'); dv.setUint32(40, n, true)
          for (let i = 0; i < n; i++) {
            const t = i / rate
            const env = 1 - (i / n)
            bytes[44 + i] = Math.max(0, Math.min(255, Math.round(128 + 100 * env * Math.sin(2 * Math.PI * freq * t))))
          }
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          return { ok: true, dataUri: 'data:audio/wav;base64,' + btoa(bin) }
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 4: systemPrompt.variable**

在现有 systemPrompt.section 注册处（~420）旁插入（context 形状由 Task 4 探测的 `contextKeys` 回填；provider 内防御式读取）：

```js
      if (systemPrompt && systemPrompt.variable) {
        systemPrompt.variable('guide_dog_voice_mode', function (context) {
          const cfg = loadConfig()
          const sid = (context && (context.sessionId || (context.session && context.session.id))) || ''
          const vm = cfg.voiceMode || {}
          const effective = sid ? (vm.sessions[sid] !== undefined ? vm.sessions[sid] : vm.default) : vm.default
          if (!effective) return undefined
          return '语音模式：开。本条回复会被自动朗读。保持回复文字与朗读内容一致，不要在回复中描述音频状态，不要重复播报。'
        })
      }
```

- [ ] **Step 5: 语法校验 + Commit**

```bash
node --check /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plugin-host.js
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/plugin-host.js && git commit -m "feat(phase1): speak config wiring, dedup, enum error codes, index metadata, beep RPC, prompt variable"
```
Expected: exit 0，commit 成功。

---

### Task 4: 探测包 pkg-5（client 形状 / 浏览器全局 / timer 服务 / variable context）

动态包不可分步运行：先部署"探测版"收集 client 形状与全局可用性，再在 Task 5/6 按真实形状实现。**探测只做安全操作**（内联 `typeof`、`Object.keys`、标量采样 ≤80 字符），绝不序列化 live 数据。

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（PROBE 节：`conversation.input.right` 常驻探测 + `conversation.chat.turnTail` 形状探测）
- Modify: `guide-dog-dsh/plugin-host.js`（`guide-dog/probe` RPC + variable context 探测）
- Regenerate: `guide-dog-dsh/plugin-source.js`

**Interfaces:**
- Consumes: Task 1/2/3 host 代码
- Produces: `~/.guide-dog/probe.json`：
  - `globals`: 内联 `typeof` 表达式（window/navigator/mediaDevices/MediaRecorder/AudioContext/WebSocket/fetch/document/Blob/**Blob.prototype.arrayBuffer**/btoa/URL/setInterval/clearInterval/Date/JSON/Promise/Object/String）——**禁止** `probeType(MediaRecorder)` 式先求值实参（审查 I5 修复）
  - `turnTail`: `{turnKeys, seq}` + `{snapshotKeys, messagesKeys, firstMessageKeys, contentKeys, textSample}`
  - `inputActions`: `{keys}`；`inputStateKeys`: `{keys}`
  - `timerSvc`: `{exists, keys}`（client `ctx.get('timer')` 探测）
  - `variableContextKeys`: host `systemPrompt.variable` 探针在下次提示词组装时写入的 context 键列表（审查 M7 修复）

- [ ] **Step 1: client PROBE 节（常驻 input.right 探测 + turnTail 形状探测）**

在 `plugin-client.js` 行 3 `const slots = ctx.get('slots')` 之后插入（探测包空会话也能上报——input.right 在 composer 可见即挂载，审查 M12 修复）：

```js
    // ============ PROBE 节（Task 4，pkg-5 专用；Task 5/6 实现后删除） ============
    function probeKeys(o) { try { return o ? Object.keys(o).slice(0, 40) : [] } catch (e) { return [] } }
    function reportGlobals() {
      // 内联 typeof：对未声明标识符恒安全（审查 I5：不得先求值实参）
      return {
        window: typeof window, navigator: typeof navigator,
        mediaDevices: typeof navigator !== 'undefined' && typeof navigator.mediaDevices,
        MediaRecorder: typeof MediaRecorder, AudioContext: typeof AudioContext,
        WebSocket: typeof WebSocket, fetch: typeof fetch, document: typeof document,
        Blob: typeof Blob,
        BlobArrayBuffer: typeof Blob !== 'undefined' && typeof Blob !== 'function' ? 'n/a' : typeof Blob.prototype.arrayBuffer,
        btoa: typeof btoa, URL: typeof URL, setInterval: typeof setInterval, clearInterval: typeof clearInterval,
        Date: typeof Date, JSON: typeof JSON, Promise: typeof Promise, Object: typeof Object, String: typeof String,
      }
    }
    function probeTimer() {
      var t = null
      try { t = ctx.get('timer') } catch (e) { t = null }
      return { exists: !!t, keys: probeKeys(t) }
    }
    // (a) 常驻探测：input.right 挂载即上报 globals/inputActions/timer（空会话可用）
    ctx.effect(function () {
      return slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'guide-dog-probe', order: 99, label: function () { return 'probe' } },
          function (props) {
            React.useEffect(function () {
              let inputState = null
              try { inputState = props.useInput() } catch (e) { inputState = null }
              host.call('guide-dog/probe', {
                report: {
                  globals: reportGlobals(),
                  inputActions: { keys: probeKeys(props.inputActions) },
                  inputStateKeys: { keys: probeKeys(inputState) },
                  timerSvc: probeTimer(),
                },
              }).catch(function () {})
            }, [])
            return null
          })
      })
    })
    // (b) 形状探测：turnTail 挂载即上报 turn/快照形状（需会话已有 turn）
    ctx.effect(function () {
      return slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          { name: 'conversation.chat.turnTail', select: function (owner) {
              if (!owner || !owner.turn) return null
              return { turnKeys: probeKeys(owner.turn), seq: owner.seq }
            } },
          function (props) {
            React.useEffect(function () {
              let snap = null
              try { snap = props.useSession() } catch (e) { snap = null }
              const list = snap ? (snap.messages || snap.turns || snap.nodes || []) : []
              const first = list[0] || {}
              const firstMsgKeys = probeKeys(first)
              let contentKeys = []
              let textSample = ''
              if (Array.isArray(first.content)) {
                const b0 = first.content[0] || {}
                contentKeys = probeKeys(b0)
                textSample = String(b0.text !== undefined ? b0.text : (b0.content !== undefined ? b0.content : '')).slice(0, 80)
              }
              host.call('guide-dog/probe', {
                report: {
                  turnTail: {
                    turnKeys: (props.matched && props.matched.turnKeys) || [],
                    seq: props.matched ? props.matched.seq : null,
                    snapshotKeys: probeKeys(snap), messagesKeys: probeKeys(list),
                    firstMessageKeys: firstMsgKeys, contentKeys: contentKeys, textSample: textSample,
                  },
                },
              }).catch(function () {})
            }, [])
            return null
          })
      })
    })
```

- [ ] **Step 2: host probe RPC + variable context 探测**

在 `guide-dog/beep` handler 之后插入：

```js
    ctx.effect(function () {
      try {
        return harness.handle('guide-dog/probe', async function (args) {
          try {
            const root = await guideDogRoot()
            let cur = {}
            const raw = await readTextFile(root + '/.guide-dog/probe.json')
            if (raw) { try { cur = JSON.parse(raw) } catch (e) { /* ignore */ } }
            await runRaw('mkdir -p ' + quote(root + '/.guide-dog'), { timeoutMs: 10000 })
            const next = Object.assign({}, cur, (args && args.report) || {})
            await writeTextFile(root + '/.guide-dog/probe.json', JSON.stringify(next, null, 2))
            return { ok: true }
          } catch (e) { return { ok: false, error: 'config_write_failed', message: String(e).slice(0, 200) } }
        })
      } catch (e) { return function () {} }
    })
    // variable context 形状探测：下次提示词组装时把 context 键列表并入 probe.json（审查 M7）
    if (systemPrompt && systemPrompt.variable) {
      systemPrompt.variable('guide_dog_probe_context', function (context) {
        const root = guideRoot || ''
        if (root) {
          try {
            readTextFile(root + '/.guide-dog/probe.json').then(function (raw) {
              let cur = {}
              if (raw) { try { cur = JSON.parse(raw) } catch (e) { /* ignore */ } }
              cur.variableContextKeys = probeKeys(context)
              return writeTextFile(root + '/.guide-dog/probe.json', JSON.stringify(cur, null, 2))
            }).catch(function () {})
          } catch (e) { /* ignore */ }
        }
        return undefined
      })
    }
```

（`probeKeys` 在 host 侧无定义——在 CONFIG 节补一行：`function probeKeys(o) { try { return o ? Object.keys(o).slice(0, 40) : [] } catch (e) { return [] } }`。）

- [ ] **Step 3: 重新生成 plugin-source.js 并校验**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh
{ echo '// ==== HOST HALF ===='; cat plugin-host.js; echo ''; echo '// ==== CLIENT HALF ===='; cat plugin-client.js; } > plugin-source.js
node --check plugin-host.js && node --check plugin-client.js && node --check plugin-source.js
```
Expected: 三处 exit 0。

- [ ] **Step 4: 部署 pkg-5（需审批）**

通过 cordis 工具：
- `cordis_define`：kind=`existing`，pluginId=`gdog-1`，name=`Guide Dog for DSH — Phase 1 probe (pkg-5)`，purpose=`探测 client 形状与浏览器全局，验证 host config/STT/speak 扩展`；`code.host` = plugin-host.js 全文，`code.client` = plugin-client.js 全文
- `cordis_run`：pluginId=`gdog-1`，packageId=返回的 pkg-5，mode=`update`

Expected: `starting`（双勾授权则自动；否则等待用户批准）。**不得**在 awaiting-approval 时重试。

- [ ] **Step 5: 收集探测结果**

等待 10–15 秒（input.right 条目在 composer 可见即上报；若当前无会话，先打开任意会话），然后：

```bash
cat /home/tt-wsl-ubuntu/.guide-dog/probe.json 2>/dev/null || echo "PROBE MISSING"
```
Expected: JSON 含 `globals / inputActions / inputStateKeys / timerSvc`；（有 turn 的会话还含 `turnTail`）。

- [ ] **Step 6: host 侧运行时验证**

```bash
echo "=== config ==="; cat /home/tt-wsl-ubuntu/.guide-dog/config.json 2>/dev/null
echo "=== status ==="; cat /home/tt-wsl-ubuntu/.guide-dog/status.json 2>/dev/null
echo "=== whisper script ==="; ls -la /home/tt-wsl-ubuntu/.guide-dog/scripts/ 2>/dev/null
echo "=== media index tail ==="; python3 -c "import json;d=json.load(open('/home/tt-wsl-ubuntu/.guide-dog/media/.index.json'));print(json.dumps((d[-1] if isinstance(d,list) else d),ensure_ascii=False)[:300])"
echo "=== tools ==="; # host Tool.listTools → 仍为 9 个 guide_dog_* 工具
```
Expected: config 含默认值且权限 600（`ls -l` 检查）；status 含 whisperAvailable；scripts 含 whisper_transcribe.py；媒体索引结构未破坏；工具集不变。

- [ ] **Step 7: 记录探测结论（决策门）**

```bash
python3 - <<'EOF'
import json
p = json.load(open('/home/tt-wsl-ubuntu/.guide-dog/probe.json'))
g = p.get('globals', {})
print('AUDIO_PATH =', 'A' if g.get('MediaRecorder') == 'function' and g.get('navigator') == 'object' and g.get('mediaDevices') == 'object' and g.get('BlobArrayBuffer') == 'function' else 'B')
print('CLIENT_BASE64 =', 'ok' if g.get('btoa') == 'function' and g.get('Blob') == 'function' else 'missing')
print('DATE =', g.get('Date'))
print('timerSvc =', p.get('timerSvc'))
print('turnKeys =', p.get('turnTail', {}).get('turnKeys'))
print('messagesKeys =', p.get('turnTail', {}).get('messagesKeys'))
print('contentKeys =', p.get('turnTail', {}).get('contentKeys'))
print('textSample =', p.get('turnTail', {}).get('textSample'))
print('inputActions =', p.get('inputActions', {}).get('keys'))
print('inputStateKeys =', p.get('inputStateKeys', {}).get('keys'))
EOF
# 另：触发一次模型回合后检查 variableContextKeys（Task 4 Step 2 的探针在下一次提示词组装时写入）
cat /home/tt-wsl-ubuntu/.guide-dog/probe.json | python3 -c "import json,sys; print('variableContextKeys =', json.load(sys.stdin).get('variableContextKeys'))"
```
Expected: 打印 AUDIO_PATH（A/B）、CLIENT_BASE64、DATE、timerSvc、全部形状与 variableContextKeys。**把输出逐字记录到 Task 5/6 的 Step 1 注释**（审查 I6：inputActions 方法名必须按探测结果回填）。

- [ ] **Step 8: Commit**

```bash
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/ && git commit -m "feat(phase1): pkg-5 probe package (client shapes, globals, timer svc, variable ctx)"
```

---

### Task 5: Client 语音模式（turnTail 自动发声 + dock 徽章 + 失败反馈）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（删除 PROBE 节；新增 VOICE MODE 节；**不声明 inject**，timer 经 `ctx.get('timer')` 可选使用——审查 C2 修复）

**Interfaces:**
- Consumes: Task 4 探测形状；Task 3 speak RPC（`{text, sessionId, turnSeq, source:'voice-mode'}`）；Task 1 get/set-config；Task 3 beep RPC；`h = React.createElement`（行 18 已有）
- Produces:
  - 模块级 `voiceState = { cfg, loaded, spoken: Set, lastError, errorAt, beepUri }`；`voiceEffective(sid)`；`loadVoiceCfg()`；`setVoiceOverride(sid, v)`
  - `conversation.chat.turnTail` 条目：select 粗筛（**无 spoken 检查**——select 拿不到 sessionId，去重只在组件内做，审查 M8 修复）；组件按 `props.sessionId` 精确判定 → speak RPC → 播放
  - `conversation.input.dock` 条目 id `guide-dog-voice-mode` order 30：徽章（点击切换会话 override）+ 失败提示（8s 过期，经 `timerSvc.interval` 每秒 tick，timer 不可用时仅在下一次渲染过期）+ 隐藏 `<audio autoPlay>`

- [ ] **Step 1: 记录探测形状（决策门注释）**

```js
    // 探测结论（Task 4 Step 7 输出）：
    // - 快照消息列表字段: <messagesKeys 实际值>
    // - content block 文本字段: <contentKeys 实际值>
    // - inputActions 方法: <实际 keys>（Task 6 依此显式选择；候选链为兜底）
    // - 录音路径: <Path A / Path B>
    // - timerSvc: <exists/keys>
    // - variableContextKeys: <实际值>
```

- [ ] **Step 2: 状态模块 + 自动发声钩子**

在 `const h = React.createElement`（行 18）之后插入：

```js
    // ============ VOICE MODE 节（Phase 1） ============
    const voiceState = { cfg: null, loaded: false, spoken: new Set(), lastError: null, errorAt: 0, beepUri: null }
    let timerSvc = null
    try { timerSvc = ctx.get('timer') } catch (e) { timerSvc = null }
    function voiceEffective(sid) {
      if (!voiceState.cfg || !voiceState.cfg.voiceMode) return false
      const vm = voiceState.cfg.voiceMode
      return sid && vm.sessions && vm.sessions[sid] !== undefined ? !!vm.sessions[sid] : !!vm.default
    }
    function loadVoiceCfg() {
      return host.call('guide-dog/get-config', {}).then(function (r) {
        if (r && r.ok && r.config) { voiceState.cfg = r.config; voiceState.loaded = true }
      }).catch(function () {})
    }
    function setVoiceOverride(sid, v) {
      const cur = (voiceState.cfg && voiceState.cfg.voiceMode && voiceState.cfg.voiceMode.sessions) || {}
      const sessions = Object.assign({}, cur)
      if (v) sessions[sid] = true; else delete sessions[sid]
      return host.call('guide-dog/set-config', { patch: { voiceMode: { sessions: sessions } } }).then(function (r) {
        if (r && r.ok) return loadVoiceCfg()
      }).catch(function () {})
    }
    function voiceTextOf(message) {
      const blocks = message && message.content
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const b of blocks) {
        if (b && typeof b.text === 'string') parts.push(b.text)
      }
      return parts.join('\n').trim()
    }
    ctx.effect(function () {
      loadVoiceCfg()
      host.call('guide-dog/beep', {}).then(function (r) { if (r && r.ok) voiceState.beepUri = r.dataUri }).catch(function () {})
      return slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          { name: 'conversation.chat.turnTail', select: function (owner) {
              // select 只收到 owner（{turn, seq, openFile}），无 sessionId：
              // 粗筛 = 配置已加载 且 任一会话语音模式可能开启；不做 spoken 去重（组件内做，审查 M8）
              if (!voiceState.loaded) return null
              if (!owner || !owner.turn || typeof owner.seq !== 'number') return null
              const vm = (voiceState.cfg && voiceState.cfg.voiceMode) || {}
              const anyOn = !!vm.default || Object.keys(vm.sessions || {}).some(function (k) { return !!vm.sessions[k] })
              if (!anyOn) return null
              return { seq: owner.seq }
            } },
          function (props) {
            const matched = props.matched || {}
            React.useEffect(function () {
              const sid = props.sessionId
              if (!sid || typeof matched.seq !== 'number') return
              if (!voiceEffective(sid)) return
              const key = sid + ':' + matched.seq
              if (voiceState.spoken.has(key)) return
              let snap = null
              try { snap = props.useSession() } catch (e) { snap = null }
              const list = snap ? (snap.messages || snap.turns || snap.nodes || []) : []
              let msg = null
              for (const m of list) { if (m && (m.seq === matched.seq || m.id === matched.seq)) { msg = m; break } }
              const text = voiceTextOf(msg)
              if (!text) return
              voiceState.spoken.add(key)
              host.call('guide-dog/speak', { text: text, sessionId: sid, turnSeq: matched.seq, source: 'voice-mode' }).then(function (r) {
                if (r && r.ok && r.url && !r.skipped) {
                  pendingPlay = { url: r.url, key: key }
                } else if (r && !r.ok) {
                  voiceState.lastError = (r.message || r.error || 'tts_failed')
                  voiceState.errorAt = typeof Date === 'function' ? Date.now() : 1
                }
              }).catch(function (e) {
                voiceState.lastError = String(e)
                voiceState.errorAt = typeof Date === 'function' ? Date.now() : 1
              })
            }, [matched.seq])
            return null
          })
      })
    })
    let pendingPlay = null // {url, key} —— 由 dock 徽章组件渲染为隐藏 <audio>
```

- [ ] **Step 3: dock 徽章 + 播放 + 失败提示**

在 VOICE MODE 节继续追加：

```js
    ctx.effect(function () {
      return slots.inject('conversation.input.dock', function () {
        return slots.register(
          { name: 'conversation.input.dock', id: 'guide-dog-voice-mode', order: 30, label: function () { return 'Voice mode' } },
          function (props) {
            const sid = props.sessionId
            const effective = voiceEffective(sid)
            const [tick, setTick] = React.useState(0)
            React.useEffect(function () {
              // timer 服务可选（探测确认）；不可用时不做每秒 tick，8s 过期退化为下次渲染
              if (!timerSvc || typeof timerSvc.interval !== 'function') return
              const stop = timerSvc.interval(function () { setTick(Date.now() % 100000) }, 1000)
              return function () { try { stop() } catch (e) { /* ignore */ } }
            }, [])
            const now = typeof Date === 'function' ? Date.now() : 0
            const err = (voiceState.errorAt && (now - voiceState.errorAt < 8000)) ? voiceState.lastError : null
            const badge = {
              display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none',
              borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 600,
              background: effective ? 'rgba(46,204,113,.15)' : 'rgba(128,128,128,.12)',
              color: effective ? '#27ae60' : '#888',
            }
            const tone = (err && voiceState.beepUri) ? h('audio', { autoPlay: true, src: voiceState.beepUri, key: 'tone-' + voiceState.errorAt, style: { display: 'none' } }) : null
            const player = pendingPlay ? h('audio', { autoPlay: true, src: pendingPlay.url, key: pendingPlay.key, style: { display: 'none' } }) : null
            return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' } },
              h('span', { style: badge, onClick: function () { setVoiceOverride(sid, !effective) } },
                effective ? '🔊 语音模式开' : '🔇 语音模式关'),
              err ? h('span', { style: { color: '#c0392b', fontSize: 12 } }, '朗读失败：' + err) : null,
              tone, player)
          })
      })
    })
```

- [ ] **Step 4: 语法校验 + Commit**

```bash
node --check /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plugin-client.js
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/plugin-client.js && git commit -m "feat(phase1): client voice mode (turnTail auto-speak, dock badge, failure tone, optional timer)"
```
Expected: exit 0，commit 成功。

---

### Task 6: Client 语音输入（麦克风按钮 + 转写 + 插入输入框）

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（新增 MIC INPUT 节）

**Interfaces:**
- Consumes: Task 4 探测的 AUDIO_PATH/CLIENT_BASE64 与 `inputActions` 方法（**决策门回填**，审查 I6）；Task 2 transcribe RPC（`{audioB64, mime, sessionId, language}`）；`voiceState.cfg`（autoSend/maxSeconds）
- Produces:
  - `conversation.input.right` 条目 id `guide-dog-mic` order 30：按钮（idle/recording/transcribing 三态）+ 语言三档切换 + 错误文案
  - Path A：MediaRecorder（`rec.start(1000)` timeslice；**秒数进 React state 触发重渲染**，审查 M9 修复；`ondataavailable` 强制 maxSeconds）
  - Path B（全局不可用）：渲染"打开录音页"链接（`/guide-dog/recorder`）
  - 插入：`insertText` 候选链，**全部未命中时报 `insert_failed` 错误，禁止静默**（审查 I6 修复）；提交：`submitInput` 候选链（autoSend 时调用）

- [ ] **Step 1: 决策门：按探测结果显式记录**

```js
    // 探测结论（Task 4 Step 7）：
    // - 录音路径 = <Path A | Path B>（windowCannotRecord() 运行时再判一次，含 Blob#arrayBuffer 检查）
    // - CLIENT_BASE64 = <ok | missing>
    // - inputActions 实际方法 = <keys 实际值>；插入主选 = <从 keys 中选出的方法名>，提交主选 = <选出的方法名>
    //   （下方候选链是兜底；若链全部未命中必须显示 insert_failed，不得静默）
```

- [ ] **Step 2: 实现 MIC INPUT 节**

在 VOICE MODE 节之后插入（模块级 `micRec`/`micChunks`/`micSeconds` 替代 useRef；秒数经 state 更新显示）：

```js
    // ============ MIC INPUT 节（Phase 1） ============
    let micRec = null // {rec, stream}
    let micChunks = []
    let micSeconds = 0
    function insertText(inputActions, text) {
      const set = inputActions.setValue || inputActions.setText || inputActions.replaceText || inputActions.append
      if (typeof set === 'function') { set(text); return true }
      const app = inputActions.appendText || inputActions.insert
      if (typeof app === 'function') { app(text); return true }
      return false
    }
    function submitInput(inputActions) {
      const sub = inputActions.submit || inputActions.send
      if (typeof sub === 'function') sub()
    }
    function windowCannotRecord() {
      var nav = null; try { nav = navigator } catch (e) { nav = null }
      var mr = null; try { mr = MediaRecorder } catch (e) { mr = null }
      var b64 = null; try { b64 = btoa } catch (e) { b64 = null }
      var bl = null; try { bl = Blob } catch (e) { bl = null }
      var ab = false
      try { ab = bl !== null && typeof bl.prototype.arrayBuffer === 'function' } catch (e) { ab = false }
      return !nav || !nav.mediaDevices || typeof mr !== 'function' || typeof b64 !== 'function' || typeof bl !== 'function' || !ab
    }
    ctx.effect(function () {
      return slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'guide-dog-mic', order: 30, label: function () { return 'Voice input' } },
          function (props) {
            const sid = props.sessionId
            const state = React.useState({ phase: 0, seconds: 0, lang: 'auto', error: null }) // 0 idle / 1 recording / 2 transcribing
            const s = state[0]; const set = state[1]
            if (windowCannotRecord()) {
              return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('a', { href: '/guide-dog/recorder', target: '_blank', style: { fontSize: 12, color: '#4a7dff', whiteSpace: 'nowrap' } }, '🎙 打开录音页'),
                h('span', { style: { color: '#888', fontSize: 11 } }, '浏览器沙箱限制，录音需在独立页面进行'))
            }
            const startRec = function () {
              try {
                navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
                  let rec = null
                  try { rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }) } catch (e) { rec = new MediaRecorder(stream) }
                  micChunks = []; micSeconds = 0
                  rec.ondataavailable = function (ev) {
                    if (ev.data && ev.data.size > 0) micChunks.push(ev.data)
                    micSeconds += 1
                    // 秒数进 state 触发重渲染（审查 M9）；maxSeconds 强制停止
                    set(function (prev) { return Object.assign({}, prev, { seconds: micSeconds }) })
                    const max = (voiceState.cfg && voiceState.cfg.voiceInput && voiceState.cfg.voiceInput.maxSeconds) || 60
                    if (micSeconds >= max && rec.state === 'recording') { try { rec.stop() } catch (e) { /* ignore */ } }
                  }
                  rec.onstop = function () { transcribe(set, s, sid, props.inputActions) }
                  rec.start(1000)
                  micRec = { rec: rec, stream: stream }
                  set(Object.assign({}, s, { phase: 1, seconds: 0, error: null }))
                }).catch(function () { set(Object.assign({}, s, { error: 'mic_denied' })) })
              } catch (e) { set(Object.assign({}, s, { error: 'mic_denied' })) }
            }
            const toggle = function () {
              if (s.phase === 1) {
                const r = micRec
                micRec = null
                if (r) { try { r.rec.stop() } catch (e) { /* ignore */ } try { r.stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ignore */ } }
                return
              }
              if (s.phase === 2) return
              startRec()
            }
            const cycLang = function () {
              const order = ['auto', 'zh', 'en']
              const i = order.indexOf(s.lang)
              set(Object.assign({}, s, { lang: order[(i + 1) % order.length] }))
            }
            const micStyle = {
              border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, lineHeight: 1,
              color: s.phase === 1 ? '#e74c3c' : '#888', borderRadius: 6, padding: 4,
            }
            const errText = {
              mic_denied: '麦克风权限被拒绝', empty_speech: '没听清，请再说一次',
              stt_failed: '转写失败', stt_timeout: '转写超时', engine_unavailable: 'STT 引擎不可用（见设置页）',
              insert_failed: '无法插入输入框（输入框接口不可用）',
            }[s.error] || null
            return h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' } },
              h('button', { onClick: toggle, title: s.phase === 1 ? '停止录音' : '语音输入', style: micStyle },
                s.phase === 1 ? '⏺' : (s.phase === 2 ? '⏳' : '🎙')),
              s.phase === 1 ? h('span', { style: { fontSize: 11, color: '#e74c3c' } }, s.seconds + 's') : null,
              h('button', { onClick: cycLang, title: '识别语言：' + s.lang, style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, color: '#888', padding: 2 } },
                { auto: 'AUTO', zh: '中', en: 'EN' }[s.lang]),
              errText ? h('span', { style: { fontSize: 11, color: '#c0392b' } }, errText) : null)
          })
      })
    })
    function transcribe(set, s, sid, inputActions) {
      const parts = micChunks
      micChunks = []
      if (!parts.length) { set(Object.assign({}, s, { phase: 0, error: 'empty_speech' })); return }
      try {
        const blob = new Blob(parts, { type: 'audio/webm' })
        blob.arrayBuffer().then(function (buf) {
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          set(Object.assign({}, s, { phase: 2, error: null }))
          return host.call('guide-dog/transcribe', { audioB64: btoa(bin), mime: 'audio/webm', sessionId: sid, language: s.lang })
        }).then(function (r) {
          if (r && r.ok && r.text) {
            const inserted = insertText(inputActions, r.text)
            set(Object.assign({}, s, { phase: 0, error: inserted ? null : 'insert_failed' }))
            if (inserted && voiceState.cfg && voiceState.cfg.voiceInput && voiceState.cfg.voiceInput.autoSend) submitInput(inputActions)
          } else {
            set(Object.assign({}, s, { phase: 0, error: (r && r.error) || 'stt_failed' }))
          }
        }).catch(function () { set(Object.assign({}, s, { phase: 0, error: 'stt_failed' })) })
      } catch (e) { set(Object.assign({}, s, { phase: 0, error: 'stt_failed' })) }
    }
```

- [ ] **Step 3: 语法校验 + Commit**

```bash
node --check /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plugin-client.js
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/plugin-client.js && git commit -m "feat(phase1): mic button voice input (state-driven seconds, insert_failed guard, arrayBuffer probe)"
```
Expected: exit 0，commit 成功。

---

### Task 6b: 录音页（仅 Path B 需要；Path A 时跳过并在 commit message 注明）

**Files:**
- Modify: `guide-dog-dsh/plugin-host.js`（`RECORDER_HTML` 常量 + 2 个 webServer 路由；插入在媒体路由注册处旁——行 355 `ctx.effect` 媒体路由块之后）

**Interfaces:**
- Consumes: `webServer.register`（**`kind:'prefix'` + 请求路径自判 + `res.writeHead`——与 v1 媒体路由一致**，审查 M5 修复）、`transcribeImpl`（Task 2）
- Produces: `GET /guide-dog/recorder` → 自含 HTML 录音页；`POST /guide-dog/transcribe-upload`（raw body audio/webm，**20MB 上限**）→ `{ok, text, language, error?}`

- [ ] **Step 1: RECORDER_HTML 常量与路由**

```js
    const RECORDER_HTML = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>Guide Dog 录音转写</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;text-align:center}
button{font-size:18px;padding:14px 28px;border-radius:10px;border:none;background:#4a7dff;color:#fff;cursor:pointer;margin:8px}
#status{color:#888;margin:12px 0}#out{white-space:pre-wrap;background:#f4f4f4;border-radius:8px;padding:14px;min-height:60px;text-align:left;display:none}
.err{color:#c0392b}</style></head><body>
<h2>🎙 Guide Dog 录音转写</h2>
<p>点击录音，说完后停止，文字会自动转写。</p>
<button id="rec">开始录音</button><button id="cp" style="display:none">复制文本</button>
<div id="status">空闲</div><div id="out"></div>
<script>
const b=document.getElementById('rec'),st=document.getElementById('status'),out=document.getElementById('out'),cp=document.getElementById('cp');
let mr=null,chunks=[];
b.onclick=async()=>{
  if(mr){mr.stop();return}
  try{
    const s=await navigator.mediaDevices.getUserMedia({audio:true});
    mr=new MediaRecorder(s);chunks=[];
    mr.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    mr.onstop=async()=>{
      const blob=new Blob(chunks,{type:'audio/webm'});
      st.textContent='转写中…';
      try{
        const r=await fetch('/guide-dog/transcribe-upload',{method:'POST',body:blob});
        const j=await r.json();
        if(j.ok&&j.text){out.style.display='block';out.textContent=j.text;cp.style.display='inline-block';st.textContent='完成（'+(j.language||'')+'）'}
        else{st.className='err';st.textContent=(j.message||j.error||'转写失败')}
      }catch(e){st.className='err';st.textContent='网络错误：'+e}
      s.getTracks().forEach(t=>t.stop());mr=null;b.textContent='开始录音';
    };
    mr.start(1000);b.textContent='停止';st.textContent='录音中…';st.className='';
  }catch(e){st.className='err';st.textContent='无法访问麦克风：'+e}
};
cp.onclick=async()=>{try{await navigator.clipboard.writeText(out.textContent);cp.textContent='已复制'}catch(e){out.select();document.execCommand('copy');cp.textContent='已复制'}};
</script></body></html>`
```

在媒体路由 `ctx.effect`（行 355–）之后插入（`kind:'prefix'` + `writeHead`，与 v1 一致；路径自判区分两个入口）：

```js
    ctx.effect(function () {
      if (!webServer) return function () {}
      try {
        return webServer.register({
          kind: 'prefix',
          path: '/guide-dog/recorder',
          handler: async function (req, res) {
            const raw = String(req.url || '/').split('?')[0]
            if (raw === '/guide-dog/recorder' && (req.method === 'GET' || req.method === 'HEAD')) {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              res.end(RECORDER_HTML)
              return
            }
            if (raw === '/guide-dog/transcribe-upload' && req.method === 'POST') {
              const chunks = []
              let total = 0
              for await (const c of req) {
                chunks.push(c)
                total += c.length
                if (total > 20 * 1024 * 1024) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"bad_args","message":"audio too large"}'); return }
              }
              const all = new Uint8Array(total)
              let off = 0
              for (const c of chunks) { all.set(c, off); off += c.length }
              const bin = new TextDecoder('latin1').decode(all)
              const r = await transcribeImpl({ audioB64: btoa(bin), mime: 'audio/webm', sessionId: '', language: 'auto' })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(r))
              return
            }
            res.writeHead(404); res.end(); return
          },
        })
      } catch (e) { return function () {} }
    })
```

- [ ] **Step 2: 语法校验 + Commit**

```bash
node --check /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plugin-host.js
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/plugin-host.js && git commit -m "feat(phase1): recorder page fallback for sandboxed client (prefix route, writeHead)"
```
Expected: exit 0，commit 成功。（运行时验证：curl `http://127.0.0.1:3080/guide-dog/recorder` 返回 HTML。）

---

### Task 7: 设置页扩展 + README

**Files:**
- Modify: `guide-dog-dsh/plugin-client.js`（`SettingsPage` 组件内，行 133 起；useEffect 实为行 137–143）
- Modify: `guide-dog-dsh/README.md`

**Interfaces:**
- Consumes: `guide-dog/get-config`、`guide-dog/set-config`、`guide-dog/status`
- Produces: 设置页新增区块——语音模式全局默认（radio 开/关）、语音输入（**引擎下拉** whisper/sherpa/minimax + 语言三档 + autoSend 复选框）、STT 状态（whisperAvailable/版本/python + 模型 select）

- [ ] **Step 1: SettingsPage 状态加载**

在 `SettingsPage` 的 `React.useEffect`（行 137–143）中追加：

```js
        host.call('guide-dog/get-config', {}).then(function (r) { if (alive && r && r.ok) set(Object.assign({}, s, { cfg: r.config })) }).catch(function () {})
        host.call('guide-dog/status', {}).then(function (r) { if (alive && r && r.ok) set(Object.assign({}, s, { status: r.status })) }).catch(function () {})
```

- [ ] **Step 2: 配置区块 UI**

在 SettingsPage 返回 JSX 的媒体画廊区块之前插入（`preStyle`/`rowStyle`/`badgeStyle`/`mutedStyle` 为 v1 已有样式常量）：

```js
        const reloadCfg = function () {
          host.call('guide-dog/get-config', {}).then(function (r) { if (r && r.ok) set(Object.assign({}, s, { cfg: r.config })) }).catch(function () {})
        }
        const setCfg = function (patch) {
          host.call('guide-dog/set-config', { patch: patch }).then(function (r) { if (r && r.ok) reloadCfg() }).catch(function () {})
        }
        const cfgBlock = s.cfg ? h('div', { style: preStyle }, [
          h('div', { style: rowStyle },
            h('span', { style: badgeStyle }, '语音模式'),
            h('label', null, h('input', { type: 'radio', name: 'vm-global', checked: !!s.cfg.voiceMode.default, onChange: function () { setCfg({ voiceMode: { default: true } }) } }), ' 全局默认开'),
            h('label', null, h('input', { type: 'radio', name: 'vm-global', checked: !s.cfg.voiceMode.default, onChange: function () { setCfg({ voiceMode: { default: false } }) } }), ' 全局默认关')),
          h('div', { style: mutedStyle }, '会话 override：输入框上方徽章点击切换（当前会话生效值以徽章为准）。'),
          h('div', { style: rowStyle },
            h('span', { style: badgeStyle }, '语音输入'),
            h('label', null, '引擎：', h('select', { value: s.cfg.voiceInput.engine, onChange: function (e) { setCfg({ voiceInput: { engine: e.target.value } }) } },
              h('option', { value: 'whisper' }, 'whisper（本地）'), h('option', { value: 'sherpa' }, 'sherpa（增强，待装）'), h('option', { value: 'minimax' }, 'minimax（保留位）'))),
            h('label', null, ' 语言：', h('select', { value: s.cfg.voiceInput.language, onChange: function (e) { setCfg({ voiceInput: { language: e.target.value } }) } },
              h('option', { value: 'auto' }, '自动'), h('option', { value: 'zh' }, '中文'), h('option', { value: 'en' }, '英文'))),
            h('label', null, h('input', { type: 'checkbox', checked: !!s.cfg.voiceInput.autoSend, onChange: function (e) { setCfg({ voiceInput: { autoSend: e.target.checked } }) } }), ' 识别后自动发送')),
          h('div', { style: rowStyle },
            h('span', { style: badgeStyle }, 'STT'),
            s.status ? h('span', { style: mutedStyle }, 'faster-whisper: ' + (s.status.whisperAvailable ? '可用 ' + ((s.status.whisperVersion || '') + ' / ' + (s.status.whisperPython || '')) : '不可用 — 需 pip install faster-whisper')) : null,
            h('label', null, ' 模型：', h('select', { value: s.cfg.voiceInput.whisper.model, onChange: function (e) { setCfg({ voiceInput: { whisper: { model: e.target.value } } }) } },
              h('option', { value: 'base' }, 'base（快）'), h('option', { value: 'small' }, 'small（准）')))),
        ]) : null
```

并将 `cfgBlock` 变量渲染进返回 JSX（在现有内容顶部）。

- [ ] **Step 3: 语法校验 + README + Commit**

```bash
node --check /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/plugin-client.js
```
Expected: exit 0。更新 `guide-dog-dsh/README.md`：Phase 1 功能清单、config.json schema、whisper 安装指引（`pip install faster-whisper`）、验证方法（引用本计划的 Task 9 命令）。

```bash
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/plugin-client.js guide-dog-dsh/README.md && git commit -m "feat(phase1): settings page voice-mode/STT controls (engine select), README phase1 docs"
```

---

### Task 8: 组装并部署 pkg-6（完整 Phase 1）

**Files:**
- Regenerate: `guide-dog-dsh/plugin-source.js`

**Interfaces:** Consumes: Task 1–7 全部代码；Produces: running pkg-6

- [ ] **Step 1: 重新生成 + 全量校验**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh
{ echo '// ==== HOST HALF ===='; cat plugin-host.js; echo ''; echo '// ==== CLIENT HALF ===='; cat plugin-client.js; } > plugin-source.js
node --check plugin-host.js && node --check plugin-client.js && node --check plugin-source.js && python3 -m py_compile scripts/whisper_transcribe.py
```
Expected: 全部 exit 0。

- [ ] **Step 2: 部署 pkg-6**

cordis 工具：
- `cordis_define`：kind=`existing`，pluginId=`gdog-1`，name=`Guide Dog for DSH — Phase 1 (voice mode + voice input)`，purpose=`硬指标语音模式（turnTail 自动发声）+ 语音输入（麦克风→whisper→输入框）+ 两层设置`；code.host = plugin-host.js 全文，code.client = plugin-client.js 全文
- `cordis_run`：pluginId=`gdog-1`，packageId=pkg-6，mode=`update`

Expected: `starting`；最终 running、currentPackageId=pkg-6。

- [ ] **Step 3: 结构验证**

```bash
# cordis_inspect_query:
#   client Slots root=conversation.input.right      → occupant id=guide-dog-mic（PROBE 条目已删）
#   client Slots root=conversation.input.dock       → occupant id=guide-dog-voice-mode (order 30)
#   client Slots root=settings.section              → occupant id=guide-dog
#   client Slots root=conversation.chat.turnTail    → 我们的 chain 条目（select 注册）
#   host Tool.listTools                             → 仍为 9 个 guide_dog_* 工具
cat /home/tt-wsl-ubuntu/.guide-dog/status.json 2>/dev/null
ls -l /home/tt-wsl-ubuntu/.guide-dog/config.json 2>/dev/null   # 权限应为 600
cat /home/tt-wsl-ubuntu/.guide-dog/config.json 2>/dev/null
```
Expected: 各 occupant 存在；status/config 正常；config 权限 600。

- [ ] **Step 4: Commit**

```bash
cd /home/tt-wsl-ubuntu/skills-repo && git add guide-dog-dsh/ && git commit -m "feat(phase1): assemble and deploy pkg-6 (voice mode hard metrics + voice input)"
```

---

### Task 9: Phase 1 验收（spec §5.4 五条）

**Files:** 无（运行验证）

**Interfaces:** Consumes: pkg-6；观测: `.index.json`、`config.json`、`status.json`、对话流

- [ ] **Step 1: 硬指标 1（机制保证，不依赖模型调用工具）**

```bash
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.guide-dog/config.json')
c = json.load(open(p)); c['voiceMode']['default'] = True
json.dump(c, open(p, 'w'), ensure_ascii=False, indent=2)
EOF
# 重启插件使 client 重载配置：cordis_run pluginId=gdog-1 packageId=pkg-6 mode=run
# 发送一条普通消息（要求模型：直接文字回复，不调用任何工具）
# 验证：媒体索引新增 voice-mode 条目，且该 turn 无 guide_dog_speak 工具调用
python3 - <<'EOF'
import json
idx = json.load(open('/home/tt-wsl-ubuntu/.guide-dog/media/.index.json'))
entries = idx if isinstance(idx, list) else idx.get('items', [])
vm = [e for e in entries if e.get('source') == 'voice-mode']
print('voice-mode entries:', len(vm))
for e in vm[-3:]: print(e.get('name'), '|', (e.get('spoken') or '')[:60])
EOF
```
Expected: `voice-mode entries >= 1`。

- [ ] **Step 2: 硬指标 2（文字与语音一致）**

```bash
python3 - <<'EOF'
import json
idx = json.load(open('/home/tt-wsl-ubuntu/.guide-dog/media/.index.json'))
entries = idx if isinstance(idx, list) else idx.get('items', [])
vm = [e for e in entries if e.get('source') == 'voice-mode']
if vm:
    last = vm[-1]
    print('spoken:', (last.get('spoken') or '')[:200])
    print('has fence:', '```' in (last.get('spoken') or ''))
EOF
```
Expected: spoken 为清洗后文本（无 ``` 围栏），与聊天可见文字语义一致。**人工**：播放 `http://127.0.0.1:3080/guide-dog/media/<name>` 确认朗读内容与聊天一致。

- [ ] **Step 3: 硬指标 3（失败必反馈；config.tts 已接线，审查 I3 修复）**

```bash
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.guide-dog/config.json')
c = json.load(open(p)); c['tts']['voiceEn'] = 'Invalid_Voice_XYZ'; c['tts']['voiceZh'] = 'Invalid_Voice_XYZ'
json.dump(c, open(p, 'w'), ensure_ascii=False, indent=2)
EOF
# 测试 turn：让模型调用 guide_dog_speak（"请朗读：测试失败反馈"）→ 工具结果应含错误码 tts_failed
#   （备选注入：直接给 guide_dog_speak 传 voice="Invalid_Voice_XYZ" 参数，等效）
# 再发一条普通消息 → dock 徽章应显示"朗读失败：..."（人工核对 UI）+ 失败提示音
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.guide-dog/config.json')
c = json.load(open(p)); c['tts']['voiceEn'] = 'English_expressive_narrator'; c['tts']['voiceZh'] = 'Chinese (Mandarin)_Gentle_Youth'
json.dump(c, open(p, 'w'), ensure_ascii=False, indent=2)
EOF
```
Expected: 工具结果含 `tts_failed` 错误码；徽章与提示音人工确认。

- [ ] **Step 4: 两层设置**

```bash
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.guide-dog/config.json')
c = json.load(open(p)); c['voiceMode']['default'] = False
json.dump(c, open(p, 'w'), ensure_ascii=False, indent=2)
EOF
# 重启插件（cordis_run run）；发普通消息 → 媒体索引不新增 voice-mode 条目
python3 - <<'EOF'
import json
idx = json.load(open('/home/tt-wsl-ubuntu/.guide-dog/media/.index.json'))
entries = idx if isinstance(idx, list) else idx.get('items', [])
print('voice-mode total:', len([e for e in entries if e.get('source') == 'voice-mode']))
EOF
# 人工：点击 dock 徽章开启会话 override → 徽章变"开"；bash 确认 config.json 的 voiceMode.sessions 出现当前会话条目
cat /home/tt-wsl-ubuntu/.guide-dog/config.json
```
Expected: 默认关时不自动发声；点击后 config 出现 sessions 条目且徽章状态切换。

- [ ] **Step 5: 语音输入**

```bash
# 已自动验证：whisper 脚本独立测试（Task 2 Step 4）
# 人工（用户）：
#  a) Path A：点击 composer 麦克风按钮 → 说话 → 停止 → 文本插入输入框（未自动发送）→ 编辑 → 发送
#  b) Path A：切换语言三档（自动/中/英）后录音，识别语言符合预期
#  c) 设置页开启"识别后自动发送"→ 录音 → 文本插入并立即发送
#  d) 浏览器拒绝麦克风权限 → 显示"麦克风权限被拒绝"
#  e) Path B：打开录音页 → 录音 → 转写 → 复制 → 粘贴发送
```
Expected: 全链路可用；错误路径有提示。

- [ ] **Step 6: 收尾**

```bash
mkdir -p /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/research
cat > /home/tt-wsl-ubuntu/skills-repo/guide-dog-dsh/research/phase1-acceptance.md <<'EOF'
# Phase 1 验收记录（2026-08-14）
<!-- 逐条填写 Task 9 各 Step 的实际输出与人工结论 -->
EOF
cd /home/tt-wsl-ubuntu/skills-repo && git add -A && git commit -m "test(phase1): acceptance record"
```
Expected: 验收记录文件生成并 commit。
