# SubFlow

[中文](README.zh.md)

Real-time speech captions with optional translation, powered by Deepgram and LLMs.

SubFlow captures system audio, transcribes it in real time via Deepgram's speech-to-text API, and displays captions in a translucent overlay window. An optional translation layer forwards transcript segments to an OpenAI-compatible LLM endpoint for live translation.

## Preview

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## Features

- **Real-time transcription** — Deepgram Nova-3 streaming speech-to-text
- **System audio capture** — PipeWire (Linux) and WASAPI (Windows)
- **Live translation** — Optional LLM-powered translation via any OpenAI-compatible API
- **Overlay + history windows** — Draggable, resizable translucent subtitle overlay and scrollable history panel
- **Multiple subtitle modes** — Original, translated, or bilingual display
- **Dark / light / system theme** — Follows desktop appearance with wallpaper accent color support

## Installation

### Linux

Download the latest release from [Releases](../../releases):

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

## Building from source

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

### Package

```bash
# Linux (AppImage + deb + rpm)
bash scripts/dist-linux.sh

# Windows cross-compilation from Linux (portable exe)
# Requires: mingw64-gcc-c++ mingw64-openssl mingw64-winpthreads-static
bash scripts/dist-windows.sh
```

## Config files

- **Linux** (AppImage / deb / rpm): `~/.config/subflow_settings`
- **Windows** (portable): next to the executable

## License

[MIT](LICENSE)
