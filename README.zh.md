# SubFlow

[English](README.md)

实时语音字幕，支持 LLM 翻译，基于 Deepgram 语音识别。

SubFlow 捕获系统音频，通过 Deepgram 语音转文字 API 实时转录，并在半透明叠层窗口中显示字幕。可选的翻译功能将字幕片段发送到 OpenAI 兼容的 LLM 接口进行实时翻译。

## 预览

<p>
  <img alt="subflow1" src="docs/screenshots/subflow1.png" width="32%" />
  <img alt="subflow2" src="docs/screenshots/subflow2.png" width="32%" />
  <img alt="subflow3" src="docs/screenshots/subflow3.png" width="32%" />
</p>

## 功能特性

- **实时转录** — Deepgram Nova-3 流式语音转文字
- **系统音频捕获** — 支持 PipeWire (Linux) 和 WASAPI (Windows)
- **实时翻译** — 可选 LLM 翻译，支持任意 OpenAI 兼容接口
- **叠层 + 历史窗口** — 可拖动、可调整大小的半透明字幕叠层和可滚动历史面板
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

- **Linux**（AppImage / deb / rpm）：`~/.config/subflow_settings`
- **Windows**：与 exe 同目录

## 许可证

[MIT](LICENSE)
