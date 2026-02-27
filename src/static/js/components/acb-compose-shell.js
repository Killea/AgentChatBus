(function registerAcbComposeShell() {
  class AcbComposeShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="compose">
          <input id="compose-author" type="text" value="human" placeholder="author" />
          <textarea id="compose-input" rows="1" placeholder="Send a system message... (Enter to send, Shift+Enter for newline)"
            oninput="autoResize(this)" onkeydown="handleKey(event)"></textarea>
          <button id="btn-send" onclick="sendMessage()" title="Send">➤</button>
        </div>`;
    }
  }

  if (!customElements.get('acb-compose-shell')) {
    customElements.define('acb-compose-shell', AcbComposeShell);
  }
})();
