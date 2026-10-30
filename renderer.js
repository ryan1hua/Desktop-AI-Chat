// ============================================================
//  renderer.js —— 界面的「行为逻辑」
// ------------------------------------------------------------
//  负责界面上的所有交互：
//    - 切换模型 / 项目
//    - 打开 / 保存设置、管理项目（前置提示 + 知识库）
//    - 添加附件（图片 / 文本文件）、发送消息
//    - 接收并显示 AI 的回复（流式 + 推理过程折叠）
// ============================================================

// 支持的模型列表：key 是接口用的名字，label 是界面显示的名字
const MODELS = {
  'deepseek-v4-pro': { label: 'DeepSeek V4 PRO', desc: '最新旗舰' },
  'deepseek-chat': { label: 'DeepSeek-V3', desc: '通用对话 · 快速' },
  'deepseek-reasoner': { label: 'DeepSeek-R1', desc: '深度推理 · 更强' },
  'glm-4-flash': { label: '智谱 GLM-4-Flash', desc: '免费 · 快速' }
};

// 当前配置（从主进程读来）：apiKey、glmApiKey、model、currentProjectId、projects
let config = { apiKey: '', glmApiKey: '', model: 'deepseek-v4-pro', currentProjectId: 'default', projects: [] };

// 按模型返回对应的 API Key（DeepSeek 用 apiKey，智谱 GLM 用 glmApiKey）
function apiKeyForModel(model) {
  return model === 'glm-4-flash' ? config.glmApiKey : config.apiKey;
}

// 每个项目各自的对话历史（内存里，重启会清空）
// 形如 { [项目id]: [{role, content}, ...] }
let projectMessages = {};

let busy = false;              // 是否正在等待回复
let attachments = [];          // 待发送的附件 [{type,name,dataUrl|content}]

// 保存「当前这一次对话」的流式回调
const handlers = { chunk: null, reasoning: null, done: null };

// ---------- 拿到页面元素 ----------
const chatEl = document.getElementById('chat');
let welcomeEl = document.getElementById('welcome');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const attachmentsEl = document.getElementById('attachments');

const modelDropdown = document.getElementById('modelDropdown');
const modelBtn = document.getElementById('modelBtn');
const modelMenu = document.getElementById('modelMenu');
const modelLabel = document.getElementById('modelLabel');

const projectDropdown = document.getElementById('projectDropdown');
const projectBtn = document.getElementById('projectBtn');
const projectMenu = document.getElementById('projectMenu');
const projectList = document.getElementById('projectList');
const projectLabel = document.getElementById('projectLabel');
const newProjectBtn = document.getElementById('newProjectBtn');
const manageProjectBtn = document.getElementById('manageProjectBtn');

const settingsModal = document.getElementById('settingsModal');
const apiKeyInput = document.getElementById('apiKeyInput');
const doubaoApiKeyInput = document.getElementById('doubaoApiKeyInput');
const glmApiKeyInput = document.getElementById('glmApiKeyInput');

const projectModal = document.getElementById('projectModal');
const projectNameInput = document.getElementById('projectNameInput');
const systemPromptInput = document.getElementById('systemPromptInput');
const kbList = document.getElementById('kbList');
const addKbBtn = document.getElementById('addKbBtn');
const deleteProjectBtn = document.getElementById('deleteProjectBtn');

// ============================================================
//  工具函数
// ============================================================

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// 当前选中的项目对象（找不到就退回第一个）
function currentProject() {
  return config.projects.find((p) => p.id === config.currentProjectId) || config.projects[0];
}

// 当前项目的对话历史数组（不存在就新建）
function currentMessages() {
  if (!projectMessages[config.currentProjectId]) {
    projectMessages[config.currentProjectId] = [];
  }
  return projectMessages[config.currentProjectId];
}

// 把消息的 content（可能是字符串，也可能是数组）转成纯文字，用于显示
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

// 清空聊天区，并重新放回「欢迎语」
function resetChat() {
  chatEl.innerHTML = '';
  const w = document.createElement('div');
  w.className = 'welcome';
  w.id = 'welcome';
  w.innerHTML =
    '<div class="welcome-logo"><span class="brand-dot big"></span></div>' +
    '<h2>你好，我是 Desktop Chat</h2>' +
    '<p>开始对话吧，输入内容后按 Enter 发送</p>';
  chatEl.appendChild(w);
  welcomeEl = w;
}

// 按历史记录重新渲染聊天区（切换项目时用）
function renderHistory(messages) {
  resetChat();
  if (!messages || messages.length === 0) return;
  welcomeEl.style.display = 'none';
  for (const m of messages) {
    if (m.role === 'assistant') {
      addMessage('assistant', typeof m.content === 'string' ? m.content : contentToText(m.content));
    } else {
      addMessage('user', contentToText(m.content));
    }
  }
  scrollToBottom();
}

// ============================================================
//  消息渲染
// ============================================================

// 显示一条「纯文字」消息
function addMessage(role, text) {
  welcomeEl.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'message ' + role;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '我' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

// 显示用户消息（可带附件：图片缩略图 / 文件标签）
function addUserMessage(text, atts) {
  welcomeEl.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'message user';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = '我';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.whiteSpace = 'pre-wrap';
    bubble.appendChild(t);
  }
  for (const a of atts || []) {
    if (a.type === 'image') {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.className = 'attach-thumb';
      bubble.appendChild(img);
    } else {
      const chip = document.createElement('div');
      chip.className = 'attach-file-chip';
      chip.textContent = '📄 ' + a.name;
      bubble.appendChild(chip);
    }
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

// 为 AI 回复建一个「空壳」
function createAssistantBlock() {
  welcomeEl.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'AI';

  const body = document.createElement('div');
  body.style.flex = '1';
  body.style.minWidth = '0';

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  chatEl.appendChild(wrap);
  scrollToBottom();

  return { wrap, body };
}

// 在 AI 回复里创建「思考过程」折叠框（放在回答上方，默认折叠）
function createReasoningBox(body) {
  const box = document.createElement('div');
  box.className = 'reasoning-box';
  box.hidden = true; // 没有思考内容时先隐藏

  const header = document.createElement('button');
  header.className = 'reasoning-header';
  const title = document.createElement('span');
  title.textContent = '💭 思考过程';
  const arrow = document.createElement('span');
  arrow.className = 'chevron';
  arrow.textContent = '▾';
  header.appendChild(title);
  header.appendChild(arrow);

  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.hidden = true; // 默认折叠

  header.addEventListener('click', () => {
    content.hidden = !content.hidden;
    box.classList.toggle('open', !content.hidden);
  });

  box.appendChild(header);
  box.appendChild(content);
  body.appendChild(box); // 先加进 body，位置在回答气泡之前（上方）

  return {
    box,
    content,
    // 有思考内容时，把折叠框显示出来
    show() {
      box.hidden = false;
    },
    append(text) {
      content.textContent += text;
    }
  };
}

// ============================================================
//  模型选择下拉
// ============================================================

function renderModelMenu() {
  modelMenu.querySelectorAll('.dropdown-item').forEach((item) => {
    item.classList.toggle('selected', item.dataset.model === config.model);
  });
  modelLabel.textContent = MODELS[config.model] ? MODELS[config.model].label : config.model;
}

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  modelDropdown.classList.toggle('open');
});

modelMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.dropdown-item');
  if (!item) return;
  config.model = item.dataset.model;
  window.api.saveConfig(config);
  renderModelMenu();
  modelDropdown.classList.remove('open');
});

// ============================================================
//  项目：下拉选择 + 切换 + 新建 + 管理
// ============================================================

function renderProjectUI() {
  const p = currentProject();
  projectLabel.textContent = p.name;

  // 重新生成下拉里的项目列表
  projectList.innerHTML = '';
  config.projects.forEach((proj) => {
    const item = document.createElement('button');
    item.className = 'dropdown-item' + (proj.id === config.currentProjectId ? ' selected' : '');
    const title = document.createElement('span');
    title.className = 'item-title';
    title.textContent = proj.name;
    item.appendChild(title);
    item.addEventListener('click', () => switchProject(proj.id));
    projectList.appendChild(item);
  });
}

function switchProject(id) {
  config.currentProjectId = id;
  window.api.saveConfig(config);
  renderProjectUI();
  renderHistory(currentMessages());
  projectDropdown.classList.remove('open');
}

projectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  renderProjectUI(); // 每次展开前刷新列表
  projectDropdown.classList.toggle('open');
});

newProjectBtn.addEventListener('click', () => {
  const id = 'p' + Date.now();
  config.projects.push({ id, name: '新项目', systemPrompt: '', knowledge: [] });
  config.currentProjectId = id;
  window.api.saveConfig(config);
  renderProjectUI();
  renderHistory([]);
  projectDropdown.classList.remove('open');
  openProjectModal();   // 新建后直接打开项目设置
});

manageProjectBtn.addEventListener('click', () => {
  projectDropdown.classList.remove('open');
  openProjectModal();
});

// 点击页面其它地方收起两个下拉
document.addEventListener('click', () => {
  modelDropdown.classList.remove('open');
  projectDropdown.classList.remove('open');
});

// ============================================================
//  设置弹窗（API Key）
// ============================================================

function openSettings() {
  apiKeyInput.value = config.apiKey;
  doubaoApiKeyInput.value = config.doubaoApiKey || '';
  glmApiKeyInput.value = config.glmApiKey || '';
  settingsModal.hidden = false;
  apiKeyInput.focus();
}

function closeSettings() {
  settingsModal.hidden = true;
}

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
document.getElementById('cancelBtn').addEventListener('click', closeSettings);

document.getElementById('keyLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.open('https://platform.deepseek.com', '_blank');
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  config.apiKey = apiKeyInput.value.trim();
  config.doubaoApiKey = doubaoApiKeyInput.value.trim();
  config.glmApiKey = glmApiKeyInput.value.trim();
  await window.api.saveConfig(config);
  closeSettings();
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

// ============================================================
//  项目管理弹窗
// ============================================================

function openProjectModal() {
  const p = currentProject();
  projectNameInput.value = p.name;
  systemPromptInput.value = p.systemPrompt;
  renderKbList();
  projectModal.hidden = false;
}

function closeProjectModal() {
  projectModal.hidden = true;
}

// 刷新知识库文件列表
function renderKbList() {
  const kb = currentProject().knowledge || [];
  kbList.innerHTML = '';
  kbList.style.display = kb.length ? 'block' : 'none';
  kb.forEach((k, i) => {
    const item = document.createElement('div');
    item.className = 'kb-item';

    const name = document.createElement('span');
    name.className = 'kb-name';
    name.textContent = '📄 ' + k.name;

    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '×';
    del.addEventListener('click', () => {
      currentProject().knowledge.splice(i, 1);
      renderKbList();
    });

    item.appendChild(name);
    item.appendChild(del);
    kbList.appendChild(item);
  });
}

// 添加知识库文件（只收文本文件）
async function addKbFile() {
  const file = await window.api.pickFile();
  if (!file) return;
  if (file.type !== 'text') {
    alert('知识库目前只支持文本文件（txt / md / csv 等）');
    return;
  }
  currentProject().knowledge = currentProject().knowledge || [];
  currentProject().knowledge.push({ name: file.name, content: file.content });
  window.api.saveConfig(config); // 立即保存，关掉弹窗也不会丢
  renderKbList();
}

function saveProject() {
  const p = currentProject();
  p.name = projectNameInput.value.trim() || '未命名项目';
  p.systemPrompt = systemPromptInput.value;
  window.api.saveConfig(config);
  renderProjectUI();
  closeProjectModal();
}

function deleteCurrentProject() {
  if (config.projects.length <= 1) {
    alert('至少保留一个项目');
    return;
  }
  const idx = config.projects.findIndex((p) => p.id === config.currentProjectId);
  const removedId = config.projects[idx].id;
  config.projects.splice(idx, 1);
  delete projectMessages[removedId];
  config.currentProjectId = config.projects[0].id;
  window.api.saveConfig(config);
  renderProjectUI();
  renderHistory(currentMessages());
  closeProjectModal();
}

document.getElementById('closeProjectBtn').addEventListener('click', closeProjectModal);
document.getElementById('cancelProjectBtn').addEventListener('click', closeProjectModal);
addKbBtn.addEventListener('click', addKbFile);
document.getElementById('saveProjectBtn').addEventListener('click', saveProject);
deleteProjectBtn.addEventListener('click', deleteCurrentProject);

projectModal.addEventListener('click', (e) => {
  if (e.target === projectModal) closeProjectModal();
});

// ============================================================
//  附件
// ============================================================

async function addAttachment() {
  try {
    const file = await window.api.pickFile();
    if (!file) return;
    attachments.push(file);
    renderAttachments();
  } catch (err) {
    alert('无法读取该文件：' + err.message);
  }
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  attachmentsEl.style.display = attachments.length ? 'flex' : 'none';
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';

    const label = document.createElement('span');
    label.textContent = (a.type === 'image' ? '🖼 ' : '📄 ') + a.name;

    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '×';
    del.addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
    });

    chip.appendChild(label);
    chip.appendChild(del);
    attachmentsEl.appendChild(chip);
  });
}

attachBtn.addEventListener('click', addAttachment);

// —— 支持复制粘贴上传（截图 Ctrl+V、复制图片等） ——
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;

  // 只挑出「文件 / 图片」类型的剪贴板内容
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return; // 纯文字粘贴，走默认行为

  e.preventDefault(); // 有图片/文件，由我们接管

  Promise.all(files.map(readPastedFile)).then((results) => {
    const valid = results.filter(Boolean);
    if (valid.length) {
      attachments.push(...valid);
      renderAttachments();
    }
  });
});

// 判断文件名是否属于「纯文本」类型（粘贴文件时用来过滤）
function isTextFileName(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true; // 没有扩展名，当文本处理
  const ext = name.slice(dot).toLowerCase();
  return ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.py', '.log', '.html', '.css', '.xml', '.yaml', '.yml'].includes(ext);
}

// 把「粘贴来的文件」读成附件格式（图片→base64，文本→文字）
function readPastedFile(file) {
  return new Promise((resolve) => {
    const isImage = file.type && file.type.startsWith('image/');
    const name = file.name || (isImage ? '粘贴图片.png' : '粘贴文件.txt');

    if (isImage) {
      const reader = new FileReader();
      reader.onload = () => resolve({ type: 'image', name, dataUrl: reader.result });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } else if (isTextFileName(name)) {
      const reader = new FileReader();
      reader.onload = () => resolve({ type: 'text', name, content: reader.result });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    } else {
      resolve(null); // 不支持的粘贴类型，跳过
    }
  });
}

// 把「文字 + 附件」组合成要发给接口的消息内容
function buildUserContent(text, atts) {
  if (!atts || atts.length === 0) return text;

  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const a of atts) {
    if (a.type === 'image') {
      // 图片用 OpenAI 视觉格式
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    } else {
      parts.push({ type: 'text', text: `【文件：${a.name}】\n${a.content}` });
    }
  }
  return parts;
}

// 拼出「前置提示 + 知识库」的 system 消息（为空则返回空字符串）
function buildSystemMessage() {
  const p = currentProject();
  let sys = p.systemPrompt ? p.systemPrompt : '';

  const kb = p.knowledge || [];
  if (kb.length) {
    const kbText = kb.map((k) => `【${k.name}】\n${k.content}`).join('\n\n');
    sys += (sys ? '\n\n' : '') + '以下是知识库内容，回答时请优先参考：\n' + kbText;
  }
  return sys;
}

// ============================================================
//  流式监听（只注册一次）
// ============================================================
window.api.onChunk((chunk) => handlers.chunk && handlers.chunk(chunk));
window.api.onReasoning((chunk) => handlers.reasoning && handlers.reasoning(chunk));
window.api.onDone(() => handlers.done && handlers.done());

// 悬浮窗里改了模型 / 新增了语音问答，主界面同步刷新
window.api.onModelChanged((model) => {
  config.model = model;
  renderModelMenu();
});
window.api.onHistoryUpdated((history) => {
  projectMessages = history || {};
  renderHistory(currentMessages());
});

// ============================================================
//  发送消息
// ============================================================
async function send() {
  const text = inputEl.value.trim();
  if ((!text && attachments.length === 0) || busy) return;

  const apiKey = apiKeyForModel(config.model);
  if (!apiKey) {
    const label = config.model === 'glm-4-flash' ? '智谱 GLM' : 'DeepSeek';
    addMessage('assistant', '请先点击右上角设置按钮，填写你的 ' + label + ' API Key。');
    openSettings();
    return;
  }

  // 取出当前附件，然后清空
  const atts = attachments.slice();
  attachments = [];
  renderAttachments();
  inputEl.value = '';
  autoResize();

  // 组装这条用户消息，记进当前项目的历史，并显示出来
  const content = buildUserContent(text, atts);
  currentMessages().push({ role: 'user', content });
  window.api.saveHistory(projectMessages);
  addUserMessage(text, atts);

  busy = true;
  sendBtn.disabled = true;

  // 建 AI 回复空壳：先放折叠的思考框，再放回答气泡
  const { body } = createAssistantBlock();
  const reasoningBox = createReasoningBox(body);
  const bubble = document.createElement('div');
  bubble.className = 'bubble cursor';
  body.appendChild(bubble);

  let full = '';
  let hasReasoning = false;

  handlers.chunk = (chunk) => {
    bubble.classList.remove('cursor');
    full += chunk;
    bubble.textContent = full;
    scrollToBottom();
  };

  handlers.reasoning = (chunk) => {
    hasReasoning = true;
    reasoningBox.show();
    reasoningBox.append(chunk);
    scrollToBottom();
  };

  handlers.done = () => {
    bubble.classList.remove('cursor');
    if (!full && !hasReasoning) bubble.textContent = '（无回复内容）';
    currentMessages().push({ role: 'assistant', content: full });
    window.api.saveHistory(projectMessages);
    busy = false;
    sendBtn.disabled = false;
    scrollToBottom();
  };

  // 组装发给接口的消息：上下文（时间/位置）+ system（前置提示+知识库）+ 历史 + 新用户消息
  const apiMessages = [];
  const context = await window.api.getContext();
  const sys = buildSystemMessage();
  const fullSys = context ? (context + (sys ? '\n\n' + sys : '')) : sys;
  if (fullSys) apiMessages.push({ role: 'system', content: fullSys });
  apiMessages.push(...currentMessages());

  try {
    await window.api.chat({ apiKey, model: config.model, messages: apiMessages });
  } catch (err) {
    bubble.classList.remove('cursor');
    bubble.textContent = '出错：' + err.message;
    busy = false;
    sendBtn.disabled = false;
    scrollToBottom();
  }
}

// ============================================================
//  输入框：自动长高 + 快捷键
// ============================================================

function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
}

inputEl.addEventListener('input', autoResize);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sendBtn.addEventListener('click', send);

// ============================================================
//  启动时初始化
// ============================================================
(async function init() {
  config = await window.api.getConfig();
  projectMessages = (await window.api.loadHistory()) || {};
  apiKeyInput.value = config.apiKey;
  renderModelMenu();
  renderProjectUI();
  renderHistory(currentMessages());
})();

// ============================================================
//  本地快捷键兜底（Ctrl+Alt 录音）
// ------------------------------------------------------------
//  uiohook 全局钩子在「窗口有焦点 + 麦克风已激活」时会漏发 keyup，
//  导致松开 Ctrl+Alt 收不到停止信号。所以窗口有焦点时，用本地监听兜底，
//  通过 localRecordStart/Stop 转发给悬浮窗（重复触发无副作用）。
// ============================================================
(() => {
  let ctrl = false, alt = false, recording = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control') ctrl = true;
    if (e.key === 'Alt') alt = true;
    if (ctrl && alt && !recording) {
      recording = true;
      window.api.localRecordStart();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') ctrl = false;
    if (e.key === 'Alt') alt = false;
    if (recording && (!ctrl || !alt)) {
      recording = false;
      window.api.localRecordStop();
    }
  });
})();
