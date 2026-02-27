(function registerAcbComposeShell() {
  class AcbComposeShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="compose">
          <input id="compose-author" type="text" value="human" placeholder="author" />
          <div id="mentions-bar" style="display:none; padding: 5px; font-size: 0.85em; background: rgba(0,0,0,0.1); border-radius: 4px; margin-bottom: 5px;">
            <span id="mentioned-agents"></span>
            <button type="button" onclick="clearMentions()" style="margin-left: 10px; cursor: pointer; border: none; background: transparent; color: #666;">❌</button>
          </div>
          <textarea id="compose-input" rows="1" placeholder="Send a message... Click an agent's row below to mention them!"
            oninput="autoResize(this)" onkeydown="handleKey(event)"></textarea>
          <button id="btn-send" onclick="sendMessage()" title="Send">➤</button>
        </div>`;

      const input = this.querySelector('#compose-input');
      if (input) {
        input.addEventListener('input', () => this.updateMentions());
      }
    }

    updateMentions() {
      const input = document.getElementById("compose-input");
      if (!input) return;
      const content = input.value;
      const mentionPattern = /@agent-([a-f0-9\-]+)/g;
      const mentions = [...content.matchAll(mentionPattern)].map(m => m[1]);

      const bar = document.getElementById("mentions-bar");
      const agentsEl = document.getElementById("mentioned-agents");
      if (!bar || !agentsEl) return;

      if (mentions.length > 0) {
        bar.style.display = 'block';
        agentsEl.textContent = `Mentioning: ${mentions.join(', ')}`;
      } else {
        bar.style.display = 'none';
      }
    }
  }

  window.clearMentions = function () {
    const input = document.getElementById("compose-input");
    if (input) {
      input.value = input.value.replace(/@agent-[a-f0-9\-]+/g, '').trim();
      const acb = document.querySelector('acb-compose-shell');
      if (acb && acb.updateMentions) acb.updateMentions();
    }
  };

  document.addEventListener('click', (e) => {
    const row = e.target.closest('acb-agent-status-item');
    if (row && row.dataset.agentId) {
      const input = document.getElementById("compose-input");
      if (input) {
        input.value = (input.value + ` @agent-${row.dataset.agentId} `).trim() + " ";
        if (typeof autoResize === 'function') autoResize(input);
        const acb = document.querySelector('acb-compose-shell');
        if (acb && acb.updateMentions) acb.updateMentions();
        input.focus();
      }
    }
  }, true);

  if (!customElements.get('acb-compose-shell')) {
    customElements.define('acb-compose-shell', AcbComposeShell);
  }
})();
