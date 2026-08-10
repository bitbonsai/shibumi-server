import { cancel, confirm, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { BunCommandRunner, type CommandRunner } from "./deploy";
import { addApp, initializeInstallation, installationPaths, type AddAppOptions } from "./install";

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

export function defaultCheckout(domain: string): string {
  return join("/srv/shibumi/apps", domain.replaceAll(".", "-"));
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

async function automaticPort(home: string): Promise<number> {
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

export async function promptForApp(initial: Partial<SetupAnswers> = {}): Promise<SetupAnswers | undefined> {
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

  const checkout = initial.checkout ?? await text({
    message: "Where should deployments live?",
    defaultValue: defaultCheckout(domain),
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

  const accepted = await confirm({
    message: `Add ${domain} to shibumi-server?`,
    initialValue: true,
  });
  if (cancelled(accepted) || !accepted) return stopSetup();

  return {
    ...initial,
    domain,
    repository,
    checkout,
    hostPort: Number(port),
  };
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
  const installation = await initializeInstallation({
    home: options.home,
    packageRoot: resolve(options.packageRoot),
    bunExecutable: options.bunExecutable,
  });
  progress.stop(`Installed shibumi-server ${installation.version}`);

  outro([
    `Launcher: ${installation.paths.launcher}`,
    "Next: shibumi-server add example.com",
    "The service starts after its first app is added.",
  ].join("\n"));
}

export async function runInteractiveAdd(options: { home: string } & Partial<SetupAnswers>): Promise<void> {
  intro("渋み  add an app");
  const { home, ...initial } = options;
  const hostPort = initial.hostPort ?? await automaticPort(home);
  const answers = await promptForApp({ ...initial, hostPort });
  if (!answers) return;

  const progress = spinner();
  progress.start(`Adding ${answers.domain}`);
  const app = await addApp({ home, ...answers });
  progress.stop(`Added ${answers.domain}`);

  const paths = installationPaths(home);
  outro([
    `Webhook URL: https://${answers.domain}/hooks/github/${app.appId}`,
    `Webhook secret: ${app.secretEnvironmentVariable} in ${paths.secrets}`,
    `Caddy upstream: 127.0.0.1:${answers.hostPort}`,
    "Next: add the Caddy route and GitHub webhook.",
  ].join("\n"));
}
