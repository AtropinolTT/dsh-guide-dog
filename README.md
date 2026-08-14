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
| `plugin-host.js` | Host half (tools, RPC, media route, prompt section) |
| `plugin-client.js` | Client half (tool cards + settings page) |
| `plugin-source.js` | Both halves concatenated for re-deployment |
| `README.md` | This file |

## Deploy

1. Create the plugin (host + client halves in ONE package):

   ```
   cordis_define  plugin.kind=new, idPrefix=gdog
                 code.host=<plugin-host.js>  code.client=<plugin-client.js>
   cordis_run     <pluginId> <packageId> run
   ```

2. Approve the Client-half activation in the web UI (single check mark). The
   Host half (tools, route, prompt section) activates with it.
3. Verify: the model's tool list contains `guide_dog_*`, and the Settings →
   **Guide Dog** page shows the mmx auth status.

After a harness restart the plugin is gone (dynamic plugins are process-local);
re-run the two commands above to restore it. `plugin-source.js` exists so you
can re-deploy without hunting through session history.

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

- Media lives in `<workspaceRoot>/.guide-dog/media` (inside the session
  workspace, so the `workspace-write` sandbox allows mmx to write there;
  no permission escalation needed).
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
- **Speak tester** — text + voice selector (from `guide-dog/voices`), plays the
  mp3 in the browser.
- **Recent media** — last 30 items from the index: image thumbnails (click to
  open full size), video tiles, audio players.

## RPC surface (Client → Host)

| Method | Args | Returns |
|---|---|---|
| `guide-dog/speak` | `{text, voice?, speed?, language?, playOnHost?}` | `{ok, url, file, voice, bytes}` |
| `guide-dog/list-media` | `{limit?}` | `[{name, kind, prompt, voice, ts, bytes, url}]` |
| `guide-dog/auth-status` | — | `{ok, method, source, keyMasked}` |
| `guide-dog/voices` | `{language?}` | `{ok, voices[]}` |

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
- **Cards show generic JSON** — the client half was not approved/loaded; approve
  the run and refresh the page.
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
