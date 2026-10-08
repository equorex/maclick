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
        contains: name => names.includes(name)
      };
    },
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
  const state = { sent: [], recording: !!options.recording };

  const documentElement = createElement('html');
  const document = {
    nodeType: 9,
    documentElement,
    children: [documentElement],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    createElement,
    querySelectorAll(selector) { return queryAll(document, selector); }
  };
  documentElement.parentNode = document;

  const browser = {
    runtime: {
      async sendMessage(message) {
        state.sent.push(message);
        if (message.type === 'GET_RECORDING_STATE') return { recording: state.recording };
        return { status: 'ok' };
      },
      onMessage: { addListener(fn) { messageListeners.push(fn); } }
    }
  };

  const context = vm.createContext({
    document,
    browser,
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
    document,
    docListeners,
    onMessage: messageListeners[0],
    overlay() {
      return document.documentElement.children.find(el => el.id === 'maclick-recording-overlay') || null;
    },
    overlayCount() {
      return document.documentElement.children.filter(el => el.id === 'maclick-recording-overlay').length;
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

  const stopButton = harness.overlay().shadowRoot.children[1].children[3];
  assert.strictEqual(stopButton.textContent, '⏹ Stop', 'stop button rendered');

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

  console.log('content script tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
