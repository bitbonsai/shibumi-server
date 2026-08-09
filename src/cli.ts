#!/usr/bin/env bun

import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseCliArgs, usageText } from "./cli-args";
import { loadConfig, validateSecrets } from "./config";
import { addApp, initializeInstallation, installationPaths } from "./install";
import { WebhookService } from "./server";

function requireLinux(): void {
  if (process.platform !== "linux") throw new Error("init and add require Linux with a systemd user session");
}

async function serve(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  validateSecrets(config);

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
}

try {
  const command = parseCliArgs(process.argv.slice(2));

  if (command.name === "help") {
    console.log(usageText);
  } else if (command.name === "init") {
    requireLinux();
    const result = await initializeInstallation({
      home: homedir(),
      packageRoot: resolve(import.meta.dir, ".."),
      bunExecutable: process.execPath,
    });
    console.log(`Installed shibumi-server ${result.version} at ${result.paths.currentRelease}.`);
    console.log("The service is installed but will not start until an app is added.");
  } else if (command.name === "add") {
    requireLinux();
    const result = await addApp({ home: homedir(), ...command });
    const paths = installationPaths(homedir());
    console.log(`Added ${result.appId} and restarted shibumi-server.`);
    console.log(`Webhook URL: https://${command.domain}/hooks/github/${result.appId}`);
    console.log(`Webhook secret: ${result.secretEnvironmentVariable} in ${paths.secrets}`);
    console.log(`Caddy upstream: 127.0.0.1:${command.hostPort}`);
    console.log("Add the webhook route to Caddy before the app's normal handler; Caddy and GitHub are not modified automatically.");
  } else {
    const config = await loadConfig(command.config);
    validateSecrets(config);
    if (command.name === "check") {
      console.log(`Configuration is valid for ${Object.keys(config.apps).length} app(s).`);
    } else {
      await serve(command.config);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (!(error instanceof Error) || !error.message.includes("Usage:")) console.error(`\n${usageText}`);
  process.exit(1);
}
