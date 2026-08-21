declare module "xpipe" {
  /**
   * Cross-platform IPC path equalizer.
   * On Unix: returns the path unchanged.
   * On Windows: rewrites a filesystem path to a named pipe path (\\.\pipe\...).
   */
  export function eq(path: string): string;

  /** The platform-specific prefix (empty string on Unix, "//./pipe/" on Windows). */
  export const prefix: string;
}
