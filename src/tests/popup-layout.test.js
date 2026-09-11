const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));
const POPUP_WIDTH = 500;

const escapeSelector = selector => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ruleBody = selector => {
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escapeSelector(selector)}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `rule ${selector} found in popup.html`);
  return match[1];
};

const assertContains = (selector, declaration) => {
  assert.ok(ruleBody(selector).includes(declaration), `${selector} contains "${declaration}"`);
};

assertContains('*', 'box-sizing: border-box');
assertContains('body', `width: ${POPUP_WIDTH}px`);
assertContains('body', 'overflow-x: hidden');
assert.ok(/html,\s*body\s*\{\s*margin:\s*0\s*;?\s*\}/.test(css), 'default body margin removed');

for (const selector of ['.status-message', '.task-card']) {
  assertContains(selector, 'overflow-wrap: anywhere');
}

for (const selector of ['.button-row', '.step-add-row', '.task-actions']) {
  assertContains(selector, 'flex-wrap: wrap');
}

assertContains('.field-input', 'resize: vertical');
assertContains('.step-type-select', 'min-width: 0');
assertContains('button', 'cursor: pointer');
assertContains('button:disabled', 'cursor: default');

const fixedWidths = [...css.matchAll(/(?:^|[;{\s])width:\s*(\d+)px/g)].map(match => Number(match[1]));
assert.ok(fixedWidths.length > 0, 'fixed widths found in popup.html');
assert.ok(fixedWidths.every(width => width <= POPUP_WIDTH), 'no fixed width exceeds popup width');

console.log('popup layout tests passed');
