import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'listening-audio-download-test', version: '1.0.0' }, {});
const title = document.querySelector('#title');
const file = document.querySelector('#file');
const button = document.querySelector('#download');
const status = document.querySelector('#status');
const diagnostics = document.querySelector('#diagnostics');
let connected = false, supported = false, pending = false, revision = 0, audio = null;
let state = 'waiting';

function paint(message) {
  button.disabled = !connected || !supported || !audio || pending;
  status.textContent = message;
  diagnostics.textContent = JSON.stringify({ uiVersion: 'download-v1', connected,
    downloadFile: connected ? supported : null, audioState: state, requestPending: pending }, null, 2);
}
function idle() {
  if (!connected) return paint('正在連接 ChatGPT…');
  if (!supported) return paint('此 Client 不支援 MCP App 檔案下載。');
  paint(audio ? '音檔已準備，請點擊下載。' : state === 'waiting' ? '等待題目資料。' : '音檔尚未準備，請先準備音訊再顯示下載卡片。');
}
app.ontoolinput = () => {
  revision++; audio = null; state = 'waiting'; pending = false;
  title.textContent = '聽力音檔下載測試'; file.textContent = '等待題目資料。'; idle();
};
app.ontoolresult = result => {
  revision++; audio = null; pending = false; state = 'invalid';
  const data = result.structuredContent;
  if (result.isError || !data || data.ok !== true ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,80}$/.test(data.setId ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(data.questionId ?? '')) {
    return paint('無法取得題目音檔資料，請重新顯示卡片。');
  }
  title.textContent = `聽力音檔 · ${data.questionId}`;
  file.textContent = data.setId;
  state = data.audio?.state;
  if (state === 'ready') {
    const value = data.audio;
    if (value.resourceUri !== `listening-audio://sets/${data.setId}/${data.questionId}.wav` ||
        value.mimeType !== 'audio/wav' || value.filename !== `${data.questionId}.wav` ||
        !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 12 * 1024 * 1024) {
      state = 'invalid'; return paint('音檔資料不完整，無法下載。');
    }
    audio = value;
    file.textContent = `${data.setId} · ${value.filename} · ${(value.bytes / 1024).toFixed(1)} KB`;
  }
  idle();
};
app.ontoolcancelled = () => { revision++; audio = null; pending = false; state = 'cancelled'; paint('題目讀取已取消。'); };
button.addEventListener('click', async () => {
  if (button.disabled) return;
  const current = revision, selected = audio;
  pending = true; paint('已向 Client 請求下載，請留意確認視窗。');
  try {
    const result = await app.downloadFile({ contents: [{ type: 'resource_link',
      uri: selected.resourceUri, name: selected.filename, mimeType: selected.mimeType }] }, { timeout: 60000 });
    if (current !== revision) return;
    pending = false;
    paint(result.isError ? 'Client 未完成下載，可能已取消、拒絕或無法讀取音檔。' :
      'Client 已接受下載請求。請確認下載檔案是否存在且可播放。');
  } catch {
    if (current !== revision) return;
    pending = false; paint('下載請求失敗或逾時。請確認 Client 支援此資源，再重試。');
  }
});
const connectTimer = setTimeout(() => paint('無法連接 App host。請更新連線後重新顯示卡片。'), 10000);
app.connect().then(() => {
  clearTimeout(connectTimer); connected = true;
  supported = Boolean(app.getHostCapabilities()?.downloadFile); idle();
}).catch(() => { clearTimeout(connectTimer); paint('App host 連線失敗。請重新顯示卡片。'); });
