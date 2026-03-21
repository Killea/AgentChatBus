#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionRoot, "..");

const extensionPackagePath = path.join(extensionRoot, "package.json");
const extensionPackageLockPath = path.join(extensionRoot, "package-lock.json");
const tsPackagePath = path.join(repoRoot, "agentchatbus-ts", "package.json");
const tsPackageLockPath = path.join(repoRoot, "agentchatbus-ts", "package-lock.json");
const tsEnvPath = path.join(repoRoot, "agentchatbus-ts", "src", "core", "config", "env.ts");
const pyprojectPath = path.join(repoRoot, "pyproject.toml");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function syncPackageLockVersion(filePath, version) {
  const lockfile = readJson(filePath);
  lockfile.version = version;
  if (lockfile.packages && lockfile.packages[""]) {
    lockfile.packages[""].version = version;
  }
  writeJson(filePath, lockfile);
}

function syncTsEnvVersion(filePath, version) {
  const source = readFileSync(filePath, "utf8");
  const pattern = /export const BUS_VERSION = "([^"]+)";/;
  if (!pattern.test(source)) {
    throw new Error(`Could not find BUS_VERSION constant in ${filePath}`);
  }
  const updated = source.replace(pattern, `export const BUS_VERSION = "${version}";`);
  writeFileSync(filePath, updated, "utf8");
}

function syncPyprojectVersion(filePath, version) {
  const source = readFileSync(filePath, "utf8");
  const pattern = /^version = "([^"]+)"$/m;
  if (!pattern.test(source)) {
    throw new Error(`Could not find project version in ${filePath}`);
  }
  const updated = source.replace(pattern, `version = "${version}"`);
  writeFileSync(filePath, updated, "utf8");
}

function main() {
  const extensionPkg = readJson(extensionPackagePath);
  const version = String(extensionPkg.version || "").trim();
  if (!version) {
    throw new Error(`Extension version is missing in ${extensionPackagePath}`);
  }

  syncPackageLockVersion(extensionPackageLockPath, version);

  const tsPkg = readJson(tsPackagePath);
  tsPkg.version = version;
  writeJson(tsPackagePath, tsPkg);
  syncPackageLockVersion(tsPackageLockPath, version);

  syncTsEnvVersion(tsEnvPath, version);
  syncPyprojectVersion(pyprojectPath, version);

  console.log(`[sync-versions] extension=${version}`);
  console.log(`[sync-versions] updated ${extensionPackageLockPath}`);
  console.log(`[sync-versions] updated ${tsPackagePath}`);
  console.log(`[sync-versions] updated ${tsPackageLockPath}`);
  console.log(`[sync-versions] updated ${tsEnvPath}`);
  console.log(`[sync-versions] updated ${pyprojectPath}`);
}

main();
