# Desktop Chat

一个基于 **Electron** 的 Windows 桌面 AI 助手，初衷是「全局快捷键 + 置顶悬浮窗」实现在生活中与AI的无感交互，支持流式对话、多项目管理、知识库、多模态文件上传和语音输入。不打断用户当前工作即可随时提问。

> 📖 面向最终用户的使用说明，请查看 [操作手册.md](./操作手册.md)。

## 技术栈

- **Electron**（主进程 + 渲染进程，`contextIsolation` / `nodeIntegration: false` 安全隔离）
- **JavaScript / Node.js**
- 大模型：DeepSeek（主力）、智谱 GLM（免费备用），OpenAI 兼容接口
- 语音识别：豆包 Seed-ASR 2.0
- 文件解析：`pdf-parse`（PDF）、`mammoth`（DOCX）
- 全局快捷键：`uiohook-napi`
- 打包：`electron-builder`（Windows 便携版 exe）

## 功能特性

- 流式对话（逐字输出）+ 推理过程折叠
- 多服务商路由：DeepSeek / 智谱 GLM 自动切换
- 多项目管理：每个项目独立的前置提示（system prompt）+ 知识库 + 历史
- 多模态：图片（base64 视觉格式）、PDF、Word、纯文本文件发送，复制粘贴上传
- 语音输入：录音 → 16kHz 重采样 → WAV → 豆包 Seed-ASR 转文字
- 悬浮窗：置顶、透明、全局快捷键 `Ctrl + Alt` 录音、气泡菜单、拖动、空闲自动收起
- 对话历史持久化（`history.json`）、配置持久化（`config.json`）

## 快速开始

### 环境要求

- Node.js ≥ 18
- Windows（语音输入 / 全局快捷键依赖 Windows API）

### 安装依赖

```bash
npm install
```

### 运行

```bash
npm start
```

> `npm start` 会通过 `launch.js` 启动，启动前会清理环境变量 `ELECTRON_RUN_AS_NODE`，避免 Electron 退化为纯 Node 模式导致窗口打不开。

### 打包

```bash
npm run dist
```

会在 `dist/` 下生成 Windows 便携版 exe。

## 项目结构

```
deepseek-chat/
├── main.js           # 主进程：窗口创建、API 调用、语音识别、配置/历史读写
├── preload.js        # 预加载脚本：contextBridge 暴露 window.api（主/悬浮窗共用）
├── renderer.js       # 主界面渲染进程逻辑
├── voice.js          # 主界面语音输入模块
├── index.html        # 主界面结构
├── styles.css        # 主界面样式
├── floating.html     # 悬浮窗结构
├── floating.css      # 悬浮窗样式
├── floating.js       # 悬浮窗逻辑
├── launch.js         # 开发启动器（清理环境变量）
├── package.json      # 项目清单与打包配置
└── 操作手册.md        # 面向用户的使用手册
```

## 架构说明

运行时共 **3 个进程**：

1. **主进程**（`main.js`）：联网调用大模型 / 语音识别、读写文件与配置、管理两个窗口
2. **渲染进程 A（主界面）**：`index.html` + `renderer.js`
3. **渲染进程 B（悬浮窗）**：`floating.html` + `floating.js`

三者通过 `preload.js` 暴露的 `window.api` 用 **IPC** 通信：请求/响应用 `ipcRenderer.invoke` ↔ `ipcMain.handle`，流式输出等持续推送用 `webContents.send` ↔ `ipcRenderer.on`。

API Key 统一存放在主进程（`config.json`），不暴露给渲染进程，规避 CORS 与密钥泄露风险。

## 配置与数据

- 配置（API Key / 模型 / 项目）与对话历史保存在系统用户数据目录（`app.getPath('userData')`）下的 `config.json`、`history.json`。

## License

MIT
