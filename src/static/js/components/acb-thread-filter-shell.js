(function registerAcbThreadFilterShell() {
  class AcbThreadFilterShell extends HTMLElement {
    connectedCallback() {
      if (this.childElementCount > 0) return;

      this.innerHTML = `
        <div id="thread-filter-wrap">
          <button id="btn-thread-filter" type="button" onclick="toggleThreadFilterPanel(event)">Filter: normal (5)</button>
          <div id="thread-filter-panel" onclick="event.stopPropagation()">
            <acb-filter-actions></acb-filter-actions>
            <acb-filter-row status="discuss" checked></acb-filter-row>
            <acb-filter-row status="implement" checked></acb-filter-row>
            <acb-filter-row status="review" checked></acb-filter-row>
            <acb-filter-row status="done" checked></acb-filter-row>
            <acb-filter-row status="closed" checked></acb-filter-row>
            <acb-filter-row status="archived"></acb-filter-row>
          </div>
        </div>`;
    }
  }

  if (!customElements.get('acb-thread-filter-shell')) {
    customElements.define('acb-thread-filter-shell', AcbThreadFilterShell);
  }
})();
