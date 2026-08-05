# 🎙️ SubFlow — 实时语音字幕

<p align="center">
    <img src="resources/icon.svg" alt="SubFlow" width="360">
</p>

<p align="center">
  <a href="https://github.com/mochizuki0323/subflow/actions/workflows/release.yml?branch=master"><img src="https://img.shields.io/github/actions/workflow/status/mochizuki0323/subflow/release.yml?branch=master&style=for-the-badge&label=Release%20CI" alt="Release CI 状态"></a>
  <a href="https://github.com/mochizuki0323/subflow/releases"><img src="https://img.shields.io/github/v/release/mochizuki0323/subflow?include_prereleases&style=for-the-badge" alt="GitHub 发行版"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

SubFlow 把电脑上正在播放的声音变成实时字幕。识别通过 sherpa-onnx 运行 NVIDIA 的 Parakeet 或 Nemotron 模型，默认完全在本机进行，音频不会离开这台机器；也可以连接自己搭建的 Parakeet 服务器。识别出的文本还可以交给 LLM（OpenAI 兼容、Anthropic 或 Google AI Studio）翻译和润色，配合场景提示词与滚动上下文，多段字幕之间也能保持连贯。

[English](README.md) · [Releases](https://github.com/mochizuki0323/subflow/releases) · [许可证](LICENSE)

## 预览

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## 功能特性

- **本地识别（Parakeet）** — 基于 sherpa-onnx 的离线语音识别，用模拟流式做到实时出字；支持日语和 25 种欧洲语言
- **本地识别（Nemotron）** — NVIDIA Nemotron 3.5 原生流式模型：声音进、文字出，断句由模型自己判断，不需要 VAD；支持中日韩在内的 33 个语言区域，断句时机和 CPU 占用都能在应用里调
- **远程引擎（可选）** — 识别也可以放在自己搭的 Parakeet 服务器上跑：模型只在服务器上加载一份，多个客户端共用，应用内可以直接拉取模型列表，每个连接的 VAD 参数还能在线调整
- **应用级与系统音频捕获** — PipeWire (Linux) 和 WASAPI (Windows)；可以只录某一个应用，也可以录整个系统的声音
- **实时监控** — 波形、电平与峰值、识别延迟、丢音统计
- **可选 LLM 层** — 通过 OpenAI 兼容、Anthropic 或 Google AI Studio 接口做翻译与后处理；支持场景提示词、滚动上下文、按服务商分别保存 API Key，以及「仅翻译定稿 / 同时翻译中间结果」开关（跳过中间结果可避免触发限流）
- **悬浮字幕 + 历史窗口** — 可拖动、可调大小的悬浮字幕窗，加一个可滚动的完整字幕记录；显示原文、译文或双语
- **导出** — 保存为 SRT（真实媒体时间戳，译文作为字幕的第二行）或纯文本
- **语音降噪** — 基于 sherpa-onnx 的噪音抑制（DPDFNet / GTCRN）。注意多数情况下它反而会*拖累*识别准确率，背景噪音确实很大时再开
- **深色 / 浅色 / 跟随系统** — 跟随桌面外观，并可从壁纸提取强调色

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

# 下载预编译的 sherpa-onnx 库（识别引擎和降噪都要用）
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

如果有一台放得下模型的机器，可以用 `server/` 目录构建独立的推理服务器（`subflow-parakeet-server`），让多台设备通过网络共用它做识别，每台客户端就不用各自在本地跑模型了。

```bash
# 一次性：为服务器拉取 sherpa-onnx
bash scripts/setup-sherpa-onnx.sh linux-x64

# 构建 → server/build/bin/subflow-parakeet-server
bash server/build.sh
```

服务器的全部配置都在一个 JSON 文件里，默认读取二进制同目录的 `config/config.json`（也可以用 `--config <path>` 指定；命令行参数会覆盖对应字段）。配置里的相对路径以配置文件所在目录为基准。参见 `server/config.example.json`：

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

每个模型的 `id` 就是应用里显示和选择的名称；`type` 为 `nemo_ctc` 或 `nemo_transducer`。然后在应用的「识别」页选择 **Parakeet 服务器** 引擎，填入服务器地址（局域网用 `ws://host:9090`，公网用 `wss://...`），拉取模型列表后选一个即可。TLS 由服务器前面的反向代理负责。

## 许可证

[MIT](LICENSE)
