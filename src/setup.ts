import { cancel, confirm, intro, isCancel, log, note, outro, select, spinner, text } from "@clack/prompts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "./config";
import { BunCommandRunner, DeploymentError, defaultDeployDependencies, deploy, rollbackToPreviousImage, type CommandRunner } from "./deploy";
import { DeploymentHistoryStore } from "./history";
import { DeploymentLogStore } from "./deployment-log";
import { DeploymentStatusStore } from "./status";
import { checkDomainDns, detectPublicAddresses } from "./domain";
import { APP_RETRY_BUDGET_MS, detectCaddySite, type CaddySiteOptions, type Compression, type HeaderProfile, type Indexing } from "./caddy";
import { applyCaddyWithSudo, authorizeCaddySudo, type CaddyApplyRequest } from "./caddy-sudo";
import { addApp, appIdForDomain, initializeInstallation, installationPaths, markCaddyManaged, registeredApps, removeApp, type AddAppOptions } from "./install";
import { parseGitHubRepositoryTarget } from "./repository";
import { brand, command, next, SHIP_INSTALL_COMMAND } from "./terminal-ui";

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type SetupAnswers = Omit<AddAppOptions, "home">;

export function mergeSetupAnswers(
  existing: Partial<SetupAnswers>,
  provided: Partial<SetupAnswers>,
): Partial<SetupAnswers> {
  return { ...existing, ...Object.fromEntries(Object.entries(provided).filter(([, value]) => value !== undefined)) };
}

export function registrationOutcome(
  fromShipSetup = process.env.SHIBUMI_SHIP_SETUP === "1",
  color?: boolean,
): string {
  return fromShipSetup
    ? "Registration is current."
    : `${next("from your local project root, run:", color)}\n   ${command(SHIP_INSTALL_COMMAND, color)}`;
}

export function formatReadySummary(options: {
  domain: string;
  appId: string;
  hostPort: number;
  caddy: "already configured" | "configured and reloaded" | "existing upstream preserved";
}): string {
  return [
    `Domain    ${options.domain}`,
    `Webhook   https://${options.domain}/hooks/github/${options.appId}`,
    `Upstream  127.0.0.1:${options.hostPort}`,
    `Caddy     ${options.caddy}`,
    "Secret    stored on server",
  ].join("\n");
}

type WhichCommand = (command: string) => string | null;

export function findCommand(
  command: string,
  home = homedir(),
  which: WhichCommand = (name) => Bun.which(name),
): string | null {
  const resolved = which(command);
  if (resolved) return resolved;
  const local = join(home, ".local", "bin", command);
  return existsSync(local) ? local : null;
}

async function composeAvailable(command: string[], runner: CommandRunner): Promise<boolean> {
  const [executable, ...prefix] = command;
  const result = await runner.run(executable, [...prefix, "version"], { capture: true, timeoutMs: 10_000 });
  return !result.timedOut && result.exitCode === 0;
}

export async function resolveComposeCommand(
  preferred?: string[],
  which: WhichCommand = findCommand,
  runner: CommandRunner = new BunCommandRunner(),
): Promise<string[]> {
  if (preferred) {
    if (!await composeAvailable(preferred, runner)) {
      throw new Error(`${preferred.join(" ")} is not available.\n\nNext: install that Compose frontend and verify ${preferred.join(" ")} version.`);
    }
    if (preferred.length === 1 && preferred[0] === "podman-compose") return [which("podman-compose") ?? preferred[0]];
    return preferred;
  }
  if (await composeAvailable(["podman", "compose"], runner)) return ["podman", "compose"];
  const standalone = which("podman-compose");
  if (standalone && await composeAvailable([standalone], runner)) return [standalone];
  throw new Error("Podman Compose is not available.\n\nNext: install podman-compose with your Linux package manager, then run podman-compose version.");
}

export async function setupRequirementIssues(
  which: WhichCommand = findCommand,
  runner: CommandRunner = new BunCommandRunner(),
): Promise<string[]> {
  const requirements = [
    { command: "git", label: "Git" },
    { command: "podman", label: "Podman" },
    { command: "caddy", label: "Caddy" },
    { command: "systemctl", label: "systemd" },
  ];
  const available = new Set(requirements.filter(({ command }) => which(command)).map(({ command }) => command));
  const issues = requirements
    .filter(({ command }) => !available.has(command))
    .map(({ label }) => `${label} is not installed`);

  if (available.has("podman")) {
    const result = await runner.run("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
      capture: true,
      timeoutMs: 10_000,
    });
    if (result.timedOut || result.exitCode !== 0 || result.stdout.trim() !== "true") {
      issues.push("Podman is not configured for the current user (rootless mode)");
    } else {
      try {
        await resolveComposeCommand(undefined, which, runner);
      } catch {
        issues.push("Podman Compose is not installed or usable (install podman-compose, then run podman-compose version)");
      }
    }
  }

  if (available.has("systemctl")) {
    const result = await runner.run("systemctl", ["--user", "show-environment"], {
      capture: true,
      timeoutMs: 10_000,
    });
    if (result.timedOut || result.exitCode !== 0) {
      issues.push("a systemd user session is not available");
    }
  }

  return issues;
}

export function defaultCheckout(domain: string, home: string): string {
  return join(home, "shibumi", appIdForDomain(domain));
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveAvailability(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailability(true)));
  });
}

export async function nextAvailablePort(
  used: ReadonlySet<number>,
  available: (port: number) => Promise<boolean> = portAvailable,
  first = 9_001,
): Promise<number> {
  for (let port = first; port <= 65_535; port += 1) {
    if (!used.has(port) && await available(port)) return port;
  }
  throw new Error(`no available port found from ${first} to 65535`);
}

async function automaticPort(home: string, domain?: string): Promise<number> {
  const paths = installationPaths(home);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(paths.config, "utf8"));
  } catch (error) {
    throw new Error(`cannot read config ${paths.config}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as { apps?: unknown; listen?: unknown }
    : undefined;
  const apps = root?.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) throw new Error("config.apps must be an object");
  if (domain) {
    const existing = (apps as Record<string, unknown>)[appIdForDomain(domain)];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      const port = (existing as { hostPort?: unknown }).hostPort;
      if (Number.isInteger(port)) return port as number;
    }
  }
  const used = new Set(
    Object.values(apps)
      .map((app) => app && typeof app === "object" && !Array.isArray(app) ? (app as { hostPort?: unknown }).hostPort : undefined)
      .filter((port): port is number => Number.isInteger(port)),
  );
  if (root.listen && typeof root.listen === "object" && !Array.isArray(root.listen)) {
    const listenerPort = (root.listen as { port?: unknown }).port;
    if (Number.isInteger(listenerPort)) used.add(listenerPort as number);
  }
  return nextAvailablePort(used);
}

function cancelled(value: unknown): value is symbol {
  return isCancel(value);
}

function stopSetup(): undefined {
  cancel("Setup cancelled.");
  return undefined;
}

export async function promptForApp(initial: Partial<SetupAnswers> = {}, home = homedir()): Promise<SetupAnswers | undefined> {
  if (initial.domain !== undefined && !DOMAIN.test(initial.domain)) {
    throw new Error("domain must be a lowercase public hostname such as example.com");
  }
  const initialTarget = initial.repository === undefined ? undefined : parseGitHubRepositoryTarget(initial.repository);
  if (initial.repository !== undefined && !initialTarget) {
    throw new Error("repository must use github:owner/repo or a GitHub repository URL");
  }
  if (initialTarget?.ref && initial.ref && initialTarget.ref !== initial.ref) {
    throw new Error("GitHub tree URL branch conflicts with ref");
  }
  const initialRepository = initialTarget?.repository;
  if (initial.checkout !== undefined && !isAbsolute(initial.checkout)) {
    throw new Error("checkout must be an absolute path");
  }
  if (initial.hostPort !== undefined && (!Number.isInteger(initial.hostPort) || initial.hostPort < 1024 || initial.hostPort > 65_535)) {
    throw new Error("port must be an integer between 1024 and 65535");
  }

  const domain = initial.domain ?? await text({
    message: "Which domain will this app use?",
    placeholder: "example.com",
    validate: (value) => DOMAIN.test(value) ? undefined : "Use a lowercase public hostname such as example.com",
  });
  if (cancelled(domain)) return stopSetup();

  let repository = initialRepository;
  if (repository === undefined) {
    const answer = await text({
      message: "Where's the repository?",
      placeholder: "github:owner/repo or https://github.com/owner/repo",
      validate: (value) => parseGitHubRepositoryTarget(value) ? undefined : "Use github:owner/repo or a GitHub URL",
    });
    if (cancelled(answer)) return stopSetup();
    const target = parseGitHubRepositoryTarget(answer)!;
    repository = target.repository;
    if (!initial.ref && target.ref) initial.ref = target.ref;
  }

  const suggestedCheckout = defaultCheckout(domain, home);
  const checkoutAnswer = initial.checkout ?? await text({
    message: "Where should deployments live?",
    placeholder: suggestedCheckout,
    validate: (value) => isAbsolute(value || suggestedCheckout) ? undefined : "Use an absolute path",
  });
  if (cancelled(checkoutAnswer)) return stopSetup();
  const checkout = checkoutAnswer || suggestedCheckout;

  const portAnswer = initial.hostPort === undefined
    ? await text({
        message: "Which local port should Caddy use?",
        placeholder: "9001",
        validate: (value) => {
          const parsed = Number(value || "9001");
          return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65_535
            ? undefined
            : "Use an integer between 1024 and 65535";
        },
      })
    : String(initial.hostPort);
  if (cancelled(portAnswer)) return stopSetup();
  const port = portAnswer || "9001";

  return {
    ...initial,
    domain,
    repository,
    ref: initial.ref ?? initialTarget?.ref,
    checkout,
    hostPort: Number(port),
  };
}

export async function confirmUninstall(purge: boolean): Promise<boolean> {
  const accepted = await confirm({
    message: purge
      ? "Uninstall shibumi-server and permanently delete config and webhook secrets?"
      : "Uninstall shibumi-server? Config and webhook secrets will be preserved.",
    initialValue: false,
  });
  if (cancelled(accepted) || !accepted) {
    cancel("Uninstall cancelled.");
    return false;
  }
  return true;
}

async function promptForCaddy(answers: SetupAnswers, yes = false): Promise<CaddyApplyRequest | undefined> {
  const detected = await detectCaddySite(answers.domain);
  const choice = yes ? (detected.exists ? "preserve" : "new") : await select({
    message: detected.exists ? `Existing Caddy site detected (${detected.upstreams.join(", ") || "custom upstream"})` : "Domain configuration",
    options: detected.exists ? [
      { value: "preserve", label: "Keep current config", hint: "recommended; add Shibumi webhook route only" },
      { value: "rewrite", label: "Rewrite with recommended defaults" },
      { value: "custom", label: "Customize replacement…" },
    ] : [
      { value: "new", label: "Recommended defaults", hint: "zstd + gzip, indexing allowed, safe headers, rotated logs" },
      { value: "custom", label: "Customize…" },
    ],
  });
  if (cancelled(choice)) return stopSetup();
  if (detected.exists && choice !== "preserve") {
    note([
      `Current upstreams: ${detected.upstreams.join(", ") || "custom"}`,
      `Current compression: ${detected.compression ? "enabled" : "not detected"}`,
      `Current headers: ${detected.headers ? "custom" : "not detected"}`,
      `Current logs: ${detected.logs ? "enabled" : "disabled"}`,
      "Replacement removes directives outside the selected Shibumi settings. A backup is created before validation and reload.",
    ].join("\n"), "Existing Caddy settings");
  }

  let compression: Compression = "zstd-gzip";
  let indexing: Indexing = "allow";
  let headers: HeaderProfile = "safe";
  let logs = true;
  let aliases = detected.aliases;
  let aliasMode: "redirect" | "serve" = "redirect";
  if (choice === "custom") {
    const compressionChoice = await select({
      message: "Compression",
      options: [
        { value: "zstd-gzip", label: "Zstd + gzip", hint: "recommended" },
        { value: "zstd", label: "Zstd only" },
        { value: "gzip", label: "Gzip only" },
        { value: "off", label: "Disabled" },
      ],
    });
    if (cancelled(compressionChoice)) return stopSetup();
    compression = compressionChoice as Compression;
    const indexingChoice = await select({
      message: "Search indexing",
      options: [
        { value: "allow", label: "Allow indexing" },
        { value: "private", label: "Private from search", hint: "not access control" },
      ],
    });
    if (cancelled(indexingChoice)) return stopSetup();
    indexing = indexingChoice as Indexing;
    const headerChoice = await select({
      message: "Safe headers",
      options: [
        { value: "safe", label: "Enabled", hint: "recommended" },
        { value: "off", label: "Disabled" },
      ],
    });
    if (cancelled(headerChoice)) return stopSetup();
    headers = headerChoice as HeaderProfile;
    const logChoice = await select({
      message: "Rotated JSON access logs",
      options: [
        { value: true, label: "Enabled", hint: "10MB × 5" },
        { value: false, label: "Disabled" },
      ],
    });
    if (cancelled(logChoice)) return stopSetup();
    logs = logChoice as boolean;
    const suggestedAliases = aliases.join(", ");
    const aliasAnswer = await text({
      message: "Domain aliases (comma-separated, optional)",
      placeholder: suggestedAliases,
      validate: (value) => {
        const values = value.split(",").map((alias) => alias.trim()).filter(Boolean);
        return values.every((alias) => DOMAIN.test(alias) && alias !== answers.domain) ? undefined : "Use public hostnames separated by commas";
      },
    });
    if (cancelled(aliasAnswer)) return stopSetup();
    aliases = (aliasAnswer || suggestedAliases).split(",").map((alias) => alias.trim()).filter(Boolean);
    if (aliases.length > 0) {
      const aliasModeChoice = await select({
        message: "Alias behavior",
        options: [
          { value: "redirect", label: "Redirect aliases to primary", hint: "recommended" },
          { value: "serve", label: "Serve the app on every hostname" },
        ],
      });
      if (cancelled(aliasModeChoice)) return stopSetup();
      aliasMode = aliasModeChoice as "redirect" | "serve";
    }
  }

  const site: CaddySiteOptions = {
    domain: answers.domain,
    appId: appIdForDomain(answers.domain),
    appPort: answers.hostPort,
    webhookPort: 8787,
    compression,
    indexing,
    headers,
    logs,
    aliases,
    aliasMode,
  };
  const mode = choice === "custom" ? (detected.exists ? "rewrite" : "new") : choice;
  const request = { version: 1, action: "apply", mode: mode as CaddyApplyRequest["mode"], site } as const;
  if (answers.dryRun || yes) return request;
  const accepted = await confirm({
    message: `Add ${answers.domain} and apply ${mode} Caddy config? sudo will ask before Caddy changes.`,
    initialValue: true,
  });
  if (cancelled(accepted) || !accepted) return stopSetup();
  return request;
}

export async function runInteractiveSetup(options: {
  home: string;
  packageRoot: string;
  bunExecutable: string;
}): Promise<void> {
  intro(brand());
  const issues = await setupRequirementIssues();
  if (issues.length > 0) {
    cancel(`Setup needs attention:\n${issues.map((issue) => `  • ${issue}`).join("\n")}\n\nInstall or configure these requirements, then run setup again.`);
    return;
  }

  const accepted = await confirm({
    message: "Install shibumi-server on this server?",
    initialValue: true,
  });
  if (cancelled(accepted) || !accepted) return stopSetup();

  const progress = spinner();
  progress.start("Installing the pinned service");
  let installation;
  try {
    installation = await initializeInstallation({
      home: options.home,
      packageRoot: resolve(options.packageRoot),
      bunExecutable: options.bunExecutable,
    });
    progress.stop(`Installed shibumi-server ${installation.version}`);
  } catch (error) {
    progress.stop("Installation failed", 1);
    throw error;
  }

  outro([
    `Launcher: ${installation.paths.shortLauncher}`,
    "The service starts after its first app is added.",
    "From your local project root:",
    SHIP_INSTALL_COMMAND,
  ].join("\n"));
}

type HealthFetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function checkAppHealth(
  healthUrl: string,
  timeoutMs: number,
  fetcher: HealthFetcher = fetch,
): Promise<{ healthy: boolean; detail: string }> {
  try {
    const response = await fetcher(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok
      ? { healthy: true, detail: `healthy (HTTP ${response.status})` }
      : { healthy: false, detail: `unhealthy (HTTP ${response.status})` };
  } catch {
    return { healthy: false, detail: "unreachable" };
  }
}

export async function runListApps(home: string): Promise<void> {
  intro(brand());
  const apps = await registeredApps(home);
  if (apps.length === 0) {
    outro(`No apps registered. From your local project root, run:\n${SHIP_INSTALL_COMMAND}`);
    return;
  }
  const results = await Promise.all(apps.map(async (app) => ({
    app,
    health: await checkAppHealth(app.healthUrl, Math.min(app.healthIntervalMs * 2, 5_000)),
  })));
  for (const { app, health } of results) {
    const summary = [
      `${app.domain}  (${app.appId})`,
      `Health      ${health.detail}`,
      `Repository  github:${app.repository}`,
      `Upstream    127.0.0.1:${app.hostPort}`,
      `Checkout    ${app.checkout}`,
      `Caddy       ${app.caddyMode ?? "unmanaged"}`,
    ].join("\n");
    health.healthy ? log.success(summary) : log.error(summary);
  }
  outro(`${apps.length} app${apps.length === 1 ? "" : "s"} registered`);
}

export async function runRemoveApp(home: string, selector: string, yes = false): Promise<void> {
  intro(brand());
  const app = (await registeredApps(home)).find((item) => item.appId === selector || item.domain === selector);
  if (!app) throw new Error(`unknown app: ${selector}.\n\nNext: run shis list and choose a domain or app ID.`);
  log.info([
    `Domain      ${app.domain}`,
    `App ID      ${app.appId}`,
    `Repository  github:${app.repository}`,
    `Upstream    127.0.0.1:${app.hostPort}`,
    "",
    "Removes Shibumi config, webhook secret, deployment status, Caddy route, and app containers.",
    "Preserves checkout, volumes, images, and GitHub webhook.",
  ].join("\n"));
  if (!yes) {
    const accepted = await confirm({ message: `Remove ${app.domain} from this server?`, initialValue: false });
    if (cancelled(accepted) || !accepted) {
      cancel("Removal cancelled.");
      return;
    }
  }

  if (app.caddyMode) {
    log.info("Caddy will validate and reload after removing Shibumi-managed configuration. sudo reads your password directly.");
    try {
      await applyCaddyWithSudo({ version: 1, action: "remove", appId: app.appId, domain: app.domain });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nNext: fix Caddy validation, then rerun shis remove ${app.appId}.`);
    }
  }

  let result;
  try {
    result = await removeApp(home, app.appId);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nNext: rerun shis remove ${app.appId}; Caddy removal is idempotent.`);
  }
  log.success(`${app.domain} removed from shibumi-server`);
  log.info([
    `Caddy       ${app.caddyMode ? "Shibumi route removed" : "unchanged (unmanaged)"}`,
    `Checkout    preserved at ${app.checkout}`,
    "Volumes     preserved",
    "Images      preserved",
    "GitHub      webhook preserved",
  ].join("\n"));
  if (result.containerWarning) {
    log.warn(`App container could not be stopped: ${result.containerWarning}\nNext: stop its Compose project manually from ${app.checkout}.`);
  }
  outro(result.remainingApps === 0
    ? "No apps remain. shibumi-server service stopped."
    : `${result.remainingApps} app${result.remainingApps === 1 ? "" : "s"} remain. shibumi-server restarted.`);
}

export async function runRollback(home: string, appId: string, yes = false): Promise<void> {
  const paths = installationPaths(home);
  const config = await loadConfig(paths.config);
  const app = config.apps[appId];
  if (!app) throw new Error(`unknown app: ${appId}.\n\nNext: run shis list and choose an app ID.`);
  intro(brand());
  if (!yes) {
    const accepted = await confirm({ message: `Restore the previous retained image for ${app.domain ?? appId}?` });
    if (isCancel(accepted) || !accepted) {
      cancel("Rollback cancelled.");
      return;
    }
  }
  const runner = new BunCommandRunner();
  const stopped = await runner.run("systemctl", ["--user", "stop", "shibumi-server.service"], { capture: true, timeoutMs: 120_000 });
  if (stopped.exitCode !== 0) throw new Error(`${stopped.stderr.trim() || "cannot stop shibumi-server"}\n\nNext: inspect systemctl --user status shibumi-server, then retry rollback.`);
  const startedAt = Date.now();
  const history = new DeploymentHistoryStore(paths.historyDirectory);
  const logs = new DeploymentLogStore(paths.logsDirectory);
  const status = new DeploymentStatusStore(paths.statusDirectory);
  const appendLog = async (stage: string, value: string) => {
    try {
      await logs.append(appId, stage, value);
    } catch (error) {
      log.error(`deployment log could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let targetCommit: string | undefined;
  try {
    const dependencies = defaultDeployDependencies();
    dependencies.onStage = async (stage) => {
      if (targetCommit) {
        await appendLog(stage, "Started");
        await status.write({ appId, commit: targetCommit, state: "running", stage, url: app.domain ? `https://${app.domain}` : undefined });
      }
    };
    try {
      const fullCommit = await rollbackToPreviousImage(appId, app, dependencies, async (commit) => {
        targetCommit = commit;
        try {
          await logs.start(appId, commit);
        } catch (error) {
          log.error(`deployment log could not be started: ${error instanceof Error ? error.message : String(error)}`);
        }
        await appendLog("accepted", "Rollback accepted");
        await history.append({ appId, commit, kind: "rollback", state: "accepted" });
        await status.write({ appId, commit, state: "accepted", stage: "accepted", url: app.domain ? `https://${app.domain}` : undefined });
      });
      await status.write({ appId, commit: fullCommit, state: "succeeded", stage: "shipped", url: app.domain ? `https://${app.domain}` : undefined });
      await appendLog("shipped", `Rollback succeeded in ${Date.now() - startedAt}ms`);
      await history.append({ appId, commit: fullCommit, kind: "rollback", state: "succeeded", durationMs: Date.now() - startedAt });
      outro(`${app.domain ?? appId} restored to ${fullCommit.slice(0, 12)}`);
    } catch (error) {
      const stage = error instanceof DeploymentError ? error.stage : "unknown";
      if (targetCommit) {
        await appendLog(stage, error instanceof Error ? error.message : String(error));
        await status.write({ appId, commit: targetCommit, state: "failed", stage, message: `${stage} failed`, url: app.domain ? `https://${app.domain}` : undefined });
        await history.append({ appId, commit: targetCommit, kind: "rollback", state: "failed", stage, durationMs: Date.now() - startedAt });
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nNext: inspect shis history ${appId} and systemctl --user status shibumi-server.`);
    }
  } finally {
    const started = await runner.run("systemctl", ["--user", "start", "shibumi-server.service"], { capture: true, timeoutMs: 30_000 });
    if (started.exitCode !== 0) log.error(`shibumi-server could not restart: ${started.stderr.trim()}\nNext: run systemctl --user start shibumi-server.`);
  }
}

export async function runCaddyCutover(home: string, appId: string): Promise<void> {
  intro(brand());
  const paths = installationPaths(home);
  const config = await loadConfig(paths.config);
  const app = config.apps[appId];
  if (!app) throw new Error(`unknown app: ${appId}`);
  if (!app.domain) throw new Error(`app ${appId} has no domain`);
  if (app.caddyMode !== "preserve") {
    outro(`${app.domain} already uses its Shibumi upstream.`);
    return;
  }
  const accepted = await confirm({
    message: `Switch ${app.domain} to healthy upstream 127.0.0.1:${app.hostPort}? sudo will validate and reload Caddy.`,
    initialValue: true,
  });
  if (cancelled(accepted) || !accepted) return stopSetup();
  await authorizeCaddySudo();
  await applyCaddyWithSudo({
    version: 1,
    action: "apply",
    mode: "cutover",
    site: {
      domain: app.domain,
      appId,
      appPort: app.hostPort,
      webhookPort: config.listen.port,
    },
  });
  await markCaddyManaged(home, appId);
  outro(`Caddy now routes ${app.domain} to 127.0.0.1:${app.hostPort}.`);
}

export async function runCaddyRefresh(home: string, appId: string): Promise<void> {
  intro(brand());
  const config = await loadConfig(installationPaths(home).config);
  const app = config.apps[appId];
  if (!app) throw new Error(`unknown app: ${appId}\n\nNext: run shis list and retry with a registered app ID.`);
  if (!app.domain) throw new Error(`app ${appId} has no domain\n\nNext: register its domain before refreshing Caddy.`);
  if (app.caddyMode === "preserve") throw new Error(`Caddy cutover is still pending for ${app.domain}.\n\nNext: run shis caddy-cutover ${appId}.`);
  if (app.caddyMode !== "managed") throw new Error(`Caddy is not managed for ${app.domain}.\n\nNext: update its reverse_proxy manually or register it with managed Caddy.`);
  const accepted = await confirm({
    message: `Refresh managed Caddy route for ${app.domain}? sudo will validate and reload Caddy.`,
    initialValue: true,
  });
  if (cancelled(accepted) || !accepted) return stopSetup();
  await applyCaddyWithSudo({
    version: 1,
    action: "apply",
    mode: "refresh",
    site: {
      domain: app.domain,
      appId,
      appPort: app.hostPort,
      webhookPort: config.listen.port,
    },
  });
  outro(`Caddy retries ${app.domain} upstream for ${APP_RETRY_BUDGET_MS / 1_000} seconds during container replacement.`);
}

export async function runInteractiveAdd(options: { home: string; yes?: boolean } & Partial<SetupAnswers>): Promise<void> {
  intro(brand());
  const { home, yes = false, ...provided } = options;
  let existing: Partial<SetupAnswers> = {};
  let existingCaddyMode: AddAppOptions["caddyMode"];
  if (provided.domain) {
    try {
      const app = (await loadConfig(installationPaths(home).config)).apps[appIdForDomain(provided.domain)];
      if (app) {
        existing = {
          domain: provided.domain,
          repository: app.repository,
          checkout: app.checkout,
          hostPort: app.hostPort,
          ref: app.ref,
          composeFile: app.composeFile,
          composeCommand: app.composeCommand,
          service: app.service,
          healthPath: new URL(app.healthUrl).pathname,
          testCommand: app.testCommand,
        };
        existingCaddyMode = app.caddyMode;
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("apps must contain at least one app")) throw error;
    }
  }
  const initial = mergeSetupAnswers(existing, provided);
  initial.composeCommand = await resolveComposeCommand(initial.composeCommand);
  if (initial.domain) {
    const progress = spinner();
    progress.start(`Checking DNS for ${initial.domain}`);
    const publicAddresses = await detectPublicAddresses();
    const dns = await checkDomainDns(initial.domain, publicAddresses);
    if (dns.state === "unknown") {
      progress.stop("DNS lookup could not be confirmed", 1);
      cancel([
        `Resolver checks for ${initial.domain} failed after three attempts. No changes were made.`,
        ...dns.errors.map((error) => `  ${error}`),
        `Check from this server: dig A ${initial.domain} && dig AAAA ${initial.domain}`,
        "Rerun this command after DNS resolution recovers.",
      ].join("\n"));
      return;
    }
    if (dns.state === "missing") {
      progress.stop("DNS is not configured", 1);
      const cloudflare = dns.nameservers.some((server) => server.endsWith(".cloudflare.com"));
      cancel([
        `Add DNS for ${initial.domain}, then rerun this command.`,
        ...(publicAddresses.length > 0
          ? publicAddresses.map((address) => `${address.includes(":") ? "AAAA" : "A"}  ${initial.domain}  ${address}`)
          : ["Public server address could not be detected; add the VPS address manually."]),
        ...(cloudflare ? ["Cloudflare dashboard: https://dash.cloudflare.com/"] : []),
      ].join("\n"));
      return;
    }
    progress.stop(dns.state === "ready" ? "DNS points to this server" : `DNS detected (${dns.state})`);
    if (dns.state === "elsewhere" && !yes) {
      const migrate = await confirm({
        message: `${initial.domain} resolves elsewhere. Prepare a staged migration to this server?`,
        initialValue: false,
      });
      if (cancelled(migrate) || !migrate) return stopSetup();
    }
  }
  const hostPort = initial.hostPort ?? await automaticPort(home, initial.domain);
  if (yes && (!initial.domain || !initial.repository)) throw new Error("add --yes requires domain and --repository");
  const answers = await promptForApp({
    ...initial,
    hostPort,
    checkout: initial.checkout ?? (yes && initial.domain ? defaultCheckout(initial.domain, home) : undefined),
  }, home);
  if (!answers) return;
  if (!answers.healthPath) {
    try {
      const compose = await readFile(join(answers.checkout, answers.composeFile ?? "compose.yaml"), "utf8");
      answers.healthPath = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+(\/[^\s"'\\]*)/.exec(compose)?.[1] ?? "/healthz";
      log.info(`Health path ${answers.healthPath} (${answers.healthPath === "/healthz" ? "default" : "detected from Compose"})`);
    } catch {
      answers.healthPath = "/healthz";
      log.info("Health path /healthz (default)");
    }
  }
  const caddy = existingCaddyMode ? undefined : await promptForCaddy(answers, yes);
  if (!existingCaddyMode && !caddy) return;
  if (caddy?.site.aliases?.length) {
    const expected = await detectPublicAddresses();
    const activeAliases: string[] = [];
    for (const alias of caddy.site.aliases) {
      const status = await checkDomainDns(alias, expected);
      if (status.state === "ready" || status.state === "cloudflare") activeAliases.push(alias);
      else if (status.state === "unknown") log.warn(`Skipping alias ${alias}: DNS lookup could not be confirmed`);
      else log.warn(`Skipping alias ${alias}: DNS is not ready`);
    }
    caddy.site.aliases = activeAliases;
  }
  if (!answers.dryRun && caddy) await authorizeCaddySudo();

  const action = answers.dryRun ? "preview" : "add";
  const progress = spinner();
  progress.start(`${answers.dryRun ? "Previewing" : "Adding"} ${answers.domain}`);
  let app;
  try {
    app = await addApp({
      home,
      ...answers,
      caddyMode: existingCaddyMode ?? (caddy?.mode === "preserve" ? "preserve" : "managed"),
    });
    progress.stop(`${answers.dryRun ? "Previewed" : existingCaddyMode ? "Already configured" : "Added"} ${answers.domain}`);
  } catch (error) {
    progress.stop(`Failed to ${action} ${answers.domain}`, 1);
    throw error;
  }

  if (!answers.dryRun && caddy) await applyCaddyWithSudo(caddy);

  if (answers.dryRun) {
    outro([
      `App ID: ${app.appId}`,
      `Checkout: ${answers.checkout}`,
      `Webhook URL: https://${answers.domain}/hooks/github/${app.appId}`,
      `Webhook secret variable: ${app.secretEnvironmentVariable}`,
      `Caddy upstream: 127.0.0.1:${answers.hostPort}`,
      `Caddy mode: ${existingCaddyMode ?? caddy?.mode}`,
      "Preview complete. No changes made. Sudo was not used.",
    ].join("\n"));
    return;
  }

  log.success(`${answers.domain} is ready`);
  log.info(formatReadySummary({
    domain: answers.domain,
    appId: app.appId,
    hostPort: answers.hostPort,
    caddy: existingCaddyMode
      ? "already configured"
      : caddy?.mode === "preserve" ? "existing upstream preserved" : "configured and reloaded",
  }));
  outro(registrationOutcome());
}
