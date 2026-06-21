# 🎙️ SubFlow — Real-Time Speech Captions

<p align="center">
    <img src="resources/icon.svg" alt="SubFlow" width="360">
</p>

<p align="center">
  <a href="https://github.com/mochizuki0323/subflow/actions/workflows/release.yml?branch=master"><img src="https://img.shields.io/github/actions/workflow/status/mochizuki0323/subflow/release.yml?branch=master&style=for-the-badge&label=Release%20CI" alt="Release CI status"></a>
  <a href="https://github.com/mochizuki0323/subflow/releases"><img src="https://img.shields.io/github/v/release/mochizuki0323/subflow?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

SubFlow is a real-time speech captioning tool built with cloud STT (Deepgram / Gladia) and local ASR (NVIDIA Parakeet). It supports capturing system audio and streaming transcription for display. By integrating OpenAI-compatible and Anthropic APIs, text can be post-processed in real time through an LLM with preset scene prompts and historical context, refining phrasing, correcting translations, and improving coherence of multi-segment output.

[中文](README.zh.md) · [Releases](https://github.com/mochizuki0323/subflow/releases) · [License](LICENSE)

## Preview

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## Features

- **Real-time transcription** — Deepgram Nova-3, Gladia Solaria-1, or NVIDIA Parakeet local ASR (switchable in settings)
- **Local ASR (Parakeet)** — Offline speech-to-text via sherpa-onnx with simulated streaming; supports Japanese and 25 European languages; no API key needed
- **Remote Parakeet server** — Point the app at a self-hosted Parakeet inference server (`remote_parakeet` provider): one loaded model is shared across all clients, available models are listed in-app, and VAD is tunable per connection at runtime
- **Speech denoising** — sherpa-onnx-powered noise reduction (DPDFNet / GTCRN models); removes background noise before transcription for cleaner results
- **Per-app & system audio capture** — PipeWire (Linux) and WASAPI (Windows); capture a single application or the entire system output
- **Optional LLM layer** — OpenAI-compatible and Anthropic APIs: translation and post-processing (scene prompts, historical context, and related options)
- **Gladia-specific features** — Server-side audio enhancer, live translation, sentiment analysis, named entity recognition, custom vocabulary, code switching
- **Overlay + history windows** — Draggable, resizable translucent subtitle overlay and scrollable history panel; optional interim results display
- **Multiple subtitle modes** — Original, translated, or bilingual display
- **Dark / light / system theme** — Follows desktop appearance; supports wallpaper accent colors

## Installation

### Linux

Download the latest version from [Releases](../../releases):

- AppImage — `subflow-*-linux-x86_64.AppImage`
- Debian/Ubuntu — `subflow-*-linux-amd64.deb`
- Fedora/RHEL — `subflow-*-linux-x86_64.rpm`

```bash
# AppImage
chmod +x subflow-*-linux-x86_64.AppImage
./subflow-*-linux-x86_64.AppImage

# Debian/Ubuntu
sudo dpkg -i subflow-*-linux-amd64.deb

# Fedora
sudo dnf install subflow-*-linux-x86_64.rpm
```

### Windows

Download from [Releases](../../releases).

## Build from source

### Prerequisites

**Linux (Fedora):**

```bash
sudo dnf install gcc-c++ clang cmake ninja-build \
  openssl-devel pipewire-devel \
  nodejs npm
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt install build-essential clang cmake ninja-build \
  libssl-dev libpipewire-0.3-dev \
  nodejs npm
```

### Build

```bash
git clone --recursive https://github.com/mochizuki0323/subflow.git
cd subflow
npm install

# Download pre-built sherpa-onnx libraries (required for denoising / Parakeet)
bash scripts/setup-sherpa-onnx.sh

# Vendor Boost headers (required by the backend's WebSocket/HTTP layer)
bash scripts/setup-boost.sh

# Build everything (backend + frontend)
bash scripts/build.sh

# Run
npm start
```

### Packaging

```bash
# Linux (AppImage + deb + rpm)
bash scripts/dist-linux.sh

# Cross-compile Windows portable build from Linux
# Requires: mingw64-gcc-c++ mingw64-openssl mingw64-winpthreads-static
bash scripts/dist-windows.sh
```

## Config files

- **Linux** (AppImage / deb / rpm): `~/.config/subflow_settings/config/`
- **Windows**: `config/` folder next to the executable

## Self-hosted Parakeet server

The `server/` directory builds a standalone inference server (`subflow-parakeet-server`) so Parakeet ASR can run on a machine that holds the models and serve multiple clients over the network, instead of running the model locally on each device.

```bash
# One-time: fetch sherpa-onnx for the server
bash scripts/setup-sherpa-onnx.sh linux-x64

# Build → server/build/bin/subflow-parakeet-server
bash server/build.sh
```

The server is driven by a single JSON config, auto-loaded from `config/config.json` next to the binary (or pass `--config <path>`; CLI flags override individual fields). Relative paths resolve against the config file's location. See `server/config.example.json`:

```json
{
  "port": 9090,
  "api_key": "",
  "vad_model": "silero_vad.onnx",
  "models": [
    { "id": "parakeet-ja", "dir": "models/<model-folder>", "type": "nemo_ctc" }
  ]
}
```

Each model `id` is what the app shows and selects; `type` is `nemo_ctc` or `nemo_transducer`. In the app, choose the **Parakeet Server** provider, enter the server address (`ws://host:9090` on a LAN or `wss://...` over the internet), fetch the model list, and pick a model. TLS is terminated by a reverse proxy in front of the server.

## License

[MIT](LICENSE)
