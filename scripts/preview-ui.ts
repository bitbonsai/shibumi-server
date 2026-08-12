#!/usr/bin/env bun

import { cancel, intro, isCancel, log, outro, select, text } from "@clack/prompts";
import { brand } from "../src/terminal-ui";

function cancelled(value: unknown): value is symbol {
  if (!isCancel(value)) return false;
  cancel("Preview cancelled.");
  return true;
}

intro(brand());
log.success("DNS detected (cloudflare)");

const repository = await text({
  message: "Where's the repository?",
  initialValue: "https://github.com/bitbonsai/vibetoolbox",
});
if (cancelled(repository)) process.exit(0);

const checkout = await text({
  message: "Where should deployments live?",
  initialValue: "/home/mwolff/shibumi/vibetoolbox-dev",
});
if (cancelled(checkout)) process.exit(0);

log.info("Health path /healthz (default)");
const configuration = await select({
  message: "Domain configuration",
  initialValue: "recommended",
  options: [
    { value: "recommended", label: "Recommended defaults", hint: "zstd + gzip, indexing allowed, safe headers, rotated logs" },
    { value: "custom", label: "Customize…" },
  ],
});
if (cancelled(configuration)) process.exit(0);

outro("UI preview complete. No system changes made.");
