# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SubFlow

Real-time speech captioning desktop app. Captures system audio, transcribes with local ASR (NVIDIA Parakeet or natively-streaming Nemotron, both via sherpa-onnx) or a self-hosted remote Parakeet inference server, optionally translates via LLM (OpenAI-compatible, Anthropic, or Google AI Studio API). Displays subtitles in a floating overlay window. Audio never leaves the machine unless the remote provider is selected.

## Build Commands

```bash
# Frontend (TypeScript + React + Vite)
npm run build:frontend        # tsc (main + preload) + vite build
npm run dev                   # watch mode with concurrent tsc + vite + electron

# C++ backend (native Linux)
npm run build:backend         # cmake + make

# C++ backend (Windows cross-compile from Linux via MinGW)
npm run build:backend:mingw   # uses scripts/build-backend-mingw.sh
BUILD_JOBS=10 npm run build:backend:mingw  # override parallel jobs

# Full distribution
npm run dist                  # Linux: AppImage + deb + rpm
npm run dist:win:linux        # Windows: portable exe + zip (cross-compiled on Linux)
npm run start                 # build frontend + run electron

# Type checking only
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.preload.json --noEmit
```

No test framework is configured.

## Architecture

Three-process model:

1. **C++ Backend** (`src/backend/`) — Standalone executable (`subflow-backend`). Captures audio (PipeWire on Linux, WASAPI on Windows) at per-application or device level, transcribes via one of three providers, broadcasts transcripts over a local WebSocket server on port 9876. The `--provider` CLI arg selects which transcriber to use (unknown values fall back to local Parakeet). `ParakeetTranscriber` runs sherpa-onnx offline ASR locally with simulated streaming (Silero VAD + periodic re-decode); `NemotronTranscriber` runs sherpa-onnx's OnlineRecognizer for cache-aware natively streaming models (no VAD, the model reports its own endpoints); `RemoteParakeetTranscriber` streams audio to a remote Parakeet server and receives transcripts back. WebSocket clients go through the Boost.Beast layer in `src/backend/net/` (see Networking). Per-app capture uses PipeWire node targeting on Linux and `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` on Windows (requires Build 20348+).

2. **Electron Main Process** (`src/frontend/main/`) — Spawns the C++ backend, connects to it via WebSocket (`WsClient`), manages three Electron windows, handles config persistence, and runs LLM translation.

3. **React Renderer** (`src/frontend/renderer/`) — Three windows: control panel, overlay (floating subtitles), history (scrollable transcript). Communicates with main process via IPC through a preload bridge.

### Control-panel structure

The sidebar is the signal path, not a list of categories: `sources → denoise → recognition → translation → output`, numbered and drawn on a bus, followed by unnumbered tools (history, logs, about). Every setting lives on the stage it configures — source language belongs to recognition, subtitle display mode to output.

Each stage reports one of four modes (`App.tsx: stageInfo`): `active`, `bypass` (switched off on purpose — the signal passes through, so the bus stays solid), `waiting` (nothing chosen yet) and `fault` (enabled but unusable). Only `fault` is red. Two derived flags drive the visuals and are deliberately computed differently: `carries` is **local** — whether this stage's own path is intact, so one unset stage does not blank the rest of the rail — while the flow pulse is **cumulative**, since data that cannot get past a broken stage is not flowing downstream of it.

Above the pages sits a monitor: scope (fed by `audio_level`), level/peak, recognition latency, dropped audio, and the latest caption. Every readout is measured; nothing there is decorative.

Two rules carry the visual design and are documented at the top of `control-panel.css`: only the signal is coloured (`--accent` = signal present, `--danger` = broken; "success" and "warning" both resolve to the accent), and only human speech gets a proportional typeface (the UI is IBM Plex Mono, Archivo is reserved for transcripts and names). Neither family covers CJK, so Chinese and Japanese fall through to the system stack in both roles.

### Speech enhancement (denoising)

`Denoiser` class in `denoiser.cpp` wraps sherpa-onnx's `OnlineSpeechDenoiser` C API. Inserted in the pipeline loop between `buffer_.read()` and `transcriber_->feed_audio()`. Supports GTCRN and DPDFNet model architectures — the architecture is selected based on the `architecture` field in `src/shared/denoise-models.json` (model registry shared by backend and frontend). Models are downloaded on demand by the Electron main process (`denoiser-manager.ts`) and stored in `{configDir}/models/`. The backend receives model path + architecture via `SET_DENOISE` WebSocket command or `--denoise*` CLI args. Denoising can be toggled at runtime without restarting the backend.

Pre-built sherpa-onnx libraries are downloaded by `scripts/setup-sherpa-onnx.sh` into `extern/sherpa-onnx/` (gitignored). Linux uses static linking; Windows uses shared DLLs with MinGW import libraries generated via `objdump` + `dlltool`.

### Local ASR (Parakeet)

`ParakeetTranscriber` in `parakeet_transcriber.cpp` uses sherpa-onnx's offline recognizer API for local speech-to-text with NVIDIA Parakeet models. Since Parakeet models are non-streaming (full-attention FastConformer), real-time output is achieved via **simulated streaming**: Silero VAD detects speech segments on the pipeline thread; a dedicated decode thread runs periodic partial re-decodes (~200ms intervals) during active speech and final decodes when VAD closes the segment.

Two model families are supported: `nemo_ctc` (single `model.int8.onnx`, e.g. Japanese) and `nemo_transducer` (encoder + decoder + joiner, e.g. V3 multilingual). Model registry is in `src/shared/parakeet-models.json`. Models are downloaded as tar.bz2 archives and extracted via pure-JS `unbzip2-stream` + `tar-stream` (cross-platform, no system `tar` dependency). The Silero VAD model (`silero_vad.onnx`, ~629KB) is auto-downloaded alongside the first Parakeet model. Download and extraction are managed by `parakeet-manager.ts`.

`--parakeet-threads` (default 4) is a deliberately separate constructor argument rather than part of `ParakeetVadParams`: the VAD params are replayed live through `set_vad`, while ORT's thread count is fixed when the recogniser is built, so carrying it there would promise a change the recogniser cannot make. It is also the opposite kind of cost from the streaming provider's thread setting — this decoder only runs while VAD holds a segment open, so lowering it saves nothing during silence and shows up directly as later interim text. The panel says so, because copying Nemotron's "lower to cut idle draw" reasoning here would be wrong.

The backend receives model dir, type, and VAD model path via `--parakeet-model-dir`, `--parakeet-model-type`, `--parakeet-vad-model` CLI args.

### Streaming ASR (Nemotron)

`NemotronTranscriber` in `nemotron_transcriber.cpp` runs NVIDIA Nemotron 3.5 (cache-aware streaming FastConformer, 128 mel bins) over sherpa-onnx's OnlineRecognizer. These models stream natively and report their own endpoints, so there is no VAD to load and nothing to re-decode — the counterpart to Parakeet's simulated streaming, not a replacement. One dedicated decode thread owns the stream outright (sherpa's OnlineStream is not safe against `AcceptWaveform` racing `Decode`, and decoding on the pipeline thread would stall capture). The model type is left unset so sherpa reads the variant from the encoder's ONNX metadata.

Endpointing is rule-based on the decoder's own trailing blanks, not a VAD: `--nemotron-min-silence` (trailing silence that ends an utterance) and `--nemotron-max-utterance` (force-cut) are the provider's own settings, exposed as sliders on its panel; VAD-only concepts (threshold, min-speech, partial interval) have no counterpart here. sherpa ORs three endpoint rules and the smallest decides, so the one setting feeds rule2 directly and rule1 through a floor at rule1's own default: leaving rule1 alone silently capped the slider at that default, but lowering it is worse than the cap, because "trailing silence" is counted in trailing *blanks* and speech the model has not yet committed to a token counts as silence — a rule1 below the emission delay resets the stream in the middle of the onset it is still deciding. The floor bounds that for plain silence only: rule2 can be woken by an emitted language tag, which sherpa strips back out of the text, so a short setting still reaches the same empty-text reset — which is why the default is 1.2s rather than something aggressive. The default is sherpa's 1.2s rather than the VAD's 0.5s because an endpoint is not free for this model: sherpa's NeMo implementation reinitialises the encoder cache on every `Reset`, so a cut costs the left context the cache exists to provide, on top of fragmenting captions and handing the translator half sentences. Accuracy is this provider's weak side generally — one 0.6B checkpoint spanning 33 locales loses to the Japanese-only Parakeet on Japanese by a wide, measured margin, and on CJK the larger chunk variants are worth their latency. `--nemotron-threads` defaults to 2 — measured, because a streaming encoder runs continuously and silence costs the same as speech, so this is the machine's idle draw whenever capture is on.

The model registry is `src/shared/nemotron-models.json` (five chunk-size variants of one model; four files each: `encoder/decoder/joiner.int8.onnx` + `tokens.txt`), downloaded by `nemotron-manager.ts`. The source language is set per-stream via `SetOption("language", ...)`: the model's prompt dictionary holds region-qualified locales, and an unknown string quietly falls back to auto-detect, so `toNemotronLanguage` maps the UI's bare codes onto registry entries (bare code → first regional variant, derived from the registry so it cannot drift) and **every** path that hands a language to a nemotron backend goes through it — spawn, provider switch, panel apply, and reconnect replay. Any nemotron setting change restarts the backend; there are no live commands for this provider (`set_vad` is not routed to it).

### Networking (`net/`)

C++ WebSocket clients are unified on **Boost.Beast** behind a Boost-free interface: `net::WsClient` (`ws_client.h` + `beast_ws_client.cpp`, async single-IO-thread, ws+wss, reconnect). The remote-Parakeet client is its only user. Boost is header-only and vendored by `scripts/setup-deps.sh` into `extern/boost/` (gitignored); the backend CMake `FATAL_ERROR`s without it. `subflow_net` is a STATIC lib linked into `subflow-backend`.

Note on `extern/` provenance: the **entire `extern/` directory is gitignored** — nothing under it is committed (there are no git submodules). Two scripts reproduce it from pinned upstream versions: `scripts/setup-deps.sh` `git clone`s uWebSockets (release tag `v20.76.0`) + its `uSockets` dependency (only `uSockets` is fetched, not the `fuzzing`/`h1spec`/`libdeflate` nested submodules), downloads the nlohmann/json single header (`v3.11.3`), and downloads the header-only **Boost** subset into `extern/boost/` (Boost is a tarball download because its superproject is ~166 nested submodules + a `b2 headers` generation step); `scripts/setup-sherpa-onnx.sh` fetches sherpa-onnx separately (platform-specific, called with a `<target>`). The build scripts auto-run `setup-deps.sh` when a dependency is missing.

### Remote Parakeet (`remote_parakeet` provider + standalone server)

`RemoteParakeetTranscriber` (`remote_parakeet_transcriber.{h,cpp}`) is a thin client over `net::WsClient`: it streams 16 kHz mono int16 PCM binary frames to a remote server and parses JSON transcript frames back. The server is selected via `--remote-parakeet-url` (`ws://`/`wss://`), `--remote-parakeet-api-key` (optional Bearer), and `--remote-parakeet-model` (server model id, sent as `?model=<id>` on the WS URL). Server-side VAD is tuned per connection: the client sends a `set_vad` control frame on connect and on change, reusing the same `--parakeet-vad-*` CLI args / `ParakeetVadParams` as the local provider (no restart).

The **standalone server** lives in the top-level `server/` directory (a separate deliverable, NOT under `src/backend/`; built with `server/build.sh` → `subflow-parakeet-server`, Linux-only, own `CMakeLists.txt`, no Boost/OpenSSL/pipewire). Architecture: a `ModelRegistry` holds one shared `ParakeetModel` (recognizer) + `DecodeScheduler` (batched, single dispatcher thread) **per model id**, loaded lazily on first use and shared across all connections (model RAM is O(models), not O(clients)); each connection gets its own `ParakeetSession` (own Silero VAD + worker thread, mirroring the local transcriber's create/rebuild/destroy). It serves over uWebSockets: `GET /models` lists models, `GET /healthz`, `GET /metrics`, and `/*` upgrades to WS (Bearer auth + `?model=` validated at upgrade). Config is a single JSON (auto-loaded from `<exe-dir>/config/config.json` or `./config/config.json`, or `--config <path>`; CLI flags override individual fields) holding all server settings + the model list; relative paths resolve against the config file. See `server/config.example.json`. Note: sherpa's VAD bundles model+state per ORT session and cannot be shared across concurrent streams, so each live session holds its own VAD (~17 MB) — only the recognizer is shared.

### Data flow

```
Audio Source → C++ Backend → [optional sherpa-onnx denoise]
  → Local STT (parakeet): [Silero VAD → Parakeet offline decode (dedicated thread)] → transcript JSON
  → Local STT (nemotron): [OnlineRecognizer streaming decode (dedicated thread), model endpoints itself] → transcript JSON
  → Remote STT: [int16 PCM → remote Parakeet server (server-side VAD + shared recognizer)] → transcript JSON
  → Electron Main (WsClient) → [optional LLM translation] → IPC → Renderer windows
```

### IPC patterns

- **Renderer → Main**: `window.electronAPI.*` calls defined in `preload.ts`. Uses `ipcRenderer.send` (fire-and-forget) for commands, `ipcRenderer.invoke` (request-response) for queries.
- **Main → Renderer**: `safeSend(window, channel, data)` broadcasts.
- **Main ↔ Backend**: JSON messages over WebSocket. Protocol defined in `src/backend/ipc/protocol.h`. Commands: `select_source`, `set_language`, `set_denoise`, `set_vad`, `start`, `stop`, etc.
- **Backend liveness** is pushed to the renderer on `backend-state` (`connecting | connected | disconnected | restarting | exited`) and is also queryable via `get-backend-state`, because the control panel is created after the socket connects and would otherwise miss the first event. Without it a dead backend left the UI rendering the last status frame forever.

### Config system

`UnifiedConfigManager` in `unified-config.ts` manages all settings in a single `config/subflow-config.json` file. Sections: `provider`, `parakeet`, `nemotron`, `remoteParakeet`, `translator`, `app`, `ui`, `windowPositions`, `denoiser`. The `provider` field (`"parakeet"`, `"nemotron"` or `"remote_parakeet"`) selects which STT service to use; an unrecognised value is rewritten to `"parakeet"` on load and any unknown section pruned, so a config from an older build cannot select a transcriber that no longer exists. `nemotron` holds `modelId`, `numThreads` and the two endpoint rules (`minSilence`, `maxUtterance`); writes go through the same clamping merge as loads. `remoteParakeet` holds `serverUrl`, `apiKey`, `model`, and `vad` (per-client VAD tuning). Auto-migrates from legacy per-file configs on first run. Config directory varies by platform: repo root (dev), next to exe (Windows packaged), `~/.config/subflow_settings` (Linux packaged). (This app config is unrelated to the standalone server's own `config/config.json`.)

### Update check (`updater.ts`)

Checking, not installing — deliberately, on both platforms. Of the five artifacts this project ships (Windows portable + zip, Linux AppImage + deb + rpm) only the AppImage has an in-place update path, so an "auto-update" would have to be a lie in the other four cases; `UpdateChecker` therefore reads `releases/latest` from the GitHub API, compares the tag against `app.getVersion()`, and hands the panel a version number plus the release URL. Nothing is downloaded and nothing is executed, which is also why no packaging target had to change (NSIS, which electron-updater would require on Windows, is not built).

`compareVersions` is dotted-numeric with the semver prerelease rule, because a string compare puts 0.0.10 *below* 0.0.9. A check in flight is returned rather than started twice — the startup check and a click on the button overlap easily and the second request only spends the rate limit. The status is pushed on `update-status` **and** queryable via `get-update-status`, for the reason `backend-state` is: the startup check (6 s after the windows exist, deliberately late and unattended) usually completes before the control panel mounts. A failed check never raises a dialog — it is nearly always a network that isn't there — and its reason (`offline`, `rate_limited`, `no_release`, `unreadable`, `http`) is carried as a code the renderer phrases, not as an English string from the main process. `checkUpdatesOnStartup` in the config's `app` section turns the automatic one off; the button stays.

On the About page the feature is uncoloured on purpose: a newer version is neither signal nor fault, so per `control-panel.css`'s first rule it gets no accent and no red. The notification is the version number itself, rendered in the nav where the history count and error count sit.

### Transcript record

The main process owns the transcript (`transcript-log.ts`) and both history views mirror it, so the control panel's tab and the floating window cannot drift in content, length or partial handling, and clearing is one operation both observe. Owning it is what makes export possible: SRT uses the backend's real media timestamps (`t0`/`t1`, populated by both Parakeet transcribers), gives a zero-length cue a readable minimum rather than emitting it unrenderable, excludes interim lines, and writes a translation as a second line of the same cue.

### Translation

`Translator` class in `translator.ts` supports OpenAI-compatible (`/v1/chat/completions`), Anthropic (`/v1/messages`), and Google AI Studio (Gemini/Gemma `:generateContent`) APIs, selected by the `apiFormat` field (`'openai'` | `'anthropic'` | `'google'`). Features: in-flight deduplication, sliding window history context, scene-specific prompts. Translation happens in the Electron main process, not the C++ backend. The Google path is special-cased: instruction-tuned Gemma models reason verbosely and bury the translation in chain-of-thought, so the request constrains the output grammar via `responseMimeType: application/json` + `responseSchema` (parsed back to the translation), with a sentinel-delimited prompt fallback for models that reject structured output. API keys are stored **per format** (`apiKeys` map keyed by `apiFormat`) so switching provider doesn't clobber the others; the flat `apiKey` field mirrors the active format for backward compat. The main-process transcript handler (`index.ts`) only sends **final** transcripts to the translator by default — interim/partial transcripts are translated only when `translatePartials` is enabled (off by default), which keeps request volume low and avoids tripping provider rate limits (e.g. AI Studio free-tier RPM).

## Cross-compilation

Windows builds are cross-compiled from Linux using MinGW-w64. Required packages (Fedora): `mingw64-gcc-c++`, `mingw64-winpthreads-static`, `mingw64-openssl`, `mingw64-openssl-static`, `mingw64-zlib-static`, `mingw64-binutils`. The exe icon is set via `resedit` (pure Node.js) in the `afterPack` hook — no Wine needed. Before building, run `scripts/setup-deps.sh` to fetch the vendored deps (uWebSockets + uSockets, nlohmann/json, and the header-only Boost subset — one setup serves both Linux and MinGW), and `scripts/setup-sherpa-onnx.sh <target>` to download pre-built sherpa-onnx libraries.

## Key conventions

- UI supports Chinese and English (`src/frontend/renderer/shared/i18n.ts`). All user-visible strings use the `t('key')` function.
- Theme system broadcasts CSS variables to all windows. Dark/light/system modes with optional wallpaper accent color extraction.
- The `BackendManager` spawns the C++ process with CLI args (`--provider`, `--language`, `--parakeet-model-dir`, `--parakeet-model-type`, `--parakeet-vad-model`, `--parakeet-threads`, `--parakeet-vad-*` VAD tuning, `--nemotron-model-dir`, `--nemotron-threads`, `--nemotron-min-silence`, `--nemotron-max-utterance`, `--remote-parakeet-url`, `--remote-parakeet-api-key`, `--remote-parakeet-model`, `--denoise`, `--denoise-model`, `--denoise-arch`). The `--parakeet-vad-*` args apply to both the local Parakeet provider and the remote one; Nemotron has its own endpoint args and takes no VAD. Each spawned child carries a generation tag so a late `exit` from a killed process cannot null out or respawn over its replacement. Changing STT provider or config triggers a full backend restart. Changing language only triggers a WebSocket reconnect (no restart). Changing denoise or VAD settings sends a `SET_DENOISE` / `SET_VAD` command without restart (the `set_vad` command is routed to both the local and remote Parakeet transcribers, never to Nemotron).
- Model resolution never leaves a backend idle when a model exists on disk: a configured model id whose files are not all present resolves to the first fully-downloaded model (the panel picker's own rule) and the corrected id is written back to config; if no model was usable when a download began and the active provider is the one it belongs to, finishing the download restarts the (necessarily modelless, so idle) backend with it. This matters because `load_model` runs once at spawn and is never retried.
- A model that does not cover the chosen source language is the one failure the pipeline cannot detect for itself: it loads, reports ready, and transcribes into the wrong script. `get-language-support` answers it in the main process — against the model the backend actually resolved, which a stale config can make differ from the one the picker shows — and it surfaces twice: as a `fault` on the recognition stage of the rail (checked before readiness, since nothing else looks wrong) and as a warning under the Parakeet model picker, which tests the *draft* selection so it appears while the picker is still open on the offending model. Nemotron's own check is that `toNemotronLanguage` refuses to resolve; a remote server's model list is unknowable from here, so that provider is never accused.
- Settings commit model (`shared/pending.ts` + `PendingBar.tsx`): anything that costs a backend restart is deferred behind a pending bar that states the cost **before** the click ("restarts the backend — capture pauses ~2s" vs "applies without interrupting capture"), derived from which keys actually changed. Everything else applies on change and has no save button. `dirty` comes from diffing the draft against the loaded snapshot, so reverting an edit is not a change and cannot trigger a restart for an identical config. Drafts live outside React keyed by panel, so switching tabs cannot discard them; closing the window with pending edits asks first.
- Live commands report whether they were actually delivered (`applied`), because `WsClient.send` is a no-op while the socket is down; everything the backend needs — language, subtitle mode, denoise, VAD, source — is replayed from config on every reconnect (`applyLiveState` in `index.ts`).
- Metrics are measured where they are knowable, never estimated: `dropped_ms` in the status frame comes from `AudioRingBuffer`, which counts the samples `write()` has to discard when the consumer falls behind; `latency_ms` on a transcript is measured inside `ParakeetTranscriber` from the segment becoming decodable to its text existing (queue wait + decode). The media clock cannot be used for this — `global_sample_count_` advances only while audio is being fed and never resets, so it diverges from wall time across any pause. Nemotron stamps each pending audio batch when its first sample arrives and reports wait + decode for the batch that produced the text; the stamp travels with the batch (cleared when the decode thread takes it), otherwise mid-speech latency grows without bound because the queue is never observed empty. Remote Parakeet leaves `latency_ms` unset rather than guessing.
- `stop-capture` clears the remembered source id. Reconnects replay `select_source`, so keeping it would resume capture after any settings save or crash.
