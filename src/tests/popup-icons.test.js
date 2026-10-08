const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function createElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    attributes: {},
    appendChild(child) { el.children.push(child); return child; },
    setAttribute(name, value) { el.attributes[name] = value; },
    getAttribute(name) { return el.attributes[name]; }
  };
  return el;
}

const document = {
  addEventListener() {},
  getElementById() { return null; },
  createElement,
  createElementNS(ns, tag) { return createElement(tag); }
};

const context = vm.createContext({
  document,
  console,
  browser: {},
  setTimeout() { return 0; },
  clearTimeout() {}
});

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8') +
  '\nglobalThis.__t = { createIcon, icons: ICON_PATHS };';
vm.runInContext(source, context);

const { createIcon, icons } = context.__t;

assert.strictEqual(typeof createIcon, 'function', 'createIcon exposed');

const svg = createIcon('play');
assert.strictEqual(svg.tagName, 'SVG', 'icon is an svg element');
assert.strictEqual(svg.getAttribute('viewBox'), '0 0 24 24', 'viewBox is set');
assert.strictEqual(svg.getAttribute('width'), '16', 'width is set');
assert.strictEqual(svg.getAttribute('height'), '16', 'height is set');
assert.strictEqual(svg.getAttribute('aria-hidden'), 'true', 'icon hidden from a11y tree');
assert.strictEqual(svg.getAttribute('focusable'), 'false', 'icon not focusable');
assert.strictEqual(svg.children.length, 1, 'icon has a single path child');
assert.strictEqual(svg.children[0].tagName, 'PATH', 'child is a path');
assert.strictEqual(svg.children[0].getAttribute('fill'), 'currentColor', 'path follows currentColor');
assert.strictEqual(svg.children[0].getAttribute('d'), icons.play, 'path data matches the source');

for (const name of ['play', 'edit', 'trash', 'arrowUp', 'arrowDown', 'close']) {
  assert.strictEqual(createIcon(name).children[0].getAttribute('d'), icons[name], `${name} icon path matches`);
}

assert.strictEqual(createIcon('missing').children[0].getAttribute('d'), undefined, 'unknown icon yields empty path');

console.log('popup icons tests passed');
