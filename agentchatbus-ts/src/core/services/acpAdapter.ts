/**
 * Generic ACP (Agent Client Protocol) adapter.
 *
 * Implements the {@link CliSessionAdapter} interface so it plugs directly into
 * the existing CliSessionManager without any changes to the session lifecycle,
 * event bus, or meeting orchestrator.
 *
 * A single instance of this adapter handles **all** ACP-compatible agents
 * (Devin CLI, OpenCode, Claude, Codex, Cursor, Copilot, Gemini, GLM, Qwen,
 * Grok, etc.). The specific agent is selected via the `agentId` constructor
 * parameter, and spawn details are resolved from {@link acpRegistry}.
 *
 * Communication uses the official `@agentclientprotocol/sdk` which handles
 * JSON-RPC 2.0 framing, request/response matching, and session management.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import { logError, logInfo } from "../../shared/logger.js";
import {
  resolveAcpSpawnCommand,
  getAcpAgent,
  type AcpAgentConfig,
} from "./acpRegistry.js";
import { resolveAcpMcpProxyScript } from "./acpMcpProxyPath.js";
import type {
  CliAdapterActivityEvent,
  CliAdapterNativeRuntimeEvent,
  CliAdapterRunHooks,
  CliAdapterRunInput,
  CliAdapterRunResult,
  CliSessionAdapter,
  CliSessionActivityFile,
} from "./adapters/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Try to read an API key from the Devin CLI credentials file.
 * Devin CLI stores credentials at `~/.local/share/devin/credentials.toml`.
 * In ACP mode, local CLI credentials are intentionally NOT used by the agent,
 * so we need to pass the API key explicitly via `meta.api_key`.
 */
function readDevinApiKey(): string | undefined {
  const credPath = path.join(
    os.homedir(),
    ".local",
    "share",
    "devin",
    "credentials.toml",
  );
  try {
    const content = fs.readFileSync(credPath, "utf-8");
    // Simple TOML parse: look for api_key = "..."
    const match = content.match(/^api_key\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Patch the `agentchatbus` MCP server entry in an agent's MCP config file
 * with the correct server URL. This is needed for agents that self-manage
 * their MCP servers (e.g., Devin CLI reads ~/.config/devin/mcp_config.json
 * at startup and ignores mcpServers passed via ACP session/new).
 *
 * The config file is a JSON object with an `mcpServers` map. We update or
 * add the `agentchatbus` entry with the given URL, preserving all other
 * entries.
 *
 * @param configPath  Path (relative to $HOME) to the MCP config JSON file.
 * @param serverUrl   The AgentChatBus HTTP server URL (e.g., http://127.0.0.1:39766).
 * @returns true if the file was patched, false if it was skipped or failed.
 */
function patchMcpConfig(configPath: string, serverUrl: string): boolean {
  const fullPath = path.join(os.homedir(), configPath);
  try {
    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      // File doesn't exist — create a minimal one with just the agentchatbus entry
      const newConfig = {
        mcpServers: {
          agentchatbus: { url: `${serverUrl}/mcp` },
        },
      };
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, JSON.stringify(newConfig, null, 2) + "\n", "utf-8");
      logInfo(`[acp-adapter] Created MCP config at ${fullPath} with agentchatbus URL ${serverUrl}/mcp`);
      return true;
    }

    const config = JSON.parse(content);
    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      config.mcpServers = {};
    }

    const mcpUrl = `${serverUrl}/mcp`;
    const existing = config.mcpServers.agentchatbus;
    if (existing && existing.url === mcpUrl) {
      // Already correct, no patch needed
      logInfo(`[acp-adapter] MCP config ${fullPath} already has correct agentchatbus URL (${mcpUrl})`);
      return true;
    }

    // Update or add the agentchatbus entry
    config.mcpServers.agentchatbus = { url: mcpUrl };

    fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    logInfo(`[acp-adapter] Patched MCP config ${fullPath}: agentchatbus URL -> ${mcpUrl}`);
    return true;
  } catch (err) {
    logError(
      `[acp-adapter] Failed to patch MCP config ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function clipText(value: unknown, maxLength = 320): string | undefined {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Map an ACP ToolKind to the AgentChatBus activity event kind.
 */
function toolKindToActivityKind(
  kind: string | undefined,
): CliAdapterActivityEvent["kind"] {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "read":
    case "search":
    case "fetch":
      return "dynamic_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

/**
 * Extract file paths from a tool call's content (diffs, etc.).
 * This is a best-effort heuristic — ACP tool call content is agent-specific.
 */
function extractFilesFromToolCall(
  update: acp.ToolCallUpdate,
): CliSessionActivityFile[] | undefined {
  if (!update.content || !Array.isArray(update.content)) {
    return undefined;
  }
  const files: CliSessionActivityFile[] = [];
  for (const item of update.content) {
    if (isRecord(item) && item.type === "diff" && typeof item.path === "string") {
      files.push({ path: item.path, change_type: "update" });
    }
  }
  return files.length > 0 ? files : undefined;
}

// ---------------------------------------------------------------------------
// AcpAdapter
// ---------------------------------------------------------------------------

export class AcpAdapter implements CliSessionAdapter {
  readonly mode = "acp" as const;
  readonly supportsInput = false;
  readonly supportsRestart = true;
  readonly supportsResize = false;
  readonly requiresPrompt = false;
  readonly shell: string | undefined;

  private readonly agentConfig: AcpAgentConfig;

  constructor(
    private readonly agentId: string,
  ) {
    const config = getAcpAgent(agentId);
    if (!config) {
      throw new Error(`Unknown ACP agent: ${agentId}`);
    }
    this.agentConfig = config;
    this.shell = undefined;
  }

  get adapterId(): string {
    return this.agentId;
  }

  async run(
    input: CliAdapterRunInput,
    hooks: CliAdapterRunHooks,
  ): Promise<CliAdapterRunResult> {
    const spawnInfo = resolveAcpSpawnCommand(this.agentId);
    if (!spawnInfo) {
      throw new Error(
        `No spawn command for ACP agent '${this.agentId}' on ${process.platform}-${process.arch}`,
      );
    }

    logInfo(
      `[acp-adapter] Spawning ${this.agentConfig.name}: ${spawnInfo.command} ${spawnInfo.args.join(" ")}`,
    );

    // For agents that self-manage MCP config (e.g., Devin CLI), patch the
    // agentchatbus entry in their config file with the correct server URL
    // before spawning. This ensures the agent connects to the right MCP
    // endpoint regardless of which port AgentChatBus is running on.
    if (this.agentConfig.mcpConfigPath) {
      const baseUrl = String(
        input.env?.AGENTCHATBUS_BASE_URL ||
          process.env.AGENTCHATBUS_BASE_URL ||
          "",
      ).trim();
      if (baseUrl) {
        patchMcpConfig(this.agentConfig.mcpConfigPath, baseUrl);
      }
    }

    const childProcess = spawn(spawnInfo.command, spawnInfo.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: input.workspace || undefined,
      env: {
        ...process.env,
        ...input.env,
        ...this.agentConfig.env,
      },
    });

    // Provide kill control immediately
    hooks.onControls({
      kill: () => {
        try {
          if (!childProcess.killed) {
            childProcess.kill("SIGTERM");
            setTimeout(() => {
              if (!childProcess.killed) {
                childProcess.kill("SIGKILL");
              }
            }, 3_000);
          }
        } catch {
          // Best effort
        }
      },
    });

    // Report process start
    childProcess.once("spawn", () => {
      hooks.onProcessStart(childProcess.pid ?? 0);
    });

    // Forward stderr to output
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      hooks.onOutput("stderr", text);
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
    });
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    // Create ACP stream from the child process stdio
    const writableWeb = Writable.toWeb(childProcess.stdin!);
    const readableWeb = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(writableWeb, readableWeb);

    let externalSessionId: string | undefined;
    let externalRequestId: string | undefined;
    let resultText = "";

    try {
      const promptResponse = await acp
        .client({ name: "agentchatbus" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
          this.handleRequestPermission(ctx.params),
        )
        .onRequest(acp.methods.client.fs.readTextFile, async (ctx) =>
          this.handleReadTextFile(ctx.params, input.workspace),
        )
        .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) =>
          this.handleWriteTextFile(ctx.params, input.workspace),
        )
        .connectWith(stream, async (ctx): Promise<acp.PromptResponse | undefined> => {
          // 1. Initialize
          hooks.onNativeRuntime?.({
            at: nowIso(),
            phase: "starting",
          });

          const initResult = await ctx.request(
            acp.methods.agent.initialize,
            {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {
                fs: {
                  readTextFile: true,
                  writeTextFile: true,
                },
              },
            },
          );

          logInfo(
            `[acp-adapter] ${this.agentConfig.name} initialized (protocol v${initResult.protocolVersion})`,
          );

          // 2. Authenticate if the agent requires it
          // Devin CLI in ACP mode intentionally does NOT use local CLI credentials.
          // We must call `authenticate` with `meta.api_key` set to the user's API key
          // (read from ~/.local/share/devin/credentials.toml).
          // For env_var/terminal types, we call authenticate without meta.
          if (initResult.authMethods && initResult.authMethods.length > 0) {
            const method = initResult.authMethods[0];
            const methodType = (method as any).type; // "env_var" | "terminal" | undefined(agent)
            logInfo(
              `[acp-adapter] Authenticating with ${this.agentConfig.name} via ${method.id} (type=${methodType || "agent"})`,
            );
            try {
              // For agent-type auth (e.g., Devin CLI's devin-browser),
              // pass the API key via meta.api_key to avoid the browser PKCE flow.
              const authParams: any = { methodId: method.id };
              if (!methodType || methodType === "agent") {
                const apiKey = readDevinApiKey();
                if (apiKey) {
                  authParams.meta = { api_key: apiKey };
                  logInfo(`[acp-adapter] Passing API key via meta.api_key for ${this.agentConfig.name}`);
                } else {
                  logInfo(`[acp-adapter] No API key found in credentials.toml, attempting browser auth`);
                }
              }
              await ctx.request(
                acp.methods.agent.authenticate,
                authParams,
              );
              logInfo(`[acp-adapter] ${this.agentConfig.name} authenticated successfully`);
            } catch (authError) {
              const detail =
                authError instanceof Error
                  ? authError.message
                  : String(authError);
              logError(
                `[acp-adapter] Authentication failed for ${this.agentConfig.name}: ${detail}`,
              );
              hooks.onOutput("stderr", `[acp-adapter] Authentication failed: ${detail}\n`);
              // Continue anyway — some agents work without explicit auth
            }
          }

          // 3. Notify initialized
          logInfo(`[acp-adapter] ${this.agentConfig.name} sending initialized notification`);
          await ctx.notify("initialized", {});

          hooks.onNativeRuntime?.({
            at: nowIso(),
            phase: "running",
          });

          // 4. Create a new session
          const sessionCwd = input.workspace || process.cwd();

          // Configure MCP server for AgentChatBus meeting tools.
          // Many ACP agents (e.g., Devin CLI) have a pre-configured `agentchatbus`
          // MCP server in their global config that connects to the AgentChatBus
          // HTTP endpoint. We pass the connection info via env vars so the agent
          // can use the pre-configured MCP server with the correct thread/agent
          // context.
          // For agents without pre-configured MCP, we also provide a stdio MCP
          // proxy as a fallback.
          const baseUrl = String(input.env?.AGENTCHATBUS_BASE_URL || process.env.AGENTCHATBUS_BASE_URL || "").trim();
          const mcpServers: acp.McpServer[] = [];
          if (baseUrl) {
            // Try stdio MCP proxy as a fallback for agents that don't have
            // pre-configured MCP servers. Agents with pre-configured MCP will
            // use their own config.
            const proxyScript = resolveAcpMcpProxyScript();
            const envVars: acp.EnvVariable[] = [
              { name: "AGENTCHATBUS_BASE_URL", value: baseUrl },
            ];
            if (input.env?.AGENTCHATBUS_THREAD_ID) {
              envVars.push({ name: "AGENTCHATBUS_THREAD_ID", value: input.env.AGENTCHATBUS_THREAD_ID });
            }
            if (input.env?.AGENTCHATBUS_THREAD_NAME) {
              envVars.push({ name: "AGENTCHATBUS_THREAD_NAME", value: input.env.AGENTCHATBUS_THREAD_NAME });
            }
            if (input.env?.AGENTCHATBUS_AGENT_ID) {
              envVars.push({ name: "AGENTCHATBUS_AGENT_ID", value: input.env.AGENTCHATBUS_AGENT_ID });
            }
            if (input.env?.AGENTCHATBUS_AGENT_TOKEN) {
              envVars.push({ name: "AGENTCHATBUS_AGENT_TOKEN", value: input.env.AGENTCHATBUS_AGENT_TOKEN });
            }
            if (input.env?.AGENTCHATBUS_AGENT_DISPLAY_NAME) {
              envVars.push({ name: "AGENTCHATBUS_AGENT_DISPLAY_NAME", value: input.env.AGENTCHATBUS_AGENT_DISPLAY_NAME });
            }

            logInfo(
              `[acp-adapter] ${this.agentConfig.name} configuring stdio MCP proxy (script=${proxyScript}, baseUrl=${baseUrl})`,
            );
            mcpServers.push({
              name: "agentchatbus-acp",
              command: process.execPath,
              args: [proxyScript],
              env: envVars,
            } as acp.McpServer);
          } else {
            logInfo(`[acp-adapter] ${this.agentConfig.name} no AGENTCHATBUS_BASE_URL found, skipping MCP server`);
          }

          logInfo(
            `[acp-adapter] ${this.agentConfig.name} creating session (cwd=${sessionCwd}, model=${input.model || "default"}, mcpServers=${mcpServers.length})`,
          );
          const sessionBuilder = ctx.buildSession({
            cwd: sessionCwd,
            ...(input.model ? { model: input.model } : {}),
            mcpServers,
          });

          const activeSession = await sessionBuilder.start();
          externalSessionId = activeSession.sessionId;
          logInfo(`[acp-adapter] ${this.agentConfig.name} session created: ${externalSessionId}`);

          hooks.onNativeRuntime?.({
            at: nowIso(),
            thread_id: externalSessionId,
            phase: "running",
            thread_status_type: "active",
          });

          hooks.onActivity?.({
            at: nowIso(),
            item_id: `acp-connect-${externalSessionId}`,
            kind: "task",
            status: "completed",
            label: `Connected to ${this.agentConfig.name}`,
          });

          // 5. Send prompt and collect updates
          const promptContent = input.prompt || "";
          logInfo(
            `[acp-adapter] ${this.agentConfig.name} sending prompt (${promptContent.length} chars): ${clipText(promptContent, 120) || "(empty)"}`,
          );
          activeSession.prompt(promptContent);

          logInfo(`[acp-adapter] ${this.agentConfig.name} waiting for updates...`);

          let promptResult: acp.PromptResponse | undefined;
          for (;;) {
            const message = await activeSession.nextUpdate();

            if (message.kind === "stop") {
              promptResult = message.response;
              const stopReason = message.response?.stopReason || "end_turn";
              hooks.onActivity?.({
                at: nowIso(),
                item_id: `acp-turn-${externalSessionId}`,
                kind: "task",
                status: "completed",
                label: `${this.agentConfig.name} turn completed (${stopReason})`,
              });
              break;
            }

            // session_update
            this.processSessionUpdate(
              message.update,
              message.notification,
              externalSessionId,
              hooks,
            );

            // Collect agent message text
            if (
              message.update.sessionUpdate === "agent_message_chunk" &&
              message.update.content.type === "text"
            ) {
              resultText += message.update.content.text;
            }
          }

          activeSession.dispose();
          return promptResult;
        });

      return {
        exitCode: childProcess.exitCode,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        resultText: resultText || undefined,
        rawResult: promptResponse
          ? (promptResponse as unknown as Record<string, unknown>)
          : null,
        externalSessionId,
        externalRequestId,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logError(`[acp-adapter] ${this.agentConfig.name} failed: ${detail}`);
      hooks.onOutput("stderr", `[acp-adapter] Error: ${detail}\n`);
      throw error;
    } finally {
      // Ensure the child process is terminated
      try {
        if (!childProcess.killed) {
          childProcess.kill("SIGTERM");
        }
      } catch {
        // Best effort
      }
    }
  }

  // -------------------------------------------------------------------------
  // Client-side ACP handlers
  // -------------------------------------------------------------------------

  /**
   * Handle permission requests from the agent.
   *
   * In the AgentChatBus multi-agent meeting context, agents run autonomously.
   * We auto-approve all permission requests (matching the behavior of the
   * existing direct adapters).
   */
  private async handleRequestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const options = params.options || [];
    // Find the first "allow" option, or the first non-reject option
    const allowOption =
      options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ||
      options.find((o) => o.kind !== "reject_once" && o.kind !== "reject_always") ||
      options[0];

    if (allowOption) {
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption.optionId,
        },
      };
    }
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  /**
   * Handle read_text_file requests from the agent.
   */
  private async handleReadTextFile(
    params: acp.ReadTextFileRequest,
    workspace: string,
  ): Promise<acp.ReadTextFileResponse> {
    const fs = await import("node:fs/promises");
    try {
      const content = await fs.readFile(params.path, "utf8");
      return { content };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logError(`[acp-adapter] readTextFile failed for ${params.path}: ${detail}`);
      throw new Error(`Failed to read file ${params.path}: ${detail}`);
    }
  }

  /**
   * Handle write_text_file requests from the agent.
   */
  private async handleWriteTextFile(
    params: acp.WriteTextFileRequest,
    workspace: string,
  ): Promise<acp.WriteTextFileResponse> {
    const fs = await import("node:fs/promises");
    try {
      await fs.writeFile(params.path, params.content, "utf8");
      return {};
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logError(`[acp-adapter] writeTextFile failed for ${params.path}: ${detail}`);
      throw new Error(`Failed to write file ${params.path}: ${detail}`);
    }
  }

  // -------------------------------------------------------------------------
  // Session update processing
  // -------------------------------------------------------------------------

  private processSessionUpdate(
    update: acp.SessionUpdate,
    notification: acp.SessionNotification,
    sessionId: string | undefined,
    hooks: CliAdapterRunHooks,
  ): void {
    const at = nowIso();

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          hooks.onOutput("stdout", update.content.text);
        }
        hooks.onActivity?.({
          at,
          item_id: `acp-msg-${sessionId}-${Date.now()}`,
          kind: "agent_message",
          status: "in_progress",
          label: clipText(update.content.type === "text" ? update.content.text : `[${update.content.type}]`) || "Message",
          content: update.content.type === "text" ? update.content.text : undefined,
        });
        break;
      }

      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          hooks.onActivity?.({
            at,
            item_id: `acp-thought-${sessionId}-${Date.now()}`,
            kind: "thinking",
            status: "in_progress",
            label: clipText(update.content.text) || "Thinking",
            content: update.content.text,
          });
        }
        break;
      }

      case "tool_call": {
        const toolUpdate = update as acp.ToolCall & { sessionUpdate: "tool_call" };
        hooks.onActivity?.({
          at,
          turn_id: undefined,
          item_id: toolUpdate.toolCallId,
          kind: toolKindToActivityKind(toolUpdate.kind),
          status: this.mapToolStatus(toolUpdate.status),
          label: toolUpdate.title || "Tool call",
          tool: toolUpdate.title,
          files: extractFilesFromToolCall(toolUpdate as unknown as acp.ToolCallUpdate),
        });
        break;
      }

      case "tool_call_update": {
        const toolUpdate = update as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" };
        hooks.onActivity?.({
          at,
          turn_id: undefined,
          item_id: toolUpdate.toolCallId,
          kind: toolKindToActivityKind(toolUpdate.kind ?? undefined),
          status: this.mapToolStatus(toolUpdate.status ?? undefined),
          label: toolUpdate.title || "Tool call update",
          tool: toolUpdate.title ?? undefined,
          files: extractFilesFromToolCall(toolUpdate),
        });
        break;
      }

      case "plan": {
        const plan = update as acp.Plan & { sessionUpdate: "plan" };
        hooks.onActivity?.({
          at,
          item_id: `acp-plan-${sessionId}`,
          kind: "plan",
          status: "in_progress",
          label: "Plan",
          plan_steps: (plan.entries || []).map((entry) => ({
            step: entry.content || "",
            status: this.mapPlanStatus(entry.status),
          })),
        });
        break;
      }

      case "plan_update": {
        const planUpdate = update as acp.PlanUpdate & { sessionUpdate: "plan_update" };
        // PlanUpdate has a `plan` field containing PlanUpdateContent
        // which may be items-based (with entries) or file/markdown-based
        const planContent = planUpdate.plan;
        const entries = planContent?.type === "items" ? planContent.entries : [];
        hooks.onActivity?.({
          at,
          item_id: `acp-plan-${sessionId}`,
          kind: "plan",
          status: "in_progress",
          label: "Plan update",
          plan_steps: (entries || []).map((entry) => ({
            step: entry.content || "",
            status: this.mapPlanStatus(entry.status),
          })),
        });
        break;
      }

      case "usage_update":
      case "session_info_update":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "plan_removed":
      case "user_message_chunk":
        // These update types don't map to AgentChatBus activities.
        // They could be forwarded as native runtime events in the future.
        break;

      default:
        // Unknown update type — ignore
        break;
    }
  }

  private mapToolStatus(
    status: string | undefined,
  ): CliAdapterActivityEvent["status"] {
    switch (status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "pending":
      case "in_progress":
      default:
        return "in_progress";
    }
  }

  private mapPlanStatus(
    status: string | undefined,
  ): "pending" | "inProgress" | "completed" {
    switch (status) {
      case "completed":
        return "completed";
      case "in_progress":
      case "inProgress":
        return "inProgress";
      default:
        return "pending";
    }
  }
}
