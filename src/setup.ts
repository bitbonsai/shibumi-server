import { cancel, confirm, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { isAbsolute, join, resolve } from "node:path";
import { BunCommandRunner, type CommandRunner } from "./deploy";
import { addApp, initializeInstallation, installationPaths, type AddAppOptions } from "./install";

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

function cancelled(value: unknown): value is symbol {
  return isCancel(value);
}

function stopSetup(): undefined {
  cancel("Setup cancelled.");
  return undefined;
}

export async function promptForSetup(): Promise<SetupAnswers | undefined> {
  const domain = await text({
    message: "Which domain will this app use?",
    placeholder: "example.com",
    validate: (value) => DOMAIN.test(value) ? undefined : "Use a lowercase public hostname such as example.com",
  });
  if (cancelled(domain)) return stopSetup();

  const repository = await text({
    message: "Which GitHub repository?",
    placeholder: "owner/repository",
    validate: (value) => REPOSITORY.test(value) ? undefined : "Use owner/repository",
  });
  if (cancelled(repository)) return stopSetup();

  const checkout = await text({
    message: "Where should deployments live?",
    defaultValue: defaultCheckout(domain),
    validate: (value) => isAbsolute(value) ? undefined : "Use an absolute path",
  });
  if (cancelled(checkout)) return stopSetup();

  const port = await text({
    message: "Which local port should Caddy use?",
    defaultValue: "9100",
    validate: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65_535
        ? undefined
        : "Use an integer between 1024 and 65535";
    },
  });
  if (cancelled(port)) return stopSetup();

  const accepted = await confirm({
    message: `Install shibumi-server and add ${domain}?`,
    initialValue: true,
  });
  if (cancelled(accepted) || !accepted) return stopSetup();

  return {
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

  const answers = await promptForSetup();
  if (!answers) return;

  const progress = spinner();
  progress.start("Installing the pinned service");
  const installation = await initializeInstallation({
    home: options.home,
    packageRoot: resolve(options.packageRoot),
    bunExecutable: options.bunExecutable,
  });
  progress.message(`Adding ${answers.domain}`);
  const app = await addApp({ home: options.home, ...answers });
  progress.stop(`shibumi-server ${installation.version} is ready`);

  const paths = installationPaths(options.home);
  outro([
    `Webhook URL: https://${answers.domain}/hooks/github/${app.appId}`,
    `Webhook secret: ${app.secretEnvironmentVariable} in ${paths.secrets}`,
    `Caddy upstream: 127.0.0.1:${answers.hostPort}`,
    "Next: add the Caddy route and GitHub webhook.",
  ].join("\n"));
}
