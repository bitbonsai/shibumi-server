#!/usr/bin/env bun

import { homedir } from "node:os";
import { resolve } from "node:path";
import packageJson from "../package.json";
import { parseCliArgs, usageText } from "./cli-args";
import { loadConfig, validateSecrets } from "./config";
import { addApp, initializeInstallation, installationPaths, uninstallInstallation } from "./install";
import { WebhookService } from "./server";
import { warnIfUpdateAvailable } from "./update";

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
  if (command.name !== "serve" && process.env.SHIBUMI_SKIP_UPDATE_CHECK !== "1") {
    await warnIfUpdateAvailable(packageJson.version);
  }

  if (command.name === "help") {
    console.log(usageText);
  } else if (command.name === "version") {
    console.log(packageJson.version);
  } else if (command.name === "setup") {
    requireLinux();
    const { runInteractiveSetup } = await import("./setup");
    await runInteractiveSetup({
      home: homedir(),
      packageRoot: resolve(import.meta.dir, ".."),
      bunExecutable: process.execPath,
    });
  } else if (command.name === "init") {
    requireLinux();
    const result = await initializeInstallation({
      home: homedir(),
      packageRoot: resolve(import.meta.dir, ".."),
      bunExecutable: process.execPath,
    });
    console.log(`Installed shibumi-server ${result.version} at ${result.paths.currentRelease}.`);
    console.log("The service is installed but will not start until an app is added.");
  } else if (command.name === "uninstall") {
    requireLinux();
    if (command.purge && !command.yes) {
      const { confirmPurge } = await import("./setup");
      if (!await confirmPurge()) process.exit(0);
    }
    const paths = await uninstallInstallation(homedir(), command.purge);
    console.log("Removed shibumi-server service, launcher, and installed releases.");
    if (command.purge) console.log("Removed local config and webhook secrets.");
    else console.log(`Preserved config and secrets in ${paths.configDirectory}.`);
    console.log("App checkouts, containers, Caddy, and GitHub settings were not changed.");
  } else if (command.name === "add") {
    requireLinux();
    const { name: _, ...options } = command;
    if (options.repository && options.checkout && options.hostPort !== undefined) {
      const result = await addApp({
        home: homedir(),
        ...options,
        repository: options.repository,
        checkout: options.checkout,
        hostPort: options.hostPort,
      });
      const paths = installationPaths(homedir());
      if (options.dryRun) {
        console.log(`Preview for ${result.appId}:`);
        console.log(`Checkout: ${options.checkout}`);
        console.log(`Webhook URL: https://${options.domain}/hooks/github/${result.appId}`);
        console.log(`Webhook secret variable: ${result.secretEnvironmentVariable}`);
        console.log(`Caddy upstream: 127.0.0.1:${options.hostPort}`);
        console.log("Preview complete. No changes made.");
      } else {
        console.log(`Added ${result.appId} and restarted shibumi-server.`);
        console.log(`Webhook URL: https://${options.domain}/hooks/github/${result.appId}`);
        console.log(`Webhook secret: ${result.secretEnvironmentVariable} in ${paths.secrets}`);
        console.log(`Caddy upstream: 127.0.0.1:${options.hostPort}`);
        console.log("Add the webhook route to Caddy before the app's normal handler; Caddy and GitHub are not modified automatically.");
      }
    } else {
      const { runInteractiveAdd } = await import("./setup");
      await runInteractiveAdd({ home: homedir(), ...options });
    }
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
