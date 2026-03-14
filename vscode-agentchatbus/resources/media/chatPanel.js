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
    messages: [],
    authorName: localStorage.getItem('acb-vscode-author') || 'human',
    agents: [],
    uploadedImages: [],
    replyTarget: null,
    editingMessageId: null,
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
  };

  const INITIAL_RECENT_RENDER_COUNT = 36;
  const OLDER_RENDER_BATCH_SIZE = 48;

  const refs = {};

  function init() {
    refs.messagesScroll = document.getElementById('messages-scroll');
    refs.messageContainer = document.getElementById('message-container');
    refs.loadingIndicator = document.getElementById('loading-indicator');
    refs.navSidebar = document.getElementById('nav-sidebar');
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
    refs.modalBackdrop = document.getElementById('modal-backdrop');
    refs.modalTitle = document.getElementById('modal-title');
    refs.modalContent = document.getElementById('modal-content');
    refs.modalClose = document.getElementById('modal-close');
    refs.toast = document.getElementById('toast');

    setLoading(true);

    refs.authorInput.value = state.authorName;

    refs.authorInput.addEventListener('input', () => {
      state.authorName = refs.authorInput.value.trim() || 'human';
      localStorage.setItem('acb-vscode-author', state.authorName);
    });

    refs.searchInput.addEventListener('input', () => {
      state.searchQuery = refs.searchInput.value.trim();
      runSearch(true);
    });
    refs.searchPrev.addEventListener('click', () => moveSearch(-1));
    refs.searchNext.addEventListener('click', () => moveSearch(1));

    refs.sendButton.addEventListener('click', () => sendMessage());
    refs.uploadButton.addEventListener('click', () => refs.imageInput.click());
    refs.imageInput.addEventListener('change', async () => {
      await uploadFiles(Array.from(refs.imageInput.files || []));
      refs.imageInput.value = '';
    });
    refs.mentionButton.addEventListener('click', (event) => {
      event.preventDefault();
      showMentionMenu('', refs.mentionButton.getBoundingClientRect());
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
    }
  }

  function normalizeMessages(items) {
    return Array.isArray(items) ? items.map(normalizeMessage).sort((a, b) => a.seq - b.seq) : [];
  }

  function normalizeMessage(message) {
    const msg = message || {};
    return {
      ...msg,
      seq: Number(msg.seq || 0),
      edit_version: Number(msg.edit_version || 0),
      reactions: Array.isArray(msg.reactions) ? msg.reactions : [],
      metadata: parseMetadata(msg.metadata),
    };
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
    const existingIndex = state.messages.findIndex((item) => item.id === message.id || item.seq === message.seq);
    if (existingIndex >= 0) {
      state.messages[existingIndex] = normalizeMessage({ ...state.messages[existingIndex], ...message });
    } else {
      state.messages.push(normalizeMessage(message));
      state.messages.sort((a, b) => a.seq - b.seq);
    }
  }

  function renderAll(keepBottom) {
    const token = ++state.renderToken;
    const shouldStickBottom = keepBottom || isNearBottom();
    renderMessages(token, shouldStickBottom);
    rebuildNavSidebar();
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
    row.dataset.seq = String(message.seq || 0);
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
    seq.textContent = `seq ${message.seq}`;
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
    body.appendChild(renderMessageTail(message));

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
    const tail = document.createElement('div');
    tail.className = 'msg-tail';

    tail.appendChild(renderReactionList(message));

    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const replyButton = createActionButton('Reply', () => setReplyTarget(message.id));
    actions.appendChild(replyButton);

    const reactButton = createActionButton('React', (event) => showReactionMenu(message.id, event.currentTarget));
    reactButton.classList.add('msg-action-react');
    actions.appendChild(reactButton);

    if (isOwnMessage(message)) {
      const editButton = createActionButton('Edit', () => beginEdit(message.id));
      actions.appendChild(editButton);
    }

    const historyButton = createActionButton('History', () => void showEditHistory(message.id));
    actions.appendChild(historyButton);

    tail.appendChild(actions);
    return tail;
  }

  function renderReactionList(message) {
    const wrap = document.createElement('div');
    wrap.className = 'reaction-list';

    const grouped = new Map();
    for (const reaction of message.reactions || []) {
      const key = reaction.reaction || '';
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }

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
      remove.textContent = 'x';
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
      showMentionMenu(mentionState.query, mentionState.rect);
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

  function showMentionMenu(query, rect) {
    const needle = String(query || '').toLowerCase();
    state.mentionCandidates = state.agents.filter((agent) => {
      const haystack = `${agent.display_name || ''} ${agent.name || ''} ${agent.id || ''}`.toLowerCase();
      return haystack.includes(needle);
    }).slice(0, 8);

    if (state.mentionCandidates.length === 0) {
      hideMentionMenu();
      return;
    }

    state.mentionIndex = 0;
    refs.mentionMenu.innerHTML = '';
    state.mentionCandidates.forEach((agent, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      if (index === 0) button.classList.add('active');
      button.innerHTML = `<div class="menu-item-title">${escapeHtml(agent.display_name || agent.name || agent.id)}</div><div class="menu-item-meta">${escapeHtml(agent.id || '')}</div>`;
      button.addEventListener('click', () => chooseMention(index));
      refs.mentionMenu.appendChild(button);
    });

    refs.mentionMenu.style.left = `${Math.max(12, Math.min(window.innerWidth - 300, rect.left))}px`;
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
    const candidates = [
      `${state.baseUrl}/api/threads/${encodeURIComponent(state.threadId)}/agents`,
      `${state.baseUrl}/api/agents`,
    ];

    for (const url of candidates) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const payload = await response.json();
        const items = Array.isArray(payload) ? payload : (payload.agents || []);
        state.agents = items.filter(Boolean);
        return;
      } catch {
        // Try next source.
      }
    }
  }

  async function uploadFiles(files) {
    const imageFiles = files.filter((file) => file && String(file.type || '').startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }

    for (const file of imageFiles) {
      const formData = new FormData();
      formData.append('file', file);
      try {
        const response = await fetch(`${state.baseUrl}/api/upload/image`, {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const payload = await response.json();
        state.uploadedImages.push({ url: payload.url, name: payload.name || file.name });
      } catch (error) {
        showToast(`Failed to upload image: ${formatError(error)}`);
      }
    }
    renderImagePreview();
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
      button.className = 'nav-entry';
      button.dataset.id = message.id;
      button.innerHTML = `<span class="nav-entry-emoji">${escapeHtml(message.author_emoji || '💬')}</span><span class="nav-entry-time">${escapeHtml(shortTime(message.created_at))}</span>`;
      button.title = `${getAuthorLabel(message)} · seq ${message.seq}`;
      button.addEventListener('click', () => scrollRowIntoView(message.id));
      refs.navSidebar.appendChild(button);
    }
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
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/')) return `${state.baseUrl}${url}`;
    return `${state.baseUrl}/${url}`;
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.AcbChatPanel = { init: boot };
})();