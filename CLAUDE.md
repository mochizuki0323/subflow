# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SubFlow

Real-time speech captioning desktop app. Captures system audio, transcribes via Deepgram Nova-3, optionally translates via LLM (OpenAI-compatible or Anthropic API). Displays subtitles in a floating overlay window.

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

1. **C++ Backend** (`src/backend/`) — Standalone executable (`subflow-backend`). Captures audio (PipeWire on Linux, WASAPI on Windows) at per-application or device level, streams to Deepgram via WebSocket, broadcasts transcripts over a local WebSocket server on port 9876. Per-app capture uses PipeWire node targeting on Linux and `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` on Windows (requires Build 20348+).

2. **Electron Main Process** (`src/frontend/main/`) — Spawns the C++ backend, connects to it via WebSocket (`WsClient`), manages three Electron windows, handles config persistence, and runs LLM translation.

3. **React Renderer** (`src/frontend/renderer/`) — Three windows: control panel (settings UI), overlay (floating subtitles), history (scrollable transcript). Communicates with main process via IPC through a preload bridge.

### Speech enhancement (denoising)

`Denoiser` class in `denoiser.cpp` wraps sherpa-onnx's `OnlineSpeechDenoiser` C API. Inserted in the pipeline loop between `buffer_.read()` and `transcriber_->feed_audio()`. Supports GTCRN and DPDFNet model architectures — the architecture is selected based on the `architecture` field in `src/shared/denoise-models.json` (model registry shared by backend and frontend). Models are downloaded on demand by the Electron main process (`denoiser-manager.ts`) and stored in `{configDir}/models/`. The backend receives model path + architecture via `SET_DENOISE` WebSocket command or `--denoise*` CLI args. Denoising can be toggled at runtime without restarting the backend.

Pre-built sherpa-onnx libraries are downloaded by `scripts/setup-sherpa-onnx.sh` into `extern/sherpa-onnx/` (gitignored). Linux uses static linking; Windows uses shared DLLs with MinGW import libraries generated via `objdump` + `dlltool`.

### Data flow

```
Audio Source → C++ Backend → [optional sherpa-onnx denoise] → [Deepgram WebSocket] → transcript JSON
  → Electron Main (WsClient) → [optional LLM translation] → IPC → Renderer windows
```

### IPC patterns

- **Renderer → Main**: `window.electronAPI.*` calls defined in `preload.ts`. Uses `ipcRenderer.send` (fire-and-forget) for commands, `ipcRenderer.invoke` (request-response) for queries.
- **Main → Renderer**: `safeSend(window, channel, data)` broadcasts.
- **Main ↔ Backend**: JSON messages over WebSocket. Protocol defined in `src/backend/ipc/protocol.h`. Commands: `select_source`, `set_language`, `set_denoise`, `start`, `stop`, etc.

### Config system

`UnifiedConfigManager` in `unified-config.ts` manages all settings in a single `config/subflow-config.json` file. Sections: `deepgram`, `translator`, `app`, `ui`, `windowPositions`, `denoiser`. Auto-migrates from legacy per-file configs on first run. Config directory varies by platform: repo root (dev), next to exe (Windows packaged), `~/.config/subflow_settings` (Linux packaged).

### Translation

`Translator` class in `translator.ts` supports OpenAI-compatible (`/v1/chat/completions`) and Anthropic (`/v1/messages`) APIs. Features: in-flight deduplication, sliding window history context, scene-specific prompts. Translation happens in the Electron main process, not the C++ backend.

## Cross-compilation

Windows builds are cross-compiled from Linux using MinGW-w64. Required packages (Fedora): `mingw64-gcc-c++`, `mingw64-winpthreads-static`, `mingw64-openssl`, `mingw64-openssl-static`, `mingw64-zlib-static`, `mingw64-binutils`. The exe icon is set via `resedit` (pure Node.js) in the `afterPack` hook — no Wine needed. Before building, run `scripts/setup-sherpa-onnx.sh <target>` to download pre-built sherpa-onnx libraries.

## Key conventions

- UI supports Chinese and English (`src/frontend/renderer/shared/i18n.ts`). All user-visible strings use the `t('key')` function.
- Theme system broadcasts CSS variables to all windows. Dark/light/system modes with optional wallpaper accent color extraction.
- The `BackendManager` spawns the C++ process with CLI args (`--api-key`, `--model`, `--language`, `--extra-params`, `--denoise`, `--denoise-model`, `--denoise-arch`). Changing Deepgram config triggers a full backend restart. Changing language only triggers a Deepgram WebSocket reconnect (no restart). Changing denoise settings sends a `SET_DENOISE` command without restart.
- Settings save behavior: Deepgram tab, Language tab, and Denoise tab use deferred save with explicit save button. Sidebar theme/language settings save immediately.
