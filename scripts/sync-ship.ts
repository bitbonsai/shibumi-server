// Syncs this project's vendored Ship client from the published immutable
// snapshot, the same mechanism create-shibumi uses for its template copy.
// The lock file records the exact URL and sha256; this script refuses to
// write anything that does not match. To upgrade Ship: update the lock to
// the new immutable vN.ts URL and checksum, run this script, review the
// diff, and re-run `bun run test` (the drift test enforces the lock).
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const LOCK_PATH = join(ROOT, "scripts", "ship.lock.json");
const TARGET = join(ROOT, "scripts", "ship.ts");

const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { url: string; sha256: string };

if (!/^https:\/\/shibumistack\.dev\/ship\/v\d+\.ts$/.test(lock.url)) {
  console.error(`Refusing non-immutable ship URL: ${lock.url}`);
  process.exit(1);
}

const response = await fetch(lock.url, { headers: { accept: "text/plain" } });
if (!response.ok) {
  console.error(`Fetch failed: ${response.status} ${lock.url}`);
  process.exit(1);
}
const body = await response.text();
const sha256 = createHash("sha256").update(body).digest("hex");
if (sha256 !== lock.sha256) {
  console.error(`Checksum mismatch for ${lock.url}\n  expected ${lock.sha256}\n  got      ${sha256}`);
  process.exit(1);
}

writeFileSync(TARGET, body);
console.log(`scripts/ship.ts synced from ${lock.url} (${sha256.slice(0, 12)}…)`);