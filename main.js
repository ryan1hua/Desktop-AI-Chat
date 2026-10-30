// ============================================================
//  main.js —— Electron 的「主进程」（后台大脑）
// ------------------------------------------------------------
//  这个文件负责：
//    1. 创建软件窗口
//    2. 保存 / 读取设置（API Key、模型、项目、知识库等）
//    3. 真正联网去调用 DeepSeek 的接口
//    4. 让用户选文件并读成文字 / 图片（供发送和知识库用）
//
//  为什么要放在这里而不是界面里？因为界面是网页、被关在沙箱里，
//  只有主进程才能安全地访问网络和文件系统。
// ============================================================

const { app, BrowserWindow, ipcMain, shell, dialog, session, screen, Menu, clipboard } = require('electron');
const path = require('path');  // 用来拼接文件路径
const fs = require('fs');      // 用来读写文件（保存配置、读附件）
const crypto = require('crypto'); // 生成随机请求 ID（豆包语音接口要）
// 注意：mammoth / pdf-parse 不再在顶部加载，改为解析 .docx/.pdf 时按需 require（省内存）
const { uIOhook } = require('uiohook-napi'); // 全局键盘监听（按住 Ctrl+Alt 录音用）

let mainWindow = null;
let floatingWindow = null;   // 悬浮窗
let floatDragTimer = null;   // 悬浮窗拖动定时器
let floatDragMoved = false;  // 悬浮窗拖动是否发生了位移
let floatCollapsed = false;  // 悬浮窗是否已收成小点（空闲自动收起）
let floatExpandedPos = null; // 收起前的位置，展开时恢复
let ctrlDown = false;        // 全局快捷键：Ctrl 是否按下
let altDown = false;         // 全局快捷键：Alt 是否按下
let keyRecording = false;    // 是否正通过快捷键录音
let appHistory = {};         // 对话历史（内存里的权威副本，启动时从 history.json 读入）

// 悬浮窗的固定尺寸（拖动时也要固定尺寸，避免 Windows 缩放导致窗口变大/漂移）
const FLOAT_W = 560;
const FLOAT_H = 460;

// 默认配置：第一次运行时就用这个
const DEFAULT_CONFIG = {
  apiKey: '',                 // DeepSeek 的密钥，先留空
  glmApiKey: '',              // 智谱 GLM 的密钥（文字对话用，免费模型 glm-4-flash）
  doubaoApiKey: '',           // 豆包语音的 API Key（语音识别用，新版控制台）
  model: 'deepseek-v4-pro',   // 默认模型：DeepSeek V4 PRO
  currentProjectId: 'default',// 当前选中的项目 id
  projects: [                 // 项目列表（每个项目有前置提示 + 知识库）
    {
      id: 'default',
      name: '默认项目',
      systemPrompt: '',        // 前置提示（系统提示词）
      knowledge: []            // 知识库：[{ name, content }]
    }
  ]
};

// ------------------------------------------------------------
//  配置的读取 / 保存 / 兼容旧版本
// ------------------------------------------------------------

// 配置文件放在系统的「用户数据目录」里
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 把读到的配置补全成完整结构（兼容旧版：旧配置只有 apiKey/model，
// 没有 projects 字段，这里自动补上默认项目）
function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...raw };

  // 保证一定有至少一个项目
  if (!Array.isArray(cfg.projects) || cfg.projects.length === 0) {
    cfg.projects = [{ id: 'default', name: '默认项目', systemPrompt: '', knowledge: [] }];
  }
  // 保证每个项目的知识库字段都存在
  cfg.projects = cfg.projects.map((p) => ({
    ...p,
    systemPrompt: p.systemPrompt || '',
    knowledge: Array.isArray(p.knowledge) ? p.knowledge : []
  }));
  // 保证当前项目 id 是有效的
  if (!cfg.projects.some((p) => p.id === cfg.currentProjectId)) {
    cfg.currentProjectId = cfg.projects[0].id;
  }
  return cfg;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG, projects: DEFAULT_CONFIG.projects.map((p) => ({ ...p })) };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

// ------------------------------------------------------------
//  创建窗口
// ------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 620,
    minHeight: 480,
    backgroundColor: '#ffffff',
    title: 'Desktop Chat',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  // 外链用系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 创建悬浮窗（置顶、透明、点一下录音）
function createFloatingWindow() {
  floatingWindow = new BrowserWindow({
    width: FLOAT_W,
    height: FLOAT_H,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  floatingWindow.loadFile('floating.html');
  floatingWindow.setAlwaysOnTop(true, 'screen-saver');
  // 默认让透明区域鼠标穿透，悬停到按钮/消息框时才接收鼠标
  floatingWindow.setIgnoreMouseEvents(true, { forward: true });

  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });
}

// 全局快捷键：按住 Ctrl + Alt 开始录音，松开结束
function setupGlobalShortcut() {
  const KEY_CTRL = [29, 3613]; // 左 Ctrl = 29，右 Ctrl = 3613
  const KEY_ALT = [56, 3640];  // 左 Alt = 56，右 Alt = 3640

  uIOhook.on('keydown', (e) => {
    if (KEY_CTRL.includes(e.keycode)) ctrlDown = true;
    if (KEY_ALT.includes(e.keycode)) altDown = true;
    if (ctrlDown && altDown && !keyRecording) {
      keyRecording = true;
      sendToFloating('record-start');
    }
  });

  uIOhook.on('keyup', (e) => {
    if (KEY_CTRL.includes(e.keycode)) ctrlDown = false;
    if (KEY_ALT.includes(e.keycode)) altDown = false;
    if (keyRecording && (!ctrlDown || !altDown)) {
      keyRecording = false;
      sendToFloating('record-stop');
    }
  });

  try {
    uIOhook.start();
  } catch (err) {
    console.error('全局快捷键启动失败：', err);
  }
}

// 安全地把数据推给界面
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// 把消息推给悬浮窗（录音开始/停止、附件等）
function sendToFloating(channel, data) {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send(channel, data);
  }
}

// ------------------------------------------------------------
//  和界面通信（IPC）
// ------------------------------------------------------------

// 界面问「设置是什么」→ 返回配置
ipcMain.handle('get-config', () => loadConfig());

// 界面说「保存这个设置」→ 存起来
ipcMain.handle('save-config', (_event, cfg) => {
  saveConfig(normalizeConfig(cfg));
  return true;
});

// ------------------------------------------------------------
//  对话历史：单独存 history.json，重启后还能看到之前的对话。
//  主进程内存里保留一份权威副本 appHistory，主界面和悬浮窗共用它。
// ------------------------------------------------------------
function getHistoryPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

// 从磁盘把历史读进内存（启动时调用一次）
function loadHistoryFromDisk() {
  try {
    appHistory = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf-8'));
  } catch {
    appHistory = {}; // 还没有历史文件
  }
}

function saveHistoryToDisk() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getHistoryPath(), JSON.stringify(appHistory, null, 2), 'utf-8');
  } catch (err) {
    console.error('保存对话历史失败：', err);
  }
}

ipcMain.handle('load-history', () => appHistory);

ipcMain.handle('save-history', (_event, history) => {
  appHistory = history || {};
  saveHistoryToDisk();
  return true;
});

// 界面说「帮我识别这段语音」→ 调用豆包语音（录音文件识别·极速版）接口
ipcMain.handle('transcribe', async (_event, audioWav) => {
  const cfg = loadConfig();
  if (!cfg.doubaoApiKey) {
    throw new Error('请先在设置里填写「豆包 API Key」');
  }

  // 音频转 base64（豆包语音接口用 JSON 传 base64 音频）
  const audioBase64 = Buffer.from(audioWav).toString('base64');

  const body = {
    user: { uid: 'deepseek-chat' },
    audio: { data: audioBase64, format: 'wav', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,   // 数字/中文规范化
      enable_punc: true,  // 加标点
      enable_ddc: false,
      show_utterances: false
    }
  };

  let res;
  try {
    res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': cfg.doubaoApiKey,             // 豆包语音的 API Key
        'X-Api-Resource-Id': 'volc.seedasr.auc',   // 资源 ID（Seed-ASR 2.0 录音文件识别）
        'X-Api-Request-Id': crypto.randomUUID(),   // 随机请求 ID
        'X-Api-Sequence': '-1'
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error('网络请求失败：' + err.message);
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`豆包 ASR 错误 ${res.status}：${t}`);
  }

  const data = await res.json();
  const code = (data && data.resp && data.resp.status_code) ?? (data && data.status_code);
  if (code && code !== 20000000) {
    if (code === 20000003) throw new Error('没有识别到语音内容，请再试一次');
    throw new Error(`豆包 ASR 返回错误码 ${code}`);
  }
  return (data && data.result && data.result.text) || '';
});

// 把「语音文字 + 附件」组合成要发给接口的消息内容（和 renderer.js 的 buildUserContent 格式一致）
function buildUserContent(text, attachment) {
  if (!attachment) return text;

  const parts = [];
  if (text) parts.push({ type: 'text', text });
  if (attachment.type === 'image') {
    parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
  } else {
    parts.push({ type: 'text', text: `【文件：${attachment.name}】\n${attachment.content}` });
  }
  return parts;
}

// ------------------------------------------------------------
//  服务商 / 模型路由（DeepSeek + 智谱 GLM）
// ------------------------------------------------------------
const PROVIDERS = {
  deepseek: { base: 'https://api.deepseek.com', keyField: 'apiKey', label: 'DeepSeek' },
  glm: { base: 'https://open.bigmodel.cn/api/paas/v4', keyField: 'glmApiKey', label: '智谱 GLM' }
};

// 模型 id → 服务商：glm-4-flash 走智谱，其余走 DeepSeek
function providerOf(model) {
  return model === 'glm-4-flash' ? 'glm' : 'deepseek';
}

// 纯文本模型（如智谱 GLM-4-Flash）不接受数组/图片格式的 content，这里统一压成纯文本字符串
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return '';
        if (p.type === 'text') return p.text || '';
        if (p.type === 'image_url') return '【图片】';
        return '';
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  return String(content || '');
}

// 智谱 GLM 是纯文本模型，把历史里带附件（数组/图片）的消息压成字符串
function normalizeMessages(provider, messages) {
  if (provider !== 'glm') return messages;
  return messages.map((m) => ({ ...m, content: contentToText(m.content) }));
}

// ------------------------------------------------------------
//  上下文（时间）：让 AI 知道「现在几点」
// ------------------------------------------------------------
function timeText() {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  return d.toLocaleString('zh-CN', { hour12: false }) + (tz ? '（' + tz + '）' : '');
}

function contextText() {
  return '当前时间：' + timeText();
}

ipcMain.handle('get-context', () => contextText());

// 悬浮窗快速对话：识别文字（可带附件）→ AI 回复（一次性，非流式）。
// 使用主软件当前项目的知识库 + 前置提示 + 历史消息，并把问答写回共享历史。
ipcMain.handle('quick-chat', async (_event, text, attachment) => {
  const cfg = loadConfig();
  const provider = providerOf(cfg.model);
  const { base, keyField, label } = PROVIDERS[provider];
  const apiKey = cfg[keyField] || '';
  if (!apiKey) {
    throw new Error('请先在设置里填写 ' + label + ' 的 API Key');
  }

  const project = cfg.projects.find((p) => p.id === cfg.currentProjectId) || cfg.projects[0];
  const projectId = project ? project.id : 'default';

  // 拼 system 消息（时间上下文 + 前置提示 + 知识库）
  let sys = contextText();
  if (project && project.systemPrompt) {
    sys += (sys ? '\n\n' : '') + project.systemPrompt;
  }
  const kb = (project && project.knowledge) || [];
  if (kb.length) {
    const kbText = kb.map((k) => `【${k.name}】\n${k.content}`).join('\n\n');
    sys += (sys ? '\n\n' : '') + '以下是知识库内容，回答时请优先参考：\n' + kbText;
  }

  // 这条语音消息的 content（可能带附件）
  const userContent = buildUserContent(text, attachment);

  // 组装消息：system + 该项目历史 + 新语音消息（智谱纯文本模型会把数组内容压成字符串）
  const messages = normalizeMessages(provider, [
    ...(sys ? [{ role: 'system', content: sys }] : []),
    ...(appHistory[projectId] || []),
    { role: 'user', content: userContent }
  ]);

  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: cfg.model, messages, stream: false })
    });
  } catch (err) {
    throw new Error('网络请求失败：' + err.message);
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI 错误 ${res.status}：${t}`);
  }

  const data = await res.json();
  const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

  // 把这一问一答写进共享历史，主界面也会显示
  if (!appHistory[projectId]) appHistory[projectId] = [];
  appHistory[projectId].push({ role: 'user', content: userContent });
  appHistory[projectId].push({ role: 'assistant', content: reply });
  saveHistoryToDisk();
  sendToRenderer('history-updated', appHistory);

  return reply;
});

// 窗口内有焦点时的本地快捷键（兜底）。
// 已知问题：uiohook 全局钩子在「应用被聚焦 + 麦克风已激活」时会漏发 keyup，
// 导致松开 Ctrl+Alt 收不到停止信号。所以当窗口有焦点时，由窗口内监听来触发，
// 走这两个通道转发给悬浮窗（悬浮窗的录音函数是幂等的，重复触发无副作用）。
ipcMain.handle('local-record-start', () => {
  ctrlDown = true; altDown = true; keyRecording = true;
  sendToFloating('record-start');
  return true;
});
ipcMain.handle('local-record-stop', () => {
  ctrlDown = false; altDown = false; keyRecording = false;
  sendToFloating('record-stop');
  return true;
});

// 悬浮窗鼠标穿透开关
ipcMain.handle('set-float-ignore-mouse', (_event, ignore) => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
  return true;
});

// 悬浮窗空闲自动收起：把窗口右移到屏幕右边缘，只留麦克风按钮的左半边露在屏内（低功耗状态）。
// 麦克风按钮在悬浮窗内的坐标（和 floating.css 的 .mic-btn 一致）
const FLOAT_MIC_X = 350;   // .mic-btn left: 350px
const FLOAT_MIC_HALF = 24; // 麦克风按钮一半宽（48/2），收起时留这一半在屏幕内

ipcMain.handle('float-collapse', () => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return false;
  if (floatCollapsed) return true;
  const [wx, wy] = floatingWindow.getPosition();
  floatExpandedPos = { x: wx, y: wy };
  // 用窗口所在屏幕的工作区右边界，把麦克风左半边停在屏幕右边缘
  const display = screen.getDisplayMatching({ x: wx, y: wy, width: FLOAT_W, height: FLOAT_H });
  const rightEdge = display.workArea.x + display.workArea.width;
  const newX = rightEdge - FLOAT_MIC_X - FLOAT_MIC_HALF;
  floatingWindow.setBounds({ x: Math.round(newX), y: wy, width: FLOAT_W, height: FLOAT_H });
  floatCollapsed = true;
  return true;
});

ipcMain.handle('float-expand', () => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return false;
  if (!floatCollapsed) return true;
  const pos = floatExpandedPos || (() => {
    const [x, y] = floatingWindow.getPosition();
    return { x, y };
  })();
  floatingWindow.setBounds({ x: Math.round(pos.x), y: Math.round(pos.y), width: FLOAT_W, height: FLOAT_H });
  floatCollapsed = false;
  return true;
});

// 悬浮窗拖动：开始拖动。
// 关键：Windows 高分屏下用 setPosition 移动窗口会让窗口被「拉大」、越拖越漂，
// 所以这里改用 setBounds 并固定宽高（FLOAT_W/FLOAT_H）。
// 鼠标屏幕坐标和窗口坐标都是 DIP，可直接相减。
ipcMain.handle('start-float-drag', () => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return false;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = floatingWindow.getPosition();
  const start = { cx: cursor.x, cy: cursor.y, wx, wy };
  floatDragMoved = false;
  clearInterval(floatDragTimer);
  floatDragTimer = setInterval(() => {
    const c = screen.getCursorScreenPoint();
    const dx = c.x - start.cx;
    const dy = c.y - start.cy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) floatDragMoved = true;
    if (floatDragMoved) {
      floatingWindow.setBounds({
        x: Math.round(start.wx + dx),
        y: Math.round(start.wy + dy),
        width: FLOAT_W,
        height: FLOAT_H
      });
    }
  }, 16);
  return true;
});

// 悬浮窗拖动：结束拖动，返回是否发生了位移（没位移当作点击）
ipcMain.handle('stop-float-drag', () => {
  clearInterval(floatDragTimer);
  floatDragTimer = null;
  const moved = floatDragMoved;
  floatDragMoved = false;
  return moved;
});

// 右键消息框 → 弹出「复制」
ipcMain.on('show-msg-menu', (event, text) => {
  const menu = Menu.buildFromTemplate([
    { label: '复制', click: () => { clipboard.writeText(String(text || '')); } }
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// 悬浮窗气泡菜单的四个动作（右键麦克风按钮 → 气泡 → 触发这些接口）

// 选择模型（气泡子菜单）：更新共享模型，主界面同步
ipcMain.handle('set-model', (_event, id) => {
  const cfg = loadConfig();
  cfg.model = id;
  saveConfig(cfg);
  sendToRenderer('model-changed', id);
  return true;
});

// 输入文件：弹文件框并读成附件（返回给悬浮窗）
ipcMain.handle('pick-float-file', async () => {
  const result = await dialog.showOpenDialog(floatingWindow, {
    properties: ['openFile'],
    filters: [{ name: '支持的文件', extensions: ['txt', 'md', 'csv', 'json', 'pdf', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'jfif', 'svg'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return readFileAsAttachment(result.filePaths[0]);
});

// 读取剪贴板里「文件」的本地路径（从资源管理器复制的 PDF/DOC 等），读不到返回 null
function readClipboardFilePath() {
  try {
    // Windows：文件在剪贴板里是 CF_HDROP。Electron 里用 readBuffer('FileNameW') 直接读，
    // 它不在 availableFormats() 里，但 readBuffer 能拿到 UTF-16LE 的完整路径。
    const wide = clipboard.readBuffer('FileNameW');
    if (wide && wide.length > 0) {
      let name = '';
      for (let i = 0; i + 1 < wide.length; i += 2) {
        const ch = wide.readUInt16LE(i);
        if (ch === 0) break;
        name += String.fromCharCode(ch);
      }
      if (name) return name;
    }

    // 兜底：text/uri-list（file:// 路径）
    const uris = clipboard.read('text/uri-list');
    if (uris) {
      const m = uris.match(/file:\/\/\/[^\r\n]+/);
      if (m) return decodeURIComponent(m[0].slice('file:///'.length));
    }
  } catch (e) {
    // 解析失败就返回 null
  }
  return null;
}

// 输入粘贴栏：读剪贴板（文字 / 截图 / 文件）成附件
ipcMain.handle('read-float-clipboard', async () => {
  const text = clipboard.readText();
  if (text && text.trim()) {
    return { type: 'text', name: '剪贴板文本', content: text };
  }
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    return { type: 'image', name: '剪贴板图片.png', dataUrl: img.toDataURL() };
  }
  const filePath = readClipboardFilePath();
  if (filePath && fs.existsSync(filePath)) {
    return await readFileAsAttachment(filePath);
  }
  throw new Error('剪贴板里没有可用的文字、图片或文件');
});

// 退出
ipcMain.handle('quit-app', () => {
  app.quit();
  return true;
});

// 显示主界面（悬浮窗气泡「主界面」）
ipcMain.handle('show-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  return true;
});

// 把一个文件路径读成附件（图片→base64，文本/PDF/DOCX→文字）。
// 返回 { type:'image', name, dataUrl } 或 { type:'text', name, content }
async function readFileAsAttachment(filePath) {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // —— 图片：读成 base64 数据网址（发给支持视觉的模型） ——
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.jfif', '.svg'];
  const MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.jfif': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  if (IMAGE_EXTS.includes(ext)) {
    const data = fs.readFileSync(filePath);
    return { type: 'image', name, dataUrl: `data:${MIME[ext]};base64,${data.toString('base64')}` };
  }

  // —— PDF / Word：解析成文字 ——
  try {
    if (ext === '.pdf') {
      const { PDFParse } = require('pdf-parse');   // 按需加载，省内存
      const data = fs.readFileSync(filePath);
      const parser = new PDFParse({ data });
      const parsed = await parser.getText();
      await parser.destroy();
      // pdf-parse 会在每页后加 "-- 1 of N --" 的分页标记，这里去掉
      const text = ((parsed && parsed.text) || '').replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();
      return { type: 'text', name, content: text };
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');   // 按需加载，省内存
      const parsed = await mammoth.extractRawText({ path: filePath });
      return { type: 'text', name, content: (parsed && parsed.value) || '' };
    }
    if (ext === '.doc') {
      throw new Error('暂不支持旧版 .doc 格式，请用 Word 另存为 .docx 后再上传');
    }
  } catch (err) {
    throw new Error('解析文件失败：' + err.message);
  }

  // —— 纯文本文件：直接读成文字 ——
  const TEXT_EXTS = [
    '.txt', '.md', '.csv', '.json', '.js', '.ts', '.py', '.log', '.html', '.css',
    '.xml', '.yaml', '.yml', '.ini', '.conf', '.sh', '.bat',
    '.c', '.cpp', '.h', '.java', '.go', '.rs', '.rb', '.php', '.sql'
  ];
  if (TEXT_EXTS.includes(ext) || ext === '') {
    return { type: 'text', name, content: fs.readFileSync(filePath, 'utf-8') };
  }

  // 其它类型：给个明确提示，别把二进制当文字读
  throw new Error('不支持的文件格式：' + (ext || '未知'));
}

// 界面说「帮我选一个文件」→ 弹文件选择框，把文件读成文字 / 图片 / 解析好的文本
ipcMain.handle('pick-and-read-file', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      {
        name: '支持的文件',
        extensions: [
          'txt', 'md', 'csv', 'json', 'js', 'ts', 'py', 'log', 'html', 'css', 'xml',
          'pdf', 'docx', 'doc',
          'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'jfif', 'svg'
        ]
      }
    ]
  });

  // 用户点了取消
  if (result.canceled || !result.filePaths.length) return null;

  return readFileAsAttachment(result.filePaths[0]);
});

// 界面说「帮我问 DeepSeek」→ 这里真正联网调用
ipcMain.handle('chat', async (event, payload) => {
  const { apiKey, model, messages } = payload;

  if (!apiKey) {
    throw new Error('请先填写 API Key');
  }

  // 按模型路由到对应服务商（DeepSeek / 智谱 GLM），都是 OpenAI 兼容接口。
  const provider = providerOf(model);
  const url = PROVIDERS[provider].base + '/chat/completions';
  const apiMessages = normalizeMessages(provider, messages);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages: apiMessages, stream: true })
    });
  } catch (err) {
    throw new Error('网络请求失败：' + err.message);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API 错误 ${res.status}：${text}`);
  }

  // 逐段读取服务器返回的内容
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          sendToRenderer('chat-done');
          return;
        }

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            sendToRenderer('chat-reasoning', delta.reasoning_content);
          } else if (delta?.content) {
            sendToRenderer('chat-chunk', delta.content);
          }
        } catch {
          // 个别行解析失败就跳过
        }
      }
    }
  } finally {
    reader.releaseLock();
    sendToRenderer('chat-done');
  }
});

// ------------------------------------------------------------
//  应用生命周期
// ------------------------------------------------------------
// —— 省内存 / 省功耗 ——
// 关掉 GPU 硬件加速：消掉 GPU 进程（省内存 + 大幅降功耗），毛玻璃模糊也随之失效
app.disableHardwareAcceleration();
// 限制渲染进程 V8 堆，避免聊天历史变大时内存越涨越高
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');

app.whenReady().then(() => {
  // 允许麦克风访问（语音输入用）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
  });

  // 先把对话历史读进内存，主界面和悬浮窗共用
  loadHistoryFromDisk();

  createWindow();
  createFloatingWindow();
  setupGlobalShortcut();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createFloatingWindow();
    }
  });
});

// 退出前停掉全局键盘监听
app.on('will-quit', () => {
  try { uIOhook.stop(); } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
