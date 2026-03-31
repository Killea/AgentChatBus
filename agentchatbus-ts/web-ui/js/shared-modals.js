(function () {
  const MODAL_CONFIGS = {
    thread: {
      overlayId: "modal-overlay",
      visibility: "class",
    },
    agent: {
      overlayId: "agent-modal-overlay",
      visibility: "style",
      styleVisibleValue: "flex",
    },
    settings: {
      overlayId: "settings-modal-overlay",
      visibility: "style",
      styleVisibleValue: "flex",
    },
    "thread-settings": {
      overlayId: "thread-settings-modal-overlay",
      visibility: "style",
      styleVisibleValue: "flex",
    },
  };

  /**
   * Common dialog positioning logic - positions dialog near click coordinate
   * @param {HTMLElement} dialogElement - The dialog element to position
   * @param {number|null} clickX - X coordinate of click (null to center)
   * @param {number|null} clickY - Y coordinate of click (null to center)
   * @param {number} dialogWidth - Width of dialog
   * @param {number} dialogHeight - Height of dialog
   */
  function positionDialogNearClick(dialogElement, clickX, clickY, dialogWidth, dialogHeight) {
    if (!dialogElement || clickX === null || clickY === null) {
      // Center the dialog (default behavior)
      dialogElement.style.position = '';
      dialogElement.style.left = '';
      dialogElement.style.top = '';
      dialogElement.style.margin = '';
      return;
    }

    const padding = 16;
    let left = clickX;
    let top = clickY;

    // If the right edge overflows, shift left
    if (left + dialogWidth > window.innerWidth - padding) {
      left = window.innerWidth - dialogWidth - padding;
    }

    // If the bottom edge overflows, shift up
    if (top + dialogHeight > window.innerHeight - padding) {
      top = window.innerHeight - dialogHeight - padding;
    }

    // Clamp to left and top boundaries
    left = Math.max(padding, left);
    top = Math.max(padding, top);

    dialogElement.style.position = 'fixed';
    dialogElement.style.left = `${left}px`;
    dialogElement.style.top = `${top}px`;
    dialogElement.style.margin = '0';
  }

  function getOverlay(configKey) {
    const cfg = MODAL_CONFIGS[configKey];
    if (!cfg) return null;
    return document.getElementById(cfg.overlayId);
  }

  function setModalVisible(configKey, visible) {
    const cfg = MODAL_CONFIGS[configKey];
    const overlay = getOverlay(configKey);
    if (!cfg || !overlay) return;

    if (cfg.visibility === "class") {
      overlay.classList.toggle("visible", visible);
      return;
    }

    const styleValue = cfg.styleVisibleValue || "block";
    overlay.style.display = visible ? styleValue : "none";
  }

  function isOverlayClick(event, configKey) {
    const overlay = getOverlay(configKey);
    return !!overlay && !!event && event.target === overlay;
  }

  // Cache of available templates populated on first modal open
  let _templates = null;
  const DEFAULT_THREAD_LAUNCH_INTERVAL_SECONDS = 2;
  const MAX_THREAD_LAUNCH_AGENTS = 4;
  const THREAD_LAUNCH_ADAPTER_STORAGE_KEY = "acb.threadLaunchAdapters.v1";
  const THREAD_LAUNCH_MODEL_CACHE_KEY = "acb.threadLaunchModels.v2";
  const THREAD_LAUNCH_SELECTIONS_STORAGE_KEY = "acb.threadLaunchSelections.v1";
  // Keep this list aligned with agentchatbus-ts/src/main.ts and src/main.py so
  // the launch picker matches the server-side deterministic emoji pool.
  const THREAD_LAUNCH_EMOJI_OPTIONS = [
    // animals
    "🦊", "🐼", "🐸", "🐙", "🦄", "🐯", "🦁", "🐵", "🐧", "🐢",
    "🦉", "🐳", "🐝", "🦋", "🪲", "🦀", "🐞", "🦎", "🐊", "🐠",
    "🐬", "🦖", "🦒", "🦓", "🦔", "🦦", "🦥", "🦩", "🐘", "🦛",
    "🐨", "🐹", "🐰", "🐮", "🐷", "🐔", "🐧",
    // plants & nature
    "🌵", "🌲", "🌴", "🌿", "🍄", "🪴", "🍀",
    // food
    "🍉", "🍓", "🍒", "🍍", "🥑", "🌽", "🍕", "🍣", "🍜", "🍪",
    "🍩", "🍫",
    // objects & tools
    "⚡", "🔥", "💡", "🔭", "🧪", "🧬", "🧭", "🪐", "🛰️", "📡",
    "🔧", "🛠️", "🧰", "🧲", "🧯", "🔒", "🔑", "📌", "📎", "📚",
    "🗺️", "🧠",
    // games & music
    "🎯", "🧩", "🎲", "♟️", "🎸", "🎧", "🎷",
    // travel & misc
    "🚲", "🛶", "🏄", "🧳", "🏺", "🪁", "🪄", "🧵", "🧶", "🪙", "🗝️",
  ];
  let _threadLaunchAgents = [];
  let _selectedThreadLaunchAgentId = "";
  let _cliModelDiscovery = null;
  let _cliModelDiscoveryLoading = false;
  let _threadLaunchPromptPreviewRequestId = 0;
  let _manualLaunchPromptPreviewRequestId = 0;
  const SERVER_PROMPT_PREVIEW_PENDING_TEXT = "Resolving launch prompt from server...";

  function createEmptyCliModelDiscovery() {
    return {
      fetched_at: null,
      providers: {
        codex: { adapter: "codex", status: "ready", strategy: "static", models: [], fetched_at: "", source_label: "Static fallback" },
        cursor: { adapter: "cursor", status: "ready", strategy: "static", models: [], fetched_at: "", source_label: "Static fallback" },
        claude: { adapter: "claude", status: "ready", strategy: "static", models: [], fetched_at: "", source_label: "Static fallback" },
        gemini: { adapter: "gemini", status: "ready", strategy: "static", models: [], fetched_at: "", source_label: "Static fallback" },
        copilot: { adapter: "copilot", status: "ready", strategy: "static", models: [], fetched_at: "", source_label: "Static fallback" },
      },
    };
  }

  function normalizeCliModelDiscovery(payload) {
    const base = createEmptyCliModelDiscovery();
    const providers = payload && typeof payload === "object" && payload.providers && typeof payload.providers === "object"
      ? payload.providers
      : {};
    for (const adapter of Object.keys(base.providers)) {
      const next = providers[adapter];
      if (!next || typeof next !== "object") {
        continue;
      }
      base.providers[adapter] = {
        adapter,
        status: String(next.status || "ready"),
        strategy: String(next.strategy || "static"),
        models: Array.isArray(next.models)
          ? next.models
            .map((model) => ({
              id: normalizeThreadLaunchModelValue(adapter, model?.id),
              label: String(model?.label || model?.id || "").trim(),
              description: String(model?.description || "").trim(),
              hidden: model?.hidden === true,
              is_default: model?.is_default === true,
              default_reasoning_effort: String(model?.default_reasoning_effort || "").trim().toLowerCase(),
              supported_reasoning_efforts: Array.isArray(model?.supported_reasoning_efforts)
                ? model.supported_reasoning_efforts
                  .map((option) => ({
                    id: String(option?.id || "").trim().toLowerCase(),
                    label: String(option?.label || option?.id || "").trim(),
                  }))
                  .filter((option) => option.id)
                : [],
            }))
            .filter((model) => model.id)
            .filter((model) => adapter !== "codex" || model.hidden !== true)
          : [],
        fetched_at: String(next.fetched_at || ""),
        source_label: String(next.source_label || "Static fallback"),
        error: next.error ? String(next.error) : "",
      };
    }
    base.fetched_at = payload && typeof payload === "object" && payload.fetched_at
      ? String(payload.fetched_at)
      : null;
    return base;
  }

  function readCliModelDiscoveryCache() {
    try {
      const raw = globalThis.localStorage?.getItem(THREAD_LAUNCH_MODEL_CACHE_KEY);
      if (!raw) {
        return null;
      }
      return normalizeCliModelDiscovery(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function writeCliModelDiscoveryCache(snapshot) {
    try {
      globalThis.localStorage?.setItem(
        THREAD_LAUNCH_MODEL_CACHE_KEY,
        JSON.stringify(snapshot),
      );
    } catch {
      // Ignore storage failures and keep the modal usable.
    }
  }

  function getCliModelDiscovery() {
    if (!_cliModelDiscovery) {
      _cliModelDiscovery = readCliModelDiscoveryCache() || createEmptyCliModelDiscovery();
    }
    return _cliModelDiscovery;
  }

  function getModelDiscoveryEntry(adapter) {
    const snapshot = getCliModelDiscovery();
    return snapshot.providers?.[adapter] || null;
  }

  function getThreadLaunchAgentModelOptions(agent) {
    const entry = getModelDiscoveryEntry(String(agent?.adapter || "codex").trim() || "codex");
    const models = Array.isArray(entry?.models) ? entry.models : [];
    const currentModel = String(agent?.model || "").trim();
    const normalized = models
      .map((model) => ({
        id: String(model?.id || "").trim(),
        label: String(model?.label || model?.id || "").trim(),
      }))
      .filter((model) => model.id);
    if (currentModel && !normalized.some((model) => model.id === currentModel)) {
      normalized.unshift({
        id: currentModel,
        label: `${currentModel} (Custom)`,
      });
    }
    return normalized;
  }

  function formatThreadLaunchModelDisplayName(label) {
    const value = String(label || "").trim();
    if (!value) {
      return "";
    }
    if (!value.toLowerCase().startsWith("gpt")) {
      return value;
    }
    return value
      .split(/(\s+)/)
      .map((token) => {
        if (!token.trim()) {
          return token;
        }
        return token
          .split("-")
          .map((segment, index) => {
            if (segment.toLowerCase() === "gpt") {
              return "GPT";
            }
            if (index > 0 && segment.length > 0) {
              return `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`;
            }
            return segment;
          })
          .join("-");
      })
      .join("");
  }

  function formatReasoningEffortLabel(effort) {
    const normalized = String(effort || "").trim().toLowerCase();
    if (normalized === "minimal") return "Minimal";
    if (normalized === "low") return "Low";
    if (normalized === "medium") return "Medium";
    if (normalized === "high") return "High";
    if (normalized === "xhigh") return "Extra High";
    return normalized ? normalized : "";
  }

  function getThreadLaunchSelectedModelEntry(agent) {
    const entry = getModelDiscoveryEntry(String(agent?.adapter || "codex").trim() || "codex");
    const models = Array.isArray(entry?.models) ? entry.models : [];
    const currentModel = getRequiredThreadLaunchModel(agent?.adapter, agent?.model);
    return models.find((model) => (
      String(model?.id || "").trim() === currentModel
      && !(String(agent?.adapter || "").trim().toLowerCase() === "codex" && model?.hidden === true)
    )) || null;
  }

  function buildThreadLaunchModelOptionsHtml(agent) {
    const options = getThreadLaunchAgentModelOptions(agent);
    return options.map((model) => (
      `<option value="${_escapeHtml(model.id)}">${_escapeHtml(formatThreadLaunchModelDisplayName(model.label || model.id))}</option>`
    )).join("");
  }

  function formatDiscoveryTime(isoString) {
    const value = String(isoString || "").trim();
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function buildModelDiscoveryStatusText() {
    const snapshot = getCliModelDiscovery();
    if (_cliModelDiscoveryLoading) {
      return "Detecting models...";
    }
    if (!snapshot?.fetched_at) {
      return "Never detected";
    }
    const entries = Object.values(snapshot.providers || {});
    const readyCount = entries.filter((entry) => entry.status === "ready").length;
    const runtimeCount = entries.filter((entry) => entry.strategy === "runtime").length;
    const helpCount = entries.filter((entry) => entry.strategy === "help").length;
    const staticCount = entries.filter((entry) => entry.strategy === "static").length;
    return `Ready ${readyCount}/5 · Runtime ${runtimeCount} · Help ${helpCount} · Static ${staticCount} · ${formatDiscoveryTime(snapshot.fetched_at)}`;
  }

  function renderModelDiscoverySummary() {
    const summaryEl = document.getElementById("thread-launch-model-summary");
    if (!summaryEl) {
      return;
    }
    const snapshot = getCliModelDiscovery();
    const providers = ["cursor", "copilot", "claude", "codex", "gemini"];
    summaryEl.innerHTML = providers.map((adapter) => {
      const entry = snapshot.providers?.[adapter];
      if (!entry) {
        return "";
      }
      const label = adapter === "cursor" ? "Cursor"
        : adapter === "claude" ? "Claude"
        : adapter === "gemini" ? "Gemini"
        : adapter === "copilot" ? "Copilot"
        : "Codex";
      const detail = `${entry.source_label} · ${Array.isArray(entry.models) ? entry.models.length : 0} models`;
      const error = entry.error ? ` · ${entry.error}` : "";
      return `<span class="thread-launch-model-summary__item">${_escapeHtml(label)}: ${_escapeHtml(detail)}${_escapeHtml(error)}</span>`;
    }).filter(Boolean).join("");
  }

  function syncModelDiscoveryUi() {
    const statusEl = document.getElementById("thread-launch-model-status");
    const buttonEl = document.getElementById("thread-launch-detect-models");
    if (statusEl) {
      statusEl.textContent = buildModelDiscoveryStatusText();
    }
    if (buttonEl) {
      buttonEl.disabled = _cliModelDiscoveryLoading;
      buttonEl.textContent = _cliModelDiscoveryLoading ? "Detecting..." : (getCliModelDiscovery()?.fetched_at ? "Refresh Models" : "Detect Models");
    }
    renderModelDiscoverySummary();
  }

  async function loadCliModelDiscovery(api, options = {}) {
    if (!_cliModelDiscovery) {
      _cliModelDiscovery = readCliModelDiscoveryCache() || createEmptyCliModelDiscovery();
    }
    syncModelDiscoveryUi();
    if (!api || _cliModelDiscoveryLoading) {
      return _cliModelDiscovery;
    }
    _cliModelDiscoveryLoading = true;
    syncModelDiscoveryUi();
    try {
      const path = options.force === true ? "/api/cli-models/discover" : "/api/cli-models";
      const method = options.force === true ? "POST" : "GET";
      const payload = await api(path, { method });
      if (payload) {
        const normalized = normalizeCliModelDiscovery(payload);
        _cliModelDiscovery = normalized;
        writeCliModelDiscoveryCache(_cliModelDiscovery);
      }
    } finally {
      _cliModelDiscoveryLoading = false;
      syncModelDiscoveryUi();
      renderThreadLaunchAgents();
    }
    return _cliModelDiscovery;
  }

  function readThreadLaunchAdapterPreferences() {
    const selectionPreferences = readThreadLaunchSelectionPreferences();
    if (selectionPreferences.length > 0) {
      return selectionPreferences
        .map((entry) => String(entry?.adapter || "").trim().toLowerCase())
        .filter((value) => value === "codex" || value === "cursor" || value === "claude" || value === "gemini" || value === "copilot");
    }
    try {
      const raw = globalThis.localStorage?.getItem(THREAD_LAUNCH_ADAPTER_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => value === "codex" || value === "cursor" || value === "claude" || value === "gemini" || value === "copilot");
    } catch {
      return [];
    }
  }

  function readThreadLaunchSelectionPreferences() {
    try {
      const raw = globalThis.localStorage?.getItem(THREAD_LAUNCH_SELECTIONS_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((entry) => {
          const adapter = String(entry?.adapter || "").trim().toLowerCase();
          const model = String(entry?.model || "").trim();
          if (!(adapter === "codex" || adapter === "cursor" || adapter === "claude" || adapter === "gemini" || adapter === "copilot")) {
            return null;
          }
          return {
            adapter,
            model: normalizeThreadLaunchModelValue(adapter, model),
            reasoning_effort: normalizeThreadLaunchReasoningEffort(adapter, entry?.reasoning_effort),
          };
        })
        .filter((entry) => Boolean(entry));
    } catch {
      return [];
    }
  }

  function writeThreadLaunchAdapterPreferences() {
    try {
      const adapters = _threadLaunchAgents
        .map((agent) => String(agent?.adapter || "").trim().toLowerCase())
        .map((value) => (value === "cursor" || value === "claude" || value === "gemini" || value === "copilot" ? value : "codex"));
      globalThis.localStorage?.setItem(
        THREAD_LAUNCH_ADAPTER_STORAGE_KEY,
        JSON.stringify(adapters),
      );
    } catch {
      // Ignore storage failures and keep the modal usable.
    }
  }

  function writeThreadLaunchSelectionPreferences() {
    try {
      const selections = _threadLaunchAgents.map((agent) => ({
        adapter: String(agent?.adapter || "").trim().toLowerCase() || "claude",
        model: normalizeThreadLaunchModelValue(agent?.adapter, agent?.model),
        reasoning_effort: normalizeThreadLaunchReasoningEffort(agent?.adapter, agent?.reasoningEffort),
      }));
      globalThis.localStorage?.setItem(
        THREAD_LAUNCH_SELECTIONS_STORAGE_KEY,
        JSON.stringify(selections),
      );
    } catch {
      // Ignore storage failures and keep the modal usable.
    }
  }

  function writeThreadLaunchSelectionPreferencesFromConfig(config) {
    try {
      const existing = readThreadLaunchSelectionPreferences();
      const nextEntry = {
        adapter: String(config?.adapter || "").trim().toLowerCase() || "claude",
        model: normalizeThreadLaunchModelValue(config?.adapter, config?.model),
        reasoning_effort: normalizeThreadLaunchReasoningEffort(config?.adapter, config?.reasoningEffort),
      };
      const nextSelections = [nextEntry, ...existing.slice(1)];
      globalThis.localStorage?.setItem(
        THREAD_LAUNCH_SELECTIONS_STORAGE_KEY,
        JSON.stringify(nextSelections),
      );
    } catch {
      // Ignore storage failures and keep the modal usable.
    }
  }

  function getPreferredThreadLaunchAdapter(slotIndex, fallback = "claude") {
    const normalizedFallback = String(fallback || "claude").trim().toLowerCase();
    const preferences = readThreadLaunchAdapterPreferences();
    const preferred = String(preferences[slotIndex] || "").trim().toLowerCase();
    if (preferred === "codex" || preferred === "cursor" || preferred === "claude" || preferred === "gemini" || preferred === "copilot") {
      return preferred;
    }
    if (normalizedFallback === "codex" || normalizedFallback === "cursor" || normalizedFallback === "claude" || normalizedFallback === "gemini" || normalizedFallback === "copilot") {
      return normalizedFallback;
    }
    return "claude";
  }

  function getPreferredThreadLaunchModel(slotIndex) {
    const preferences = readThreadLaunchSelectionPreferences();
    return String(preferences[slotIndex]?.model || "").trim();
  }

  function getPreferredThreadLaunchReasoningEffort(slotIndex) {
    const preferences = readThreadLaunchSelectionPreferences();
    return String(preferences[slotIndex]?.reasoning_effort || "").trim();
  }

  function normalizeThreadLaunchModelValue(adapter, model) {
    const normalizedAdapter = String(adapter || "").trim().toLowerCase();
    const normalizedModel = String(model || "").trim();
    if (normalizedAdapter === "cursor") {
      return normalizedModel || "auto";
    }
    return normalizedModel;
  }

  function getRequiredThreadLaunchModel(adapter, model) {
    return normalizeThreadLaunchModelValue(adapter, model);
  }

  function normalizeThreadLaunchReasoningEffort(adapter, reasoningEffort) {
    const normalizedAdapter = String(adapter || "").trim().toLowerCase();
    if (normalizedAdapter !== "codex") {
      return "";
    }
    const normalized = String(reasoningEffort || "").trim().toLowerCase();
    if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
      return normalized;
    }
    return "";
  }

  function getThreadLaunchAgentReasoningOptions(agent) {
    if (String(agent?.adapter || "").trim().toLowerCase() !== "codex") {
      return [];
    }
    const selectedModel = getThreadLaunchSelectedModelEntry(agent);
    const supported = Array.isArray(selectedModel?.supported_reasoning_efforts)
      ? selectedModel.supported_reasoning_efforts
      : [];
    const normalizedSupported = supported
      .map((option) => ({
        id: normalizeThreadLaunchReasoningEffort("codex", option?.id),
        label: String(option?.label || option?.id || "").trim(),
      }))
      .filter((option) => option.id);
    if (normalizedSupported.length > 0) {
      return normalizedSupported;
    }
    return [
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ];
  }

  function syncThreadLaunchAgentReasoningForModel(agent) {
    if (!agent || String(agent.adapter || "").trim().toLowerCase() !== "codex") {
      if (agent) {
        agent.reasoningEffort = "";
      }
      return;
    }
    const selectedModel = getThreadLaunchSelectedModelEntry(agent);
    const availableIds = getThreadLaunchAgentReasoningOptions(agent)
      .map((option) => normalizeThreadLaunchReasoningEffort(agent.adapter, option.id))
      .filter(Boolean);
    const current = normalizeThreadLaunchReasoningEffort(agent.adapter, agent.reasoningEffort);
    if (current && availableIds.includes(current)) {
      agent.reasoningEffort = current;
      return;
    }
    const defaultReasoning = normalizeThreadLaunchReasoningEffort(
      agent.adapter,
      selectedModel?.default_reasoning_effort,
    );
    agent.reasoningEffort = defaultReasoning && availableIds.includes(defaultReasoning)
      ? defaultReasoning
      : "";
  }

  function buildThreadLaunchReasoningOptionsHtml(agent) {
    if (String(agent?.adapter || "").trim().toLowerCase() !== "codex") {
      return '<option value="">Not supported for this adapter</option>';
    }
    const normalized = normalizeThreadLaunchReasoningEffort(agent.adapter, agent.reasoningEffort);
    const selectedModel = getThreadLaunchSelectedModelEntry(agent);
    const defaultReasoning = normalizeThreadLaunchReasoningEffort(
      agent.adapter,
      selectedModel?.default_reasoning_effort,
    );
    const options = getThreadLaunchAgentReasoningOptions(agent);
    const defaultLabel = defaultReasoning
      ? `Use Codex default (${formatReasoningEffortLabel(defaultReasoning)})`
      : "Use Codex default";
    return [
      `<option value="" ${!normalized ? "selected" : ""}>${_escapeHtml(defaultLabel)}</option>`,
      ...options.map((option) => (
        `<option value="${_escapeHtml(option.id)}" ${normalized === option.id ? "selected" : ""}>${_escapeHtml(formatReasoningEffortLabel(option.id) || option.label || option.id)}</option>`
      )),
    ].join("");
  }

  function getThreadLaunchReasoningMeta(agent) {
    if (String(agent?.adapter || "").trim().toLowerCase() !== "codex") {
      return "Official reasoning level is currently only wired for Codex.";
    }
    const normalized = normalizeThreadLaunchReasoningEffort(agent.adapter, agent.reasoningEffort);
    const selectedModel = getThreadLaunchSelectedModelEntry(agent);
    const defaultReasoning = normalizeThreadLaunchReasoningEffort(
      agent.adapter,
      selectedModel?.default_reasoning_effort,
    );
    const optionCount = getThreadLaunchAgentReasoningOptions(agent).length;
    return normalized
      ? `Codex reasoning override: ${formatReasoningEffortLabel(normalized)}`
      : (defaultReasoning
        ? `Using ${formatThreadLaunchModelDisplayName(selectedModel?.label || selectedModel?.id || "Codex")} default: ${formatReasoningEffortLabel(defaultReasoning)} · ${optionCount} supported`
        : "Use Codex default reasoning from CLI/app-server configuration.");
  }

  function buildThreadLaunchModelMetaHtml(agent) {
    const entry = getModelDiscoveryEntry(agent.adapter);
    const selectedModel = getThreadLaunchSelectedModelEntry(agent);
    const source = String(entry?.source_label || "Static fallback").trim();
    const count = Array.isArray(entry?.models) ? entry.models.length : 0;
    const when = formatDiscoveryTime(entry?.fetched_at || getCliModelDiscovery()?.fetched_at || "");
    const error = entry?.error ? ` · ${String(entry.error)}` : "";
    const sourceLine = `${source} · ${count} suggestions${when ? ` · ${when}` : ""}${error}`;
    const title = formatThreadLaunchModelDisplayName(
      selectedModel?.label || selectedModel?.id || getRequiredThreadLaunchModel(agent.adapter, agent.model),
    );
    const description = String(selectedModel?.description || "").trim();
    const badges = [];
    if (selectedModel?.is_default) {
      badges.push('<span class="thread-launch-model-badge">Default</span>');
    }
    const defaultReasoning = normalizeThreadLaunchReasoningEffort(
      agent.adapter,
      selectedModel?.default_reasoning_effort,
    );
    if (defaultReasoning) {
      badges.push(`<span class="thread-launch-model-badge">Reasoning ${_escapeHtml(formatReasoningEffortLabel(defaultReasoning))}</span>`);
    }
    const detailLine = selectedModel
      ? `
        <div class="thread-launch-model-selected">
          <div class="thread-launch-model-selected__title">${_escapeHtml(title)}</div>
          ${badges.length ? `<div class="thread-launch-model-badges">${badges.join("")}</div>` : ""}
          ${description ? `<div class="thread-launch-model-selected__description">${_escapeHtml(description)}</div>` : ""}
        </div>
      `
      : "";
    return `
      <div class="thread-launch-model-meta__source">${_escapeHtml(sourceLine)}</div>
      ${detailLine}
    `;
  }

  async function _loadTemplates(api) {
    if (_templates !== null) return _templates;
    try {
      const result = await api("/api/templates");
      _templates = Array.isArray(result) ? result : [];
    } catch {
      // Keep cache unset on failure so future modal opens can retry.
      return [];
    }
    return _templates;
  }

  function _populateTemplateDropdown(templates) {
    const sel = document.getElementById("modal-template");
    if (!sel) return;
    // Keep the first built-in default option, remove the rest
    while (sel.options.length > 1) sel.remove(1);
    for (const t of templates) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name + (t.is_builtin ? "" : " ★");
      opt.dataset.description = t.description || "";
      sel.appendChild(opt);
    }
    sel.onchange = () => {
      const desc = document.getElementById("modal-template-desc");
      if (!desc) return;
      const selected = sel.options[sel.selectedIndex];
      desc.textContent = selected ? (selected.dataset.description || "") : "";
    };
  }

  function getThreadLaunchMode() {
    return document.querySelector('input[name="thread-launch-mode"]:checked')?.value || "thread_with_agent";
  }

  function syncThreadLaunchUi() {
    const mode = getThreadLaunchMode();
    const modalEl = document.getElementById("modal");
    const layoutEl = document.getElementById("thread-create-layout");
    const configEl = document.getElementById("thread-agent-config");
    const sideEl = document.getElementById("thread-agent-side");
    const agentActionsEl = document.getElementById("thread-agent-actions");
    const threadOnlyActionsEl = document.getElementById("thread-thread-only-actions");
    const submitBtn = document.getElementById("btn-create-thread");
    const submitBtnThreadOnly = document.getElementById("btn-create-thread-only");
    const agentCount = Math.max(
      1,
      Number(document.getElementById("thread-launch-agents-list")?.dataset.agentCount || "1"),
    );
    const isWithAgent = mode === "thread_with_agent";
    if (modalEl) {
      modalEl.classList.toggle("modal--thread-only", !isWithAgent);
    }
    if (layoutEl) {
      layoutEl.classList.toggle("meeting-modal-layout--single", true);
    }
    if (configEl) {
      configEl.classList.toggle("meeting-modal-hidden", !isWithAgent);
    }
    if (sideEl) {
      sideEl.classList.toggle("meeting-modal-hidden", !isWithAgent);
    }
    if (agentActionsEl) {
      agentActionsEl.classList.toggle("meeting-modal-hidden", !isWithAgent);
    }
    if (threadOnlyActionsEl) {
      threadOnlyActionsEl.classList.toggle("meeting-modal-hidden", isWithAgent);
    }
    if (submitBtn) {
      submitBtn.textContent = isWithAgent
        ? (agentCount > 1 ? "Create and Start Agents" : "Create and Start First Agent")
        : "Create Thread";
    }
    if (submitBtnThreadOnly) {
      submitBtnThreadOnly.textContent = "Create Thread";
    }
  }

  function resetAgentForm(prefix) {
    const adapterEl = document.getElementById(`${prefix}-adapter`);
    const modeEl = document.getElementById(`${prefix}-mode`);
    const modelEl = document.getElementById(`${prefix}-model`);
    const modelSuggestionEl = document.getElementById(`${prefix}-model-suggestion`);
    const reasoningEl = document.getElementById(`${prefix}-reasoning-effort`);
    const displayNameEl = document.getElementById(`${prefix}-display-name`);
    const emojiEl = document.getElementById(`${prefix}-emoji`);
    const emojiPreviewEl = document.getElementById(`${prefix}-emoji-preview`);
    const instructionEl = document.getElementById(`${prefix}-instruction`);
    const preferredAdapter = getPreferredThreadLaunchAdapter(0, "claude");
    const preferredModel = getRequiredThreadLaunchModel(
      preferredAdapter,
      getPreferredThreadLaunchModel(0),
    );
    const preferredReasoningEffort = normalizeThreadLaunchReasoningEffort(
      preferredAdapter,
      getPreferredThreadLaunchReasoningEffort(0),
    );
    const preferredEmoji = pickRandomThreadLaunchEmoji();
    if (adapterEl) adapterEl.value = preferredAdapter;
    if (modeEl) modeEl.value = getThreadLaunchModeForAdapter(preferredAdapter);
    if (modelEl) modelEl.value = preferredModel;
    if (modelSuggestionEl) modelSuggestionEl.value = "";
    if (reasoningEl) reasoningEl.value = preferredReasoningEffort;
    if (displayNameEl) displayNameEl.value = "";
    if (emojiEl) {
      emojiEl.innerHTML = THREAD_LAUNCH_EMOJI_OPTIONS.map((emoji) => (
        `<option value="${_escapeHtml(emoji)}" ${emoji === preferredEmoji ? "selected" : ""}>${_escapeHtml(emoji)}</option>`
      )).join("");
      emojiEl.value = preferredEmoji;
    }
    if (emojiPreviewEl) {
      emojiPreviewEl.textContent = preferredEmoji;
    }
    if (instructionEl) instructionEl.value = "";
    syncAddAgentModelControls(prefix);
  }

  function resetAutoAssembleForm() {
    const goalEl = document.getElementById("agent-auto-goal");
    const maxEl = document.getElementById("agent-auto-max");
    const adaptersEl = document.getElementById("agent-auto-adapters");
    if (goalEl) goalEl.value = "";
    if (maxEl) maxEl.value = "2";
    if (adaptersEl) adaptersEl.value = "any";
  }

  function getAddAgentTab() {
    return document.getElementById("agent-modal")?.dataset.activeTab || "manual";
  }

  function switchAddAgentTab(tabId) {
    const nextTab = tabId === "auto" ? "auto" : "manual";
    const modalEl = document.getElementById("agent-modal");
    if (!modalEl) return nextTab;
    modalEl.dataset.activeTab = nextTab;

    const tabs = [
      {
        id: "manual",
        button: document.getElementById("agent-modal-tab-manual"),
        panel: document.getElementById("agent-modal-panel-manual"),
      },
      {
        id: "auto",
        button: document.getElementById("agent-modal-tab-auto"),
        panel: document.getElementById("agent-modal-panel-auto"),
      },
    ];

    tabs.forEach((tab) => {
      const active = tab.id === nextTab;
      if (tab.button) {
        tab.button.classList.toggle("is-active", active);
        tab.button.setAttribute("aria-selected", active ? "true" : "false");
      }
      if (tab.panel) {
        tab.panel.classList.toggle("meeting-modal-hidden", !active);
        tab.panel.classList.toggle("is-active", active);
      }
    });

    const submitBtn = document.getElementById("btn-add-agent-submit");
    if (submitBtn) {
      submitBtn.disabled = nextTab !== "manual";
      submitBtn.textContent = nextTab === "manual" ? "Add Agent" : "Planning Soon";
    }

    return nextTab;
  }

  function readAgentLaunchConfig(prefix) {
    const adapter = String(document.getElementById(`${prefix}-adapter`)?.value || "codex").trim();
    const defaultMode = getThreadLaunchModeForAdapter(adapter);
    const requestedMode = String(document.getElementById(`${prefix}-mode`)?.value || defaultMode).trim();
    const mode = normalizeThreadLaunchMode(adapter, requestedMode || defaultMode);
    const model = getRequiredThreadLaunchModel(
      adapter,
      String(document.getElementById(`${prefix}-model`)?.value || "").trim(),
    );
    const reasoningEffort = normalizeThreadLaunchReasoningEffort(
      adapter,
      String(document.getElementById(`${prefix}-reasoning-effort`)?.value || "").trim(),
    );
    const displayName = String(document.getElementById(`${prefix}-display-name`)?.value || "").trim();
    const emoji = String(document.getElementById(`${prefix}-emoji`)?.value || "").trim();
    const initialInstruction = String(document.getElementById(`${prefix}-instruction`)?.value || "").trim();
    return {
      adapter,
      model,
      reasoningEffort,
      mode,
      meetingTransport: "agent_mcp",
      displayName,
      emoji,
      initialInstruction,
    };
  }

  function buildAddAgentModelOptionsHtml(adapter, currentModel = "") {
    const options = getThreadLaunchAgentModelOptions({
      adapter,
      model: currentModel,
    });
    return options.map((model) => (
      `<option value="${_escapeHtml(model.id)}">${_escapeHtml(model.label || model.id)}</option>`
    )).join("");
  }

  function syncAddAgentModelControls(prefix) {
    const adapterEl = document.getElementById(`${prefix}-adapter`);
    const modelEl = document.getElementById(`${prefix}-model`);
    const suggestionEl = document.getElementById(`${prefix}-model-suggestion`);
    const reasoningEl = document.getElementById(`${prefix}-reasoning-effort`);
    const modeEl = document.getElementById(`${prefix}-mode`);
    const emojiEl = document.getElementById(`${prefix}-emoji`);
    const emojiPreviewEl = document.getElementById(`${prefix}-emoji-preview`);
    if (!adapterEl) {
      return;
    }
    const adapter = String(adapterEl.value || "claude").trim() || "claude";
    if (modeEl) {
      const currentMode = String(modeEl.value || getThreadLaunchModeForAdapter(adapter)).trim();
      modeEl.innerHTML = buildThreadLaunchModeOptionsHtml(adapter, currentMode);
      modeEl.value = normalizeThreadLaunchMode(adapter, currentMode);
    }
    if (modelEl) {
      modelEl.value = getRequiredThreadLaunchModel(adapter, modelEl.value);
      modelEl.required = !(adapter === "cursor" || adapter === "gemini");
    }
    if (suggestionEl) {
      const currentModel = String(modelEl?.value || "").trim();
      suggestionEl.innerHTML = `<option value="">Suggestions</option>${buildAddAgentModelOptionsHtml(adapter, currentModel)}`;
      suggestionEl.value = "";
    }
    if (reasoningEl) {
      reasoningEl.innerHTML = buildThreadLaunchReasoningOptionsHtml(adapter, reasoningEl.value);
      reasoningEl.value = normalizeThreadLaunchReasoningEffort(adapter, reasoningEl.value);
      reasoningEl.disabled = adapter !== "codex";
    }
    if (emojiEl && emojiPreviewEl) {
      emojiPreviewEl.textContent = String(emojiEl.value || "").trim() || "🤖";
    }
  }

  function buildDefaultParticipantName(config) {
    if (config.displayName) {
      return config.displayName;
    }
    const adapterLabel = config.adapter === "cursor" ? "Cursor" :
                         config.adapter === "claude" ? "Claude" :
                         config.adapter === "gemini" ? "Gemini" :
                         config.adapter === "copilot" ? "Copilot" : "Codex";
    return adapterLabel;
  }

  function getThreadLaunchModeForAdapter(adapter) {
    const normalizedAdapter = String(adapter || "").trim().toLowerCase();
    if (normalizedAdapter === "codex") {
      return "direct";
    }
    return "interactive";
  }

  function normalizeThreadLaunchMode(adapter, currentMode) {
    const normalizedAdapter = String(adapter || "").trim().toLowerCase();
    const requested = String(currentMode || "").trim().toLowerCase();
    if (normalizedAdapter === "codex") {
      if (requested === "headless" || requested === "interactive" || requested === "direct") {
        return requested;
      }
      return "direct";
    }
    return requested === "headless" ? "headless" : "interactive";
  }

  function getThreadLaunchModeLabel(mode) {
    if (mode === "direct") {
      return "Codex Direct (App Server)";
    }
    return mode === "headless" ? "Headless JSON Resume" : "Interactive PTY";
  }

  function buildThreadLaunchModeOptionsHtml(adapter, currentMode = "") {
    const normalizedAdapter = String(adapter || "").trim().toLowerCase();
    const normalized = normalizeThreadLaunchMode(adapter, currentMode);
    const options = [];
    if (normalizedAdapter === "codex") {
      options.push(
        `<option value="direct" ${normalized === "direct" ? "selected" : ""}>Codex Direct (App Server)</option>`,
      );
    }
    options.push(
      `<option value="interactive" ${normalized === "interactive" ? "selected" : ""}>Interactive PTY</option>`,
      `<option value="headless" ${normalized === "headless" ? "selected" : ""}>Headless JSON Resume</option>`,
    );
    return options.join("");
  }

  function getThreadLaunchUsedEmojis(excludeAgentId = "") {
    const excluded = String(excludeAgentId || "").trim();
    return new Set(
      _threadLaunchAgents
        .filter((agent) => String(agent?.id || "").trim() !== excluded)
        .map((agent) => String(agent?.emoji || "").trim())
        .filter((emoji) => THREAD_LAUNCH_EMOJI_OPTIONS.includes(emoji)),
    );
  }

  function pickRandomThreadLaunchEmoji(excludeAgentId = "") {
    const used = getThreadLaunchUsedEmojis(excludeAgentId);
    const available = THREAD_LAUNCH_EMOJI_OPTIONS.filter((emoji) => !used.has(emoji));
    const pool = available.length ? available : THREAD_LAUNCH_EMOJI_OPTIONS.slice();
    if (!pool.length) {
      return "🤖";
    }
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      const bytes = new Uint32Array(1);
      globalThis.crypto.getRandomValues(bytes);
      return pool[bytes[0] % pool.length];
    }
    return pool[Math.floor(Math.random() * pool.length)] || pool[0];
  }

  function getThreadLaunchEmojiOptions(agentId) {
    const current = String(getThreadLaunchAgentById(agentId)?.emoji || "").trim();
    const used = getThreadLaunchUsedEmojis(agentId);
    return THREAD_LAUNCH_EMOJI_OPTIONS.filter((emoji) => emoji === current || !used.has(emoji));
  }

  function buildThreadLaunchEmojiOptionsHtml(agentId) {
    const current = String(getThreadLaunchAgentById(agentId)?.emoji || "").trim() || "🤖";
    return getThreadLaunchEmojiOptions(agentId).map((emoji) => (
      `<option value="${_escapeHtml(emoji)}" ${emoji === current ? "selected" : ""}>${_escapeHtml(emoji)}</option>`
    )).join("");
  }

  function createThreadLaunchAgent(overrides = {}, slotIndex = 0) {
    const requestedAdapter = String(overrides.adapter || "").trim().toLowerCase();
    const adapter = getPreferredThreadLaunchAdapter(
      slotIndex,
      requestedAdapter || "claude",
    );
    const preferredModel = getRequiredThreadLaunchModel(
      adapter,
      String(overrides.model || "").trim() || getPreferredThreadLaunchModel(slotIndex),
    );
    const preferredReasoningEffort = normalizeThreadLaunchReasoningEffort(
      adapter,
      String(overrides.reasoningEffort || "").trim() || getPreferredThreadLaunchReasoningEffort(slotIndex),
    );
    const requestedEmoji = String(overrides.emoji || "").trim();
    const fallbackEmoji = pickRandomThreadLaunchEmoji();
    const emoji = THREAD_LAUNCH_EMOJI_OPTIONS.includes(requestedEmoji)
      ? requestedEmoji
      : fallbackEmoji;
    return {
      id: `thread-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      adapter,
      model: preferredModel,
      reasoningEffort: preferredReasoningEffort,
      emoji,
      mode: getThreadLaunchModeForAdapter(adapter),
      meetingTransport: "agent_mcp",
      displayName: "",
      initialInstruction: "",
      promptOverride: "",
      ...overrides,
      adapter,
    };
  }

  function getThreadLaunchAgentById(agentId) {
    return _threadLaunchAgents.find((agent) => agent.id === agentId) || null;
  }

  function getThreadLaunchAgentConfigs() {
    return _threadLaunchAgents.map((agent) => ({
      adapter: agent.adapter || "claude",
      model: String(agent.model || "").trim(),
      reasoningEffort: normalizeThreadLaunchReasoningEffort(agent.adapter, agent.reasoningEffort),
      emoji: String(agent.emoji || "").trim() || pickRandomThreadLaunchEmoji(agent.id),
      mode: normalizeThreadLaunchMode(
        agent.adapter || "claude",
        String(agent.mode || getThreadLaunchModeForAdapter(agent.adapter || "claude")).trim()
          || getThreadLaunchModeForAdapter(agent.adapter || "claude"),
      ),
      meetingTransport: agent.meetingTransport || "agent_mcp",
      displayName: "",
      initialInstruction: String(agent.initialInstruction || "").trim(),
      promptOverride: String(agent.promptOverride || ""),
    }));
  }

  function getThreadLaunchIntervalMs() {
    const raw = Number(document.getElementById("thread-launch-interval-seconds")?.value || DEFAULT_THREAD_LAUNCH_INTERVAL_SECONDS);
    const seconds = Number.isFinite(raw) ? Math.max(0, Math.min(30, raw)) : DEFAULT_THREAD_LAUNCH_INTERVAL_SECONDS;
    return Math.round(seconds * 1000);
  }

  function getThreadLaunchGlobalInstruction() {
    return String(document.getElementById("thread-launch-global-instruction")?.value || "").trim();
  }

  function buildDefaultThreadName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const yy = String(now.getFullYear()).slice(-2);
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let suffix = "";
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(3);
      globalThis.crypto.getRandomValues(bytes);
      suffix = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
    } else {
      suffix = Array.from({ length: 3 }, () => {
        const index = Math.floor(Math.random() * alphabet.length);
        return alphabet[index];
      }).join("");
    }
    return `Thread${yy}${mm}${dd}-${suffix}`;
  }

  function buildDefaultInstruction({ topic, config, isFirstAgent }) {
    return [
      `You are joining the AgentChatBus thread "${topic}".`,
      "After joining, check the returned bus_connect role metadata, introduce yourself briefly, explain what you can help with, and wait for further instructions.",
      config.mode !== "interactive"
        ? "Respond in plain text."
        : "",
    ].filter(Boolean).join(" ");
  }

  function buildDefaultReentryPrompt({ topic }) {
    const normalizedTopic = String(topic || "").trim() || "current thread";
    return [
      `Please use msg_wait to process messages in "${normalizedTopic}".`,
      "When you are ready to contribute, please prefer to use msg_post to share your opinion in the thread.",
    ].join(" ");
  }

  function getResolvedThreadLaunchInstruction({ topic, config, isFirstAgent }) {
    const agentInstruction = String(config.initialInstruction || "").trim();
    if (agentInstruction) {
      return agentInstruction;
    }
    const globalInstruction = getThreadLaunchGlobalInstruction();
    if (globalInstruction) {
      return globalInstruction;
    }
    return buildDefaultInstruction({ topic, config, isFirstAgent });
  }

  function getThreadLaunchGlobalReentryPrompt() {
    return String(document.getElementById("thread-launch-global-reentry-prompt")?.value || "").trim();
  }

  function getResolvedThreadLaunchReentryPrompt({ topic }) {
    const override = getThreadLaunchGlobalReentryPrompt();
    if (override) {
      return override;
    }
    return buildDefaultReentryPrompt({ topic });
  }

  function syncThreadLaunchGlobalInstructionField(options = {}) {
    const globalInstructionEl = document.getElementById("thread-launch-global-instruction");
    if (!globalInstructionEl) {
      return;
    }
    const topic = String(options.topic || document.getElementById("modal-topic")?.value || "").trim() || "current thread";
    const firstAgent = _threadLaunchAgents[0] || createThreadLaunchAgent({ adapter: "claude" });
    const defaultInstruction = buildDefaultInstruction({
      topic,
      config: firstAgent,
      isFirstAgent: true,
    });
    const shouldReplace =
      options.force === true
      || !String(globalInstructionEl.value || "").trim()
      || globalInstructionEl.dataset.autogenerated === "1";
    globalInstructionEl.placeholder = defaultInstruction;
    if (!shouldReplace) {
      return;
    }
    globalInstructionEl.value = defaultInstruction;
    globalInstructionEl.dataset.autogenerated = "1";
  }

  function syncThreadLaunchGlobalReentryPromptField(options = {}) {
    const reentryEl = document.getElementById("thread-launch-global-reentry-prompt");
    if (!reentryEl) {
      return;
    }
    const topic = String(options.topic || document.getElementById("modal-topic")?.value || "").trim() || "current thread";
    const defaultPrompt = buildDefaultReentryPrompt({ topic });
    const shouldReplace =
      options.force === true
      || !String(reentryEl.value || "").trim()
      || reentryEl.dataset.autogenerated === "1";
    reentryEl.placeholder = defaultPrompt;
    if (!shouldReplace) {
      return;
    }
    reentryEl.value = defaultPrompt;
    reentryEl.dataset.autogenerated = "1";
  }

  function buildLaunchPromptPreview({ topic, threadId, config, isFirstAgent }) {
    const participantName = buildDefaultParticipantName(config);
    const initialInstruction = getResolvedThreadLaunchInstruction({ topic, config, isFirstAgent });
    const roleLabel = isFirstAgent ? "administrator" : "participant";
    const administratorLabel = isFirstAgent
      ? `${participantName} (<agent_id will be assigned at launch>)`
      : "Agent 1 (<agent_id will be assigned at launch>)";
    const previewBusConnectPayload = JSON.stringify({
      thread_id: threadId || "<thread_id will be created at launch>",
      agent_id: "<agent_id will be registered at launch>",
      token: "<token will be issued at launch>",
    }, null, 2);
    return [
      `You are launching as this exact AgentChatBus identity: ${participantName} (<agent_id will be registered at launch>).`,
      `The current thread "${topic}" is newly created for this launch.`,
      `Your assigned role for this thread is: ${roleLabel}.`,
      isFirstAgent
        ? "You are the administrator for this thread. Other launched agents are participants."
        : `You are a participant. The administrator is ${administratorLabel}.`,
      "Please use the mcp tool `agentchatbus` to participate in the discussion.",
      `Use \`bus_connect\` to join the "${topic}" thread.`,
      "You must use the exact `agent_id` and `token` below when calling `bus_connect`. Do not register a new agent identity and do not omit these credentials.",
      "Call `bus_connect` with exactly this payload:",
      "```json",
      previewBusConnectPayload,
      "```",
      threadId
        ? `If a tool asks you to identify the thread again, use thread_name "${topic}" or thread_id "${threadId}".`
        : `If a tool asks you to identify the thread again, use thread_name "${topic}" or thread_id "<thread_id will be created at launch>".`,
      "Please follow the system prompts within the thread.",
      "All agents should maintain a cooperative attitude.",
      "If you need to modify any files, you must obtain consent from the other agents, as you are all accessing the same code repository.",
      "Everyone can view the source code.",
      "Please remain courteous and avoid causing code conflicts.",
      "Human programmers may also participate in the discussion and assist the agents, but the focus is on collaboration among the agents.",
      "Administrators are responsible for coordinating the work.",
      "After entering the thread, please introduce yourself.",
      "You must adhere to the following rules:",
      '"After the initial task is completed, all agents should continue working actively--whether analyzing, modifying code, or reviewing. If you believe you need to wait, use `msg_wait` to wait for 10 minutes. Do not exit the agent process unless notified to do so. `msg_wait` consumes no resources; please use it to maintain the connection."',
      "Ensure you always reply to this thread via `msg_post`.",
      "If someone speaks up, please try to respond and share your thoughts. Do not just wait.",
      "Do not create a new thread.",
      "Do not call `agent_register` for this launch.",
      `Initial Task: ${initialInstruction}`,
    ].join("\n");
  }

  async function resolveLaunchPromptPreviewFromServer(options = {}) {
    const api = window.AcbApi?.api;
    if (typeof api !== "function") {
      return null;
    }
    const payload = {
      thread_id: options.threadId || undefined,
      topic: options.topic || undefined,
      participant_role: options.isFirstAgent ? "administrator" : "participant",
      participant_display_name: buildDefaultParticipantName(options.config || {}),
      administrator_name: options.administratorName || undefined,
      administrator_agent_id: options.administratorAgentId || undefined,
      initial_instruction: options.initialInstruction || "",
      reentry_prompt_override: options.reentryPromptOverride || "",
      adapter: options.config?.adapter || undefined,
      mode: options.config?.mode || undefined,
    };
    return await api("/api/cli/meeting-prompt-preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  function buildResolvedPromptMetaSuffix(resolved) {
    const resolution = resolved && typeof resolved === "object" ? resolved.resolution : null;
    if (!resolution || typeof resolution !== "object") {
      return "server-resolved";
    }
    if (resolution.exactLaunchPrompt === true) {
      return "server-resolved · exact launch prompt";
    }
    const pending = [];
    if (resolution.threadIdResolved !== true) {
      pending.push("thread id pending");
    }
    if (resolution.participantIdentityResolved !== true) {
      pending.push("launch credentials pending");
    }
    return pending.length > 0
      ? `server-resolved · ${pending.join(" · ")}`
      : "server-resolved";
  }

  function syncThreadLaunchPromptOverrideField() {
    const overrideEl = document.getElementById("thread-agent-prompt-override");
    if (!overrideEl) {
      return;
    }
    const selectedAgent = getThreadLaunchAgentById(_selectedThreadLaunchAgentId) || _threadLaunchAgents[0] || null;
    const nextValue = String(selectedAgent?.promptOverride || "");
    if (overrideEl.value !== nextValue) {
      overrideEl.value = nextValue;
    }
  }

  async function syncThreadLaunchPromptPreview() {
    const previewEl = document.getElementById("thread-agent-prompt-preview");
    const metaEl = document.getElementById("thread-agent-prompt-meta");
    const detailsEl = document.getElementById("thread-agent-side");
    const summaryEl = document.getElementById("thread-agent-prompt-summary");
    const reentryMetaEl = document.getElementById("thread-agent-reentry-meta");
    const reentryPreviewEl = document.getElementById("thread-agent-reentry-preview");
    if (!previewEl) {
      return;
    }
    const topic = String(document.getElementById("modal-topic")?.value || "").trim() || "current thread";
    const selectedAgent = getThreadLaunchAgentById(_selectedThreadLaunchAgentId) || _threadLaunchAgents[0] || null;
    if (!selectedAgent) {
      previewEl.textContent = "";
      if (metaEl) {
        metaEl.textContent = "";
      }
      if (reentryMetaEl) {
        reentryMetaEl.textContent = "";
      }
      if (summaryEl) {
        summaryEl.textContent = "Resolved Launch Prompt";
      }
      if (reentryPreviewEl) {
        reentryPreviewEl.textContent = "";
      }
      if (detailsEl) {
        detailsEl.classList.add("meeting-modal-hidden");
      }
      return;
    }
    const index = Math.max(0, _threadLaunchAgents.findIndex((agent) => agent.id === selectedAgent.id));
    const isFirstAgent = index === 0;
    const roleLabel = isFirstAgent ? "Administrator" : "Participant";
    const fallbackPrompt = buildLaunchPromptPreview({
      topic,
      threadId: "",
      config: selectedAgent,
      isFirstAgent,
    });
    const fallbackReentryPrompt = getResolvedThreadLaunchReentryPrompt({ topic });
    const exactPromptOverride = String(selectedAgent.promptOverride || "");
    const previewRequestId = ++_threadLaunchPromptPreviewRequestId;
    previewEl.textContent = SERVER_PROMPT_PREVIEW_PENDING_TEXT;
    if (reentryPreviewEl) {
      reentryPreviewEl.textContent = SERVER_PROMPT_PREVIEW_PENDING_TEXT;
    }
    if (summaryEl) {
      summaryEl.textContent = `Resolved Launch Prompt · ${roleLabel}`;
    }
    if (metaEl) {
      metaEl.textContent = `Previewing Agent ${index + 1} · ${roleLabel} · ${buildDefaultParticipantName(selectedAgent)} · resolving`;
    }
    if (reentryMetaEl) {
      reentryMetaEl.textContent = `Shared re-entry prompt · resolving`;
    }
    if (detailsEl) {
      detailsEl.classList.remove("meeting-modal-hidden");
    }
    if (exactPromptOverride.trim()) {
      previewEl.textContent = exactPromptOverride;
      if (reentryPreviewEl) {
        reentryPreviewEl.textContent = fallbackReentryPrompt;
      }
      if (metaEl) {
        metaEl.textContent = `Previewing Agent ${index + 1} · ${roleLabel} · ${buildDefaultParticipantName(selectedAgent)} · manual exact launch prompt`;
      }
      if (reentryMetaEl) {
        reentryMetaEl.textContent = "Shared re-entry prompt · server-resolved";
      }
      return;
    }
    try {
      const firstAgent = _threadLaunchAgents[0] || selectedAgent;
      const resolved = await resolveLaunchPromptPreviewFromServer({
        topic,
        config: selectedAgent,
        isFirstAgent,
        initialInstruction: getResolvedThreadLaunchInstruction({ topic, config: selectedAgent, isFirstAgent }),
        reentryPromptOverride: getResolvedThreadLaunchReentryPrompt({ topic }),
        administratorName: isFirstAgent ? undefined : buildDefaultParticipantName(firstAgent),
        administratorAgentId: isFirstAgent ? undefined : "<agent_id will be assigned at launch>",
      });
      if (previewRequestId !== _threadLaunchPromptPreviewRequestId) {
        return;
      }
      previewEl.textContent = String(resolved?.prompt || "").trim() || fallbackPrompt;
      if (reentryPreviewEl) {
        reentryPreviewEl.textContent = String(resolved?.reentry_prompt || "").trim() || fallbackReentryPrompt;
      }
      if (metaEl) {
        metaEl.textContent = `Previewing Agent ${index + 1} · ${roleLabel} · ${buildDefaultParticipantName(selectedAgent)} · ${buildResolvedPromptMetaSuffix(resolved)}`;
      }
      if (reentryMetaEl) {
        reentryMetaEl.textContent = "Shared re-entry prompt · server-resolved";
      }
    } catch {
      if (previewRequestId !== _threadLaunchPromptPreviewRequestId) {
        return;
      }
      previewEl.textContent = fallbackPrompt;
      if (reentryPreviewEl) {
        reentryPreviewEl.textContent = fallbackReentryPrompt;
      }
      if (metaEl) {
        metaEl.textContent = `Previewing Agent ${index + 1} · ${roleLabel} · ${buildDefaultParticipantName(selectedAgent)} · local fallback`;
      }
      if (reentryMetaEl) {
        reentryMetaEl.textContent = "Shared re-entry prompt · local fallback";
      }
    }
  }

  function renderThreadLaunchAgents() {
    const listEl = document.getElementById("thread-launch-agents-list");
    const countEl = document.getElementById("thread-launch-agent-count");
    const addBtn = document.getElementById("thread-launch-add-agent");
    if (!listEl) {
      return;
    }
    if (!_threadLaunchAgents.length) {
      _threadLaunchAgents = [createThreadLaunchAgent({}, 0)];
    }
    if (!getThreadLaunchAgentById(_selectedThreadLaunchAgentId)) {
      _selectedThreadLaunchAgentId = _threadLaunchAgents[0]?.id || "";
    }
    const topic = String(document.getElementById("modal-topic")?.value || "").trim() || "current thread";
    syncThreadLaunchGlobalInstructionField({ topic });
    listEl.innerHTML = _threadLaunchAgents.map((agent, index) => {
      const isFirstAgent = index === 0;
      const selectedClass = agent.id === _selectedThreadLaunchAgentId ? " is-selected" : "";
      return `
        <div
          class="thread-launch-agent-row${selectedClass}"
          onclick="window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
          onpointerdown="window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
        >
          <div class="thread-launch-agent-row__header">
            <div class="thread-launch-agent-row__meta">
              <button
                class="thread-launch-agent-row__title"
                type="button"
                onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
              >
                ${_escapeHtml(String(agent.emoji || "🤖").trim() || "🤖")} Agent ${index + 1}
              </button>
              <span class="thread-launch-agent-row__badge${isFirstAgent ? " thread-launch-agent-row__badge--admin" : ""}">
                ${isFirstAgent ? "Administrator" : "Participant"}
              </span>
            </div>
            ${index > 0 ? `<button class="btn-secondary btn-compact thread-launch-agent-row__remove" type="button" onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.removeThreadLaunchAgent('${_escapeHtml(agent.id)}')">Remove</button>` : ""}
          </div>
          <div
            class="thread-launch-agent-row__fields"
            onclick="window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
            onpointerdown="window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
          >
            <div class="settings-field thread-launch-agent-field thread-launch-agent-field--adapter">
              <label>Adapter</label>
              <div
                class="thread-launch-adapter-group"
                onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
              >
                <label
                  class="thread-launch-adapter-option"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                >
                  <input
                    type="radio"
                    name="thread-launch-adapter-${_escapeHtml(agent.id)}"
                    value="codex"
                    data-agent-id="${_escapeHtml(agent.id)}"
                    data-field="adapter"
                    ${agent.adapter === "codex" ? "checked" : ""}
                    onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                  />
                  <span>Codex</span>
                </label>
                <label
                  class="thread-launch-adapter-option"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                >
                  <input
                    type="radio"
                    name="thread-launch-adapter-${_escapeHtml(agent.id)}"
                    value="cursor"
                    data-agent-id="${_escapeHtml(agent.id)}"
                    data-field="adapter"
                    ${agent.adapter === "cursor" ? "checked" : ""}
                    onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                  />
                  <span>Cursor</span>
                </label>
                <label
                  class="thread-launch-adapter-option"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                >
                  <input
                    type="radio"
                    name="thread-launch-adapter-${_escapeHtml(agent.id)}"
                    value="claude"
                    data-agent-id="${_escapeHtml(agent.id)}"
                    data-field="adapter"
                    ${agent.adapter === "claude" ? "checked" : ""}
                    onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                  />
                  <span>Claude</span>
                </label>
                <label
                  class="thread-launch-adapter-option"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                >
                  <input
                    type="radio"
                    name="thread-launch-adapter-${_escapeHtml(agent.id)}"
                    value="gemini"
                    data-agent-id="${_escapeHtml(agent.id)}"
                    data-field="adapter"
                    ${agent.adapter === "gemini" ? "checked" : ""}
                    onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                  />
                  <span>Gemini</span>
                </label>
                <label
                  class="thread-launch-adapter-option"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                >
                  <input
                    type="radio"
                    name="thread-launch-adapter-${_escapeHtml(agent.id)}"
                    value="copilot"
                    data-agent-id="${_escapeHtml(agent.id)}"
                    data-field="adapter"
                    ${agent.adapter === "copilot" ? "checked" : ""}
                    onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                    onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                  />
                  <span>Copilot</span>
                </label>
              </div>
            </div>
            <div class="settings-field thread-launch-agent-field thread-launch-agent-field--emoji">
              <label>Emoji</label>
              <div class="thread-launch-emoji-row">
                <span class="thread-launch-emoji-preview" aria-hidden="true">${_escapeHtml(String(agent.emoji || "🤖").trim() || "🤖")}</span>
                <select
                  data-agent-id="${_escapeHtml(agent.id)}"
                  data-field="emoji"
                  onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                  onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                >
                  ${buildThreadLaunchEmojiOptionsHtml(agent.id)}
                </select>
              </div>
            </div>
            <div class="settings-field thread-launch-agent-field thread-launch-agent-field--model">
              <label>Model</label>
              <div class="thread-launch-model-row">
                <input
                  type="text"
                  value="${_escapeHtml(getRequiredThreadLaunchModel(agent.adapter, agent.model))}"
                  data-agent-id="${_escapeHtml(agent.id)}"
                  data-field="model"
                  placeholder="Leave blank for adapter default, or type any model"
                  ${agent.adapter === "cursor" || agent.adapter === "gemini" ? "" : "required"}
                  onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                  onfocus="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                  oninput="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                  onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                />
                <select
                  data-agent-id="${_escapeHtml(agent.id)}"
                  data-field="modelSuggestion"
                  onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                  onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                  onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
                >
                  <option value="">Suggestions</option>
                  ${buildThreadLaunchModelOptionsHtml(agent)}
                </select>
              </div>
              <div class="thread-launch-model-meta">${buildThreadLaunchModelMetaHtml(agent)}</div>
            </div>
            <div class="settings-field thread-launch-agent-field">
              <label>Reasoning Level</label>
              <select
                data-agent-id="${_escapeHtml(agent.id)}"
                data-field="reasoningEffort"
                ${agent.adapter === "codex" ? "" : "disabled"}
                onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
              >
                ${buildThreadLaunchReasoningOptionsHtml(agent)}
              </select>
              <div class="thread-launch-model-meta">${_escapeHtml(getThreadLaunchReasoningMeta(agent))}</div>
            </div>
            <div class="settings-field thread-launch-agent-field">
              <label>Mode</label>
              <select
                data-agent-id="${_escapeHtml(agent.id)}"
                data-field="mode"
                onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onchange="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
              >
                ${buildThreadLaunchModeOptionsHtml(agent.adapter, agent.mode)}
              </select>
              <div class="thread-launch-model-meta">${_escapeHtml(getThreadLaunchModeLabel(agent.mode))}</div>
            </div>
            <div class="settings-field thread-launch-agent-field thread-launch-agent-field--instruction">
              <label>Instruction Override</label>
              <input
                type="text"
                value="${_escapeHtml(String(agent.initialInstruction || ""))}"
                data-agent-id="${_escapeHtml(agent.id)}"
                data-field="initialInstruction"
                placeholder="Leave blank to use the shared instruction"
                onclick="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onpointerdown="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                onfocus="event.stopPropagation(); window.AcbModals && window.AcbModals.selectThreadLaunchAgent('${_escapeHtml(agent.id)}')"
                oninput="window.AcbModals && window.AcbModals.updateThreadLaunchAgentField(this)"
              />
            </div>
          </div>
        </div>
      `;
    }).join("");
    listEl.dataset.agentCount = String(_threadLaunchAgents.length);
    if (countEl) {
      countEl.textContent = String(_threadLaunchAgents.length);
    }
    if (addBtn) {
      addBtn.disabled = _threadLaunchAgents.length >= MAX_THREAD_LAUNCH_AGENTS;
    }
    writeThreadLaunchAdapterPreferences();
    writeThreadLaunchSelectionPreferences();
    syncModelDiscoveryUi();
    syncThreadLaunchPromptOverrideField();
    syncThreadLaunchPromptPreview();
    syncThreadLaunchUi();
  }

  function resetThreadLaunchAgents() {
    _threadLaunchAgents = [createThreadLaunchAgent({ adapter: "claude" }, 0)];
    _selectedThreadLaunchAgentId = _threadLaunchAgents[0].id;
    syncThreadLaunchGlobalInstructionField({ force: true });
    syncThreadLaunchGlobalReentryPromptField({ force: true });
    const intervalEl = document.getElementById("thread-launch-interval-seconds");
    if (intervalEl) {
      intervalEl.value = String(DEFAULT_THREAD_LAUNCH_INTERVAL_SECONDS);
    }
    syncModelDiscoveryUi();
    renderThreadLaunchAgents();
  }

  function addThreadLaunchAgent() {
    if (_threadLaunchAgents.length >= MAX_THREAD_LAUNCH_AGENTS) {
      return;
    }
    const nextAgent = createThreadLaunchAgent(
      { adapter: "codex" },
      _threadLaunchAgents.length,
    );
    _threadLaunchAgents.push(nextAgent);
    _selectedThreadLaunchAgentId = nextAgent.id;
    renderThreadLaunchAgents();
  }

  function removeThreadLaunchAgent(agentId) {
    if (_threadLaunchAgents.length <= 1) {
      return;
    }
    _threadLaunchAgents = _threadLaunchAgents.filter((agent) => agent.id !== agentId);
    if (!getThreadLaunchAgentById(_selectedThreadLaunchAgentId)) {
      _selectedThreadLaunchAgentId = _threadLaunchAgents[0]?.id || "";
    }
    renderThreadLaunchAgents();
  }

  function selectThreadLaunchAgent(agentId) {
    if (!getThreadLaunchAgentById(agentId)) {
      return;
    }
    if (_selectedThreadLaunchAgentId === agentId) {
      return;
    }
    _selectedThreadLaunchAgentId = agentId;
    renderThreadLaunchAgents();
  }

  function updateThreadLaunchAgentField(element) {
    const agentId = String(element?.dataset?.agentId || "").trim();
    const field = String(element?.dataset?.field || "").trim();
    const agent = getThreadLaunchAgentById(agentId);
    if (!agent || !field) {
      return;
    }
    _selectedThreadLaunchAgentId = agentId;
    if (field === "adapter") {
      const previousAdapter = agent.adapter;
      agent.adapter = String(element.value || "claude").trim() || "claude";
      agent.mode = getThreadLaunchModeForAdapter(agent.adapter);
      agent.meetingTransport = "agent_mcp";
      if (agent.adapter === "cursor" || agent.adapter === "gemini") {
        agent.model = getRequiredThreadLaunchModel(agent.adapter, agent.model);
      } else if (previousAdapter === "cursor" && String(agent.model || "").trim() === "auto") {
        agent.model = "";
      } else if (previousAdapter === "gemini" && !String(agent.model || "").trim()) {
        agent.model = "";
      }
      syncThreadLaunchAgentReasoningForModel(agent);
      if (_threadLaunchAgents[0]?.id === agentId) {
        syncThreadLaunchGlobalInstructionField();
      }
      writeThreadLaunchAdapterPreferences();
      renderThreadLaunchAgents();
      return;
    }
    if (field === "emoji") {
      const nextEmoji = String(element.value || "").trim();
      if (!THREAD_LAUNCH_EMOJI_OPTIONS.includes(nextEmoji)) {
        return;
      }
      agent.emoji = nextEmoji;
      renderThreadLaunchAgents();
      return;
    }
    if (field === "mode") {
      agent.mode = normalizeThreadLaunchMode(agent.adapter, element.value);
      if (_threadLaunchAgents[0]?.id === agentId) {
        syncThreadLaunchGlobalInstructionField();
      }
      renderThreadLaunchAgents();
      return;
    }
    if (field === "model") {
      agent.model = getRequiredThreadLaunchModel(agent.adapter, element.value);
      syncThreadLaunchAgentReasoningForModel(agent);
      syncThreadLaunchPromptPreview();
      renderThreadLaunchAgents();
      return;
    }
    if (field === "modelSuggestion") {
      const suggestedModel = String(element.value || "").trim();
      if (suggestedModel) {
        agent.model = getRequiredThreadLaunchModel(agent.adapter, suggestedModel);
      }
      syncThreadLaunchAgentReasoningForModel(agent);
      renderThreadLaunchAgents();
      return;
    }
    if (field === "reasoningEffort") {
      agent.reasoningEffort = normalizeThreadLaunchReasoningEffort(agent.adapter, element.value);
      syncThreadLaunchPromptPreview();
      renderThreadLaunchAgents();
      return;
    }
    if (field === "initialInstruction") {
      agent.initialInstruction = String(element.value || "");
      syncThreadLaunchPromptPreview();
      return;
    }
  }

  async function syncLaunchPromptPreview(prefix, options = {}) {
    const previewEl = document.getElementById(`${prefix}-prompt-preview`);
    if (!previewEl) {
      return;
    }
    const topic = String(options.topic || "").trim() || "current thread";
    const config = readAgentLaunchConfig(prefix);
    const fallbackPrompt = buildLaunchPromptPreview({
      topic,
      threadId: options.threadId,
      config,
      isFirstAgent: Boolean(options.isFirstAgent),
    });
    const previewRequestId = prefix === "agent-modal"
      ? ++_manualLaunchPromptPreviewRequestId
      : 0;
    previewEl.textContent = SERVER_PROMPT_PREVIEW_PENDING_TEXT;
    try {
      const resolved = await resolveLaunchPromptPreviewFromServer({
        threadId: options.threadId,
        topic,
        config,
        isFirstAgent: Boolean(options.isFirstAgent),
        initialInstruction: getResolvedThreadLaunchInstruction({
          topic,
          config,
          isFirstAgent: Boolean(options.isFirstAgent),
        }),
      });
      if (prefix === "agent-modal" && previewRequestId !== _manualLaunchPromptPreviewRequestId) {
        return;
      }
      previewEl.textContent = String(resolved?.prompt || "").trim() || fallbackPrompt;
    } catch {
      if (prefix === "agent-modal" && previewRequestId !== _manualLaunchPromptPreviewRequestId) {
        return;
      }
      previewEl.textContent = fallbackPrompt;
    }
  }

  function syncDefaultInstructionField(prefix, options = {}) {
    const instructionEl = document.getElementById(`${prefix}-instruction`);
    if (!instructionEl) {
      return;
    }
    const topic = String(options.topic || "").trim() || "current thread";
    const config = readAgentLaunchConfig(prefix);
    const defaultInstruction = buildDefaultInstruction({
      topic,
      config,
      isFirstAgent: Boolean(options.isFirstAgent),
    });
    const shouldReplace =
      options.force === true
      || !String(instructionEl.value || "").trim()
      || instructionEl.dataset.autogenerated === "1";
    instructionEl.placeholder = defaultInstruction;
    if (!shouldReplace) {
      syncLaunchPromptPreview(prefix, options);
      return;
    }
    instructionEl.value = defaultInstruction;
    instructionEl.dataset.autogenerated = "1";
    syncLaunchPromptPreview(prefix, options);
  }

  function markInstructionAsUserEdited(prefix) {
    const instructionEl = document.getElementById(`${prefix}-instruction`);
    if (!instructionEl) {
      return;
    }
    instructionEl.dataset.autogenerated = "0";
  }

  function bindInstructionAutofill(prefix, options = {}) {
    const topicInputId = options.topicInputId;
    const getTopic = options.getTopic;
    const isFirstAgent = Boolean(options.isFirstAgent);
    const bind = (elementId, eventName = "change") => {
      const el = document.getElementById(elementId);
      if (!el || el.dataset.defaultInstructionBound === "1") {
        return;
      }
      el.dataset.defaultInstructionBound = "1";
      el.addEventListener(eventName, () => {
        const nextOptions = {
          topic: typeof getTopic === "function" ? getTopic() : "",
          threadId: typeof options.getThreadId === "function" ? options.getThreadId() : undefined,
          isFirstAgent,
        };
        syncDefaultInstructionField(prefix, nextOptions);
        syncLaunchPromptPreview(prefix, nextOptions);
      });
    };

    bind(`${prefix}-adapter`);
    bind(`${prefix}-mode`);
    bind(`${prefix}-display-name`, "input");

    const instructionEl = document.getElementById(`${prefix}-instruction`);
    if (instructionEl && instructionEl.dataset.userEditBound !== "1") {
      instructionEl.dataset.userEditBound = "1";
      instructionEl.addEventListener("input", () => {
        markInstructionAsUserEdited(prefix);
        syncLaunchPromptPreview(prefix, {
          topic: typeof getTopic === "function" ? getTopic() : "",
          threadId: typeof options.getThreadId === "function" ? options.getThreadId() : undefined,
          isFirstAgent,
        });
      });
    }

    if (topicInputId) {
      const topicEl = document.getElementById(topicInputId);
      if (topicEl && topicEl.dataset.defaultInstructionBound !== "1") {
        topicEl.dataset.defaultInstructionBound = "1";
        topicEl.addEventListener("input", () => {
          const nextOptions = {
            topic: typeof getTopic === "function" ? getTopic() : "",
            threadId: typeof options.getThreadId === "function" ? options.getThreadId() : undefined,
            isFirstAgent,
          };
          syncDefaultInstructionField(prefix, nextOptions);
          syncLaunchPromptPreview(prefix, nextOptions);
        });
      }
    }
  }

  async function registerParticipantAgent(api, config) {
    const adapterLabel = config.adapter === "cursor" ? "Cursor" :
                         config.adapter === "claude" ? "Claude" :
                         config.adapter === "gemini" ? "Gemini" :
                         config.adapter === "copilot" ? "Copilot" : "Codex";
    const modeLabel = config.mode === "direct"
      ? "Direct App Server"
      : config.mode === "headless"
        ? "Headless CLI"
        : "Interactive PTY";
    const displayName = buildDefaultParticipantName(config);
    const result = await api("/api/agents/register", {
      method: "POST",
      body: JSON.stringify({
        ide: adapterLabel,
        model: String(config.model || "").trim() || modeLabel,
        display_name: displayName,
        emoji: String(config.emoji || "").trim() || undefined,
      }),
    });
    return result?.agent_id && result?.token ? result : null;
  }

  async function createParticipantSession(api, options) {
    const {
      threadId,
      threadTopic,
      uiAgent,
      participantAgent,
      config,
      isFirstAgent,
    } = options;
    const result = await api(`/api/threads/${threadId}/cli-sessions`, {
      method: "POST",
      headers: {
        "X-Agent-Token": uiAgent.token,
      },
      body: JSON.stringify({
        adapter: config.adapter,
        model: String(config.model || "").trim() || undefined,
        reasoning_effort: normalizeThreadLaunchReasoningEffort(config.adapter, config.reasoningEffort) || undefined,
        mode: config.mode,
        meeting_transport: config.meetingTransport,
        prompt: String(config.promptOverride || "").trim() || undefined,
        initial_instruction: config.initialInstruction || "",
        reentry_prompt_override: config.reentryPrompt || "",
        requested_by_agent_id: uiAgent.agent_id,
        participant_agent_id: participantAgent.agent_id,
        participant_display_name: participantAgent.display_name || buildDefaultParticipantName(config),
        cols: 120,
        rows: 32,
      }),
    });
    return result?.session || null;
  }

  function openThreadModal(api) {
    const launchPreviewDetailsEl = document.getElementById("thread-agent-side");
    const reentryPreviewDetailsEl = document.getElementById("thread-agent-reentry-side");
    if (launchPreviewDetailsEl instanceof HTMLDetailsElement) {
      launchPreviewDetailsEl.open = true;
    }
    if (reentryPreviewDetailsEl instanceof HTMLDetailsElement) {
      reentryPreviewDetailsEl.open = true;
    }
    const topicInputEl = document.getElementById("modal-topic");
    const launchWithAgent = document.querySelector('input[name="thread-launch-mode"][value="thread_with_agent"]');
    if (launchWithAgent) {
      launchWithAgent.checked = true;
    }
    if (topicInputEl && !String(topicInputEl.value || "").trim()) {
      topicInputEl.value = buildDefaultThreadName();
    }
    if (topicInputEl && topicInputEl.dataset.threadLaunchBound !== "1") {
      topicInputEl.dataset.threadLaunchBound = "1";
      topicInputEl.addEventListener("input", () => {
        syncThreadLaunchGlobalInstructionField({
          topic: String(topicInputEl.value || "").trim() || "current thread",
        });
        syncThreadLaunchGlobalReentryPromptField({
          topic: String(topicInputEl.value || "").trim() || "current thread",
        });
        renderThreadLaunchAgents();
      });
    }
    const globalInstructionEl = document.getElementById("thread-launch-global-instruction");
    if (globalInstructionEl && globalInstructionEl.dataset.threadLaunchBound !== "1") {
      globalInstructionEl.dataset.threadLaunchBound = "1";
      globalInstructionEl.addEventListener("input", () => {
        globalInstructionEl.dataset.autogenerated = "0";
      });
      globalInstructionEl.addEventListener("input", () => {
        syncThreadLaunchPromptPreview();
      });
    }
    const globalReentryEl = document.getElementById("thread-launch-global-reentry-prompt");
    if (globalReentryEl && globalReentryEl.dataset.threadLaunchBound !== "1") {
      globalReentryEl.dataset.threadLaunchBound = "1";
      globalReentryEl.addEventListener("input", () => {
        globalReentryEl.dataset.autogenerated = "0";
      });
      globalReentryEl.addEventListener("input", () => {
        syncThreadLaunchPromptPreview();
      });
    }
    const promptOverrideEl = document.getElementById("thread-agent-prompt-override");
    if (promptOverrideEl && promptOverrideEl.dataset.threadLaunchBound !== "1") {
      promptOverrideEl.dataset.threadLaunchBound = "1";
      promptOverrideEl.addEventListener("input", () => {
        const selectedAgent = getThreadLaunchAgentById(_selectedThreadLaunchAgentId) || _threadLaunchAgents[0] || null;
        if (!selectedAgent) {
          return;
        }
        selectedAgent.promptOverride = String(promptOverrideEl.value || "");
        syncThreadLaunchPromptPreview();
      });
    }
    setModalVisible("thread", true);
    resetThreadLaunchAgents();
    syncThreadLaunchUi();
    syncModelDiscoveryUi();
    setTimeout(() => document.getElementById("modal-topic").focus(), 100);
    if (api) {
      void loadCliModelDiscovery(api, { force: false });
      _loadTemplates(api).then((templates) => _populateTemplateDropdown(templates));
    }
  }

  function closeThreadModal(e) {
    if (!e || isOverlayClick(e, "thread")) {
      setModalVisible("thread", false);
    }
  }

  async function submitThreadModal(deps) {
    const { api, refreshThreads, selectThread } = deps;
    const topicInput = document.getElementById("modal-topic");
    const topic = topicInput.value.trim();
    if (!topic) return;

    const modelInputs = Array.from(document.querySelectorAll('[data-field="model"]'));
    for (const input of modelInputs) {
      if (input instanceof HTMLInputElement && !input.reportValidity()) {
        return;
      }
    }

    const templateSel = document.getElementById("modal-template");
    const template = templateSel ? templateSel.value || null : null;
    const launchMode = getThreadLaunchMode();
    const shouldLaunchFirstAgent = launchMode === "thread_with_agent";
    const launchAgentConfigs = shouldLaunchFirstAgent
      ? getThreadLaunchAgentConfigs().map((config, index) => ({
        ...config,
        initialInstruction: getResolvedThreadLaunchInstruction({
          topic,
          config,
          isFirstAgent: index === 0,
        }),
        reentryPrompt: getResolvedThreadLaunchReentryPrompt({ topic }),
        promptOverride: String(config.promptOverride || ""),
      }))
      : [];
    const firstAgentConfig = shouldLaunchFirstAgent ? launchAgentConfigs[0] || null : null;
    const launchIntervalMs = getThreadLaunchIntervalMs();

    // UI-14: get or register a browser-session agent to provide auth for thread creation
    const uiAgent = window.AcbUiAgent ? await window.AcbUiAgent.ensureUiAgent() : null;
    if (!uiAgent) {
      console.error("[Thread Create] Could not obtain UI agent token -- cannot create thread");
      return;
    }

    let creatorAuth = uiAgent;
    let participantAgent = null;
    if (shouldLaunchFirstAgent && firstAgentConfig) {
      participantAgent = await registerParticipantAgent(api, firstAgentConfig);
      if (!participantAgent) {
        console.error("[Thread Create] Could not register target agent");
        return;
      }
      creatorAuth = {
        agent_id: participantAgent.agent_id,
        token: participantAgent.token,
      };
    }

    topicInput.value = "";
    if (templateSel) templateSel.value = "";
    const descEl = document.getElementById("modal-template-desc");
    if (descEl) descEl.textContent = "";
    resetThreadLaunchAgents();
    const launchWithAgent = document.querySelector('input[name="thread-launch-mode"][value="thread_with_agent"]');
    if (launchWithAgent) {
      launchWithAgent.checked = true;
    }
    syncThreadLaunchUi();
    closeThreadModal();

    const t = await api("/api/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": creatorAuth.token,
      },
      body: JSON.stringify({
        topic,
        creator_agent_id: creatorAuth.agent_id,
        assign_creator_admin: shouldLaunchFirstAgent,
        ...(template ? { template } : {}),
      }),
    });
    if (t) {
      const followupLaunchConfigs = shouldLaunchFirstAgent ? launchAgentConfigs.slice(1) : [];
      if (shouldLaunchFirstAgent && participantAgent && firstAgentConfig) {
        await createParticipantSession(api, {
          threadId: t.id,
          threadTopic: topic,
          uiAgent,
          participantAgent,
          config: firstAgentConfig,
          isFirstAgent: true,
        });
      }
      const syncContext =
        typeof t.current_seq === "number" && t.reply_token
          ? {
              current_seq: t.current_seq,
              reply_token: t.reply_token,
              reply_window: t.reply_window || null,
            }
          : null;
      await refreshThreads();
      selectThread(t.id, t.topic, t.status, syncContext);
      if (window.AcbChat && typeof window.AcbChat.refreshThreadAdmin === "function") {
        await window.AcbChat.refreshThreadAdmin(t.id, api);
      }
      if (window.AcbCliSessions && typeof window.AcbCliSessions.refreshThread === "function") {
        await window.AcbCliSessions.refreshThread(t.id, api);
      }
      if (shouldLaunchFirstAgent && window.AcbCliSessions?.setTerminalVisibility) {
        window.AcbCliSessions.setTerminalVisibility(t.id, true);
      }
      for (let index = 0; index < followupLaunchConfigs.length; index += 1) {
        const config = followupLaunchConfigs[index];
        if (launchIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, launchIntervalMs));
        }
        const nextParticipantAgent = await registerParticipantAgent(api, config);
        if (!nextParticipantAgent) {
          console.error(`[Thread Create] Could not register target agent ${index + 2}`);
          continue;
        }
        const session = await createParticipantSession(api, {
          threadId: t.id,
          threadTopic: topic,
          uiAgent,
          participantAgent: nextParticipantAgent,
          config,
          isFirstAgent: false,
        });
        if (!session) {
          console.error(`[Thread Create] Failed to create target agent CLI session ${index + 2}`);
        }
      }
      if (followupLaunchConfigs.length > 0 && window.AcbCliSessions && typeof window.AcbCliSessions.refreshThread === "function") {
        await window.AcbCliSessions.refreshThread(t.id, api);
      }
    }
  }

  async function openAddAgentModal(api) {
    const threadId = window.currentThreadId;
    if (!threadId) {
      return;
    }
    resetAgentForm("agent-modal");
    syncAddAgentModelControls("agent-modal");
    if (api) {
      void loadCliModelDiscovery(api, { force: false }).then(() => {
        syncAddAgentModelControls("agent-modal");
      });
    }
    bindInstructionAutofill("agent-modal", {
      getTopic: () => document.getElementById("thread-title")?.textContent?.trim() || "current thread",
      getThreadId: () => window.currentThreadId || "",
      isFirstAgent: false,
    });
    const adapterEl = document.getElementById("agent-modal-adapter");
    const modelEl = document.getElementById("agent-modal-model");
    const modelSuggestionEl = document.getElementById("agent-modal-model-suggestion");
    const emojiEl = document.getElementById("agent-modal-emoji");
    const emojiPreviewEl = document.getElementById("agent-modal-emoji-preview");
    if (adapterEl && adapterEl.dataset.addAgentBound !== "1") {
      adapterEl.dataset.addAgentBound = "1";
      adapterEl.addEventListener("change", () => {
        syncAddAgentModelControls("agent-modal");
        syncDefaultInstructionField("agent-modal", {
          topic: document.getElementById("thread-title")?.textContent?.trim() || "current thread",
          threadId: window.currentThreadId || "",
          isFirstAgent: false,
        });
      });
    }
    if (modelSuggestionEl && modelSuggestionEl.dataset.addAgentBound !== "1") {
      modelSuggestionEl.dataset.addAgentBound = "1";
      modelSuggestionEl.addEventListener("change", () => {
        if (modelEl && String(modelSuggestionEl.value || "").trim()) {
          modelEl.value = getRequiredThreadLaunchModel(
            String(adapterEl?.value || "claude").trim(),
            modelSuggestionEl.value,
          );
        }
      });
    }
    if (emojiEl && emojiEl.dataset.addAgentBound !== "1") {
      emojiEl.dataset.addAgentBound = "1";
      emojiEl.addEventListener("change", () => {
        if (emojiPreviewEl) {
          emojiPreviewEl.textContent = String(emojiEl.value || "").trim() || "🤖";
        }
      });
    }
    resetAutoAssembleForm();
    switchAddAgentTab("manual");
    const threadTitle = document.getElementById("thread-title")?.textContent?.trim() || "current thread";
    const hintEl = document.getElementById("agent-modal-context");
    const roleHintEl = document.getElementById("agent-modal-hint");
    if (hintEl) {
      hintEl.textContent = `Launch another agent session into "${threadTitle}".`;
    }
    if (roleHintEl && api) {
      try {
        const agentsRes = await api(`/api/threads/${threadId}/agents`);
        const count = Array.isArray(agentsRes) ? agentsRes.length : 0;
        roleHintEl.textContent = count > 0
          ? "New agents join as participants."
          : "The first launched agent in this thread will become the administrator.";
        syncDefaultInstructionField("agent-modal", {
          topic: threadTitle,
          threadId,
          isFirstAgent: count === 0,
          force: true,
        });
      } catch {
        roleHintEl.textContent = "New agents join as participants unless they are the first active agent in the thread.";
        syncDefaultInstructionField("agent-modal", {
          topic: threadTitle,
          threadId,
          isFirstAgent: false,
          force: true,
        });
      }
    } else {
      syncDefaultInstructionField("agent-modal", {
        topic: threadTitle,
        threadId,
        isFirstAgent: false,
        force: true,
      });
    }
    setModalVisible("agent", true);
  }

  function closeAddAgentModal(e) {
    if (!e || isOverlayClick(e, "agent")) {
      setModalVisible("agent", false);
    }
  }

  async function submitAddAgentModal(deps) {
    const { api, refreshAgents } = deps;
    const threadId = window.currentThreadId;
    if (!threadId) {
      return;
    }
    if (getAddAgentTab() !== "manual") {
      return;
    }
    const uiAgent = window.AcbUiAgent ? await window.AcbUiAgent.ensureUiAgent() : null;
    if (!uiAgent) {
      console.error("[Add Agent] Could not obtain UI agent token");
      return;
    }

    const modelInput = document.getElementById("agent-modal-model");
    if (modelInput instanceof HTMLInputElement && !modelInput.reportValidity()) {
      return;
    }

    const config = readAgentLaunchConfig("agent-modal");
    writeThreadLaunchSelectionPreferencesFromConfig(config);
    const participantAgent = await registerParticipantAgent(api, config);
    if (!participantAgent) {
      console.error("[Add Agent] Could not register target agent");
      return;
    }

    const threadTopic = document.getElementById("thread-title")?.textContent?.trim() || "current thread";
    const session = await createParticipantSession(api, {
      threadId,
      threadTopic,
      uiAgent,
      participantAgent,
      config,
      isFirstAgent: false,
    });
    if (!session) {
      console.error("[Add Agent] Failed to create target agent CLI session");
      return;
    }

    closeAddAgentModal();
    if (typeof refreshAgents === "function") {
      await refreshAgents();
    }
    if (window.AcbCliSessions && typeof window.AcbCliSessions.refreshThread === "function") {
      await window.AcbCliSessions.refreshThread(threadId, api);
      if (typeof window.AcbCliSessions.selectSession === "function") {
        window.AcbCliSessions.selectSession(session.id, threadId);
      }
    }
    if (window.AcbCliSessions?.setTerminalVisibility) {
      window.AcbCliSessions.setTerminalVisibility(threadId, true);
    }
    if (window.AcbChat && typeof window.AcbChat.refreshThreadAdmin === "function") {
      await window.AcbChat.refreshThreadAdmin(threadId, api);
    }
  }

  let _settingsManifest = null;

  function _escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function _diagnosticsToolsCardHtml() {
    return `
      <div class="settings-card diag-card">
        <div class="diag-subtitle" style="margin-bottom: 12px; font-size: 13px; color: var(--text-2);">
          Run a self-test to verify Database, MCP Tools, and Agent connectivity.
        </div>
        <button class="btn-primary diag-run-btn" id="btn-run-diagnostics" onclick="window.runDiagnostics(this)" style="width: 100%; margin-bottom: 12px;">Run Diagnostics <span id="diag-btn-emoji"></span></button>
        <div id="diagnostics-results" class="diag-terminal" style="display: none; background: #0c0c0c; color: #00ff00; font-family: monospace; padding: 12px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; line-height: 1.5; max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; word-break: break-word; overflow-x: hidden;"></div>
        <button class="btn-secondary diag-copy-btn" id="btn-copy-diagnostics" onclick="window.copyDiagnosticsReport(this)" style="width: 100%; display: none; margin-top: 12px;">Copy Diagnostic Report</button>
      </div>
    `;
  }

  function _renderField(field) {
    const descHtml = field.description
      ? `<div class="settings-field-description">${_escapeHtml(field.description)}</div>`
      : "";
    const envLockHtml = field.readonly_reason
      ? `<div class="settings-field-note">${_escapeHtml(field.readonly_reason)}</div>`
      : "";
    const valueSourceHtml = field.value_source === "env"
      ? `<div class="settings-field-note">Value source: startup parameter / environment</div>`
      : "";
    const restartHtml = field.restart_required
      ? `<div class="settings-field-note">Requires restart</div>`
      : "";
    const disabledAttr = field.editable ? "" : " disabled";
    const inputId = _escapeHtml(field.input_id);
    const label = _escapeHtml(field.label);

    if (field.type === "boolean") {
      return `
        <div class="settings-field-container" style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">
          <div class="settings-field settings-field-row" style="margin-bottom:0;">
            <span style="font-size:13px;color:var(--text-1);font-weight:500;">${label}</span>
            <label class="toggle-switch" for="${inputId}">
              <input id="${inputId}" type="checkbox"${field.value ? " checked" : ""}${disabledAttr} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          ${descHtml}
          ${valueSourceHtml}
          ${envLockHtml}
          ${restartHtml}
        </div>`;
    }

    if (field.type === "string[]") {
      const listValue = Array.isArray(field.value) ? field.value.join(", ") : "";
      return `
        <div class="settings-field" style="margin-bottom:8px;">
          <label for="${inputId}">${label}</label>
          <textarea id="${inputId}" rows="3"${disabledAttr}>${_escapeHtml(listValue)}</textarea>
          ${descHtml}
          ${valueSourceHtml}
          ${envLockHtml}
          ${restartHtml}
        </div>`;
    }

    if (field.type === "enum") {
      const options = Array.isArray(field.options) ? field.options : [];
      const currentValue = String(field.value ?? "");
      const optionHtml = options.map((option) => `
        <option value="${_escapeHtml(option.value)}"${option.value === currentValue ? " selected" : ""}>${_escapeHtml(option.label)}</option>
      `).join("");
      return `
        <div class="settings-field" style="margin-bottom:8px;">
          <label for="${inputId}">${label}</label>
          <select id="${inputId}"${disabledAttr}>${optionHtml}</select>
          ${descHtml}
          ${valueSourceHtml}
          ${envLockHtml}
          ${restartHtml}
        </div>`;
    }

    const inputType = field.type === "integer" || field.type === "number" ? "number" : "text";
    const minAttr = field.min !== undefined ? ` min="${field.min}"` : "";
    const maxAttr = field.max !== undefined ? ` max="${field.max}"` : "";
    const stepAttr = field.step !== undefined ? ` step="${field.step}"` : "";
    const rawValue = field.value === undefined || field.value === null ? "" : String(field.value);

    return `
      <div class="settings-field" style="margin-bottom:8px;">
        <label for="${inputId}">${label}</label>
        <input id="${inputId}" type="${inputType}" value="${_escapeHtml(rawValue)}"${minAttr}${maxAttr}${stepAttr}${disabledAttr} />
        ${descHtml}
        ${valueSourceHtml}
        ${envLockHtml}
        ${restartHtml}
      </div>`;
  }

  function _renderSectionPane(section) {
    if (section.id === "ui") {
      const html = window.AcbModalShell?.renderUiPreferencesHtml
        ? window.AcbModalShell.renderUiPreferencesHtml()
        : "";
      return `
        <div id="pane-ui" class="settings-tab-pane">
          <div class="settings-section-title">PREFERENCES</div>
          <div class="settings-card">${html}</div>
        </div>`;
    }

    const fieldsHtml = (section.fields || []).map(_renderField).join("");
    const diagnosticsHtml = section.id === "diagnostics" ? _diagnosticsToolsCardHtml() : "";

    return `
      <div id="pane-${_escapeHtml(section.id)}" class="settings-tab-pane${section.active ? " active" : ""}">
        <div class="settings-section-title">${_escapeHtml(String(section.title || "").toUpperCase())}</div>
        ${fieldsHtml ? `<div class="settings-card">${fieldsHtml}</div>` : ""}
        ${diagnosticsHtml}
      </div>`;
  }

  function _buildSettingsSections(manifest) {
    const serverSections = Array.isArray(manifest?.sections) ? manifest.sections : [];
    const diagnosticsSection = serverSections.find((section) => section.id === "diagnostics") || {
      id: "diagnostics",
      nav_label: "Diagnostics",
      title: "Runtime Configuration",
      fields: [],
      order: 999,
    };
    const visibleServerSections = serverSections
      .filter((section) => section.id !== "diagnostics")
      .sort((left, right) => (left.order || 0) - (right.order || 0));

    return [
      ...visibleServerSections,
      { id: "ui", nav_label: "UI", title: "Preferences", fields: [], order: 95 },
      diagnosticsSection,
    ];
  }

  function _renderSettingsManifest(manifest) {
    const sidebar = document.getElementById("settings-sidebar");
    const content = document.getElementById("settings-content");
    if (!sidebar || !content) return;

    const sections = _buildSettingsSections(manifest);
    const activeSectionId = sections[0]?.id || "agent";

    sidebar.innerHTML = sections.map((section, index) => `
      <div id="nav-${_escapeHtml(section.id)}" class="settings-nav-item${index === 0 ? " active" : ""}" onclick="switchSettingsTab('${_escapeHtml(section.id)}')">
        ${_escapeHtml(section.nav_label || section.title || section.id)}
      </div>
    `).join("") + '<div style="flex-grow: 1;"></div>';

    content.innerHTML = sections
      .map((section, index) => _renderSectionPane({ ...section, active: index === 0 }))
      .join("");

    if (window.AcbModalShell?.bindMinimapCheckbox) {
      window.AcbModalShell.bindMinimapCheckbox();
    } else if (window.AcbModalShell?.syncMinimapCheckbox) {
      window.AcbModalShell.syncMinimapCheckbox();
    }
    if (window.AcbModalShell?.bindIdentityInputs) {
      window.AcbModalShell.bindIdentityInputs();
    }

    window.switchSettingsTab(activeSectionId);
  }

  function _parseFieldValue(field) {
    const input = document.getElementById(field.input_id);
    if (!input) return undefined;

    if (field.type === "boolean") {
      return !!input.checked;
    }
    if (field.type === "integer") {
      return parseInt(input.value, 10);
    }
    if (field.type === "number") {
      return Number(input.value);
    }
    if (field.type === "string[]") {
      return String(input.value || "")
        .split(/[\n,]/g)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return input.value;
  }

  async function openSettingsModal(api) {
    document.getElementById("settings-message").style.display = "none";
    setModalVisible("settings", true);
    try {
      const manifest = await api("/api/settings/manifest");
      if (manifest) {
        _settingsManifest = manifest;
        _renderSettingsManifest(manifest);
      }
    } catch (err) {
      console.error(err);
    }
  }

  function closeSettingsModal(e) {
    if (e && !isOverlayClick(e, "settings")) return;
    setModalVisible("settings", false);
  }

  async function submitSettings(api) {
    const payload = {};
    const sections = Array.isArray(_settingsManifest?.sections) ? _settingsManifest.sections : [];
    for (const section of sections) {
      for (const field of Array.isArray(section.fields) ? section.fields : []) {
        if (!field.editable) continue;
        payload[field.key] = _parseFieldValue(field);
      }
    }

    const msg = document.getElementById("settings-message");

    try {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (res && res.ok) {
        msg.textContent = res.message || _settingsManifest?.save_message || "Saved! Restart server to apply.";
        msg.style.display = "block";
        msg.style.color = "var(--green)";
        setTimeout(() => closeSettingsModal(), 2500);
      } else if (msg) {
        const detail = Array.isArray(res?.errors)
          ? res.errors.join("; ")
          : (res?.detail || "Error saving settings");
        msg.textContent = detail;
        msg.style.display = "block";
        msg.style.color = "var(--red, #f05555)";
      }
    } catch (err) {
      console.error(err);
      if (msg) {
        msg.textContent = "Error saving settings";
        msg.style.display = "block";
        msg.style.color = "var(--red, #f05555)";
      }
    }
  }

  // Thread Settings Modal Functions
  async function openThreadSettingsModal(api) {
    const threadId = window.currentThreadId;
    if (!threadId) {
      console.error("No current thread selected");
      return;
    }

    document.getElementById("thread-settings-message").style.display = "none";
    setModalVisible("thread-settings", true);

    let agentEmojiById = new Map();
    try {
      const agentsRes = await api("/api/agents");
      if (Array.isArray(agentsRes)) {
        agentEmojiById = new Map(
          agentsRes
            .map((a) => [String(a?.id || "").trim(), String(a?.emoji || "").trim()])
            .filter(([id, emoji]) => id && emoji)
        );
      }
    } catch (err) {
      console.warn("Unable to load agent emoji map:", err);
    }

    try {
      const res = await api(`/api/threads/${threadId}/settings`);
      if (res) {
        document.getElementById("ts-timeout-seconds").value = res.timeout_seconds || 60;
        document.getElementById("ts-switch-timeout-seconds").value = res.switch_timeout_seconds || 60;
      }
    } catch (err) {
      console.error("Error loading thread settings:", err);
    }

    // Load current admin info
    try {
      const adminRes = await api(`/api/threads/${threadId}/admin`);
      if (adminRes) {
        // Show current admin (creator or auto-assigned)
        const currentAdminEl = document.getElementById("ts-current-admin");
        const adminLabel = adminRes.admin_name || adminRes.admin_id;
        if (adminLabel) {
          const adminId = String(adminRes.admin_id || "").trim();
          const emoji = (adminId ? agentEmojiById.get(adminId) : "") || String(adminRes.admin_emoji || "").trim() || "🤖";
          const typeLabel = adminRes.admin_type === "creator" ? " (Creator)" : " (Auto-assigned)";
          currentAdminEl.textContent = `${emoji} ${adminLabel}${typeLabel}`;
        } else {
          currentAdminEl.textContent = "Unassigned";
        }
      }
    } catch (err) {
      console.error("Error loading admin info:", err);
    }

  }

  function closeThreadSettingsModal(e) {
    if (e && !isOverlayClick(e, "thread-settings")) return;
    setModalVisible("thread-settings", false);
  }

  async function submitThreadSettings(api) {
    const threadId = window.currentThreadId;
    if (!threadId) {
      console.error("No current thread selected");
      return;
    }

    const timeoutInput = document.getElementById("ts-timeout-seconds");
    const switchTimeoutInput = document.getElementById("ts-switch-timeout-seconds");

    // Validation using HTML5 Native checking
    if (!timeoutInput.reportValidity()) return;
    if (!switchTimeoutInput.reportValidity()) return;

    const timeoutSeconds = parseInt(timeoutInput.value, 10);
    const switchTimeoutSeconds = parseInt(switchTimeoutInput.value, 10);

    const msg = document.getElementById("thread-settings-message");
    const cancelBtn = document.getElementById("ts-btn-cancel");
    const saveBtn = document.getElementById("ts-btn-save");

    const setSubmittingState = (submitting) => {
      if (cancelBtn) cancelBtn.disabled = submitting;
      if (saveBtn) {
        saveBtn.disabled = submitting;
        saveBtn.style.cursor = submitting ? "not-allowed" : "pointer";
      }
    };
    let keepDisabledUntilClose = false;

    try {
      setSubmittingState(true);

      const res = await api(`/api/threads/${threadId}/settings`, {
        method: "POST",
        body: JSON.stringify({
          // Auto administrator stays enabled by default and is not user-configurable in UI.
          auto_administrator_enabled: true,
          auto_coordinator_enabled: true,
          timeout_seconds: timeoutSeconds,
          switch_timeout_seconds: switchTimeoutSeconds,
        }),
      });

      if (!res) {
        throw new Error("No response from server");
      }

      if (res.detail || res.error) {
        const detailText = typeof res.detail === "string" ? res.detail : "Error saving settings";
        msg.textContent = detailText;
        msg.style.display = "block";
        msg.style.color = "var(--red, #f05555)";
        return;
      }

      msg.textContent = "Settings saved successfully!";
      msg.style.display = "block";
      msg.style.color = "var(--green)";
      keepDisabledUntilClose = true;
      setTimeout(() => {
        setSubmittingState(false);
        closeThreadSettingsModal();
      }, 1500);
    } catch (err) {
      console.error("Error saving thread settings:", err);
      msg.textContent = "Error saving settings";
      msg.style.display = "block";
      msg.style.color = "var(--red, #f05555)";
    } finally {
      if (keepDisabledUntilClose) return;
      setSubmittingState(false);
    }
  }

  async function detectThreadLaunchModels(api) {
    if (!api) {
      return null;
    }
    return await loadCliModelDiscovery(api, { force: true });
  }

  window.AcbModals = {
    positionDialogNearClick,
    openThreadModal,
    closeThreadModal,
    submitThreadModal,
    syncThreadLaunchUi,
    addThreadLaunchAgent,
    detectThreadLaunchModels,
    removeThreadLaunchAgent,
    selectThreadLaunchAgent,
    updateThreadLaunchAgentField,
    openAddAgentModal,
    closeAddAgentModal,
    submitAddAgentModal,
    switchAddAgentTab,
    openSettingsModal,
    closeSettingsModal,
    submitSettings,
    openThreadSettingsModal,
    closeThreadSettingsModal,
    submitThreadSettings,
  };

  // Global wrappers for onclick handlers
  function _resolveApi() {
    if (window.AcbApi && typeof window.AcbApi.api === "function") {
      return window.AcbApi.api;
    }
    throw new Error("API layer is not ready: window.AcbApi.api is unavailable");
  }

  window.openThreadSettingsModal = function() {
    const api = _resolveApi();
    openThreadSettingsModal(api);
  };
  window.closeThreadSettingsModal = closeThreadSettingsModal;
  window.openAddAgentModal = function() {
    const api = _resolveApi();
    return openAddAgentModal(api);
  };
  window.closeAddAgentModal = closeAddAgentModal;
  window.submitAddAgentModal = function() {
    const api = _resolveApi();
    return submitAddAgentModal({
      api,
      refreshAgents: typeof window.refreshAgents === "function" ? window.refreshAgents : null,
    });
  };
  window.submitThreadSettings = function() {
    const api = _resolveApi();
    submitThreadSettings(api);
  };

  window.runDiagnostics = async function (btn) {
    const resultsEl = document.getElementById("diagnostics-results");
    const copyBtn = document.getElementById("btn-copy-diagnostics");
    if (!resultsEl || !copyBtn) return;

    btn.disabled = true;
    btn.innerHTML = 'Running... <span id="diag-btn-emoji">⏳</span>';
    resultsEl.style.display = "block";
    resultsEl.textContent = "Connecting to backend...\n";
    copyBtn.style.display = "none";

    let allOk = true;

    try {
      const api = _resolveApi();
      const start = performance.now();
      const res = await api("/api/system/diagnostics");
      const rtt = Math.round(performance.now() - start);

      let out = "";

      out += "========================================================\n"
      out += "                   SYSTEM OVERVIEW                      \n"
      out += "========================================================\n"
      out += `App Directory: ${res.app_dir}\n`;
      out += `Database Path: ${res.db_path}\n`;

      const upHours = Math.floor(res.uptime_seconds / 3600);
      const upMins = Math.floor((res.uptime_seconds % 3600) / 60);
      const upSecs = res.uptime_seconds % 60;
      out += `Server Uptime: ${upHours}h ${upMins}m ${upSecs}s\n`;
      out += `Server Time  : ${res.server_time_utc}\n\n`;

      out += `SQLite Threads : ${res.total_threads}\n`;
      out += `SQLite Messages: ${res.total_messages}\n\n`;

      out += "========================================================\n"
      out += "                 TRANSPORT & SERVICES                   \n"
      out += "========================================================\n"
      out += `[DB] SQLite Check: ${res.db_ok ? "✅ OK" : "❌ FAIL"} (${res.db_latency_ms}ms)\n`;
      if (!res.db_ok) allOk = false;

      out += `[MCP] Service Check: ${res.mcp_ok ? "✅ OK" : "❌ FAIL"}\n`;
      out += `      Tools    : ${res.mcp_tools_count}\n`;
      out += `      Prompts  : ${res.mcp_prompts_count}\n`;
      out += `      Resources: ${res.mcp_resources_count}\n\n`;
      if (!res.mcp_ok) allOk = false;

      out += `[NET] TCP SSE Streams: ${res.active_sse_connections}\n`;
      out += `      SSE Loopback Test: ${res.sse_simulated_ok ? "✅ OK" : "❌ FAIL"}\n`;
      if (!res.sse_simulated_ok) allOk = false;

      out += `[AGT] Registered Agents: ${res.online_agents_total} Online\n`;
      out += `      SSE Transport: ${res.sse_agents_count}\n`;
      out += `      StdIO Transport: ${res.stdio_agents_count}\n`;

      let uiConnected = false;
      if (window.AcbSSE && typeof window.AcbSSE.isConnected === 'function') {
        uiConnected = window.AcbSSE.isConnected();
      } else if (window.AcbSSE) {
        uiConnected = window.AcbSSE.connected;
      }

      out += `\n[UI] SSE Event Stream: ${uiConnected ? "✅ CONNECTED" : "❌ DISCONNECTED"}\n\n`;
      if (!uiConnected) allOk = false;

      out += "========================================================\n"
      out += "                    DIAGNOSTIC LOGS                     \n"
      out += "========================================================\n"
      if (res.logs && Array.isArray(res.logs)) {
        res.logs.forEach(l => {
          out += `> ${l}\n`;
        });
      }

      resultsEl.textContent = out;
      copyBtn.style.display = "block";
    } catch (err) {
      resultsEl.textContent += `\n❌ Error: ${err.message || err}`;
      allOk = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `Run Diagnostics <span id="diag-btn-emoji">${allOk ? "✅" : "❌"}</span>`;
    }
  };

  window.copyDiagnosticsReport = function (btn) {
    const resultsEl = document.getElementById("diagnostics-results");
    if (!resultsEl) return;

    const text = resultsEl.textContent;
    const report = "### AgentChatBus Diagnostics Report\n\n```text\n" + text + "\n```\n\n**User Agent**: " + navigator.userAgent + "\n**URL**: " + window.location.href;

    navigator.clipboard.writeText(report).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }).catch(err => {
      console.error("Failed to copy", err);
      alert("Failed to copy to clipboard");
    });
  };
})();
