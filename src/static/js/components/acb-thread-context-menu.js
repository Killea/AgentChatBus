(function registerAcbThreadContextMenu() {
  class AcbThreadContextMenu extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="thread-context-menu">
          <button id="ctx-close" class="ctx-item" type="button" onclick="closeThreadFromMenu()">Close</button>
          <button id="ctx-archive" class="ctx-item" type="button" onclick="archiveThreadFromMenu()">Archive</button>
          <button id="ctx-unarchive" class="ctx-item" type="button" onclick="unarchiveThreadFromMenu()" style="display: none;">Unarchive</button>
          <hr class="ctx-divider" aria-hidden="true">
          <button id="ctx-delete" class="ctx-item ctx-item--destructive" type="button" onclick="deleteThreadFromMenu()">Delete</button>
        </div>`;
    }
  }

  if (!customElements.get('acb-thread-context-menu')) {
    customElements.define('acb-thread-context-menu', AcbThreadContextMenu);
  }
})();
