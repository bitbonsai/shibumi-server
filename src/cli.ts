#!/usr/bin/env bun

import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";
import { resolve } from "node:path";
import packageJson from "../package.json";
import { createClientConfig, readWebhookSecret } from "./client-config";
import { formatHelp, parseCliArgs } from "./cli-args";
import { loadConfig, validateSecrets } from "./config";
import { addApp, enablePrebuiltApp, initializeInstallation, installationPaths, setDeploymentMode, uninstallInstallation } from "./install";
import { WebhookService } from "./server";
import { DeploymentStatusStore } from "./status";
import { DeploymentHistoryStore } from "./history";
import { DeploymentLogStore } from "./deployment-log";
import { BunCommandRunner } from "./deploy";
import { DeploymentQueueStore } from "./queue";
import { updateToLatest, warnIfUpdateAvailable } from "./update";
import { SHIP_INSTALL_COMMAND } from "./terminal-ui";

function requireLinux(): void {
  if (process.platform !== "linux") throw new Error("this command requires Linux with a systemd user session");
}

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb");
}

async function installRelease(version: string): Promise<number> {
  return Bun.spawn([process.execPath, "x", `shibumi-server@${version}`, "init"], {
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      SHIBUMI_SKIP_UPDATE_CHECK: "1",
      SHIBUMI_QUIET_INIT: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

async function humanUi(): Promise<typeof import("@clack/prompts") | undefined> {
  return supportsColor() ? import("@clack/prompts") : undefined;
}

async function present(
  rows: Array<{ tone: "info" | "success" | "warn"; message: string }>,
  outcome: string,
): Promise<void> {
  const ui = await humanUi();
  if (!ui) {
    for (const row of rows) console.log(row.message);
    console.log(outcome);
    return;
  }
  ui.intro((await import("./terminal-ui")).brand());
  for (const row of rows) {
    if (row.tone === "success") ui.log.success(row.message);
    else if (row.tone === "warn") ui.log.warn(row.message);
    else ui.log.info(row.message);
  }
  ui.outro(outcome);
}

async function serve(configPath: string, statusDirectory: string): Promise<void> {
  const config = await loadConfig(configPath);
  validateSecrets(config);

  const paths = installationPaths(homedir());
  const service = new WebhookService(config, {
    statusStore: new DeploymentStatusStore(statusDirectory),
    historyStore: new DeploymentHistoryStore(paths.historyDirectory),
    logStore: new DeploymentLogStore(paths.logsDirectory),
    queueStore: new DeploymentQueueStore(`${statusDirectory}/queue`),
  });
  await service.scheduleImageCleanup();
  await service.resumeQueued();
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
    const ui = await humanUi();
    ui?.intro((await import("./terminal-ui")).brand());
    const progress = ui?.spinner();
    progress?.start("Checking npm registry");
    try {
      const result = await updateToLatest(packageJson.version, installRelease);
      progress?.stop(result.updated ? `Installed shibumi-server ${result.version}` : `shibumi-server ${result.version} is current`);
      if (ui) ui.outro(result.updated ? `Updated to shibumi-server ${result.version}` : "No update needed");
      else console.log(result.updated ? `Updated shibumi-server to ${result.version}.` : `shibumi-server ${result.version} is already current.`);
    } catch (error) {
      progress?.error("Update failed");
      throw error;
    }
  } else if (command.name === "init") {
    requireLinux();
    const result = await initializeInstallation({
      home: homedir(),
      packageRoot: resolve(import.meta.dir, ".."),
      bunExecutable: process.execPath,
    });
    if (process.env.SHIBUMI_QUIET_INIT !== "1") await present([
      { tone: "success", message: `Installed shibumi-server ${result.version}` },
      { tone: "info", message: `Release ${result.paths.currentRelease}` },
      { tone: "info", message: `Launcher ${result.paths.shortLauncher}` },
    ], `Next: from your local project root, run:\n${SHIP_INSTALL_COMMAND}`);
  } else if (command.name === "uninstall") {
    requireLinux();
    if (!command.yes) {
      const { confirmUninstall } = await import("./setup");
      if (!await confirmUninstall(command.purge)) process.exit(0);
    }
    const ui = await humanUi();
    const uninstallBrand = ui ? (await import("./terminal-ui")).brand() : undefined;
    const paths = await uninstallInstallation(homedir(), command.purge);
    if (ui) {
      ui.intro(uninstallBrand!);
      ui.log.success("Removed service, launchers, and installed releases");
      if (command.purge) ui.log.warn("Removed local config and webhook secrets");
      else ui.log.info(`Preserved config and secrets in ${paths.configDirectory}`);
      ui.outro("App checkouts, containers, Caddy, and GitHub settings are unchanged");
    } else await present([
      { tone: "success", message: "Removed service, launchers, and installed releases" },
      { tone: command.purge ? "warn" : "info", message: command.purge ? "Removed local config and webhook secrets" : `Preserved config and secrets in ${paths.configDirectory}` },
    ], "App checkouts, containers, Caddy, and GitHub settings are unchanged");
  } else if (command.name === "list") {
    const { runListApps } = await import("./setup");
    await runListApps(homedir());
  } else if (command.name === "remove") {
    requireLinux();
    const { runRemoveApp } = await import("./setup");
    await runRemoveApp(homedir(), command.app, command.yes);
  } else if (command.name === "enable-prebuilt") {
    requireLinux();
    await enablePrebuiltApp(homedir(), command.appId);
    console.log(`Prebuilt deployments enabled for ${command.appId}.`);
  } else if (command.name === "deployment-mode") {
    requireLinux();
    await setDeploymentMode(homedir(), command.appId, command.mode);
    console.log(`${command.mode === "prebuilt" ? "Prebuilt" : "Server build"} deployments enabled for ${command.appId}.`);
  } else if (command.name === "image-load") {
    requireLinux();
    const { loadPrebuiltImage } = await import("./prebuilt");
    const image = await loadPrebuiltImage(installationPaths(homedir()).config, command.appId, command.commit, command.archiveBytes, new BunCommandRunner());
    console.log(`Loaded ${image}.`);
  } else if (command.name === "caddy-cutover") {
    requireLinux();
    const { runCaddyCutover } = await import("./setup");
    await runCaddyCutover(homedir(), command.appId);
  } else if (command.name === "caddy-refresh") {
    requireLinux();
    const { runCaddyRefresh } = await import("./setup");
    await runCaddyRefresh(homedir(), command.appId);
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
    else if (status) await present([
      { tone: status.state === "succeeded" ? "success" : status.state === "failed" ? "warn" : "info", message: `${status.commit.slice(0, 12)}  ${status.state}` },
      { tone: "info", message: `Stage ${status.stage}${status.message ? `: ${status.message}` : ""}` },
    ], status.url ?? status.appId);
    else await present([], `No deployment status for ${command.appId}${command.commit ? ` at ${command.commit}` : ""}`);
  } else if (command.name === "history") {
    const entries = await new DeploymentHistoryStore(installationPaths(homedir()).historyDirectory).read(command.appId);
    if (command.json) console.log(JSON.stringify(entries));
    else if (entries.length === 0) await present([], `No deployment history for ${command.appId}`);
    else await present(entries.map((entry) => ({
      tone: entry.state === "succeeded" ? "success" as const : entry.state === "failed" ? "warn" as const : "info" as const,
      message: `${entry.at}  ${entry.kind}  ${entry.state}  ${entry.commit.slice(0, 12)}${entry.stage ? `  ${entry.stage}` : ""}${entry.durationMs === undefined ? "" : `  ${entry.durationMs}ms`}`,
    })), `${entries.length} recent record${entries.length === 1 ? "" : "s"}`);
  } else if (command.name === "logs") {
    const value = await new DeploymentLogStore(installationPaths(homedir()).logsDirectory).read(command.appId);
    if (!value) throw new Error(`No deployment log for ${command.appId}.\n\nNext: run shis list and confirm the app ID, or deploy the app first.`);
    process.stdout.write(value);
  } else if (command.name === "rollback") {
    requireLinux();
    const { runRollback } = await import("./setup");
    await runRollback(homedir(), command.appId, command.yes);
  } else if (command.name === "redeploy") {
    requireLinux();
    const { triggerRedeploy } = await import("./redeploy");
    await triggerRedeploy(homedir(), command.appId, command.commit);
    console.log(`Redeploy accepted for ${command.commit}.`);
  } else if (command.name === "add") {
    requireLinux();
    const { name: _, yes, ...options } = command;
    if (options.repository && options.checkout && options.hostPort !== undefined) {
      const { resolveComposeCommand } = await import("./setup");
      options.composeCommand = await resolveComposeCommand(options.composeCommand);
      const result = await addApp({
        home: homedir(),
        ...options,
        repository: options.repository,
        checkout: options.checkout,
        hostPort: options.hostPort,
      });
      const paths = installationPaths(homedir());
      if (options.dryRun) await present([
        { tone: "info", message: `App ID ${result.appId}` },
        { tone: "info", message: `Checkout ${options.checkout}` },
        { tone: "info", message: `Webhook https://${options.domain}/hooks/github/${result.appId}` },
        { tone: "info", message: `Secret ${result.secretEnvironmentVariable}` },
        { tone: "info", message: `Upstream 127.0.0.1:${options.hostPort}` },
      ], "Preview complete. No changes made");
      else await present([
        { tone: "success", message: `Added ${result.appId} and restarted shibumi-server` },
        { tone: "info", message: `Webhook https://${options.domain}/hooks/github/${result.appId}` },
        { tone: "info", message: `Secret ${result.secretEnvironmentVariable} in ${paths.secrets}` },
        { tone: "info", message: `Upstream 127.0.0.1:${options.hostPort}` },
      ], "Next: add the webhook route to Caddy before the app handler");
    } else {
      const { runInteractiveAdd } = await import("./setup");
      await runInteractiveAdd({ home: homedir(), yes, ...options });
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
