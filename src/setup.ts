import { cancel, confirm, intro, isCancel, log, note, outro, select, spinner, text } from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "./config";
import { BunCommandRunner, type CommandRunner } from "./deploy";
import { checkDomainDns, detectPublicAddresses } from "./domain";
import { detectCaddySite, type CaddySiteOptions, type Compression, type HeaderProfile, type Indexing } from "./caddy";
import { applyCaddyWithSudo, authorizeCaddySudo, type CaddyApplyRequest } from "./caddy-sudo";
import { addApp, appIdForDomain, initializeInstallation, installationPaths, markCaddyManaged, type AddAppOptions } from "./install";

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_REPOSITORY = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type SetupAnswers = Omit<AddAppOptions, "home">;

type WhichCommand = (command: string) => string | null;

export async function setupRequirementIssues(
  which: WhichCommand = (command) => Bun.which(command),
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
  return join(home, ".local", "share", "shibumi", "apps", appIdForDomain(domain));
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
  first = 9_100,
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
  if (initial.repository !== undefined && !REPOSITORY.test(initial.repository)) {
    throw new Error("repository must use owner/repository");
  }
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

  let repository = initial.repository;
  if (repository === undefined) {
    const answer = await text({
      message: "Where's the repository?",
      placeholder: "github:user/repo",
      validate: (value) => GITHUB_REPOSITORY.test(value) ? undefined : "Use github:user/repo",
    });
    if (cancelled(answer)) return stopSetup();
    repository = answer.slice("github:".length);
  }

  const suggestedCheckout = defaultCheckout(domain, home);
  const checkout = initial.checkout ?? await text({
    message: "Where should deployments live?",
    placeholder: suggestedCheckout,
    defaultValue: suggestedCheckout,
    validate: (value) => isAbsolute(value) ? undefined : "Use an absolute path",
  });
  if (cancelled(checkout)) return stopSetup();

  const port = initial.hostPort === undefined
    ? await text({
        message: "Which local port should Caddy use?",
        defaultValue: "9100",
        validate: (value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65_535
            ? undefined
            : "Use an integer between 1024 and 65535";
        },
      })
    : String(initial.hostPort);
  if (cancelled(port)) return stopSetup();

  return {
    ...initial,
    domain,
    repository,
    checkout,
    hostPort: Number(port),
  };
}

export async function confirmPurge(): Promise<boolean> {
  const accepted = await confirm({
    message: "Permanently delete shibumi-server config and webhook secrets?",
    initialValue: false,
  });
  if (cancelled(accepted) || !accepted) {
    cancel("Uninstall cancelled.");
    return false;
  }
  return true;
}

async function promptForCaddy(answers: SetupAnswers): Promise<CaddyApplyRequest | undefined> {
  const detected = await detectCaddySite(answers.domain);
  const choice = await select({
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
    const aliasChoice = await text({
      message: "Domain aliases (comma-separated, optional)",
      defaultValue: aliases.join(", "),
      validate: (value) => {
        const values = value.split(",").map((alias) => alias.trim()).filter(Boolean);
        return values.every((alias) => DOMAIN.test(alias) && alias !== answers.domain) ? undefined : "Use public hostnames separated by commas";
      },
    });
    if (cancelled(aliasChoice)) return stopSetup();
    aliases = aliasChoice.split(",").map((alias) => alias.trim()).filter(Boolean);
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
  const accepted = await confirm({
    message: answers.dryRun
      ? `Preview ${answers.domain} without writing config, secrets, or Caddy files?`
      : `Add ${answers.domain} and apply ${mode} Caddy config? sudo will ask before Caddy changes.`,
    initialValue: true,
  });
  if (cancelled(accepted) || !accepted) return stopSetup();
  return { version: 1, action: "apply", mode: mode as CaddyApplyRequest["mode"], site };
}

export async function runInteractiveSetup(options: {
  home: string;
  packageRoot: string;
  bunExecutable: string;
}): Promise<void> {
  intro("渋み  shibumi-server");
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
    `Launcher: ${installation.paths.launcher}`,
    "Next: shibumi-server add example.com",
    "The service starts after its first app is added.",
  ].join("\n"));
}

export async function runCaddyCutover(home: string, appId: string): Promise<void> {
  intro("渋み  Caddy cutover");
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

export async function runInteractiveAdd(options: { home: string } & Partial<SetupAnswers>): Promise<void> {
  intro("渋み  add an app");
  const { home, ...provided } = options;
  let existing: Partial<SetupAnswers> = {};
  if (provided.domain) {
    try {
      const app = (await loadConfig(installationPaths(home).config)).apps[appIdForDomain(provided.domain)];
      if (app) existing = {
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
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("apps must contain at least one app")) throw error;
    }
  }
  const initial = { ...existing, ...provided };
  if (initial.domain) {
    const progress = spinner();
    progress.start(`Checking DNS for ${initial.domain}`);
    const publicAddresses = await detectPublicAddresses();
    const dns = await checkDomainDns(initial.domain, publicAddresses);
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
    if (dns.state === "elsewhere") {
      const migrate = await confirm({
        message: `${initial.domain} resolves elsewhere. Prepare a staged migration to this server?`,
        initialValue: false,
      });
      if (cancelled(migrate) || !migrate) return stopSetup();
    }
  }
  const hostPort = initial.hostPort ?? await automaticPort(home, initial.domain);
  const answers = await promptForApp({ ...initial, hostPort }, home);
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
  const caddy = await promptForCaddy(answers);
  if (!caddy) return;
  if (caddy.site.aliases?.length) {
    const expected = await detectPublicAddresses();
    const activeAliases: string[] = [];
    for (const alias of caddy.site.aliases) {
      const status = await checkDomainDns(alias, expected);
      if (status.state === "ready" || status.state === "cloudflare") activeAliases.push(alias);
      else log.warn(`Skipping alias ${alias}: DNS is not ready`);
    }
    caddy.site.aliases = activeAliases;
  }
  if (!answers.dryRun) await authorizeCaddySudo();

  const action = answers.dryRun ? "preview" : "add";
  const progress = spinner();
  progress.start(`${answers.dryRun ? "Previewing" : "Adding"} ${answers.domain}`);
  let app;
  try {
    app = await addApp({ home, ...answers, caddyMode: caddy.mode === "preserve" ? "preserve" : "managed" });
    progress.stop(`${answers.dryRun ? "Previewed" : "Added"} ${answers.domain}`);
  } catch (error) {
    progress.stop(`Failed to ${action} ${answers.domain}`, 1);
    throw error;
  }

  if (!answers.dryRun) await applyCaddyWithSudo(caddy);

  const paths = installationPaths(home);
  outro(answers.dryRun ? [
    `App ID: ${app.appId}`,
    `Checkout: ${answers.checkout}`,
    `Webhook URL: https://${answers.domain}/hooks/github/${app.appId}`,
    `Webhook secret variable: ${app.secretEnvironmentVariable}`,
    `Caddy upstream: 127.0.0.1:${answers.hostPort}`,
    `Caddy mode: ${caddy.mode}`,
    "Preview complete. No changes made. Sudo was not used.",
  ].join("\n") : [
    `Webhook URL: https://${answers.domain}/hooks/github/${app.appId}`,
    `Webhook secret: ${app.secretEnvironmentVariable} in ${paths.secrets}`,
    `Caddy upstream: 127.0.0.1:${answers.hostPort}`,
    "Caddy configuration applied and reloaded.",
    `Client config: shibumi-server client-config ${app.appId} --server-hostname <ssh-host>`,
    "Next on your project machine: bun run ship. It downloads shibumi-server.json and configures the GitHub webhook.",
  ].join("\n"));
}
