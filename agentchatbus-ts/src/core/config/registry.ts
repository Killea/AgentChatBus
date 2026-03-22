import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isIPv4 } from "node:net";
import { getLaunchOverride, isLaunchLockedEnvVar } from "./launchOverrides.js";

export type ConfigType = "boolean" | "integer" | "number" | "string" | "string[]" | "enum";
export type ConfigKind =
  | "duration_seconds"
  | "duration_ms"
  | "host"
  | "port"
  | "feature_flag"
  | "cidr_list"
  | "path"
  | "secret"
  | "text";
export type ConfigScope = "editable" | "readonly" | "hidden";
export type ConfigSensitivity =
  | "public"
  | "security"
  | "secret"
  | "internal"
  | "path"
  | "test"
  | "runtime";
export type ConfigSectionId = "agent" | "attention" | "network" | "advanced" | "diagnostics" | "internal";
export type ConfigValueSource = "env" | "persisted" | "default" | "derived";

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  dbPathConfigured: boolean;
  testDbPath: string | null;
  adminToken: string | null;
  showAd: boolean;
  allowedHosts: string[];
  agentHeartbeatTimeout: number;
  msgWaitTimeout: number;
  msgWaitMinTimeoutMs: number;
  enforceMsgWaitMinTimeout: boolean;
  replyTokenLeaseSeconds: number;
  seqTolerance: number;
  seqMismatchMaxMessages: number;
  rateLimitMsgPerMinute: number;
  rateLimitEnabled: boolean;
  threadTimeoutMinutes: number;
  threadTimeoutSweepInterval: number;
  reloadEnabled: boolean;
  exposeThreadResources: boolean;
  contentFilterEnabled: boolean;
  enableHandoffTarget: boolean;
  enableStopReason: boolean;
  enablePriority: boolean;
  appDir: string;
  configFile: string;
  webUiDir: string | null;
  uploadsDir: string | null;
  cliWorkspace: string | null;
  cursorAgentCommand: string | null;
  codexCommand: string | null;
  ptyUseConpty: boolean;
  ownerBootToken: string;
  ideHeartbeatTimeoutMs: number;
}

export interface ConfigDescriptor<T = unknown> {
  key: string;
  envVar: string;
  resolvedField: keyof AppConfig;
  persistedKey?: string;
  type: ConfigType;
  kind: ConfigKind;
  defaultValue: T | ((ctx: ResolveContext) => T);
  label: string;
  description: string;
  section: ConfigSectionId;
  scope: ConfigScope;
  sensitivity: ConfigSensitivity;
  restartRequired: boolean;
  order: number;
  inputId?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  resolve: (ctx: ResolveContext) => T;
}

type ResolveContext = {
  persisted: Record<string, unknown>;
  resolved: Partial<AppConfig>;
};

type SectionMeta = {
  id: ConfigSectionId;
  navLabel: string;
  title: string;
  order: number;
};

export type SettingsManifestField = {
  key: string;
  source: "config" | "diagnostic";
  value_source: ConfigValueSource;
  label: string;
  input_id: string;
  type: ConfigType;
  kind: ConfigKind;
  description: string;
  section: ConfigSectionId;
  scope: Exclude<ConfigScope, "hidden">;
  sensitivity: ConfigSensitivity | "derived";
  restart_required: boolean;
  value: unknown;
  default_value?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  editable: boolean;
  readonly_reason?: string;
};

export type SettingsManifestSection = {
  id: ConfigSectionId;
  nav_label: string;
  title: string;
  order: number;
  fields: SettingsManifestField[];
};

export type SettingsManifest = {
  schema_version: string;
  save_message: string;
  sections: SettingsManifestSection[];
};

type DiagnosticDescriptor = {
  key: string;
  label: string;
  description: string;
  type: ConfigType;
  kind: ConfigKind;
  sensitivity: "derived";
  section: "diagnostics";
  order: number;
  value: (config: AppConfig) => unknown;
};

const SETTINGS_MANIFEST_SCHEMA_VERSION = "2026-03-19.v2";
const DEFAULT_MSG_WAIT_MIN_TIMEOUT_MS = process.env.NODE_ENV === "test" ? 0 : 60000;

const SECTION_META: Record<ConfigSectionId, SectionMeta> = {
  agent: { id: "agent", navLabel: "Agent", title: "Timeouts", order: 10 },
  attention: { id: "attention", navLabel: "Attention", title: "Attention Mechanisms", order: 20 },
  network: { id: "network", navLabel: "Network", title: "Listening", order: 30 },
  advanced: { id: "advanced", navLabel: "Advanced", title: "Advanced", order: 40 },
  diagnostics: { id: "diagnostics", navLabel: "Diagnostics", title: "Runtime Configuration", order: 90 },
  internal: { id: "internal", navLabel: "Internal", title: "Internal", order: 999 },
};

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? value : undefined;
}

function getEnvValue(envVar: string): string | undefined {
  // Launch overrides are higher precedence than real environment variables.
  const launchOverride = getLaunchOverride(envVar);
  if (launchOverride !== undefined) {
    return normalizeEnvValue(launchOverride);
  }
  return normalizeEnvValue(process.env[envVar]);
}

function getPersistedValue(persisted: Record<string, unknown>, key?: string): unknown {
  if (!key) return undefined;
  return persisted[key];
}

function getRawValue(
  ctx: ResolveContext,
  descriptor: Pick<ConfigDescriptor, "envVar" | "persistedKey">,
  fallback: unknown
): unknown {
  const envValue = getEnvValue(descriptor.envVar);
  if (envValue !== undefined) {
    return envValue;
  }
  const persistedValue = getPersistedValue(ctx.persisted, descriptor.persistedKey);
  if (persistedValue !== undefined && persistedValue !== null && String(persistedValue) !== "") {
    return persistedValue;
  }
  return fallback;
}

function hasPersistedValue(
  persisted: Record<string, unknown>,
  key?: string
): boolean {
  if (!key) return false;
  const persistedValue = getPersistedValue(persisted, key);
  return persistedValue !== undefined && persistedValue !== null && String(persistedValue) !== "";
}

function getConfigValueSource(
  descriptor: Pick<ConfigDescriptor, "envVar" | "persistedKey">,
  ctx: ResolveContext
): Exclude<ConfigValueSource, "derived"> {
  if (getEnvValue(descriptor.envVar) !== undefined) {
    return "env";
  }
  if (hasPersistedValue(ctx.persisted, descriptor.persistedKey)) {
    return "persisted";
  }
  return "default";
}

function getReadonlyReason(
  descriptor: ConfigDescriptor,
  valueSource: Exclude<ConfigValueSource, "derived">
): string | undefined {
  void valueSource; // kept for future: useful for UI copy, not needed for lock decision

  // Only settings injected via CLI launch parameters become readonly.
  // We intentionally do NOT treat all env-provided values as readonly anymore.
  if (descriptor.scope === "editable" && isLaunchLockedEnvVar(descriptor.envVar)) {
    return (
      `This setting is controlled by launch parameters (${descriptor.envVar}) ` +
      "and is read-only in the Web UI. Change the launch parameters and restart the server to update it."
    );
  }
  return undefined;
}

function parseBoolLike(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseStrictBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new Error("invalid boolean");
}

function parseNumberLike(value: unknown, defaultValue: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseIntegerLike(value: unknown, defaultValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.trunc(parsed);
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map(item => item.trim()).filter(Boolean);
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [String(value).trim()].filter(Boolean);
}

function parseNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

export function isIpAllowed(ip: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;

  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;

  for (const entry of allowedHosts) {
    if (entry.includes("/")) {
      const [networkAddr, prefixLenStr] = entry.split("/");
      const prefixLen = Number(prefixLenStr);
      if (!isIPv4(networkAddr) || !isIPv4(normalized) || isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) {
        continue;
      }
      const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
      const ipInt = ipToInt(normalized);
      const netInt = ipToInt(networkAddr);
      if (ipInt !== null && netInt !== null && (ipInt & mask) === (netInt & mask)) {
        return true;
      }
    } else if (normalized === entry || ip === entry) {
      return true;
    }
  }
  return false;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function getAppDirFallback(): string {
  const configured = getEnvValue("AGENTCHATBUS_APP_DIR");
  if (configured) {
    return resolve(configured);
  }
  return join(process.cwd(), "data");
}

function getConfigFileFallback(appDir: string): string {
  const configured = getEnvValue("AGENTCHATBUS_CONFIG_FILE");
  if (configured) {
    return resolve(configured);
  }
  return join(appDir, "config.json");
}

function getPersistedConfigFilePath(): string {
  return getConfigFileFallback(getAppDirFallback());
}

export function getPersistedConfig(): Record<string, unknown> {
  const configFile = getPersistedConfigFilePath();
  try {
    if (existsSync(configFile)) {
      return JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function resolveDefaultValue<T>(descriptor: ConfigDescriptor<T>, ctx: ResolveContext): T {
  return typeof descriptor.defaultValue === "function"
    ? (descriptor.defaultValue as (ctx: ResolveContext) => T)(ctx)
    : descriptor.defaultValue;
}

function makeInputId(key: string): string {
  return `setting-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function buildVisibleField<T>(
  descriptor: ConfigDescriptor<T>,
  value: T,
  ctx: ResolveContext
): SettingsManifestField {
  const valueSource = getConfigValueSource(descriptor, ctx);
  const readonlyReason = getReadonlyReason(descriptor, valueSource);
  const effectiveScope: Exclude<ConfigScope, "hidden"> =
    readonlyReason ? "readonly" : (descriptor.scope as Exclude<ConfigScope, "hidden">);

  return {
    key: descriptor.key,
    source: "config",
    value_source: valueSource,
    label: descriptor.label,
    input_id: descriptor.inputId ?? makeInputId(descriptor.key),
    type: descriptor.type,
    kind: descriptor.kind,
    description: descriptor.description,
    section: descriptor.section,
    scope: effectiveScope,
    sensitivity: descriptor.sensitivity,
    restart_required: descriptor.restartRequired,
    value,
    default_value: resolveDefaultValue(descriptor, ctx),
    min: descriptor.min,
    max: descriptor.max,
    step: descriptor.step,
    options: descriptor.options,
    editable: descriptor.scope === "editable" && !readonlyReason,
    readonly_reason: readonlyReason,
  };
}

const DIAGNOSTIC_FIELDS: DiagnosticDescriptor[] = [
  {
    key: "PUBLIC_DEMO_MODE",
    label: "Public Demo Mode",
    description: "Derived from SHOW_AD. When enabled, public-demo security restrictions are active.",
    type: "boolean",
    kind: "feature_flag",
    sensitivity: "derived",
    section: "diagnostics",
    order: 310,
    value: (config) => config.showAd,
  },
  {
    key: "ADMIN_TOKEN_CONFIGURED",
    label: "Admin Token Configured",
    description: "True when AGENTCHATBUS_ADMIN_TOKEN is set.",
    type: "boolean",
    kind: "feature_flag",
    sensitivity: "derived",
    section: "diagnostics",
    order: 320,
    value: (config) => Boolean(config.adminToken),
  },
  {
    key: "ALLOWED_HOSTS_ENABLED",
    label: "IP Allowlist Enabled",
    description: "True when AGENTCHATBUS_ALLOWED_HOSTS contains at least one entry.",
    type: "boolean",
    kind: "feature_flag",
    sensitivity: "derived",
    section: "diagnostics",
    order: 330,
    value: (config) => config.allowedHosts.length > 0,
  },
];

export const CONFIG_REGISTRY: ReadonlyArray<ConfigDescriptor> = [
  {
    key: "APP_DIR",
    envVar: "AGENTCHATBUS_APP_DIR",
    resolvedField: "appDir",
    type: "string",
    kind: "path",
    defaultValue: () => join(process.cwd(), "data"),
    label: "App Directory",
    description: "Base directory used for runtime data and default config locations.",
    section: "internal",
    scope: "hidden",
    sensitivity: "path",
    restartRequired: true,
    order: 1,
    resolve: () => getAppDirFallback(),
  },
  {
    key: "CONFIG_FILE",
    envVar: "AGENTCHATBUS_CONFIG_FILE",
    resolvedField: "configFile",
    type: "string",
    kind: "path",
    defaultValue: (ctx: ResolveContext) => join(String(ctx.resolved.appDir || getAppDirFallback()), "config.json"),
    label: "Config File",
    description: "Path to the persisted TS config JSON file.",
    section: "internal",
    scope: "hidden",
    sensitivity: "path",
    restartRequired: true,
    order: 2,
    resolve: (ctx) => getConfigFileFallback(String(ctx.resolved.appDir || getAppDirFallback())),
  },
  {
    key: "HOST",
    envVar: "AGENTCHATBUS_HOST",
    resolvedField: "host",
    persistedKey: "HOST",
    type: "string",
    kind: "host",
    defaultValue: "127.0.0.1",
    label: "Host",
    description:
      "The IP address or hostname the server binds to. Use '127.0.0.1' for local-only access or '0.0.0.0' for LAN access.",
    section: "network",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 10,
    inputId: "setting-host",
    resolve: (ctx) => String(getRawValue(ctx, { envVar: "AGENTCHATBUS_HOST", persistedKey: "HOST" }, "127.0.0.1")),
  },
  {
    key: "PORT",
    envVar: "AGENTCHATBUS_PORT",
    resolvedField: "port",
    persistedKey: "PORT",
    type: "integer",
    kind: "port",
    defaultValue: 39765,
    label: "Port",
    description: "The TCP port used by the HTTP and SSE server.",
    section: "network",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 20,
    inputId: "setting-port",
    min: 1,
    max: 65535,
    step: 1,
    resolve: (ctx) => parseIntegerLike(getRawValue(ctx, { envVar: "AGENTCHATBUS_PORT", persistedKey: "PORT" }, 39765), 39765),
  },
  {
    key: "DB",
    envVar: "AGENTCHATBUS_DB",
    resolvedField: "dbPath",
    type: "string",
    kind: "path",
    defaultValue: (ctx: ResolveContext) => join(String(ctx.resolved.appDir || getAppDirFallback()), "bus-ts.db"),
    label: "Database Path",
    description: "Primary SQLite database path.",
    section: "internal",
    scope: "hidden",
    sensitivity: "path",
    restartRequired: true,
    order: 30,
    resolve: (ctx) => getEnvValue("AGENTCHATBUS_DB") || join(String(ctx.resolved.appDir || getAppDirFallback()), "bus-ts.db"),
  },
  {
    key: "TEST_DB",
    envVar: "AGENTCHATBUS_TEST_DB",
    resolvedField: "testDbPath",
    type: "string",
    kind: "path",
    defaultValue: null,
    label: "Test Database Path",
    description: "Testing-only database override used by integration and unit tests.",
    section: "internal",
    scope: "hidden",
    sensitivity: "test",
    restartRequired: true,
    order: 40,
    resolve: () => parseNullableString(getEnvValue("AGENTCHATBUS_TEST_DB")),
  },
  {
    key: "ADMIN_TOKEN",
    envVar: "AGENTCHATBUS_ADMIN_TOKEN",
    resolvedField: "adminToken",
    type: "string",
    kind: "secret",
    defaultValue: null,
    label: "Admin Token",
    description: "Admin token used to protect privileged settings and management endpoints.",
    section: "internal",
    scope: "hidden",
    sensitivity: "secret",
    restartRequired: true,
    order: 50,
    resolve: () => parseNullableString(getEnvValue("AGENTCHATBUS_ADMIN_TOKEN")),
  },
  {
    key: "SHOW_AD",
    envVar: "AGENTCHATBUS_SHOW_AD",
    resolvedField: "showAd",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: false,
    label: "Public Demo Mode",
    description: "Public-demo guard mode. Hidden from normal settings because it changes the service security posture.",
    section: "internal",
    scope: "hidden",
    sensitivity: "security",
    restartRequired: true,
    order: 60,
    resolve: () => parseBoolLike(getEnvValue("AGENTCHATBUS_SHOW_AD"), false),
  },
  {
    key: "ALLOWED_HOSTS",
    envVar: "AGENTCHATBUS_ALLOWED_HOSTS",
    resolvedField: "allowedHosts",
    type: "string[]",
    kind: "cidr_list",
    defaultValue: [],
    label: "Allowed Hosts",
    description: "Optional IP/CIDR allowlist for non-loopback clients.",
    section: "internal",
    scope: "hidden",
    sensitivity: "security",
    restartRequired: true,
    order: 70,
    resolve: () => parseAllowedHosts(getEnvValue("AGENTCHATBUS_ALLOWED_HOSTS")),
  },
  {
    key: "AGENT_HEARTBEAT_TIMEOUT",
    envVar: "AGENTCHATBUS_HEARTBEAT_TIMEOUT",
    resolvedField: "agentHeartbeatTimeout",
    persistedKey: "AGENT_HEARTBEAT_TIMEOUT",
    type: "integer",
    kind: "duration_seconds",
    defaultValue: 60,
    label: "Agent Heartbeat Timeout (seconds)",
    description: "Interval used to determine whether an agent is still considered online.",
    section: "agent",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 80,
    inputId: "setting-heartbeat",
    min: 1,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(ctx, { envVar: "AGENTCHATBUS_HEARTBEAT_TIMEOUT", persistedKey: "AGENT_HEARTBEAT_TIMEOUT" }, 60),
      60
    ),
  },
  {
    key: "MSG_WAIT_TIMEOUT",
    envVar: "AGENTCHATBUS_WAIT_TIMEOUT",
    resolvedField: "msgWaitTimeout",
    persistedKey: "MSG_WAIT_TIMEOUT",
    type: "integer",
    kind: "duration_seconds",
    defaultValue: 300,
    label: "Default msg_wait Timeout (seconds)",
    description: "Default long-poll timeout used when clients do not provide timeout_ms.",
    section: "agent",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 90,
    inputId: "setting-wait",
    min: 1,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(ctx, { envVar: "AGENTCHATBUS_WAIT_TIMEOUT", persistedKey: "MSG_WAIT_TIMEOUT" }, 300),
      300
    ),
  },
  {
    key: "MSG_WAIT_MIN_TIMEOUT_MS",
    envVar: "AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS",
    resolvedField: "msgWaitMinTimeoutMs",
    persistedKey: "MSG_WAIT_MIN_TIMEOUT_MS",
    type: "integer",
    kind: "duration_ms",
    defaultValue: DEFAULT_MSG_WAIT_MIN_TIMEOUT_MS,
    label: "Minimum msg_wait Timeout (ms)",
    description: "TS-only minimum timeout used to clamp blocking msg_wait polls.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 100,
    min: 0,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS", persistedKey: "MSG_WAIT_MIN_TIMEOUT_MS" },
        DEFAULT_MSG_WAIT_MIN_TIMEOUT_MS
      ),
      DEFAULT_MSG_WAIT_MIN_TIMEOUT_MS
    ),
  },
  {
    key: "ENFORCE_MSG_WAIT_MIN_TIMEOUT",
    envVar: "AGENTCHATBUS_ENFORCE_MSG_WAIT_MIN_TIMEOUT",
    resolvedField: "enforceMsgWaitMinTimeout",
    persistedKey: "ENFORCE_MSG_WAIT_MIN_TIMEOUT",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: false,
    label: "Enforce Minimum msg_wait Timeout",
    description: "Rejects non-quick-return waits shorter than the configured minimum timeout.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 110,
    resolve: (ctx) => parseBoolLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_ENFORCE_MSG_WAIT_MIN_TIMEOUT", persistedKey: "ENFORCE_MSG_WAIT_MIN_TIMEOUT" },
        false
      ),
      false
    ),
  },
  {
    key: "REPLY_TOKEN_LEASE_SECONDS",
    envVar: "AGENTCHATBUS_REPLY_TOKEN_LEASE_SECONDS",
    resolvedField: "replyTokenLeaseSeconds",
    persistedKey: "REPLY_TOKEN_LEASE_SECONDS",
    type: "integer",
    kind: "duration_seconds",
    defaultValue: 3600,
    label: "Reply Token Lease (seconds)",
    description: "Lifetime of issued reply tokens before they expire.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 120,
    min: 1,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_REPLY_TOKEN_LEASE_SECONDS", persistedKey: "REPLY_TOKEN_LEASE_SECONDS" },
        3600
      ),
      3600
    ),
  },
  {
    key: "SEQ_TOLERANCE",
    envVar: "AGENTCHATBUS_SEQ_TOLERANCE",
    resolvedField: "seqTolerance",
    persistedKey: "SEQ_TOLERANCE",
    type: "integer",
    kind: "text",
    defaultValue: 0,
    label: "Sequence Tolerance",
    description: "Allowed sequence skew before strict sync rejects a request.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 130,
    min: 0,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(ctx, { envVar: "AGENTCHATBUS_SEQ_TOLERANCE", persistedKey: "SEQ_TOLERANCE" }, 0),
      0
    ),
  },
  {
    key: "SEQ_MISMATCH_MAX_MESSAGES",
    envVar: "AGENTCHATBUS_SEQ_MISMATCH_MAX_MESSAGES",
    resolvedField: "seqMismatchMaxMessages",
    persistedKey: "SEQ_MISMATCH_MAX_MESSAGES",
    type: "integer",
    kind: "text",
    defaultValue: 100,
    label: "Seq Mismatch Max Messages",
    description: "Maximum number of messages returned in seq mismatch recovery payloads.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 140,
    min: 1,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_SEQ_MISMATCH_MAX_MESSAGES", persistedKey: "SEQ_MISMATCH_MAX_MESSAGES" },
        100
      ),
      100
    ),
  },
  {
    key: "RATE_LIMIT_ENABLED",
    envVar: "AGENTCHATBUS_RATE_LIMIT_ENABLED",
    resolvedField: "rateLimitEnabled",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: true,
    label: "Rate Limiting Enabled",
    description: "Readonly view of whether per-agent message rate limiting is active.",
    section: "diagnostics",
    scope: "readonly",
    sensitivity: "runtime",
    restartRequired: true,
    order: 150,
    resolve: () => parseBoolLike(getEnvValue("AGENTCHATBUS_RATE_LIMIT_ENABLED"), true),
  },
  {
    key: "RATE_LIMIT_MSG_PER_MINUTE",
    envVar: "AGENTCHATBUS_RATE_LIMIT",
    resolvedField: "rateLimitMsgPerMinute",
    persistedKey: "RATE_LIMIT_MSG_PER_MINUTE",
    type: "integer",
    kind: "text",
    defaultValue: 30,
    label: "Rate Limit (messages/minute)",
    description: "Maximum messages an agent can post per minute when rate limiting is enabled.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 160,
    min: 0,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(ctx, { envVar: "AGENTCHATBUS_RATE_LIMIT", persistedKey: "RATE_LIMIT_MSG_PER_MINUTE" }, 30),
      30
    ),
  },
  {
    key: "THREAD_TIMEOUT",
    envVar: "AGENTCHATBUS_THREAD_TIMEOUT",
    resolvedField: "threadTimeoutMinutes",
    persistedKey: "THREAD_TIMEOUT",
    type: "integer",
    kind: "duration_seconds",
    defaultValue: 0,
    label: "Thread Timeout (minutes)",
    description: "Automatic thread close timeout. Use 0 to disable.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 170,
    min: 0,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(ctx, { envVar: "AGENTCHATBUS_THREAD_TIMEOUT", persistedKey: "THREAD_TIMEOUT" }, 0),
      0
    ),
  },
  {
    key: "TIMEOUT_SWEEP_INTERVAL",
    envVar: "AGENTCHATBUS_TIMEOUT_SWEEP_INTERVAL",
    resolvedField: "threadTimeoutSweepInterval",
    persistedKey: "TIMEOUT_SWEEP_INTERVAL",
    type: "integer",
    kind: "duration_seconds",
    defaultValue: 60,
    label: "Thread Timeout Sweep Interval (seconds)",
    description: "Polling interval used by the timeout sweeper when thread timeout is enabled.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 180,
    min: 1,
    step: 1,
    resolve: (ctx) => parseIntegerLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_TIMEOUT_SWEEP_INTERVAL", persistedKey: "TIMEOUT_SWEEP_INTERVAL" },
        60
      ),
      60
    ),
  },
  {
    key: "RELOAD",
    envVar: "AGENTCHATBUS_RELOAD",
    resolvedField: "reloadEnabled",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: false,
    label: "Reload Enabled",
    description: "Development-only live-reload toggle.",
    section: "internal",
    scope: "hidden",
    sensitivity: "runtime",
    restartRequired: true,
    order: 190,
    resolve: () => parseBoolLike(getEnvValue("AGENTCHATBUS_RELOAD"), false),
  },
  {
    key: "EXPOSE_THREAD_RESOURCES",
    envVar: "AGENTCHATBUS_EXPOSE_THREAD_RESOURCES",
    resolvedField: "exposeThreadResources",
    persistedKey: "EXPOSE_THREAD_RESOURCES",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: false,
    label: "Expose Thread Resources",
    description: "Allows MCP clients to browse per-thread transcript and state resources.",
    section: "advanced",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 200,
    resolve: (ctx) => parseBoolLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_EXPOSE_THREAD_RESOURCES", persistedKey: "EXPOSE_THREAD_RESOURCES" },
        false
      ),
      false
    ),
  },
  {
    key: "CONTENT_FILTER_ENABLED",
    envVar: "AGENTCHATBUS_CONTENT_FILTER_ENABLED",
    resolvedField: "contentFilterEnabled",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: true,
    label: "Content Filter Enabled",
    description: "Readonly view of the secret-pattern content filter guard.",
    section: "diagnostics",
    scope: "readonly",
    sensitivity: "runtime",
    restartRequired: true,
    order: 210,
    resolve: () => parseBoolLike(getEnvValue("AGENTCHATBUS_CONTENT_FILTER_ENABLED"), true),
  },
  {
    key: "ENABLE_HANDOFF_TARGET",
    envVar: "AGENTCHATBUS_ENABLE_HANDOFF_TARGET",
    resolvedField: "enableHandoffTarget",
    persistedKey: "ENABLE_HANDOFF_TARGET",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: false,
    label: "Handoff Target Mechanism",
    description: "Controls whether agents can route messages directly to another agent.",
    section: "attention",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 220,
    inputId: "setting-handoff-target",
    resolve: (ctx) => parseBoolLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_ENABLE_HANDOFF_TARGET", persistedKey: "ENABLE_HANDOFF_TARGET" },
        false
      ),
      false
    ),
  },
  {
    key: "ENABLE_STOP_REASON",
    envVar: "AGENTCHATBUS_ENABLE_STOP_REASON",
    resolvedField: "enableStopReason",
    persistedKey: "ENABLE_STOP_REASON",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: false,
    label: "Stop Reason Mechanism",
    description: "Controls whether agents can annotate messages with a stop reason.",
    section: "attention",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 230,
    inputId: "setting-stop-reason",
    resolve: (ctx) => parseBoolLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_ENABLE_STOP_REASON", persistedKey: "ENABLE_STOP_REASON" },
        false
      ),
      false
    ),
  },
  {
    key: "ENABLE_PRIORITY",
    envVar: "AGENTCHATBUS_ENABLE_PRIORITY",
    resolvedField: "enablePriority",
    persistedKey: "ENABLE_PRIORITY",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: false,
    label: "Message Priority Mechanism",
    description: "Controls whether agents can mark messages as urgent or system priority.",
    section: "attention",
    scope: "editable",
    sensitivity: "public",
    restartRequired: true,
    order: 240,
    inputId: "setting-priority",
    resolve: (ctx) => parseBoolLike(
      getRawValue(
        ctx,
        { envVar: "AGENTCHATBUS_ENABLE_PRIORITY", persistedKey: "ENABLE_PRIORITY" },
        false
      ),
      false
    ),
  },
  {
    key: "IDE_HEARTBEAT_TIMEOUT",
    envVar: "AGENTCHATBUS_IDE_HEARTBEAT_TIMEOUT",
    resolvedField: "ideHeartbeatTimeoutMs",
    type: "integer",
    kind: "duration_ms",
    defaultValue: 45000,
    label: "IDE Heartbeat Timeout",
    description: "Internal IDE-side ownership heartbeat timeout.",
    section: "internal",
    scope: "hidden",
    sensitivity: "runtime",
    restartRequired: true,
    order: 250,
    resolve: () => parseIntegerLike(getEnvValue("AGENTCHATBUS_IDE_HEARTBEAT_TIMEOUT"), 45000),
  },
  {
    key: "OWNER_BOOT_TOKEN",
    envVar: "AGENTCHATBUS_OWNER_BOOT_TOKEN",
    resolvedField: "ownerBootToken",
    type: "string",
    kind: "secret",
    defaultValue: "",
    label: "Owner Boot Token",
    description: "Internal bundled-service ownership token.",
    section: "internal",
    scope: "hidden",
    sensitivity: "secret",
    restartRequired: true,
    order: 260,
    resolve: () => String(getEnvValue("AGENTCHATBUS_OWNER_BOOT_TOKEN") || ""),
  },
  {
    key: "WEB_UI_DIR",
    envVar: "AGENTCHATBUS_WEB_UI_DIR",
    resolvedField: "webUiDir",
    type: "string",
    kind: "path",
    defaultValue: null,
    label: "Web UI Directory",
    description: "Override directory used to serve the bundled browser UI.",
    section: "internal",
    scope: "hidden",
    sensitivity: "path",
    restartRequired: true,
    order: 270,
    resolve: () => {
      const configured = getEnvValue("AGENTCHATBUS_WEB_UI_DIR");
      return configured ? resolve(configured) : null;
    },
  },
  {
    key: "UPLOADS_DIR",
    envVar: "AGENTCHATBUS_UPLOADS_DIR",
    resolvedField: "uploadsDir",
    type: "string",
    kind: "path",
    defaultValue: null,
    label: "Uploads Directory",
    description: "Optional upload root used by MCP file-aware helpers.",
    section: "internal",
    scope: "hidden",
    sensitivity: "path",
    restartRequired: true,
    order: 280,
    resolve: () => {
      const configured = getEnvValue("AGENTCHATBUS_UPLOADS_DIR");
      return configured ? resolve(configured) : null;
    },
  },
  {
    key: "CLI_WORKSPACE",
    envVar: "AGENTCHATBUS_CLI_WORKSPACE",
    resolvedField: "cliWorkspace",
    type: "string",
    kind: "path",
    defaultValue: null,
    label: "CLI Workspace",
    description: "Default workspace path used by CLI adapters when no explicit workspace is supplied.",
    section: "internal",
    scope: "hidden",
    sensitivity: "path",
    restartRequired: true,
    order: 281,
    resolve: () => {
      const configured = getEnvValue("AGENTCHATBUS_CLI_WORKSPACE");
      return configured ? resolve(configured) : null;
    },
  },
  {
    key: "CURSOR_AGENT_COMMAND",
    envVar: "AGENTCHATBUS_CURSOR_AGENT_COMMAND",
    resolvedField: "cursorAgentCommand",
    type: "string",
    kind: "text",
    defaultValue: null,
    label: "Cursor Agent Command",
    description: "Optional override for the Cursor CLI command used by the headless adapter.",
    section: "internal",
    scope: "hidden",
    sensitivity: "runtime",
    restartRequired: true,
    order: 282,
    resolve: () => {
      const configured = getEnvValue("AGENTCHATBUS_CURSOR_AGENT_COMMAND");
      return configured ? configured : null;
    },
  },
  {
    key: "CODEX_COMMAND",
    envVar: "AGENTCHATBUS_CODEX_COMMAND",
    resolvedField: "codexCommand",
    type: "string",
    kind: "text",
    defaultValue: null,
    label: "Codex Command",
    description: "Optional override for the Codex CLI command used by the interactive PTY adapter.",
    section: "internal",
    scope: "hidden",
    sensitivity: "runtime",
    restartRequired: true,
    order: 283,
    resolve: () => {
      const configured = getEnvValue("AGENTCHATBUS_CODEX_COMMAND");
      return configured ? configured : null;
    },
  },
  {
    key: "PTY_USE_CONPTY",
    envVar: "AGENTCHATBUS_PTY_USE_CONPTY",
    resolvedField: "ptyUseConpty",
    type: "boolean",
    kind: "feature_flag",
    defaultValue: true,
    label: "Use ConPTY",
    description: "Controls whether Windows PTY sessions prefer ConPTY before falling back to WinPTY.",
    section: "internal",
    scope: "hidden",
    sensitivity: "runtime",
    restartRequired: true,
    order: 284,
    resolve: (ctx) => parseBoolLike(getRawValue(ctx, { envVar: "AGENTCHATBUS_PTY_USE_CONPTY" }, true), true),
  },
] as const;

const REGISTRY_BY_KEY = new Map(CONFIG_REGISTRY.map(descriptor => [descriptor.key, descriptor]));
const REGISTRY_BY_ENV_VAR = new Map(CONFIG_REGISTRY.map(descriptor => [descriptor.envVar, descriptor]));

export function getConfigDescriptorByKey(key: string): ConfigDescriptor | undefined {
  return REGISTRY_BY_KEY.get(key);
}

export function getConfigDescriptorByEnvVar(envVar: string): ConfigDescriptor | undefined {
  return REGISTRY_BY_ENV_VAR.get(envVar);
}

export function getConfig(): AppConfig {
  const persisted = getPersistedConfig();
  const ctx: ResolveContext = { persisted, resolved: {} };

  for (const descriptor of CONFIG_REGISTRY) {
    ctx.resolved[descriptor.resolvedField] = descriptor.resolve(ctx) as never;
  }

  const config = ctx.resolved as AppConfig;
  config.dbPathConfigured = getEnvValue("AGENTCHATBUS_DB") !== undefined;
  return config;
}

export function getVisibleConfigDescriptors(): ConfigDescriptor[] {
  return CONFIG_REGISTRY.filter((descriptor): descriptor is ConfigDescriptor => descriptor.scope !== "hidden");
}

export function getConfigDict(): Record<string, unknown> {
  const config = getConfig();
  const entries = getVisibleConfigDescriptors()
    .map(descriptor => [descriptor.key, config[descriptor.resolvedField]])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));

  return Object.fromEntries(entries);
}

function coerceUpdateValue(descriptor: ConfigDescriptor, value: unknown): unknown {
  switch (descriptor.type) {
    case "boolean":
      if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
        try {
          return parseStrictBoolean(value);
        } catch {
          throw new Error(`${descriptor.key} must be a boolean`);
        }
      }
      throw new Error(`${descriptor.key} must be a boolean`);
    case "integer": {
      const parsed = parseIntegerLike(value, Number.NaN);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${descriptor.key} must be an integer`);
      }
      if (descriptor.min !== undefined && parsed < descriptor.min) {
        throw new Error(`${descriptor.key} must be >= ${descriptor.min}`);
      }
      if (descriptor.max !== undefined && parsed > descriptor.max) {
        throw new Error(`${descriptor.key} must be <= ${descriptor.max}`);
      }
      return parsed;
    }
    case "number": {
      const parsed = parseNumberLike(value, Number.NaN);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${descriptor.key} must be a number`);
      }
      if (descriptor.min !== undefined && parsed < descriptor.min) {
        throw new Error(`${descriptor.key} must be >= ${descriptor.min}`);
      }
      if (descriptor.max !== undefined && parsed > descriptor.max) {
        throw new Error(`${descriptor.key} must be <= ${descriptor.max}`);
      }
      return parsed;
    }
    case "string": {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`${descriptor.key} must be a string`);
      }
      const parsed = String(value).trim();
      if (descriptor.kind !== "path" && parsed.length === 0) {
        throw new Error(`${descriptor.key} must not be empty`);
      }
      return parsed;
    }
    case "string[]": {
      if (!Array.isArray(value) && typeof value !== "string") {
        throw new Error(`${descriptor.key} must be a list or comma-separated string`);
      }
      return parseStringList(value);
    }
    case "enum": {
      const parsed = String(value);
      if (!descriptor.options?.some(option => option.value === parsed)) {
        throw new Error(`${descriptor.key} must be one of: ${descriptor.options?.map(option => option.value).join(", ")}`);
      }
      return parsed;
    }
    default:
      return value;
  }
}

export class ConfigValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "ConfigValidationError";
    this.errors = errors;
  }
}

export function preparePersistedConfigUpdate(newData: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const update: Record<string, unknown> = {};

  for (const descriptor of CONFIG_REGISTRY) {
    if (descriptor.scope !== "editable" || !descriptor.persistedKey) {
      continue;
    }
    if (!(descriptor.key in newData)) {
      continue;
    }
    const nextValue = newData[descriptor.key];
    if (nextValue === undefined || nextValue === null) {
      continue;
    }
    try {
      update[descriptor.persistedKey] = coerceUpdateValue(descriptor, nextValue);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Invalid value for ${descriptor.key}`);
    }
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  return update;
}

export function saveConfigDict(newData: Record<string, unknown>): void {
  const current = getPersistedConfig();
  const update = preparePersistedConfigUpdate(newData);
  const merged = { ...current, ...update };

  if ("SHOW_AD" in merged) {
    delete merged.SHOW_AD;
  }

  const configFile = getPersistedConfigFilePath();
  try {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    // Ignore write errors to match current behavior.
  }
}

function addFieldToSection(
  sections: Map<ConfigSectionId, SettingsManifestSection>,
  sectionId: ConfigSectionId,
  field: SettingsManifestField
): void {
  const meta = SECTION_META[sectionId];
  if (!sections.has(sectionId)) {
    sections.set(sectionId, {
      id: meta.id,
      nav_label: meta.navLabel,
      title: meta.title,
      order: meta.order,
      fields: [],
    });
  }
  sections.get(sectionId)!.fields.push(field);
}

export function getSettingsManifest(): SettingsManifest {
  const persisted = getPersistedConfig();
  const config = getConfig();
  const ctx: ResolveContext = { persisted, resolved: config };
  const sections = new Map<ConfigSectionId, SettingsManifestSection>();

  for (const descriptor of getVisibleConfigDescriptors()) {
    addFieldToSection(
      sections,
      descriptor.section,
      buildVisibleField(descriptor, config[descriptor.resolvedField], ctx)
    );
  }

  for (const diagnostic of DIAGNOSTIC_FIELDS) {
    addFieldToSection(sections, "diagnostics", {
      key: diagnostic.key,
      source: "diagnostic",
      value_source: "derived",
      label: diagnostic.label,
      input_id: makeInputId(diagnostic.key),
      type: diagnostic.type,
      kind: diagnostic.kind,
      description: diagnostic.description,
      section: "diagnostics",
      scope: "readonly",
      sensitivity: diagnostic.sensitivity,
      restart_required: false,
      value: diagnostic.value(config),
      editable: false,
    });
  }

  const orderedSections = [...sections.values()]
    .map(section => ({
      ...section,
      fields: section.fields.sort((left, right) => {
        const leftDescriptor = getConfigDescriptorByKey(left.key);
        const rightDescriptor = getConfigDescriptorByKey(right.key);
        const leftOrder = leftDescriptor?.order ?? DIAGNOSTIC_FIELDS.find(field => field.key === left.key)?.order ?? 9999;
        const rightOrder = rightDescriptor?.order ?? DIAGNOSTIC_FIELDS.find(field => field.key === right.key)?.order ?? 9999;
        return leftOrder - rightOrder;
      }),
    }))
    .sort((left, right) => left.order - right.order);

  return {
    schema_version: SETTINGS_MANIFEST_SCHEMA_VERSION,
    save_message: "Settings saved. Restart the server to apply changes.",
    sections: orderedSections,
  };
}
