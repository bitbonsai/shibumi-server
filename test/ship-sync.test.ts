// The vendored Ship client is byte-locked to a published immutable snapshot
// (scripts/ship.lock.json). Anything that replaces or edits scripts/ship.ts
// without bumping the lock first fails here, so CI catches drift instead of
// an orphaned client. Sync with: bun run sync:ship.
import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const lock = JSON.parse(readFileSync(join(ROOT, "scripts", "ship.lock.json"), "utf8")) as {
  url: string;
  sha256: string;
};
const vendored = readFileSync(join(ROOT, "scripts", "ship.ts"), "utf8");

describe("vendored Ship client", () => {
  test("is byte-identical to the locked immutable snapshot", () => {
    const sha256 = createHash("sha256").update(vendored).digest("hex");
    expect(sha256).toBe(lock.sha256);
  });

  test("locks an immutable versioned URL", () => {
    expect(lock.url).toMatch(/^https:\/\/shibumistack\.dev\/ship\/v\d+\.ts$/);
  });

  test("self-references the same immutable version it was locked to", () => {
    const match = /const CURRENT_SOURCE = "(https:\/\/shibumistack\.dev\/ship\/v\d+\.ts)";/.exec(vendored);
    expect(match?.[1]).toBe(lock.url);
  });
});