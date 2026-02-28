(function registerAcbComposeShell() {
  class AcbComposeShell extends HTMLElement {
    constructor() {
      super();
      this.uploadedImages = [];
    }

    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="compose">
          <input id="compose-author" type="text" value="human" placeholder="author" />
          <div style="flex: 1; display: flex; flex-direction: column; min-width: 0;">
            <div id="mentions-bar" style="display:none; padding: 5px; font-size: 0.85em; background: rgba(0,0,0,0.1); border-radius: 4px; margin-bottom: 5px;">
              <span id="mentioned-agents"></span>
              <button type="button" onclick="clearMentions()" style="margin-left: 10px; cursor: pointer; border: none; background: transparent; color: #666;">❌</button>
            </div>
            <div id="image-preview" style="display:none; padding: 8px; background: rgba(100,150,200,.08); border-radius: 4px; margin-bottom: 5px; gap:8px; flex-wrap:wrap;"></div>
            <div id="compose-input" contenteditable="true" style="overflow-y: auto; word-break: break-word;" placeholder="Send a message... Click an agent's row below to mention them!" onkeydown="handleKey(event)"></div>
          </div>
          <button id="btn-send" onclick="sendMessage()" title="Send">➤</button>
        </div>`;

      const input = this.querySelector('#compose-input');
      if (input) {
        input.addEventListener('input', () => this.updateMentions());
        input.addEventListener('paste', (e) => this.handlePaste(e));
        input.addEventListener('drop', (e) => this.handleDrop(e));
        input.addEventListener('dragover', (e) => e.preventDefault());
      }
    }

    extractMentions() {
      const input = document.getElementById("compose-input");
      if (!input) return [];
      
      const mentions = [];
      for (const child of input.childNodes) {
        if (child.nodeType === 1 && child.getAttribute && child.getAttribute('data-mention-id')) {
          mentions.push(child.getAttribute('data-mention-id'));
        }
      }
      return mentions;
    }

    updateMentions() {
      const mentions = this.extractMentions();

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

    async handlePaste(e) {
      e.preventDefault();
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) await this.uploadImage(file);
        } else if (item.type === 'text/plain') {
          const text = await item.getAsString();
          const input = document.getElementById("compose-input");
          if (input) {
            // Insert text directly into contenteditable
            const textNode = document.createTextNode(text);
            if (input.childNodes.length === 0) {
              input.appendChild(textNode);
            } else {
              input.appendChild(textNode);
            }
            input.focus();
          }
        }
      }
    }

    handleDrop(e) {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files) return;

      for (const file of files) {
        if (file.type.startsWith('image/')) {
          this.uploadImage(file);
        }
      }
    }

    async uploadImage(file) {
      const formData = new FormData();
      formData.append('file', file);

      try {
        console.log(`[Upload] Starting upload of ${file.name} (${file.size} bytes, type: ${file.type})`);
        const response = await fetch('/api/upload/image', { method: 'POST', body: formData });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Upload failed with ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        console.log(`[Upload] Success: ${JSON.stringify(data)}`);
        const imageUrl = data.url;

        this.uploadedImages.push({ url: imageUrl, name: file.name });
        console.log(`[Upload] Image added to preview. Total images: ${this.uploadedImages.length}`);
        this.renderImagePreview();
      } catch (err) {
        console.error('[Upload] Image upload error:', err);
        alert(`Failed to upload image: ${err.message}`);
      }
    }

    renderImagePreview() {
      const preview = document.getElementById("image-preview");
      if (!preview) return;

      if (this.uploadedImages.length === 0) {
        preview.style.display = 'none';
        return;
      }

      preview.style.display = 'flex';
      preview.innerHTML = this.uploadedImages.map((img, i) => `
        <div style="position: relative; display: inline-block;">
          <img src="${img.url}" style="max-width: 80px; max-height: 80px; border-radius: 4px; object-fit: cover;" />
          <button type="button" onclick="removeImage(${i})" style="position: absolute; top: -8px; right: -8px; width: 20px; height: 20px; border-radius: 50%; background: #ff4444; color: white; border: none; cursor: pointer; font-size: 12px;">×</button>
        </div>
      `).join('');
  }

  }

  window.clearMentions = function () {
    const acb = document.querySelector('acb-compose-shell');
    if (acb) {
      const input = acb.querySelector('#compose-input');
      if (input) {
        for (const child of input.childNodes) {
          if (child.nodeType === 1 && child.getAttribute && child.getAttribute('data-mention-id')) {
            child.remove();
          }
        }
        if (acb.updateMentions) acb.updateMentions();
      }
    }
  };

  window.removeImage = function(index) {
    const acb = document.querySelector('acb-compose-shell');
    if (acb && acb.uploadedImages) {
      acb.uploadedImages.splice(index, 1);
      acb.renderImagePreview();
    }
  };

  document.addEventListener('click', (e) => {
    const row = e.target.closest('acb-agent-status-item');
    if (row && row.dataset.agentId) {
      const acb = document.querySelector('acb-compose-shell');
      if (acb) {
        const input = acb.querySelector('#compose-input');
        if (input) {
          const mentionSpan = document.createElement('span');
          mentionSpan.setAttribute('data-mention-id', row.dataset.agentId);
          mentionSpan.contentEditable = 'false';
          mentionSpan.style.cssText = 'background: rgba(59,130,246,0.2); color: #3b82f6; padding: 2px 6px; border-radius: 4px; margin: 0 4px; font-weight: 500; border: 1px solid #3b82f6; display: inline-block;';
          mentionSpan.textContent = `@${row.dataset.agentId.slice(0, 8)}`;

          input.appendChild(mentionSpan);
          input.appendChild(document.createTextNode(' '));
          input.focus();

          if (acb.updateMentions) acb.updateMentions();
        }
      }
    }
  }, true);

  if (!customElements.get('acb-compose-shell')) {
    customElements.define('acb-compose-shell', AcbComposeShell);
  }
})();
