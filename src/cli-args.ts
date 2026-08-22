import { parseGitHubRepositoryTarget } from "./repository";

export type CliCommand =
  | { name: "help" }
  | { name: "version" }
  | { name: "setup" | "update" | "list" }
  | { name: "remove"; app: string; yes: boolean }
  | { name: "check" | "serve"; config: string }
  | { name: "client-config"; appId: string; serverHostname?: string }
  | { name: "webhook-secret" | "caddy-cutover" | "caddy-refresh" | "enable-prebuilt"; appId: string }
  | { name: "deployment-mode"; appId: string; mode: "build" | "prebuilt" }
  | { name: "image-load"; appId: string; commit: string; archiveBytes: number }
  | { name: "status"; appId: string; commit?: string; json: boolean }
  | { name: "history"; appId: string; json: boolean }
  | { name: "logs"; appId: string }
  | { name: "rollback"; appId: string; yes: boolean }
  | { name: "redeploy"; appId: string; commit: string }
  | { name: "init" }
  | { name: "uninstall"; purge: boolean; yes: boolean }
  | {
      name: "add";
      domain: string;
      dryRun: boolean;
      yes: boolean;
      repository?: string;
      checkout?: string;
      hostPort?: number;
      testCommand?: string[];
      ref?: string;
      composeFile?: string;
      composeCommand?: string[];
      service?: string;
      healthPath?: string;
      deploymentMode?: "build" | "prebuilt";
    };

const ansi = {
  accent: "\x1b[38;5;208m",
  bold: "\x1b[1m",
  muted: "\x1b[38;5;245m",
  reset: "\x1b[0m",
};

export function formatHelp(color = false): string {
  const paint = (value: string, style: keyof typeof ansi) => color ? `${ansi[style]}${value}${ansi.reset}` : value;
  const heading = (value: string) => paint(value, "accent");
  const command = (value: string) => paint(value, "bold");
  const detail = (value: string) => paint(value, "muted");

  return `${paint("渋み", "accent")}  ${paint("shis", "bold")} ${detail("(shibumi-server)")}
${detail("Deploy apps to a Linux VPS with rootless Podman.")}

${heading("USAGE")}
  ${command("shis")} [command]
  ${command("shis --help")}                            Show help
  ${command("shis --version")}                         Show version

${heading("SETUP")}
  ${command("shis")}                                   Guided installation
  ${command("shis setup")}                             Guided installation
  ${command("shis init")}                              Install only (automation)
  ${command("shis update")}                            Install latest stable release
  ${command("shis uninstall")} [--purge] [--yes]

${heading("APPS")}
  ${command("shis list")}                              List registered apps
  ${command("shis remove <domain|app-id>")} [--yes]
      Remove an app; preserve checkout, volumes, images, and GitHub webhook

  ${command("shis add <domain>")} [--dry-run] [--yes]
      Add or preview an app interactively

  ${command("shis add <domain> \\")}
    ${command("--repository <repository> \\")}
    ${command("--checkout <absolute-path> \\")}
    ${command("--port <port> [--dry-run] [options] \\")}
    ${command("[-- <test-command...>]")}
      Add or preview an app with explicit settings

${heading("OPERATIONS")}
  ${command("shis status <app-id>")} [--commit <sha>] [--json]
  ${command("shis history <app-id>")} [--json]
  ${command("shis logs <app-id>")}                  Show latest deployment log
  ${command("shis rollback <app-id>")} [--yes]
  ${command("shis redeploy <app-id> <full-sha>")}
  ${command("shis image-load <app-id> <full-sha> <bytes>")} Load prebuilt image from stdin
  ${command("shis deployment-mode <app-id> <build|prebuilt>")}
  ${command("shis enable-prebuilt <app-id>")}       Compatibility alias
  ${command("shis caddy-cutover <app-id>")}
  ${command("shis caddy-refresh <app-id>")}          Add managed retry budget
  ${command("shis client-config <app-id>")} [--server-hostname <host>]
  ${command("shis webhook-secret <app-id>")}
  ${command("shis check --config <path>")}
  ${command("shis serve --config <path>")}

${heading("ADD OPTIONS")}
  ${command("--repository <repository>")}       github:owner/repo or GitHub URL, including /tree/<branch>
  ${command("--dry-run")}                     Preview without changing system
  ${command("--ref <refs/heads/main>")}        Git branch ref
  ${command("--compose-file <path>")}          Compose file inside checkout
  ${command("--compose-command <frontend>")}   podman or podman-compose
  ${command("--service <name>")}               Compose service (default: web)
  ${command("--health-path </healthz>")}        Loopback health path
  ${command("--deployment-mode <mode>")}        build or prebuilt

${detail("Docs: https://server.shibumistack.dev")}`;
}

export const usageText = formatHelp();

function fail(message: string): never {
  throw new Error(`${message}\n\n${usageText}`);
}

function optionValues(args: string[], allowed: Set<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--") || !allowed.has(option)) fail(`unknown option: ${option}`);
    if (values.has(option)) fail(`option may only be used once: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${option}`);
    values.set(option, value);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string>, option: string): string {
  const value = values.get(option);
  if (!value) fail(`missing required option: ${option}`);
  return value;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [name, ...args] = argv;
  if (!name || name === "setup") {
    if (args.length > 0) fail("setup does not accept arguments");
    return { name: "setup" };
  }
  if (name === "--help" || name === "-h" || name === "help") {
    if (args.length > 0) fail("help does not accept arguments");
    return { name: "help" };
  }
  if (name === "--version" || name === "-v" || name === "version") {
    if (args.length > 0) fail("version does not accept arguments");
    return { name: "version" };
  }
  if (name === "init" || name === "update" || name === "list") {
    if (args.length > 0) fail(`${name} does not accept arguments`);
    return { name };
  }
  if (name === "remove") {
    const app = args.shift();
    if (!app || app.startsWith("--")) fail("remove requires a domain or app id");
    const flags = new Set(args);
    if (flags.size !== args.length) fail("remove flags may only be used once");
    const unknown = args.find((arg) => arg !== "--yes");
    if (unknown) fail(`unknown option: ${unknown}`);
    return { name, app, yes: flags.has("--yes") };
  }
  if (name === "uninstall") {
    const flags = new Set(args);
    if (flags.size !== args.length) fail("uninstall flags may only be used once");
    const unknown = args.find((arg) => arg !== "--purge" && arg !== "--yes");
    if (unknown) fail(`unknown option: ${unknown}`);
    return { name, purge: flags.has("--purge"), yes: flags.has("--yes") };
  }

  if (name === "check" || name === "serve") {
    const values = optionValues(args, new Set(["--config"]));
    return { name, config: required(values, "--config") };
  }

  if (name === "client-config") {
    const appId = args.shift();
    if (!appId || appId.startsWith("--")) fail("client-config requires an app id");
    const values = optionValues(args, new Set(["--server-hostname"]));
    return { name, appId, serverHostname: values.get("--server-hostname") };
  }

  if (name === "webhook-secret" || name === "caddy-cutover" || name === "caddy-refresh" || name === "enable-prebuilt") {
    if (args.length !== 1 || args[0].startsWith("--")) fail(`${name} requires an app id`);
    return { name, appId: args[0] };
  }

  if (name === "deployment-mode") {
    const [appId, mode, ...extra] = args;
    if (!appId || extra.length > 0 || (mode !== "build" && mode !== "prebuilt")) fail("deployment-mode requires an app id and build or prebuilt");
    return { name, appId, mode };
  }

  if (name === "history") {
    const appId = args.shift();
    if (!appId || appId.startsWith("--")) fail("history requires an app id");
    if (args.some((arg) => arg !== "--json") || args.filter((arg) => arg === "--json").length > 1) fail("history accepts only one --json flag");
    return { name, appId, json: args.includes("--json") };
  }

  if (name === "logs") {
    if (args.length !== 1 || args[0].startsWith("--")) fail("logs requires an app id");
    return { name, appId: args[0] };
  }

  if (name === "rollback") {
    const [appId, ...flags] = args;
    if (!appId || appId.startsWith("--")) fail("rollback requires an app id");
    if (flags.some((arg) => arg !== "--yes") || flags.filter((arg) => arg === "--yes").length > 1) fail("rollback accepts only one --yes flag");
    return { name, appId, yes: flags.includes("--yes") };
  }

  if (name === "redeploy") {
    const [appId, commit, ...extra] = args;
    if (!appId || !commit || extra.length > 0) fail("redeploy requires an app id and full commit SHA");
    if (!/^[a-f0-9]{40}$/.test(commit)) fail("redeploy commit must be a full lowercase SHA");
    return { name, appId, commit };
  }

  if (name === "image-load") {
    const [appId, commit, bytes, ...extra] = args;
    if (!appId || !commit || !bytes || extra.length > 0) fail("image-load requires an app id, full commit SHA, and archive byte size");
    if (!/^[a-f0-9]{40}$/.test(commit)) fail("image-load commit must be a full lowercase SHA");
    if (!/^\d+$/.test(bytes) || Number(bytes) < 1 || Number(bytes) > 16 * 1024 ** 3) fail("image-load archive size must be between 1 byte and 16 GiB");
    return { name, appId, commit, archiveBytes: Number(bytes) };
  }

  if (name === "status") {
    const appId = args.shift();
    if (!appId || appId.startsWith("--")) fail("status requires an app id");
    const jsonCount = args.filter((arg) => arg === "--json").length;
    if (jsonCount > 1) fail("option may only be used once: --json");
    const values = optionValues(args.filter((arg) => arg !== "--json"), new Set(["--commit"]));
    return { name, appId, commit: values.get("--commit"), json: jsonCount === 1 };
  }

  if (name === "add") {
    const separator = args.indexOf("--");
    const beforeCommand = separator === -1 ? [...args] : args.slice(0, separator);
    const testCommand = separator === -1 ? undefined : args.slice(separator + 1);
    if (testCommand?.length === 0) fail("test command after -- must not be empty");
    const domain = beforeCommand.shift();
    if (!domain || domain.startsWith("--")) fail("add requires a domain");
    const dryRunCount = beforeCommand.filter((arg) => arg === "--dry-run").length;
    const yesCount = beforeCommand.filter((arg) => arg === "--yes").length;
    if (dryRunCount > 1) fail("option may only be used once: --dry-run");
    if (yesCount > 1) fail("option may only be used once: --yes");
    const dryRun = dryRunCount === 1;

    const values = optionValues(beforeCommand.filter((arg) => arg !== "--dry-run" && arg !== "--yes"), new Set([
      "--repository",
      "--checkout",
      "--port",
      "--ref",
      "--compose-file",
      "--compose-command",
      "--service",
      "--health-path",
      "--deployment-mode",
    ]));
    const deploymentMode = values.get("--deployment-mode");
    if (deploymentMode !== undefined && deploymentMode !== "build" && deploymentMode !== "prebuilt") fail("--deployment-mode must be build or prebuilt");
    const repositoryValue = values.get("--repository");
    const target = repositoryValue === undefined ? undefined : parseGitHubRepositoryTarget(repositoryValue);
    const repository = target?.repository;
    if (repositoryValue !== undefined && !target) fail("--repository must use github:owner/repo or a GitHub repository URL");
    const explicitRef = values.get("--ref");
    if (target?.ref && explicitRef && target.ref !== explicitRef) fail("GitHub tree URL branch conflicts with --ref");
    const portValue = values.get("--port");
    if (portValue !== undefined && !/^\d+$/.test(portValue)) fail("--port must be an integer");
    const composeFrontend = values.get("--compose-command");
    if (composeFrontend && composeFrontend !== "podman" && composeFrontend !== "podman-compose") {
      fail("--compose-command must be podman or podman-compose");
    }

    return {
      name,
      domain,
      dryRun,
      yes: yesCount === 1,
      repository,
      checkout: values.get("--checkout"),
      hostPort: portValue === undefined ? undefined : Number(portValue),
      testCommand,
      ref: explicitRef ?? target?.ref,
      composeFile: values.get("--compose-file"),
      composeCommand: composeFrontend === "podman-compose" ? ["podman-compose"] : undefined,
      service: values.get("--service"),
      healthPath: values.get("--health-path"),
      deploymentMode,
    };
  }

  fail(name ? `unknown command: ${name}` : "missing command");
}
