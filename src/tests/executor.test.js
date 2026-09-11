const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const errors = [];
const logs = [];
const clicks = [];
const events = [];
const focuses = [];
const blurs = [];

const elements = {};
function makeElement(name) { return { click() { clicks.push(name); } }; }
elements['#a'] = makeElement('#a');
elements['#submit'] = makeElement('#submit');

const inputPrototype = {};
Object.defineProperty(inputPrototype, 'value', {
  set(value) { this._value = value; },
  get() { return this._value; }
});

const textareaPrototype = {};
Object.defineProperty(textareaPrototype, 'value', {
  set(value) { this._value = value; this._viaTextarea = true; },
  get() { return this._value; }
});

function makeTextField(selector, tagName = 'INPUT') {
  const element = Object.create(tagName === 'TEXTAREA' ? textareaPrototype : inputPrototype);
  element.tagName = tagName;
  element.focus = () => focuses.push(selector);
  element.blur = () => blurs.push(selector);
  element.dispatchEvent = event => events.push({ selector, type: event.type, bubbles: event.bubbles });
  return element;
}

elements['#name'] = makeTextField('#name');
elements['#bio'] = makeTextField('#bio', 'TEXTAREA');

let readyState = 'complete';

const sandbox = {
  document: {
    querySelector: sel => elements[sel] || null,
    get readyState() { return readyState; }
  },
  HTMLInputElement: { prototype: inputPrototype },
  HTMLTextAreaElement: { prototype: textareaPrototype },
  Event: class {
    constructor(type, options) {
      this.type = type;
      this.bubbles = !!(options && options.bubbles);
    }
  },
  console: { log: message => logs.push(message), error: message => errors.push(message), warn: () => {} },
  setTimeout,
  clearTimeout
};

const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'executor.js'), 'utf8'), context);

assert.strictEqual(typeof context.executeTask, 'function', 'executor.js publishes executeTask');
const executeTask = context.executeTask;

(async () => {
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'click', selector: '#a' }, { type: 'wait_timeout', ms: 10 }] });
  assert.deepStrictEqual(clicks, ['#a'], 'click executed');
  assert.strictEqual(errors.length, 0, 'no errors');

  errors.length = 0;
  clicks.length = 0;
  await executeTask({ defaultTimeout: 50, steps: [{ type: 'click', selector: '#missing' }, { type: 'click', selector: '#a' }] });
  assert.deepStrictEqual(clicks, [], 'chain stops on missing element');
  assert.strictEqual(errors.length, 1, 'one error reported');
  assert.ok(errors[0].includes('Step 1 failed'), errors[0]);

  errors.length = 0;
  clicks.length = 0;
  setTimeout(() => { elements['#b'] = makeElement('#b'); }, 150);
  await executeTask({ defaultTimeout: 2000, steps: [{ type: 'wait_element', selector: '#b' }] });
  assert.deepStrictEqual(clicks, ['#b'], 'wait_element waits then clicks');
  assert.strictEqual(errors.length, 0, 'no errors on wait_element');

  errors.length = 0;
  events.length = 0;
  focuses.length = 0;
  blurs.length = 0;
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'input_text', selector: '#name', value: 'Alice' }] });
  assert.strictEqual(elements['#name'].value, 'Alice', 'input value set');
  assert.deepStrictEqual(focuses, ['#name'], 'input focused');
  assert.deepStrictEqual(blurs, ['#name'], 'input blurred');
  assert.deepStrictEqual(events, [
    { selector: '#name', type: 'input', bubbles: true },
    { selector: '#name', type: 'change', bubbles: true }
  ], 'input and change dispatched');
  assert.strictEqual(errors.length, 0, 'no errors on input_text');

  events.length = 0;
  focuses.length = 0;
  blurs.length = 0;
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'input_text', selector: '#bio', value: 'Hello' }] });
  assert.strictEqual(elements['#bio'].value, 'Hello', 'textarea value set');
  assert.strictEqual(elements['#bio']._viaTextarea, true, 'textarea setter used');

  events.length = 0;
  elements['#name'].value = 'old';
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'input_text', selector: '#name', value: '' }] });
  assert.strictEqual(elements['#name'].value, '', 'empty value clears the field');

  errors.length = 0;
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'input_text', selector: '#name', value: 42 }] });
  assert.strictEqual(elements['#name'].value, '42', 'non-string value is stringified');

  errors.length = 0;
  events.length = 0;
  await executeTask({ defaultTimeout: 30, steps: [{ type: 'input_text', selector: '#missing', value: 'x' }] });
  assert.strictEqual(errors.length, 1, 'missing input reports error');
  assert.ok(errors[0].includes('Element not found'), errors[0]);

  errors.length = 0;
  clicks.length = 0;
  readyState = 'loading';
  setTimeout(() => { readyState = 'complete'; }, 150);
  await executeTask({ defaultTimeout: 2000, steps: [{ type: 'wait_page_load' }] });
  assert.strictEqual(errors.length, 0, 'wait_page_load completes');
  assert.strictEqual(logs[logs.length - 1], 'Task completed', 'task completion logged');

  errors.length = 0;
  clicks.length = 0;
  readyState = 'loading';
  setTimeout(() => { readyState = 'complete'; }, 500);
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'wait_page_load' }] });
  assert.strictEqual(errors.length, 0, 'wait_page_load ignores task default timeout');
  readyState = 'complete';

  errors.length = 0;
  clicks.length = 0;
  readyState = 'loading';
  const slowLoad = setTimeout(() => { readyState = 'complete'; }, 500);
  await executeTask({ defaultTimeout: 30000, steps: [{ type: 'wait_page_load', timeout: 50 }] });
  assert.strictEqual(errors.length, 1, 'explicit page load timeout aborts');
  assert.ok(errors[0].includes('Page load timeout'), errors[0]);
  clearTimeout(slowLoad);
  readyState = 'complete';

  errors.length = 0;
  clicks.length = 0;
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'unknown_type' }, { type: 'click', selector: '#a' }] });
  assert.deepStrictEqual(clicks, [], 'chain stops on unknown step type');
  assert.ok(errors[0].includes('Unknown step type'), errors[0]);

  errors.length = 0;
  clicks.length = 0;
  const started = Date.now();
  await executeTask({ defaultTimeout: 30, steps: [{ type: 'click', selector: '#missing' }] });
  assert.ok(Date.now() - started < 300, 'task defaultTimeout limits the wait');
  assert.strictEqual(errors.length, 1, 'timeout error reported');

  errors.length = 0;
  clicks.length = 0;
  const zeroStart = Date.now();
  await executeTask({ defaultTimeout: 300, steps: [{ type: 'wait_timeout', ms: 0 }] });
  assert.ok(Date.now() - zeroStart < 700, 'wait_timeout ms:0 does not fall back to 1000');
  assert.strictEqual(errors.length, 0, 'wait_timeout ms:0 completes');

  console.log('executor tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
