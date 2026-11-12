const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const eq = (actual, expected, msg) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function matchesCompound(element, selector) {
  let base = selector;
  const nthMatch = base.match(/:nth-child\((\d+)\)\s*$/);
  if (nthMatch) {
    base = base.slice(0, nthMatch.index);
    const index = Number(nthMatch[1]);
    const siblings = element.parentNode && element.parentNode.children
      ? element.parentNode.children
      : [element];
    if (siblings.indexOf(element) + 1 !== index) return false;
  }

  const idMatch = base.match(/#([^\s.#:]+)/);
  if (idMatch && element.id !== idMatch[1]) return false;

  const classNames = [];
  base.replace(/\.([^\s.#:]+)/g, (match, name) => {
    classNames.push(name);
    return match;
  });
  if (!classNames.every(name => element.classList.contains(name))) return false;

  const tag = base.split('#')[0].split('.')[0];
  if (tag && tag.toLowerCase() !== (element.localName || '').toLowerCase()) return false;

  return true;
}

function queryAll(root, selector) {
  const results = [];
  const visit = node => {
    for (const child of node.children || []) {
      if (matchesCompound(child, selector)) results.push(child);
      visit(child);
    }
  };
  visit(root);
  return results;
}

function createElement(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    localName: tag.toLowerCase(),
    nodeType: 1,
    children: [],
    id: '',
    className: '',
    type: '',
    value: '',
    style: { cssText: '' },
    parentNode: null,
    parentElement: null,
    get classList() {
      const names = el.className ? el.className.split(/\s+/).filter(Boolean) : [];
      return {
        length: names.length,
        item: index => names[index],
        contains: name => names.includes(name),
        add(name) {
          if (names.includes(name)) return;
          names.push(name);
          el.className = names.join(' ');
        },
        remove(name) {
          const index = names.indexOf(name);
          if (index < 0) return;
          names.splice(index, 1);
          el.className = names.join(' ');
        },
        toggle(name, force) {
          const enabled = force === undefined ? !names.includes(name) : !!force;
          if (enabled) this.add(name);
          else this.remove(name);
          return enabled;
        }
      };
    },
    setAttribute(name, value) { el[name] = value; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el, name) ? el[name] : null; },
    getRootNode() {
      let node = el;
      while (node.parentNode) node = node.parentNode;
      return node;
    },
    querySelectorAll(selector) { return queryAll(el, selector); },
    attachShadow() {
      el.shadowRoot = createElement('#shadow-root');
      el.shadowRoot.nodeType = 11;
      return el.shadowRoot;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach(fn => fn(event)); },
    appendChild(child) {
      child.parentNode = el;
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    },
    contains(node) { return el.children.includes(node); },
    set textContent(value) { el._text = value; },
    get textContent() { return el._text; }
  };
  return el;
}

const jsDir = path.join(__dirname, '..', 'js');
const contentSource = fs.readFileSync(path.join(jsDir, 'content_script.js'), 'utf8');

function createHarness(options = {}) {
  const docListeners = {};
  const messageListeners = [];
  const storageListeners = [];
  const sessionStore = options.sessionStore || {};
  const state = {
    sent: [],
    recording: !!options.recording,
    launcher: options.launcher || { task: null }
  };

  const documentElement = createElement('html');
  const document = {
    nodeType: 9,
    documentElement,
    children: [documentElement],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    createElement,
    createElementNS(namespace, tag) { return createElement(tag); },
    querySelectorAll(selector) { return queryAll(document, selector); }
  };
  documentElement.parentNode = document;

  const browser = {
    runtime: {
      async sendMessage(message) {
        state.sent.push(message);
        if (message.type === 'GET_RECORDING_STATE') return { recording: state.recording };
        if (message.type === 'GET_LAUNCHER_STATE') return state.launcher;
        if (message.type === 'RUN_LAST_TASK') return { status: 'started' };
        return { status: 'ok' };
      },
      onMessage: { addListener(fn) { messageListeners.push(fn); } }
    },
    storage: {
      onChanged: { addListener(fn) { storageListeners.push(fn); } }
    }
  };

  const sessionStorage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(sessionStore, key) ? sessionStore[key] : null;
    },
    setItem(key, value) { sessionStore[key] = String(value); },
    removeItem(key) { delete sessionStore[key]; }
  };

  const context = vm.createContext({
    document,
    browser,
    sessionStorage,
    console,
    Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    CSS: { escape: value => value },
    setTimeout,
    clearTimeout,
    ...(options.pointerEvents === false ? {} : { PointerEvent: function PointerEvent() {} })
  });

  vm.runInContext(contentSource, context);

  return {
    state,
    sessionStore,
    document,
    docListeners,
    onMessage: messageListeners[0],
    overlay() {
      return document.documentElement.children.find(el => el.id === 'maclick-floating-panel') || null;
    },
    overlayCount() {
      return document.documentElement.children.filter(el => el.id === 'maclick-floating-panel').length;
    },
    setLauncher(task) {
      state.launcher = { task };
    },
    emitTaskStorageChange() {
      storageListeners.forEach(fn => fn({ maclick_tasks: { newValue: [] } }, 'local'));
    }
  };
}

(async () => {
  const harness = createHarness();
  await delay(10);
  assert.strictEqual(harness.overlay(), null, 'no overlay without recording');

  await harness.onMessage({ type: 'START_RECORDING' });
  assert.ok(harness.overlay(), 'overlay shown on start');

  await harness.onMessage({ type: 'START_RECORDING' });
  const overlayCount = harness.overlayCount();
  assert.strictEqual(overlayCount, 1, 'overlay is not duplicated on repeated start');

  const panelBody = harness.overlay().shadowRoot.children[1];
  const stopButton = panelBody.children[0].children[3];
  const cancelButton = panelBody.children[0].children[4];
  assert.strictEqual(stopButton.textContent, '⏹ Stop', 'stop button rendered');
  assert.strictEqual(cancelButton.textContent, '✕ Cancel', 'cancel button rendered');
  assert.strictEqual(cancelButton.getAttribute('aria-label'), 'Cancel recording', 'cancel button accessible label');
  assert.strictEqual(panelBody.children[1].hidden, true, 'actions hidden while recording');

  harness.state.sent.length = 0;
  harness.docListeners.click[0]({
    target: harness.overlay(),
    composedPath: () => [harness.overlay(), document.documentElement]
  });
  assert.strictEqual(harness.state.sent.length, 0, 'overlay click is not recorded');

  const target = createElement('button');
  target.id = 'submit';
  harness.document.documentElement.appendChild(target);

  harness.docListeners.click[0]({ target, composedPath: () => [target] });
  assert.strictEqual(harness.state.sent.length, 1, 'page click is recorded');
  eq(harness.state.sent[0], { type: 'RECORDED_STEP', step: { type: 'click', selector: '#submit' } }, 'recorded step selector');

  harness.state.sent.length = 0;
  harness.docListeners.click[0]({ target: harness.overlay(), composedPath: () => [harness.overlay()] });
  stopButton.dispatch('click');
  assert.strictEqual(harness.overlay(), null, 'overlay hidden after stop button');
  assert.strictEqual(harness.state.sent.length, 1, 'stop button sends a single message');
  assert.strictEqual(harness.state.sent[0].type, 'RECORDING_STOPPED', 'stop button stops recording');

  await harness.onMessage({ type: 'START_RECORDING' });
  assert.ok(harness.overlay(), 'overlay shown again after restart');

  harness.state.sent.length = 0;
  const escEvent = { key: 'Escape', preventDefault() { escEvent.defaultPrevented = true; } };
  harness.docListeners.keydown[0](escEvent);
  assert.strictEqual(escEvent.defaultPrevented, true, 'escape default prevented');
  assert.strictEqual(harness.overlay(), null, 'overlay hidden on escape');
  assert.strictEqual(harness.state.sent[0].type, 'RECORDING_STOPPED', 'escape stops recording');

  await harness.onMessage({ type: 'START_RECORDING' });
  await harness.onMessage({ type: 'STOP_RECORDING' });
  assert.strictEqual(harness.overlay(), null, 'overlay hidden on background stop');

  const discardHarness = createHarness({ recording: true });
  await delay(10);
  const discardPanel = discardHarness.overlay();
  const discardButton = discardPanel.shadowRoot.children[1].children[0].children[4];
  discardHarness.state.sent.length = 0;
  discardButton.dispatch('click');
  assert.strictEqual(discardHarness.overlay(), null, 'overlay hidden after cancel button');
  assert.strictEqual(discardHarness.state.sent.length, 1, 'cancel button sends a single message');
  assert.strictEqual(discardHarness.state.sent[0].type, 'CANCEL_RECORDING', 'cancel button discards recording');

  const discardTarget = createElement('button');
  discardTarget.id = 'after-cancel';
  discardHarness.document.documentElement.appendChild(discardTarget);
  discardHarness.state.sent.length = 0;
  discardHarness.docListeners.click[0]({ target: discardTarget, composedPath: () => [discardTarget] });
  assert.strictEqual(discardHarness.state.sent.length, 0, 'clicks are not recorded after cancel');

  const restored = createHarness({ recording: true });
  await delay(10);
  assert.ok(restored.overlay(), 'overlay restored with active recording');

  const inputHarness = createHarness({ recording: true });
  await delay(10);

  const textInput = createElement('input');
  textInput.id = 'name';
  textInput.type = 'text';
  textInput.value = 'Alice';
  inputHarness.document.documentElement.appendChild(textInput);

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: textInput, composedPath: () => [textInput] });
  assert.strictEqual(inputHarness.state.sent.length, 1, 'text input change recorded');
  eq(inputHarness.state.sent[0], {
    type: 'RECORDED_STEP',
    step: { type: 'input_text', selector: '#name', value: 'Alice' }
  }, 'text input step payload');

  const passwordInput = createElement('input');
  passwordInput.id = 'pwd';
  passwordInput.type = 'password';
  passwordInput.value = 'secret';
  inputHarness.document.documentElement.appendChild(passwordInput);

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: passwordInput, composedPath: () => [passwordInput] });
  assert.strictEqual(inputHarness.state.sent.length, 0, 'password change not recorded');

  const bio = createElement('textarea');
  bio.id = 'bio';
  bio.value = 'hello';
  inputHarness.document.documentElement.appendChild(bio);

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: bio, composedPath: () => [bio] });
  eq(inputHarness.state.sent[0], {
    type: 'RECORDED_STEP',
    step: { type: 'input_text', selector: '#bio', value: 'hello' }
  }, 'textarea change recorded');

  const checkbox = createElement('input');
  checkbox.id = 'agree';
  checkbox.type = 'checkbox';
  checkbox.value = 'on';
  inputHarness.document.documentElement.appendChild(checkbox);

  const select = createElement('select');
  select.id = 'city';
  select.value = 'msk';
  inputHarness.document.documentElement.appendChild(select);

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: checkbox, composedPath: () => [checkbox] });
  inputHarness.docListeners.change[0]({ target: select, composedPath: () => [select] });
  assert.strictEqual(inputHarness.state.sent.length, 0, 'non-text fields not recorded');

  inputHarness.state.sent.length = 0;
  textInput.value = '';
  inputHarness.docListeners.change[0]({ target: textInput, composedPath: () => [textInput] });
  eq(inputHarness.state.sent[0], {
    type: 'RECORDED_STEP',
    step: { type: 'input_text', selector: '#name', value: '' }
  }, 'empty value recorded as clear');

  await inputHarness.onMessage({ type: 'STOP_RECORDING' });
  inputHarness.state.sent.length = 0;
  textInput.value = 'ignored';
  inputHarness.docListeners.change[0]({ target: textInput, composedPath: () => [textInput] });
  assert.strictEqual(inputHarness.state.sent.length, 0, 'change not recorded after stop');

  const orderHarness = createHarness({ recording: true });
  await delay(10);
  orderHarness.state.sent.length = 0;

  const orderInput = createElement('input');
  orderInput.id = 'order';
  orderInput.type = 'text';
  orderInput.value = 'x';
  orderHarness.document.documentElement.appendChild(orderInput);

  orderHarness.docListeners.change[0]({ target: orderInput, composedPath: () => [orderInput] });
  orderHarness.docListeners.click[0]({ target: orderInput, composedPath: () => [orderInput] });
  eq(orderHarness.state.sent.map(message => message.step.type), ['input_text', 'click'], 'input recorded before click');

  const selectorHarness = createHarness({ recording: true });
  await delay(10);
  const root = selectorHarness.document.documentElement;

  const clickSelector = element => {
    selectorHarness.state.sent.length = 0;
    selectorHarness.docListeners.click[0]({ target: element, composedPath: () => [element] });
    assert.strictEqual(selectorHarness.state.sent.length, 1, 'selector click recorded');
    return selectorHarness.state.sent[0].step.selector;
  };

  assert.strictEqual(clickSelector(root), 'html', 'root html selector');

  const body = createElement('body');
  root.appendChild(body);
  assert.strictEqual(clickSelector(body), 'body', 'body selector');

  const uniqueClass = createElement('div');
  uniqueClass.className = 'unique-widget';
  root.appendChild(uniqueClass);
  assert.strictEqual(clickSelector(uniqueClass), '.unique-widget', 'unique class selector');

  const dupClassA = createElement('div');
  dupClassA.className = 'widget';
  const dupClassB = createElement('span');
  dupClassB.className = 'widget';
  root.appendChild(dupClassA);
  root.appendChild(dupClassB);
  assert.strictEqual(clickSelector(dupClassB), 'span.widget', 'tag and class selector');

  const nthA = createElement('span');
  nthA.className = 'row';
  const nthB = createElement('span');
  nthB.className = 'row';
  root.appendChild(nthA);
  root.appendChild(nthB);
  assert.strictEqual(clickSelector(nthA), 'span.row:nth-child(' + (root.children.indexOf(nthA) + 1) + ')', 'class nth-child selector');

  const dupIdA = createElement('div');
  dupIdA.id = 'dup';
  const dupIdB = createElement('div');
  dupIdB.id = 'dup';
  root.appendChild(dupIdA);
  root.appendChild(dupIdB);
  assert.strictEqual(clickSelector(dupIdA), 'html > div:nth-child(' + (root.children.indexOf(dupIdA) + 1) + ')', 'duplicate id falls back to path');

  const shadowHost = createElement('div');
  root.appendChild(shadowHost);
  const shadow = shadowHost.attachShadow({ mode: 'open' });
  const shadowTarget = createElement('button');
  shadowTarget.id = 'inner';
  shadow.appendChild(shadowTarget);
  assert.strictEqual(clickSelector(shadowTarget), '#inner', 'selector inside shadow root');

  const pointerHarness = createHarness({ recording: true });
  await delay(10);

  const toggle = createElement('button');
  toggle.id = 'menu-toggle';
  pointerHarness.document.documentElement.appendChild(toggle);

  pointerHarness.docListeners.pointerdown[0]({ target: toggle, composedPath: () => [toggle] });
  toggle.id = '';
  toggle.className = 'menu-toggle expanded';

  pointerHarness.state.sent.length = 0;
  pointerHarness.docListeners.click[0]({ target: toggle, composedPath: () => [toggle] });
  eq(pointerHarness.state.sent[0], {
    type: 'RECORDED_STEP',
    step: { type: 'click', selector: '#menu-toggle' }
  }, 'selector captured on pointerdown before DOM mutation');

  const cancelHarness = createHarness({ recording: true });
  await delay(10);

  const cancelTarget = createElement('button');
  cancelTarget.id = 'keep';
  cancelHarness.document.documentElement.appendChild(cancelTarget);

  cancelHarness.docListeners.pointerdown[0]({ target: cancelTarget, composedPath: () => [cancelTarget] });
  cancelTarget.id = '';
  cancelTarget.className = 'renamed';
  cancelHarness.docListeners.pointercancel[0]({});

  cancelHarness.state.sent.length = 0;
  cancelHarness.docListeners.click[0]({ target: cancelTarget, composedPath: () => [cancelTarget] });
  assert.strictEqual(cancelHarness.state.sent[0].step.selector, '.renamed', 'pointercancel resets cached selector');

  const legacyHarness = createHarness({ recording: true, pointerEvents: false });
  await delay(10);
  assert.ok(legacyHarness.docListeners.mousedown, 'mousedown fallback registered without PointerEvent');

  const legacyTarget = createElement('a');
  legacyTarget.id = 'legacy';
  legacyHarness.document.documentElement.appendChild(legacyTarget);

  legacyHarness.docListeners.mousedown[0]({ target: legacyTarget, composedPath: () => [legacyTarget] });
  legacyTarget.id = '';
  legacyTarget.className = 'legacy-link';

  legacyHarness.state.sent.length = 0;
  legacyHarness.docListeners.click[0]({ target: legacyTarget, composedPath: () => [legacyTarget] });
  assert.strictEqual(legacyHarness.state.sent[0].step.selector, '#legacy', 'mousedown fallback captures selector');

  const emptyLauncherHarness = createHarness();
  await delay(10);
  assert.strictEqual(emptyLauncherHarness.overlay(), null, 'no panel without a last task');

  const launcherHarness = createHarness({
    launcher: { task: { id: 'last', name: 'Login', lastActiveAt: 1000 } }
  });
  await delay(10);

  let launcherPanel = launcherHarness.overlay();
  assert.ok(launcherPanel, 'launcher panel shown with last task');
  let launcherBody = launcherPanel.shadowRoot.children[1];
  assert.strictEqual(launcherBody.children[0].hidden, true, 'recording indicator hidden on launcher');
  assert.strictEqual(launcherBody.children[1].hidden, false, 'actions visible on launcher');

  let playButton = launcherBody.children[1].children[0];
  let reloadButton = launcherBody.children[1].children[1];
  let closeButton = launcherBody.children[1].children[2];
  assert.strictEqual(playButton.title, 'Run last task: Login', 'play button shows task name');
  assert.strictEqual(playButton.getAttribute('aria-label'), 'Run last task: Login', 'play button accessible label');
  assert.strictEqual(reloadButton.getAttribute('aria-label'), 'Reload tab', 'reload button accessible label');
  assert.strictEqual(closeButton.getAttribute('aria-label'), 'Hide panel', 'close button accessible label');
  assert.ok(playButton.className.includes('play'), 'play button styled');
  assert.ok(reloadButton.className.includes('reload'), 'reload button styled');
  assert.ok(closeButton.className.includes('close'), 'close button styled');
  assert.strictEqual(playButton.children[0].tagName, 'SVG', 'play button uses an svg icon');
  assert.strictEqual(reloadButton.children[0].tagName, 'SVG', 'reload button uses an svg icon');
  assert.strictEqual(closeButton.children[0].tagName, 'SVG', 'close button uses an svg icon');
  assert.strictEqual(closeButton.children[0].children[0].getAttribute('d').startsWith('M19 6.41'), true, 'close icon path rendered');

  launcherHarness.state.sent.length = 0;
  playButton.dispatch('click');
  await delay(10);

  const runMessage = launcherHarness.state.sent.find(message => message.type === 'RUN_LAST_TASK');
  eq(runMessage, { type: 'RUN_LAST_TASK', taskId: 'last' }, 'play button runs the displayed task');
  assert.strictEqual(playButton.disabled, false, 'play button re-enabled after run');

  launcherHarness.state.sent.length = 0;
  reloadButton.dispatch('click');
  await delay(10);
  eq(launcherHarness.state.sent[0], { type: 'RELOAD_TAB' }, 'reload button reloads the tab');

  closeButton.dispatch('click');
  assert.strictEqual(launcherHarness.overlay(), null, 'close button hides the whole panel');
  assert.ok(Number(launcherHarness.sessionStore['maclick-launcher-dismissed-at']) > 0, 'dismissal time stored');

  launcherHarness.emitTaskStorageChange();
  await delay(10);
  assert.strictEqual(launcherHarness.overlay(), null, 'panel stays hidden without new activity');

  launcherHarness.setLauncher({ id: 'last', name: 'Login', lastActiveAt: Date.now() + 5000 });
  launcherHarness.emitTaskStorageChange();
  await delay(10);
  assert.ok(launcherHarness.overlay(), 'panel returns after new task activity');

  launcherHarness.setLauncher(null);
  launcherHarness.emitTaskStorageChange();
  await delay(10);
  assert.strictEqual(launcherHarness.overlay(), null, 'panel hides when task disappears');

  const recordLaunchHarness = createHarness({
    launcher: { task: { id: 'last', name: 'Login', lastActiveAt: Date.now() } }
  });
  await delay(10);
  assert.ok(recordLaunchHarness.overlay(), 'launcher visible before recording');

  await recordLaunchHarness.onMessage({ type: 'START_RECORDING' });
  launcherPanel = recordLaunchHarness.overlay();
  launcherBody = launcherPanel.shadowRoot.children[1];
  assert.strictEqual(launcherBody.children[0].hidden, false, 'recording indicator shown while recording');
  assert.strictEqual(launcherBody.children[1].hidden, true, 'actions hidden while recording');

  await recordLaunchHarness.onMessage({ type: 'STOP_RECORDING' });
  assert.strictEqual(launcherBody.children[0].hidden, true, 'recording indicator hidden after stop');
  assert.strictEqual(launcherBody.children[1].hidden, false, 'actions restored after stop');

  const sharedSession = {};
  const firstVisit = createHarness({
    launcher: { task: { id: 'last', name: 'Login', lastActiveAt: 1000 } },
    sessionStore: sharedSession
  });
  await delay(10);
  firstVisit.overlay().shadowRoot.children[1].children[1].children[2].dispatch('click');

  const secondVisit = createHarness({
    launcher: { task: { id: 'last', name: 'Login', lastActiveAt: 1000 } },
    sessionStore: sharedSession
  });
  await delay(10);
  assert.strictEqual(secondVisit.overlay(), null, 'dismissal survives page reload');

  console.log('content script tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
