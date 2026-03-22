/**
 * Main module - ported from src/main.py
 */
import { createHash } from "node:crypto";

const AGENT_EMOJIS = ['🤖', '🧠', '⚡', '💡', '🔧', '🎯', '📊', '🚀'];

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
