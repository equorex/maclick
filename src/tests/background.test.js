const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { webcrypto } = require('crypto');

const eq = (actual, expected, msg) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);

const badgeTextFor = tabId => {
  const calls = actionCalls.filter(call => call.method === 'setBadgeText' && call.details.tabId === tabId);
  return calls.length ? calls.at(-1).details.text : undefined;
};

const badgeTextCountFor = (tabId, text) => actionCalls.filter(
  call => call.method === 'setBadgeText' && call.details.tabId === tabId && call.details.text === text
).length;

const sessionStore = {};
const localStore = {};
let listener;
let removedListener;
const sentToTabs = [];
const actionCalls = [];
const executions = [];
let executionError = null;
const tabsById = {
  1: { id: 1, url: 'https://example.com/page' },
  3: { id: 3, url: 'https://esc.example/' },
  5: { id: 5, url: 'https://race.example/' },
  7: { id: 7, url: 'about:preferences' },
  8: { id: 8, url: 'https://launcher.example/page' },
  9: { id: 9, url: 'https://empty.example/' }
};

const browser = {
  action: {
    async setBadgeText(details) { actionCalls.push({ method: 'setBadgeText', details }); },
    async setBadgeBackgroundColor(details) { actionCalls.push({ method: 'setBadgeBackgroundColor', details }); },
    async setTitle(details) { actionCalls.push({ method: 'setTitle', details }); }
  },
  storage: {
    session: {
      async get(keys) {
        const out = {};
        for (const key of keys) if (key in sessionStore) out[key] = sessionStore[key];
        return out;
      },
      async set(patch) {
        Object.assign(sessionStore, patch);
      }
    },
    local: {
      async get(keys) {
        const out = {};
        for (const key of keys) if (key in localStore) out[key] = localStore[key];
        return out;
      },
      async set(patch) {
        Object.assign(localStore, patch);
      }
    }
  },
  tabs: {
    async sendMessage(tabId, message) {
      sentToTabs.push({ tabId, message });
      return { status: 'ok' };
    },
    async get(tabId) {
      return tabsById[tabId] || null;
    },
    onRemoved: { addListener(fn) { removedListener = fn; } }
  },
  scripting: {
    async executeScript(details) {
      executions.push(details);
      if (executionError) throw new Error(executionError);
    }
  },
  runtime: {
    onMessage: { addListener(fn) { listener = fn; } }
  }
};

const jsDir = path.join(__dirname, '..', 'js');
const context = vm.createContext({ browser, console, crypto: webcrypto, URL, Date });

vm.runInContext(fs.readFileSync(path.join(jsDir, 'storage.js'), 'utf8'), context);
assert.strictEqual(context.TASK_DEFAULT_TIMEOUT, 300, 'storage.js publishes TASK_DEFAULT_TIMEOUT');
assert.ok(context.taskStorage, 'storage.js publishes taskStorage');

vm.runInContext(fs.readFileSync(path.join(jsDir, 'executor.js'), 'utf8'), context);
assert.strictEqual(typeof context.executeTask, 'function', 'executor.js publishes executeTask for background');

vm.runInContext(fs.readFileSync(path.join(jsDir, 'background.js'), 'utf8'), context);

(async () => {
  const popup = { id: 'popup' };
  const contentSender = tabId => ({ tab: { id: tabId, url: (tabsById[tabId] || {}).url } });

  let res = await listener({ type: 'GET_RECORDING_STATE', tabId: 1 }, popup);
  eq(res, { recording: false }, 'empty state');
  assert.strictEqual(badgeTextFor(1), undefined, 'no badge before recording');

  res = await listener({ type: 'START_RECORDING', tabId: 1 }, popup);
  assert.strictEqual(res.status, 'started');
  eq(sentToTabs.at(-1), { tabId: 1, message: { type: 'START_RECORDING' } }, 'start forwarded');
  assert.strictEqual(badgeTextFor(1), 'REC', 'badge set on start');
  assert.ok(actionCalls.some(call => call.method === 'setBadgeBackgroundColor' && call.details.tabId === 1), 'badge color set');
  assert.ok(actionCalls.some(call => call.method === 'setTitle' && call.details.tabId === 1 && call.details.title === 'maclick: recording (Esc to stop)'), 'recording title set');

  const badgeCountBeforeRestore = badgeTextCountFor(1, 'REC');
  res = await listener({ type: 'GET_RECORDING_STATE', tabId: 1 }, popup);
  assert.strictEqual(res.recording, true);
  assert.strictEqual(badgeTextCountFor(1, 'REC'), badgeCountBeforeRestore + 1, 'badge restored on navigation');

  await listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#a' } }, contentSender(1));
  await listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#b' } }, contentSender(1));

  res = await listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#c' } }, contentSender(2));
  assert.strictEqual(res.status, 'ignored', 'other tab not recording');

  res = await listener({ type: 'STOP_RECORDING', tabId: 1 }, popup);
  assert.strictEqual(res.status, 'stopped');
  assert.ok(res.task && res.task.id, 'task created on stop');
  assert.strictEqual(res.task.host, 'example.com');
  assert.ok(res.task.name.startsWith('Task from '), 'recorded task name is in English');
  assert.strictEqual(res.task.defaultTimeout, 300, 'defaultTimeout set');
  assert.strictEqual(res.task.steps.length, 3, 'task holds page load wait plus recorded steps');
  assert.strictEqual(res.task.steps[0].type, 'wait_page_load', 'wait_page_load is the first step');
  assert.strictEqual((localStore.maclick_tasks || []).length, 1, 'task persisted');
  eq(sentToTabs.at(-1), { tabId: 1, message: { type: 'STOP_RECORDING' } }, 'stop forwarded');
  assert.strictEqual(badgeTextFor(1), '', 'badge cleared on stop');

  res = await listener({ type: 'GET_RECORDING_STATE', tabId: 1 }, popup);
  eq(res, { recording: false }, 'session dropped after stop');

  res = await listener({ type: 'STOP_RECORDING', tabId: 1 }, popup);
  assert.strictEqual(res.task, null, 'empty recording not saved');
  assert.strictEqual(res.error, 'empty', 'empty recording reason reported');
  assert.strictEqual((localStore.maclick_tasks || []).length, 1, 'task count unchanged');

  await listener({ type: 'START_RECORDING', tabId: 7 }, popup);
  await listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#t' } }, contentSender(7));
  res = await listener({ type: 'STOP_RECORDING', tabId: 7 }, popup);
  assert.strictEqual(res.task, null, 'technical domain task not saved');
  assert.strictEqual(res.error, 'no_host', 'technical domain reason reported');
  assert.strictEqual((localStore.maclick_tasks || []).length, 1, 'task count unchanged for technical domain');

  await listener({ type: 'START_RECORDING', tabId: 3 }, popup);
  await listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#x' } }, contentSender(3));
  res = await listener({ type: 'RECORDING_STOPPED' }, contentSender(3));
  assert.ok(res.task, 'esc saves task');
  assert.strictEqual(res.task.steps.length, 2);
  assert.strictEqual(res.task.steps[0].type, 'wait_page_load', 'esc task starts with page load wait');
  assert.strictEqual(res.task.steps.some(step => step.type === 'stop_recording'), false, 'no stop_recording step');
  assert.strictEqual(localStore.maclick_tasks.length, 2);
  res = await listener({ type: 'GET_RECORDING_STATE', tabId: 3 }, popup);
  eq(res, { recording: false }, 'esc drops session');
  assert.strictEqual(badgeTextFor(3), '', 'badge cleared on esc');

  await listener({ type: 'START_RECORDING', tabId: 5 }, popup);
  await Promise.all([
    listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#1' } }, contentSender(5)),
    listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#2' } }, contentSender(5)),
    listener({ type: 'RECORDED_STEP', step: { type: 'click', selector: '#3' } }, contentSender(5))
  ]);
  res = await listener({ type: 'STOP_RECORDING', tabId: 5 }, popup);
  assert.strictEqual(res.task.steps.length, 4, 'concurrent steps are not lost');

  await listener({ type: 'START_RECORDING', tabId: 6 }, popup);
  removedListener(6);
  await new Promise(resolve => setTimeout(resolve, 10));
  res = await listener({ type: 'GET_RECORDING_STATE', tabId: 6 }, popup);
  eq(res, { recording: false }, 'tab removal drops session');

  const startError = await listener({ type: 'START_RECORDING' }, popup);
  assert.strictEqual(startError.status, 'error');

  localStore.maclick_tasks = [
    ...localStore.maclick_tasks,
    { id: 'old', name: 'Older', host: 'launcher.example', lastUsedAt: 10, steps: [] },
    { id: 'new', name: 'Newest', host: 'launcher.example', lastUsedAt: 20, steps: [] },
    { id: 'other', name: 'Other host', host: 'other.example', lastUsedAt: 30, steps: [] },
    { id: 'string-date', name: 'String date', host: 'launcher.example', lastUsedAt: '999', steps: [] }
  ];

  res = await listener({ type: 'GET_LAUNCHER_STATE' }, contentSender(8));
  eq(res, { task: { id: 'new', name: 'Newest', lastUsedAt: 20 } }, 'last used task selected for host');

  res = await listener({ type: 'GET_LAUNCHER_STATE' }, contentSender(1));
  eq(res, { task: null }, 'never used tasks are not offered');

  res = await listener({ type: 'GET_LAUNCHER_STATE' }, contentSender(9));
  eq(res, { task: null }, 'no launcher task for an empty host');

  res = await listener({ type: 'GET_LAUNCHER_STATE' }, contentSender(7));
  eq(res, { task: null }, 'technical domain has no launcher task');

  res = await listener({ type: 'GET_LAUNCHER_STATE' }, popup);
  eq(res, { task: null }, 'no launcher task without a tab');

  executions.length = 0;
  res = await listener({ type: 'RUN_LAST_TASK', taskId: 'old' }, contentSender(8));
  eq(res, { status: 'stale', task: { id: 'new', name: 'Newest', lastUsedAt: 20 } }, 'stale task rejected');
  assert.strictEqual(executions.length, 0, 'stale task is not executed');

  res = await listener({ type: 'RUN_LAST_TASK' }, contentSender(8));
  assert.strictEqual(res.status, 'stale', 'missing task id treated as stale');
  assert.strictEqual(executions.length, 0, 'missing task id is not executed');

  res = await listener({ type: 'RUN_LAST_TASK', taskId: 'new' }, contentSender(8));
  assert.strictEqual(res.status, 'started', 'last task started from launcher');
  assert.strictEqual(res.task.id, 'new', 'started task reported');
  assert.strictEqual(executions.length, 1, 'task executed once');
  assert.strictEqual(executions[0].target.tabId, 8, 'executed in the requesting tab');
  assert.strictEqual(executions[0].args[0].id, 'new', 'last task passed to executor');
  assert.strictEqual(typeof executions[0].func, 'function', 'executor function injected');
  assert.ok(localStore.maclick_tasks.find(task => task.id === 'new').lastUsedAt > 20, 'lastUsedAt updated on run');

  executions.length = 0;
  res = await listener({ type: 'RUN_LAST_TASK', taskId: 'new' }, contentSender(9));
  eq(res, { status: 'error', error: 'no_task' }, 'no task for host');
  assert.strictEqual(executions.length, 0, 'nothing executed without a task');

  res = await listener({ type: 'RUN_LAST_TASK', taskId: 'new' }, contentSender(7));
  eq(res, { status: 'error', error: 'no_host' }, 'technical domain cannot run a task');

  res = await listener({ type: 'RUN_LAST_TASK', taskId: 'new' }, popup);
  eq(res, { status: 'error', error: 'Unknown tab' }, 'run requires a tab');

  executionError = 'boom';
  res = await listener({ type: 'RUN_LAST_TASK', taskId: 'new' }, contentSender(8));
  eq(res, { status: 'error', error: 'boom' }, 'execution error reported');
  executionError = null;

  console.log('background tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
