(function registerAcbThreadContextMenu() {
  class AcbThreadContextMenu extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="thread-context-menu" role="menu">
          <button id="ctx-copy-name" class="ctx-item" type="button" role="menuitem" onclick="copyThreadNameFromMenu()">Copy Thread Name</button>
          <div class="ctx-submenu-container">
            <button id="ctx-gen-prompt" class="ctx-item ctx-submenu-trigger" type="button" role="menuitem">
              Generate Prompt
              <span class="ctx-submenu-arrow">▶</span>
            </button>
            <div class="ctx-submenu" role="menu">
              <button class="ctx-item" type="button" role="menuitem" onclick="copyJoinPromptFromMenu()">Copy Join Prompt</button>
            </div>
          </div>
          <hr class="ctx-divider" aria-hidden="true">
          <button id="ctx-close" class="ctx-item" type="button" role="menuitem" onclick="closeThreadFromMenu()">Close</button>
          <button id="ctx-archive" class="ctx-item" type="button" role="menuitem" onclick="archiveThreadFromMenu()">Archive</button>
          <button id="ctx-unarchive" class="ctx-item" type="button" role="menuitem" onclick="unarchiveThreadFromMenu()" style="display: none;">Unarchive</button>
          <hr class="ctx-divider" aria-hidden="true">
          <button id="ctx-delete" class="ctx-item ctx-item--destructive" type="button" role="menuitem" onclick="deleteThreadFromMenu()">Delete</button>
        </div>`;
    }
  }

  if (!customElements.get('acb-thread-context-menu')) {
    customElements.define('acb-thread-context-menu', AcbThreadContextMenu);
  }
})();
