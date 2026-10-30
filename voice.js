// ============================================================
//  voice.js —— 语音输入（豆包 Seed-ASR）
// ------------------------------------------------------------
//  点麦克风录音 → 转成 WAV → 交给主进程调用豆包 Seed-ASR 接口
//  → 拿回文字填入输入框。
// ============================================================

let recorder = null;     // 录音器
let micStream = null;    // 麦克风流
let isRecording = false;
let isBusy = false;      // 正在识别中

const micBtn = document.getElementById('micBtn');
const inputEl = document.getElementById('input');
const micStateEl = document.getElementById('micState');

// —— 把麦克风错误翻译成通俗提示 ——
function micErrorMessage(err) {
  if (err.name === 'NotAllowedError') {
    return '麦克风权限被拒绝：请在 Windows 设置 → 隐私和安全性 → 麦克风 里，允许本应用使用麦克风';
  }
  if (err.name === 'NotFoundError') {
    return '未找到麦克风设备，请确认麦克风已连接';
  }
  if (err.name === 'NotReadableError') {
    return '麦克风被其它程序占用，请关闭占用麦克风的程序后重试';
  }
  return '无法使用麦克风：' + err.message;
}

// —— 把录音 blob 转成 16kHz 单声道 Float32Array ——
async function blobTo16kFloat32(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  // 用 OfflineAudioContext 重采样到 16000Hz 单声道
  const offline = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  await ctx.close();
  return rendered.getChannelData(0);
}

// —— 把 16kHz 单声道 Float32Array 编码成 WAV（豆包 ASR 用） ——
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
  view.setUint32(16, 16, true); // fmt 块大小
  view.setUint16(20, 1, true);  // PCM 编码
  view.setUint16(22, 1, true);  // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);  // 块对齐
  view.setUint16(34, 16, true); // 16 位采样
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

// —— 开始 / 停止录音 ——
async function toggleRecording() {
  if (isBusy) return;

  if (!isRecording) {
    // 开始录音
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      micStateEl.textContent = micErrorMessage(err);
      return;
    }

    const chunks = [];
    recorder = new MediaRecorder(micStream);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      isBusy = true;
      micStateEl.textContent = '识别中…';
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const float32 = await blobTo16kFloat32(blob);
        const wav = float32ToWav(float32);
        const text = await window.api.transcribe(wav);
        if (text && text.trim()) {
          inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + text.trim();
          inputEl.dispatchEvent(new Event('input')); // 触发输入框自适应高度
          micStateEl.textContent = '';  // 识别成功，清掉「识别中…」提示
        } else {
          micStateEl.textContent = '没听清，请再试一次';
        }
      } catch (err) {
        micStateEl.textContent = '识别失败：' + err.message;
      } finally {
        isBusy = false;
        micBtn.classList.remove('recording');
      }
    };

    recorder.start();
    isRecording = true;
    micBtn.classList.add('recording');
    micStateEl.textContent = '录音中… 再点一下结束';
  } else {
    // 停止录音，触发识别
    recorder.stop();
    micStream.getTracks().forEach((t) => t.stop());
    isRecording = false;
  }
}

micBtn.addEventListener('click', toggleRecording);
