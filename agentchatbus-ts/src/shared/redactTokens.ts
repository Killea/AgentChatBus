export const redactTokens = (text: string): string =>
  text.replace(/(\\?"token\\?"\s*:\s*\\?")[^"\\]*/g, "$1[REDACTED]");
