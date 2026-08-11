/**
 * ACP (Agent Client Protocol) agent registry.
 *
 * Defines the set of ACP-compatible agents that AgentChatBus can spawn and
 * communicate with via the standard ACP JSON-RPC protocol over stdio.
 *
 * Each agent entry describes how to spawn it (binary or npx), which arguments
 * to pass, and optional environment variables. The generic {@link AcpAdapter}
 * reads this config and handles all protocol-level communication — no
 * per-agent adapter code is needed.
 *
 * Registry entries mirror the official ACP registry format
 * (https://github.com/agentclientprotocol/registry) but are simplified to
 * only the fields AgentChatBus needs for spawning.
 */

export type AcpDistributionKind = "binary" | "npx";

export interface AcpBinaryPlatformEntry {
  /** Command to execute (relative to archive extraction root, or absolute). */
  cmd: string;
  /** Arguments to pass after the command. */
  args: string[];
}

export interface AcpNpxDistribution {
  /** npm package spec, e.g. "@agentclientprotocol/claude-agent-acp@0.66.0". */
  package: string;
  /** Extra args after the package name. */
  args: string[];
}

export interface AcpBinaryDistribution {
  /** Map of platform key → binary entry. Platform key: `${os}-${arch}`. */
  entries: Record<string, AcpBinaryPlatformEntry>;
}

export interface AcpAgentConfig {
  /** Unique agent ID used in CliSessionAdapterId and HTTP API. */
  id: string;
  /** Human-readable name for UI display. */
  name: string;
  /** Short description. */
  description?: string;
  /** Distribution method. */
  distribution: AcpDistributionKind;
  /** Binary distribution (when distribution === "binary"). */
  binary?: AcpBinaryDistribution;
  /** npx distribution (when distribution === "npx"). */
  npx?: AcpNpxDistribution;
  /**
   * Optional environment variables to set when spawning.
   * Useful for API keys (e.g. DEVIN_API_KEY, ANTHROPIC_API_KEY).
   */
  env?: Record<string, string>;
  /**
   * If true, the agent binary is expected to already be on PATH
   * (e.g. installed via `opencode install` or `devin-cli install`).
   * The registry won't attempt to download archives.
   */
  useSystemPath?: boolean;
  /**
   * Override the spawn command entirely. When set, this is used as the
   * command and `args` from the distribution are appended.
   * Useful for agents installed at known paths like ~/.local/bin/devin.
   */
  commandOverride?: string;
  /**
   * Path (relative to $HOME) to the agent's MCP server config file.
   * Some agents (e.g., Devin CLI) self-manage their MCP servers by reading
   * a config file at startup, ignoring the `mcpServers` passed via ACP
   * `session/new`. For these agents, we patch the `agentchatbus` entry in
   * this file with the correct server URL before spawning.
   * Set to null/undefined for agents that accept ACP-provided mcpServers.
   */
  mcpConfigPath?: string;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function getPlatformKey(): string {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : "x86_64";
  return `${os}-${arch}`;
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

export const ACP_AGENTS: AcpAgentConfig[] = [
  {
    id: "devin",
    name: "Devin CLI",
    description: "Devin CLI coding agent by Cognition",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "devin", args: ["acp"] },
        "darwin-x86_64": { cmd: "devin", args: ["acp"] },
        "linux-aarch64": { cmd: "devin", args: ["acp"] },
        "linux-x86_64": { cmd: "devin", args: ["acp"] },
        "windows-aarch64": { cmd: "devin.exe", args: ["acp"] },
        "windows-x86_64": { cmd: "devin.exe", args: ["acp"] },
      },
    },
    // Devin CLI self-manages MCP servers via ~/.config/devin/mcp_config.json.
    // It ignores mcpServers passed via ACP session/new (mcpCapabilities: {http:false, sse:false}).
    // We patch the agentchatbus entry in this file before spawning.
    mcpConfigPath: ".config/devin/mcp_config.json",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "The open source coding agent",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "opencode", args: ["acp"] },
        "darwin-x86_64": { cmd: "opencode", args: ["acp"] },
        "linux-aarch64": { cmd: "opencode", args: ["acp"] },
        "linux-x86_64": { cmd: "opencode", args: ["acp"] },
        "windows-aarch64": { cmd: "opencode.exe", args: ["acp"] },
        "windows-x86_64": { cmd: "opencode.exe", args: ["acp"] },
      },
    },
  },
  {
    id: "claude",
    name: "Claude",
    description: "ACP wrapper for Anthropic's Claude",
    distribution: "npx",
    npx: {
      package: "@agentclientprotocol/claude-agent-acp@0.66.0",
      args: [],
    },
  },
  {
    id: "codex",
    name: "Codex",
    description: "ACP adapter for OpenAI's coding assistant",
    distribution: "npx",
    npx: {
      package: "@agentclientprotocol/codex-acp@1.1.14",
      args: [],
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Cursor's coding agent",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "cursor-agent", args: ["acp"] },
        "darwin-x86_64": { cmd: "cursor-agent", args: ["acp"] },
        "linux-aarch64": { cmd: "cursor-agent", args: ["acp"] },
        "linux-x86_64": { cmd: "cursor-agent", args: ["acp"] },
        "windows-aarch64": { cmd: "cursor-agent.cmd", args: ["acp"] },
        "windows-x86_64": { cmd: "cursor-agent.cmd", args: ["acp"] },
      },
    },
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    description: "GitHub's AI pair programmer",
    distribution: "npx",
    npx: {
      package: "@github/copilot-language-server@1.529.0",
      args: ["--acp"],
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google's official CLI for Gemini",
    distribution: "npx",
    npx: {
      package: "@google/gemini-cli@0.54.4",
      args: ["--acp"],
    },
  },
  {
    id: "glm",
    name: "GLM Agent",
    description:
      "ACP agent powered by Zhipu AI's GLM Coding Plan models",
    distribution: "npx",
    npx: {
      package: "glm-acp-agent@1.3.0",
      args: [],
    },
  },
  {
    id: "qwen",
    name: "Qwen Code",
    description: "Alibaba's Qwen coding assistant",
    distribution: "npx",
    npx: {
      package: "@qwen-code/qwen-code@0.21.9",
      args: ["--acp", "--experimental-skills"],
    },
  },
  {
    id: "grok",
    name: "Grok Build",
    description: "xAI's coding agent and CLI",
    distribution: "npx",
    npx: {
      package: "@xai-official/grok@1.0.0",
      args: ["agent", "stdio"],
    },
  },
  {
    id: "cline",
    name: "Cline",
    description:
      "Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more",
    distribution: "npx",
    npx: {
      package: "cline@3.0.52",
      args: ["--acp"],
    },
  },
  {
    id: "auggie",
    name: "Auggie CLI",
    description:
      "Augment Code's powerful software agent, backed by industry-leading context engine",
    distribution: "npx",
    npx: {
      package: "@augmentcode/auggie@0.35.0",
      args: ["--acp"],
    },
    env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
  },
  {
    id: "goose",
    name: "Goose",
    description:
      "A local, extensible, open source AI agent that automates engineering tasks",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "goose", args: ["acp"] },
        "darwin-x86_64": { cmd: "goose", args: ["acp"] },
        "linux-aarch64": { cmd: "goose", args: ["acp"] },
        "linux-x86_64": { cmd: "goose", args: ["acp"] },
        "windows-x86_64": { cmd: "goose.exe", args: ["acp"] },
      },
    },
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    description: "Moonshot AI's coding assistant",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "kimi", args: ["acp"] },
        "linux-aarch64": { cmd: "kimi", args: ["acp"] },
        "linux-x86_64": { cmd: "kimi", args: ["acp"] },
        "windows-aarch64": { cmd: "kimi.exe", args: ["acp"] },
        "windows-x86_64": { cmd: "kimi.exe", args: ["acp"] },
      },
    },
  },
  {
    id: "amp",
    name: "Amp",
    description: "ACP wrapper for Amp - the frontier coding agent",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "amp-acp", args: [] },
        "darwin-x86_64": { cmd: "amp-acp", args: [] },
        "linux-aarch64": { cmd: "amp-acp", args: [] },
        "linux-x86_64": { cmd: "amp-acp", args: [] },
        "windows-x86_64": { cmd: "amp-acp.exe", args: [] },
      },
    },
  },
  {
    id: "factory-droid",
    name: "Factory Droid",
    description: "Factory Droid - AI coding agent powered by Factory AI",
    distribution: "npx",
    npx: {
      package: "droid@0.191.1",
      args: ["exec", "--output-format", "acp-daemon"],
    },
    env: {
      DROID_DISABLE_AUTO_UPDATE: "true",
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    },
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    description: "Mistral's open-source coding assistant",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "vibe-acp", args: [] },
        "darwin-x86_64": { cmd: "vibe-acp", args: [] },
        "linux-aarch64": { cmd: "vibe-acp", args: [] },
        "linux-x86_64": { cmd: "vibe-acp", args: [] },
        "windows-x86_64": { cmd: "vibe-acp.exe", args: [] },
      },
    },
  },
  {
    id: "poolside",
    name: "Poolside",
    description: "Poolside's coding agent",
    distribution: "binary",
    useSystemPath: true,
    binary: {
      entries: {
        "darwin-aarch64": { cmd: "pool", args: ["acp"] },
        "darwin-x86_64": { cmd: "pool", args: ["acp"] },
        "linux-aarch64": { cmd: "pool", args: ["acp"] },
        "linux-x86_64": { cmd: "pool", args: ["acp"] },
        "windows-aarch64": { cmd: "pool.exe", args: ["acp"] },
        "windows-x86_64": { cmd: "pool.exe", args: ["acp"] },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const ACP_AGENT_MAP = new Map<string, AcpAgentConfig>(
  ACP_AGENTS.map((agent) => [agent.id, agent]),
);

export function getAcpAgent(id: string): AcpAgentConfig | undefined {
  return ACP_AGENT_MAP.get(id);
}

export function listAcpAgents(): AcpAgentConfig[] {
  return ACP_AGENTS.slice();
}

export function isAcpAgent(id: string): boolean {
  return ACP_AGENT_MAP.has(id);
}

/**
 * Resolve the spawn command and args for an agent on the current platform.
 * Returns null if the agent is not found or the current platform has no
 * binary distribution.
 */
export function resolveAcpSpawnCommand(
  agentId: string,
): { command: string; args: string[] } | null {
  const agent = ACP_AGENT_MAP.get(agentId);
  if (!agent) {
    return null;
  }

  if (agent.distribution === "npx" && agent.npx) {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    return {
      command: npxCmd,
      args: ["-y", agent.npx.package, ...agent.npx.args],
    };
  }

  if (agent.distribution === "binary" && agent.binary) {
    const platformKey = getPlatformKey();
    const entry = agent.binary.entries[platformKey];
    if (!entry) {
      return null;
    }
    return {
      command: entry.cmd,
      args: entry.args,
    };
  }

  return null;
}
