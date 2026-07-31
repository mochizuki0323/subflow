# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SubFlow

Real-time speech captioning desktop app. Captures system audio, transcribes with local ASR (NVIDIA Parakeet via sherpa-onnx) or a self-hosted remote Parakeet inference server, optionally translates via LLM (OpenAI-compatible, Anthropic, or Google AI Studio API). Displays subtitles in a floating overlay window. Audio never leaves the machine unless the remote provider is selected.

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

1. **C++ Backend** (`src/backend/`) — Standalone executable (`subflow-backend`). Captures audio (PipeWire on Linux, WASAPI on Windows) at per-application or device level, transcribes via one of two providers, broadcasts transcripts over a local WebSocket server on port 9876. The `--provider` CLI arg selects which transcriber to use (unknown values fall back to local Parakeet). `ParakeetTranscriber` runs sherpa-onnx offline ASR locally with simulated streaming (Silero VAD + periodic re-decode); `RemoteParakeetTranscriber` streams audio to a remote Parakeet server and receives transcripts back. WebSocket clients go through the Boost.Beast layer in `src/backend/net/` (see Networking). Per-app capture uses PipeWire node targeting on Linux and `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` on Windows (requires Build 20348+).

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

The backend receives model dir, type, and VAD model path via `--parakeet-model-dir`, `--parakeet-model-type`, `--parakeet-vad-model` CLI args.

### Networking (`net/`)

C++ WebSocket clients are unified on **Boost.Beast** behind a Boost-free interface: `net::WsClient` (`ws_client.h` + `beast_ws_client.cpp`, async single-IO-thread, ws+wss, reconnect). The remote-Parakeet client is its only user. Boost is header-only and vendored by `scripts/setup-deps.sh` into `extern/boost/` (gitignored); the backend CMake `FATAL_ERROR`s without it. `subflow_net` is a STATIC lib linked into `subflow-backend`.

Note on `extern/` provenance: the **entire `extern/` directory is gitignored** — nothing under it is committed (there are no git submodules). Two scripts reproduce it from pinned upstream versions: `scripts/setup-deps.sh` `git clone`s uWebSockets (release tag `v20.76.0`) + its `uSockets` dependency (only `uSockets` is fetched, not the `fuzzing`/`h1spec`/`libdeflate` nested submodules), downloads the nlohmann/json single header (`v3.11.3`), and downloads the header-only **Boost** subset into `extern/boost/` (Boost is a tarball download because its superproject is ~166 nested submodules + a `b2 headers` generation step); `scripts/setup-sherpa-onnx.sh` fetches sherpa-onnx separately (platform-specific, called with a `<target>`). The build scripts auto-run `setup-deps.sh` when a dependency is missing.

### Remote Parakeet (`remote_parakeet` provider + standalone server)

`RemoteParakeetTranscriber` (`remote_parakeet_transcriber.{h,cpp}`) is a thin client over `net::WsClient`: it streams 16 kHz mono int16 PCM binary frames to a remote server and parses JSON transcript frames back. The server is selected via `--remote-parakeet-url` (`ws://`/`wss://`), `--remote-parakeet-api-key` (optional Bearer), and `--remote-parakeet-model` (server model id, sent as `?model=<id>` on the WS URL). Server-side VAD is tuned per connection: the client sends a `set_vad` control frame on connect and on change, reusing the same `--parakeet-vad-*` CLI args / `ParakeetVadParams` as the local provider (no restart).

The **standalone server** lives in the top-level `server/` directory (a separate deliverable, NOT under `src/backend/`; built with `server/build.sh` → `subflow-parakeet-server`, Linux-only, own `CMakeLists.txt`, no Boost/OpenSSL/pipewire). Architecture: a `ModelRegistry` holds one shared `ParakeetModel` (recognizer) + `DecodeScheduler` (batched, single dispatcher thread) **per model id**, loaded lazily on first use and shared across all connections (model RAM is O(models), not O(clients)); each connection gets its own `ParakeetSession` (own Silero VAD + worker thread, mirroring the local transcriber's create/rebuild/destroy). It serves over uWebSockets: `GET /models` lists models, `GET /healthz`, `GET /metrics`, and `/*` upgrades to WS (Bearer auth + `?model=` validated at upgrade). Config is a single JSON (auto-loaded from `<exe-dir>/config/config.json` or `./config/config.json`, or `--config <path>`; CLI flags override individual fields) holding all server settings + the model list; relative paths resolve against the config file. See `server/config.example.json`. Note: sherpa's VAD bundles model+state per ORT session and cannot be shared across concurrent streams, so each live session holds its own VAD (~17 MB) — only the recognizer is shared.

### Data flow

```
Audio Source → C++ Backend → [optional sherpa-onnx denoise]
  → Local STT: [Silero VAD → Parakeet offline decode (dedicated thread)] → transcript JSON
  → Remote STT: [int16 PCM → remote Parakeet server (server-side VAD + shared recognizer)] → transcript JSON
  → Electron Main (WsClient) → [optional LLM translation] → IPC → Renderer windows
```

### IPC patterns

- **Renderer → Main**: `window.electronAPI.*` calls defined in `preload.ts`. Uses `ipcRenderer.send` (fire-and-forget) for commands, `ipcRenderer.invoke` (request-response) for queries.
- **Main → Renderer**: `safeSend(window, channel, data)` broadcasts.
- **Main ↔ Backend**: JSON messages over WebSocket. Protocol defined in `src/backend/ipc/protocol.h`. Commands: `select_source`, `set_language`, `set_denoise`, `set_vad`, `start`, `stop`, etc.
- **Backend liveness** is pushed to the renderer on `backend-state` (`connecting | connected | disconnected | restarting | exited`) and is also queryable via `get-backend-state`, because the control panel is created after the socket connects and would otherwise miss the first event. Without it a dead backend left the UI rendering the last status frame forever.

### Config system

`UnifiedConfigManager` in `unified-config.ts` manages all settings in a single `config/subflow-config.json` file. Sections: `provider`, `parakeet`, `remoteParakeet`, `translator`, `app`, `ui`, `windowPositions`, `denoiser`. The `provider` field (`"parakeet"` or `"remote_parakeet"`) selects which STT service to use; an unrecognised value is rewritten to `"parakeet"` on load and any unknown section pruned, so a config from an older build cannot select a transcriber that no longer exists. `remoteParakeet` holds `serverUrl`, `apiKey`, `model`, and `vad` (per-client VAD tuning). Auto-migrates from legacy per-file configs on first run. Config directory varies by platform: repo root (dev), next to exe (Windows packaged), `~/.config/subflow_settings` (Linux packaged). (This app config is unrelated to the standalone server's own `config/config.json`.)

### Transcript record

The main process owns the transcript (`transcript-log.ts`) and both history views mirror it, so the control panel's tab and the floating window cannot drift in content, length or partial handling, and clearing is one operation both observe. Owning it is what makes export possible: SRT uses the backend's real media timestamps (`t0`/`t1`, populated by both Parakeet transcribers), gives a zero-length cue a readable minimum rather than emitting it unrenderable, excludes interim lines, and writes a translation as a second line of the same cue.

### Translation

`Translator` class in `translator.ts` supports OpenAI-compatible (`/v1/chat/completions`), Anthropic (`/v1/messages`), and Google AI Studio (Gemini/Gemma `:generateContent`) APIs, selected by the `apiFormat` field (`'openai'` | `'anthropic'` | `'google'`). Features: in-flight deduplication, sliding window history context, scene-specific prompts. Translation happens in the Electron main process, not the C++ backend. The Google path is special-cased: instruction-tuned Gemma models reason verbosely and bury the translation in chain-of-thought, so the request constrains the output grammar via `responseMimeType: application/json` + `responseSchema` (parsed back to the translation), with a sentinel-delimited prompt fallback for models that reject structured output. API keys are stored **per format** (`apiKeys` map keyed by `apiFormat`) so switching provider doesn't clobber the others; the flat `apiKey` field mirrors the active format for backward compat. The main-process transcript handler (`index.ts`) only sends **final** transcripts to the translator by default — interim/partial transcripts are translated only when `translatePartials` is enabled (off by default), which keeps request volume low and avoids tripping provider rate limits (e.g. AI Studio free-tier RPM).

## Cross-compilation

Windows builds are cross-compiled from Linux using MinGW-w64. Required packages (Fedora): `mingw64-gcc-c++`, `mingw64-winpthreads-static`, `mingw64-openssl`, `mingw64-openssl-static`, `mingw64-zlib-static`, `mingw64-binutils`. The exe icon is set via `resedit` (pure Node.js) in the `afterPack` hook — no Wine needed. Before building, run `scripts/setup-deps.sh` to fetch the vendored deps (uWebSockets + uSockets, nlohmann/json, and the header-only Boost subset — one setup serves both Linux and MinGW), and `scripts/setup-sherpa-onnx.sh <target>` to download pre-built sherpa-onnx libraries.

## Key conventions

- UI supports Chinese and English (`src/frontend/renderer/shared/i18n.ts`). All user-visible strings use the `t('key')` function.
- Theme system broadcasts CSS variables to all windows. Dark/light/system modes with optional wallpaper accent color extraction.
- The `BackendManager` spawns the C++ process with CLI args (`--provider`, `--language`, `--parakeet-model-dir`, `--parakeet-model-type`, `--parakeet-vad-model`, `--parakeet-vad-*` VAD tuning, `--remote-parakeet-url`, `--remote-parakeet-api-key`, `--remote-parakeet-model`, `--denoise`, `--denoise-model`, `--denoise-arch`). The `--parakeet-vad-*` args apply to both the local Parakeet provider and the remote one. Each spawned child carries a generation tag so a late `exit` from a killed process cannot null out or respawn over its replacement. Changing STT provider or config triggers a full backend restart. Changing language only triggers a WebSocket reconnect (no restart). Changing denoise or VAD settings sends a `SET_DENOISE` / `SET_VAD` command without restart (the `set_vad` command is routed to both the local and remote Parakeet transcribers).
- Settings commit model (`shared/pending.ts` + `PendingBar.tsx`): anything that costs a backend restart is deferred behind a pending bar that states the cost **before** the click ("restarts the backend — capture pauses ~2s" vs "applies without interrupting capture"), derived from which keys actually changed. Everything else applies on change and has no save button. `dirty` comes from diffing the draft against the loaded snapshot, so reverting an edit is not a change and cannot trigger a restart for an identical config. Drafts live outside React keyed by panel, so switching tabs cannot discard them; closing the window with pending edits asks first.
- Live commands report whether they were actually delivered (`applied`), because `WsClient.send` is a no-op while the socket is down; everything the backend needs — language, subtitle mode, denoise, VAD, source — is replayed from config on every reconnect (`applyLiveState` in `index.ts`).
- Metrics are measured where they are knowable, never estimated: `dropped_ms` in the status frame comes from `AudioRingBuffer`, which counts the samples `write()` has to discard when the consumer falls behind; `latency_ms` on a transcript is measured inside `ParakeetTranscriber` from the segment becoming decodable to its text existing (queue wait + decode). The media clock cannot be used for this — `global_sample_count_` advances only while audio is being fed and never resets, so it diverges from wall time across any pause. Remote Parakeet leaves `latency_ms` unset rather than guessing.
- `stop-capture` clears the remembered source id. Reconnects replay `select_source`, so keeping it would resume capture after any settings save or crash.
