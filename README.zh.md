# 🎙️ SubFlow — 实时语音字幕

<p align="center">
    <img src="resources/icon.svg" alt="SubFlow" width="360">
</p>

<p align="center">
  <a href="https://github.com/mochizuki0323/subflow/actions/workflows/release.yml?branch=master"><img src="https://img.shields.io/github/actions/workflow/status/mochizuki0323/subflow/release.yml?branch=master&style=for-the-badge&label=Release%20CI" alt="Release CI 状态"></a>
  <a href="https://github.com/mochizuki0323/subflow/releases"><img src="https://img.shields.io/github/v/release/mochizuki0323/subflow?include_prereleases&style=for-the-badge" alt="GitHub 发行版"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

SubFlow 是一款基于云端 STT（Deepgram / Gladia）与本地 ASR（NVIDIA Parakeet）开发的实时语音字幕工具，支持捕获系统音频并实现流式转录显示。通过接入 OpenAI 兼容、Anthropic 或 Google AI Studio（Gemini/Gemma）等接口，能够通过 LLM 结合预设的场景提示词与历史上下文对文本进行实时后处理，用于优化断句、纠正翻译并提升多段输出的连贯性。

[English](README.md) · [发行版](https://github.com/mochizuki0323/subflow/releases) · [许可证](LICENSE)

## 预览

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## 功能特性

- **实时转录** — Deepgram Nova-3、Gladia Solaria-1 或 NVIDIA Parakeet 本地 ASR（可在设置中切换）
- **本地 ASR (Parakeet)** — 基于 sherpa-onnx 的离线语音识别，通过模拟流式输出实现实时字幕；支持日语及 25 种欧洲语言，无需 API Key
- **远程 Parakeet 服务器** — 将应用指向自建的 Parakeet 推理服务器（`remote_parakeet` provider）：一份已加载的模型被所有客户端共享，可在应用内拉取可用模型列表，VAD 参数可按连接运行时调整
- **语音降噪** — 基于 sherpa-onnx 的噪音抑制（DPDFNet / GTCRN 模型）；在转录前去除背景噪音，提升识别准确率
- **应用级与系统音频捕获** — PipeWire (Linux) 和 WASAPI (Windows)；支持捕获单个应用或整个系统音频输出
- **可选 LLM 层** — 通过 OpenAI 兼容、Anthropic 或 Google AI Studio（Gemini/Gemma）接口进行翻译与后处理；支持场景提示词、历史上下文、按服务商分别保存 API Key，以及「仅翻译最终字幕 / 同时翻译中间结果」的开关（跳过中间结果可避免触发限流）
- **Gladia 专属功能** — 服务端音频增强、实时翻译、情感分析、命名实体识别、自定义词汇、多语言切换
- **叠层 + 历史窗口** — 可拖动、可调整大小的半透明字幕叠层和可滚动历史面板；支持显示中间结果
- **多种字幕模式** — 原文、翻译或双语显示
- **深色 / 浅色 / 跟随系统** — 跟随桌面外观，支持壁纸取色

## 安装

### Linux

从 [Releases](../../releases) 下载最新版本：

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

从 [Releases](../../releases) 下载。

## 从源码构建

### 前置依赖

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

### 构建

```bash
git clone --recursive https://github.com/mochizuki0323/subflow.git
cd subflow
npm install

# 下载预编译的 sherpa-onnx 库（降噪 / Parakeet 所需）
bash scripts/setup-sherpa-onnx.sh

# 拉取 Boost 头文件（后端的 WebSocket/HTTP 层所需）
bash scripts/setup-boost.sh

# 构建全部（后端 + 前端）
bash scripts/build.sh

# 运行
npm start
```

### 打包

```bash
# Linux (AppImage + deb + rpm)
bash scripts/dist-linux.sh

# 从 Linux 交叉编译 Windows 便携版
# 需要: mingw64-gcc-c++ mingw64-openssl mingw64-winpthreads-static
bash scripts/dist-windows.sh
```

## 配置文件

- **Linux**（AppImage / deb / rpm）：`~/.config/subflow_settings/config/`
- **Windows**：exe 同目录下的 `config/` 文件夹

## 自建 Parakeet 服务器

`server/` 目录可构建一个独立的推理服务器（`subflow-parakeet-server`），把 Parakeet ASR 放到一台存放模型的机器上、通过网络为多个客户端服务，而不必在每台设备本地跑模型。

```bash
# 一次性：为服务器拉取 sherpa-onnx
bash scripts/setup-sherpa-onnx.sh linux-x64

# 构建 → server/build/bin/subflow-parakeet-server
bash server/build.sh
```

服务器由单个 JSON 配置驱动，默认从二进制同目录的 `config/config.json` 自动加载（也可用 `--config <path>` 指定；命令行参数会覆盖对应字段）。配置里的相对路径相对配置文件所在目录解析。参见 `server/config.example.json`：

```json
{
  "port": 9090,
  "api_key": "",
  "vad_model": "silero_vad.onnx",
  "models": [
    { "id": "parakeet-ja", "dir": "models/<模型文件夹>", "type": "nemo_ctc" }
  ]
}
```

每个模型的 `id` 即应用中显示并选择的名称；`type` 为 `nemo_ctc` 或 `nemo_transducer`。在应用中选择 **Parakeet 服务器** provider，填入服务器地址（局域网 `ws://host:9090` 或公网 `wss://...`），拉取模型列表并选择一个模型。TLS 由服务器前置的反向代理终止。

## 许可证

[MIT](LICENSE)
