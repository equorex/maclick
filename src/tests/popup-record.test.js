const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function createClassList() {
  const classes = new Set();
  return {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    contains(name) { return classes.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !classes.has(name) : !!force;
      if (enabled) classes.add(name); else classes.delete(name);
      return enabled;
    }
  };
}

function createElement(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    value: '',
    classList: createClassList(),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach(fn => fn(event)); },
    querySelector() { return null; },
    appendChild(child) { el.children.push(child); return child; },
    set textContent(value) { el._text = value; el.children.length = 0; },
    get textContent() { return el._text; }
  };
  return el;
}

const jsDir = path.join(__dirname, '..', 'js');
const popupSource = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8') +
  '\nglobalThis.__t = { toggleRecord, renderTaskList, get isRecording() { return isRecording; }, set isRecording(v) { isRecording = v; } };';

function createHarness(options = {}) {
  const elements = {
    indicator: createElement('div'),
    'record-btn': createElement('button'),
    'status-message': createElement('div'),
    'task-list': createElement('div')
  };

  const state = { closed: false, sent: [], responses: [], tasks: (options.tasks || []).map(task => ({ ...task })) };

  const document = {
    addEventListener() {},
    getElementById(id) { return elements[id] || null; },
    createElement
  };

  const browser = {
    tabs: {
      async query() {
        return options.noActiveTab ? [] : [{ id: 42 }];
      }
    },
    runtime: {
      async sendMessage(message) {
        state.sent.push(message);
        return state.responses.shift();
      }
    },
    storage: {
      local: {
        async get() { return { maclick_tasks: state.tasks }; },
        async set(patch) {
          if (patch.maclick_tasks) state.tasks = patch.maclick_tasks;
        }
      }
    }
  };

  const context = vm.createContext({
    document,
    browser,
    console,
    window: { close() { state.closed = true; } },
    setTimeout() { return 0; },
    clearTimeout() {}
  });

  vm.runInContext(fs.readFileSync(path.join(jsDir, 'storage.js'), 'utf8'), context);
  vm.runInContext(popupSource, context);

  return { context, elements, state };
}

(async () => {
  const started = createHarness();
  started.state.responses.push({ status: 'started' });
  await started.context.__t.toggleRecord();

  assert.strictEqual(started.context.__t.isRecording, true, 'recording flag set');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(started.state.sent[0])),
    { type: 'START_RECORDING', tabId: 42 },
    'start message sent'
  );
  assert.strictEqual(started.state.closed, true, 'popup closed after successful start');
  assert.strictEqual(started.elements['record-btn'].textContent, '⏹ Stop', 'button switched to stop');
  assert.strictEqual(started.elements.indicator.classList.contains('recording'), true, 'indicator is recording');

  const failed = createHarness();
  failed.state.responses.push({ status: 'error', error: 'boom' });
  await failed.context.__t.toggleRecord();

  assert.strictEqual(failed.state.closed, false, 'popup stays open on start error');
  assert.strictEqual(failed.context.__t.isRecording, false, 'recording flag not set on error');
  assert.ok(failed.elements['status-message'].textContent.includes('boom'), 'error message shown');
  assert.ok(failed.elements['status-message'].className.includes('error'), 'error status style');

  const noResponse = createHarness();
  await noResponse.context.__t.toggleRecord();

  assert.strictEqual(noResponse.state.closed, false, 'popup stays open without response');
  assert.ok(noResponse.elements['status-message'].textContent.includes('unknown error'), 'unknown error message');

  const noTab = createHarness({ noActiveTab: true });
  await noTab.context.__t.toggleRecord();

  assert.strictEqual(noTab.state.closed, false, 'popup stays open without active tab');
  assert.strictEqual(noTab.state.sent.length, 0, 'nothing sent without active tab');
  assert.ok(noTab.elements['status-message'].textContent.includes('No active tab found'), 'missing tab message');

  const stopped = createHarness();
  stopped.context.__t.isRecording = true;
  stopped.state.responses.push({ status: 'stopped', task: { name: 'My task' } });
  await stopped.context.__t.toggleRecord();

  assert.strictEqual(stopped.context.__t.isRecording, false, 'recording flag cleared on stop');
  assert.strictEqual(stopped.state.closed, false, 'popup stays open after stop');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(stopped.state.sent[0])),
    { type: 'STOP_RECORDING', tabId: 42 },
    'stop message sent'
  );
  assert.ok(stopped.elements['status-message'].textContent.includes('My task'), 'saved task message shown');
  assert.ok(stopped.elements['status-message'].textContent.includes('saved'), 'saved status wording');
  assert.strictEqual(stopped.elements['record-btn'].textContent, 'Record', 'button switched to record');

  const emptyHarness = createHarness();
  await emptyHarness.context.__t.renderTaskList();

  const emptyList = emptyHarness.elements['task-list'];
  assert.strictEqual(emptyList.children.length, 1, 'empty state rendered');
  assert.strictEqual(emptyList.children[0].tagName, 'P', 'empty state is a paragraph');
  assert.strictEqual(emptyList.children[0].className, 'empty-list', 'empty state class');
  assert.strictEqual(emptyList.children[0].textContent, 'No saved tasks', 'empty state text');

  const rendering = createHarness({
    tasks: [{
      id: 't1',
      name: '<img src=x onerror=alert(1)>',
      description: '<b>description</b>',
      host: 'example.com',
      createdAt: Date.parse('2026-01-02T03:04:05')
    }]
  });
  await rendering.context.__t.renderTaskList();

  const cards = rendering.elements['task-list'].children;
  assert.strictEqual(cards.length, 1, 'one task card rendered');
  assert.strictEqual(cards[0].className, 'task-card', 'task card class');
  assert.strictEqual(cards[0].children[0].tagName, 'STRONG', 'task name element');
  assert.strictEqual(cards[0].children[0].textContent, '<img src=x onerror=alert(1)>', 'name rendered as text');
  assert.strictEqual(cards[0].children[1].className, 'task-description', 'description class');
  assert.strictEqual(cards[0].children[1].textContent, '<b>description</b>', 'description rendered as text');
  assert.strictEqual(cards[0].children[2].className, 'task-meta', 'meta class');
  assert.ok(cards[0].children[2].textContent.startsWith('example.com • '), 'meta contains host and date');

  const actions = cards[0].children[3];
  assert.strictEqual(actions.className, 'task-actions', 'actions class');
  assert.deepStrictEqual(
    actions.children.map(button => button.className),
    ['btn-run', 'btn-edit', 'btn-delete'],
    'action buttons rendered'
  );
  assert.deepStrictEqual(
    actions.children.map(button => button.textContent),
    ['▶ Run', '✎ Edit', '🗑 Delete'],
    'action button labels'
  );

  const described = createHarness({
    tasks: [{ id: 't2', name: 'No description', host: '', createdAt: Date.now() }]
  });
  await described.context.__t.renderTaskList();
  assert.strictEqual(described.elements['task-list'].children[0].children.length, 3, 'no description element without text');

  console.log('popup record tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
