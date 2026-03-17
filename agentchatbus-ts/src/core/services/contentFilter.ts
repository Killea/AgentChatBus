/**
 * AgentChatBus Content Filter
 *
 * Blocks messages containing known secret patterns (API keys, tokens, private keys)
 * before they are persisted to the database.
 *
 * All patterns are configurable via AGENTCHATBUS_CONTENT_FILTER_ENABLED env var.
 * Detection is regex-based and conservative: only high-confidence patterns are blocked
 * to avoid false positives in technical conversations.
 *
 * Ported from Python: src/content_filter.py
 */

/**
 * Secret pattern definition: [regex, label]
 */
type SecretPattern = [RegExp, string];

/**
 * Known secret patterns to block.
 * Each pattern is a tuple of [RegExp, descriptive label].
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  [/AKIA[0-9A-Z]{16}/, "AWS Access Key ID"],
  [/ASIA[0-9A-Z]{16}/, "AWS Temporary Access Key"],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}/, "JWT Token"],
  [/ghp_[A-Za-z0-9]{36}/, "GitHub Personal Access Token"],
  [/gho_[A-Za-z0-9]{36}/, "GitHub OAuth Token"],
  [/ghs_[A-Za-z0-9]{36}/, "GitHub App Token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "Private Key"],
  [/sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/, "OpenAI API Key"],
  [/xox[bprs]-[0-9A-Za-z\-]{10,}/, "Slack Token"],
  [/AIza[0-9A-Za-z\-_]{35}/, "Google API Key"],
  [/[Aa][Zz][Uu][Rr][Ee][A-Za-z0-9_]{10,}=[A-Za-z0-9+/]{43}=/, "Azure Storage Key"],
];

/**
 * Error thrown when a message is blocked by the content filter.
 */
export class ContentFilterError extends Error {
  public readonly patternName: string;

  constructor(patternName: string) {
    super(`Content blocked: detected ${patternName}`);
    this.name = "ContentFilterError";
    this.patternName = patternName;
  }
}

/**
 * Check if content filter is enabled.
 * Defaults to true, can be disabled via AGENTCHATBUS_CONTENT_FILTER_ENABLED=false
 */
export function isContentFilterEnabled(): boolean {
  const envValue = process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED;
  if (envValue === undefined) {
    return true; // Enabled by default
  }
  return envValue.toLowerCase() !== "false";
}

/**
 * Scan text for known secret patterns.
 *
 * @param text - The text to scan
 * @returns Tuple of [blocked, patternLabel]. blocked=true if a secret pattern is detected.
 */
export function checkContent(text: string): [boolean, string | null] {
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return [true, label];
    }
  }
  return [false, null];
}

/**
 * Check content and throw ContentFilterError if blocked.
 * Respects AGENTCHATBUS_CONTENT_FILTER_ENABLED env var.
 *
 * @param text - The text to check
 * @throws ContentFilterError if a secret pattern is detected and filter is enabled
 */
export function checkContentOrThrow(text: string): void {
  if (!isContentFilterEnabled()) {
    return;
  }

  const [blocked, patternName] = checkContent(text);
  if (blocked && patternName) {
    throw new ContentFilterError(patternName);
  }
}
