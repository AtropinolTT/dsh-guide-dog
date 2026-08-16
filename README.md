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
