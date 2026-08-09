import { composePath, type AppConfig } from "./config";

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  capture?: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface DeploymentLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DeployDependencies {
  runner: CommandRunner;
  fetch: Fetcher;
  sleep(milliseconds: number): Promise<void>;
  logger: DeploymentLogger;
}

export class DeploymentError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "DeploymentError";
  }
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...extra };
}

export class BunCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    const capture = options.capture ?? false;
    const process = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: cleanEnvironment(options.env ?? {}),
      stdin: "ignore",
      stdout: capture ? "pipe" : "inherit",
      stderr: capture ? "pipe" : "inherit",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      capture ? new Response(process.stdout).text() : Promise.resolve(""),
      capture ? new Response(process.stderr).text() : Promise.resolve(""),
    ]);
    return { exitCode, stdout, stderr };
  }
}

async function runChecked(
  dependencies: DeployDependencies,
  stage: string,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  dependencies.logger.info("deployment stage started", { stage });
  const result = await dependencies.runner.run(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new DeploymentError(stage, detail ? `${stage} failed: ${detail}` : `${stage} failed with exit code ${result.exitCode}`);
  }
  return result;
}

async function waitForHealth(app: AppConfig, dependencies: DeployDependencies): Promise<void> {
  for (let attempt = 1; attempt <= app.healthAttempts; attempt += 1) {
    try {
      const response = await dependencies.fetch(app.healthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(app.healthIntervalMs * 2, 5_000)),
      });
      if (response.ok) return;
    } catch {
      // The app may still be starting. Retry until the configured deadline.
    }
    if (attempt < app.healthAttempts) await dependencies.sleep(app.healthIntervalMs);
  }
  throw new DeploymentError("health", `health check did not pass after ${app.healthAttempts} attempts`);
}

export async function deploy(appId: string, app: AppConfig, commit: string, dependencies: DeployDependencies): Promise<void> {
  const startedAt = Date.now();
  const git = (args: string[], stage: string, capture = false) =>
    runChecked(dependencies, stage, "git", ["-C", app.checkout, ...args], { capture });

  const status = await git(["status", "--porcelain"], "checkout", true);
  if (status.stdout.trim()) throw new DeploymentError("checkout", "deployment checkout has local changes");

  await git(["fetch", "--prune", "origin", app.ref], "fetch");
  const fetched = await git(["rev-parse", "FETCH_HEAD"], "verify", true);
  if (fetched.stdout.trim().toLowerCase() !== commit) {
    throw new DeploymentError("verify", "fetched branch no longer matches the webhook commit");
  }
  await git(["reset", "--hard", commit], "checkout");

  const [composeExecutable, ...composePrefix] = app.composeCommand;
  const compose = [
    ...composePrefix,
    "--project-name",
    app.composeProject,
    "--file",
    composePath(app),
  ];
  const options: CommandOptions = { env: { SHIBUMI_PORT: String(app.hostPort) } };

  await runChecked(dependencies, "build", composeExecutable, [...compose, "build"], options);
  await runChecked(
    dependencies,
    "test",
    composeExecutable,
    [...compose, "run", "--rm", app.service, ...app.testCommand],
    options,
  );
  await runChecked(dependencies, "start", composeExecutable, [...compose, "up", "-d", "--remove-orphans"], options);
  await waitForHealth(app, dependencies);

  dependencies.logger.info("deployment succeeded", {
    app: appId,
    commit,
    durationMs: Date.now() - startedAt,
  });
}

export function defaultDeployDependencies(logger: DeploymentLogger = console): DeployDependencies {
  return {
    runner: new BunCommandRunner(),
    fetch,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    logger,
  };
}
