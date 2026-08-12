#!/usr/bin/env bun

import { homedir } from "node:os";
import { resolve } from "node:path";
import packageJson from "../package.json";
import { createClientConfig, readWebhookSecret } from "./client-config";
import { formatHelp, parseCliArgs } from "./cli-args";
import { loadConfig, validateSecrets } from "./config";
import { addApp, initializeInstallation, installationPaths, uninstallInstallation } from "./install";
import { WebhookService } from "./server";
import { DeploymentStatusStore } from "./status";
import { DeploymentHistoryStore } from "./history";
import { updateToLatest, warnIfUpdateAvailable } from "./update";

function requireLinux(): void {
  if (process.platform !== "linux") throw new Error("this command requires Linux with a systemd user session");
}

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb");
}

async function installRelease(version: string): Promise<number> {
  return Bun.spawn([process.execPath, "x", `shibumi-server@${version}`, "init"], {
    env: { ...process.env, SHIBUMI_SKIP_UPDATE_CHECK: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

async function serve(configPath: string, statusDirectory: string): Promise<void> {
  const config = await loadConfig(configPath);
  validateSecrets(config);

  const paths = installationPaths(homedir());
  const service = new WebhookService(config, {
    statusStore: new DeploymentStatusStore(statusDirectory),
    historyStore: new DeploymentHistoryStore(paths.historyDirectory),
  });
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
  if (!["help", "version", "serve", "update"].includes(command.name) && process.env.SHIBUMI_SKIP_UPDATE_CHECK !== "1") {
    await warnIfUpdateAvailable(packageJson.version);
  }

  if (command.name === "help") {
    console.log(formatHelp(supportsColor()));
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
  } else if (command.name === "update") {
    requireLinux();
    const result = await updateToLatest(packageJson.version, installRelease);
    console.log(result.updated
      ? `Updated shibumi-server to ${result.version}.`
      : `shibumi-server ${result.version} is already current.`);
  } else if (command.name === "init") {
    requireLinux();
    const result = await initializeInstallation({
      home: homedir(),
      packageRoot: resolve(import.meta.dir, ".."),
      bunExecutable: process.execPath,
    });
    console.log(`Installed shibumi-server ${result.version} at ${result.paths.currentRelease}.`);
    console.log(`Launcher: ${result.paths.shortLauncher}`);
    console.log("Next: shis add example.com");
  } else if (command.name === "uninstall") {
    requireLinux();
    if (command.purge && !command.yes) {
      const { confirmPurge } = await import("./setup");
      if (!await confirmPurge()) process.exit(0);
    }
    const paths = await uninstallInstallation(homedir(), command.purge);
    console.log("Removed shibumi-server service, launchers, and installed releases.");
    if (command.purge) console.log("Removed local config and webhook secrets.");
    else console.log(`Preserved config and secrets in ${paths.configDirectory}.`);
    console.log("App checkouts, containers, Caddy, and GitHub settings were not changed.");
  } else if (command.name === "list") {
    const { runListApps } = await import("./setup");
    await runListApps(homedir());
  } else if (command.name === "remove") {
    requireLinux();
    const { runRemoveApp } = await import("./setup");
    await runRemoveApp(homedir(), command.app, command.yes);
  } else if (command.name === "caddy-cutover") {
    requireLinux();
    const { runCaddyCutover } = await import("./setup");
    await runCaddyCutover(homedir(), command.appId);
  } else if (command.name === "client-config") {
    const paths = installationPaths(homedir());
    console.log(JSON.stringify(await createClientConfig(
      paths.config,
      command.appId,
      command.serverHostname ? async () => command.serverHostname as string : undefined,
    ), null, 2));
  } else if (command.name === "webhook-secret") {
    const paths = installationPaths(homedir());
    console.log(JSON.stringify({ secret: await readWebhookSecret(paths.config, paths.secrets, command.appId) }));
  } else if (command.name === "status") {
    const status = await new DeploymentStatusStore(installationPaths(homedir()).statusDirectory).read(command.appId, command.commit);
    if (command.json) console.log(JSON.stringify(status ?? null));
    else if (status) console.log(`${status.appId} ${status.commit} ${status.state} ${status.stage}${status.message ? `: ${status.message}` : ""}`);
    else console.log(`No deployment status for ${command.appId}${command.commit ? ` at ${command.commit}` : ""}.`);
  } else if (command.name === "history") {
    const entries = await new DeploymentHistoryStore(installationPaths(homedir()).historyDirectory).read(command.appId);
    if (command.json) console.log(JSON.stringify(entries));
    else if (entries.length === 0) console.log(`No deployment history for ${command.appId}.`);
    else for (const entry of entries) console.log(`${entry.at} ${entry.kind} ${entry.state} ${entry.commit}${entry.stage ? ` ${entry.stage}` : ""}${entry.durationMs === undefined ? "" : ` ${entry.durationMs}ms`}`);
  } else if (command.name === "rollback") {
    requireLinux();
    const { runRollback } = await import("./setup");
    await runRollback(homedir(), command.appId, command.commit, command.yes);
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
  } else if (command.name === "check") {
    const config = await loadConfig(command.config);
    validateSecrets(config);
    console.log(`Configuration is valid for ${Object.keys(config.apps).length} app(s).`);
  } else if (command.name === "serve") {
    await serve(command.config, installationPaths(homedir()).statusDirectory);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
