import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, parse, resolve as resolvePath } from "node:path";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { callTool, listTools, withToolCallContext } from "../../adapters/mcp/tools.js";
import { SeqMismatchError, MissingSyncFieldsError, ReplyTokenInvalidError, ReplyTokenExpiredError, ReplyTokenReplayError, BusError } from "../../core/types/errors.js";
import {
  BUS_VERSION,
  ConfigValidationError,
  getConfig,
  getConfigDict,
  getSettingsManifest,
  isIpAllowed,
  saveConfigDict,
} from "../../core/config/env.js";
import { resolvePreferredAgentDisplayName } from "../../main.js";
import {
  buildCliMeetingWakePrompt,
  buildCliMcpMeetingPrompt,
  buildCliMcpMeetingPromptPreview,
} from "../../core/services/cliMeetingContextBuilder.js";
import {
  closeMeetingLikeHuman,
  registerThreadSessionClearer,
} from "../../core/services/meetingCloseService.js";
import { CliModelDiscoveryService } from "../../core/services/cliModelDiscovery.js";
import { CliSessionManager, type CliSessionSnapshot } from "../../core/services/cliSessionManager.js";
import { CliMeetingOrchestrator } from "../../core/services/cliMeetingOrchestrator.js";
import { MemoryStore, memoryStore } from "../../core/services/memoryStore.js";
import { registerStore } from "../../core/services/storeSingleton.js";
import { eventBus } from "../../shared/eventBus.js";
import { handleMcpRequest } from "../mcp/handlers.js";
import {
  getOrCreateTransport,
  deleteTransport,
  registerLegacySseTransport,
  connectLegacySseTransport,
  getLegacySseTransport,
} from "../mcp/streamableHttp.js";
import { resolveDefaultWorkspacePath } from "../../core/services/adapters/utils.js";
import { WINDOWS_POWERSHELL } from "../../core/services/adapters/constants.js";

// Allow tests to override the global memoryStore instance
export let memoryStoreInstance: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  return memoryStoreInstance || memoryStore;
}

type JsonBody = Record<string, unknown>;

function decorateAgentsForPresentation<T extends Record<string, any>>(agents: T[]): Array<T & {
  preferred_display_name: string;
  configured_display_name?: string;
}> {
  const used = new Set<string>();
  return agents.map((agent) => {
    const configuredDisplayName = String(agent.display_name || "").trim();
    const legacyFallback = configuredDisplayName || String(agent.name || agent.id || "").trim() || "Unknown";
    const preferredDisplayName = resolvePreferredAgentDisplayName({
      ide: typeof agent.ide === "string" ? agent.ide : undefined,
      model: typeof agent.model === "string" ? agent.model : undefined,
      emoji: typeof agent.emoji === "string" ? agent.emoji : undefined,
      display_name: configuredDisplayName || undefined,
      name: typeof agent.name === "string" ? agent.name : undefined,
      id: typeof agent.id === "string" ? agent.id : undefined,
      existingDisplayNames: used,
    });
    used.add(String(preferredDisplayName || legacyFallback).trim().toLowerCase());
    return {
      ...agent,
      configured_display_name: configuredDisplayName || undefined,
      preferred_display_name: preferredDisplayName || legacyFallback,
      // Keep API compatibility: `display_name` should represent the configured/user-facing
      // name (or legacy fallback), while `preferred_display_name` provides the runtime
      // auto-resolved presentation alias.
      display_name: configuredDisplayName || legacyFallback,
    };
  });
}

function decorateMessageLikeForPresentation<T extends Record<string, any>>(
  message: T,
  presentedAgentsById: Map<string, Record<string, any>>,
): T {
  const authorId = String(message.author_id || "").trim();
  const presentedAgent = authorId ? presentedAgentsById.get(authorId) : undefined;
  if (!presentedAgent) {
    return message;
  }
  return {
    ...message,
    author_name: presentedAgent.preferred_display_name || presentedAgent.display_name || message.author_name,
    author_emoji: String(message.author_emoji || "").trim() || presentedAgent.emoji || "🤖",
  };
}

const THREAD_CLI_WORKSPACE_METADATA_KEY = "cli_workspace";
const THREAD_RESTART_BLUEPRINT_METADATA_KEY = "restart_blueprint";
const RESTART_TOMBSTONE_MARKER = "[restart-tombstone]";

type CliAdapterId = "cursor" | "codex" | "claude" | "gemini" | "copilot";
type CliAdapterMode = "headless" | "interactive" | "direct";

type ThreadRestartBlueprintAgent = {
  participant_agent_id?: string;
  adapter: CliAdapterId;
  mode: CliAdapterMode;
  model?: string;
  reasoning_effort?: string;
  permission_mode?: string;
  initial_instruction?: string;
  prompt_override?: string;
  reentry_prompt_override?: string;
  participant_display_name?: string;
  participant_emoji?: string;
  launch_order: number;
  created_at: string;
};

type ThreadRestartBlueprint = {
  version: 1;
  agents: ThreadRestartBlueprintAgent[];
  updated_at: string;
};

type WorkspaceCleanupMode = "skipped" | "recycle_bin" | "deleted" | "mixed";

type WorkspaceCleanupResult = {
  attempted: boolean;
  target: string | null;
  mode: WorkspaceCleanupMode;
  cleared_entries: number;
  preserved_entries: string[];
};

function normalizeWorkspaceCandidate(value: unknown): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) {
    return undefined;
  }
  try {
    return resolvePath(raw);
  } catch {
    return undefined;
  }
}

function isUsableWorkspaceCandidate(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return existsSync(value);
  } catch {
    return false;
  }
}

function extractThreadCliWorkspace(thread: { metadata?: Record<string, unknown> } | undefined): string | undefined {
  const candidate = thread?.metadata?.[THREAD_CLI_WORKSPACE_METADATA_KEY];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function withThreadWorkspace<T extends { metadata?: Record<string, unknown> }>(
  thread: T,
): T & { workspace?: string } {
  return {
    ...thread,
    workspace: extractThreadCliWorkspace(thread),
  };
}

function resolveCliAdapterLabel(adapter: CliAdapterId): string {
  if (adapter === "cursor") return "Cursor";
  if (adapter === "claude") return "Claude";
  if (adapter === "gemini") return "Gemini";
  if (adapter === "copilot") return "Copilot";
  return "Codex";
}

function resolveCliModeFallbackLabel(mode: CliAdapterMode): string {
  if (mode === "direct") return "Direct App Server";
  if (mode === "headless") return "Headless CLI";
  return "Interactive PTY";
}

function normalizeRestartBlueprintAgent(value: unknown): ThreadRestartBlueprintAgent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const adapter = String(entry.adapter || "").trim().toLowerCase() as CliAdapterId;
  const mode = String(entry.mode || "").trim().toLowerCase() as CliAdapterMode;
  if (!["cursor", "codex", "claude", "gemini", "copilot"].includes(adapter)) {
    return null;
  }
  if (!["headless", "interactive", "direct"].includes(mode)) {
    return null;
  }
  const launchOrder = Number(entry.launch_order);
  return {
    participant_agent_id: String(entry.participant_agent_id || "").trim() || undefined,
    adapter,
    mode,
    model: String(entry.model || "").trim() || undefined,
    reasoning_effort: String(entry.reasoning_effort || "").trim() || undefined,
    permission_mode: String(entry.permission_mode || "").trim() || undefined,
    initial_instruction: typeof entry.initial_instruction === "string"
      ? entry.initial_instruction
      : undefined,
    prompt_override: typeof entry.prompt_override === "string"
      ? entry.prompt_override
      : undefined,
    reentry_prompt_override: typeof entry.reentry_prompt_override === "string"
      ? entry.reentry_prompt_override
      : undefined,
    participant_display_name: String(entry.participant_display_name || "").trim() || undefined,
    participant_emoji: String(entry.participant_emoji || "").trim() || undefined,
    launch_order: Number.isFinite(launchOrder) ? Math.max(0, Math.trunc(launchOrder)) : 0,
    created_at: String(entry.created_at || "").trim() || new Date().toISOString(),
  };
}

function normalizeThreadRestartBlueprint(value: unknown): ThreadRestartBlueprint | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Record<string, unknown>;
  const agents = Array.isArray(source.agents)
    ? source.agents
      .map((entry) => normalizeRestartBlueprintAgent(entry))
      .filter((entry): entry is ThreadRestartBlueprintAgent => Boolean(entry))
      .sort((left, right) => left.launch_order - right.launch_order)
    : [];
  return {
    version: 1,
    agents,
    updated_at: String(source.updated_at || "").trim() || new Date().toISOString(),
  };
}

function extractThreadRestartBlueprint(
  thread: { metadata?: Record<string, unknown> } | undefined,
): ThreadRestartBlueprint | null {
  return normalizeThreadRestartBlueprint(thread?.metadata?.[THREAD_RESTART_BLUEPRINT_METADATA_KEY]);
}

function rememberThreadRestartBlueprintEntry(
  store: MemoryStore,
  threadId: string,
  entry: Omit<ThreadRestartBlueprintAgent, "launch_order" | "created_at">,
): void {
  store.updateThreadMetadata(threadId, (metadata) => {
    const current = normalizeThreadRestartBlueprint(metadata[THREAD_RESTART_BLUEPRINT_METADATA_KEY]);
    const nextAgents = current ? [...current.agents] : [];
    const existingIndex = entry.participant_agent_id
      ? nextAgents.findIndex((agent) => agent.participant_agent_id === entry.participant_agent_id)
      : -1;
    const now = new Date().toISOString();
    const normalizedEntry: ThreadRestartBlueprintAgent = {
      ...entry,
      launch_order: existingIndex >= 0 ? nextAgents[existingIndex].launch_order : nextAgents.length,
      created_at: existingIndex >= 0 ? nextAgents[existingIndex].created_at : now,
    };

    if (existingIndex >= 0) {
      nextAgents[existingIndex] = normalizedEntry;
    } else {
      nextAgents.push(normalizedEntry);
    }

    metadata[THREAD_RESTART_BLUEPRINT_METADATA_KEY] = {
      version: 1,
      agents: nextAgents
        .sort((left, right) => left.launch_order - right.launch_order)
        .map((agent, index) => ({
          ...agent,
          launch_order: index,
        })),
      updated_at: now,
    } satisfies ThreadRestartBlueprint;
    return metadata;
  });
}

function buildThreadRestartTombstoneTopic(store: MemoryStore, topic: string): string {
  const suffix = `${RESTART_TOMBSTONE_MARKER} ${new Date().toISOString()}`;
  let candidate = `${topic} ${suffix}`;
  let attempt = 2;
  while (store.getThreadByTopic(candidate)) {
    candidate = `${topic} ${suffix} ${attempt}`;
    attempt += 1;
  }
  return candidate;
}

async function tryRecycleWorkspaceEntry(targetPath: string): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  const escapedPath = targetPath.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$target = '${escapedPath}'`,
    "if (-not (Test-Path -LiteralPath $target)) { exit 0 }",
    "if (Test-Path -LiteralPath $target -PathType Container) {",
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(",
    "    $target,",
    "    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,",
    "    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,",
    "    [Microsoft.VisualBasic.FileIO.UICancelOption]::DoNothing",
    "  )",
    "} else {",
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(",
    "    $target,",
    "    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,",
    "    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,",
    "    [Microsoft.VisualBasic.FileIO.UICancelOption]::DoNothing",
    "  )",
    "}",
  ].join(" ");

  return await new Promise<boolean>((resolve) => {
    try {
      execFile(
        WINDOWS_POWERSHELL,
        ["-NoProfile", "-Command", script],
        {
          windowsHide: true,
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        },
        (error) => {
          resolve(!error);
        },
      );
    } catch {
      resolve(false);
    }
  });
}

async function clearThreadWorkspaceContents(input: {
  store: MemoryStore;
  threadId: string;
  workspace: string | undefined;
}): Promise<WorkspaceCleanupResult> {
  const target = normalizeWorkspaceCandidate(input.workspace);
  if (!target || !isUsableWorkspaceCandidate(target)) {
    throw new Error("Thread workspace is unavailable; cannot clear workspace contents.");
  }

  const gitMarkerPath = join(target, ".git");
  if (!existsSync(gitMarkerPath)) {
    throw new Error("Workspace cleanup is only allowed when the thread workspace points at a git repository root.");
  }

  const parsed = parse(target);
  if (parsed.root && parsed.root.toLowerCase() === target.toLowerCase()) {
    throw new Error("Refusing to clear a filesystem root directory.");
  }

  const serviceRoot = resolvePath(process.cwd());
  if (serviceRoot.toLowerCase() === target.toLowerCase()) {
    throw new Error("Refusing to clear the AgentChatBus service workspace.");
  }

  const sharedWorkspace = input.store.getThreads(true).some((thread) => {
    if (thread.id === input.threadId) {
      return false;
    }
    const threadWorkspace = normalizeWorkspaceCandidate(extractThreadCliWorkspace(thread));
    return Boolean(threadWorkspace) && threadWorkspace!.toLowerCase() === target.toLowerCase();
  });
  if (sharedWorkspace) {
    throw new Error("Workspace cleanup is blocked because another thread is using the same workspace.");
  }

  const children = await readdir(target, { withFileTypes: true });
  const removableEntries = children.filter((entry) => entry.name !== ".git");
  let recycledCount = 0;
  let deletedCount = 0;

  for (const entry of removableEntries) {
    const entryPath = join(target, entry.name);
    const recycled = await tryRecycleWorkspaceEntry(entryPath);
    if (recycled) {
      recycledCount += 1;
      continue;
    }

    const stats = await lstat(entryPath);
    await rm(entryPath, {
      recursive: stats.isDirectory(),
      force: true,
      maxRetries: 2,
    });
    deletedCount += 1;
  }

  let mode: WorkspaceCleanupMode = "skipped";
  if (recycledCount > 0 && deletedCount > 0) {
    mode = "mixed";
  } else if (recycledCount > 0) {
    mode = "recycle_bin";
  } else if (deletedCount > 0) {
    mode = "deleted";
  }

  return {
    attempted: true,
    target,
    mode,
    cleared_entries: removableEntries.length,
    preserved_entries: [".git"],
  };
}

async function pickDirectoryWithWindowsDialog(currentPath?: string): Promise<string | null> {
  const selectedPath = normalizeWorkspaceCandidate(currentPath);
  const initialPath = selectedPath && isUsableWorkspaceCandidate(selectedPath) ? selectedPath : "";
  const escapedInitialPath = initialPath.replaceAll("'", "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
    "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
    "$owner.Show()",
    "$owner.Activate()",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select a working directory for this AgentChatBus thread.'",
    "$dialog.ShowNewFolderButton = $true",
    escapedInitialPath ? `$dialog.SelectedPath = '${escapedInitialPath}'` : "",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "$owner.Dispose()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {",
    "  [Console]::Out.Write($dialog.SelectedPath)",
    "}",
  ].filter(Boolean).join("; ");

  return await new Promise<string | null>((resolve, reject) => {
    execFile(
      WINDOWS_POWERSHELL,
      ["-NoProfile", "-STA", "-Command", script],
      {
        windowsHide: false,
        timeout: 600_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "Directory picker failed").trim()));
          return;
        }
        const resolvedPath = String(stdout || "").trim();
        resolve(resolvedPath || null);
      },
    );
  });
}

function decorateAgentForPresentation<T extends Record<string, any>>(agent: T | undefined): (T & {
  preferred_display_name: string;
  configured_display_name?: string;
}) | undefined {
  if (!agent) {
    return undefined;
  }
  return decorateAgentsForPresentation([agent])[0];
}

function resolveStaticPath(): string {
  const envStaticPath = getConfig().webUiDir;
  const candidates = [
    envStaticPath,
    join(process.cwd(), "resources", "web-ui"),
    join(process.cwd(), "web-ui"),
    join(process.cwd(), "..", "web-ui"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return candidates[0] ?? join(process.cwd(), "web-ui");
}

function resolvePackageRoot(packageName: string): string | null {
  const segments = packageName.split("/");
  const candidates = [
    join(process.cwd(), "resources", "bundled-server", "node_modules", ...segments),
    join(process.cwd(), "node_modules", ...segments),
    join(process.cwd(), "..", "node_modules", ...segments),
    join(process.cwd(), "..", "..", "node_modules", ...segments),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  const ip = request.ip || request.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

function createRequestAbortContext(request: FastifyRequest, reply: FastifyReply): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  request.raw.on("aborted", abort);
  reply.raw.on("close", abort);

  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    },
  };
}

function createCliThreadSession(input: {
  store: MemoryStore;
  cliMeetingOrchestrator: CliMeetingOrchestrator;
  cliSessionManager: CliSessionManager;
  buildLaunchEnv: (args: {
    threadId: string;
    threadName: string;
    participantAgentId: string;
    participantDisplayName?: string;
  }) => Record<string, string>;
  threadId: string;
  requestedByAgentId: string;
  participantAgentId?: string;
  participantDisplayName?: string;
  adapter?: string;
  mode?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  promptOverride?: string;
  initialInstruction?: string;
  reentryPromptOverride?: string;
  workspace?: string;
  cols?: number;
  rows?: number;
  persistRestartBlueprint?: boolean;
}): CliSessionSnapshot {
  const thread = input.store.getThread(input.threadId);
  if (!thread) {
    throw new Error("Thread not found");
  }

  const participantAgentId = String(input.participantAgentId || "").trim();
  const participantDisplayName = String(input.participantDisplayName || "").trim();
  if (participantAgentId && !input.store.getAgent(participantAgentId)) {
    throw new Error("participant_agent_id does not reference a registered agent");
  }

  const promptSeed = typeof input.initialInstruction === "string"
    ? input.initialInstruction
    : "";
  const exactPromptOverride = typeof input.promptOverride === "string" && input.promptOverride.trim().length > 0
    ? String(input.promptOverride)
    : "";
  const reentryPromptOverride = typeof input.reentryPromptOverride === "string"
    ? input.reentryPromptOverride.trim()
    : "";

  const explicitWorkspace = normalizeWorkspaceCandidate(input.workspace);
  const rawWorkspaceProvided = String(input.workspace || "").trim().length > 0;
  if (rawWorkspaceProvided && (!explicitWorkspace || !isUsableWorkspaceCandidate(explicitWorkspace))) {
    throw new Error("workspace must be an existing directory");
  }
  const threadWorkspace = extractThreadCliWorkspace(thread);
  const resolvedWorkspace = explicitWorkspace || threadWorkspace;
  if (resolvedWorkspace && !isUsableWorkspaceCandidate(resolvedWorkspace)) {
    throw new Error("Thread default workspace is unavailable; update the thread workspace before launching a CLI session");
  }

  const adapter = (String(input.adapter || "cursor").trim() || "cursor") as CliAdapterId;
  let finalPrompt = exactPromptOverride || promptSeed;
  let participantRole: "administrator" | "participant" | undefined;
  let contextDeliveryMode: "join" | "resume" | "incremental" | undefined;
  let lastDeliveredSeq: number | undefined;
  let finalParticipantDisplayName = participantDisplayName || undefined;
  let launchEnv: Record<string, string> | undefined;

  if (participantAgentId) {
    const prepared = input.cliMeetingOrchestrator.prepareSession({
      threadId: input.threadId,
      participantAgentId,
      participantDisplayName: participantDisplayName || undefined,
      initialInstruction: promptSeed,
    });
    finalPrompt = prepared.prompt;
    participantRole = prepared.participantRole;
    contextDeliveryMode = prepared.contextDeliveryMode;
    lastDeliveredSeq = prepared.lastDeliveredSeq;
    finalParticipantDisplayName = prepared.participantDisplayName;
    if (!exactPromptOverride) {
      finalPrompt = buildCliMcpMeetingPrompt({
        store: input.store,
        threadId: input.threadId,
        participantAgentId,
        participantDisplayName: finalParticipantDisplayName,
        participantRole: prepared.participantRole,
        initialInstruction: promptSeed,
        serverUrl: getConfig().host === "0.0.0.0"
          ? `http://127.0.0.1:${getConfig().port}`
          : `http://${getConfig().host}:${getConfig().port}`,
        adapter,
        mode: typeof input.mode === "string" ? input.mode.trim() : undefined,
      }).prompt;
    }
    launchEnv = input.buildLaunchEnv({
      threadId: input.threadId,
      threadName: thread.topic,
      participantAgentId,
      participantDisplayName: finalParticipantDisplayName,
    });
  }

  const session = input.cliSessionManager.createSession({
    threadId: input.threadId,
    threadDisplayName: thread.topic,
    reentryPromptOverride: reentryPromptOverride || undefined,
    adapter,
    mode: typeof input.mode === "string"
      ? input.mode.trim() as CliAdapterMode
      : undefined,
    model: typeof input.model === "string" ? input.model.trim() : undefined,
    reasoningEffort: typeof input.reasoningEffort === "string"
      ? input.reasoningEffort.trim()
      : undefined,
    permissionMode: typeof input.permissionMode === "string"
      ? input.permissionMode.trim()
      : undefined,
    prompt: finalPrompt,
    initialInstruction: promptSeed,
    workspace: resolvedWorkspace,
    requestedByAgentId: input.requestedByAgentId,
    participantAgentId: participantAgentId || undefined,
    participantDisplayName: finalParticipantDisplayName,
    participantRole,
    meetingTransport: "agent_mcp",
    contextDeliveryMode,
    lastDeliveredSeq,
    cols: input.cols,
    rows: input.rows,
    launchEnv,
  });

  if (participantAgentId && input.persistRestartBlueprint !== false) {
    const participantAgent = input.store.getAgent(participantAgentId);
    rememberThreadRestartBlueprintEntry(input.store, input.threadId, {
      participant_agent_id: participantAgentId,
      adapter: session.adapter as CliAdapterId,
      mode: session.mode as CliAdapterMode,
      model: session.model || undefined,
      reasoning_effort: session.reasoning_effort || undefined,
      permission_mode: session.permission_mode || undefined,
      initial_instruction: promptSeed || undefined,
      prompt_override: exactPromptOverride || undefined,
      reentry_prompt_override: reentryPromptOverride || undefined,
      participant_display_name: finalParticipantDisplayName || undefined,
      participant_emoji: participantAgent?.emoji || undefined,
    });
  }

  return session;
}

export function createHttpServer() {
  const fastify = Fastify({ logger: false });
  // If AGENTCHATBUS_DB env is set for this process, create a dedicated store
  // instance so in-process tests can control the DB path and teardown.
  let store: ReturnType<typeof getMemoryStore>;
  // Allow tests to override the DB path using AGENTCHATBUS_TEST_DB
  const cfg = getConfig();
  const envDb = cfg.testDbPath || (cfg.dbPathConfigured ? cfg.dbPath : null);
  // Track ownership: only close the store on shutdown if this server created it.
  const ownsStore = Boolean(envDb);
  if (envDb) {
    try {
      // Lazily create an instance bound to this DB path.
      memoryStoreInstance = new MemoryStore(envDb);
      // Ensure MCP tools and other modules use the same store instance
      try { registerStore(memoryStoreInstance); } catch (_) { }
      store = memoryStoreInstance;
    } catch (e) {
      // Fallback to global store on error
      store = getMemoryStore();
    }
  } else {
    store = getMemoryStore();
  }
  const cliSessionManager = new CliSessionManager();
  const unregisterThreadSessionClearer = registerThreadSessionClearer(async (threadId: string) =>
    cliSessionManager.clearSessionsForThread(threadId)
  );
  const cliModelDiscovery = new CliModelDiscoveryService();
  const cliMeetingOrchestrator = new CliMeetingOrchestrator(store, cliSessionManager);
  const loopbackHost = cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host;
  const serverUrl = `http://${loopbackHost}:${cfg.port}`;

  function buildCliMcpLaunchEnv(input: {
    threadId: string;
    threadName: string;
    participantAgentId: string;
    participantDisplayName?: string;
  }): Record<string, string> {
    const participant = store.getAgent(input.participantAgentId);
    if (!participant?.token) {
      return {};
    }
    return {
      AGENTCHATBUS_BASE_URL: serverUrl,
      AGENTCHATBUS_THREAD_ID: input.threadId,
      AGENTCHATBUS_THREAD_NAME: input.threadName,
      AGENTCHATBUS_AGENT_ID: input.participantAgentId,
      AGENTCHATBUS_AGENT_TOKEN: participant.token,
      AGENTCHATBUS_AGENT_DISPLAY_NAME:
        input.participantDisplayName || resolvePreferredAgentDisplayName(participant) || input.participantAgentId,
    };
  }

  const adminDecisionBySource = new Map<string, {
    action: string;
    new_admin_id?: string;
    notified_admin_id?: string;
  }>();

  function requireAuthorizedAgent(
    request: FastifyRequest,
    reply: FastifyReply,
    body: JsonBody,
    fieldName: string,
  ): string | null {
    const rawAgentId = typeof body[fieldName] === "string" ? body[fieldName] : "";
    const agentId = rawAgentId.trim();
    if (!agentId) {
      reply.code(400);
      void reply.send({ detail: `${fieldName} is required` });
      return null;
    }

    const token = String(request.headers["x-agent-token"] || "");
    if (!token) {
      reply.code(401);
      void reply.send({ detail: "X-Agent-Token header required" });
      return null;
    }
    if (!store.verifyAgentToken(agentId, token)) {
      reply.code(401);
      void reply.send({ detail: "Invalid agent_id/token" });
      return null;
    }
    return agentId;
  }

  function requireSessionController(
    reply: FastifyReply,
    session: { requested_by_agent_id: string },
    agentId: string,
  ): boolean {
    if (session.requested_by_agent_id === agentId) {
      return true;
    }
    reply.code(403);
    void reply.send({ detail: "Only the session owner can control this CLI session" });
    return false;
  }

  void fastify.register(multipart);

  const staticPath = resolveStaticPath();
  void fastify.register(fastifyStatic, {
    root: staticPath,
    prefix: "/static/",
  });
  const xtermRoot = resolvePackageRoot("@xterm/xterm");
  if (xtermRoot) {
    void fastify.register(fastifyStatic, {
      root: xtermRoot,
      prefix: "/static/vendor/xterm/",
      decorateReply: false,
    });
  }
  const xtermFitRoot = resolvePackageRoot("@xterm/addon-fit");
  if (xtermFitRoot) {
    void fastify.register(fastifyStatic, {
      root: xtermFitRoot,
      prefix: "/static/vendor/xterm-addon-fit/",
      decorateReply: false,
    });
  }

  // ── SEC-05: Security middleware ──────────────────────────────────────────────
  // Config is read per-request (not captured at server creation time) to avoid
  // test isolation issues and support dynamic reconfiguration.

  // Patterns of URL prefixes/exact routes that are agent-auth-gated (exempt from SHOW_AD guard)
  const SHOW_AD_AGENT_AUTH_EXEMPT_PREFIXES = [
    "/api/agents/register",
    "/api/agents/heartbeat",
    "/api/agents/resume",
    "/api/agents/unregister",
  ];
  const SHOW_AD_AGENT_AUTH_EXEMPT_EXACT: Array<{ method: string; pattern: RegExp }> = [
    { method: "POST", pattern: /^\/api\/threads$/ },
    { method: "POST", pattern: /^\/api\/threads\/[^/]+\/messages$/ },
  ];

  fastify.addHook("onRequest", async (request, reply) => {
    // Re-read config on each request for test isolation and dynamic support
    const cfg = getConfig();

    // Layer 1: IP allowlist — enforced when AGENTCHATBUS_ALLOWED_HOSTS is set.
    // Loopback addresses always bypass the allowlist.
    if (cfg.allowedHosts.length > 0 && !isLoopbackRequest(request)) {
      const ip = request.ip || request.socket.remoteAddress || "";
      if (!isIpAllowed(ip, cfg.allowedHosts)) {
        reply.code(403);
        await reply.send({ detail: "Forbidden: source IP not in AGENTCHATBUS_ALLOWED_HOSTS" });
        return;
      }
    }

    // Layer 2: SHOW_AD write guard — when SHOW_AD=true, protect all write endpoints
    // that are not already gated by X-Agent-Token.
    if (cfg.showAd) {
      // Allow all GET requests (read-only)
      if (request.method === "GET") return;
      // Allow OPTIONS/HEAD
      if (request.method === "OPTIONS" || request.method === "HEAD") return;
      // Allow loopback — admin can always manage from localhost
      if (isLoopbackRequest(request)) return;

      const url = request.url.split("?")[0];

      // Allow agent-auth-gated endpoints
      if (SHOW_AD_AGENT_AUTH_EXEMPT_PREFIXES.some(p => url === p || url.startsWith(p + "/"))) return;
      for (const { method, pattern } of SHOW_AD_AGENT_AUTH_EXEMPT_EXACT) {
        if (request.method === method && pattern.test(url)) return;
      }

      // All other write/delete endpoints require X-Admin-Token
      const adminToken = request.headers["x-admin-token"] as string | undefined;
      if (!cfg.adminToken || adminToken !== cfg.adminToken) {
        reply.code(401);
        await reply.send({ detail: "Unauthorized: X-Admin-Token required in SHOW_AD mode" });
      }
    }
  });

  // ── End SEC-05 ───────────────────────────────────────────────────────────────

  fastify.get("/", async (request, reply) => {
    return reply.sendFile("index.html");
  });

  fastify.get("/health", async () => {
    const ideStatus = store.getIdeStatus();
    const cfg = getConfig();
    const startupMode = cfg.workspaceDev
      ? "workspace-dev-service"
      : cfg.ownerBootToken
      ? "bundled-ts-service"
      : (ideStatus.ownership_assignable === true
        ? "external-service-extension-managed"
        : (ideStatus.ownership_assignable === false
          ? "external-service-manual"
          : "external-service-unknown"));
    return {
      status: "ok",
      service: "AgentChatBus",
      engine: "node",
      version: BUS_VERSION,
      runtime: `node ${process.version}`,
      transport: "http+sse",
      pty: {
        mode: cfg.ptyUseConpty ? "conpty" : "winpty",
        conpty_enabled: Boolean(cfg.ptyUseConpty),
        platform: process.platform,
      },
      startup_mode: startupMode,
      // TS-only diagnostics enhancement:
      // Python backend may omit this shape. Web clients should treat it as optional.
      // This reports the currently effective msg_wait minimum-wait policy.
      wait_policy: {
        msg_wait_min_timeout_ms: Math.max(0, Number(cfg.msgWaitMinTimeoutMs || 0)),
        enforce_min_timeout: Boolean(cfg.enforceMsgWaitMinTimeout),
        behavior: cfg.enforceMsgWaitMinTimeout
          ? "reject_below_min_non_quick_return"
          : "clamp_below_min_non_quick_return",
      },
      management: {
        ownership_assignable: Boolean(ideStatus.ownership_assignable),
        owner_instance_id: ideStatus.owner_instance_id ?? null,
        registered_sessions_count: ideStatus.registered_sessions_count ?? 0,
      },
    };
  });

  fastify.get("/events", async (_request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const unsubscribe = eventBus.subscribe((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    reply.raw.on("close", () => {
      unsubscribe();
    });
    return reply;
  });

  async function handleStreamableHttpRequest(request: FastifyRequest, reply: FastifyReply) {
    // Get session ID from header (MCP SDK uses 'mcp-session-id')
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;

    console.log(`[MCP] ${request.method} request: session=${headerSessionId?.slice(0, 8) || "new"}`);
    const abortContext = createRequestAbortContext(request, reply);

    try {
      // Get or create transport (async - waits for server to be ready)
      const { transport, sessionId, isNew } = await getOrCreateTransport(headerSessionId);

      // Set session ID header in response
      if (isNew) {
        reply.header("mcp-session-id", sessionId);
      }

      // Use native Node.js request/response objects for StreamableHTTPServerTransport
      await withToolCallContext({ sessionId, abortSignal: abortContext.signal }, () =>
        transport.handleRequest(request.raw, reply.raw, request.body)
      );

      return reply;
    } catch (error: any) {
      console.error(`[MCP] ${request.method} Error: ${error.message}`);
      reply.code(500);
      return { error: error.message };
    } finally {
      abortContext.cleanup();
    }
  }

  // POST /mcp - Streamable HTTP endpoint (preferred modern MCP endpoint)
  fastify.post("/mcp", handleStreamableHttpRequest);

  // GET /mcp - SSE stream for the modern Streamable HTTP transport
  fastify.get("/mcp", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;
    const abortContext = createRequestAbortContext(request, reply);

    try {
      if (!headerSessionId) {
        reply.code(400);
        return { error: "Missing mcp-session-id header" };
      }

      const { transport } = await getOrCreateTransport(headerSessionId);
      await withToolCallContext({ sessionId: headerSessionId, abortSignal: abortContext.signal }, () =>
        transport.handleRequest(request.raw, reply.raw)
      );

      return reply;
    } catch (error: any) {
      console.error(`[MCP] GET Error: ${error.message}`);
      reply.code(500);
      return { error: error.message };
    } finally {
      abortContext.cleanup();
    }
  });

  // DELETE /mcp - Close modern Streamable HTTP session
  fastify.delete("/mcp", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;

    if (headerSessionId) {
      deleteTransport(headerSessionId);
      console.log(`[MCP] DELETE session: ${headerSessionId.slice(0, 8)}`);
    }

    reply.code(204);
    return reply;
  });

  // Keep /mcp/sse as an alias for existing configs already shipped to users.
  fastify.post("/mcp/sse", handleStreamableHttpRequest);
  fastify.get("/mcp/sse", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;
    const abortContext = createRequestAbortContext(request, reply);
    if (!headerSessionId) {
      abortContext.cleanup();
      reply.code(400);
      return { error: "Missing mcp-session-id header" };
    }
    try {
      const { transport } = await getOrCreateTransport(headerSessionId);
      await withToolCallContext({ sessionId: headerSessionId, abortSignal: abortContext.signal }, () =>
        transport.handleRequest(request.raw, reply.raw)
      );
      return reply;
    } catch (error: any) {
      console.error(`[MCP-ALIAS] GET Error: ${error.message}`);
      reply.code(500);
      return { error: error.message };
    } finally {
      abortContext.cleanup();
    }
  });
  fastify.delete("/mcp/sse", async (request, reply) => {
    const headerSessionId = request.headers["mcp-session-id"] as string | undefined;
    if (headerSessionId) {
      deleteTransport(headerSessionId);
    }
    reply.code(204);
    return reply;
  });

  // Deprecated HTTP+SSE transport for clients that still fall back to the old protocol.
  fastify.get("/sse", async (_request, reply) => {
    try {
      const transport = new SSEServerTransport("/messages", reply.raw);
      registerLegacySseTransport(transport);
      await connectLegacySseTransport(transport);
      return reply;
    } catch (error: any) {
      console.error(`[MCP-SSE-LEGACY] GET Error: ${error.message}`);
      if (!reply.sent) {
        reply.code(500);
        return { error: error.message };
      }
      return reply;
    }
  });

  const handleLegacySsePost = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { sessionId?: string };
    // Accept both sessionId and session_id for wider legacy compatibility.
    const fallbackQuery = request.query as { session_id?: string };
    const sessionId =
      (typeof query.sessionId === "string" ? query.sessionId : "") ||
      (typeof fallbackQuery.session_id === "string" ? fallbackQuery.session_id : "");
    if (!sessionId) {
      reply.code(400);
      return { error: "Missing sessionId parameter" };
    }

    const abortContext = createRequestAbortContext(request, reply);
    const transport = getLegacySseTransport(sessionId);
    if (!transport) {
      abortContext.cleanup();
      reply.code(404);
      return { error: "Session not found" };
    }

    try {
      await withToolCallContext({ sessionId, abortSignal: abortContext.signal }, () =>
        transport.handlePostMessage(request.raw, reply.raw, request.body)
      );
      return reply;
    } catch (error: any) {
      console.error(`[MCP-SSE-LEGACY] POST Error: ${error.message}`);
      if (!reply.sent) {
        reply.code(500);
        return { error: error.message };
      }
      return reply;
    } finally {
      abortContext.cleanup();
    }
  };

  fastify.post("/messages", handleLegacySsePost);
  fastify.post("/messages/", handleLegacySsePost);

  // Legacy endpoint for backwards compatibility
  // Supports the full MCP method set used by Python server parity.
  const handleLegacyMcpMessages = async (_request: FastifyRequest, reply: FastifyReply) => {
    const abortContext = createRequestAbortContext(_request, reply);
    const request = _request.body as
      | { id?: string | number | null; method?: string; params?: Record<string, unknown> }
      | undefined;
    if (!request?.method) {
      abortContext.cleanup();
      reply.code(400);
      return { error: "INVALID_REQUEST", detail: "method is required" };
    }

    // Keep legacy response shape for existing tools/list and tools/call tests.
    if (request.method === "tools/list") {
      abortContext.cleanup();
      return { result: listTools() };
    }
    if (request.method === "tools/call") {
      try {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const sessionId =
          typeof _request.headers["mcp-session-id"] === "string"
            ? _request.headers["mcp-session-id"]
            : "legacy-mcp";
        const result = await withToolCallContext({ sessionId, abortSignal: abortContext.signal }, () =>
          callTool(String(params?.name || ""), params?.arguments || {})
        );
        try { console.log(`[mcp-call] ${String(params?.name || "")} => ${JSON.stringify(result).slice(0, 200)}`); } catch (_) {}
        return { result };
      } catch (error) {
        try { console.error(`[mcp-call-error] ${String((error as Error).message || error)}`); } catch (_) {}
        reply.code(400);
        return { error: (error as Error).message };
      } finally {
        abortContext.cleanup();
      }
    }

    // For other MCP methods, run through unified MCP handler and expose result payload.
    try {
      const rpc = await handleMcpRequest({
        id: request.id ?? null,
        method: request.method,
        params: request.params || {},
      });

      if (rpc === null) {
        reply.code(204);
        return reply.send();
      }
      if ("error" in rpc) {
        reply.code(400);
        return { error: (rpc as { error: { message?: string } }).error?.message || "MCP_ERROR", detail: rpc };
      }
      return { result: (rpc as { result?: unknown }).result };
    } finally {
      abortContext.cleanup();
    }
  };

  fastify.post("/mcp/messages/", handleLegacyMcpMessages);
  fastify.post("/mcp/messages", handleLegacyMcpMessages);

  // REST-style MCP tool endpoints (for easier testing)
  fastify.post("/api/mcp/tool/:toolName", async (request, reply) => {
    const params = request.params as { toolName: string };
    const body = request.body as Record<string, unknown> | undefined;
    const abortContext = createRequestAbortContext(request, reply);
    try {
      const sessionId =
        typeof request.headers["mcp-session-id"] === "string"
          ? request.headers["mcp-session-id"]
          : undefined;
      const result = await withToolCallContext({ sessionId, abortSignal: abortContext.signal }, () =>
        callTool(params.toolName, body || {})
      );
      // All tools should return a blocks-style MCP payload for consistency
      try {
        // If the tool already returned a blocks-style array, forward it unchanged
        if (Array.isArray(result)) {
          return result as unknown;
        }
        // Ensure a consistent blocks-style response expected by parity tests
        // Use a safe stringify that tolerates functions and circular refs
        const safeStringify = (obj: unknown) => {
          const seen = new Set();
          return JSON.stringify(obj, (_key, value) => {
            if (typeof value === 'function') return undefined;
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return undefined;
              seen.add(value);
            }
            return value;
          });
        };
        // Always produce a string payload; if stringify returns falsy, fall back to '{}'
        let payloadText = safeStringify(result) || "{}";
        // debug log to help parity tests diagnose response shape in subprocesses
        try { console.log(`[mcp-rest] ${params.toolName} -> ${String(payloadText).slice(0,200)}`); } catch (e) { }
        try {
          // write a copy for debugging when running in a child process
          writeFileSync("tmp_last_mcp_response.json", String(payloadText), { encoding: "utf8" });
        } catch (e) {}
        // Always return a blocks-style array with a text block containing the JSON payload
        return [ { type: "text", text: payloadText } ];
      } catch (e) {
        // If anything unexpected happens here, return a minimal safe text block
        return [ { type: "text", text: "{}" } ];
      }
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    } finally {
      abortContext.cleanup();
    }
  });

  fastify.get("/api/threads", async (request) => {
    const query = request.query as { include_archived?: boolean; status?: string; limit?: number; before?: string };
    let threads = store.getThreads(Boolean(query.include_archived));
    if (query.status) {
      threads = threads.filter((thread) => thread.status === query.status);
    }
    
    // Add waiting_agents for each thread (match Python main.py L990-1002)
    const threadsWithWaitingAgents = threads.map(thread => {
      const waitingAgents = decorateAgentsForPresentation(store.getWaitingAgentsForThread(thread.id));
      return {
        ...withThreadWorkspace(thread),
        waiting_agents: waitingAgents.map(agent => ({
          id: agent.id,
          display_name: agent.preferred_display_name || agent.display_name || agent.name,
          emoji: agent.emoji || "🤖"
        }))
      };
    });
    
    return {
      threads: threadsWithWaitingAgents,
      total: threads.length,
      has_more: false,
      next_cursor: null
    };
  });

  fastify.get("/api/threads/:threadId/messages", async (request, reply) => {
    const params = request.params as { threadId: string };
    const query = request.query as {
      after_seq?: number | string;
      limit?: number | string;
      include_system_prompt?: boolean | string | number;
      priority?: string;
    };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    const afterSeq = Number(query.after_seq || 0);
    const limit = Math.min(Math.max(1, Number(query.limit || 200) || 200), 1000);
    const includeSystemPrompt =
      query.include_system_prompt === true
      || query.include_system_prompt === 1
      || query.include_system_prompt === "1"
      || query.include_system_prompt === "true";
    const priority = typeof query.priority === "string" ? query.priority : undefined;
    if (priority && !["normal", "urgent", "system"].includes(priority)) {
      reply.code(400);
      return { detail: `Invalid priority filter '${priority}'` };
    }
    const presentedAgentsById = new Map(
      decorateAgentsForPresentation(store.listAgents()).map((agent) => [String(agent.id || "").trim(), agent]),
    );
    return store
      .getMessages(params.threadId, afterSeq, includeSystemPrompt, priority)
      .slice(0, limit)
      .map((message) => decorateMessageLikeForPresentation(message, presentedAgentsById));
  });

  fastify.get("/api/threads/:threadId/transcript", async (request, reply) => {
    const params = request.params as { threadId: string };
    const query = request.query as {
      after_seq?: number | string;
      limit?: number | string;
      include_system_prompt?: boolean | string | number;
      priority?: string;
    };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    const afterSeq = Number(query.after_seq || 0);
    const limit = Math.min(Math.max(1, Number(query.limit || 400) || 400), 2000);
    const includeSystemPrompt =
      query.include_system_prompt === true
      || query.include_system_prompt === 1
      || query.include_system_prompt === "1"
      || query.include_system_prompt === "true";
    const priority = typeof query.priority === "string" ? query.priority : undefined;
    if (priority && !["normal", "urgent", "system"].includes(priority)) {
      reply.code(400);
      return { detail: `Invalid priority filter '${priority}'` };
    }
    const presentedAgentsById = new Map(
      decorateAgentsForPresentation(store.listAgents()).map((agent) => [String(agent.id || "").trim(), agent]),
    );
    return store
      .getHumanTranscript(params.threadId, afterSeq, includeSystemPrompt, priority, limit)
      .map((entry) => decorateMessageLikeForPresentation(entry, presentedAgentsById));
  });

  fastify.get("/api/threads/:threadId/cli-sessions", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    const settings = store.getThreadSettings(params.threadId);
    const currentAdminId = settings?.creator_admin_id || settings?.auto_assigned_admin_id || null;
    const agentEmojiById = new Map(
      store.listAgents().map((agent) => [String(agent.id || "").trim(), String(agent.emoji || "").trim()]),
    );
    return {
      sessions: cliSessionManager.listSessionsForThread(params.threadId).map((session) => {
        const participantAgentId = String(session.participant_agent_id || "").trim();
        return {
          ...session,
          participant_emoji: participantAgentId ? (agentEmojiById.get(participantAgentId) || null) : null,
          resolved_participant_role: participantAgentId
            ? (participantAgentId === currentAdminId ? "administrator" : "participant")
            : session.participant_role || null,
        };
      }),
    };
  });

  fastify.post("/api/threads/:threadId/sync-context", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return store.issueSyncContext(params.threadId);
  });

  fastify.get("/api/cli-defaults", async () => {
    const resolution = resolveDefaultWorkspacePath();
    return {
      workspace: resolution.workspace,
      source: resolution.source,
      configured_workspace: resolution.configuredWorkspace,
      candidates: resolution.candidates,
      fallback_chain: [
        "AGENTCHATBUS_CLI_WORKSPACE",
        "process.cwd()",
        "homedir()",
      ],
    };
  });

  fastify.post("/api/system/pick-directory", async (request, reply) => {
    if (process.platform !== "win32") {
      reply.code(501);
      return { detail: "Native directory picker is only implemented on Windows in this build." };
    }
    try {
      const body = request.body as JsonBody;
      const path = await pickDirectoryWithWindowsDialog(
        typeof body?.current_path === "string" ? body.current_path : undefined,
      );
      return {
        ok: true,
        canceled: !path,
        path: path || null,
      };
    } catch (error) {
      reply.code(500);
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.post("/api/cli/meeting-prompt-preview", async (request, reply) => {
    const body = request.body as JsonBody;
    const threadId = typeof body.thread_id === "string" ? body.thread_id.trim() : "";
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    const existingThread = threadId ? store.getThread(threadId) : undefined;
    if (!threadId && !topic) {
      reply.code(400);
      return { detail: "thread_id or topic is required" };
    }
    if (threadId && !existingThread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }

    const participantRole = String(body.participant_role || "").trim() === "administrator"
      ? "administrator"
      : "participant";

    try {
      const envelope = buildCliMcpMeetingPromptPreview({
        store,
        threadId: threadId || undefined,
        topic: topic || undefined,
        participantRole,
        participantDisplayName: typeof body.participant_display_name === "string"
          ? body.participant_display_name.trim()
          : undefined,
        participantAgentId: typeof body.participant_agent_id === "string"
          ? body.participant_agent_id.trim()
          : undefined,
        participantToken: typeof body.participant_token === "string"
          ? body.participant_token.trim()
          : undefined,
        administratorName: typeof body.administrator_name === "string"
          ? body.administrator_name.trim()
          : undefined,
        administratorAgentId: typeof body.administrator_agent_id === "string"
          ? body.administrator_agent_id.trim()
          : undefined,
        initialInstruction: typeof body.initial_instruction === "string"
          ? body.initial_instruction
          : undefined,
        adapter: typeof body.adapter === "string" ? body.adapter.trim() : undefined,
        mode: typeof body.mode === "string" ? body.mode.trim() : undefined,
      });
      return {
        prompt: envelope.prompt,
        reentry_prompt: String(body.reentry_prompt_override || "").trim()
          || buildCliMeetingWakePrompt(existingThread?.topic || topic || threadId || "current thread"),
        delivered_seq: envelope.deliveredSeq,
        participant_role: participantRole,
        administrator: envelope.administrator,
        resolution: envelope.resolution,
      };
    } catch (error) {
      reply.code(400);
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.post("/api/threads/:threadId/cli-sessions", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }

    const requestedByAgentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!requestedByAgentId) {
      return reply;
    }
    try {
      const session = createCliThreadSession({
        store,
        cliMeetingOrchestrator,
        cliSessionManager,
        buildLaunchEnv: buildCliMcpLaunchEnv,
        threadId: params.threadId,
        requestedByAgentId,
        participantAgentId: typeof body.participant_agent_id === "string"
          ? body.participant_agent_id.trim()
          : undefined,
        participantDisplayName: typeof body.participant_display_name === "string"
          ? body.participant_display_name.trim()
          : undefined,
        adapter: typeof body.adapter === "string" ? body.adapter : undefined,
        mode: typeof body.mode === "string" ? body.mode : undefined,
        model: typeof body.model === "string" ? body.model.trim() : undefined,
        reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
        permissionMode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
        promptOverride: typeof body.prompt === "string" ? body.prompt : undefined,
        initialInstruction: typeof body.initial_instruction === "string"
          ? body.initial_instruction
          : undefined,
        reentryPromptOverride: typeof body.reentry_prompt_override === "string"
          ? body.reentry_prompt_override
          : undefined,
        workspace: typeof body.workspace === "string" ? body.workspace : undefined,
        cols: body.cols === undefined ? undefined : Number(body.cols),
        rows: body.rows === undefined ? undefined : Number(body.rows),
      });
      reply.code(201);
      return { session };
    } catch (error) {
      reply.code(400);
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.get("/api/cli-models", async () => {
    return cliModelDiscovery.getSnapshot();
  });

  fastify.post("/api/cli-models/discover", async () => {
    return await cliModelDiscovery.refreshAll();
  });

  fastify.post("/api/threads", async (request, reply) => {
    const body = request.body as JsonBody;
    const topic = String(body.topic || "").trim();
    if (!topic) {
      reply.code(400);
      return { detail: "topic is required" };
    }

    const creatorAgentIdRaw = typeof body.creator_agent_id === "string" ? body.creator_agent_id : "";
    const creatorAgentId = creatorAgentIdRaw.trim();
    if (!creatorAgentId) {
      reply.code(400);
      return { detail: "creator_agent_id is required" };
    }

    const token = String(request.headers["x-agent-token"] || "");
    if (!token) {
      reply.code(401);
      return { detail: "X-Agent-Token header required to create thread as a registered agent" };
    }
    if (!store.verifyAgentToken(creatorAgentId, token)) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }

    const creator = store.getAgent(creatorAgentId);
    if (!creator) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }

    const assignCreatorAdmin = body.assign_creator_admin !== false;
    const requestedWorkspace = normalizeWorkspaceCandidate(body.workspace);
    const rawWorkspaceProvided = String(body.workspace || "").trim().length > 0;
    if (rawWorkspaceProvided && (!requestedWorkspace || !isUsableWorkspaceCandidate(requestedWorkspace))) {
      reply.code(400);
      return { detail: "workspace must be an existing directory" };
    }
    const threadMetadata = requestedWorkspace
      ? { [THREAD_CLI_WORKSPACE_METADATA_KEY]: requestedWorkspace }
      : undefined;

    const created = store.createThread(
      topic,
      typeof body.system_prompt === "string" ? body.system_prompt : undefined,
      undefined,
      {
        metadata: threadMetadata,
        creatorAdminId: assignCreatorAdmin ? creatorAgentId : undefined,
        creatorAdminName: assignCreatorAdmin ? resolvePreferredAgentDisplayName(creator) : undefined,
        applySystemPromptContentFilter: true
      }
    );

    reply.code(201);
    return {
      id: created.thread.id,
      topic: created.thread.topic,
      status: created.thread.status,
      system_prompt: created.thread.system_prompt,
      metadata: created.thread.metadata,
      workspace: extractThreadCliWorkspace(created.thread),
      created_at: created.thread.created_at,
      updated_at: created.thread.updated_at,
      current_seq: created.sync.current_seq,
      reply_token: created.sync.reply_token,
      reply_window: created.sync.reply_window
    };
  });

  fastify.post("/api/threads/:threadId/restart", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    const requestedByAgentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!requestedByAgentId) {
      return reply;
    }

    const sourceThread = store.getThread(params.threadId);
    if (!sourceThread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }

    const clearWorkspace = body.clear_workspace === true;
    const sourceSettings = store.getThreadSettings(params.threadId);
    const sourceBlueprint = extractThreadRestartBlueprint(sourceThread);
    const sourceAgents = sourceBlueprint?.agents || [];
    const sourceWorkspace = extractThreadCliWorkspace(sourceThread);
    const nextThreadMetadata = { ...(sourceThread.metadata || {}) };
    delete nextThreadMetadata[THREAD_RESTART_BLUEPRINT_METADATA_KEY];

    const workspaceCleanup: WorkspaceCleanupResult = {
      attempted: false,
      target: sourceWorkspace || null,
      mode: "skipped",
      cleared_entries: 0,
      preserved_entries: sourceWorkspace ? [".git"] : [],
    };

    const tombstoneTopic = buildThreadRestartTombstoneTopic(store, sourceThread.topic);
    const newParticipantAgents: Array<ReturnType<typeof store.registerAgent>> = [];
    let renamedSource = false;
    let newThreadId = "";
    let newThreadSync: {
      current_seq: number;
      reply_token: string;
      reply_window: { expires_at: string; max_new_messages: number };
    } | null = null;

    try {
      const renamedThread = store.renameThread(params.threadId, tombstoneTopic);
      if (!renamedThread) {
        throw new Error("Failed to reserve the existing thread topic for restart.");
      }
      renamedSource = true;

      await cliSessionManager.clearSessionsForThread(params.threadId);

      if (clearWorkspace) {
        const cleanupResult = await clearThreadWorkspaceContents({
          store,
          threadId: params.threadId,
          workspace: sourceWorkspace,
        });
        workspaceCleanup.attempted = cleanupResult.attempted;
        workspaceCleanup.target = cleanupResult.target;
        workspaceCleanup.mode = cleanupResult.mode;
        workspaceCleanup.cleared_entries = cleanupResult.cleared_entries;
        workspaceCleanup.preserved_entries = cleanupResult.preserved_entries;
      }

      for (const blueprintAgent of sourceAgents) {
        newParticipantAgents.push(store.registerAgent({
          ide: resolveCliAdapterLabel(blueprintAgent.adapter),
          model: blueprintAgent.model || resolveCliModeFallbackLabel(blueprintAgent.mode),
          display_name: blueprintAgent.participant_display_name,
          emoji: blueprintAgent.participant_emoji,
        }));
      }

      const creatorAgent = newParticipantAgents[0];
      const created = store.createThread(
        sourceThread.topic,
        sourceThread.system_prompt,
        sourceThread.template_id,
        {
          metadata: Object.keys(nextThreadMetadata).length > 0 ? nextThreadMetadata : undefined,
          creatorAdminId: creatorAgent?.id,
          creatorAdminName: creatorAgent
            ? resolvePreferredAgentDisplayName(creatorAgent)
            : undefined,
          applySystemPromptContentFilter: true,
        },
      );
      newThreadId = created.thread.id;
      newThreadSync = created.sync;

      if (sourceSettings) {
        store.updateThreadSettings(newThreadId, {
          auto_administrator_enabled: sourceSettings.auto_administrator_enabled,
          timeout_seconds: sourceSettings.timeout_seconds,
          switch_timeout_seconds: sourceSettings.switch_timeout_seconds,
        });
      }

      for (let index = 0; index < sourceAgents.length; index += 1) {
        const blueprintAgent = sourceAgents[index];
        const participantAgent = newParticipantAgents[index];
        if (!participantAgent) {
          throw new Error(`Missing participant agent registration for launch slot ${index + 1}.`);
        }
        createCliThreadSession({
          store,
          cliMeetingOrchestrator,
          cliSessionManager,
          buildLaunchEnv: buildCliMcpLaunchEnv,
          threadId: newThreadId,
          requestedByAgentId,
          participantAgentId: participantAgent.id,
          participantDisplayName: blueprintAgent.participant_display_name,
          adapter: blueprintAgent.adapter,
          mode: blueprintAgent.mode,
          model: blueprintAgent.model,
          reasoningEffort: blueprintAgent.reasoning_effort,
          permissionMode: blueprintAgent.permission_mode,
          promptOverride: blueprintAgent.prompt_override,
          initialInstruction: blueprintAgent.initial_instruction,
          reentryPromptOverride: blueprintAgent.reentry_prompt_override,
          workspace: sourceWorkspace,
          cols: 120,
          rows: 32,
        });
      }

      const sourceParticipantIds = new Set(
        sourceAgents
          .map((agent) => String(agent.participant_agent_id || "").trim())
          .filter(Boolean),
      );

      const deleted = store.deleteThread(params.threadId);
      if (!deleted) {
        throw new Error("Failed to delete the original thread after restart.");
      }

      const otherThreads = store.getThreads(true);
      for (const sourceParticipantId of sourceParticipantIds) {
        const stillReferenced = otherThreads.some((thread) => {
          if (thread.id === params.threadId || thread.id === newThreadId) {
            return false;
          }
          return store.getThreadAgents(thread.id).some((agent) => agent.id === sourceParticipantId);
        });
        if (stillReferenced) {
          continue;
        }
        const sourceParticipant = store.getAgent(sourceParticipantId);
        if (!sourceParticipant?.token) {
          continue;
        }
        store.unregisterAgent(sourceParticipantId, sourceParticipant.token);
      }

      const newThread = store.getThread(newThreadId);
      if (!newThread || !newThreadSync) {
        throw new Error("Restart succeeded but the new thread could not be loaded.");
      }

      reply.code(200);
      return {
        ok: true,
        old_thread_id: params.threadId,
        new_thread: {
          id: newThread.id,
          topic: newThread.topic,
          status: newThread.status,
          system_prompt: newThread.system_prompt,
          metadata: newThread.metadata,
          workspace: extractThreadCliWorkspace(newThread),
          created_at: newThread.created_at,
          updated_at: newThread.updated_at,
          current_seq: newThreadSync.current_seq,
          reply_token: newThreadSync.reply_token,
          reply_window: newThreadSync.reply_window,
        },
        restarted_agents_count: sourceAgents.length,
        workspace_cleanup: workspaceCleanup,
      };
    } catch (error) {
      if (newThreadId) {
        try {
          await cliSessionManager.clearSessionsForThread(newThreadId);
        } catch {
          // Best-effort rollback.
        }
        try {
          store.deleteThread(newThreadId);
        } catch {
          // Best-effort rollback.
        }
      }

      for (const participantAgent of newParticipantAgents) {
        const latestAgent = store.getAgent(participantAgent.id);
        if (!latestAgent?.token) {
          continue;
        }
        try {
          store.unregisterAgent(latestAgent.id, latestAgent.token);
        } catch {
          // Best-effort rollback.
        }
      }

      if (renamedSource) {
        try {
          store.renameThread(params.threadId, sourceThread.topic);
        } catch {
          // Best-effort rollback.
        }
      }

      reply.code(400);
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.post("/api/threads/:threadId/messages", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    const author = String(body.author || "human");
    const role = (typeof body.role === "string" ? body.role : "user") as any;

    if (role === "system" && (author === "human" || author === "")) {
      reply.code(400);
      return { detail: "role 'system' is not allowed for human messages" };
    }

    let expectedLastSeq = typeof body.expected_last_seq === "number" ? body.expected_last_seq : undefined;
    let replyToken = typeof body.reply_token === "string" ? body.reply_token : undefined;

    if (expectedLastSeq === undefined || !replyToken) {
      const sync = store.issueSyncContext(params.threadId);
      expectedLastSeq = sync.current_seq;
      replyToken = sync.reply_token;
    }

    const msgMetadata = (typeof body.metadata === "object" && body.metadata !== null)
      ? { ...(body.metadata as Record<string, unknown>) }
      : {};
    if (Array.isArray(body.mentions)) {
      msgMetadata.mentions = body.mentions;
    }
    if (Array.isArray(body.images)) {
      msgMetadata.images = body.images;
    }

    try {
      const message = store.postMessage({
        threadId: params.threadId,
        author,
        content: String(body.content || ""),
        expectedLastSeq,
        replyToken,
        role,
        metadata: Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined,
        replyToMsgId: typeof body.reply_to_msg_id === "string" ? body.reply_to_msg_id : undefined,
        priority: (typeof body.priority === "string" ? body.priority : "normal") as any
      });

      reply.code(201);
      return {
        id: message.id,
        seq: message.seq,
        author: message.author,
        author_id: message.author_id,
        author_name: message.author_name,
        author_emoji: message.author_emoji || "🤖",
        role: message.role,
        content: message.content,
        created_at: message.created_at,
        metadata: message.metadata,
        reply_to_msg_id: message.reply_to_msg_id,
        priority: message.priority
      };
    } catch (error) {
      // Prefer structured BusError handling
      if (error instanceof SeqMismatchError || (error as any)?.detail?.error === 'SEQ_MISMATCH') {
        reply.code(409);
        const err = error as SeqMismatchError | any;
        return { 
          error: 'SEQ_MISMATCH',
          current_seq: err.current_seq,
          expected_last_seq: err.expected_last_seq,
          new_messages_1st_read: err.new_messages,
          action: 'READ_MESSAGES_THEN_CALL_MSG_WAIT'
        };
      }
      if (error instanceof ReplyTokenReplayError || (error as any)?.detail?.error === 'TOKEN_REPLAY') {
        // Tests expect TOKEN_REPLAY to surface as a 400 with detail.error = 'TOKEN_REPLAY'
        reply.code(400);
        return { detail: (error as any).detail || { error: 'TOKEN_REPLAY' } };
      }
      if (error instanceof MissingSyncFieldsError) {
        reply.code(400);
        return { detail: (error as any).detail || { error: 'MISSING_SYNC_FIELDS' } };
      }
      if (error instanceof ReplyTokenInvalidError || error instanceof ReplyTokenExpiredError) {
        reply.code(400);
        return { detail: (error as any).detail || { error: 'TOKEN_INVALID' } };
      }
      if ((error as Error).message === "Thread not found") {
        reply.code(404);
        return { detail: "Thread not found" };
      }
      // Fallback: if it's a BusError with detail, surface it
      if ((error as any)?.detail) {
        reply.code(400);
        return { detail: (error as any).detail };
      }
      reply.code(400);
      return { detail: (error as Error).message };
    }
  });

  fastify.get("/api/agents", async () => decorateAgentsForPresentation(store.listAgents()));

  fastify.get("/api/cli-sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const session = cliSessionManager.getSession(params.sessionId);
    if (!session) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    return { session };
  });

  fastify.get("/api/cli-sessions/:sessionId/output", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = request.query as { after?: number | string; limit?: number | string };
    const output = cliSessionManager.getSessionOutput(
      params.sessionId,
      Number(query.after || 0),
      Number(query.limit || 200),
    );
    if (!output) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    return output;
  });

  fastify.post("/api/cli-sessions/:sessionId/restart", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    const existingSession = cliSessionManager.getSession(params.sessionId);
    if (!existingSession) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    if (!requireSessionController(reply, existingSession, agentId)) {
      return reply;
    }
    try {
      if (existingSession.participant_agent_id) {
        const prepared = cliMeetingOrchestrator.prepareSession({
          threadId: existingSession.thread_id,
          participantAgentId: existingSession.participant_agent_id,
          participantDisplayName: existingSession.participant_display_name,
          initialInstruction: existingSession.initial_instruction,
        });
        const threadName = store.getThread(existingSession.thread_id)?.topic || existingSession.thread_id;
        const reentryPrompt = String(existingSession.reentry_prompt_override || "").trim()
          || buildCliMeetingWakePrompt(threadName);
        cliSessionManager.updateSessionLaunchEnv(
          params.sessionId,
          buildCliMcpLaunchEnv({
            threadId: existingSession.thread_id,
            threadName,
            participantAgentId: existingSession.participant_agent_id,
            participantDisplayName: existingSession.participant_display_name,
          }),
        );
        cliSessionManager.updateSessionThreadDisplayName(
          params.sessionId,
          threadName,
        );
        cliSessionManager.updateMeetingState(params.sessionId, {
          participant_role: prepared.participantRole,
          context_delivery_mode: "resume",
          meeting_post_state: "pending",
          meeting_post_error: "",
        });
        const session = await cliSessionManager.restartSession(params.sessionId, {
          prompt: reentryPrompt,
          promptHistoryKind: "wake",
          contextDeliveryMode: "resume",
        });
        if (!session) {
          reply.code(404);
          return { detail: "CLI session not found" };
        }
        return { session, requested_by_agent_id: agentId };
      }
      const session = await cliSessionManager.restartSession(params.sessionId);
      if (!session) {
        reply.code(404);
        return { detail: "CLI session not found" };
      }
      return { session, requested_by_agent_id: agentId };
    } catch (error) {
      reply.code(400);
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.post("/api/cli-sessions/:sessionId/stop", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    const existingSession = cliSessionManager.getSession(params.sessionId);
    if (!existingSession) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    if (!requireSessionController(reply, existingSession, agentId)) {
      return reply;
    }
    const session = await cliSessionManager.stopSession(params.sessionId);
    if (!session) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    return { session, requested_by_agent_id: agentId };
  });

  fastify.post("/api/cli-sessions/:sessionId/resize", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    const existingSession = cliSessionManager.getSession(params.sessionId);
    if (!existingSession) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    if (!requireSessionController(reply, existingSession, agentId)) {
      return reply;
    }
    const cols = Number(body.cols);
    const rows = Number(body.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      reply.code(400);
      return { detail: "cols and rows are required" };
    }
    const result = await cliSessionManager.resizeSession(params.sessionId, cols, rows);
    if (!result) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    reply.code(result.ok ? 200 : 400);
    return { ...result, requested_by_agent_id: agentId };
  });

  fastify.post("/api/cli-sessions/:sessionId/input", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = request.body as JsonBody;
    const agentId = requireAuthorizedAgent(request, reply, body, "requested_by_agent_id");
    if (!agentId) {
      return reply;
    }
    const existingSession = cliSessionManager.getSession(params.sessionId);
    if (!existingSession) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    if (!requireSessionController(reply, existingSession, agentId)) {
      return reply;
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) {
      reply.code(400);
      return { detail: "text is required" };
    }
    const result = await cliSessionManager.sendInput(params.sessionId, text);
    if (!result) {
      reply.code(404);
      return { detail: "CLI session not found" };
    }
    reply.code(result.ok ? 200 : 400);
    return { ...result, requested_by_agent_id: agentId };
  });

  fastify.get("/api/threads/:threadId/agents", async (request) => {
    const params = request.params as { threadId: string };
    return decorateAgentsForPresentation(store.getThreadAgents(params.threadId));
  });

  fastify.get("/api/agents/:agentId", async (request, reply) => {
    const params = request.params as { agentId: string };
    const agent = store.getAgent(params.agentId);
    if (!agent) {
      reply.code(404);
      return { detail: "Agent not found" };
    }
    return decorateAgentForPresentation(agent);
  });

  fastify.put("/api/agents/:agentId", async (request, reply) => {
    const params = request.params as { agentId: string };
    const body = request.body as JsonBody;
    const { validateEmoji } = await import("../../main.js");
    const validatedEmoji = typeof body.emoji === "string" ? validateEmoji(body.emoji) : undefined;
    const agent = store.updateAgent(params.agentId, String(body.token || ""), {
      description: typeof body.description === "string" ? body.description : undefined,
      display_name: typeof body.display_name === "string" ? body.display_name : undefined,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
      skills: Array.isArray(body.skills) ? body.skills : undefined,
      emoji: validatedEmoji !== undefined ? (validatedEmoji || undefined) : undefined
    });
    if (!agent) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true, ...decorateAgentForPresentation(agent), agent_id: agent.id };
  });

  fastify.post("/api/agents/register", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      const ide = String(body.ide || "CLI");
      const model = String(body.model || "unknown");
      const { validateEmoji } = await import("../../main.js");
      const validatedEmoji = typeof body.emoji === "string" ? validateEmoji(body.emoji) : null;
      const agent = store.registerAgent({
        ide,
        model,
        description: typeof body.description === "string" ? body.description : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
        display_name: typeof body.display_name === "string" ? body.display_name : undefined,
        skills: Array.isArray(body.skills) ? body.skills : undefined,
        emoji: validatedEmoji || undefined
      });
      reply.code(200);
      const cfg = getConfig();
      const isShowAd = cfg.showAd;
      const presentedAgent = decorateAgentForPresentation(agent)!;
      return {
        ok: true,
        id: agent.id,
        agent_id: agent.id,
        name: agent.name,
        display_name: presentedAgent.display_name,
        preferred_display_name: presentedAgent.preferred_display_name,
        configured_display_name: presentedAgent.configured_display_name,
        // SEC-05: Suppress token in public demo mode (SHOW_AD=true) to prevent token leakage.
        // Private deployments (localhost or non-SHOW_AD) still receive the token for agent auth.
        ...(cfg.showAd ? {} : { token: agent.token }),
        capabilities: agent.capabilities,
        skills: agent.skills,
        emoji: (agent as any).emoji || "🤖",
        ...(isShowAd ? { restricted_mode: true, restrictions: ["no_filesystem_disclosure"] } : {})
      };
    } catch (err) {
      console.error("Registration error:", err);
      reply.code(500);
      return { detail: (err as Error).message };
    }
  });

  fastify.post("/api/agents/heartbeat", async (request, reply) => {
    const body = request.body as JsonBody;
    const ok = store.heartbeatAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!ok) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true };
  });

  fastify.post("/api/agents/resume", async (request, reply) => {
    const body = request.body as JsonBody;
    const agent = store.resumeAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!agent) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    const presentedAgent = decorateAgentForPresentation(agent)!;
    return {
      ok: true,
      agent_id: agent.id,
      name: agent.name,
      display_name: presentedAgent.display_name,
      preferred_display_name: presentedAgent.preferred_display_name,
      configured_display_name: presentedAgent.configured_display_name,
      is_online: agent.is_online,
      last_heartbeat: agent.last_heartbeat
    };
  });

  fastify.post("/api/agents/unregister", async (request, reply) => {
    const body = request.body as JsonBody;
    const ok = store.unregisterAgent(String(body.agent_id || ""), String(body.token || ""));
    if (!ok) {
      reply.code(401);
      return { detail: "Invalid agent_id/token" };
    }
    return { ok: true };
  });

  fastify.get("/api/logs", async (request) => {
    const query = request.query as { after?: number; limit?: number };
    return store.getLogs(Number(query.after || 0), Number(query.limit || 200));
  });

  fastify.get("/api/system/diagnostics", async () => store.getDiagnostics());

  fastify.get("/api/ide/status", async (request) => {
    const query = request.query as { instance_id?: string; session_token?: string };
    return store.getIdeStatus(query.instance_id, query.session_token);
  });

  fastify.post("/api/ide/register", async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "IDE registration APIs are only available from localhost" };
    }
    const body = request.body as JsonBody;
    return store.registerIde({
      instance_id: String(body.instance_id || ""),
      ide_label: String(body.ide_label || ""),
      claim_owner: Boolean(body.claim_owner),
      owner_boot_token: typeof body.owner_boot_token === "string" ? body.owner_boot_token : undefined,
    });
  });

  fastify.post("/api/ide/heartbeat", async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "IDE registration APIs are only available from localhost" };
    }
    try {
      const body = request.body as JsonBody;
      return store.ideHeartbeat({
        instance_id: String(body.instance_id || ""),
        session_token: String(body.session_token || "")
      });
    } catch (error) {
      reply.code(403);
      return { detail: (error as Error).message };
    }
  });

  fastify.post("/api/ide/unregister", async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "IDE registration APIs are only available from localhost" };
    }
    try {
      const body = request.body as JsonBody;
      const result = store.ideUnregister({
        instance_id: String(body.instance_id || ""),
        session_token: String(body.session_token || "")
      });
      if (result.shutdown_requested) {
        setTimeout(() => process.exit(0), 50);
      }
      return result;
    } catch (error) {
      reply.code(403);
      return { detail: (error as Error).message };
    }
  });

  fastify.post("/api/shutdown", async (request, reply) => {
    const body = request.body as JsonBody;
    const force = Boolean(body.force);

    if (!isLoopbackRequest(request)) {
      reply.code(403);
      return { detail: "Shutdown is only allowed from localhost" };
    }

    if (!force) {
      try {
        store.authorizeIdeShutdown({
          instance_id: String(body.instance_id || ""),
          session_token: String(body.session_token || ""),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.code(message.includes("registered") ? 404 : 403);
        return { detail: message };
      }
    }

    reply.code(200);
    setTimeout(() => process.exit(0), 50);
    return { ok: true, force };
  });

  const setThreadStatus = async (
    request: FastifyRequest,
    reply: FastifyReply,
    status: string,
  ) => {
    const params = request.params as { threadId: string };
    const ok = store.setThreadStatus(params.threadId, status as never);
    if (!ok) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return { ok: true };
  };

  fastify.post("/api/threads/:threadId/archive", async (request, reply) => setThreadStatus(request, reply, "archived"));
  fastify.post("/api/threads/:threadId/unarchive", async (request, reply) => setThreadStatus(request, reply, "discuss"));
  fastify.post("/api/threads/:threadId/rename", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = (request.body || {}) as JsonBody;
    const topic = String(body.topic || "").trim();
    if (!topic) {
      reply.code(400);
      return { detail: "topic is required" };
    }
    try {
      const renamed = store.renameThread(params.threadId, topic);
      if (!renamed) {
        reply.code(404);
        return { detail: "Thread not found" };
      }
      return { ok: true, thread: renamed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.includes("already exists") ? 409 : 400);
      return { detail: message };
    }
  });
  fastify.post("/api/threads/:threadId/close", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = (request.body || {}) as JsonBody;
    const summary = typeof body.summary === "string" ? body.summary : undefined;
    const result = await closeMeetingLikeHuman(store, { threadId: params.threadId, summary });
    if (!result.ok) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return result;
  });
  fastify.post("/api/threads/:threadId/state", async (request, reply) => {
    const body = request.body as JsonBody;
    return setThreadStatus(request, reply, String(body.state || "discuss") as never);
  });
  fastify.delete("/api/threads/:threadId", async (request, reply) => {
    const params = request.params as { threadId: string };
    await cliSessionManager.clearSessionsForThread(params.threadId);
    const ok = store.deleteThread(params.threadId);
    if (!ok) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return { ok: true, deleted: params.threadId };
  });

  fastify.get("/api/messages/:messageId/reactions", async (request, reply) => {
    const params = request.params as { messageId: string };
    const message = store.getMessage(params.messageId);
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { reactions: store.getReactions(params.messageId) };
  });

  fastify.post("/api/messages/:messageId/reactions", async (request, reply) => {
    const params = request.params as { messageId: string };
    const body = request.body as JsonBody;
    const message = store.addReaction(params.messageId, String(body.agent_id || ""), String(body.reaction || ""));
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    reply.code(201);
    return { ok: true, reactions: store.getReactions(params.messageId) };
  });

  fastify.delete("/api/messages/:messageId/reactions/:reaction", async (request, reply) => {
    const params = request.params as { messageId: string; reaction: string };
    const query = request.query as { agent_id?: string };
    const result = store.removeReaction(params.messageId, String(query.agent_id || ""), params.reaction);
    if (!result) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { removed: result.removed };
  });

  fastify.put("/api/messages/:messageId", async (request, reply) => {
    const params = request.params as { messageId: string };
    const body = request.body as JsonBody;
    const result = store.editMessage(params.messageId, String(body.new_content || ""), String(body.edited_by || "system"));
    if (!result) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return result;
  });

  fastify.get("/api/messages/:messageId/history", async (request, reply) => {
    const params = request.params as { messageId: string };
    const message = store.getMessage(params.messageId);
    if (!message) {
      reply.code(404);
      return { detail: "Message not found" };
    }
    return { edits: store.getMessageHistory(params.messageId) };
  });

  // Settings API - Python parity
  fastify.get("/api/settings", async () => getConfigDict());

  fastify.get("/api/settings/manifest", async () => getSettingsManifest());
  
  fastify.put("/api/settings", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const adminToken = request.headers["x-admin-token"] as string | undefined;
    const cfg = getConfig();
    
    if (cfg.adminToken && adminToken !== cfg.adminToken) {
      reply.code(401);
      return { detail: "Invalid admin token" };
    }

    try {
      if (Object.keys(body).length > 0) {
        saveConfigDict(body);
      }
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        reply.code(400);
        return {
          detail: "Invalid settings payload",
          errors: error.errors,
        };
      }
      throw error;
    }
    
    return { 
      ok: true, 
      message: "Settings saved. Restart the server to apply changes." 
    };
  });

  // Templates API - Python parity
  fastify.get("/api/templates", async () => {
    const templates = store.getTemplates();
    // Python returns array directly with subset of fields
    return templates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      is_builtin: t.is_builtin,
      created_at: t.created_at
    }));
  });

  fastify.get("/api/templates/:templateId", async (request, reply) => {
    const params = request.params as { templateId: string };
    const template = store.getTemplate(params.templateId);
    if (!template) {
      reply.code(404);
      return { detail: "Template not found" };
    }
    // Python returns full template details
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      system_prompt: template.system_prompt,
      default_metadata: template.default_metadata,
      is_builtin: template.is_builtin,
      created_at: template.created_at
    };
  });

  fastify.post("/api/templates", async (request, reply) => {
    const body = request.body as JsonBody;
    try {
      // Fix #7: Content filter on system_prompt
      if (body.system_prompt) {
        const { checkContentOrThrow } = await import("../../core/services/contentFilter.js");
        checkContentOrThrow(String(body.system_prompt));
      }
      const success = store.createTemplate({
        id: String(body.id),
        name: String(body.name),
        description: body.description ? String(body.description) : undefined,
        system_prompt: body.system_prompt ? String(body.system_prompt) : undefined,
        default_metadata: body.default_metadata as Record<string, unknown> | undefined
      });
      if (success) {
        const template = store.getTemplate(String(body.id));
        reply.code(201);
        return {
          id: template!.id,
          name: template!.name,
          description: template!.description,
          is_builtin: template!.is_builtin
        };
      }
      reply.code(500);
      return { detail: "Failed to create template" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("already exists")) {
        reply.code(409);
        return { detail: message };
      }
      reply.code(400);
      return { detail: message };
    }
  });

  fastify.delete("/api/templates/:templateId", async (request, reply) => {
    const params = request.params as { templateId: string };
    try {
      const deleted = store.deleteTemplate(params.templateId);
      if (!deleted) {
        reply.code(404);
        return { detail: "Template not found" };
      }
      reply.code(204);
      return reply.send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("built-in")) {
        reply.code(403);
        return { detail: message };
      }
      reply.code(404);
      return { detail: message };
    }
  });

  fastify.get("/api/threads/:threadId/settings", async (request, reply) => {
    const params = request.params as { threadId: string };
    const settings = store.getThreadSettings(params.threadId);
    if (!settings) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return settings;
  });

  fastify.post("/api/threads/:threadId/settings", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as JsonBody;
    const settings = memoryStore.updateThreadSettings(params.threadId, {
      auto_administrator_enabled: typeof body.auto_administrator_enabled === "boolean" ? body.auto_administrator_enabled : undefined,
      timeout_seconds: typeof body.timeout_seconds === "number" ? body.timeout_seconds : undefined,
      switch_timeout_seconds: typeof body.switch_timeout_seconds === "number" ? body.switch_timeout_seconds : undefined
    });
    if (!settings) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    return settings;
  });

  fastify.get("/api/threads/:threadId/admin", async (request, reply) => {
    const params = request.params as { threadId: string };
    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    const settings = store.getThreadSettings(params.threadId);
    // Priority: creator_admin > auto_assigned_admin
    const adminId = settings?.creator_admin_id || settings?.auto_assigned_admin_id || null;
    const adminAgent = adminId ? store.getAgent(adminId) : undefined;
    const adminName = adminAgent
      ? resolvePreferredAgentDisplayName(adminAgent)
      : (settings?.creator_admin_name || settings?.auto_assigned_admin_name || null);
    const adminType = settings?.creator_admin_id ? "creator" : (settings?.auto_assigned_admin_id ? "auto_assigned" : null);
    const assignedAt = settings?.creator_assignment_time || settings?.admin_assignment_time || null;
    
    // Get emoji from agent record
    let adminEmoji: string | null = null;
    if (adminId) {
      const agents = store.listAgents();
      const agent = agents.find(a => a.id === adminId);
      adminEmoji = agent?.emoji || null;
    }
    
    return {
      admin_id: adminId,
      admin_name: adminName,
      admin_emoji: adminEmoji,
      admin_type: adminType,
      assigned_at: assignedAt
    };
  });

  fastify.post("/api/threads/:threadId/admin/decision", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = request.body as {
      action: "switch" | "keep" | "takeover" | "cancel";
      candidate_admin_id?: string;
      source_message_id?: string;
    };

    const thread = store.getThread(params.threadId);
    if (!thread) {
      reply.code(404);
      return { detail: "Thread not found" };
    }

    // Helper to get agent emoji
    const getAgentEmoji = (agentId: string | null | undefined): string => {
      if (!agentId) return "❔";
      const agents = store.listAgents();
      const agent = agents.find(a => a.id === agentId);
      return agent?.emoji || "🤖";
    };

    // Helper to get agent name
    const getAgentName = (agentId: string | null | undefined): string => {
      if (!agentId) return "Unknown";
      const agents = store.listAgents();
      const agent = agents.find(a => a.id === agentId);
      return resolvePreferredAgentDisplayName(agent || { id: agentId });
    };

    const settings = store.getThreadSettings(params.threadId);
    const currentAdminId = settings?.creator_admin_id || settings?.auto_assigned_admin_id || null;
    const currentAdminName = currentAdminId
      ? getAgentName(currentAdminId)
      : (settings?.creator_admin_name || settings?.auto_assigned_admin_name || null);

    // Check for source_message_id and already decided
    if (body.source_message_id) {
      const sourceEntry = store.getTranscriptMessage(body.source_message_id);
      if (!sourceEntry) {
        reply.code(404);
        return { detail: "source_message_id not found" };
      }
      const sourceMsg = sourceEntry.message;
      if (sourceMsg.thread_id !== params.threadId) {
        reply.code(400);
        return { detail: "source_message_id does not belong to this thread" };
      }

      // Parse metadata (already an object in TS version)
      const sourceMeta: Record<string, unknown> = sourceMsg.metadata || {};
      const sourceUiType = String(sourceMeta.ui_type || "");

      // Validate ui_type
      if (!["admin_switch_confirmation_required", "admin_takeover_confirmation_required"].includes(sourceUiType)) {
        reply.code(400);
        return { detail: "source_message_id is not an admin confirmation prompt" };
      }

      // Validate action for ui_type
      const allowedActions: Record<string, string[]> = {
        "admin_switch_confirmation_required": ["switch", "keep"],
        "admin_takeover_confirmation_required": ["takeover", "cancel"]
      };
      if (!allowedActions[sourceUiType]?.includes(body.action)) {
        reply.code(400);
        return { detail: `Invalid action '${body.action}' for source_message_id ui_type=${sourceUiType}` };
      }

      // Check if already decided
      if (sourceMeta.decision_status === "resolved") {
        return {
          ok: true,
          thread_id: params.threadId,
          action: sourceMeta.decision_action || body.action,
          already_decided: true,
          source_message_id: body.source_message_id,
          decided_at: sourceMeta.decision_at
        };
      }

      // Handle switch action
      if (body.action === "switch") {
        if (!body.candidate_admin_id) {
          reply.code(400);
          return { detail: "candidate_admin_id is required for action='switch'" };
        }

        const candidate = store.getAgent(body.candidate_admin_id);
        if (!candidate) {
          reply.code(404);
          return { detail: "Candidate admin agent not found" };
        }

        const candidateName = resolvePreferredAgentDisplayName(candidate);
        store.switchAdmin(params.threadId, candidate.id, candidateName);

        const oldBadge = `${getAgentEmoji(currentAdminId)} ${currentAdminName || currentAdminId || "Unknown"}`;
        const newBadge = `${getAgentEmoji(candidate.id)} ${candidateName}`;
        const confirmation = `Administrator switched by human decision: ${oldBadge} -> ${newBadge}.`;
        const decidedAt = new Date().toISOString();

        const metadata = {
          ui_type: "admin_switch_decision_result",
          visibility: "human_only",
          decision: "switch",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          previous_admin_id: currentAdminId,
          new_admin_id: candidate.id,
          new_admin_name: candidateName,
          new_admin_emoji: getAgentEmoji(candidate.id),
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, confirmation, JSON.stringify(metadata));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "switch";
        sourceMeta.decision_at = decidedAt;
        store.updateTranscriptMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "switch",
          thread_id: params.threadId,
          new_admin_id: candidate.id,
          new_admin_name: candidateName,
          already_decided: false
        };
      }

      // Handle keep action
      if (body.action === "keep") {
        const keptBadge = `${getAgentEmoji(currentAdminId)} ${currentAdminName || currentAdminId || "Unknown"}`;
        const confirmation = `Administrator kept by human decision: ${keptBadge}.`;
        const decidedAt = new Date().toISOString();

        const metadata = {
          ui_type: "admin_switch_decision_result",
          visibility: "human_only",
          decision: "keep",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          kept_admin_id: currentAdminId,
          kept_admin_name: currentAdminName,
          kept_admin_emoji: getAgentEmoji(currentAdminId),
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, confirmation, JSON.stringify(metadata));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "keep";
        sourceMeta.decision_at = decidedAt;
        store.updateTranscriptMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "keep",
          thread_id: params.threadId,
          kept_admin_id: currentAdminId,
          kept_admin_name: currentAdminName,
          already_decided: false
        };
      }

      // Handle takeover action
      if (body.action === "takeover") {
        const targetAdminId = String(sourceMeta.current_admin_id || currentAdminId || body.candidate_admin_id || "");
        if (!targetAdminId) {
          reply.code(400);
          return { detail: "No actionable administrator found for takeover" };
        }

        const targetAdmin = store.getAgent(targetAdminId);
        if (!targetAdmin) {
          reply.code(404);
          return { detail: "Takeover administrator agent not found" };
        }

        const targetName = resolvePreferredAgentDisplayName(targetAdmin);
        const targetEmoji = getAgentEmoji(targetAdmin.id);
        const instruction = `Coordinator decision: ${targetEmoji} ${targetName}, all other agents appear offline/unavailable. Please take over now, continue work directly, and do not keep waiting in msg_wait.`;
        const decidedAt = new Date().toISOString();

        const metadata = {
          ui_type: "admin_coordination_takeover_instruction",
          decision: "takeover",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          handoff_target: targetAdmin.id,
          target_admin_id: targetAdmin.id,
          target_admin_name: targetName,
          target_admin_emoji: targetEmoji,
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, instruction, JSON.stringify(metadata));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "takeover";
        sourceMeta.decision_at = decidedAt;
        store.updateTranscriptMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "takeover",
          thread_id: params.threadId,
          notified_admin_id: targetAdmin.id,
          notified_admin_name: targetName,
          already_decided: false
        };
      }

      // Handle cancel action
      if (body.action === "cancel") {
        const cancelContent = "Administrator takeover request canceled by human decision. System will continue waiting for other agents to come online.";
        const decidedAt = new Date().toISOString();

        const cancelMeta = {
          ui_type: "admin_takeover_decision_result",
          decision: "cancel",
          visibility: "human_only",
          thread_id: params.threadId,
          source_message_id: body.source_message_id,
          decided_at: decidedAt
        };

        store.postSystemMessage(params.threadId, cancelContent, JSON.stringify(cancelMeta));

        // Update source message metadata
        sourceMeta.decision_status = "resolved";
        sourceMeta.decision_action = "cancel";
        sourceMeta.decision_at = decidedAt;
        store.updateTranscriptMessageMetadata(body.source_message_id, sourceMeta);

        return {
          ok: true,
          action: "cancel",
          thread_id: params.threadId,
          already_decided: false
        };
      }
    }

    // No source_message_id - simple switch without confirmation prompt
    if (body.action === "switch") {
      if (!body.candidate_admin_id) {
        reply.code(400);
        return { detail: "candidate_admin_id is required for action='switch'" };
      }

      const candidate = store.getAgent(body.candidate_admin_id);
      if (!candidate) {
        reply.code(404);
        return { detail: "Candidate admin agent not found" };
      }

      const candidateName = resolvePreferredAgentDisplayName(candidate);
      store.switchAdmin(params.threadId, candidate.id, candidateName);

      return {
        ok: true,
        action: "switch",
        thread_id: params.threadId,
        new_admin_id: candidate.id,
        new_admin_name: candidateName,
        already_decided: false
      };
    }

    return { ok: true, thread_id: params.threadId, action: body.action };
  });

  fastify.get("/api/threads/:threadId/export", async (request, reply) => {
    const params = request.params as { threadId: string };
    const md = store.exportThreadMarkdown(params.threadId);
    if (md === null) {
      reply.code(404);
      return { detail: "Thread not found" };
    }
    
    // Generate filename from topic
    const thread = store.getThread(params.threadId);
    const rawTopic = thread?.topic || params.threadId;
    const slug = rawTopic
      .toLowerCase()
      .replace(/[^\w\-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "thread";
    const filename = `${slug}.md`;
    
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return md;
  });

  fastify.get("/api/search", async (request, reply) => {
    const query = request.query as { q?: string; query?: string; thread_id?: string; limit?: number };
    const q = String(query.q || query.query || "").trim();
    if (!q) {
      reply.code(400);
      return { detail: "Query parameter 'q' must not be empty" };
    }
    const limit = Math.min(Math.max(1, query.limit || 50), 200);
    const results = store.searchMessages(q, query.thread_id, limit);
    return { results, total: results.length, query: q };
  });

  fastify.get("/api/metrics", async () => store.getMetrics());

  fastify.get("/api/debug/sse-status", async () => ({
    subscribers: eventBus.listenerCount()
  }));

  fastify.post("/api/agents/:agentId/kick", async (request, reply) => {
    const params = request.params as { agentId: string };
    const result = store.kickAgent(params.agentId);
    if (!result.ok) {
      reply.code(404);
      return { detail: "Agent not found" };
    }
    return result;
  });

  fastify.post("/api/upload/image", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { detail: "file is required" };
    }
    const buffer = await file.toBuffer();
    const url = `data:${file.mimetype};base64,${buffer.toString("base64")}`;
    return {
      url,
      name: file.filename
    };
  });

  // Ensure underlying persistence DB is closed when the server shuts down.
  fastify.addHook('onClose', async () => {
    try {
      unregisterThreadSessionClearer();
    } catch {
      // ignore
    }
    try {
      await cliSessionManager.close();
    } catch {
      // ignore
    }
    try {
      cliMeetingOrchestrator.close();
    } catch {
      // ignore
    }
    try {
      if (ownsStore && store && typeof (store as any).close === 'function') {
        try { (store as any).close(); } catch (e) { }
        // If we created a per-process instance, clear the global override
        try { memoryStoreInstance = null; } catch (_) { }
      }
    } catch (e) {
      // ignore
    }
  });

  // Fix #4: Background tasks (Python parity)
  // Event cleanup every 60s — remove events older than 1 hour
  const cleanupInterval = setInterval(() => {
    try { store.cleanupOldEvents(3600); } catch (_) { /* ignore */ }
  }, 60_000);
  // Thread timeout sweep — configurable interval
  const timeoutInterval = setInterval(() => {
    try { store.threadTimeoutSweep(30); } catch (_) { /* ignore */ }
  }, 30_000);
  const adminCoordinatorInterval = setInterval(() => {
    try { store.adminCoordinatorSweep(); } catch (_) { /* ignore */ }
  }, 10_000);
  // Cleanup intervals on server close
  fastify.addHook("onClose", () => {
    clearInterval(cleanupInterval);
    clearInterval(timeoutInterval);
    clearInterval(adminCoordinatorInterval);
  });

  return fastify;
}

export async function startHttpServer() {
  const config = getConfig();

  if (config.showAd && !config.adminToken) {
    console.error(
      "[SEC-05] FATAL: SHOW_AD=true but AGENTCHATBUS_ADMIN_TOKEN is not set. " +
      "Set AGENTCHATBUS_ADMIN_TOKEN to a secure value before starting in public demo mode."
    );
    process.exit(1);
  }

  const server = createHttpServer();
  await server.listen({ host: config.host, port: config.port });
  return server;
}
