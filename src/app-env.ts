// Per-app environment store. `shis env set|list|rm <app-id>` manages a file at
// <config>/env/<app-id>.env; deploy injects its contents into the container
// through the compose override. Values arrive over stdin (never argv), so
// secrets stay out of the process list, and the file is written 0600.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KEY = /^[A-Z_][A-Z0-9_]*$/;
// Set by shibumi-server at deploy; composeOverride would silently drop a stored
// value, so reject at set time to keep operator intent and stored state aligned.
const RESERVED = new Set(["SHIBUMI_COMMIT", "SHIBUMI_DEPLOYED_AT"]);

export function appEnvPath(configDirectory: string, appId: string): string {
  return join(configDirectory, "env", `${appId}.env`);
}

export function isValidEnvKey(key: string): boolean {
  return KEY.test(key);
}

// Parses KEY=VALUE lines: ignores blanks and comments, trims, strips one layer
// of matching surrounding quotes. Malformed lines and bad keys are skipped.
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function serializeEnv(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  if (keys.length === 0) return "";
  return keys.map((key) => `${key}=${env[key]}`).join("\n") + "\n";
}

export function readAppEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

export function writeAppEnv(path: string, env: Record<string, string>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (Object.keys(env).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  // Temp-and-rename: a pre-existing file's looser mode would apply during the
  // write; the temp file is born 0600 and replaces the target atomically.
  const temp = `${path}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, serializeEnv(env), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

// Merges parsed stdin entries into the existing store. Rejects a value that
// would not round-trip (newlines) so the file stays a clean KEY=VALUE list.
export function mergeAppEnv(existing: Record<string, string>, incoming: Record<string, string>): Record<string, string> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (!KEY.test(key)) throw new Error(`invalid environment variable name: ${key}`);
    if (RESERVED.has(key)) throw new Error(`${key} is reserved (set by shibumi-server at deploy)`);
    if (/[\r\n]/.test(value)) throw new Error(`value for ${key} contains a newline`);
    merged[key] = value;
  }
  return merged;
}
