# 🎙️ SubFlow — Real-Time Speech Captions

<p align="center">
    <img src="resources/icon.svg" alt="SubFlow" width="360">
</p>

<p align="center">
  <a href="https://github.com/mochizuki0323/subflow/actions/workflows/release.yml?branch=master"><img src="https://img.shields.io/github/actions/workflow/status/mochizuki0323/subflow/release.yml?branch=master&style=for-the-badge&label=Release%20CI" alt="Release CI status"></a>
  <a href="https://github.com/mochizuki0323/subflow/releases"><img src="https://img.shields.io/github/v/release/mochizuki0323/subflow?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

SubFlow is a real-time speech captioning tool built with Deepgram and LLMs. It supports capturing system audio and streaming transcription for display. By integrating OpenAI-compatible and Anthropic APIs, text can be post-processed in real time through an LLM with preset scene prompts and historical context, refining phrasing, correcting translations, and improving coherence of multi-segment output.

[中文](README.zh.md) · [Releases](https://github.com/mochizuki0323/subflow/releases) · [License](LICENSE)

## Preview

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## Features

- **Real-time transcription** — Deepgram Nova-3 streaming speech-to-text
- **System audio capture** — Supports PipeWire (Linux) and WASAPI (Windows)
- **Optional LLM layer** — OpenAI-compatible and Anthropic APIs: translation and post-processing (scene prompts, historical context, and related options)
- **Overlay + history windows** — Draggable, resizable translucent subtitle overlay and scrollable history panel
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

- **Linux** (AppImage / deb / rpm): `~/.config/subflow_settings`
- **Windows**: next to the executable

## License

[MIT](LICENSE)
