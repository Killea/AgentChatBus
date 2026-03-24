import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import spawn from "cross-spawn";
import { getConfig } from "../config/registry.js";
import type { CliSessionAdapterId } from "./cliSessionManager.js";
import { WINDOWS_POWERSHELL } from "./adapters/constants.js";
import {
  resolveCodexHeadlessCommand,
} from "./adapters/codexHeadlessAdapter.js";
import {
  resolveCopilotHeadlessCommand,
} from "./adapters/copilotHeadlessAdapter.js";
import {
  resolveCursorAgentCommand,
} from "./adapters/cursorHeadlessAdapter.js";
import {
  resolveGeminiHeadlessCommand,
} from "./adapters/geminiHeadlessAdapter.js";
import {
  resolveClaudeCommand,
} from "./adapters/claudeHeadlessAdapter.js";

export type CliModelDiscoveryStrategy = "runtime" | "help" | "static";
export type CliModelDiscoveryStatus = "ready" | "error";

export type CliDiscoveredModel = {
  id: string;
  label: string;
};

export type CliModelDiscoveryEntry = {
  adapter: CliSessionAdapterId;
  status: CliModelDiscoveryStatus;
  strategy: CliModelDiscoveryStrategy;
  models: CliDiscoveredModel[];
  fetched_at: string;
  source_label: string;
  error?: string;
};

export type CliModelDiscoverySnapshot = {
  fetched_at: string | null;
  providers: Record<CliSessionAdapterId, CliModelDiscoveryEntry>;
};

type CommandSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const STATIC_MODELS: Record<CliSessionAdapterId, CliDiscoveredModel[]> = {
  cursor: [],
  copilot: [],
  claude: [
    { id: "sonnet", label: "sonnet" },
    { id: "opus", label: "opus" },
    { id: "haiku", label: "haiku" },
    { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    { id: "claude-opus-4-6", label: "claude-opus-4-6" },
  ],
  codex: [
    { id: "gpt-5.4", label: "gpt-5.4" },
    { id: "gpt-5-mini", label: "gpt-5-mini" },
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { id: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { id: "gpt-5.2", label: "gpt-5.2" },
    { id: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
    { id: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
    { id: "gpt-4.1", label: "gpt-4.1" },
  ],
  gemini: [
    { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview" },
    { id: "gemini-3-flash-preview", label: "gemini-3-flash-preview" },
    { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    { id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite" },
  ],
};

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueModels(models: CliDiscoveredModel[]): CliDiscoveredModel[] {
  const seen = new Set<string>();
  const result: CliDiscoveredModel[] = [];
  for (const model of models) {
    const id = String(model.id || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({
      id,
      label: String(model.label || id).trim() || id,
    });
  }
  return result;
}

function buildStaticEntry(
  adapter: CliSessionAdapterId,
  fetchedAt = nowIso(),
  error?: string,
): CliModelDiscoveryEntry {
  return {
    adapter,
    status: error ? "error" : "ready",
    strategy: "static",
    models: uniqueModels(STATIC_MODELS[adapter] || []),
    fetched_at: fetchedAt,
    source_label: "Static fallback",
    ...(error ? { error } : {}),
  };
}

function createEmptySnapshot(): CliModelDiscoverySnapshot {
  const fetchedAt = null;
  return {
    fetched_at: fetchedAt,
    providers: {
      cursor: buildStaticEntry("cursor"),
      copilot: buildStaticEntry("copilot"),
      claude: buildStaticEntry("claude"),
      codex: buildStaticEntry("codex"),
      gemini: buildStaticEntry("gemini"),
    },
  };
}

async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const isPowerShellShim = isWindows && /\.ps1$/i.test(spec.command);
    const command = isWindows && isPowerShellShim ? WINDOWS_POWERSHELL : spec.command;
    const args = isWindows && isPowerShellShim
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", spec.command, ...spec.args]
      : spec.args;
    const env = { ...process.env, ...(spec.env || {}) };
    if (isWindows) {
      const commandDir = dirname(spec.command);
      if (commandDir && commandDir !== "." && existsSync(commandDir)) {
        const currentPath = String(env.Path || env.PATH || "");
        if (!currentPath.toLowerCase().includes(commandDir.toLowerCase())) {
          env.Path = `${commandDir};${currentPath}`;
          env.PATH = env.Path;
        }
      }
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd: spec.cwd || process.cwd(),
      env,
      shell: false,
    });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore best-effort timeout shutdown failures.
      }
      reject(new Error(`Timed out after ${spec.timeoutMs || 15000}ms`));
    }, spec.timeoutMs || 15000);

    const finalize = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      finalize({
        exitCode: typeof code === "number" ? code : null,
        stdout,
        stderr,
      });
    });
  });
}

function parseCursorModels(stdout: string): CliDiscoveredModel[] {
  return uniqueModels(
    String(stdout || "")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line && !/^loading models/i.test(line) && !/^available models/i.test(line) && !/^tip:/i.test(line))
      .map((line) => {
        const match = line.match(/^([^\s]+)\s+-\s+(.+)$/);
        if (!match) {
          return null;
        }
        return {
          id: match[1].trim(),
          label: match[2].trim(),
        };
      })
      .filter((value): value is CliDiscoveredModel => Boolean(value)),
  );
}

function parseCopilotModels(stdout: string): CliDiscoveredModel[] {
  const lines = String(stdout || "").split(/\r?\n/g);
  const models: CliDiscoveredModel[] = [];
  let inModelSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inModelSection && models.length > 0) {
        break;
      }
      continue;
    }
    if (/^`model`:/i.test(line) || /^model:/i.test(line)) {
      inModelSection = true;
      continue;
    }
    if (!inModelSection) {
      continue;
    }
    const match = line.match(/^-\s+"?([a-z0-9._-]+)"?$/i);
    if (!match) {
      if (models.length > 0 && !line.startsWith("-")) {
        break;
      }
      continue;
    }
    models.push({
      id: match[1],
      label: match[1],
    });
  }
  return uniqueModels(models);
}

function resolveWorkspace(): string {
  return String(getConfig().cliWorkspace || process.cwd()).trim() || process.cwd();
}

function resolveClaudeBinary(): string {
  const candidates = [
    resolveClaudeCommand(),
    process.platform === "win32" ? "claude.exe" : "",
  ].filter(Boolean);
  if (process.platform === "win32") {
    try {
      const output = execFileSync("where.exe", ["claude"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const matches = String(output || "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      candidates.unshift(...matches);
    } catch {
      // Fall through to the default candidates.
    }
  }
  return candidates[0] || "claude";
}

export class CliModelDiscoveryService {
  private cache: CliModelDiscoverySnapshot = createEmptySnapshot();

  getSnapshot(): CliModelDiscoverySnapshot {
    return JSON.parse(JSON.stringify(this.cache)) as CliModelDiscoverySnapshot;
  }

  async refreshAll(): Promise<CliModelDiscoverySnapshot> {
    const fetchedAt = nowIso();
    const entries = await Promise.all([
      this.discoverCursor(fetchedAt),
      this.discoverCopilot(fetchedAt),
      this.discoverClaude(fetchedAt),
      this.discoverCodex(fetchedAt),
      this.discoverGemini(fetchedAt),
    ]);
    const providers = entries.reduce((acc, entry) => {
      acc[entry.adapter] = entry;
      return acc;
    }, {} as Record<CliSessionAdapterId, CliModelDiscoveryEntry>);
    this.cache = {
      fetched_at: fetchedAt,
      providers,
    };
    return this.getSnapshot();
  }

  private async discoverCursor(fetchedAt: string): Promise<CliModelDiscoveryEntry> {
    try {
      const command = resolveCursorAgentCommand();
      const result = await runCommand({
        command,
        args: ["models"],
        cwd: resolveWorkspace(),
        timeoutMs: 20000,
      });
      const models = parseCursorModels(result.stdout);
      if (!models.length) {
        throw new Error("Cursor returned no models");
      }
      return {
        adapter: "cursor",
        status: "ready",
        strategy: "runtime",
        models,
        fetched_at: fetchedAt,
        source_label: "Runtime command",
      };
    } catch (error) {
      return buildStaticEntry("cursor", fetchedAt, error instanceof Error ? error.message : String(error));
    }
  }

  private async discoverCopilot(fetchedAt: string): Promise<CliModelDiscoveryEntry> {
    try {
      const command = resolveCopilotHeadlessCommand();
      const result = await runCommand({
        command,
        args: ["help", "config"],
        cwd: resolveWorkspace(),
        timeoutMs: 20000,
      });
      const models = parseCopilotModels(result.stdout);
      if (!models.length) {
        throw new Error("Copilot help output did not expose a model list");
      }
      return {
        adapter: "copilot",
        status: "ready",
        strategy: "help",
        models,
        fetched_at: fetchedAt,
        source_label: "Help config parse",
      };
    } catch (error) {
      const fallback = buildStaticEntry("copilot", fetchedAt, error instanceof Error ? error.message : String(error));
      fallback.models = uniqueModels([
        { id: "gpt-5.4", label: "gpt-5.4" },
        { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
        { id: "gpt-5-mini", label: "gpt-5-mini" },
        { id: "claude-sonnet-4.6", label: "claude-sonnet-4.6" },
        { id: "gemini-3-pro-preview", label: "gemini-3-pro-preview" },
      ]);
      return fallback;
    }
  }

  private async discoverClaude(fetchedAt: string): Promise<CliModelDiscoveryEntry> {
    try {
      const command = resolveClaudeBinary();
      await runCommand({
        command,
        args: ["--help"],
        cwd: resolveWorkspace(),
        timeoutMs: 12000,
      });
      return {
        ...buildStaticEntry("claude", fetchedAt),
        status: "ready",
      };
    } catch (error) {
      return buildStaticEntry("claude", fetchedAt, error instanceof Error ? error.message : String(error));
    }
  }

  private async discoverCodex(fetchedAt: string): Promise<CliModelDiscoveryEntry> {
    try {
      const command = resolveCodexHeadlessCommand();
      await runCommand({
        command,
        args: ["--help"],
        cwd: resolveWorkspace(),
        timeoutMs: 12000,
      });
      return {
        ...buildStaticEntry("codex", fetchedAt),
        status: "ready",
      };
    } catch (error) {
      return buildStaticEntry("codex", fetchedAt, error instanceof Error ? error.message : String(error));
    }
  }

  private async discoverGemini(fetchedAt: string): Promise<CliModelDiscoveryEntry> {
    try {
      const command = resolveGeminiHeadlessCommand();
      await runCommand({
        command,
        args: ["--help"],
        cwd: resolveWorkspace(),
        timeoutMs: 12000,
      });
      return {
        ...buildStaticEntry("gemini", fetchedAt),
        status: "ready",
      };
    } catch (error) {
      return buildStaticEntry("gemini", fetchedAt, error instanceof Error ? error.message : String(error));
    }
  }
}
