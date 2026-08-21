#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (process.env.npm_config_dry_run === "true") {
  console.log("Dry run: website version sync skipped.");
  process.exit(0);
}

const website = resolve(import.meta.dir, "..", "..", "shibumistack.dev");
const { version } = await import("../package.json");
if (!existsSync(resolve(website, "scripts", "sync-server-version.ts"))) {
  console.log("Website checkout not found. Run `bun run sync:server` in shibumistack.dev after publish.");
  process.exit(0);
}

for (let attempt = 1; attempt <= 8; attempt += 1) {
  const sync = Bun.spawnSync([process.execPath, "run", "sync:server", version], { cwd: website, stdout: "inherit", stderr: "inherit" });
  if (sync.exitCode === 0) {
    console.log("Website pin synced. Review, commit, and deploy shibumistack.dev.");
    process.exit(0);
  }
  if (attempt < 8) await Bun.sleep(attempt * 2_000);
}

throw new Error("website version sync failed after npm propagation wait");
