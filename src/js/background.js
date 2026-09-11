const SESSION_KEY = 'maclick_sessions';
const memorySessions = {};

const RECORDING_BADGE = 'REC';
const RECORDING_BADGE_COLOR = '#e53e3e';
const DEFAULT_TITLE = 'maclick - Record & Replay';
const RECORDING_TITLE = 'maclick: recording (Esc to stop)';

async function showRecordingIndicator(tabId) {
  if (!browser.action) return;

  try {
    await browser.action.setBadgeBackgroundColor({ color: RECORDING_BADGE_COLOR, tabId });
    await browser.action.setBadgeText({ text: RECORDING_BADGE, tabId });
    await browser.action.setTitle({ title: RECORDING_TITLE, tabId });
  } catch (e) {
    console.warn('Failed to show recording indicator:', e);
  }
}

async function clearRecordingIndicator(tabId) {
  if (!browser.action) return;

  try {
    await browser.action.setBadgeText({ text: '', tabId });
    await browser.action.setTitle({ title: DEFAULT_TITLE, tabId });
  } catch (e) {
    console.warn('Failed to clear recording indicator:', e);
  }
}

function hasSessionStorage() {
  return !!(browser.storage && browser.storage.session);
}

async function loadSessions() {
  if (!hasSessionStorage()) return memorySessions;

  const stored = await browser.storage.session.get([SESSION_KEY]);
  return stored[SESSION_KEY] || {};
}

async function saveSessions(sessions) {
  if (!hasSessionStorage()) {
    for (const key of Object.keys(memorySessions)) delete memorySessions[key];
    Object.assign(memorySessions, sessions);
    return;
  }

  await browser.storage.session.set({ [SESSION_KEY]: sessions });
}

async function getSession(tabId) {
  const sessions = await loadSessions();
  return sessions[String(tabId)] || null;
}

async function setSession(tabId, session) {
  const sessions = await loadSessions();
  sessions[String(tabId)] = session;
  await saveSessions(sessions);
}

async function removeSession(tabId) {
  const sessions = await loadSessions();
  delete sessions[String(tabId)];
  await saveSessions(sessions);
}

function resolveTabId(message, sender) {
  if (typeof message.tabId === 'number') return message.tabId;
  if (sender.tab && typeof sender.tab.id === 'number') return sender.tab.id;
  return null;
}

async function handleStartRecording(message, sender) {
  const tabId = resolveTabId(message, sender);
  if (tabId === null) return { status: 'error', error: 'Unknown tab' };

  try {
    await browser.tabs.sendMessage(tabId, { type: 'START_RECORDING' });
  } catch (e) {
    return { status: 'error', error: e.message };
  }

  const existing = await getSession(tabId);
  const steps = existing && existing.recording ? existing.steps : [];
  await setSession(tabId, { recording: true, steps });
  await showRecordingIndicator(tabId);
  return { status: 'started' };
}

function getHostname(url) {
  if (!url) return '';

  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

function formatDate(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function saveRecordedTask(url, steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const host = getHostname(url);
  const task = {
    id: crypto.randomUUID(),
    name: `Task from ${formatDate(new Date())} (${host})`,
    host,
    description: '',
    defaultTimeout: TASK_DEFAULT_TIMEOUT,
    createdAt: Date.now(),
    steps: [{ type: 'wait_page_load' }, ...steps]
  };

  return taskStorage.add(task);
}

async function getTabUrl(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    return tab ? tab.url : '';
  } catch (e) {
    return '';
  }
}

async function resolveTabUrl(sender, tabId) {
  if (sender.tab && sender.tab.url) return sender.tab.url;
  return getTabUrl(tabId);
}

async function finishRecording(sender, tabId, session) {
  const url = await resolveTabUrl(sender, tabId);
  const task = await saveRecordedTask(url, session ? session.steps : []);
  await removeSession(tabId);
  await clearRecordingIndicator(tabId);
  return task;
}

async function handleStopRecording(message, sender) {
  const tabId = resolveTabId(message, sender);
  if (tabId === null) return { status: 'error' };

  try {
    await browser.tabs.sendMessage(tabId, { type: 'STOP_RECORDING' });
  } catch (e) {
    console.warn('Content script did not confirm stop:', e);
  }

  const session = await getSession(tabId);
  const task = await finishRecording(sender, tabId, session);
  return { status: 'stopped', task };
}

async function handleRecordedStep(message, sender) {
  const tabId = resolveTabId(message, sender);
  if (tabId === null) return { status: 'ignored' };

  const session = await getSession(tabId);
  if (!session || !session.recording || !message.step) return { status: 'ignored' };

  session.steps.push(message.step);
  await setSession(tabId, session);
  return { status: 'ok' };
}

async function handleRecordingStopped(message, sender) {
  const tabId = resolveTabId(message, sender);
  if (tabId === null) return { status: 'ignored' };

  const session = await getSession(tabId);
  if (!session || !session.recording) return { status: 'ignored' };

  const task = await finishRecording(sender, tabId, session);
  return { status: 'stopped', task };
}

async function handleGetRecordingState(message, sender) {
  const tabId = resolveTabId(message, sender);
  if (tabId === null) return { recording: false };

  const session = await getSession(tabId);
  const recording = !!(session && session.recording);

  if (recording) await showRecordingIndicator(tabId);

  return { recording };
}

let operationQueue = Promise.resolve();

function enqueue(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(() => {}, () => {});
  return result;
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'START_RECORDING':
      return enqueue(() => handleStartRecording(message, sender));
    case 'STOP_RECORDING':
      return enqueue(() => handleStopRecording(message, sender));
    case 'RECORDED_STEP':
      return enqueue(() => handleRecordedStep(message, sender));
    case 'RECORDING_STOPPED':
      return enqueue(() => handleRecordingStopped(message, sender));
    case 'GET_RECORDING_STATE':
      return enqueue(() => handleGetRecordingState(message, sender));
    default:
      return undefined;
  }
}

browser.runtime.onMessage.addListener((message, sender) => handleMessage(message, sender));

browser.tabs.onRemoved.addListener(tabId => {
  removeSession(tabId).catch(e => console.error('Failed to drop recording session:', e));
});
