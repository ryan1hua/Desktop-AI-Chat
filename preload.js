// ============================================================
//  preload.js —— 界面和主进程之间的「安全桥梁」
// ------------------------------------------------------------
//  把允许用到的功能打包成 window.api 暴露给界面（主窗口和悬浮窗共用）。
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // —— 设置 / 项目 ——
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  // —— 对话历史 ——
  loadHistory: () => ipcRenderer.invoke('load-history'),
  saveHistory: (history) => ipcRenderer.invoke('save-history', history),

  // —— 选文件（附件 / 知识库） ——
  pickFile: () => ipcRenderer.invoke('pick-and-read-file'),

  // —— 对话 ——
  chat: (payload) => ipcRenderer.invoke('chat', payload),

  // —— 语音识别（豆包 Seed-ASR） ——
  transcribe: (audioWav) => ipcRenderer.invoke('transcribe', audioWav),

  // —— 悬浮窗快速对话（识别文字 + 可选附件 → AI 回复，一次性） ——
  quickChat: (text, attachment) => ipcRenderer.invoke('quick-chat', text, attachment),

  // —— 上下文（当前时间 + 用户位置） ——
  getContext: () => ipcRenderer.invoke('get-context'),

  // —— 悬浮窗鼠标穿透开关 ——
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-float-ignore-mouse', ignore),

  // —— 悬浮窗拖动 ——
  startFloatDrag: () => ipcRenderer.invoke('start-float-drag'),
  stopFloatDrag: () => ipcRenderer.invoke('stop-float-drag'),

  // —— 悬浮窗空闲收起 / 展开 ——
  floatCollapse: () => ipcRenderer.invoke('float-collapse'),
  floatExpand: () => ipcRenderer.invoke('float-expand'),

  // —— 悬浮窗右键菜单 ——
  showMsgMenu: (text) => ipcRenderer.send('show-msg-menu', text),  // 右键消息框 → 复制

  // —— 悬浮窗气泡菜单动作 ——
  pickFloatFile: () => ipcRenderer.invoke('pick-float-file'),        // 输入文件
  readFloatClipboard: () => ipcRenderer.invoke('read-float-clipboard'), // 输入粘贴栏
  setModel: (id) => ipcRenderer.invoke('set-model', id),            // 选择模型
  quitApp: () => ipcRenderer.invoke('quit-app'),                    // 退出
  showMain: () => ipcRenderer.invoke('show-main'),                  // 显示主界面

  // —— 监听主进程推来的流式内容 ——
  onChunk: (cb) => ipcRenderer.on('chat-chunk', (_e, chunk) => cb(chunk)),
  onReasoning: (cb) => ipcRenderer.on('chat-reasoning', (_e, chunk) => cb(chunk)),
  onDone: (cb) => ipcRenderer.on('chat-done', () => cb()),

  // —— 全局快捷键触发录音 ——
  onRecordStart: (cb) => ipcRenderer.on('record-start', () => cb()),
  onRecordStop: (cb) => ipcRenderer.on('record-stop', () => cb()),

  // —— 悬浮窗语音问答写回共享历史后，主界面同步；模型变更同步 ——
  onHistoryUpdated: (cb) => ipcRenderer.on('history-updated', (_e, history) => cb(history)),
  onModelChanged: (cb) => ipcRenderer.on('model-changed', (_e, model) => cb(model)),

  // —— 窗口内有焦点时的本地快捷键（兜底，见 floating.js 说明） ——
  localRecordStart: () => ipcRenderer.invoke('local-record-start'),
  localRecordStop: () => ipcRenderer.invoke('local-record-stop')
});
