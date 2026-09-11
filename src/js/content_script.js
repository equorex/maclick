const OVERLAY_ID = 'maclick-recording-overlay';
const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number'];
const OVERLAY_CSS = `
  .panel {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #1a202c;
    color: #ffffff;
    border-radius: 999px;
    font: 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #e53e3e;
    animation: maclick-pulse 1s infinite;
  }
  @keyframes maclick-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .hint { opacity: 0.7; }
  .stop {
    padding: 4px 10px;
    border: none;
    border-radius: 999px;
    background: #e53e3e;
    color: #ffffff;
    font-size: 12px;
    cursor: pointer;
  }
  .stop:hover { background: #c53030; }
`;

let isRecording = false;
let overlayHost = null;

function getSelector(element) {
  if (!element || element.tagName === 'HTML' || element.tagName === 'BODY') return null;

  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let part = current.tagName.toLowerCase();

    if (current.id) {
      part += '#' + CSS.escape(current.id);
      parts.unshift(part);
      break;
    }

    const classes = Array.from(current.classList).slice(0, 2);
    for (const cls of classes) {
      part += '.' + CSS.escape(cls);
    }

    const siblings = current.parentNode ? Array.from(current.parentNode.children) : [];
    if (siblings.length > 1) {
      part += ':nth-child(' + (siblings.indexOf(current) + 1) + ')';
    }

    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function isTextInput(element) {
  if (!element) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;

  return TEXT_INPUT_TYPES.includes((element.type || 'text').toLowerCase());
}

function sendMessage(message) {
  browser.runtime.sendMessage(message).catch(e => {
    console.error('Failed to send message:', message.type, e);
  });
}

function stopRecordingFromPage() {
  if (!isRecording) return;

  isRecording = false;
  hideOverlay();
  sendMessage({ type: 'RECORDING_STOPPED' });
}

function showOverlay() {
  if (overlayHost && document.documentElement.contains(overlayHost)) return;

  overlayHost = document.createElement('div');
  overlayHost.id = OVERLAY_ID;
  overlayHost.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;';

  const shadow = overlayHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;

  const panel = document.createElement('div');
  panel.className = 'panel';

  const dot = document.createElement('span');
  dot.className = 'dot';

  const text = document.createElement('span');
  text.textContent = 'Recording actions';

  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Esc to stop';

  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.className = 'stop';
  stopButton.textContent = '⏹ Stop';
  stopButton.addEventListener('click', stopRecordingFromPage);

  panel.appendChild(dot);
  panel.appendChild(text);
  panel.appendChild(hint);
  panel.appendChild(stopButton);
  shadow.appendChild(style);
  shadow.appendChild(panel);

  document.documentElement.appendChild(overlayHost);
}

function hideOverlay() {
  if (!overlayHost) return;

  if (overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
  overlayHost = null;
}

function isOverlayEvent(e) {
  if (!overlayHost) return false;
  if (e.target === overlayHost) return true;
  return typeof e.composedPath === 'function' && e.composedPath().includes(overlayHost);
}

document.addEventListener('click', function(e) {
  if (!isRecording || isOverlayEvent(e)) return;

  sendMessage({
    type: 'RECORDED_STEP',
    step: { type: 'click', selector: getSelector(e.target) }
  });
}, true);

document.addEventListener('change', function(e) {
  if (!isRecording || isOverlayEvent(e)) return;

  const target = e.target;
  if (!isTextInput(target)) return;

  sendMessage({
    type: 'RECORDED_STEP',
    step: { type: 'input_text', selector: getSelector(target), value: target.value }
  });
}, true);

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape' || !isRecording) return;

  e.preventDefault();
  stopRecordingFromPage();
}, true);

browser.runtime.onMessage.addListener(async function(message) {
  if (message.type === 'START_RECORDING') {
    isRecording = true;
    showOverlay();
    return { status: 'started' };
  }

  if (message.type === 'STOP_RECORDING') {
    isRecording = false;
    hideOverlay();
    return { status: 'stopped' };
  }

  return undefined;
});

async function restoreRecordingState() {
  try {
    const state = await browser.runtime.sendMessage({ type: 'GET_RECORDING_STATE' });
    if (state && state.recording) {
      isRecording = true;
      showOverlay();
    }
  } catch (e) {
    console.warn('Failed to restore recording state:', e);
  }
}

restoreRecordingState();
