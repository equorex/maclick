const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function createElement(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { (listeners[type] || []).forEach(fn => fn({ preventDefault() {} })); },
    querySelector() { return null; },
    remove() {},
    set textContent(value) { el._text = value; el.children.length = 0; },
    get textContent() { return el._text; }
  };
  return el;
}

const elements = {
  editStepsList: createElement('div'),
  'step-type-select': createElement('select'),
  'task-timeout': createElement('input')
};
const document = {
  addEventListener() {},
  getElementById(id) { return elements[id] || null; },
  createElement
};

const browser = {
  storage: {
    local: {
      async get() { return {}; },
      async set() {}
    }
  }
};

const jsDir = path.join(__dirname, '..', 'js');
const context = vm.createContext({ document, console, browser, setTimeout, clearTimeout });

vm.runInContext(fs.readFileSync(path.join(jsDir, 'storage.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(jsDir, 'executor.js'), 'utf8'), context);

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8') +
  '\nglobalThis.__t = { renderSteps, moveStep, removeStepAt, addStep, get steps() { return editingSteps; }, set steps(v) { editingSteps = v; } };';
vm.runInContext(source, context);

assert.strictEqual(context.TASK_DEFAULT_TIMEOUT, 300, 'popup sees TASK_DEFAULT_TIMEOUT from storage.js');
assert.ok(context.taskStorage, 'popup sees taskStorage from storage.js');
assert.strictEqual(typeof context.executeTask, 'function', 'popup sees executeTask from executor.js');
assert.strictEqual(context.PAGE_LOAD_DEFAULT_TIMEOUT, 30000, 'popup sees PAGE_LOAD_DEFAULT_TIMEOUT from executor.js');

const t = context.__t;

const clickRow = (row, inputValue) => {
  const input = row.children[4];
  if (inputValue !== undefined) input.value = inputValue;
  input.dispatch('input');
};

t.steps = [
  { type: 'click', selector: '#a' },
  { type: 'wait_timeout', ms: 500 },
  { type: 'wait_element', selector: '#c', timeout: 300 }
];
t.renderSteps();

let container = elements.editStepsList;
assert.strictEqual(container.children.length, 3, 'three rows rendered');
assert.strictEqual(container.children[0].children[4].value, '#a', 'selector in input');
assert.strictEqual(container.children[1].children[4].value, 500, 'ms in input');
assert.strictEqual(container.children[2].children[4].value, '#c', 'selector in last row');
assert.strictEqual(container.children[0].children[1].disabled, true, 'up disabled on first row');
assert.strictEqual(container.children[0].children[2].disabled, false, 'down enabled on first row');
assert.strictEqual(container.children[2].children[2].disabled, true, 'down disabled on last row');

clickRow(container.children[0], '#changed');
assert.strictEqual(t.steps[0].selector, '#changed', 'editing selector updates model');

t.moveStep(0, 1);
assert.strictEqual(t.steps[0].type, 'wait_timeout', 'move down swaps steps');
assert.strictEqual(t.steps[1].selector, '#changed', 'moved step keeps edits');
assert.strictEqual(container.children[0].children[0].textContent, '1.', 'renumbered after move');

t.moveStep(2, -1);
assert.strictEqual(t.steps[1].type, 'wait_element', 'move up swaps steps');

t.removeStepAt(1);
assert.strictEqual(t.steps.length, 2, 'step removed');
assert.strictEqual(t.steps[0].type, 'wait_timeout', 'remaining order preserved');

elements['step-type-select'].value = 'wait_timeout';
t.addStep();
assert.strictEqual(t.steps.length, 3);
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[2])), { type: 'wait_timeout', ms: 1000 }, 'add wait step');

elements['step-type-select'].value = 'click';
t.addStep();
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[3])), { type: 'click', selector: '' }, 'add click step');

elements['step-type-select'].value = 'wait_element';
t.addStep();
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[4])), { type: 'wait_element', selector: '', timeout: 300 }, 'add wait_element step');

assert.strictEqual(container.children.length, 5, 'rows re-rendered after add');
assert.strictEqual(container.children[4].children[5].value, 300, 'new timeout input bound');
clickRow(container.children[3], 'div#x');
assert.strictEqual(t.steps[3].selector, 'div#x', 'new click step editable');

assert.strictEqual(t.steps[2].type, 'wait_timeout', 'wait step at expected position');
container.children[2].children[4].value = 2000;
container.children[2].children[4].dispatch('input');
assert.strictEqual(t.steps[2].ms, 2000, 'editing ms updates model');

t.steps = [];
elements['task-timeout'].value = 700;

elements['step-type-select'].value = 'wait_page_load';
t.addStep();
elements['step-type-select'].value = 'wait_element';
t.addStep();
t.renderSteps();
container = elements.editStepsList;

  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'wait_page_load', timeout: 30000 }, 'add wait_page_load with page load default timeout');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[1])), { type: 'wait_element', selector: '', timeout: 700 }, 'add wait_element with task default timeout');

  assert.strictEqual(container.children[0].children[4].value, 30000, 'wait_page_load timeout bound');
assert.strictEqual(container.children[1].children[4].value, '', 'wait_element selector bound');
assert.strictEqual(container.children[1].children[5].value, 700, 'wait_element timeout bound');

container.children[0].children[4].value = 1500;
container.children[0].children[4].dispatch('input');
assert.strictEqual(t.steps[0].timeout, 1500, 'editing timeout updates model');

container.children[1].children[4].value = '#submit';
container.children[1].children[4].dispatch('input');
assert.strictEqual(t.steps[1].selector, '#submit', 'editing wait_element selector updates model');

container.children[1].children[5].value = '';
container.children[1].children[5].dispatch('input');
assert.strictEqual(t.steps[1].timeout, 0, 'empty timeout falls back to task default');

  elements['task-timeout'].value = 'abc';
  elements['step-type-select'].value = 'wait_element';
  t.addStep();
  assert.strictEqual(t.steps[t.steps.length - 1].timeout, 300, 'invalid task timeout falls back to constant');

t.steps = [{ type: 'input_text', selector: '#name', value: 'Alice' }];
t.renderSteps();
container = elements.editStepsList;

assert.strictEqual(container.children.length, 1, 'input_text row rendered');
assert.strictEqual(container.children[0].children[3].textContent, 'Input text:', 'input_text label');
assert.strictEqual(container.children[0].children[4].value, '#name', 'input_text selector bound');
assert.strictEqual(container.children[0].children[5].value, 'Alice', 'input_text value bound');

container.children[0].children[4].value = '#login';
container.children[0].children[4].dispatch('input');
container.children[0].children[5].value = 'Bob';
container.children[0].children[5].dispatch('input');
assert.strictEqual(t.steps[0].selector, '#login', 'editing input_text selector updates model');
assert.strictEqual(t.steps[0].value, 'Bob', 'editing input_text value updates model');

elements['step-type-select'].value = 'input_text';
t.addStep();
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[1])), { type: 'input_text', selector: '', value: '' }, 'add input_text step');

console.log('popup steps tests passed');
