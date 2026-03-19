/**
 * AgentChatBus Filesystem Disclosure Filter (SEC-06)
 *
 * Blocks messages containing filesystem directory listings or file dumps
 * when SHOW_AD=true (public demo mode).
 *
 * This filter is SHOW_AD-conditional — it does not run on private/localhost
 * deployments. The existing secret-pattern content filter (contentFilter.ts)
 * is always-on and handles a separate concern (API keys, tokens).
 *
 * Design: conservative. False positives (blocking legitimate messages) are
 * worse than false negatives in a technical community. Only structured/bulk
 * filesystem output is blocked, not casual path mentions.
 */

/** Result of a filesystem disclosure check. */
export interface FilesystemDisclosureResult {
  blocked: boolean;
  reason: string | null;
}

// ─── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Unix-style directory tree connector characters (output of `tree`, `eza`, etc.)
 * Matches lines like:  ├── src/  │   └── main.ts
 */
const TREE_CONNECTOR_RE = /[├└│]/;

/**
 * Unix `ls -la` style lines: permissions block at start.
 * Matches: drwxr-xr-x, -rw-r--r--, lrwxrwxrwx, etc.
 */
const LS_LA_LINE_RE = /^[dlrwxtTsS\-]{9,10}\s+\d+\s+\S+/m;

/**
 * `ls -la` summary header: "total NNN"
 */
const LS_TOTAL_RE = /^total\s+\d+$/m;

/**
 * Windows `dir` / PowerShell listing header or entry.
 * Matches lines with:  Mode  LastWriteTime  Length  Name
 * or                   d----  03/19/2026  14:00  folder
 * or                   -a---  03/19/2026  14:00  12345  file.txt
 */
const WINDOWS_DIR_LINE_RE = /^([d\-][a-rhs\-]{4})\s+\d{2}\/\d{2}\/\d{4}/m;

/**
 * Windows PowerShell `dir` column header line.
 */
const WINDOWS_DIR_HEADER_RE = /Mode\s+LastWriteTime\s+(Length\s+)?Name/i;

/**
 * Absolute Unix path: starts with / followed by at least one path segment.
 * Intentionally requires at least 2 segments to avoid matching bare `/`.
 */
const UNIX_ABS_PATH_RE = /^\/[a-zA-Z0-9_\-.]+(?:\/[a-zA-Z0-9_\-. ]*)+\s*$/;

/**
 * Absolute Windows path: drive letter + colon + backslash.
 */
const WIN_ABS_PATH_RE = /^[A-Za-z]:\\(?:[^\\\n]+\\)*[^\\\n]*\s*$/;

/**
 * /etc/passwd line format: username:x:uid:gid:...
 * Detects dumped passwd file content (6+ colon-separated fields).
 */
const PASSWD_LINE_RE = /^[a-zA-Z_][a-zA-Z0-9_\-]*:[x*]:?\d+:\d+:/m;

/**
 * SSH private/public key headers — already covered by contentFilter for private
 * keys, but we also guard public key files and authorized_keys.
 */
const SSH_AUTH_KEYS_RE = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+)\s+AAAA/m;

/** Minimum number of consecutive path-only lines to trigger "dense path cluster" blocking. */
const DENSE_PATH_THRESHOLD = 3;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether `text` contains filesystem disclosure patterns.
 *
 * Returns a result object with `blocked: true` and a descriptive `reason`
 * when a pattern fires. Returns `{ blocked: false, reason: null }` otherwise.
 *
 * This function is pure and has no side effects.
 */
export function checkFilesystemDisclosure(text: string): FilesystemDisclosureResult {
  // 1. Unix tree connector characters (multi-line structural output)
  const lines = text.split("\n");
  const treeLines = lines.filter((l) => TREE_CONNECTOR_RE.test(l));
  if (treeLines.length >= 2) {
    return { blocked: true, reason: "Directory tree output (├── / └── characters)" };
  }

  // 2. ls -la style output: permissions block + total header together
  if (LS_LA_LINE_RE.test(text) && LS_TOTAL_RE.test(text)) {
    return { blocked: true, reason: "Unix directory listing (ls -la output)" };
  }

  // 3. Windows dir listing: column header or multiple dir entry lines
  if (WINDOWS_DIR_HEADER_RE.test(text)) {
    return { blocked: true, reason: "Windows directory listing header (dir/Get-ChildItem output)" };
  }
  const winDirLines = lines.filter((l) => WINDOWS_DIR_LINE_RE.test(l));
  if (winDirLines.length >= 2) {
    return { blocked: true, reason: "Windows directory listing entries (dir/Get-ChildItem output)" };
  }

  // 4. Dense path cluster: ≥ DENSE_PATH_THRESHOLD consecutive path-only lines
  let consecutivePaths = 0;
  let maxConsecutivePaths = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      consecutivePaths = 0;
      continue;
    }
    if (UNIX_ABS_PATH_RE.test(trimmed) || WIN_ABS_PATH_RE.test(trimmed)) {
      consecutivePaths++;
      maxConsecutivePaths = Math.max(maxConsecutivePaths, consecutivePaths);
    } else {
      consecutivePaths = 0;
    }
  }
  if (maxConsecutivePaths >= DENSE_PATH_THRESHOLD) {
    return {
      blocked: true,
      reason: `Dense filesystem path cluster (${maxConsecutivePaths} consecutive path lines)`,
    };
  }

  // 5. /etc/passwd content dump
  if (PASSWD_LINE_RE.test(text)) {
    return { blocked: true, reason: "Sensitive file content (/etc/passwd format)" };
  }

  // 6. SSH authorized_keys / public key dump
  if (SSH_AUTH_KEYS_RE.test(text)) {
    return { blocked: true, reason: "SSH public key or authorized_keys content" };
  }

  return { blocked: false, reason: null };
}

/**
 * Check whether the filesystem disclosure filter is active.
 * Active when AGENTCHATBUS_SHOW_AD=true (public demo mode).
 */
export function isFilesystemDisclosureFilterActive(): boolean {
  const showAd = process.env.AGENTCHATBUS_SHOW_AD;
  if (!showAd) return false;
  return ["1", "true", "yes"].includes(showAd.trim().toLowerCase());
}

/**
 * Check content and throw FilesystemDisclosureError if blocked.
 * No-op when SHOW_AD is not set or false.
 *
 * @throws FilesystemDisclosureError when disclosure is detected and filter is active.
 */
export function checkFilesystemDisclosureOrThrow(text: string): void {
  if (!isFilesystemDisclosureFilterActive()) return;

  const result = checkFilesystemDisclosure(text);
  if (result.blocked && result.reason) {
    throw new FilesystemDisclosureError(result.reason);
  }
}

/**
 * Error thrown when a message is blocked by the filesystem disclosure filter.
 */
export class FilesystemDisclosureError extends Error {
  public readonly disclosureReason: string;

  constructor(disclosureReason: string) {
    super(
      `Content blocked in demo mode: ${disclosureReason}. ` +
        "Filesystem listings and path dumps are not allowed on public instances."
    );
    this.name = "FilesystemDisclosureError";
    this.disclosureReason = disclosureReason;
  }
}
