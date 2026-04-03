(function () {
  const vscode = acquireVsCodeApi();

  function readBootstrapConfig() {
    const root = document.body;
    if (!root) return {};
    return {
      threadId: root.dataset.threadId || '',
      threadTopic: root.dataset.threadTopic || '',
      threadStatus: root.dataset.threadStatus || '',
      baseUrl: root.dataset.baseUrl || '',
      mermaidScriptUrl: root.dataset.mermaidScriptUrl || '',
      theme: root.dataset.theme || '',
      nonce: root.dataset.nonce || '',
    };
  }

  const config = readBootstrapConfig();

  const state = {
    baseUrl: String(config.baseUrl || '').replace(/\/+$/, ''),
    mermaidScriptUrl: String(config.mermaidScriptUrl || ''),
    nonce: String(config.nonce || ''),
    threadId: String(config.threadId || ''),
    theme: localStorage.getItem('acb-vscode-theme') || String(config.theme || 'dark'),
    messages: [],
    authorName: localStorage.getItem('acb-vscode-author') || 'human',
    agents: [],
    uploadedImages: [],
    replyTarget: null,
    editingMessageId: null,
    searchOpen: false,
    searchQuery: '',
    searchMatchIds: [],
    searchIndex: -1,
    mentionCandidates: [],
    mentionIndex: 0,
    reactionTargetId: null,
    pendingSend: false,
    toastTimer: null,
    renderToken: 0,
    mermaidLoadPromise: null,
    uploadResolvers: new Map(),
    uploadRequestSeq: 0,
    agentsLoaded: false,
    agentsLoadPromise: null,
    connectionTimer: null,
    engineTapTimes: [],
    indicatorResolvers: new Map(),
    indicatorRequestSeq: 0,
  };

  const INITIAL_RECENT_RENDER_COUNT = 36;
  const OLDER_RENDER_BATCH_SIZE = 48;

  const refs = {};
  const PYTHON_ENGINE_SVG = '<svg width="100%" height="100%" viewBox="0 0 256 255" version="1.1" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid"><defs><linearGradient x1="12.9593594%" y1="12.0393928%" x2="79.6388325%" y2="78.2008538%" id="pyGrad1"><stop stop-color="#387EB8" offset="0%"></stop><stop stop-color="#366994" offset="100%"></stop></linearGradient><linearGradient x1="19.127525%" y1="20.5791813%" x2="90.7415328%" y2="88.4290372%" id="pyGrad2"><stop stop-color="#FFE052" offset="0%"></stop><stop stop-color="#FFC331" offset="100%"></stop></linearGradient></defs><g><path d="M126.915866,0.0722755491 C62.0835831,0.0722801733 66.1321288,28.1874648 66.1321288,28.1874648 L66.2044043,57.3145115 L128.072276,57.3145115 L128.072276,66.0598532 L41.6307171,66.0598532 C41.6307171,66.0598532 0.144551098,61.3549438 0.144551098,126.771315 C0.144546474,192.187673 36.3546019,189.867871 36.3546019,189.867871 L57.9649915,189.867871 L57.9649915,159.51214 C57.9649915,159.51214 56.8001363,123.302089 93.5968379,123.302089 L154.95878,123.302089 C154.95878,123.302089 189.434218,123.859386 189.434218,89.9830604 L189.434218,33.9695088 C189.434218,33.9695041 194.668541,0.0722755491 126.915866,0.0722755491 Z M92.8018069,19.6589497 C98.9572068,19.6589452 103.932242,24.6339846 103.932242,30.7893845 C103.932246,36.9447844 98.9572068,41.9198193 92.8018069,41.9198193 C86.646407,41.9198239 81.6713721,36.9447844 81.6713721,30.7893845 C81.6713674,24.6339846 86.646407,19.6589497 92.8018069,19.6589497 Z" fill="url(#pyGrad1)"></path><path d="M128.757101,254.126271 C193.589403,254.126271 189.540839,226.011081 189.540839,226.011081 L189.468564,196.884035 L127.600692,196.884035 L127.600692,188.138693 L214.042251,188.138693 C214.042251,188.138693 255.528417,192.843589 255.528417,127.427208 C255.52844,62.0108566 219.318366,64.3306589 219.318366,64.3306589 L197.707976,64.3306589 L197.707976,94.6863832 C197.707976,94.6863832 198.87285,130.896434 162.07613,130.896434 L100.714182,130.896434 C100.714182,130.896434 66.238745,130.339138 66.238745,164.215486 L66.238745,220.229038 C66.238745,220.229038 61.0044225,254.126271 128.757101,254.126271 Z M162.87116,234.539597 C156.715759,234.539597 151.740726,229.564564 151.740726,223.409162 C151.740726,217.253759 156.715759,212.278727 162.87116,212.278727 C169.026563,212.278727 174.001595,217.253759 174.001595,223.409162 C174.001618,229.564564 169.026563,234.539597 162.87116,234.539597 Z" fill="url(#pyGrad2)"></path></g></svg>';
  const NODE_ENGINE_SVG = '<svg width="100%" height="100%" viewBox="0 0 256 289" version="1.1" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid"><g><path d="M127.999999,288.463771 C124.024844,288.463771 120.314699,287.403728 116.869564,285.548656 L81.6231884,264.612838 C76.32298,261.697724 78.9730854,260.637682 80.5631458,260.107661 C87.7184259,257.72257 89.0434775,257.192547 96.4637688,252.952381 C97.2587979,252.422361 98.3188405,252.687372 99.1138718,253.217392 L126.144927,269.383024 C127.20497,269.913045 128.530021,269.913045 129.325053,269.383024 L235.064182,208.165634 C236.124225,207.635611 236.654245,206.575571 236.654245,205.250519 L236.654245,83.0807467 C236.654245,81.7556929 236.124225,80.6956526 235.064182,80.1656324 L129.325053,19.2132506 C128.26501,18.6832305 126.939959,18.6832305 126.144927,19.2132506 L20.4057954,80.1656324 C19.3457551,80.6956526 18.8157349,82.0207041 18.8157349,83.0807467 L18.8157349,205.250519 C18.8157349,206.31056 19.3457551,207.635611 20.4057954,208.165634 L49.2919247,224.861286 C64.9275364,232.811595 74.7329196,223.536234 74.7329196,214.260871 L74.7329196,93.681159 C74.7329196,92.0910985 76.0579711,90.5010358 77.9130428,90.5010358 L91.4285716,90.5010358 C93.0186343,90.5010358 94.6086948,91.8260873 94.6086948,93.681159 L94.6086948,214.260871 C94.6086948,235.196689 83.2132512,247.387164 63.3374737,247.387164 C57.2422362,247.387164 52.4720502,247.387164 38.9565214,240.761906 L11.1304347,224.861286 C4.24016581,220.886129 0,213.46584 0,205.515528 L0,83.3457557 C0,75.3954465 4.24016581,67.9751552 11.1304347,64.0000006 L116.869564,2.78260752 C123.494824,-0.927535841 132.505176,-0.927535841 139.130436,2.78260752 L244.869565,64.0000006 C251.759834,67.9751552 256,75.3954465 256,83.3457557 L256,205.515528 C256,213.46584 251.759834,220.886129 244.869565,224.861286 L139.130436,286.078676 C135.685299,287.668739 131.710145,288.463771 127.999999,288.463771 Z M160.596274,204.455488 C114.219461,204.455488 104.679089,183.254659 104.679089,165.233955 C104.679089,163.643893 106.004141,162.053832 107.859212,162.053832 L121.639752,162.053832 C123.229813,162.053832 124.554864,163.113872 124.554864,164.703935 C126.674947,178.749484 132.770187,185.639753 160.861283,185.639753 C183.122154,185.639753 192.662526,180.604556 192.662526,168.67909 C192.662526,161.788821 190.012423,156.753624 155.296065,153.308489 C126.409938,150.393375 108.389235,144.033126 108.389235,120.977226 C108.389235,99.5113875 126.409938,86.7908901 156.621119,86.7908901 C190.542443,86.7908901 207.238095,98.4513472 209.358178,123.89234 C209.358178,124.687371 209.093167,125.482403 208.563147,126.277434 C208.033127,126.807454 207.238095,127.337474 206.443064,127.337474 L192.662526,127.337474 C191.337475,127.337474 190.012423,126.277434 189.747412,124.952382 C186.567289,110.376813 178.351966,105.606625 156.621119,105.606625 C132.240165,105.606625 129.325053,114.086957 129.325053,120.447205 C129.325053,128.132506 132.770187,130.5176 165.631471,134.757766 C198.227744,138.997931 213.598344,145.093169 213.598344,167.884058 C213.333333,191.20497 194.252589,204.455488 160.596274,204.455488 Z" fill="#539E43"></path></g></svg>';

  function init() {
    refs.messagesScroll = document.getElementById('messages-scroll');
    refs.messageContainer = document.getElementById('message-container');
    refs.loadingIndicator = document.getElementById('loading-indicator');
    refs.navSidebar = document.getElementById('nav-sidebar');
    refs.searchBar = document.getElementById('search-bar');
    refs.searchToggle = document.getElementById('search-toggle-btn');
    refs.searchInput = document.getElementById('search-input');
    refs.searchCounter = document.getElementById('search-counter');
    refs.searchPrev = document.getElementById('search-prev');
    refs.searchNext = document.getElementById('search-next');
    refs.composeInput = document.getElementById('compose-input');
    refs.sendButton = document.getElementById('send-button');
    refs.authorInput = document.getElementById('author-input');
    refs.uploadButton = document.getElementById('upload-button');
    refs.mentionButton = document.getElementById('mention-button');
    refs.imageInput = document.getElementById('image-input');
    refs.imagePreview = document.getElementById('image-preview');
    refs.replyPreview = document.getElementById('reply-preview');
    refs.mentionMenu = document.getElementById('mention-menu');
    refs.reactionMenu = document.getElementById('reaction-menu');
    refs.uiTooltip = document.getElementById('ui-tooltip');
    refs.modalBackdrop = document.getElementById('modal-backdrop');
    refs.modalTitle = document.getElementById('modal-title');
    refs.modalContent = document.getElementById('modal-content');
    refs.modalClose = document.getElementById('modal-close');
    refs.toast = document.getElementById('toast');
    refs.engineIcon = document.getElementById('engine-icon');
    refs.engineBadge = document.getElementById('engine-badge');
    refs.connectionBadge = document.getElementById('connection-badge');
    refs.connectionText = document.getElementById('connection-text');
    refs.newThreadBtn = document.getElementById('new-thread-btn');

    setLoading(true);
    if (refs.engineIcon) {
      refs.engineIcon.innerHTML = NODE_ENGINE_SVG;
    }
    applyTheme(state.theme || config.theme || 'dark');
    void refreshServerIndicators();
    state.connectionTimer = window.setInterval(() => {
      void refreshServerIndicators();
    }, 30000);

    refs.authorInput.value = state.authorName;

    refs.authorInput.addEventListener('input', () => {
      state.authorName = refs.authorInput.value.trim() || 'human';
      localStorage.setItem('acb-vscode-author', state.authorName);
    });

    refs.searchInput.addEventListener('input', () => {
      state.searchQuery = refs.searchInput.value.trim();
      runSearch(true);
    });
    if (refs.searchToggle) {
      refs.searchToggle.addEventListener('click', () => toggleSearch());
    }
    refs.searchPrev.addEventListener('click', () => moveSearch(-1));
    refs.searchNext.addEventListener('click', () => moveSearch(1));
    if (refs.newThreadBtn) {
      refs.newThreadBtn.addEventListener('click', () => {
        void requestNewThread();
      });
    }
    if (refs.engineBadge) {
      refs.engineBadge.addEventListener('click', onEngineBadgeClick);
    }

    refs.sendButton.addEventListener('click', () => sendMessage());
    refs.uploadButton.addEventListener('click', () => refs.imageInput.click());
    refs.imageInput.addEventListener('change', async () => {
      await uploadFiles(Array.from(refs.imageInput.files || []));
      refs.imageInput.value = '';
    });
    refs.mentionButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await openMentionPicker();
    });

    refs.composeInput.addEventListener('input', onComposerInput);
    refs.composeInput.addEventListener('keydown', onComposerKeyDown);
    refs.composeInput.addEventListener('paste', onComposerPaste);
    refs.composeInput.addEventListener('drop', onComposerDrop);
    refs.composeInput.addEventListener('dragover', (event) => event.preventDefault());

    refs.messagesScroll.addEventListener('scroll', () => updateActiveNavEntry());

    refs.modalBackdrop.addEventListener('click', (event) => {
      if (event.target === refs.modalBackdrop) {
        closeModal();
      }
    });
    refs.modalClose.addEventListener('click', closeModal);

    refs.reactionMenu.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-reaction]');
      if (!button || !state.reactionTargetId) return;
      hideReactionMenu();
      await addReaction(state.reactionTargetId, button.getAttribute('data-reaction') || '');
    });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('#mention-menu') && !event.target.closest('#mention-button')) {
        hideMentionMenu();
      }
      if (!event.target.closest('#reaction-menu') && !event.target.closest('.msg-action-react')) {
        hideReactionMenu();
      }
    });

    document.addEventListener('mouseover', (event) => {
      const anchor = event.target.closest('.tooltip-anchor[data-tooltip]');
      if (!anchor) return;
      showCustomTooltip(anchor);
    });

    document.addEventListener('mouseout', (event) => {
      const anchor = event.target.closest('.tooltip-anchor[data-tooltip]');
      if (!anchor) return;
      if (anchor.contains(event.relatedTarget)) return;
      hideCustomTooltip();
    });

    document.addEventListener('focusin', (event) => {
      const anchor = event.target.closest('.tooltip-anchor[data-tooltip]');
      if (!anchor) return;
      showCustomTooltip(anchor);
    });

    document.addEventListener('focusout', (event) => {
      const anchor = event.target.closest('.tooltip-anchor[data-tooltip]');
      if (!anchor) return;
      if (anchor.contains(event.relatedTarget)) return;
      hideCustomTooltip();
    });

    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (state.searchOpen) {
          focusSearchInput();
        } else {
          openSearch();
        }
        return;
      }

      if (event.key === 'Escape' && state.searchOpen) {
        if (document.activeElement === refs.searchInput || state.searchQuery) {
          event.preventDefault();
          closeSearch();
        }
      }
    });

    window.addEventListener('scroll', hideCustomTooltip, true);
    window.addEventListener('resize', hideCustomTooltip);

    window.addEventListener('message', handleHostMessage);

    // Agent lookup is non-critical for first paint. Defer it so thread open focuses on chat content.
    setTimeout(() => {
      void loadAgents();
    }, 250);
  }

  function handleHostMessage(event) {
    const message = event.data || {};
    switch (message.command) {
      case 'loadMessages':
        state.messages = normalizeMessages(message.messages || []);
        setLoading(true);
        // Yield one frame so loading state can paint before heavy DOM work starts.
        void (async () => {
          await nextFrame();
          renderAll(true);
          await nextFrame();
          setLoading(false);
        })();
        break;
      case 'appendMessages':
        for (const item of normalizeMessages(message.messages || [])) {
          upsertMessage(item);
        }
        renderAll(isNearBottom());
        break;
      case 'newMessage':
        upsertMessage(normalizeMessage(message.message));
        renderAll(true);
        break;
      case 'sendResult':
        state.pendingSend = false;
        updateSendButton();
        if (message.ok) {
          clearComposer();
        } else {
          showToast(message.error || 'Failed to send message.');
        }
        break;
      case 'uploadResult': {
        const resolver = state.uploadResolvers.get(message.requestId);
        if (!resolver) {
          break;
        }
        state.uploadResolvers.delete(message.requestId);
        if (message.ok) {
          resolver.resolve(message.image || null);
        } else {
          resolver.reject(new Error(message.error || 'Image upload failed.'));
        }
        break;
      }
      case 'agentsResult': {
        if (!state.agentsLoadPromise || state.agentsLoadPromise.requestId !== message.requestId) {
          break;
        }
        const pending = state.agentsLoadPromise;
        state.agentsLoadPromise = null;
        if (message.ok) {
          state.agents = Array.isArray(message.agents) ? message.agents.filter(Boolean) : [];
          state.agentsLoaded = true;
          pending.resolve(state.agents);
        } else {
          pending.reject(new Error(message.error || 'Failed to load agents.'));
        }
        break;
      }
      case 'createThreadResult':
        if (!message.ok) {
          showToast(message.error || 'Failed to create thread.');
        }
        break;
      case 'serverIndicatorsResult': {
        const resolver = state.indicatorResolvers.get(message.requestId);
        if (!resolver) {
          break;
        }
        state.indicatorResolvers.delete(message.requestId);
        if (message.ok) {
          resolver.resolve(message);
        } else {
          resolver.reject(new Error(message.error || 'Failed to load server indicators.'));
        }
        break;
      }
    }
  }

  function applyTheme(theme) {
    const normalized = String(theme || 'dark').toLowerCase() === 'light' ? 'light' : 'dark';
    state.theme = normalized;
    document.body.setAttribute('data-theme', normalized);
    localStorage.setItem('acb-vscode-theme', normalized);
  }

  async function refreshServerIndicators() {
    const isWebview = String(window.location.protocol || '').startsWith('vscode-webview');
    try {
      if (isWebview) {
        const requestId = `ind-${Date.now()}-${state.indicatorRequestSeq++}`;
        const indicatorsPromise = new Promise((resolve, reject) => {
          state.indicatorResolvers.set(requestId, { resolve, reject });
        });
        vscode.postMessage({ command: 'getServerIndicators', requestId });
        const indicators = await indicatorsPromise;
        const engine = String(indicators?.engine || '').toLowerCase();
        if (refs.engineIcon) {
          refs.engineIcon.innerHTML = engine === 'python' ? PYTHON_ENGINE_SVG : NODE_ENGINE_SVG;
        }
        if (refs.connectionBadge) {
          refs.connectionBadge.classList.toggle('disconnected', !Boolean(indicators?.connected));
        }
        if (refs.connectionText) {
          refs.connectionText.textContent = indicators?.connected ? 'Connected' : 'Reconnecting';
        }
        return;
      }

      const response = await fetch(`${state.baseUrl}/api/metrics`);
      if (!response.ok) throw new Error(await response.text());
      const metrics = await response.json();
      const engine = String(metrics?.engine || '').toLowerCase();
      if (refs.engineIcon) refs.engineIcon.innerHTML = engine === 'python' ? PYTHON_ENGINE_SVG : NODE_ENGINE_SVG;
      if (refs.connectionBadge) refs.connectionBadge.classList.remove('disconnected');
      if (refs.connectionText) refs.connectionText.textContent = 'Connected';
    } catch {
      if (refs.connectionBadge) {
        refs.connectionBadge.classList.add('disconnected');
      }
      if (refs.connectionText) {
        refs.connectionText.textContent = 'Reconnecting';
      }
    }
  }

  function onEngineBadgeClick(event) {
    if (!event.ctrlKey) {
      state.engineTapTimes.length = 0;
      return;
    }
    const isBrowserDebug = /^https?:$/i.test(window.location.protocol);
    if (!isBrowserDebug) {
      state.engineTapTimes.length = 0;
      return;
    }

    const now = Date.now();
    const windowMs = 1200;
    while (state.engineTapTimes.length > 0 && (now - state.engineTapTimes[0]) > windowMs) {
      state.engineTapTimes.shift();
    }
    state.engineTapTimes.push(now);
    if (state.engineTapTimes.length < 3) {
      return;
    }
    state.engineTapTimes.length = 0;
    const target = new URL('/', window.location.origin);
    window.location.assign(target.toString());
  }

  async function requestNewThread() {
    const topic = `New Thread ${new Date().toLocaleString()}`;
    vscode.postMessage({ command: 'createThread', topic });
  }

  function toggleSearch() {
    if (state.searchOpen) {
      closeSearch();
      return;
    }
    openSearch();
  }

  function openSearch() {
    if (!refs.searchBar) {
      return;
    }
    state.searchOpen = true;
    refs.searchBar.classList.remove('hidden');
    refs.searchBar.setAttribute('aria-hidden', 'false');
    if (refs.searchToggle) {
      refs.searchToggle.classList.add('active');
      refs.searchToggle.setAttribute('aria-pressed', 'true');
    }
    focusSearchInput();
  }

  function closeSearch() {
    if (!refs.searchBar) {
      return;
    }
    state.searchOpen = false;
    refs.searchBar.classList.add('hidden');
    refs.searchBar.setAttribute('aria-hidden', 'true');
    if (refs.searchToggle) {
      refs.searchToggle.classList.remove('active');
      refs.searchToggle.setAttribute('aria-pressed', 'false');
    }
    clearSearchState();
    hideCustomTooltip();
  }

  function focusSearchInput() {
    window.requestAnimationFrame(() => {
      refs.searchInput?.focus();
      refs.searchInput?.select();
    });
  }

  function clearSearchState() {
    state.searchQuery = '';
    state.searchMatchIds = [];
    state.searchIndex = -1;
    if (refs.searchInput) {
      refs.searchInput.value = '';
    }
    runSearch(false);
  }

  function normalizeMessages(items) {
    return Array.isArray(items) ? items.map(normalizeMessage).sort(compareMessagesForDisplay) : [];
  }

  function normalizeMessage(message) {
    const msg = message || {};
    const transcriptIndex = Number(msg.transcript_index);
    return {
      ...msg,
      seq: typeof msg.seq === 'number' ? msg.seq : (Number.isFinite(Number(msg.seq)) ? Number(msg.seq) : null),
      transcript_index: Number.isFinite(transcriptIndex) ? transcriptIndex : null,
      entry_kind: typeof msg.entry_kind === 'string' ? msg.entry_kind : 'message',
      edit_version: Number(msg.edit_version || 0),
      reactions: Array.isArray(msg.reactions) ? msg.reactions : [],
      metadata: parseMetadata(msg.metadata),
    };
  }

  function getMessageSortKey(message) {
    if (Number.isFinite(Number(message?.transcript_index))) {
      return Number(message.transcript_index);
    }
    if (Number.isFinite(Number(message?.seq))) {
      return Number(message.seq);
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function compareMessagesForDisplay(left, right) {
    return getMessageSortKey(left) - getMessageSortKey(right);
  }

  function parseMetadata(metadata) {
    if (!metadata) return null;
    if (typeof metadata === 'string') {
      try {
        return JSON.parse(metadata);
      } catch {
        return null;
      }
    }
    return metadata;
  }

  function upsertMessage(message) {
    const normalized = normalizeMessage(message);
    const existingIndex = state.messages.findIndex((item) => {
      if (item.id && normalized.id && item.id === normalized.id) {
        return true;
      }
      if (
        Number.isFinite(Number(item.seq))
        && Number.isFinite(Number(normalized.seq))
        && item.entry_kind === 'message'
        && normalized.entry_kind === 'message'
        && Number(item.seq) === Number(normalized.seq)
      ) {
        return true;
      }
      return false;
    });
    if (existingIndex >= 0) {
      state.messages[existingIndex] = normalizeMessage({ ...state.messages[existingIndex], ...normalized });
    } else {
      state.messages.push(normalized);
      state.messages.sort(compareMessagesForDisplay);
    }
  }

  function renderAll(keepBottom) {
    const token = ++state.renderToken;
    const shouldStickBottom = keepBottom || isNearBottom();
    renderMessages(token, shouldStickBottom);
    rebuildNavSidebar();
    updateNavSidebarScrollbarState();
    if (state.searchQuery) {
      runSearch(false);
    } else {
      updateSearchCounter();
    }
    updateActiveNavEntry();
  }

  function renderMessages(token, shouldStickBottom) {
    refs.messageContainer.innerHTML = '';

    if (state.messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No messages yet. Start the thread here.';
      refs.messageContainer.appendChild(empty);
      return;
    }

    const byId = new Map(state.messages.map((item) => [item.id, item]));

    const recentStartIndex = Math.max(0, state.messages.length - INITIAL_RECENT_RENDER_COUNT);
    const olderMessages = state.messages.slice(0, recentStartIndex);
    const recentMessages = state.messages.slice(recentStartIndex);

    appendMessageBatch(recentMessages, byId, refs.messageContainer);

    void maybeRenderMermaidForMessages(recentMessages);

    if (shouldStickBottom) {
      scrollToBottom();
    }

    if (olderMessages.length === 0) {
      return;
    }

    const loadingBanner = document.createElement('div');
    loadingBanner.className = 'composer-note';
    loadingBanner.textContent = `Loading ${olderMessages.length} older messages...`;
    refs.messageContainer.prepend(loadingBanner);

    void scheduleOlderMessageBackfill(token, olderMessages, byId, loadingBanner);
  }

  async function scheduleOlderMessageBackfill(token, olderMessages, byId, loadingBanner) {
    let cursor = olderMessages.length;
    while (cursor > 0 && token === state.renderToken) {
      await nextFrame();
      const start = Math.max(0, cursor - OLDER_RENDER_BATCH_SIZE);
      const batch = olderMessages.slice(start, cursor);
      prependMessageBatch(batch, byId, loadingBanner);
      cursor = start;

      void maybeRenderMermaidForMessages(batch);

      if (token === state.renderToken) {
        loadingBanner.textContent = cursor > 0
          ? `Loading ${cursor} older messages...`
          : '';
      }
    }

    if (token !== state.renderToken) {
      loadingBanner.remove();
      return;
    }

    loadingBanner.remove();
    if (state.searchQuery) {
      runSearch(false);
    }
    updateActiveNavEntry();
  }

  function appendMessageBatch(messages, byId, parent) {
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      fragment.appendChild(renderMessageRow(message, byId));
    }
    parent.appendChild(fragment);
  }

  function prependMessageBatch(messages, byId, loadingBanner) {
    const previousBottomOffset = refs.messagesScroll.scrollHeight - refs.messagesScroll.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      fragment.appendChild(renderMessageRow(message, byId));
    }
    loadingBanner.after(fragment);
    const nextBottomOffset = refs.messagesScroll.scrollHeight - previousBottomOffset;
    refs.messagesScroll.scrollTop = Math.max(0, nextBottomOffset);
  }

  function nextFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  async function maybeRenderMermaidForMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }
    if (!messagesMayContainMermaid(messages)) {
      return;
    }
    const ready = await ensureMermaidLoaded();
    if (!ready) {
      return;
    }
    if (window.AcbMessageRenderer && typeof window.AcbMessageRenderer.renderMermaidBlocks === 'function') {
      await window.AcbMessageRenderer.renderMermaidBlocks(refs.messageContainer);
    }
  }

  function messagesMayContainMermaid(messages) {
    return messages.some((message) => {
      const content = String(message?.content || '');
      return content.includes('```mermaid') || /^(graph|flowchart)\s+(TD|TB|LR|RL)\b/im.test(content);
    });
  }

  async function ensureMermaidLoaded() {
    if (window.mermaid) {
      return true;
    }
    if (!state.mermaidScriptUrl) {
      return false;
    }
    if (state.mermaidLoadPromise) {
      return state.mermaidLoadPromise;
    }

    state.mermaidLoadPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = state.mermaidScriptUrl;
      script.async = true;
      if (state.nonce) {
        script.setAttribute('nonce', state.nonce);
      }
      script.onload = () => resolve(Boolean(window.mermaid));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });

    return state.mermaidLoadPromise;
  }

  function setLoading(visible) {
    if (!refs.loadingIndicator) return;
    refs.loadingIndicator.classList.toggle('hidden', !visible);
  }

  function renderMessageRow(message, byId) {
    const row = document.createElement('article');
    row.className = 'msg-row';
    if (Number.isFinite(Number(message.seq))) {
      row.dataset.seq = String(message.seq);
    }
    row.dataset.id = message.id || '';

    if (isOwnMessage(message)) {
      row.classList.add('own');
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = message.author_emoji || (isOwnMessage(message) ? '👤' : '🤖');

    const main = document.createElement('div');
    main.className = 'msg-main';

    const header = document.createElement('div');
    header.className = 'msg-header';
    header.innerHTML = '';

    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = getAuthorLabel(message);
    header.appendChild(author);

    const time = document.createElement('span');
    time.textContent = formatTimestamp(message.created_at);
    header.appendChild(time);

    const seq = document.createElement('span');
    seq.textContent = Number.isFinite(Number(message.seq))
      ? `seq ${message.seq}`
      : (message.entry_kind === 'human_only' ? 'human-only' : 'message');
    header.appendChild(seq);

    if (message.edit_version > 0) {
      const edited = document.createElement('button');
      edited.className = 'msg-action-btn';
      edited.textContent = `(edited x${message.edit_version})`;
      edited.addEventListener('click', () => void showEditHistory(message.id));
      header.appendChild(edited);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';

    const bubble = document.createElement('div');
    bubble.className = 'message';

    if (message.reply_to_msg_id && byId.has(message.reply_to_msg_id)) {
      bubble.appendChild(renderReplyQuote(byId.get(message.reply_to_msg_id)));
    }

    if (state.editingMessageId === message.id) {
      bubble.appendChild(renderEditBox(message));
    } else {
      const content = document.createElement('div');
      if (window.AcbMessageRenderer && typeof window.AcbMessageRenderer.renderMessageContent === 'function') {
        window.AcbMessageRenderer.renderMessageContent(content, message.content || '', message.metadata || {});
      } else {
        content.textContent = message.content || '';
      }
      bubble.appendChild(content);
      const images = Array.isArray(message.metadata?.images) ? message.metadata.images : [];
      if (images.length > 0) {
        bubble.appendChild(renderMessageImages(images));
      }
    }

    body.appendChild(bubble);
    const tail = renderMessageTail(message);
    if (tail) {
      body.appendChild(tail);
    }

    main.appendChild(header);
    main.appendChild(body);
    row.appendChild(avatar);
    row.appendChild(main);
    return row;
  }

  function renderReplyQuote(message) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';

    const author = document.createElement('div');
    author.className = 'reply-quote-author';
    author.textContent = `Replying to ${getAuthorLabel(message)}`;

    const content = document.createElement('div');
    content.textContent = truncateText(message.content || '', 180);

    quote.appendChild(author);
    quote.appendChild(content);
    return quote;
  }

  function renderMessageImages(images) {
    const wrap = document.createElement('div');
    wrap.className = 'message-images';

    for (const image of images) {
      const img = document.createElement('img');
      img.className = 'message-image';
      img.src = toAbsoluteUrl(image.url || '');
      img.alt = image.name || 'uploaded image';
      img.loading = 'lazy';
      wrap.appendChild(img);
    }
    return wrap;
  }

  function renderMessageTail(message) {
    const reactions = renderReactionList(message);
    if (!reactions) {
      return null;
    }

    const tail = document.createElement('div');
    tail.className = 'msg-tail';
    tail.appendChild(reactions);
    return tail;
  }

  function renderReactionList(message) {
    const grouped = new Map();
    for (const reaction of message.reactions || []) {
      const key = reaction.reaction || '';
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }

    if (grouped.size === 0) {
      return null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'reaction-list';

    for (const [reaction, count] of grouped.entries()) {
      const pill = document.createElement('button');
      pill.className = 'reaction-pill';
      pill.textContent = `${reaction} ${count}`;
      pill.title = 'Add another reaction';
      pill.addEventListener('click', () => void addReaction(message.id, reaction));
      wrap.appendChild(pill);
    }

    return wrap;
  }

  function renderEditBox(message) {
    const box = document.createElement('div');
    box.className = 'msg-edit-box';

    const input = document.createElement('textarea');
    input.className = 'msg-edit-input';
    input.value = message.content || '';
    box.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.appendChild(createActionButton('Save', () => void saveEdit(message.id, input.value)));
    actions.appendChild(createActionButton('Cancel', () => cancelEdit()));
    box.appendChild(actions);

    return box;
  }

  function createActionButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-action-btn';
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  function beginEdit(messageId) {
    state.editingMessageId = messageId;
    renderAll(false);
    scrollRowIntoView(messageId);
  }

  function cancelEdit() {
    state.editingMessageId = null;
    renderAll(false);
  }

  async function saveEdit(messageId, content) {
    const trimmed = String(content || '').trim();
    if (!trimmed) {
      showToast('Edited message cannot be empty.');
      return;
    }

    try {
      const response = await fetch(`${state.baseUrl}/api/messages/${encodeURIComponent(messageId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed, edited_by: state.authorName || 'human' }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const payload = await response.json();
      const message = state.messages.find((item) => item.id === messageId);
      if (message) {
        message.content = trimmed;
        message.edited_at = payload.edited_at || new Date().toISOString();
        message.edit_version = Number(payload.version || message.edit_version || 1);
      }
      state.editingMessageId = null;
      renderAll(false);
    } catch (error) {
      showToast(`Failed to edit message: ${formatError(error)}`);
    }
  }

  async function showEditHistory(messageId) {
    try {
      const response = await fetch(`${state.baseUrl}/api/messages/${encodeURIComponent(messageId)}/history`);
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const payload = await response.json();
      refs.modalTitle.textContent = 'Message edit history';
      refs.modalContent.innerHTML = '';

      const intro = document.createElement('div');
      intro.className = 'composer-note';
      intro.textContent = `Current version: ${payload.edit_version || 0}`;
      refs.modalContent.appendChild(intro);

      for (const entry of payload.edits || []) {
        const block = document.createElement('div');
        block.className = 'history-entry';

        const meta = document.createElement('div');
        meta.className = 'history-meta';
        meta.textContent = `v${entry.version} by ${entry.edited_by} at ${formatTimestamp(entry.created_at)}`;

        const pre = document.createElement('pre');
        pre.textContent = entry.old_content || '';

        block.appendChild(meta);
        block.appendChild(pre);
        refs.modalContent.appendChild(block);
      }

      if (!payload.edits || payload.edits.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No previous edits recorded.';
        refs.modalContent.appendChild(empty);
      }

      refs.modalBackdrop.classList.remove('hidden');
    } catch (error) {
      showToast(`Failed to load edit history: ${formatError(error)}`);
    }
  }

  function closeModal() {
    refs.modalBackdrop.classList.add('hidden');
  }

  function setReplyTarget(messageId) {
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) return;
    state.replyTarget = { id: message.id, author: getAuthorLabel(message), content: truncateText(message.content || '', 180) };
    renderReplyPreview();
    refs.composeInput.focus();
  }

  function renderReplyPreview() {
    if (!state.replyTarget) {
      refs.replyPreview.classList.add('hidden');
      refs.replyPreview.innerHTML = '';
      return;
    }

    refs.replyPreview.classList.remove('hidden');
    refs.replyPreview.innerHTML = '';

    const text = document.createElement('div');
    text.className = 'reply-preview-text';
    text.innerHTML = `<strong>Replying to ${escapeHtml(state.replyTarget.author)}</strong><br>${escapeHtml(state.replyTarget.content)}`;

    const button = document.createElement('button');
    button.className = 'icon-btn';
    button.textContent = 'Clear';
    button.addEventListener('click', () => {
      state.replyTarget = null;
      renderReplyPreview();
    });

    refs.replyPreview.appendChild(text);
    refs.replyPreview.appendChild(button);
  }

  function renderImagePreview() {
    if (state.uploadedImages.length === 0) {
      refs.imagePreview.classList.add('hidden');
      refs.imagePreview.innerHTML = '';
      return;
    }

    refs.imagePreview.classList.remove('hidden');
    refs.imagePreview.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'image-preview-list';

    state.uploadedImages.forEach((image, index) => {
      const item = document.createElement('div');
      item.className = 'image-preview-item';

      const img = document.createElement('img');
      img.src = toAbsoluteUrl(image.url || '');
      img.alt = image.name || `image-${index + 1}`;

      const remove = document.createElement('button');
      remove.className = 'image-remove-btn';
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove image');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        state.uploadedImages.splice(index, 1);
        renderImagePreview();
      });

      item.appendChild(img);
      item.appendChild(remove);
      list.appendChild(item);
    });

    refs.imagePreview.appendChild(list);
  }

  async function sendMessage() {
    if (state.pendingSend) return;

    const payload = extractComposerPayload();
    if (!payload.content && state.uploadedImages.length === 0) {
      showToast('Write a message or attach an image first.');
      return;
    }

    if (state.uploadedImages.length > 0) {
      payload.images = [...state.uploadedImages];
    }
    if (state.replyTarget) {
      payload.reply_to_msg_id = state.replyTarget.id;
    }
    payload.author = state.authorName || 'human';

    state.pendingSend = true;
    updateSendButton();
    vscode.postMessage({ command: 'sendMessage', payload });
  }

  function updateSendButton() {
    refs.sendButton.disabled = state.pendingSend;
    refs.sendButton.textContent = state.pendingSend ? 'Sending...' : 'Send';
  }

  function clearComposer() {
    refs.composeInput.innerHTML = '';
    state.uploadedImages = [];
    state.replyTarget = null;
    renderReplyPreview();
    renderImagePreview();
    hideMentionMenu();
  }

  function extractComposerPayload() {
    const mentions = [];
    const mentionLabels = {};

    function walk(node) {
      let text = '';
      for (const child of Array.from(node.childNodes || [])) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent || '';
          continue;
        }

        if (child.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }

        const element = child;
        if (element.hasAttribute('data-mention-id')) {
          const mentionId = element.getAttribute('data-mention-id') || '';
          const mentionLabel = element.getAttribute('data-mention-label') || mentionId;
          if (mentionId && !mentions.includes(mentionId)) {
            mentions.push(mentionId);
            mentionLabels[mentionId] = mentionLabel;
          }
          text += element.textContent || `@${mentionLabel}`;
        } else {
          text += walk(element);
          if (['DIV', 'P', 'BR'].includes(element.tagName) && !text.endsWith('\n')) {
            text += '\n';
          }
        }
      }
      return text;
    }

    const content = walk(refs.composeInput).trim();
    const payload = { content };

    if (mentions.length > 0) {
      payload.mentions = mentions;
      payload.metadata = { mention_labels: mentionLabels };
    }

    return payload;
  }

  function onComposerInput() {
    const mentionState = detectMentionQuery();
    if (mentionState) {
      void showMentionMenuForQuery(mentionState.query, mentionState.rect);
    } else {
      hideMentionMenu();
    }
  }

  function onComposerKeyDown(event) {
    if (!refs.mentionMenu.classList.contains('hidden')) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveMentionSelection(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveMentionSelection(-1);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        chooseMention(state.mentionIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideMentionMenu();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function detectMentionQuery() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !refs.composeInput.contains(selection.anchorNode)) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    range.setStart(refs.composeInput, 0);
    const textBeforeCaret = range.toString();
    const match = textBeforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) {
      return null;
    }

    const anchorRect = selection.getRangeAt(0).getBoundingClientRect();
    return {
      query: match[1] || '',
      rect: anchorRect.width || anchorRect.height ? anchorRect : refs.composeInput.getBoundingClientRect(),
    };
  }

  async function openMentionPicker() {
    refs.composeInput.focus();
    placeCaretAtEndIfNeeded();

    try {
      await ensureAgentsLoaded();
      showMentionMenu('', getMentionButtonAnchorRect());
    } catch (error) {
      showToast(`Failed to load agents: ${formatError(error)}`);
    }
  }

  async function showMentionMenuForQuery(query, rect) {
    try {
      await ensureAgentsLoaded();
      showMentionMenu(query, rect);
    } catch {
      hideMentionMenu();
    }
  }

  function showMentionMenu(query, rect) {
    const needle = String(query || '').toLowerCase();
    state.mentionCandidates = state.agents.filter((agent) => {
      const haystack = `${agent.display_name || ''} ${agent.name || ''} ${agent.id || ''}`.toLowerCase();
      return haystack.includes(needle);
    }).slice(0, 8);

    state.mentionIndex = 0;
    refs.mentionMenu.innerHTML = '';

    if (state.mentionCandidates.length === 0) {
      refs.mentionMenu.appendChild(renderMentionEmptyState(
        Array.isArray(state.agents) && state.agents.length > 0
          ? 'No matching agents in this thread'
          : 'No agents in this thread'
      ));
    } else {
      state.mentionCandidates.forEach((agent, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu-item';
        if (index === 0) button.classList.add('active');
        button.innerHTML = `<div class="menu-item-title">${escapeHtml(agent.emoji || '')} ${escapeHtml(agent.display_name || agent.name || agent.id)}</div><div class="menu-item-meta">${escapeHtml(agent.id || '')}</div>`;
        button.addEventListener('click', () => chooseMention(index));
        refs.mentionMenu.appendChild(button);
      });
    }

    const menuWidth = Math.min(320, Math.max(220, refs.composeInput.getBoundingClientRect().width));
    refs.mentionMenu.style.width = `${menuWidth}px`;
    refs.mentionMenu.style.left = `${Math.max(12, Math.min(window.innerWidth - menuWidth - 12, rect.left))}px`;
    refs.mentionMenu.style.top = `${Math.min(window.innerHeight - 240, rect.bottom + 8)}px`;
    refs.mentionMenu.classList.remove('hidden');
  }

  function hideMentionMenu() {
    refs.mentionMenu.classList.add('hidden');
    refs.mentionMenu.innerHTML = '';
    state.mentionCandidates = [];
    state.mentionIndex = 0;
  }

  function moveMentionSelection(delta) {
    if (state.mentionCandidates.length === 0) return;
    state.mentionIndex = (state.mentionIndex + delta + state.mentionCandidates.length) % state.mentionCandidates.length;
    Array.from(refs.mentionMenu.querySelectorAll('.menu-item')).forEach((item, index) => {
      item.classList.toggle('active', index === state.mentionIndex);
    });
  }

  function chooseMention(index) {
    const agent = state.mentionCandidates[index];
    if (!agent) return;
    insertMentionPill(agent);
    hideMentionMenu();
  }

  function renderMentionEmptyState(text) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = text;
    return empty;
  }

  function insertMentionPill(agent) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      refs.composeInput.focus();
    }

    const currentSelection = window.getSelection();
    if (!currentSelection || currentSelection.rangeCount === 0) return;
    const range = currentSelection.getRangeAt(0);

    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const textNode = range.startContainer;
      const currentText = textNode.textContent || '';
      const prefix = currentText.slice(0, range.startOffset);
      const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
      if (match) {
        const atIndex = prefix.lastIndexOf('@');
        const replaceRange = document.createRange();
        replaceRange.setStart(textNode, atIndex);
        replaceRange.setEnd(textNode, range.startOffset);
        replaceRange.deleteContents();
        range.setStart(textNode, atIndex);
        range.collapse(true);
      }
    }

    const pill = document.createElement('span');
    pill.className = 'mention-pill';
    pill.contentEditable = 'false';
    pill.setAttribute('data-mention-id', agent.id || '');
    pill.setAttribute('data-mention-label', agent.display_name || agent.name || agent.id || 'agent');
    pill.textContent = `@${agent.display_name || agent.name || agent.id}`;

    const spacer = document.createTextNode(' ');
    range.insertNode(spacer);
    range.insertNode(pill);
    range.setStartAfter(spacer);
    range.collapse(true);
    currentSelection.removeAllRanges();
    currentSelection.addRange(range);
    refs.composeInput.focus();
  }

  function placeCaretAtEndIfNeeded() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && refs.composeInput.contains(selection.anchorNode)) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(refs.composeInput);
    range.collapse(false);
    const nextSelection = window.getSelection();
    if (!nextSelection) {
      return;
    }
    nextSelection.removeAllRanges();
    nextSelection.addRange(range);
  }

  function getMentionButtonAnchorRect() {
    const composerRect = refs.composeInput.getBoundingClientRect();
    const buttonRect = refs.mentionButton.getBoundingClientRect();
    return {
      left: Math.max(12, Math.min(buttonRect.left, composerRect.left)),
      bottom: Math.max(buttonRect.bottom, composerRect.top),
    };
  }

  function showCustomTooltip(anchor) {
    if (!refs.uiTooltip) {
      return;
    }

    const text = anchor.getAttribute('data-tooltip');
    if (!text) {
      hideCustomTooltip();
      return;
    }

    refs.uiTooltip.textContent = text;
    refs.uiTooltip.classList.remove('hidden');

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = refs.uiTooltip.getBoundingClientRect();
    const margin = 12;
    const gap = 10;

    let left = anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2);
    left = Math.max(margin, Math.min(window.innerWidth - tooltipRect.width - margin, left));
    const anchorCenter = anchorRect.left + (anchorRect.width / 2);
    const arrowLeft = Math.max(12, Math.min(tooltipRect.width - 12, anchorCenter - left));

    let top = anchorRect.top - tooltipRect.height - gap;
    let side = 'top';
    if (top < margin) {
      top = Math.min(window.innerHeight - tooltipRect.height - margin, anchorRect.bottom + gap);
      side = 'bottom';
    }

    refs.uiTooltip.dataset.side = side;
    refs.uiTooltip.style.setProperty('--tooltip-arrow-left', `${arrowLeft}px`);
    refs.uiTooltip.style.left = `${left}px`;
    refs.uiTooltip.style.top = `${top}px`;
  }

  function hideCustomTooltip() {
    if (!refs.uiTooltip) {
      return;
    }
    refs.uiTooltip.classList.add('hidden');
    refs.uiTooltip.textContent = '';
    refs.uiTooltip.style.left = '';
    refs.uiTooltip.style.top = '';
    refs.uiTooltip.style.removeProperty('--tooltip-arrow-left');
    refs.uiTooltip.dataset.side = 'top';
  }

  function showReactionMenu(messageId, anchor) {
    state.reactionTargetId = messageId;
    const rect = anchor.getBoundingClientRect();
    refs.reactionMenu.style.left = `${Math.max(12, Math.min(window.innerWidth - 200, rect.left - 120))}px`;
    refs.reactionMenu.style.top = `${Math.min(window.innerHeight - 140, rect.bottom + 8)}px`;
    refs.reactionMenu.classList.remove('hidden');
  }

  function hideReactionMenu() {
    refs.reactionMenu.classList.add('hidden');
    state.reactionTargetId = null;
  }

  async function addReaction(messageId, reaction) {
    if (!reaction) return;
    try {
      const response = await fetch(`${state.baseUrl}/api/messages/${encodeURIComponent(messageId)}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: state.authorName || 'human', reaction }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const refresh = await fetch(`${state.baseUrl}/api/messages/${encodeURIComponent(messageId)}/reactions`);
      if (!refresh.ok) {
        throw new Error(await refresh.text());
      }
      const reactions = await refresh.json();
      const message = state.messages.find((item) => item.id === messageId);
      if (message) {
        message.reactions = Array.isArray(reactions) ? reactions : [];
      }
      renderAll(false);
    } catch (error) {
      showToast(`Failed to react: ${formatError(error)}`);
    }
  }

  async function loadAgents() {
    return ensureAgentsLoaded();
  }

  async function ensureAgentsLoaded() {
    if (state.agentsLoaded) {
      return state.agents;
    }

    if (state.agentsLoadPromise) {
      return state.agentsLoadPromise.promise;
    }

    const requestId = `agents-${Date.now()}-${state.uploadRequestSeq++}`;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    state.agentsLoadPromise = {
      requestId,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };

    vscode.postMessage({ command: 'loadAgents', requestId });
    return promise;
  }

  async function uploadFiles(files) {
    const imageFiles = files.filter((file) => file && String(file.type || '').startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }

    for (const file of imageFiles) {
      try {
        const payload = await requestImageUpload(file);
        if (payload?.url) {
          state.uploadedImages.push({ url: payload.url, name: payload.name || file.name });
        }
      } catch (error) {
        showToast(`Failed to upload image: ${formatError(error)}`);
      }
    }
    renderImagePreview();
  }

  async function requestImageUpload(file) {
    const requestId = `upload-${Date.now()}-${state.uploadRequestSeq++}`;
    const buffer = await file.arrayBuffer();
    const data = Array.from(new Uint8Array(buffer));

    const promise = new Promise((resolve, reject) => {
      state.uploadResolvers.set(requestId, { resolve, reject });
    });

    vscode.postMessage({
      command: 'uploadImage',
      requestId,
      payload: {
        name: file.name,
        type: file.type,
        data,
      },
    });

    return promise;
  }

  async function onComposerPaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageFiles = items
      .filter((item) => String(item.type || '').startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    await uploadFiles(imageFiles);

    const text = event.clipboardData?.getData('text/plain') || '';
    if (text) {
      insertPlainText(text);
    }
  }

  async function onComposerDrop(event) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    await uploadFiles(files);
  }

  function insertPlainText(text) {
    if (!text) return;
    refs.composeInput.focus();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      refs.composeInput.appendChild(document.createTextNode(text));
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function runSearch(scrollToActive) {
    const query = String(state.searchQuery || '').trim().toLowerCase();
    const rows = Array.from(refs.messageContainer.querySelectorAll('.msg-row'));

    rows.forEach((row) => row.classList.remove('search-hit', 'search-active'));

    if (!query) {
      state.searchMatchIds = [];
      state.searchIndex = -1;
      updateSearchCounter();
      return;
    }

    state.searchMatchIds = state.messages
      .filter((message) => {
        const haystack = [
          message.content || '',
          getAuthorLabel(message),
          JSON.stringify(message.metadata || {}),
        ].join(' ').toLowerCase();
        return haystack.includes(query);
      })
      .map((message) => message.id);

    state.searchIndex = state.searchMatchIds.length > 0
      ? Math.min(Math.max(state.searchIndex, 0), state.searchMatchIds.length - 1)
      : -1;

    for (const row of rows) {
      if (state.searchMatchIds.includes(row.dataset.id)) {
        row.classList.add('search-hit');
      }
    }

    highlightActiveSearchMatch(scrollToActive);
    updateSearchCounter();
  }

  function moveSearch(delta) {
    if (state.searchMatchIds.length === 0) return;
    state.searchIndex = (state.searchIndex + delta + state.searchMatchIds.length) % state.searchMatchIds.length;
    highlightActiveSearchMatch(true);
    updateSearchCounter();
  }

  function highlightActiveSearchMatch(scrollToActive) {
    Array.from(refs.messageContainer.querySelectorAll('.msg-row')).forEach((row) => {
      row.classList.toggle('search-active', row.dataset.id === state.searchMatchIds[state.searchIndex]);
    });

    if (scrollToActive && state.searchIndex >= 0) {
      scrollRowIntoView(state.searchMatchIds[state.searchIndex]);
    }
  }

  function updateSearchCounter() {
    const current = state.searchMatchIds.length === 0 || state.searchIndex < 0 ? 0 : state.searchIndex + 1;
    refs.searchCounter.textContent = `${current} / ${state.searchMatchIds.length}`;
  }

  function rebuildNavSidebar() {
    refs.navSidebar.innerHTML = '';
    for (const message of state.messages) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-entry tooltip-anchor';
      button.dataset.id = message.id;
      const seqLabel = Number.isFinite(Number(message.seq))
        ? `seq ${message.seq}`
        : (message.entry_kind === 'human_only' ? 'human-only' : 'message');
      button.setAttribute('data-tooltip', `${getAuthorLabel(message)} · ${shortTime(message.created_at)} · ${seqLabel}`);
      button.innerHTML = `<span class="nav-entry-emoji">${escapeHtml(message.author_emoji || '💬')}</span><span class="nav-entry-time">${escapeHtml(shortTime(message.created_at))}</span>`;
      button.addEventListener('click', () => scrollRowIntoView(message.id));
      refs.navSidebar.appendChild(button);
    }
  }

  function updateNavSidebarScrollbarState() {
    if (!refs.navSidebar) {
      return;
    }
    window.requestAnimationFrame(() => {
      // CSS ties layout to this flag: #nav-sidebar vs #nav-sidebar.has-scrollbar.
      // Keep width delta aligned with scrollbar width to avoid clipping timestamps.
      const hasScrollbar = refs.navSidebar.scrollHeight > refs.navSidebar.clientHeight + 1;
      refs.navSidebar.classList.toggle('has-scrollbar', hasScrollbar);
    });
  }

  function updateActiveNavEntry() {
    const rows = Array.from(refs.messageContainer.querySelectorAll('.msg-row'));
    if (rows.length === 0) return;

    let bestRow = rows[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    const viewportTop = refs.messagesScroll.scrollTop;

    for (const row of rows) {
      row.classList.remove('nav-active');
      const distance = Math.abs(row.offsetTop - viewportTop - 16);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestRow = row;
      }
    }

    bestRow.classList.add('nav-active');
    Array.from(refs.navSidebar.querySelectorAll('.nav-entry')).forEach((entry) => {
      entry.classList.toggle('active', entry.dataset.id === bestRow.dataset.id);
    });
  }

  function scrollRowIntoView(messageId) {
    const row = refs.messageContainer.querySelector(`.msg-row[data-id="${cssEscape(messageId)}"]`);
    if (!row) return;
    refs.messagesScroll.scrollTo({ top: row.offsetTop - 12, behavior: 'smooth' });
  }

  function scrollToBottom() {
    refs.messagesScroll.scrollTop = refs.messagesScroll.scrollHeight;
  }

  function isNearBottom() {
    const remaining = refs.messagesScroll.scrollHeight - refs.messagesScroll.scrollTop - refs.messagesScroll.clientHeight;
    return remaining < 72;
  }

  function isOwnMessage(message) {
    const author = String(message.author || message.author_name || '').trim().toLowerCase();
    const localAuthor = String(state.authorName || '').trim().toLowerCase();
    return author === localAuthor || (author === 'system (human)' && (localAuthor === 'human' || localAuthor === 'system (human)'));
  }

  function getAuthorLabel(message) {
    return message.author || message.author_name || message.author_id || 'system';
  }

  function showToast(text) {
    refs.toast.textContent = text;
    refs.toast.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      refs.toast.classList.add('hidden');
    }, 4200);
  }

  function formatTimestamp(value) {
    if (!value) return '';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  }

  function shortTime(value) {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value));
    } catch {
      return '';
    }
  }

  function truncateText(text, maxLength) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (raw.length <= maxLength) return raw;
    return `${raw.slice(0, maxLength - 1)}...`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/([ #;?%&,.+*~\':"!^$\[\]()=>|\/])/g, '\\$1');
  }

  function toAbsoluteUrl(url) {
    const normalized = String(url || '').trim();
    if (!normalized) return '';
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(normalized)) return normalized;
    if (normalized.startsWith('/')) return `${state.baseUrl}${normalized}`;
    return `${state.baseUrl}/${normalized}`;
  }

  function formatError(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  let _booted = false;
  function boot() {
    if (_booted) return;
    _booted = true;
    try {
      init();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const root = document.getElementById('message-container');
      if (root) {
        root.innerHTML = `<div class="empty-state">Chat panel failed to initialize. ${message}</div>`;
      }
    }
  }

  window.addEventListener('beforeunload', () => {
    if (state.connectionTimer) {
      clearInterval(state.connectionTimer);
      state.connectionTimer = null;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.AcbChatPanel = { init: boot };
})();
