/**
 * Main module - ported from src/main.py
 */
import { createHash } from "node:crypto";

// Keep this pool aligned with the original Python implementation in src/main.py.
// The deterministic hash mapping and the Web UI launch picker both rely on this
// larger set so avatars stay varied and stable across transports.
export const AGENT_EMOJIS = [
  // animals
  "🦊", "🐼", "🐸", "🐙", "🦄", "🐯", "🦁", "🐵", "🐧", "🐢",
  "🦉", "🐳", "🐝", "🦋", "🪲", "🦀", "🐞", "🦎", "🐊", "🐠",
  "🐬", "🦖", "🦒", "🦓", "🦔", "🦦", "🦥", "🦩", "🐘", "🦛",
  "🐨", "🐹", "🐰", "🐮", "🐷", "🐔",
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

export const AGENT_EMOJI_LABELS = [
  "Fox", "Owl", "Cat", "Dog", "Panda", "Koala", "Eagle", "Octopus", "Whale", "Turtle",
  "Wolf", "Dolphin", "Tiger", "Rabbit", "Ant", "Beaver", "Cow", "Camel", "Mouse", "Horse",
  "Penguin", "Robot", "Hamster", "Chick", "Rooster", "Snake", "Elephant", "Gorilla", "Monkey", "Unicorn",
  "Boar", "Lobster", "Fish", "Squid", "Seal", "Otter",
  "Blossom", "Leaf", "Maple", "Tulip", "Cactus", "Herb", "Mushroom",
  "Apple", "Orange", "Pear", "Peach", "Bread", "Grapes", "Lemon", "Watermelon", "Taco", "Cake",
  "Cookie", "Candy",
  "Bolt", "Flame", "Bulb", "Telescope", "Vial", "Helix", "Compass", "Orbit", "Satellite", "Antenna",
  "Wrench", "Tools", "Toolbox", "Magnet", "Extinguisher", "Lock", "Key", "Pin", "Clip", "Books",
  "Map", "Brain",
  "Target", "Puzzle", "Dice", "Chess", "Guitar", "Headphones", "Sax",
  "Bike", "Canoe", "Surf", "Luggage", "Vase", "Kite", "Wand", "Thread", "Yarn", "Coin", "OldKey",
];

// Unicode Emoji_Presentation property — covers the practical emoji range callers
// are expected to use (single codepoints, optional VS-16, optional ZWJ sequences).
const EMOJI_RE = /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*$/u;

/**
 * Validate and normalize an explicit emoji value.
 * Returns the trimmed emoji if valid, or `null` if the input is blank/invalid.
 * Keeps the contract narrow: only true emoji sequences are accepted so avatar
 * rendering surfaces (badges, minimap, tooltips) stay consistent.
 */
export function validateEmoji(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!EMOJI_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * 移植自：src/main.py::_agent_emoji (L132-140)
 * 生成确定性的 agent emoji，基于 agent_id 的 hash
 */
export function generateAgentEmoji(agentId: string | null): string {
  if (!agentId) {
    return '❔';
  }
  
  // 对应 Python: L135 - normalized = str(agent_id).strip().lower()
  const normalized = String(agentId).trim().toLowerCase();
  
  if (!normalized) {
    return '❔';
  }
  
  // Match Python behavior with deterministic SHA-256 based index.
  const digest = createHash("sha256").update(normalized, "utf8").digest();
  const hash64 = digest.readBigUInt64BE(0);
  const idx = Number(hash64 % BigInt(AGENT_EMOJIS.length));
  return AGENT_EMOJIS[idx];
}

function normalizeEmojiSeed(raw: string | null | undefined): string {
  return String(raw || "").trim().toLowerCase();
}

function buildEmojiIndex(seed: string): number {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const hash64 = digest.readBigUInt64BE(0);
  return Number(hash64 % BigInt(AGENT_EMOJIS.length));
}

function toTitleToken(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === "vscode") return "VSCode";
  if (lower === "gpt") return "GPT";
  if (lower === "ui") return "UI";
  if (lower === "api") return "API";
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

export function prettifyRuntimeLabel(raw: string | null | undefined): string {
  const normalized = String(raw || "").trim();
  if (!normalized) return "";

  const lowered = normalized.toLowerCase();
  const keywordMappings: Array<[string, string]> = [
    ["codex", "Codex"],
    ["cursor", "Cursor"],
    ["claude", "Claude"],
    ["gemini", "Gemini"],
    ["copilot", "Copilot"],
    ["vscode", "VSCode"],
    ["vs code", "VSCode"],
    ["browser", "Browser"],
    ["cli", "CLI"],
  ];
  for (const [needle, label] of keywordMappings) {
    if (lowered.includes(needle)) {
      return label;
    }
  }

  return normalized
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(toTitleToken)
    .join(" ");
}

export function resolveAutoAgentDisplayBase(input: {
  ide?: string | null;
  model?: string | null;
}): string {
  const ide = prettifyRuntimeLabel(input.ide);
  const model = prettifyRuntimeLabel(input.model);
  const genericLabels = new Set(["CLI", "Browser", "Unknown Ide"]);

  if (["Codex", "Cursor", "Claude", "Gemini", "Copilot"].includes(model)) {
    return model;
  }
  if (ide && !genericLabels.has(ide)) {
    return ide;
  }
  if (model) {
    return model;
  }
  if (ide) {
    return ide;
  }
  return "Agent";
}

export function buildLegacyAutoAgentDisplayNameCandidates(input: {
  ide?: string | null;
  model?: string | null;
}): string[] {
  const ideRaw = String(input.ide || "").trim();
  const modelRaw = String(input.model || "").trim();
  const idePretty = prettifyRuntimeLabel(input.ide);
  const modelPretty = prettifyRuntimeLabel(input.model);
  const base = resolveAutoAgentDisplayBase(input);
  const candidates = new Set(
    [
      base,
      ideRaw,
      idePretty,
      modelRaw,
      modelPretty,
      `${base} ${modelRaw}`.trim(),
      `${base} ${modelPretty}`.trim(),
      `${idePretty} ${modelPretty}`.trim(),
      `${ideRaw} ${modelRaw}`.trim(),
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  return Array.from(candidates);
}

export function deriveAgentEmojiSeed(input: {
  ide?: string | null;
  model?: string | null;
  display_name?: string | null;
  alias_source?: string | null;
}): string {
  const aliasSource = normalizeEmojiSeed(input.alias_source);
  const displayName = String(input.display_name || "").trim();
  if (aliasSource === "user" && displayName) {
    return normalizeEmojiSeed(`display:${displayName}`);
  }

  const ide = String(input.ide || "").trim();
  const model = String(input.model || "").trim();
  if (ide || model) {
    return normalizeEmojiSeed(`runtime:${ide}|${model}`);
  }

  if (displayName) {
    return normalizeEmojiSeed(`display:${displayName}`);
  }

  return "";
}

export function generateAgentEmojiCandidates(seed: string | null | undefined): string[] {
  const normalized = normalizeEmojiSeed(seed);
  if (!normalized) {
    return ["❔"];
  }

  const start = buildEmojiIndex(normalized);
  const ordered: string[] = [];
  for (let offset = 0; offset < AGENT_EMOJIS.length; offset += 1) {
    ordered.push(AGENT_EMOJIS[(start + offset) % AGENT_EMOJIS.length]);
  }
  return ordered;
}

export function describeAgentEmoji(emoji: string | null | undefined): string {
  const normalized = String(emoji || "").trim();
  const index = AGENT_EMOJIS.indexOf(normalized);
  if (index < 0) {
    return "Agent";
  }
  return AGENT_EMOJI_LABELS[index] || "Agent";
}

export function buildAutoAgentDisplayName(input: {
  ide?: string | null;
  model?: string | null;
  emoji?: string | null;
  existingDisplayNames?: Iterable<string>;
}): string {
  const base = resolveAutoAgentDisplayBase(input);
  const label = describeAgentEmoji(input.emoji);
  const baseName = `${base} ${label}`.trim();
  const normalizedBase = baseName.toLowerCase();
  const existing = new Set(
    Array.from(input.existingDisplayNames || [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );

  if (!existing.has(normalizedBase)) {
    return baseName;
  }

  let suffix = 2;
  while (existing.has(`${normalizedBase} ${suffix}`)) {
    suffix += 1;
  }
  return `${baseName} ${suffix}`;
}

export function resolvePreferredAgentDisplayName(input: {
  ide?: string | null;
  model?: string | null;
  emoji?: string | null;
  display_name?: string | null;
  name?: string | null;
  id?: string | null;
  existingDisplayNames?: Iterable<string>;
}): string {
  const configuredDisplayName = String(input.display_name || "").trim();
  const legacyFallback =
    configuredDisplayName
    || String(input.name || input.id || "").trim()
    || "Unknown";
  const hasEmoji = Boolean(String(input.emoji || "").trim());
  if (!hasEmoji) {
    return legacyFallback;
  }
  return buildAutoAgentDisplayName({
    ide: input.ide,
    model: input.model,
    emoji: input.emoji,
    existingDisplayNames: input.existingDisplayNames,
  });
}
