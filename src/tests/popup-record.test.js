const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { webcrypto } = require('crypto');

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
    dataset: {},
    value: '',
    attributes: {},
    classList: createClassList(),
    setAttribute(name, value) { el.attributes[name] = value; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null; },
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
  '\nglobalThis.__t = { toggleRecord, renderTaskList, renderLastUsed, renderTasks, editTask, handleEditTask, cancelEdit, deleteTask, runTask, reorderSteps, filterTasks, pickLastUsed, selectDomainFilter, updateDomainFilterUi, hasHostAccess, updatePermissionBanner, requestHostAccess,' +
  ' editor: editorRefs,' +
  ' get currentEditingTaskId() { return currentEditingTaskId; },' +
  ' get isRecording() { return isRecording; }, set isRecording(v) { isRecording = v; },' +
  ' get domainFilter() { return domainFilter; }, set domainFilter(v) { domainFilter = v; },' +
  ' get currentHost() { return currentHost; }, set currentHost(v) { currentHost = v; } };';

function createHarness(options = {}) {
  const filterGroup = createElement('div');
  const domainBtn = createElement('button');
  domainBtn.setAttribute('data-filter', 'domain');
  const allBtn = createElement('button');
  allBtn.setAttribute('data-filter', 'all');
  filterGroup.appendChild(domainBtn);
  filterGroup.appendChild(allBtn);

  const elements = {
    indicator: createElement('div'),
    'record-btn': createElement('button'),
    'status-message': createElement('div'),
    'task-list': createElement('div'),
    'last-used-section': createElement('section'),
    'last-used-task': createElement('div'),
    'domain-filter': filterGroup,
    'permission-banner': createElement('div'),
    'grant-permission-btn': createElement('button')
  };

  const state = {
    closed: false,
    sent: [],
    responses: [],
    executed: false,
    tasks: (options.tasks || []).map(task => ({ ...task })),
    prefs: { maclick_domain_filter: options.domainFilter }
  };

  let hostAccess = options.hostAccess !== false;

  const document = {
    addEventListener() {},
    getElementById(id) { return elements[id] || null; },
    createElement,
    createElementNS(ns, tag) { return createElement(tag); }
  };

  const browser = {
    tabs: {
      async query() {
        return options.noActiveTab ? [] : [{ id: 42, url: options.url === undefined ? 'https://example.com/page' : options.url }];
      }
    },
    runtime: {
      async sendMessage(message) {
        state.sent.push(message);
        return state.responses.shift();
      }
    },
    scripting: {
      async executeScript() { state.executed = true; }
    },
    storage: {
      local: {
        async get(keys) {
          const result = {};
          for (const key of keys) {
            if (key === 'maclick_tasks') result[key] = state.tasks;
            if (key === 'maclick_domain_filter') result[key] = state.prefs[key];
          }
          return result;
        },
        async set(patch) {
          if ('maclick_tasks' in patch) state.tasks = patch.maclick_tasks;
          if ('maclick_domain_filter' in patch) state.prefs.maclick_domain_filter = patch.maclick_domain_filter;
        }
      }
    }
  };

  if (!options.noPermissionsApi) {
    browser.permissions = {
      async contains() { return hostAccess; },
      async request() {
        hostAccess = options.requestGranted !== false;
        return hostAccess;
      }
    };
  }

  const context = vm.createContext({
    document,
    browser,
    console,
    crypto: webcrypto,
    URL,
    window: { close() { state.closed = true; } },
    setTimeout() { return 0; },
    clearTimeout() {}
  });

  vm.runInContext(fs.readFileSync(path.join(jsDir, 'storage.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(jsDir, 'executor.js'), 'utf8'), context);
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
  assert.strictEqual(started.elements['record-btn'].textContent, 'Stop', 'button switched to stop');
  assert.strictEqual(started.elements.indicator.classList.contains('recording'), true, 'indicator is recording');

  const failed = createHarness();
  failed.state.responses.push({ status: 'error', error: 'boom' });
  await failed.context.__t.toggleRecord();

  assert.strictEqual(failed.state.closed, false, 'popup stays open on start error');
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

  const stopped = createHarness({ tasks: [] });
  stopped.context.__t.isRecording = true;
  stopped.state.responses.push({ status: 'stopped', task: { name: 'My task' } });
  await stopped.context.__t.toggleRecord();

  assert.strictEqual(stopped.state.closed, false, 'popup stays open after stop');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(stopped.state.sent[0])),
    { type: 'STOP_RECORDING', tabId: 42 },
    'stop message sent'
  );
  assert.ok(stopped.elements['status-message'].textContent.includes('My task'), 'saved task message shown');
  assert.strictEqual(stopped.elements['record-btn'].textContent, 'Record', 'button switched to record');

  const emptyHarness = createHarness();
  await emptyHarness.context.__t.renderTaskList();

  const emptyList = emptyHarness.elements['task-list'];
  assert.strictEqual(emptyList.children.length, 1, 'empty state rendered');
  assert.strictEqual(emptyList.children[0].tagName, 'P', 'empty state is a paragraph');
  assert.strictEqual(emptyList.children[0].className, 'empty-list', 'empty state class');
  assert.strictEqual(emptyList.children[0].textContent, 'No saved tasks', 'empty state text');
  assert.strictEqual(emptyHarness.elements['last-used-section'].hidden, true, 'last used hidden without usage');

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

  const head = cards[0].children[0];
  assert.strictEqual(head.className, 'task-head', 'task head class');
  assert.strictEqual(head.children[0].tagName, 'STRONG', 'task name element');
  assert.strictEqual(head.children[0].textContent, '<img src=x onerror=alert(1)>', 'name rendered as text');

  const actions = head.children[1];
  assert.strictEqual(actions.className, 'task-actions', 'actions class');
  assert.deepStrictEqual(
    actions.children.map(button => button.className),
    ['btn-icon btn-run', 'btn-icon btn-edit', 'btn-icon btn-delete'],
    'action buttons rendered'
  );
  assert.deepStrictEqual(
    actions.children.map(button => button.getAttribute('aria-label')),
    ['Run', 'Edit', 'Delete'],
    'action button accessible labels'
  );
  assert.ok(
    actions.children.every(button => button.children[0].tagName === 'SVG'),
    'action buttons render an icon'
  );

  assert.strictEqual(cards[0].children[1].className, 'task-description', 'description class');
  assert.strictEqual(cards[0].children[1].textContent, '<b>description</b>', 'description rendered as text');
  assert.strictEqual(cards[0].children[2].className, 'task-meta', 'meta class');
  assert.ok(cards[0].children[2].textContent.startsWith('example.com • '), 'meta contains host and date');

  const described = createHarness({
    tasks: [{ id: 't2', name: 'No description', host: '', createdAt: Date.now() }]
  });
  await described.context.__t.renderTaskList();
  assert.strictEqual(described.elements['task-list'].children[0].children.length, 2, 'no description element without text');

  const lastUsed = createHarness({
    tasks: [
      { id: 'a', name: 'Older', host: 'example.com', createdAt: Date.now(), lastUsedAt: 10 },
      { id: 'b', name: 'Newer', host: 'example.com', createdAt: Date.now(), lastUsedAt: 20 }
    ]
  });
  lastUsed.context.__t.currentHost = 'example.com';
  await lastUsed.context.__t.renderTaskList();

  assert.strictEqual(lastUsed.elements['last-used-section'].hidden, false, 'last used section shown');
  const recent = lastUsed.elements['last-used-task'].children[0];
  assert.strictEqual(recent.className, 'task-card is-recent', 'recent card class');
  assert.strictEqual(recent.children[0].children[0].textContent, 'Newer', 'most recent task picked');
  assert.deepStrictEqual(
    recent.children[0].children[1].children.map(button => button.getAttribute('aria-label')),
    ['Run', 'Edit'],
    'recent card has run and edit only'
  );

  const otherDomain = createHarness({
    tasks: [{ id: 'a', name: 'Other', host: 'other.com', createdAt: Date.now(), lastUsedAt: 10 }]
  });
  otherDomain.context.__t.currentHost = 'example.com';
  await otherDomain.context.__t.renderTaskList();
  assert.strictEqual(otherDomain.elements['last-used-section'].hidden, true, 'last used ignores other domains');

  const noHostLastUsed = createHarness({
    tasks: [{ id: 'a', name: 'Any', host: 'example.com', createdAt: Date.now(), lastUsedAt: 10 }]
  });
  noHostLastUsed.context.__t.currentHost = '';
  await noHostLastUsed.context.__t.renderTaskList();
  assert.strictEqual(noHostLastUsed.elements['last-used-section'].hidden, true, 'last used hidden without current domain');

  assert.strictEqual(lastUsed.context.__t.pickLastUsed([]), null, 'no last used without tasks');
  assert.strictEqual(lastUsed.context.__t.pickLastUsed([{ id: 'x' }]), null, 'tasks without lastUsedAt ignored');
  assert.strictEqual(
    lastUsed.context.__t.pickLastUsed([{ id: 'x', lastUsedAt: 5 }, { id: 'y', lastUsedAt: 9 }]).id,
    'y',
    'newest usage wins'
  );

  const filterSource = [{ id: '1', host: 'a.com' }, { id: '2', host: 'b.com' }];
  assert.deepStrictEqual(lastUsed.context.__t.filterTasks(filterSource, 'all', 'a.com').map(t => t.id), ['1', '2'], 'all filter');
  assert.deepStrictEqual(lastUsed.context.__t.filterTasks(filterSource, 'domain', 'a.com').map(t => t.id), ['1'], 'domain filter');
  assert.deepStrictEqual(lastUsed.context.__t.filterTasks(filterSource, 'domain', '').map(t => t.id), ['1', '2'], 'empty host falls back to all');

  const filtered = createHarness({
    url: 'https://example.com/page',
    tasks: [
      { id: '1', name: 'Here', host: 'example.com', createdAt: Date.now() },
      { id: '2', name: 'Elsewhere', host: 'other.com', createdAt: Date.now() }
    ]
  });
  filtered.context.__t.currentHost = 'example.com';
  filtered.context.__t.domainFilter = 'domain';
  filtered.context.__t.updateDomainFilterUi();
  await filtered.context.__t.renderTaskList();

  assert.strictEqual(filtered.elements['task-list'].children.length, 1, 'only current domain tasks');
  assert.strictEqual(filtered.elements['task-list'].children[0].children[0].children[0].textContent, 'Here', 'domain task shown');
  assert.strictEqual(filtered.elements['domain-filter'].children[0].getAttribute('aria-pressed'), 'true', 'domain filter active');

  await filtered.context.__t.selectDomainFilter('all');
  assert.strictEqual(filtered.elements['task-list'].children.length, 2, 'all tasks after switching');
  assert.strictEqual(filtered.state.prefs.maclick_domain_filter, 'all', 'filter persisted');
  assert.strictEqual(filtered.elements['domain-filter'].children[1].getAttribute('aria-pressed'), 'true', 'all filter active');

  const noHost = createHarness({ url: 'about:debugging', tasks: [] });
  noHost.context.__t.currentHost = '';
  noHost.context.__t.domainFilter = 'domain';
  noHost.context.__t.updateDomainFilterUi();
  assert.strictEqual(noHost.elements['domain-filter'].children[0].disabled, true, 'domain option disabled without host');
  assert.strictEqual(noHost.elements['domain-filter'].children[1].getAttribute('aria-pressed'), 'true', 'all active without host');

  const filteredEmpty = createHarness({
    tasks: [{ id: '1', name: 'A', host: 'other.com', createdAt: Date.now() }]
  });
  filteredEmpty.context.__t.currentHost = 'example.com';
  filteredEmpty.context.__t.domainFilter = 'domain';
  await filteredEmpty.context.__t.renderTaskList();
  assert.strictEqual(filteredEmpty.elements['task-list'].children[0].className, 'empty-list', 'filtered empty state');
  assert.strictEqual(filteredEmpty.elements['task-list'].children[0].textContent, 'No tasks for this domain', 'filtered empty text');

  const editing = createHarness({
    tasks: [{ id: 't1', name: 'Old', host: 'example.com', createdAt: Date.now(), steps: [{ type: 'click', selector: '#a' }] }]
  });
  await editing.context.__t.editTask('t1');

  assert.strictEqual(editing.context.__t.currentEditingTaskId, 't1', 'task marked as editing');
  const editingCard = editing.elements['task-list'].children[0];
  assert.strictEqual(editingCard.className, 'task-card is-editing', 'card switched to edit mode');
  assert.strictEqual(editingCard.children[0].className, 'task-head', 'editing card keeps task head');
  assert.strictEqual(editingCard.children[0].children[0].textContent, 'Old', 'editing head shows task name');
  assert.strictEqual(editing.context.__t.editor.name.value, 'Old', 'editor prefilled with name');
  assert.strictEqual(editing.context.__t.editor.steps.children.length, 1, 'editor renders steps');

  editing.context.__t.editor.name.value = 'New name';
  await editing.context.__t.handleEditTask({ preventDefault() {} });

  assert.strictEqual(editing.context.__t.currentEditingTaskId, null, 'editing cleared after save');
  assert.strictEqual(editing.state.tasks[0].name, 'New name', 'task saved in storage');
  assert.strictEqual(editing.elements['task-list'].children[0].className, 'task-card', 'card back to summary');
  assert.ok(editing.elements['status-message'].textContent.includes('saved'), 'save status shown');

  await editing.context.__t.editTask('t1');
  await editing.context.__t.cancelEdit();
  assert.strictEqual(editing.context.__t.currentEditingTaskId, null, 'cancel clears editing');
  assert.strictEqual(editing.elements['task-list'].children[0].className, 'task-card', 'cancel restores summary');

  const running = createHarness({
    tasks: [{ id: 't1', name: 'Runner', host: 'example.com', createdAt: Date.now(), steps: [] }]
  });
  running.context.__t.currentHost = 'example.com';
  await running.context.__t.runTask('t1');

  assert.strictEqual(running.state.executed, true, 'task executed');
  assert.ok(Number.isFinite(running.state.tasks[0].lastUsedAt), 'lastUsedAt recorded on run');
  assert.strictEqual(running.elements['last-used-section'].hidden, false, 'last used section appears after run');
  assert.strictEqual(running.elements['last-used-task'].children.length, 1, 'last used card rendered');

  const withAccess = createHarness();
  assert.strictEqual(await withAccess.context.__t.hasHostAccess(), true, 'host access detected');
  await withAccess.context.__t.updatePermissionBanner();
  assert.strictEqual(withAccess.elements['permission-banner'].hidden, true, 'banner hidden when access granted');

  const noAccess = createHarness({ hostAccess: false });
  assert.strictEqual(await noAccess.context.__t.hasHostAccess(), false, 'missing host access detected');
  await noAccess.context.__t.updatePermissionBanner();
  assert.strictEqual(noAccess.elements['permission-banner'].hidden, false, 'banner shown without access');

  await noAccess.context.__t.requestHostAccess();
  assert.strictEqual(noAccess.elements['permission-banner'].hidden, true, 'banner hidden after grant');
  assert.ok(noAccess.elements['status-message'].textContent.includes('granted'), 'grant status shown');

  const denied = createHarness({ hostAccess: false, requestGranted: false });
  await denied.context.__t.updatePermissionBanner();
  await denied.context.__t.requestHostAccess();
  assert.strictEqual(denied.elements['permission-banner'].hidden, false, 'banner stays after denial');
  assert.ok(denied.elements['status-message'].textContent.includes('required'), 'denial status shown');

  const noApi = createHarness({ noPermissionsApi: true });
  assert.strictEqual(await noApi.context.__t.hasHostAccess(), true, 'assumes access without permissions API');
  await noApi.context.__t.updatePermissionBanner();
  assert.strictEqual(noApi.elements['permission-banner'].hidden, true, 'banner hidden without permissions API');

  const technicalStart = createHarness({ url: 'about:preferences' });
  await technicalStart.context.__t.toggleRecord();
  assert.strictEqual(technicalStart.state.sent.length, 0, 'recording not started on technical domain');
  assert.ok(technicalStart.elements['status-message'].textContent.includes('technical'), 'technical start warning shown');

  const noHostStop = createHarness({ tasks: [] });
  noHostStop.context.__t.isRecording = true;
  noHostStop.state.responses.push({ status: 'stopped', task: null, error: 'no_host' });
  await noHostStop.context.__t.toggleRecord();
  assert.ok(noHostStop.elements['status-message'].textContent.includes('technical'), 'no_host stop warning shown');

  const technicalRun = createHarness({
    url: 'about:preferences',
    tasks: [{ id: 'src', name: 'Login', host: 'other.com', createdAt: Date.now(), steps: [] }]
  });
  technicalRun.context.__t.currentHost = '';
  await technicalRun.context.__t.runTask('src');
  assert.strictEqual(technicalRun.state.executed, false, 'run blocked on technical domain');
  assert.strictEqual(technicalRun.state.tasks.length, 1, 'no copy on technical domain');
  assert.ok(technicalRun.elements['status-message'].textContent.includes('technical'), 'technical run warning shown');

  const foreign = createHarness({
    url: 'https://example.com/page',
    tasks: [{
      id: 'src',
      name: 'Login',
      host: 'other.com',
      description: 'desc',
      defaultTimeout: 500,
      createdAt: 1,
      steps: [{ type: 'click', selector: '#a' }]
    }]
  });
  foreign.context.__t.currentHost = 'example.com';
  foreign.context.__t.domainFilter = 'all';
  await foreign.context.__t.runTask('src');

  assert.strictEqual(foreign.state.executed, true, 'foreign task executed');
  assert.strictEqual(foreign.state.tasks.length, 2, 'copy created for current domain');
  const copy = foreign.state.tasks.find(task => task.host === 'example.com');
  assert.ok(copy, 'copy stored on current domain');
  assert.strictEqual(copy.sourceId, 'src', 'copy tracks its source');
  assert.strictEqual(copy.name, 'Login', 'copy keeps name');
  assert.strictEqual(copy.defaultTimeout, 500, 'copy keeps default timeout');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(copy.steps)), [{ type: 'click', selector: '#a' }], 'copy keeps steps');
  assert.ok(Number.isFinite(copy.lastUsedAt), 'copy marked as used');
  assert.strictEqual(foreign.context.__t.domainFilter, 'domain', 'filter reset to current domain');
  assert.strictEqual(foreign.state.prefs.maclick_domain_filter, 'domain', 'filter persisted');
  assert.strictEqual(foreign.elements['last-used-section'].hidden, false, 'last used shown after copy');
  assert.strictEqual(foreign.elements['last-used-task'].children[0].children[0].children[0].textContent, 'Login', 'last used is the copy');
  assert.strictEqual(foreign.elements['task-list'].children.length, 1, 'only current domain task listed');

  await foreign.context.__t.runTask('src');
  assert.strictEqual(foreign.state.tasks.length, 2, 'existing copy reused on repeat run');
  assert.strictEqual(foreign.state.tasks.find(task => task.host === 'example.com').id, copy.id, 'same copy reused');

  const sameDomain = createHarness({
    tasks: [{ id: 't1', name: 'Same', host: 'example.com', createdAt: Date.now(), steps: [] }]
  });
  sameDomain.context.__t.currentHost = 'example.com';
  sameDomain.context.__t.domainFilter = 'all';
  await sameDomain.context.__t.runTask('t1');
  assert.strictEqual(sameDomain.state.tasks.length, 1, 'no copy for same domain');
  assert.strictEqual(sameDomain.context.__t.domainFilter, 'all', 'filter unchanged for same domain');
  assert.ok(Number.isFinite(sameDomain.state.tasks[0].lastUsedAt), 'same domain marked as used');

  console.log('popup record tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
