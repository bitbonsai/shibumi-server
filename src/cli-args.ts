export type CliCommand =
  | { name: "help" }
  | { name: "version" }
  | { name: "setup" }
  | { name: "check" | "serve"; config: string }
  | { name: "init" }
  | {
      name: "add";
      domain: string;
      repository?: string;
      checkout?: string;
      hostPort?: number;
      testCommand?: string[];
      ref?: string;
      composeFile?: string;
      composeCommand?: string[];
      service?: string;
      healthPath?: string;
    };

export const usageText = `Usage:
  shibumi-server --help                  Show help
  shibumi-server --version               Show version
  shibumi-server                         Interactive installation
  shibumi-server setup                   Interactive installation
  shibumi-server init                    Install only (automation)
  shibumi-server add <domain>             Add an app interactively
  shibumi-server add <domain> --repository <owner/repo> --checkout <absolute-path> --port <port> [options] [-- <test-command...>]
  shibumi-server check --config <path>
  shibumi-server serve --config <path>

Add options:
  --ref <refs/heads/main>             Git branch ref (default: refs/heads/main)
  --compose-file <path>               Compose file inside checkout (default: compose.yaml)
  --compose-command <frontend>        podman or podman-compose (default: podman)
  --service <name>                    Compose service (default: web)
  --health-path </healthz>            Loopback health path (default: /healthz)`;

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
  if (name === "init") {
    if (args.length > 0) fail("init does not accept arguments");
    return { name };
  }

  if (name === "check" || name === "serve") {
    const values = optionValues(args, new Set(["--config"]));
    return { name, config: required(values, "--config") };
  }

  if (name === "add") {
    const separator = args.indexOf("--");
    const beforeCommand = separator === -1 ? [...args] : args.slice(0, separator);
    const testCommand = separator === -1 ? undefined : args.slice(separator + 1);
    if (testCommand?.length === 0) fail("test command after -- must not be empty");
    const domain = beforeCommand.shift();
    if (!domain || domain.startsWith("--")) fail("add requires a domain");

    const values = optionValues(beforeCommand, new Set([
      "--repository",
      "--checkout",
      "--port",
      "--ref",
      "--compose-file",
      "--compose-command",
      "--service",
      "--health-path",
    ]));
    const portValue = values.get("--port");
    if (portValue !== undefined && !/^\d+$/.test(portValue)) fail("--port must be an integer");
    const composeFrontend = values.get("--compose-command");
    if (composeFrontend && composeFrontend !== "podman" && composeFrontend !== "podman-compose") {
      fail("--compose-command must be podman or podman-compose");
    }

    return {
      name,
      domain,
      repository: values.get("--repository"),
      checkout: values.get("--checkout"),
      hostPort: portValue === undefined ? undefined : Number(portValue),
      testCommand,
      ref: values.get("--ref"),
      composeFile: values.get("--compose-file"),
      composeCommand: composeFrontend === "podman-compose" ? ["podman-compose"] : undefined,
      service: values.get("--service"),
      healthPath: values.get("--health-path"),
    };
  }

  fail(name ? `unknown command: ${name}` : "missing command");
}
