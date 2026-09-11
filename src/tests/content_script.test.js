const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const eq = (actual, expected, msg) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createElement(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    id: '',
    className: '',
    type: '',
    style: { cssText: '' },
    parentNode: null,
    attachShadow() {
      el.shadowRoot = createElement('#shadow-root');
      return el.shadowRoot;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach(fn => fn(event)); },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
      child.parentNode = null;
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

  const document = {
    documentElement: createElement('html'),
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    createElement
  };

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
    Node: { ELEMENT_NODE: 1 },
    CSS: { escape: value => value },
    setTimeout,
    clearTimeout
  });

  vm.runInContext(contentSource, context);

  return {
    state,
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
  target.nodeType = 1;
  target.parentElement = null;

  harness.docListeners.click[0]({ target, composedPath: () => [target] });
  assert.strictEqual(harness.state.sent.length, 1, 'page click is recorded');
  eq(harness.state.sent[0], { type: 'RECORDED_STEP', step: { type: 'click', selector: 'button#submit' } }, 'recorded step selector');

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
  textInput.nodeType = 1;
  textInput.parentElement = null;
  textInput.type = 'text';
  textInput.value = 'Alice';

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: textInput, composedPath: () => [textInput] });
  assert.strictEqual(inputHarness.state.sent.length, 1, 'text input change recorded');
  eq(inputHarness.state.sent[0], {
    type: 'RECORDED_STEP',
    step: { type: 'input_text', selector: 'input#name', value: 'Alice' }
  }, 'text input step payload');

  const passwordInput = createElement('input');
  passwordInput.id = 'pwd';
  passwordInput.nodeType = 1;
  passwordInput.parentElement = null;
  passwordInput.type = 'password';
  passwordInput.value = 'secret';

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: passwordInput, composedPath: () => [passwordInput] });
  assert.strictEqual(inputHarness.state.sent.length, 0, 'password change not recorded');

  const bio = createElement('textarea');
  bio.id = 'bio';
  bio.nodeType = 1;
  bio.parentElement = null;
  bio.value = 'hello';

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: bio, composedPath: () => [bio] });
  eq(inputHarness.state.sent[0], {
    type: 'RECORDED_STEP',
    step: { type: 'input_text', selector: 'textarea#bio', value: 'hello' }
  }, 'textarea change recorded');

  const checkbox = createElement('input');
  checkbox.id = 'agree';
  checkbox.nodeType = 1;
  checkbox.parentElement = null;
  checkbox.type = 'checkbox';
  checkbox.value = 'on';

  const select = createElement('select');
  select.id = 'city';
  select.nodeType = 1;
  select.parentElement = null;
  select.value = 'msk';

  inputHarness.state.sent.length = 0;
  inputHarness.docListeners.change[0]({ target: checkbox, composedPath: () => [checkbox] });
  inputHarness.docListeners.change[0]({ target: select, composedPath: () => [select] });
  assert.strictEqual(inputHarness.state.sent.length, 0, 'non-text fields not recorded');

  inputHarness.state.sent.length = 0;
  textInput.value = '';
  inputHarness.docListeners.change[0]({ target: textInput, composedPath: () => [textInput] });
  eq(inputHarness.state.sent[0], {
    type: 'RECORDED_STEP',
    step: { type: 'input_text', selector: 'input#name', value: '' }
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
  orderInput.nodeType = 1;
  orderInput.parentElement = null;
  orderInput.type = 'text';
  orderInput.value = 'x';

  orderHarness.docListeners.change[0]({ target: orderInput, composedPath: () => [orderInput] });
  orderHarness.docListeners.click[0]({ target: orderInput, composedPath: () => [orderInput] });
  eq(orderHarness.state.sent.map(message => message.step.type), ['input_text', 'click'], 'input recorded before click');

  console.log('content script tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
