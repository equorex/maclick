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
    dataset: {},
    attributes: {},
    classList: createClassList(),
    appendChild(child) { el.children.push(child); return child; },
    setAttribute(name, value) { el.attributes[name] = value; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach(fn => fn(event || { preventDefault() {} })); },
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
  createElement,
  createElementNS(ns, tag) { return createElement(tag); }
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
  '\nglobalThis.__t = { renderSteps, reorderSteps, removeStepAt, addStep, changeStepType, normalizeStep, editor: editorRefs, get steps() { return editingSteps; }, set steps(v) { editingSteps = v; } };';
vm.runInContext(source, context);

assert.strictEqual(context.TASK_DEFAULT_TIMEOUT, 300, 'popup sees TASK_DEFAULT_TIMEOUT from storage.js');
assert.ok(context.taskStorage, 'popup sees taskStorage from storage.js');
assert.strictEqual(typeof context.executeTask, 'function', 'popup sees executeTask from executor.js');
assert.strictEqual(context.PAGE_LOAD_DEFAULT_TIMEOUT, 30000, 'popup sees PAGE_LOAD_DEFAULT_TIMEOUT from executor.js');

const t = context.__t;
t.editor.steps = elements.editStepsList;
t.editor.timeout = elements['task-timeout'];
t.editor.typeSelect = elements['step-type-select'];

const selectorOf = row => row.children[3];
const typeSelectOf = row => row.children[2];
const numberTextOf = row => row.children[1].textContent;

const dragEvent = () => ({ preventDefault() {}, dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' } });

t.steps = [
  { type: 'click', selector: '#a' },
  { type: 'wait_timeout', ms: 500 },
  { type: 'wait_element', selector: '#c', timeout: 300 }
];
t.renderSteps();

let container = elements.editStepsList;
assert.strictEqual(container.children.length, 3, 'three rows rendered');
assert.strictEqual(container.children[0].children[0].className, 'drag-handle', 'drag handle rendered');
assert.strictEqual(container.children[0].children[0].children[0].tagName, 'SVG', 'drag handle has icon');
assert.strictEqual(container.children[0].draggable, true, 'step row is draggable');
assert.strictEqual(container.children[0].dataset.index, '0', 'step row index stored');
assert.strictEqual(typeSelectOf(container.children[0]).className, 'step-type', 'type select rendered');
assert.strictEqual(typeSelectOf(container.children[0]).value, 'click', 'type select reflects click');
assert.strictEqual(typeSelectOf(container.children[2]).value, 'wait_element', 'type select reflects wait_element');
assert.strictEqual(selectorOf(container.children[0]).value, '#a', 'selector in input');
assert.strictEqual(selectorOf(container.children[1]).value, 500, 'ms in input');
assert.strictEqual(selectorOf(container.children[2]).value, '#c', 'selector in last row');
assert.strictEqual(container.children[0].children.length, 5, 'click row: handle, number, select, selector, remove');
assert.strictEqual(container.children[2].children.length, 6, 'wait_element row has timeout input');

selectorOf(container.children[0]).value = '#changed';
selectorOf(container.children[0]).dispatch('input');
assert.strictEqual(t.steps[0].selector, '#changed', 'editing selector updates model');

container.children[0].dispatch('dragstart', dragEvent());
container.children[2].dispatch('drop', dragEvent());

assert.strictEqual(t.steps[0].type, 'wait_timeout', 'drag drops clicked step to the end');
assert.strictEqual(t.steps[1].selector, '#c', 'other steps keep their edits');
assert.strictEqual(t.steps[2].type, 'click', 'dragged step now last');
assert.strictEqual(t.steps[2].selector, '#changed', 'moved step keeps edits');
assert.strictEqual(numberTextOf(elements.editStepsList.children[0]), '1.', 'renumbered after drag');

t.steps = [
  { type: 'click', selector: 'a' },
  { type: 'click', selector: 'b' },
  { type: 'click', selector: 'c' }
];
t.renderSteps();
t.reorderSteps(2, 0);
assert.deepStrictEqual(t.steps.map(step => step.selector), ['c', 'a', 'b'], 'reorder moves step to front');
t.reorderSteps(0, 1);
assert.deepStrictEqual(t.steps.map(step => step.selector), ['a', 'c', 'b'], 'reorder moves step forward');
t.reorderSteps(0, 0);
t.reorderSteps(-1, 0);
t.reorderSteps(0, 99);
assert.deepStrictEqual(t.steps.map(step => step.selector), ['a', 'c', 'b'], 'out of range reorder is ignored');

t.steps = [
  { type: 'click', selector: 'a' },
  { type: 'click', selector: 'b' },
  { type: 'click', selector: 'c' }
];
t.renderSteps();
const guardRows = elements.editStepsList.children;
guardRows[0].dispatch('dragstart', {
  preventDefault() {},
  target: { tagName: 'INPUT' },
  dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' }
});
guardRows[2].dispatch('drop', dragEvent());
assert.deepStrictEqual(t.steps.map(step => step.selector), ['a', 'b', 'c'], 'drag starting from a field is ignored');

t.steps = [
  { type: 'click', selector: 'a' },
  { type: 'click', selector: 'c' },
  { type: 'click', selector: 'b' }
];
t.renderSteps();
t.removeStepAt(1);
assert.deepStrictEqual(t.steps.map(step => step.selector), ['a', 'b'], 'step removed');

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

container = elements.editStepsList;
assert.strictEqual(container.children.length, 5, 'rows re-rendered after add');
assert.strictEqual(container.children[4].children[4].value, 300, 'new timeout input bound');

elements['task-timeout'].value = 700;
t.steps = [];
elements['step-type-select'].value = 'wait_page_load';
t.addStep();
elements['step-type-select'].value = 'wait_element';
t.addStep();
t.renderSteps();
container = elements.editStepsList;

assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'wait_page_load', timeout: 30000 }, 'add wait_page_load with page load default timeout');
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[1])), { type: 'wait_element', selector: '', timeout: 700 }, 'add wait_element with task default timeout');
assert.strictEqual(container.children[0].children[3].value, 30000, 'wait_page_load timeout bound');
assert.strictEqual(container.children[1].children[3].value, '', 'wait_element selector bound');
assert.strictEqual(container.children[1].children[4].value, 700, 'wait_element timeout bound');

container.children[0].children[3].value = 1500;
container.children[0].children[3].dispatch('input');
assert.strictEqual(t.steps[0].timeout, 1500, 'editing timeout updates model');

container.children[1].children[3].value = '#submit';
container.children[1].children[3].dispatch('input');
assert.strictEqual(t.steps[1].selector, '#submit', 'editing wait_element selector updates model');

elements['task-timeout'].value = 'abc';
elements['step-type-select'].value = 'wait_element';
t.addStep();
assert.strictEqual(t.steps[t.steps.length - 1].timeout, 300, 'invalid task timeout falls back to constant');

t.steps = [{ type: 'input_text', selector: '#name', value: 'Alice' }];
t.renderSteps();
container = elements.editStepsList;

assert.strictEqual(container.children.length, 1, 'input_text row rendered');
assert.strictEqual(typeSelectOf(container.children[0]).value, 'input_text', 'input_text type selected');
assert.strictEqual(container.children[0].children[3].value, '#name', 'input_text selector bound');
assert.strictEqual(container.children[0].children[4].value, 'Alice', 'input_text value bound');

container.children[0].children[3].value = '#login';
container.children[0].children[3].dispatch('input');
container.children[0].children[4].value = 'Bob';
container.children[0].children[4].dispatch('input');
assert.strictEqual(t.steps[0].selector, '#login', 'editing input_text selector updates model');
assert.strictEqual(t.steps[0].value, 'Bob', 'editing input_text value updates model');

elements['step-type-select'].value = 'input_text';
t.addStep();
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[1])), { type: 'input_text', selector: '', value: '' }, 'add input_text step');

t.steps = [{ type: 'click', selector: '#x' }];
t.renderSteps();
t.changeStepType(0, 'wait_element');
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'wait_element', selector: '#x', timeout: 300 }, 'change click to wait_element keeps selector');
assert.strictEqual(elements.editStepsList.children[0].children[4].value, 300, 'wait_element shows timeout field after change');

t.steps = [{ type: 'input_text', selector: '#name', value: 'Alice' }];
t.renderSteps();
t.changeStepType(0, 'click');
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'click', selector: '#name' }, 'change input_text to click keeps selector and drops value');

t.steps = [{ type: 'click', selector: '#a' }];
t.renderSteps();
t.changeStepType(0, 'wait_timeout');
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'wait_timeout', ms: 1000 }, 'change click to timeout');

t.changeStepType(0, 'wait_page_load');
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'wait_page_load', timeout: 30000 }, 'change timeout to wait_page_load');

t.changeStepType(0, 'click');
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'click', selector: '' }, 'change back to click resets fields');

t.changeStepType(0, 'click');
assert.deepStrictEqual(JSON.parse(JSON.stringify(t.steps[0])), { type: 'click', selector: '' }, 'same type change is a no-op');

t.steps = [{ type: 'click', selector: '#z' }];
t.renderSteps();
const rowSelect = elements.editStepsList.children[0].children[2];
rowSelect.value = 'input_text';
rowSelect.dispatch('change');
assert.strictEqual(t.steps[0].type, 'input_text', 'select change updates step type');

console.log('popup steps tests passed');
