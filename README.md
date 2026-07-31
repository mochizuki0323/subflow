# 🎙️ SubFlow — Real-Time Speech Captions

<p align="center">
    <img src="resources/icon.svg" alt="SubFlow" width="360">
</p>

<p align="center">
  <a href="https://github.com/mochizuki0323/subflow/actions/workflows/release.yml?branch=master"><img src="https://img.shields.io/github/actions/workflow/status/mochizuki0323/subflow/release.yml?branch=master&style=for-the-badge&label=Release%20CI" alt="Release CI status"></a>
  <a href="https://github.com/mochizuki0323/subflow/releases"><img src="https://img.shields.io/github/v/release/mochizuki0323/subflow?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

SubFlow turns whatever is playing on your machine into live subtitles. Recognition runs on NVIDIA Parakeet through sherpa-onnx — locally by default, so audio never leaves the machine, or against a self-hosted server you point it at. Optionally the text is passed through an LLM (OpenAI-compatible, Anthropic, or Google AI Studio) for translation and post-processing, with scene prompts and rolling context so multi-segment output stays coherent.

[中文](README.zh.md) · [Releases](https://github.com/mochizuki0323/subflow/releases) · [License](LICENSE)

## Preview

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## Features

- **Runs on your machine** — NVIDIA Parakeet offline via sherpa-onnx with simulated streaming; Japanese and 25 European languages. Nothing is sent anywhere unless you choose the remote engine
- **Remote engine (optional)** — Point the app at a self-hosted Parakeet server: one loaded model serves every client, available models are listed in-app, and VAD is tunable per connection at runtime
- **Per-application capture** — PipeWire (Linux) and WASAPI (Windows). On Linux the selected application's output ports are linked directly, so you caption one app while everything else keeps making noise
- **The interface is the signal path** — Source → denoise → recognition → translation → output, in order. Every stage reports what it is actually doing, an unconfigured stage is a bypass rather than a break, and a stage that stops the signal says so — including "both output windows are closed", the most common reason for seeing nothing
- **A monitor, not a spinner** — Live scope, level and peak, recognition latency, and dropped audio. Every figure is measured; there are no decorative numbers
- **Optional LLM layer** — Translation and post-processing via OpenAI-compatible, Anthropic, or Google AI Studio APIs; scene prompts, rolling context, per-provider API keys, and a switch for translating interim lines or only finals (skip interim to stay inside rate limits)
- **Overlay + history windows** — Draggable, resizable subtitle overlay and a scrollable transcript; original, translated, or bilingual
- **Export** — Save the transcript as SRT (real media timestamps, translation as a second line) or plain text
- **Speech denoising** — sherpa-onnx noise reduction (DPDFNet / GTCRN). Note it often *hurts* accuracy rather than helping — turn it on only when background noise is significant
- **Dark / light / system theme** — Follows the desktop, and can take its accent colour from your wallpaper
- **Keyboard reachable** — Every primary action, including choosing a source

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
sudo dnf install git curl gcc-c++ clang cmake ninja-build \
  openssl-devel pipewire-devel \
  nodejs npm
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt install git curl build-essential clang cmake ninja-build \
  libssl-dev libpipewire-0.3-dev \
  nodejs npm
```

### Build

```bash
git clone https://github.com/mochizuki0323/subflow.git
cd subflow
npm install

# Fetch vendored deps (uWebSockets + uSockets, nlohmann/json, Boost headers)
bash scripts/setup-deps.sh

# Download pre-built sherpa-onnx libraries (required for denoising / Parakeet)
bash scripts/setup-sherpa-onnx.sh

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

Each model `id` is what the app shows and selects; `type` is `nemo_ctc` or `nemo_transducer`. In the app, choose the **Remote server** engine under Recognition, enter the address (`ws://host:9090` on a LAN or `wss://...` over the internet), fetch the model list, and pick a model. TLS is terminated by a reverse proxy in front of the server.

## License

[MIT](LICENSE)
