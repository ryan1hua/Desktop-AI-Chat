// ============================================================
//  floating.js —— 悬浮窗逻辑
// ------------------------------------------------------------
//  点麦克风 / 全局快捷键 → 录音 → 豆包 ASR 转文字 → 发给 AI
//  → 悬浮窗左侧弹两个消息框（识别文字 + AI 回复），渐隐渐出。
//  麦克风按钮可拖动（拖动窗口）、点一下录音。
// ============================================================

let recorder = null;
let micStream = null;
let isRecording = false;
let isBusy = false;
let starting = false;    // 正在等待麦克风授权（startRecording 还没走完）
let pendingStop = false; // 授权期间用户就松开了，标记「开始完立即停止」
let pendingAttachment = null; // 待发送附件（右键「输入文件 / 输入粘贴栏」设置，发一次就清空）
let menuOpen = false;         // 右键气泡菜单是否打开
let collapsed = false;        // 悬浮窗是否已收成小点（空闲自动收起）
const IDLE_MS = 20 * 1000; // 空闲 20 秒后自动收起
let idleTimer = null;         // 空闲计时器
let panelOpen = false;        // 输入面板是否打开

const micBtn = document.getElementById('micBtn');
const userBox = document.getElementById('userBox');
const aiBox = document.getElementById('aiBox');
const userText = document.getElementById('userText');
const aiText = document.getElementById('aiText');
const attachChip = document.getElementById('attachChip');
const bubbleMenu = document.getElementById('bubbleMenu');
const modelMenu = document.getElementById('modelMenu');
const inputPanel = document.getElementById('inputPanel');
const floatInput = document.getElementById('floatInput');
const recordBtn = document.getElementById('recordBtn');

const HIDE_MS = 5000;   // 5 秒后自动消失
const FADE_MS = 300;    // 渐隐/渐出动画时长
const hideTimers = {};  // 每个消息框的消失定时器

// —— 录音 blob 转 16kHz 单声道 Float32Array ——
async function blobTo16kFloat32(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  const offline = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  await ctx.close();
  return rendered.getChannelData(0);
}

// —— Float32Array → WAV ——
function float32ToWav(float32, sampleRate = 16000) {
  const numSamples = float32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

// —— 开始录音 ——
async function startRecording() {
  if (isRecording || isBusy || starting) return;
  if (collapsed) expandFloat();  // 全局快捷键在收起态触发时，先展开再录
  // 进入录音模式：输入框消失，录音按钮显示并变红
  floatInput.style.display = 'none';
  inputPanel.hidden = false;
  recordBtn.hidden = false;
  recordBtn.classList.add('recording');
  inputPanel.classList.remove('pop', 'fade-out');
  void inputPanel.offsetWidth;
  inputPanel.classList.add('pop');
  panelOpen = false;
  window.api.setIgnoreMouse(false);
  starting = true;
  pendingStop = false;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    starting = false;
    recordBtn.classList.remove('recording');
    recordBtn.hidden = true;
    inputPanel.hidden = true;
    showMsg(userBox, userText, '无法使用麦克风：' + err.message);
    return;
  }
  starting = false;

  // 等待麦克风授权期间用户已经松开（快速点按），立即停止，避免一直录着
  if (pendingStop) {
    pendingStop = false;
    micStream.getTracks().forEach((t) => t.stop());
    recordBtn.classList.remove('recording');
    recordBtn.hidden = true;
    inputPanel.hidden = true;
    return;
  }

  const chunks = [];
  recorder = new MediaRecorder(micStream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    isBusy = true;
    // 录音结束：录音按钮消失
    recordBtn.classList.remove('recording');
    recordBtn.hidden = true;
    inputPanel.hidden = true;
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const float32 = await blobTo16kFloat32(blob);
      const wav = float32ToWav(float32);

      const text = await window.api.transcribe(wav);
      if (text && text.trim()) {
        // 取走待发送附件（发一次就清空）
        const att = pendingAttachment;
        pendingAttachment = null;
        updateAttachChip();

        showMsg(userBox, userText, att ? `📎 ${att.name}\n${text.trim()}` : text.trim());
        const reply = await window.api.quickChat(text.trim(), att);
        showMsg(aiBox, aiText, reply || '（无回复）');
      } else {
        showMsg(userBox, userText, '没听清，请再试一次');
      }
    } catch (err) {
      showMsg(userBox, userText, '出错：' + err.message);
    } finally {
      isBusy = false;
    }
  };

  recorder.start();
  isRecording = true;
}

// —— 停止录音（触发识别） ——
function stopRecording() {
  // 麦克风授权还没完成就收到停止：先记下来，等开始完成立即停
  if (starting) {
    pendingStop = true;
    return;
  }
  if (!isRecording) return;
  recorder.stop();
  micStream.getTracks().forEach((t) => t.stop());
  isRecording = false;
}

// 录音按钮：开始 / 结束录音
function toggleRecording() {
  if (collapsed) { expandFloat(); return; }
  if (isRecording) stopRecording();
  else startRecording();
}

// 悬浮窗麦克风按钮：切换输入面板
function togglePanel() {
  if (collapsed) { expandFloat(); return; }
  if (isRecording) { stopRecording(); return; }
  if (panelOpen) closePanel();
  else openPanel();
}

function openPanel() {
  if (panelOpen) return;
  panelOpen = true;
  closeAllMenus();
  hideMsg(userBox);   // 输入框出现时，隐藏消息框（两者不共存）
  hideMsg(aiBox);
  inputPanel.hidden = false;
  floatInput.style.display = '';
  recordBtn.hidden = false;
  recordBtn.classList.remove('recording');
  floatInput.value = '';
  inputPanel.classList.remove('pop', 'fade-out');
  void inputPanel.offsetWidth;
  inputPanel.classList.add('pop');
  window.api.setIgnoreMouse(false);
  floatInput.focus();
  resetIdleTimer();
}

function closePanel() {
  if (!panelOpen && inputPanel.hidden) return;
  panelOpen = false;
  inputPanel.classList.remove('pop');   // 先移除入场动画，让渐隐能生效
  inputPanel.classList.add('fade-out');
  setTimeout(() => {
    inputPanel.hidden = true;
    inputPanel.classList.remove('fade-out');
    floatInput.style.display = '';
    window.api.setIgnoreMouse(true);
  }, 300);
}

// 输入框回车发送
async function sendFloatText() {
  const text = floatInput.value.trim();
  if (!text || isBusy) return;
  const att = pendingAttachment;
  pendingAttachment = null;
  updateAttachChip();
  closePanel();
  showMsg(userBox, userText, att ? `📎 ${att.name}\n${text}` : text);
  try {
    const reply = await window.api.quickChat(text, att);
    showMsg(aiBox, aiText, reply || '（无回复）');
  } catch (err) {
    showMsg(userBox, userText, '出错：' + err.message);
  }
}

// —— 空闲自动收起 / 展开 ——
function resetIdleTimer() {
  clearTimeout(idleTimer);
  if (collapsed) return;   // 收起态不用计时
  idleTimer = setTimeout(collapseFloat, IDLE_MS);
}

async function collapseFloat() {
  // 录音中 / 处理中 / 菜单开着时不收
  if (collapsed || isRecording || isBusy || starting || menuOpen) return;
  closeAllMenus();
  collapsed = true;
  document.body.classList.add('collapsed');
  await window.api.floatCollapse();
}

async function expandFloat() {
  if (!collapsed) return;
  collapsed = false;
  document.body.classList.remove('collapsed');
  await window.api.floatExpand();
  resetIdleTimer();
}

// —— 显示消息框（渐入 + 5 秒后渐出） ——
function showMsg(box, textEl, text) {
  textEl.textContent = text;
  box.hidden = false;
  box.classList.remove('show'); // 先回到「未显示」状态
  void box.offsetWidth;         // 强制浏览器先渲染一帧「透明」状态
  box.classList.add('show');    // 再触发渐入动画
  startHideTimer(box);
}

// —— 立即隐藏消息框（输入框出现时，两者不共存） ——
function hideMsg(box) {
  clearTimeout(hideTimers[box.id]);
  box._timerState = 'idle';
  box.classList.remove('show');
  box.hidden = true;
}

// 更新「待发送附件」小提示
function updateAttachChip() {
  if (pendingAttachment) {
    attachChip.textContent = '📎 ' + (pendingAttachment.name || '附件');
    attachChip.hidden = false;
  } else {
    attachChip.hidden = true;
    attachChip.textContent = '';
  }
}

function startHideTimer(box) {
  clearTimeout(hideTimers[box.id]);
  box._timerState = 'running';
  hideTimers[box.id] = setTimeout(() => {
    box._timerState = 'idle';
    box.classList.remove('show');
    setTimeout(() => { box.hidden = true; }, FADE_MS);
  }, HIDE_MS);
}

// —— 判断坐标是否在元素上 ——
function isOver(el, x, y) {
  if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// —— 统一鼠标处理：穿透切换 + 消息框悬停保持 ——
function updateMouse(x, y) {
  const overMic = isOver(micBtn, x, y);
  const overUser = isOver(userBox, x, y);
  const overAi = isOver(aiBox, x, y);
  const panelActive = !inputPanel.hidden;  // 输入面板/录音时整窗接收鼠标

  // 悬停到按钮/消息框时接收鼠标，否则穿透（点得到下面的软件）。
  // 气泡菜单打开或输入面板显示时，整个窗口都接收鼠标。
  window.api.setIgnoreMouse(!(overMic || overUser || overAi || panelActive || menuOpen));

  [userBox, aiBox].forEach((box) => {
    if (box.hidden) return;
    if (isOver(box, x, y)) {
      if (box._timerState !== 'hovering') {
        box._timerState = 'hovering';
        clearTimeout(hideTimers[box.id]); // 悬停保持
      }
    } else if (box._timerState !== 'running') {
      startHideTimer(box); // 移出重新计时
    }
  });
}

// —— 拖动：主进程用屏幕坐标移动窗口（避免 DPI 缩放导致的偏移） ——
let dragging = false;

micBtn.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  dragging = true;
  window.api.setIgnoreMouse(false); // 拖动期间整个窗口接收鼠标
  await window.api.startFloatDrag();
});

document.addEventListener('mousemove', (e) => {
  if (dragging) return; // 主进程负责移动窗口
  updateMouse(e.clientX, e.clientY);
  resetIdleTimer();
});

document.addEventListener('mouseup', async () => {
  if (!dragging) return;
  dragging = false;
  const moved = await window.api.stopFloatDrag();
  if (!moved) togglePanel(); // 没拖动，当作点击
  window.api.setIgnoreMouse(true);
});

// —— 全局快捷键（按住 Ctrl+Alt 录音，松开停止） ——
window.api.onRecordStart(() => startRecording());
window.api.onRecordStop(() => stopRecording());

// —— 输入面板：录音按钮 + 输入框回车 ——
recordBtn.addEventListener('click', () => {
  toggleRecording();
  resetIdleTimer();
});

floatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFloatText();
  }
});

// —— 预热麦克风：启动时先开一次再关 ——
// 第一次调用 getUserMedia 会初始化声卡/授权，较慢，可能导致「按第一次没录上」。
// 这里先悄悄开一次再关，之后按住快捷键就能立刻开始录音。
async function warmupMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    // 预热失败没关系，真正录音时会再尝试
  }
}
warmupMic();

// 启动后开始空闲计时（20 秒无操作自动滑到屏幕边缘）
resetIdleTimer();

// —— 本地快捷键兜底（同主窗口 renderer.js） ——
// 悬浮窗被点击后会获得焦点，此时同样用本地监听兜底，避免 uiohook 漏发 keyup。
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

// —— 右键菜单 ——
// 右键消息框 → 复制该消息框文字（系统原生菜单）
userBox.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showMsgMenu(userText.textContent);
});
aiBox.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showMsgMenu(aiText.textContent);
});
// 右键麦克风按钮 → 弹出毛玻璃气泡菜单
micBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMenu(bubbleMenu);
});

// —— 气泡菜单：右半圆定位（圆形气泡、大小不等）+ 出水式弹出 ——
function layoutBubbles(wrap) {
  const bubbles = Array.from(wrap.querySelectorAll('.bubble'));
  const W = window.innerWidth;
  const H = window.innerHeight;
  const n = bubbles.length;

  // 右半圆：以「麦克风按钮」为圆心，气泡沿右半圆（正上→正下，经过正右）分布
  // 角度约定：0°=正右，+角度=上方，-角度=下方
  const mr = micBtn.getBoundingClientRect();
  const cx = mr.left + mr.width / 2;
  const cy = mr.top + mr.height / 2;
  const R = 90;
  const startDeg = 90;    // 最上面（第 0 个气泡）
  const endDeg = -90;     // 最下面（最后一个气泡）

  bubbles.forEach((b, i) => {
    // 圆形气泡，直径从 data-size 读，实现大小不等
    const size = parseInt(b.dataset.size, 10) || 80;
    b.style.width = size + 'px';
    b.style.height = size + 'px';

    const deg = n === 1 ? 0 : startDeg + (endDeg - startDeg) * (i / (n - 1));
    const rad = deg * Math.PI / 180;
    let x = cx + R * Math.cos(rad) - size / 2;
    let y = cy - R * Math.sin(rad) - size / 2;
    // 夹在窗口内，避免跑出边界
    x = Math.max(4, Math.min(W - size - 4, x));
    y = Math.max(4, Math.min(H - size - 4, y));
    b.style.left = Math.round(x) + 'px';
    b.style.top = Math.round(y) + 'px';
  });
}

function openMenu(wrap) {
  closeAllMenus();
  menuOpen = true;
  wrap.hidden = false;        // 先显示（仍是透明），这样能量出气泡宽高来定位
  layoutBubbles(wrap);
  Array.from(wrap.querySelectorAll('.bubble')).forEach((b, i) => {
    b.classList.remove('pop');
    void b.offsetWidth;       // 强制重排，确保动画重新播放
    b.style.animationDelay = (i * 70) + 'ms'; // 依次错开弹出
    b.classList.add('pop');
  });
  window.api.setIgnoreMouse(false); // 菜单打开时接收鼠标
}

function closeAllMenus() {
  menuOpen = false;
  bubbleMenu.hidden = true;
  modelMenu.hidden = true;
  window.api.setIgnoreMouse(true);
}

// 点空白处 / 按 Esc 关闭菜单
document.addEventListener('click', (e) => {
  resetIdleTimer();
  if (!menuOpen || e.target.closest('.bubble')) return;
  closeAllMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuOpen) closeAllMenus();
});

// —— 气泡点击 ——
bubbleMenu.addEventListener('click', (e) => {
  const b = e.target.closest('.bubble');
  if (!b) return;
  const action = b.dataset.action;
  if (action === 'model') {
    openMenu(modelMenu);       // 展开模型子菜单
  } else if (action === 'main') {
    closeAllMenus();
    window.api.showMain();     // 显示主界面
  } else if (action === 'file') {
    closeAllMenus();
    pickFloatFile();
  } else if (action === 'clipboard') {
    closeAllMenus();
    readFloatClipboard();
  } else if (action === 'quit') {
    window.api.quitApp();
  }
});

modelMenu.addEventListener('click', (e) => {
  const b = e.target.closest('.bubble');
  if (!b) return;
  const model = b.dataset.model;
  if (model) {
    window.api.setModel(model);
    closeAllMenus();
  }
});

// —— 输入文件 / 输入粘贴栏（返回的附件存为待发送附件） ——
function applyAttachment(att) {
  if (!att) return;
  pendingAttachment = att;
  updateAttachChip();
  showMsg(userBox, userText, `已附加：${att.name}（下次语音输入时一起发送）`);
}

async function pickFloatFile() {
  try {
    applyAttachment(await window.api.pickFloatFile());
  } catch (err) {
    showMsg(userBox, userText, err.message);
  }
}

async function readFloatClipboard() {
  try {
    applyAttachment(await window.api.readFloatClipboard());
  } catch (err) {
    showMsg(userBox, userText, err.message);
  }
}
