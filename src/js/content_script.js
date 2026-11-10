const PANEL_ID = 'maclick-floating-panel';
const DISMISSED_AT_KEY = 'maclick-launcher-dismissed-at';
const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  play: 'M8 5v14l11-7z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
};
const PANEL_CSS = `
  .panel {
    display: flex;
    align-items: center;
    padding: 3px;
    background: #1a202c;
    color: #ffffff;
    border-radius: 999px;
    font: 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }
  .panel [hidden] { display: none !important; }
  .recording {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 9px;
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
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: #ffffff;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
  }
  .icon-button:hover { background: rgba(255, 255, 255, 0.16); }
  .icon-button:focus-visible { outline: 2px solid #ffffff; outline-offset: 1px; }
  .icon-button:disabled { opacity: 0.5; cursor: default; }
  .icon-button.play { color: #86efac; }
  .icon-button.play:not(:disabled):hover { background: #16a34a; color: #ffffff; }
  .icon-button.close:not(:disabled):hover { background: #e53e3e; color: #ffffff; }
  svg { display: block; }
`;

let isRecording = false;
let panelHost = null;
let recordingSection = null;
let actionsSection = null;
let playButton = null;
let closeButton = null;
let launcherTask = null;
let launcherRequestId = 0;
let isRunningTask = false;
let pendingClickSelector = null;

const POINTER_DOWN_EVENT = typeof PointerEvent === 'undefined' ? 'mousedown' : 'pointerdown';

function positionInNodeList(element, nodeList) {
  for (let i = 0; i < nodeList.length; i++) {
    if (element === nodeList[i]) return i;
  }
  return -1;
}

function getSelectorRoot(element) {
  if (typeof element.getRootNode !== 'function') return document;

  const root = element.getRootNode();
  if (root && (root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE)) {
    return root;
  }
  return document;
}

function getSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;

  const root = getSelectorRoot(element);
  if (!root || typeof root.querySelectorAll !== 'function') return null;

  if (element.id && root.querySelectorAll('#' + CSS.escape(element.id)).length === 1) {
    return '#' + CSS.escape(element.id);
  }

  const tagName = (element.localName || element.tagName || '').toLowerCase();
  if (tagName === 'html' || tagName === 'head' || tagName === 'body') {
    return tagName;
  }

  const classList = element.classList || [];
  for (let i = 0; i < classList.length; i++) {
    let selector = '.' + CSS.escape(classList.item(i));
    if (root.querySelectorAll(selector).length === 1) return selector;

    selector = CSS.escape(tagName) + selector;
    if (root.querySelectorAll(selector).length === 1) return selector;

    if (!element.parentNode || !element.parentNode.children) continue;
    const index = positionInNodeList(element, element.parentNode.children) + 1;
    selector = selector + ':nth-child(' + index + ')';
    if (root.querySelectorAll(selector).length === 1) return selector;
  }

  if (!element.parentNode || !element.parentNode.children) return null;

  const index = positionInNodeList(element, element.parentNode.children) + 1;
  if (index < 1) return null;

  let selector = CSS.escape(tagName) + ':nth-child(' + index + ')';
  if (element.parentNode !== root) {
    const parentSelector = getSelector(element.parentNode);
    if (!parentSelector) return null;
    selector = parentSelector + ' > ' + selector;
  }
  return selector;
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

function createIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}

function createIconButton(iconName, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.appendChild(createIcon(iconName));
  button.addEventListener('click', onClick);
  return button;
}

function createRecordingSection() {
  const section = document.createElement('div');
  section.className = 'recording';

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

  section.appendChild(dot);
  section.appendChild(text);
  section.appendChild(hint);
  section.appendChild(stopButton);
  return section;
}

function createActionsSection() {
  const section = document.createElement('div');
  section.className = 'actions';
  section.hidden = true;

  playButton = createIconButton('play', 'Run last task', runLastTask);
  playButton.classList.add('play');

  closeButton = createIconButton('close', 'Hide panel', dismissPanel);
  closeButton.classList.add('close');

  section.appendChild(playButton);
  section.appendChild(closeButton);
  return section;
}

function ensurePanel() {
  if (panelHost) return true;
  if (!document.documentElement) return false;

  panelHost = document.createElement('div');
  panelHost.id = PANEL_ID;
  panelHost.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;pointer-events:auto;';

  const shadow = panelHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;

  const panel = document.createElement('div');
  panel.className = 'panel';

  recordingSection = createRecordingSection();
  actionsSection = createActionsSection();
  panel.appendChild(recordingSection);
  panel.appendChild(actionsSection);

  shadow.appendChild(style);
  shadow.appendChild(panel);
  document.documentElement.appendChild(panelHost);
  return true;
}

function hidePanel() {
  if (!panelHost) return;

  const host = panelHost;
  panelHost = null;
  recordingSection = null;
  actionsSection = null;
  playButton = null;
  closeButton = null;

  if (host.parentNode) host.parentNode.removeChild(host);
}

function readDismissedAt() {
  try {
    const value = parseInt(sessionStorage.getItem(DISMISSED_AT_KEY), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (e) {
    return null;
  }
}

function isLauncherDismissed(task) {
  if (!task || !Number.isFinite(task.lastUsedAt)) return true;

  const dismissedAt = readDismissedAt();
  return dismissedAt !== null && task.lastUsedAt <= dismissedAt;
}

function renderPanel() {
  const showRecording = isRecording;
  const showActions = !isRecording && !!launcherTask && !isLauncherDismissed(launcherTask);

  if (!showRecording && !showActions) {
    hidePanel();
    return;
  }

  if (!ensurePanel()) return;

  recordingSection.hidden = !showRecording;
  actionsSection.hidden = !showActions;

  if (showActions) {
    const taskName = launcherTask.name || '';
    const label = taskName ? `Run last task: ${taskName}` : 'Run last task';
    playButton.title = label;
    playButton.setAttribute('aria-label', label);
    playButton.disabled = isRunningTask;
    closeButton.title = 'Hide panel';
    closeButton.setAttribute('aria-label', 'Hide panel');
    closeButton.disabled = false;
  }
}

async function refreshLauncherState() {
  const requestId = ++launcherRequestId;
  let state = null;

  try {
    state = await browser.runtime.sendMessage({ type: 'GET_LAUNCHER_STATE' });
  } catch (e) {
    console.warn('Failed to read launcher state:', e);
    return;
  }

  if (requestId !== launcherRequestId) return;

  const task = state && state.task;
  launcherTask = task && typeof task.id === 'string' && task.id.length > 0 && Number.isFinite(task.lastUsedAt)
    ? {
        id: task.id,
        name: typeof task.name === 'string' ? task.name : '',
        lastUsedAt: task.lastUsedAt
      }
    : null;

  renderPanel();
}

async function runLastTask() {
  if (!launcherTask || isRunningTask) return;

  const taskId = launcherTask.id;
  isRunningTask = true;
  renderPanel();

  try {
    const result = await browser.runtime.sendMessage({ type: 'RUN_LAST_TASK', taskId });
    if (!result || result.status !== 'started') {
      console.warn('Failed to run last task:', result && result.error ? result.error : result);
    }
  } catch (e) {
    console.error('Failed to run last task:', e);
  } finally {
    isRunningTask = false;
    await refreshLauncherState();
  }
}

function dismissPanel() {
  try {
    sessionStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
  } catch (e) {
    console.warn('Failed to remember dismissed panel:', e);
  }

  hidePanel();
}

function stopRecordingFromPage() {
  if (!isRecording) return;

  isRecording = false;
  renderPanel();
  sendMessage({ type: 'RECORDING_STOPPED' });
}

function isPanelEvent(e) {
  if (!panelHost) return false;
  if (e.target === panelHost) return true;
  return typeof e.composedPath === 'function' && e.composedPath().includes(panelHost);
}

document.addEventListener(POINTER_DOWN_EVENT, function(e) {
  if (!isRecording || isPanelEvent(e)) return;

  pendingClickSelector = getSelector(e.target);
}, true);

document.addEventListener('pointercancel', function() {
  pendingClickSelector = null;
}, true);

document.addEventListener('click', function(e) {
  if (!isRecording || isPanelEvent(e)) return;

  const selector = pendingClickSelector || getSelector(e.target);
  pendingClickSelector = null;

  sendMessage({
    type: 'RECORDED_STEP',
    step: { type: 'click', selector }
  });
}, true);

document.addEventListener('change', function(e) {
  if (!isRecording || isPanelEvent(e)) return;

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
    renderPanel();
    return { status: 'started' };
  }

  if (message.type === 'STOP_RECORDING') {
    isRecording = false;
    renderPanel();
    return { status: 'stopped' };
  }

  return undefined;
});

async function restoreRecordingState() {
  try {
    const state = await browser.runtime.sendMessage({ type: 'GET_RECORDING_STATE' });
    if (state && state.recording) {
      isRecording = true;
      renderPanel();
    }
  } catch (e) {
    console.warn('Failed to restore recording state:', e);
  }
}

function watchTaskStorage() {
  if (!browser.storage || !browser.storage.onChanged) return;

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes || !changes.maclick_tasks) return;
    refreshLauncherState();
  });
}

function initPageState() {
  watchTaskStorage();
  restoreRecordingState();
  refreshLauncherState();
}

initPageState();

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', renderPanel, { once: true });
}
