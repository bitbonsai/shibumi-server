#!/usr/bin/env bun

import { loadConfig, validateSecrets } from "./config";
import { WebhookService } from "./server";

function usage(): never {
  console.error(`Usage:
  shibumi-server check --config <path>
  shibumi-server serve --config <path>`);
  process.exit(1);
}

function configPath(args: string[]): string {
  const index = args.indexOf("--config");
  if (index === -1 || !args[index + 1]) usage();
  return args[index + 1];
}

const [command, ...args] = process.argv.slice(2);
if (command !== "check" && command !== "serve") usage();

try {
  const config = await loadConfig(configPath(args));
  validateSecrets(config);

  if (command === "check") {
    console.log(`Configuration is valid for ${Object.keys(config.apps).length} app(s).`);
    process.exit(0);
  }

  const service = new WebhookService(config);
  const server = Bun.serve({
    hostname: config.listen.hostname,
    port: config.listen.port,
    fetch: (request) => service.handle(request),
  });

  console.log(`shibumi-server listening on ${server.hostname}:${server.port}`);
  const shutdown = async () => {
    console.log("shibumi-server stopping");
    server.stop(false);
    await service.waitForIdle();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
