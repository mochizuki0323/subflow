# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SubFlow

Real-time speech captioning desktop app. Captures system audio, transcribes via cloud STT (Deepgram Nova-3 or Gladia Solaria-1), local ASR (NVIDIA Parakeet via sherpa-onnx), or a self-hosted remote Parakeet inference server, optionally translates via LLM (OpenAI-compatible, Anthropic, or Google AI Studio API). Displays subtitles in a floating overlay window.

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

1. **C++ Backend** (`src/backend/`) — Standalone executable (`subflow-backend`). Captures audio (PipeWire on Linux, WASAPI on Windows) at per-application or device level, transcribes via one of four providers, broadcasts transcripts over a local WebSocket server on port 9876. The `--provider` CLI arg selects which transcriber to use. `DeepgramTranscriber` connects directly to `api.deepgram.com`; `GladiaTranscriber` first POSTs to `api.gladia.io/v2/live` to create a session, then connects to the returned WebSocket URL; `ParakeetTranscriber` runs sherpa-onnx offline ASR locally with simulated streaming (Silero VAD + periodic re-decode); `RemoteParakeetTranscriber` streams audio to a remote Parakeet server and receives transcripts back. All WebSocket/HTTP clients go through the Boost.Beast layer in `src/backend/net/` (see Networking). Per-app capture uses PipeWire node targeting on Linux and `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` on Windows (requires Build 20348+).

2. **Electron Main Process** (`src/frontend/main/`) — Spawns the C++ backend, connects to it via WebSocket (`WsClient`), manages three Electron windows, handles config persistence, and runs LLM translation.

3. **React Renderer** (`src/frontend/renderer/`) — Three windows: control panel (settings UI), overlay (floating subtitles), history (scrollable transcript). Communicates with main process via IPC through a preload bridge.

### Speech enhancement (denoising)

`Denoiser` class in `denoiser.cpp` wraps sherpa-onnx's `OnlineSpeechDenoiser` C API. Inserted in the pipeline loop between `buffer_.read()` and `transcriber_->feed_audio()`. Supports GTCRN and DPDFNet model architectures — the architecture is selected based on the `architecture` field in `src/shared/denoise-models.json` (model registry shared by backend and frontend). Models are downloaded on demand by the Electron main process (`denoiser-manager.ts`) and stored in `{configDir}/models/`. The backend receives model path + architecture via `SET_DENOISE` WebSocket command or `--denoise*` CLI args. Denoising can be toggled at runtime without restarting the backend.

Pre-built sherpa-onnx libraries are downloaded by `scripts/setup-sherpa-onnx.sh` into `extern/sherpa-onnx/` (gitignored). Linux uses static linking; Windows uses shared DLLs with MinGW import libraries generated via `objdump` + `dlltool`.

### Local ASR (Parakeet)

`ParakeetTranscriber` in `parakeet_transcriber.cpp` uses sherpa-onnx's offline recognizer API for local speech-to-text with NVIDIA Parakeet models. Since Parakeet models are non-streaming (full-attention FastConformer), real-time output is achieved via **simulated streaming**: Silero VAD detects speech segments on the pipeline thread; a dedicated decode thread runs periodic partial re-decodes (~200ms intervals) during active speech and final decodes when VAD closes the segment.

Two model families are supported: `nemo_ctc` (single `model.int8.onnx`, e.g. Japanese) and `nemo_transducer` (encoder + decoder + joiner, e.g. V3 multilingual). Model registry is in `src/shared/parakeet-models.json`. Models are downloaded as tar.bz2 archives and extracted via pure-JS `unbzip2-stream` + `tar-stream` (cross-platform, no system `tar` dependency). The Silero VAD model (`silero_vad.onnx`, ~629KB) is auto-downloaded alongside the first Parakeet model. Download and extraction are managed by `parakeet-manager.ts`.

The backend receives model dir, type, and VAD model path via `--parakeet-model-dir`, `--parakeet-model-type`, `--parakeet-vad-model` CLI args.

### Networking (`net/`)

All C++ WebSocket and HTTP clients are unified on **Boost.Beast** behind a Boost-free interface: `net::WsClient` (`ws_client.h` + `beast_ws_client.cpp`, async single-IO-thread, ws+wss, reconnect) and `net::HttpClient` (`http_client.{h,cpp}`, sync). Deepgram, Gladia, and the remote-Parakeet client all use this layer. Boost is header-only and vendored by `scripts/setup-boost.sh` into `extern/boost/` (gitignored); the backend CMake `FATAL_ERROR`s without it. `subflow_net` is a STATIC lib linked into `subflow-backend`.

### Remote Parakeet (`remote_parakeet` provider + standalone server)

`RemoteParakeetTranscriber` (`remote_parakeet_transcriber.{h,cpp}`) is a thin client over `net::WsClient`: it streams 16 kHz mono int16 PCM binary frames to a remote server and parses JSON transcript frames back. The server is selected via `--remote-parakeet-url` (`ws://`/`wss://`), `--remote-parakeet-api-key` (optional Bearer), and `--remote-parakeet-model` (server model id, sent as `?model=<id>` on the WS URL). Server-side VAD is tuned per connection: the client sends a `set_vad` control frame on connect and on change, reusing the same `--parakeet-vad-*` CLI args / `ParakeetVadParams` as the local provider (no restart).

The **standalone server** lives in the top-level `server/` directory (a separate deliverable, NOT under `src/backend/`; built with `server/build.sh` → `subflow-parakeet-server`, Linux-only, own `CMakeLists.txt`, no Boost/OpenSSL/pipewire). Architecture: a `ModelRegistry` holds one shared `ParakeetModel` (recognizer) + `DecodeScheduler` (batched, single dispatcher thread) **per model id**, loaded lazily on first use and shared across all connections (model RAM is O(models), not O(clients)); each connection gets its own `ParakeetSession` (own Silero VAD + worker thread, mirroring the local transcriber's create/rebuild/destroy). It serves over uWebSockets: `GET /models` lists models, `GET /healthz`, `GET /metrics`, and `/*` upgrades to WS (Bearer auth + `?model=` validated at upgrade). Config is a single JSON (auto-loaded from `<exe-dir>/config/config.json` or `./config/config.json`, or `--config <path>`; CLI flags override individual fields) holding all server settings + the model list; relative paths resolve against the config file. See `server/config.example.json`. Note: sherpa's VAD bundles model+state per ORT session and cannot be shared across concurrent streams, so each live session holds its own VAD (~17 MB) — only the recognizer is shared.

### Data flow

```
Audio Source → C++ Backend → [optional sherpa-onnx denoise]
  → Cloud STT: [Deepgram/Gladia WebSocket] → transcript JSON
  → Local STT: [Silero VAD → Parakeet offline decode (dedicated thread)] → transcript JSON
  → Remote STT: [int16 PCM → remote Parakeet server (server-side VAD + shared recognizer)] → transcript JSON
  → Electron Main (WsClient) → [optional LLM translation] → IPC → Renderer windows
```

### IPC patterns

- **Renderer → Main**: `window.electronAPI.*` calls defined in `preload.ts`. Uses `ipcRenderer.send` (fire-and-forget) for commands, `ipcRenderer.invoke` (request-response) for queries.
- **Main → Renderer**: `safeSend(window, channel, data)` broadcasts.
- **Main ↔ Backend**: JSON messages over WebSocket. Protocol defined in `src/backend/ipc/protocol.h`. Commands: `select_source`, `set_language`, `set_denoise`, `start`, `stop`, etc.

### Config system

`UnifiedConfigManager` in `unified-config.ts` manages all settings in a single `config/subflow-config.json` file. Sections: `provider`, `deepgram`, `gladia`, `parakeet`, `remoteParakeet`, `translator`, `app`, `ui`, `windowPositions`, `denoiser`. The `provider` field (`"deepgram"`, `"gladia"`, `"parakeet"`, or `"remote_parakeet"`) selects which STT service to use. `remoteParakeet` holds `serverUrl`, `apiKey`, `model`, and `vad` (per-client VAD tuning). Auto-migrates from legacy per-file configs on first run. Config directory varies by platform: repo root (dev), next to exe (Windows packaged), `~/.config/subflow_settings` (Linux packaged). (This app config is unrelated to the standalone server's own `config/config.json`.)

### Translation

`Translator` class in `translator.ts` supports OpenAI-compatible (`/v1/chat/completions`), Anthropic (`/v1/messages`), and Google AI Studio (Gemini/Gemma `:generateContent`) APIs, selected by the `apiFormat` field (`'openai'` | `'anthropic'` | `'google'`). Features: in-flight deduplication, sliding window history context, scene-specific prompts. Translation happens in the Electron main process, not the C++ backend. The Google path is special-cased: instruction-tuned Gemma models reason verbosely and bury the translation in chain-of-thought, so the request constrains the output grammar via `responseMimeType: application/json` + `responseSchema` (parsed back to the translation), with a sentinel-delimited prompt fallback for models that reject structured output. API keys are stored **per format** (`apiKeys` map keyed by `apiFormat`) so switching provider doesn't clobber the others; the flat `apiKey` field mirrors the active format for backward compat. The main-process transcript handler (`index.ts`) only sends **final** transcripts to the translator by default — interim/partial transcripts are translated only when `translatePartials` is enabled (off by default), which keeps request volume low and avoids tripping provider rate limits (e.g. AI Studio free-tier RPM).

## Cross-compilation

Windows builds are cross-compiled from Linux using MinGW-w64. Required packages (Fedora): `mingw64-gcc-c++`, `mingw64-winpthreads-static`, `mingw64-openssl`, `mingw64-openssl-static`, `mingw64-zlib-static`, `mingw64-binutils`. The exe icon is set via `resedit` (pure Node.js) in the `afterPack` hook — no Wine needed. Before building, run `scripts/setup-sherpa-onnx.sh <target>` to download pre-built sherpa-onnx libraries and `scripts/setup-boost.sh` to vendor Boost headers (header-only, one setup serves both Linux and MinGW).

## Key conventions

- UI supports Chinese and English (`src/frontend/renderer/shared/i18n.ts`). All user-visible strings use the `t('key')` function.
- Theme system broadcasts CSS variables to all windows. Dark/light/system modes with optional wallpaper accent color extraction.
- The `BackendManager` spawns the C++ process with CLI args (`--provider`, `--api-key`, `--model`, `--language`, `--extra-params`, `--gladia-api-key`, `--gladia-model`, `--gladia-config`, `--parakeet-model-dir`, `--parakeet-model-type`, `--parakeet-vad-model`, `--parakeet-vad-*` VAD tuning, `--remote-parakeet-url`, `--remote-parakeet-api-key`, `--remote-parakeet-model`, `--denoise`, `--denoise-model`, `--denoise-arch`). The `--parakeet-vad-*` args apply to both the local Parakeet provider and the remote one. `--gladia-config` is a JSON string of Gladia feature flags (code_switching, speech_threshold, endpointing, translation, etc.) parsed in `GladiaTranscriber::build_init_body()`. Changing STT provider or config triggers a full backend restart. Changing language only triggers a WebSocket reconnect (no restart). Changing denoise or VAD settings sends a `SET_DENOISE` / `SET_VAD` command without restart (the `set_vad` command is routed to both the local and remote Parakeet transcribers).
- Settings save behavior: Deepgram tab, Language tab, Denoise tab, Parakeet tab, and Parakeet Server tab use deferred save with explicit save button; VAD tuning (Parakeet + Parakeet Server) applies live via `set_vad`. Sidebar theme/language settings and the interim results toggle save immediately.
