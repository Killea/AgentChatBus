const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChatPanelHtml,
  buildRecoveredChatPanelHtml,
  getChatPanelWebviewOptions,
  getRecoveredChatPanelWebviewOptions,
} = require('../out/views/chatPanelHtml');

test('chat panel webview options retain context and allow scripts', () => {
  const root = { path: '/extension-root' };
  const options = getChatPanelWebviewOptions(root);

  assert.equal(options.enableScripts, true);
  assert.equal(options.retainContextWhenHidden, true);
  assert.deepEqual(options.localResourceRoots, [root]);
});

test('recovered chat panel disables scripts', () => {
  const root = { path: '/extension-root' };
  const options = getRecoveredChatPanelWebviewOptions(root);

  assert.equal(options.enableScripts, false);
  assert.deepEqual(options.localResourceRoots, [root]);
});

test('chat panel html keeps mermaid support without CSP worker breakage', () => {
  const html = buildChatPanelHtml(
    {
      rendererScriptUri: 'vscode-resource:/renderer.js',
      rendererStyleUri: 'vscode-resource:/renderer.css',
      panelScriptUri: 'vscode-resource:/panel.js',
      panelStyleUri: 'vscode-resource:/panel.css',
    },
    {
      threadId: 'thread-1',
      threadTopic: 'Topic <unsafe>',
      threadStatus: 'discuss',
      baseUrl: 'http://127.0.0.1:39765',
      mermaidScriptUrl: 'vscode-resource:/mermaid.min.js',
      theme: 'light',
    }
  );

  assert.match(html, /data-mermaid-script-url="vscode-resource:\/mermaid\.min\.js"/);
  assert.match(html, /<script src="vscode-resource:\/renderer\.js"><\/script>/);
  assert.match(html, /<script src="vscode-resource:\/panel\.js"><\/script>/);
  assert.match(html, /<input id="search-input" type="search" placeholder="Search this thread" spellcheck="false" \/>/);
  assert.match(html, /<div id="search-counter">0 \/ 0<\/div>/);
  assert.match(html, /title="Previous match" aria-label="Previous match">⬆️<\/button>/);
  assert.match(html, /title="Next match" aria-label="Next match">⬇️<\/button>/);
  assert.match(html, /data-thread-topic="Topic &lt;unsafe&gt;"/);
  assert.match(html, /data-tooltip="Edit the human display name used for new messages"/);
  assert.match(html, /data-tooltip="Mention an agent in this thread" aria-label="Mention an agent in this thread">@<\/button>/);
  assert.match(html, /data-tooltip="Upload an image from file" aria-label="Upload an image from file">Image<\/button>/);
  assert.ok(!html.includes('Content-Security-Policy'));
  assert.ok(!html.includes("default-src 'none'"));
});

test('recovered chat panel html shows reload guidance', () => {
  const html = buildRecoveredChatPanelHtml();

  assert.match(html, /Chat session needs reload/);
  assert.match(html, /Please open the thread again from the Threads panel\./);
});