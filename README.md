# Guide Dog for DSH, powered by MiniMax

[![dsh-recommend](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2FAtropinolTT__dsh-guide-dog.certified.json)](https://github.com/zp-home/dsh-recommend)
[![dsh score](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2FAtropinolTT__dsh-guide-dog.json)](https://github.com/zp-home/dsh-recommend)

**English** | [简体中文](https://github.com/AtropinolTT/dsh-guide-dog/blob/main/README.zh-CN.md)

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
  settings page with auth status and a speak tester.
- **Skill integration** — `guide_dog_speak` reuses your existing
  [`audio-conversation`](https://github.com/your/audio-conversation) and
  [`speech-mmx`](https://github.com/your/speech-mmx) skill pipelines
  (text transform, CJK auto-detect, per-language voices, host playback),
  and falls back to raw `mmx speech synthesize` when the skill scripts are absent.
- **Automatic invocation** — a mounted system-prompt section
  (`guide-dog-vision`, order 110) tells the agent to auto-invoke the inspection
  tools for any job needing visual checks, especially when the active model
  cannot see images.
- **Call mode (Phase 2, shipped)** — hands-free, real-time voice conversation
  in the web UI: VAD / push-to-talk turn-taking, streaming sentence-level TTS
  with barge-in, consensus-first protection for write commands, progress
  announcements, and a unified floating dual-pill UI at the composer with
  zh/en i18n (details in "Phase 2 — call mode" below).
- **Accessibility mode (Phase 3, planned)** — an `a11y` config block is
  reserved (auto-narration, vision-cloud, summary-first); accessibility
  features are next on the roadmap and will be tested and rolled out after the
  call-mode shakeout.

## Featured

Guide Dog is featured in [dsh-recommend](https://github.com/zp-home/dsh-recommend),
a community-curated plugin directory for DSH. It passed the project's
certification review and carries the gold **certified** badge at the top of
this README; the score badge updates automatically on every registry sync.

## Files

| File | Purpose |
|---|---|
| `plugin-host.js` | Host half — **source of record** (tools, RPC, media route, prompt section, voice mode) |
| `plugin-client.js` | Client half — **source of record** (tool cards, settings page, voice cluster) |
| `bundle/` | Static web-profile bundle generated from the two halves (`deploy/convert_bundle.py`) |
| `deploy/` | `convert_bundle.py` (source → bundle) and `publish.py` (bundle → `~/.dsh/dsh-guide-dog` + web profile registration) |
| `package.json` | Root manifest declaring the `dsh.bundle` (makes the repo installable via `dsh plugin add`) |
| `README.md` | This file |
| `README.zh-CN.md` | Simplified-Chinese version of this README |

## Install

Install straight from this repository with the standard DSH plugin command —
the root `package.json` declares the `dsh.bundle` manifest, so the profile's
pnpm layer resolves the package itself (no npm publish required):

```sh
dsh plugin --profile web add github:AtropinolTT/dsh-guide-dog
```

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
- **Voice mode** — global default on/off radios (per-session override lives on
  the small speaker button at the input's bottom-left).
- **Voice input** — STT engine select (whisper / sherpa / minimax),
  recognition language (auto/zh/en), input device select (defaults to the
  system default), and auto-send-after-recognition checkbox.
- **STT** — faster-whisper availability + version/python, and the whisper model
  select (base/small).
- **Speak tester** — text + voice selector (from `guide-dog/voices`), plays the
  mp3 in the browser.

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
    "Voice mode: on/off · Global default: on/off".
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
  `🎙 Open recorder page` link to the standalone `/guide-dog/recorder` page
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
Guide Dog shows the Voice mode / Voice input / STT blocks.

## Phase 2 — call mode

### Feature list

- **WebSocket-free dual channel** — uplink is a whole-clip POST
  `/guide-dog/call-transcribe` (webm/opus, ≤20MB, reuses the Phase 1
  `transcribeImpl` and the local whisper pipeline) → `{ok, text, language,
  durationMs}`; downlink is `GET /guide-dog/tts-stream` over a chunked HTTP
  stream (the host spawns `mmx speech synthesize --stream --format pcm
  --sample-rate 24000` per sentence and pipes stdout incrementally into
  `res.write`; the client reads the stream with `fetch().body.getReader()`
  → PCM→WAV → seamless Web Audio scheduling). No new WebSocket protocol
  surface on the transport layer; browser and CLI reuse the same pipeline.
- **Automatic VAD + push-to-talk (PTT)** — default VAD (`call.mode='vad'`):
  MediaRecorder (`audio/webm;codecs=opus`, 250ms timeslice, continuous
  recording) + a parallel AnalyserNode energy detector (RMS ≥
  `vad.threshold`; silence for `vad.silenceMs` ends an utterance;
  `vad.minSpeechMs` minimum speech; `vad.maxSegmentSeconds` per-segment cap)
  — speak-pause-speak automatically becomes two turns; the panel can switch
  to `ptt` push-to-talk (hold the mic to talk, release to send; VAD
  parameters do not participate in endpointing, only in interruption
  monitoring).
- **Consensus-first (core interaction paradigm)** — active only when
  call/a11y is on; typing mode keeps the Phase 1 behavior: a prompt soft
  constraint (`guide_dog_call_consensus` systemPrompt variable, conversational
  wording: understand intent first, ask when unclear, explain before
  writing/modifying and wait for the user's go-ahead) plus a mechanical hard
  guarantee (`tools/pre-execute` waterfall interception: write/edit and
  destructive-bash heuristics rm/mv/cp/truncate/dd/overwriting-redirect/git
  push etc. → unconfirmed returns `{kind:'deny', reason:
  'needs_voice_confirmation'}` and the model asks by voice; user confirmation
  keywords hit → released for this turn; before every execution the host
  TTS-broadcasts a one-sentence summary built from the tool args (not through
  the model), then opens a `consensus.summaryWindowMs` interruption window;
  speech inside the window aborts the execution — the tool has physically not
  started). Interceptor failure → deny and announce "consensus check failed"
  (better to block wrongly than to allow wrongly, spec §6.8).
- **Progress announcements (minimalist principle, RC10)** — only useful
  information is announced: `agent/status` (running → "processing"),
  `tools/result` (tool name → phrase: write/edit → "modifying files",
  web_search → "searching the web", guide_dog_image/video/music/speak →
  "generating media", bash only for destructive commands (the same
  DESTRUCTIVE_BASH_RE as consensus) → "running a command"; read/grep/glob/
  skill/non-destructive bash/unknown tools stay silent), `agent/error`
  ("processing failed: <short reason>"); same-phrase 4s cooldown dedupe
  (multi-step same-kind operations announced once); >120s without any event
  during a call → heartbeat "still processing, please wait". Announcements
  and reply playback share one queue: announcements first (queue head),
  replies yield; announcements go through the **streaming channel** (the same
  WebAudio PCM chain as replies) → constructive serialization on a single
  player, one after another — overlap is impossible.
- **Streaming TTS** — reply text is split per sentence (`stream.sentenceSplit`
  charset `。！？.!?\n`; `stream.maxSentenceChars` force-truncates over-long
  sentences) and synthesized sentence by sentence; each sentence gets a fresh
  one-time token via `guide-dog/tts-token` (single-use, 5-minute validity,
  bound to sessionId); pre-synthesis between sentences (while the current
  sentence plays, the client requests the next sentence's stream ahead of
  time and appends decoded frames seamlessly on the playback-time chain — the
  next sentence continues before the previous one finishes; long replies are
  read in full with ≤400ms gaps). Measured ~600ms to first byte for short
  Chinese sentences, satisfying the "first audio <1.5s" criterion.
  **Only the turn's final message is played (RC13)**: intermediate assistant
  messages (with tool-call blocks) are not enqueued — playing near-identical
  text per step was the root cause of "the same content repeated";
  intermediate steps are covered by progress announcements. A terminal tool
  turn (the last message still has tool calls) is covered by the turn/end
  fallback that plays the buffered text — never silent.
- **Barge-in** — VAD detects user speech during playback (≥
  `vad.interruptMinMs` 300ms to avoid false triggers) → the browser
  immediately stops playback and clears the unplayed buffer → the stop is a
  10ms fade-out (RC13) — `src.stop()` hard cuts click at sentence boundaries.
  The first transcript segment after the interruption goes straight to the
  current turn via the `interrupt` RPC (`agent.steer`, RC11) instead of
  queueing as a new turn → abort the current `tts-stream` fetch → the new
  speech naturally becomes the next turn (Pipecat InterruptionFrame
  semantics).
- **Voice commands** — call transcriptions that hit the command table (pause,
  resume, repeat/say-again, slower/faster, look-at-screen [Phase 3 stub])
  execute locally and are not submitted to the conversation (stop/continue
  are consensus confirmation words, not in the command table — they pass
  through to the agent unchanged); `guide-dog/call-command` RPC provides
  host-side commands such as `clear-queue`.
- **Dual-channel mutual exclusion (RC13)** — text already spoken on the host
  speakers via `guide_dog_speak(playOnHost=true)` is not replayed through the
  voice-mode/call queue channels (consumed on use, the same text blocked
  once) — eliminates the "host + browser double sound".
- **Fault tolerance** — a stream interruption auto-reconnects once (at most
  one retry per (sid,text) within 5s, no retry on 429; a fresh token per
  sentence; failure toast "playback interrupted"); STT failure does not
  submit + beep + toast; TTS failure still lands the text + failure beep +
  panel error state (never silent); consensus-interceptor failure denies
  conservatively and announces the reason. Session ownership for call
  transcription/interruption/polling is captured once when the call starts
  (RC13) — multi-session switching no longer cross-talks.

### RC14 fixes (2026-08-17): announcement content selection + queue tail-truncation + progress dedupe + double-play pinpointing

- **Announcement sanitization (`sanitizeSpeechText`, F1)** — before
  enqueueing, reply text goes through a markdown/URL/emoji strip:
  `[title](url)` keeps the title, drops the URL; bare URLs (`https?://`,
  `www.`) are removed entirely; leading list/quote markers (`-`/`+`/`*`/`>`)
  and leading ordered-list markers (`1.` `1、` `1)`) are stripped; markdown
  markers such as `**bold**` and backticks are stripped; emoji ranges
  (`U+1F000-U+1FAFF` etc.) are stripped. Call mode reads only human language
  — no URLs/`**`/`-`/📢 metacharacters, so URL fragments like
  "thepaper/newsD/weather.com" are no longer read out in pieces.
- **Smart sentence splitting (`splitSentences`, F2)** — in the default
  separators `'。！？.!?\n'`, `.` follows a smart rule: split only when `.` is
  followed by whitespace + an uppercase letter/digit/CJK (`'Hello. Next'` → 2
  sentences; `'8.17 的上海'` stays 1; dots inside URLs are never split). The
  Chinese separator set gains `；;` so `…；` no longer cuts one Chinese reply
  into two halves.
- **Queue cap 40 with tail truncation (`VOICE_QUEUE_MAX`, F3)** — raised
  10→40, **drop from the tail to keep content**: on overflow `while
  (q.length > VOICE_QUEUE_MAX) q.pop()` (first-in content wins; the old
  `splice(0, …)` head-removal strategy cut the main content first while
  keeping URL fragments). announce/hb progress still use `pop()` (unshifted
  to the queue head, progress first).
- **30s progress-phrase dedupe window (F4)** — `announce`'s `progressDedupe`
  cooldown extended 4s→30s: web_search results ~4.3s apart no longer announce
  "searching the web" three times. The `progressDedupe` function body is
  untouched; `repro-progress.js` semantics preserved.
- **Dual-channel mutual exclusion by sanitized text (F5)** —
  `wasHostSpoken` / `markHostSpoken` uniformly use
  `sanitizeSpeechText`-processed text as the key: all three `wasHostSpoken`
  call sites (downlink, turn-end flush, voice-mode) match on the sanitized
  key; `speakImpl` registers both the raw and the sanitized key after a
  successful `playOnHost` (double key) so any downstream channel dedupes
  correctly. Known edge: when transform.py rewrites the text the two keys may
  differ slightly (acceptable edge).
- **Diagnostic instrumentation (F6, one-shot retest to pinpoint "reading
  twice")** — zero behavior change, logs only:
  - host (`[gd-host]`, visible in the DSH terminal):
    `enqueue from=downlink|turnend|voice-mode|consensus|announce|heartbeat n=... qlen=...`,
    `shift key=... remain=...`, `skip host-spoken sid=... text=...`,
    `QUEUE-DUP text=...`.
  - client (`[gd]`, browser DevTools): `playStreamEntry ... times=...`
    (accumulates per `entry.key || entry.text` on each play),
    `PLAY-SUMMARY key=N | ...` (when the queue empties, summarizes all current
    counts then clears).
  - Retest calibration (basis for the RC15 direction): `QUEUE-DUP` → host
    double-enqueue; `PLAY-SUMMARY key=2` → client double-play; neither but
    still twice → tts-stream double audio write; `enqueue from=` same source
    twice with the same text → event replay.

### RC15 fixes (2026-08-17): persistent player + gesture unlock + failed-entry requeue + event-replay dedupe

- **Persistent voice player (`playVoiceEntry`, F1)** — voice-mode playback
  changed from "new Audio() + temporary URL each time" to **fetch + Blob +
  single-element reuse**: the whole clip is fetched once into a `Blob`, bound
  via `URL.createObjectURL` to a **single** `<audio>` element; later entries
  only replace `src` and the playback callbacks — no more repeated
  Audio-object creation/destruction, which eliminates the
  `ERR_CONTENT_LENGTH_MISMATCH` retry storm (each Audio rebuild replays the
  pre-mismatch portion; with long audio this looked like "repeated replay +
  stutter").
- **Gesture unlock + blocked-pending retry (F2)** — under the browser
  autoplay policy the first play may be blocked (`play()` rejected): enter a
  "pending playback" state, bind the first user gesture
  (`click`/`keydown`/`touchstart`, capture phase, persistent listener) and
  continue automatically; blocked entries are no longer dropped — they replay
  after the gesture. `stopCurrent` now correctly releases `busy` and requeues
  (prevents a busy deadlock from swallowing entries).
- **Failed-entry requeue RPC (`voice-requeue`, F3)** — on playback failure
  (decode/network/blocked) the client calls the host `voice-requeue` RPC to
  re-enqueue the entry (`requeueEntry` pure function: new text inserts,
  duplicate text skips, tail pop truncates), max 3 retries per entry
  (`attempts` map) — no more lost content.
- **Event-replay 10s text-window dedupe (`replayDup`, F4)** — host enqueue
  for the "call downlink + voice mode" channels gains a 10s last-text dedupe
  window (`lastStreamText`/`lastVoiceText` maps): the same text enqueued
  again within 10s is skipped (`[gd-host] skip replay text=` /
  `[gd-host] skip voice-dup text=` instrumentation). Root cause: event
  replay on voice mode + call downlink enqueued the same text twice — the
  male-voice reply repeated "7 times" because this window was missing.
- **url-entry play counts (F5)** — `PLAY-SUMMARY` summary logs cover
  voice-mode entries (`playCounts` keyed by `entry.key || entry.url`,
  summarized and cleared when the queue empties) — url-entry play counts are
  trackable; retest pinpointing no longer relies on guessing.
- **Build marker** — the client build tag was bumped to `rc15-20260817` at
  the time (`plugin-client.js` source and `bundle/lib/client.js` in sync;
  visible in the DevTools console after a hard refresh; since superseded —
  the current tag is `rc20-20260817`).

### config.json schema (Phase 2: call / a11y)

New keys added on top of the Phase 1 config
(`~/.dsh/guide-dog/.guide-dog/config.json`); all optional, deep-merged over
defaults (spec §4 copy):

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

- `call.mode`: `vad` (default, automatic endpointing) | `ptt` (push-to-talk).
- `call.vad.method`: `energy` (Phase 2 v1, RMS energy threshold; raise
  `threshold` in noisy environments) → upgrade slot `silero` (web-vad
  browser WASM) / `sherpa` (VAD+ASR integrated).
- `call.stream.format/sampleRate`: `mmx speech synthesize --stream` args
  (s16le mono PCM; 24000 is the explicit override — mmx's own default is
  32000).
- `call.consensus`: `enabled` toggles consensus-first (effective only in
  call/a11y); `summaryWindowMs` is the window that waits for the user to
  interrupt after the summary announcement.
- `a11y`: Phase 3 accessibility-mode config (this stage only `enabled`
  participates in the call streaming/consensus decisions;
  `autoNarrate`/`visionCloud`/`summaryFirst` are reserved for Phase 3).

### Routes (Phase 2)

| Method & Path | Purpose |
|---|---|
| `POST /guide-dog/call-transcribe` | Uplink: whole-clip audio (the client sends a raw `audio/webm` body with an `x-session-id` header; the host base64s the whole body and hands it to whisper), hard cap ≤20MB; the host reuses the Phase 1 `transcribeImpl` → `{ok, text, language, durationMs}` |
| `GET /guide-dog/tts-stream?token=…&sid=…&text=<sentence>` | Downlink: chunked PCM audio stream (`content-type: audio/pcm`, `cache-control: no-store`); requires a one-time token issued by `guide-dog/tts-token` — missing/wrong token → 403, in-flight stream for that session → 429 |

RPC-style endpoints (`tts-token` / `call-active` / `call-command`) go through
the same JSON POST compatibility layer; their physical URL is
`/guide-dog/api/guide-dog/<name>` (double prefix, same as the Phase 1
`guide-dog/status` example) — see the three new rows in the RPC surface table
below.

### Verification

```
node --check bundle/lib/index.js && node --check bundle/lib/client.js       # bundle syntax ×2
curl -s -X POST http://127.0.0.1:3080/guide-dog/call-transcribe \
  -H 'content-type: application/json' -d '{}' | head -5                    # uplink route reachable (empty audio → error JSON)
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3080/guide-dog/tts-stream?token=bad&sid=x&text=hi'      # invalid token → 403
```

Manual acceptance checklist (full criteria in
`specs/2026-08-14-guide-dog-v2-design.md` §6.9; verify item by item after
deploying and restarting DSH):

1. VAD: speak-pause-speak becomes two separate turns; silence detection does
   not cut wrongly (`threshold` adjustable).
2. Turn loop: voice → transcription → submit → agent execution (incl. tool
   calls) → reply read aloud; an end-to-end "use voice to have the agent
   generate an image / search" completes.
3. Barge-in: speaking during playback stops it; the next turn works.
4. Progress announcements: at least one stage announcement while the agent
   runs a tool.
5. Stream safety: non-allowlisted Origin and missing/wrong tokens rejected;
   recovery after a dropped-stream reconnect.
6. Full streaming: long replies read in full; "repeat / pause / slower"
   commands work; first-audio latency ≤1.5s, playback gaps ≤400ms (measured).
7. Consensus-first: voice "change X in README to Y" → not executed
   immediately → voice confirmation → after confirmation a short summary is
   heard before every write; speaking during the summary aborts that
   execution and the user's speech becomes a new turn; an unconfirmed
   write/edit is blocked (check the `tools/pre-execute` interception path).
8. Ambiguous intent (e.g. "change that file" without context) → the agent
   asks the key question by voice instead of guessing; the user asking "why
   change it?" → the agent explains by voice.
9. PTT: hold to talk / release to send; the mode switch takes effect in VAD
   mode.

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
- **`MiniMax-H3` returns "TokenPlan or Credit does not yet support the
  MiniMax-H3 model family"** — the account's MiniMax plan does not include the
  H3 model family. Use `model: "MiniMax-Hailuo-2.3"` (legacy V1) or upgrade
  the plan. The plugin surfaces the API error verbatim (the message may appear
  in Chinese), so this is visible in the tool result.
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
