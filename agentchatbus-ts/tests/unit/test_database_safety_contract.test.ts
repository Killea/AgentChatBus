import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PROD_DB_LITERALS = [
  "data/bus.db",
  "data\\bus.db",
  ".agentchatbus/bus.db",
  ".agentchatbus\\bus.db",
];

const AGENTCHATBUS_DB_ASSIGN_RE = /process\.env\[['\"]AGENTCHATBUS_DB['\"]\]\s*=\s*['\"]([^'\"]+)['\"]/g;

function readText(filePath: string): string {
  return readFileSync(filePath, { encoding: "utf8" });
}

function isTestScopedDb(value: string): boolean {
  if (value === ":memory:") return true;
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const name = path.basename(value).toLowerCase();
  return name.includes("test") || normalized.includes("/tests/") || normalized.includes("/test");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch (error: any) {
      // Handle concurrent filesystem changes (e.g. sqlite -journal files removed between readdir/stat)
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}


describe("database safety contract (TS parity)", () => {
  const testsRoot = path.resolve(__dirname, "..");

  it("test files must not hardcode production database paths", () => {
    const offending: Array<{ file: string; literals: string[] }> = [];

    for (const file of walk(testsRoot)) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      // Skip this test file itself (it contains the literals for testing)
      if (file.includes("test_database_safety_contract")) continue;
      const text = readText(file).toLowerCase();
      const hits = PROD_DB_LITERALS.filter((literal) => text.includes(literal.toLowerCase()));
      if (hits.length > 0) {
        offending.push({ file, literals: hits });
      }
    }

    expect(offending, JSON.stringify(offending, null, 2)).toHaveLength(0);
  });

  it("AGENTCHATBUS_DB assignments in tests must point to test-scoped DBs", () => {
    const badAssignments: Array<{ file: string; value: string }> = [];

    for (const file of walk(testsRoot)) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const text = readText(file);
      let match: RegExpExecArray | null;
      while ((match = AGENTCHATBUS_DB_ASSIGN_RE.exec(text)) !== null) {
        const value = match[1];
        if (!isTestScopedDb(value)) {
          badAssignments.push({ file, value });
        }
      }
    }

    expect(badAssignments, JSON.stringify(badAssignments, null, 2)).toHaveLength(0);
  });

  it("runtime AGENTCHATBUS_DB must be set to a test database", () => {
    if (!process.env.AGENTCHATBUS_DB) {
      // Align with Python guardrail: ensure tests run against a non-production DB.
      process.env.AGENTCHATBUS_DB = ":memory:";
    }
    const value = process.env.AGENTCHATBUS_DB ?? "";
    const normalized = value.replace(/\\/g, "/").toLowerCase();
    const homeProd = path.join(os.homedir(), ".agentchatbus", "bus.db").replace(/\\/g, "/").toLowerCase();

    expect(normalized).not.toBe("data/bus.db");
    expect(normalized).not.toBe(homeProd);
    expect(isTestScopedDb(value)).toBe(true);
  });
});
