const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readChatPanelCss() {
  const cssPath = path.join(
    __dirname,
    '..',
    'resources',
    'web-ui',
    'extension',
    'media',
    'chatPanel.css'
  );
  return fs.readFileSync(cssPath, 'utf8');
}

function readPxValue(css, selector, property) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedProp = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `${escapedSelector}\\s*\\{[^}]*${escapedProp}:\\s*(\\d+)px;`,
    's'
  );
  const match = css.match(regex);
  assert.ok(match, `Missing "${property}" for selector "${selector}"`);
  return Number(match[1]);
}

test('nav sidebar width delta matches scrollbar width budget', () => {
  const css = readChatPanelCss();
  const baseWidth = readPxValue(css, '#nav-sidebar', 'width');
  const scrollWidth = readPxValue(css, '#nav-sidebar.has-scrollbar', 'width');
  const scrollbarWidth = readPxValue(css, '#nav-sidebar::-webkit-scrollbar', 'width');

  assert.equal(
    scrollWidth - baseWidth,
    scrollbarWidth,
    'has-scrollbar width should expand by scrollbar width'
  );
});

test('nav entry spacing preserves readable timestamp pills', () => {
  const css = readChatPanelCss();

  assert.match(
    css,
    /\.nav-entry\s*\{[^}]*padding:\s*4px 6px;[^}]*width:\s*100%;/s,
    'nav entries should keep horizontal padding and full-width pill layout'
  );
  assert.match(
    css,
    /\.nav-entry-time\s*\{[^}]*flex:\s*1 1 auto;/s,
    'timestamp text should remain flexible instead of collapsing too early'
  );
});
