# 🎙️ SubFlow — 实时语音字幕

<p align="center">
    <img src="resources/icon.svg" alt="SubFlow" width="360">
</p>

<p align="center">
  <a href="https://github.com/mochizuki0323/subflow/actions/workflows/release.yml?branch=master"><img src="https://img.shields.io/github/actions/workflow/status/mochizuki0323/subflow/release.yml?branch=master&style=for-the-badge&label=Release%20CI" alt="Release CI 状态"></a>
  <a href="https://github.com/mochizuki0323/subflow/releases"><img src="https://img.shields.io/github/v/release/mochizuki0323/subflow?include_prereleases&style=for-the-badge" alt="GitHub 发行版"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

SubFlow 把机器上正在播放的声音变成实时字幕。识别基于 sherpa-onnx 上的 NVIDIA Parakeet——默认完全在本机运行，音频不会离开这台机器；也可以指向一台自建的推理服务器。文本还可以选择性地经过 LLM（OpenAI 兼容、Anthropic 或 Google AI Studio）做翻译与后处理，配合场景提示词和滚动上下文，让多段输出保持连贯。

[English](README.md) · [Releases](https://github.com/mochizuki0323/subflow/releases) · [许可证](LICENSE)

## 预览

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## 功能特性

- **跑在你自己的机器上** — 基于 sherpa-onnx 的 NVIDIA Parakeet 离线识别，通过模拟流式输出实现实时字幕；支持日语及 25 种欧洲语言。除非你主动选择远程引擎，否则没有任何数据被发出去
- **远程引擎（可选）** — 把应用指向自建的 Parakeet 服务器：一份已加载的模型服务所有客户端，可在应用内拉取模型列表，VAD 参数可按连接运行时调整
- **应用级捕获** — PipeWire (Linux) 和 WASAPI (Windows)。Linux 上会直接连接目标应用的输出端口，所以可以只给一个应用加字幕，其他应用照常出声
- **界面就是信号路径** — 音频源 → 降噪 → 识别 → 翻译 → 输出，按顺序排列。每一级汇报自己实际在做什么；关掉某一级是「旁路」而不是「断链」；真正阻断信号的那一级会明说——包括「两个输出窗口都关着」这个最常见的「什么都看不到」的原因
- **是仪表，不是转圈** — 实时波形、电平与峰值、识别延迟、丢弃音频。每个数字都是量出来的，没有装饰性读数
- **可选 LLM 层** — 通过 OpenAI 兼容、Anthropic 或 Google AI Studio 接口做翻译与后处理；支持场景提示词、滚动上下文、按服务商分别保存 API Key，以及「仅翻译定稿 / 同时翻译中间结果」开关（跳过中间结果可避免触发限流）
- **叠层 + 历史窗口** — 可拖动、可缩放的字幕叠层和可滚动的完整记录；原文、翻译或双语
- **导出** — 可导出为 SRT（使用真实媒体时间戳，译文作为字幕的第二行）或纯文本
- **语音降噪** — 基于 sherpa-onnx 的噪音抑制（DPDFNet / GTCRN）。注意它在多数情况下反而会*损害*识别准确率，建议仅在背景噪音明显时开启
- **深色 / 浅色 / 跟随系统** — 跟随桌面外观，并可从壁纸提取强调色
- **键盘可达** — 包括选择音频源在内的所有主要操作

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

### 构建

```bash
git clone https://github.com/mochizuki0323/subflow.git
cd subflow
npm install

# 拉取 vendored 依赖（uWebSockets + uSockets、nlohmann/json、Boost 头文件）
bash scripts/setup-deps.sh

# 下载预编译的 sherpa-onnx 库（降噪 / Parakeet 所需）
bash scripts/setup-sherpa-onnx.sh

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

每个模型的 `id` 即应用中显示并选择的名称；`type` 为 `nemo_ctc` 或 `nemo_transducer`。在应用的「识别」页选择 **远程服务器** 引擎，填入地址（局域网 `ws://host:9090` 或公网 `wss://...`），拉取模型列表并选择一个模型。TLS 由服务器前置的反向代理终止。

## 许可证

[MIT](LICENSE)
