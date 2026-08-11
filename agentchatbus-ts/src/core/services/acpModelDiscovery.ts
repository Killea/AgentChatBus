/**
 * ACP agent model discovery.
 *
 * Spawns an ACP agent, performs the initialize + session/new handshake
 * (without sending any prompt), reads the `configOptions` from the
 * NewSessionResponse to extract available models, then terminates the
 * process.
 *
 * This mirrors how Devin discovers models: it doesn't parse CLI output
 * or hardcode model lists — it asks the agent directly via ACP.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { logError, logInfo } from "../../shared/logger.js";
import { resolveAcpSpawnCommand } from "./acpRegistry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcpModelOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpModelDiscoveryResult {
  agentId: string;
  models: AcpModelOption[];
  configOptions: Array<{
    id: string;
    name: string;
    category?: string | null;
    type: "select" | "boolean";
    currentValue?: string | boolean;
    options?: AcpModelOption[];
  }>;
  modes?: Array<{
    modeId: string;
    name: string;
    isCurrent?: boolean;
  }>;
  discovered_at: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _modelCache = new Map<string, { result: AcpModelDiscoveryResult; time: number }>();
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Discover available models for an ACP agent by spawning it, performing
 * the ACP handshake, and reading configOptions from session/new.
 *
 * The agent process is terminated after discovery.
 */
export async function discoverAcpAgentModels(
  agentId: string,
  workspace?: string,
  force = false,
): Promise<AcpModelDiscoveryResult> {
  const now = Date.now();
  const cached = _modelCache.get(agentId);
  if (!force && cached && now - cached.time < MODEL_CACHE_TTL_MS) {
    return cached.result;
  }

  const spawnInfo = resolveAcpSpawnCommand(agentId);
  if (!spawnInfo) {
    return {
      agentId,
      models: [],
      configOptions: [],
      discovered_at: new Date().toISOString(),
      error: `No spawn command for agent '${agentId}'`,
    };
  }

  logInfo(`[acp-models] Discovering models for ${agentId}: ${spawnInfo.command} ${spawnInfo.args.join(" ")}`);

  let childProcess: ChildProcess | null = null;
  try {
    childProcess = spawn(spawnInfo.command, spawnInfo.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspace || undefined,
      timeout: 30_000, // 30 second timeout for the whole discovery
    });

    const writableWeb = Writable.toWeb(childProcess.stdin!);
    const readableWeb = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(writableWeb, readableWeb);

    const result = await acp
      .client({ name: "agentchatbus-model-discovery" })
      .connectWith(stream, async (ctx): Promise<AcpModelDiscoveryResult> => {
        // 1. Initialize
        const initResult = await ctx.request(
          acp.methods.agent.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: {
                readTextFile: false,
                writeTextFile: false,
              },
            },
          },
        );

        logInfo(
          `[acp-models] ${agentId} initialized (protocol v${initResult.protocolVersion})`,
        );

        // 2. Authenticate if required (use first method, best-effort)
        if (initResult.authMethods && initResult.authMethods.length > 0) {
          try {
            await ctx.request(acp.methods.agent.authenticate, {
              methodId: initResult.authMethods[0].id,
            });
          } catch {
            // Authentication may fail — we still try session/new
          }
        }

        // 3. Notify initialized
        await ctx.notify("initialized", {});

        // 4. Create a session (without sending any prompt)
        const sessionBuilder = ctx.buildSession({
          cwd: workspace || process.cwd(),
          mcpServers: [],
        });

        const activeSession = await sessionBuilder.start();
        const sessionResponse = activeSession.newSessionResponse;

        // 5. Extract models from configOptions
        const configOptions: AcpModelDiscoveryResult["configOptions"] = [];
        const models: AcpModelOption[] = [];

        if (sessionResponse.configOptions && Array.isArray(sessionResponse.configOptions)) {
          for (const opt of sessionResponse.configOptions) {
            const entry: AcpModelDiscoveryResult["configOptions"][number] = {
              id: opt.id,
              name: opt.name,
              category: opt.category ?? null,
              type: opt.type === "boolean" ? "boolean" : "select",
            };

            if (opt.type === "select") {
              entry.currentValue = opt.currentValue;
              const options: AcpModelOption[] = [];
              if (Array.isArray(opt.options)) {
                for (const optItem of opt.options) {
                  if ("value" in optItem) {
                    const modelOpt: AcpModelOption = {
                      value: optItem.value,
                      name: optItem.name,
                      description: optItem.description ?? null,
                    };
                    options.push(modelOpt);
                  }
                }
              }
              entry.options = options;

              // If this option's category is "model", extract its options as models
              if (opt.category === "model") {
                models.push(...options);
              }
            } else if (opt.type === "boolean") {
              entry.currentValue = opt.currentValue;
            }

            configOptions.push(entry);
          }
        }

        // 6. Extract modes if available
        const modes: AcpModelDiscoveryResult["modes"] = [];
        if (sessionResponse.modes) {
          const modeState = sessionResponse.modes;
          if (Array.isArray(modeState.availableModes)) {
            for (const mode of modeState.availableModes) {
              modes.push({
                modeId: mode.id,
                name: mode.name,
                isCurrent: modeState.currentModeId === mode.id,
              });
            }
          }
        }

        // 7. Close the session
        try {
          await ctx.request(acp.methods.agent.session.close, {
            sessionId: activeSession.sessionId,
          });
        } catch {
          // Best effort — we're done anyway
        }

        activeSession.dispose();

        const discoveryResult: AcpModelDiscoveryResult = {
          agentId,
          models,
          configOptions,
          modes: modes.length > 0 ? modes : undefined,
          discovered_at: new Date().toISOString(),
        };

        logInfo(
          `[acp-models] ${agentId}: discovered ${models.length} models, ${configOptions.length} config options, ${modes.length} modes`,
        );

        return discoveryResult;
      });

    _modelCache.set(agentId, { result, time: Date.now() });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError(`[acp-models] Failed to discover models for ${agentId}: ${detail}`);

    const errorResult: AcpModelDiscoveryResult = {
      agentId,
      models: [],
      configOptions: [],
      discovered_at: new Date().toISOString(),
      error: detail,
    };

    // Cache errors for a shorter time to allow retry
    _modelCache.set(agentId, { result: errorResult, time: Date.now() - MODEL_CACHE_TTL_MS + 30_000 });
    return errorResult;
  } finally {
    // Ensure the child process is terminated
    if (childProcess) {
      try {
        if (!childProcess.killed) {
          childProcess.kill("SIGTERM");
          setTimeout(() => {
            if (!childProcess?.killed) {
              childProcess?.kill("SIGKILL");
            }
          }, 3_000);
        }
      } catch {
        // Best effort
      }
    }
  }
}

/**
 * Clear the model discovery cache for a specific agent or all agents.
 */
export function clearModelDiscoveryCache(agentId?: string): void {
  if (agentId) {
    _modelCache.delete(agentId);
  } else {
    _modelCache.clear();
  }
}
