import { readFile, statfs } from "node:fs/promises";
import { freemem } from "node:os";
import { composePath, type AppConfig } from "./config";

const MEBIBYTE = 1024 * 1024;

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  capture?: boolean;
  timeoutMs?: number;
  onOutput?(line: string): void | Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface DeploymentLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResourceAvailability {
  memoryBytes: number;
  diskBytes: number;
}

export interface ResourceInspector {
  available(checkout: string): Promise<ResourceAvailability>;
}

export interface DeployDependencies {
  runner: CommandRunner;
  resources: ResourceInspector;
  fetch: Fetcher;
  sleep(milliseconds: number): Promise<void>;
  logger: DeploymentLogger;
  onStage?(stage: string): void | Promise<void>;
  onOutput?(stage: string, line: string): void | Promise<void>;
}

export interface DeployOptions {
  allowAncestor?: boolean;
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
    const pipe = capture || options.onOutput !== undefined;
    let timedOut = false;
    const subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: cleanEnvironment(options.env ?? {}),
      stdin: "ignore",
      stdout: pipe ? "pipe" : "inherit",
      stderr: pipe ? "pipe" : "inherit",
      detached: process.platform !== "win32",
    });
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          try {
            if (process.platform === "win32") subprocess.kill("SIGKILL");
            else process.kill(-subprocess.pid, "SIGKILL");
          } catch {
            subprocess.kill("SIGKILL");
          }
        }, options.timeoutMs);

    const consume = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream): Promise<string> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let value = "";
      let pending = "";
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const text = decoder.decode(chunk, { stream: true });
        if (capture) value += text;
        else target.write(text);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) await options.onOutput?.(line);
      }
      pending += decoder.decode();
      if (pending.trim()) await options.onOutput?.(pending);
      return value;
    };

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        pipe ? consume(subprocess.stdout!, process.stdout) : Promise.resolve(""),
        pipe ? consume(subprocess.stderr!, process.stderr) : Promise.resolve(""),
      ]);
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export class HostResourceInspector implements ResourceInspector {
  async available(checkout: string): Promise<ResourceAvailability> {
    const [memoryBytes, filesystem] = await Promise.all([
      availableMemoryBytes(),
      statfs(checkout),
    ]);
    return {
      memoryBytes,
      diskBytes: filesystem.bavail * filesystem.bsize,
    };
  }
}

async function availableMemoryBytes(): Promise<number> {
  if (process.platform === "linux") {
    const memoryInfo = await readFile("/proc/meminfo", "utf8");
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(memoryInfo);
    if (!available) throw new Error("cannot determine available memory from /proc/meminfo");
    return Number(available[1]) * 1024;
  }
  return freemem();
}

async function runChecked(
  dependencies: DeployDependencies,
  stage: string,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  await dependencies.onStage?.(stage);
  dependencies.logger.info("deployment stage started", { stage });
  const stream = (stage === "build" || stage === "test") && dependencies.onOutput
    ? { ...options, onOutput: (line: string) => dependencies.onOutput?.(stage, line) }
    : options;
  const result = await dependencies.runner.run(command, args, stream);
  if (result.timedOut) {
    throw new DeploymentError(stage, `${stage} timed out after ${options.timeoutMs}ms`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new DeploymentError(stage, detail ? `${stage} failed: ${detail}` : `${stage} failed with exit code ${result.exitCode}`);
  }
  return result;
}

async function checkResources(app: AppConfig, dependencies: DeployDependencies): Promise<void> {
  let available: ResourceAvailability;
  try {
    available = await dependencies.resources.available(app.checkout);
  } catch (error) {
    throw new DeploymentError(
      "preflight",
      `resource preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const memoryMb = Math.floor(available.memoryBytes / MEBIBYTE);
  if (memoryMb < app.minimumFreeMemoryMb) {
    throw new DeploymentError(
      "preflight",
      `resource preflight failed: ${memoryMb} MiB memory available; ${app.minimumFreeMemoryMb} MiB required`,
    );
  }
  const diskMb = Math.floor(available.diskBytes / MEBIBYTE);
  if (diskMb < app.minimumFreeDiskMb) {
    throw new DeploymentError(
      "preflight",
      `resource preflight failed: ${diskMb} MiB disk available; ${app.minimumFreeDiskMb} MiB required`,
    );
  }
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

async function retainReleaseImages(
  appId: string,
  app: AppConfig,
  commit: string,
  releaseTimestamp: number,
  composeExecutable: string,
  compose: string[],
  options: CommandOptions,
  dependencies: DeployDependencies,
): Promise<void> {
  const repository = `localhost/shibumi-server/${appId}`;
  const tag = `release-${releaseTimestamp}-${commit.slice(0, 12)}`;
  const release = `${repository}:${tag}`;

  try {
    const container = await runChecked(
      dependencies,
      "retain",
      "podman",
      [
        "container", "list",
        "--filter", `label=io.podman.compose.project=${app.composeProject}`,
        "--filter", `label=io.podman.compose.service=${app.service}`,
        "--format", "{{.ID}}",
      ],
      { capture: true },
    );
    const containerId = container.stdout.trim().split(/\s+/)[0];
    if (!containerId) throw new DeploymentError("retain", "cannot find the healthy application container");

    const image = await runChecked(
      dependencies,
      "retain",
      "podman",
      ["container", "inspect", "--format", "{{.Image}}", containerId],
      { capture: true },
    );
    const imageId = image.stdout.trim();
    if (!imageId) throw new DeploymentError("retain", "cannot find the healthy application image");

    await runChecked(dependencies, "retain", "podman", ["image", "tag", imageId, release], { capture: true });
    const listed = await runChecked(
      dependencies,
      "retain",
      "podman",
      ["image", "list", "--filter", `reference=${repository}:release-*`, "--format", "{{.Tag}}"],
      { capture: true },
    );
    const releases = new Set(listed.stdout.split(/\r?\n/).filter((value) => /^release-\d{13}-[a-f0-9]{12}$/.test(value)));
    releases.add(tag);
    const retained = app.retainedRollbackImages + 1;
    const expired = [...releases]
      .sort((left, right) => right.localeCompare(left))
      .slice(retained);

    for (const expiredTag of expired) {
      await runChecked(
        dependencies,
        "retain",
        "podman",
        ["image", "rm", `${repository}:${expiredTag}`],
        { capture: true },
      );
    }
    await runChecked(
      dependencies,
      "prune",
      "podman",
      ["image", "prune", "--force"],
      { capture: true, timeoutMs: 60_000 },
    );
  } catch (error) {
    dependencies.logger.error("release image retention failed after a healthy deployment", {
      app: appId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface RunningRelease {
  imageId: string;
  imageName: string;
}

async function runningRelease(
  app: AppConfig,
  composeExecutable: string,
  compose: string[],
  options: CommandOptions,
  dependencies: DeployDependencies,
): Promise<RunningRelease | undefined> {
  const container = await dependencies.runner.run(
    composeExecutable,
    [...compose, "ps", "--quiet", app.service],
    { ...options, capture: true },
  );
  let containerId = container.exitCode === 0 ? container.stdout.trim().split(/\s+/)[0] : undefined;
  if (!containerId) {
    const labeled = await dependencies.runner.run("podman", [
      "container", "list",
      "--filter", `label=io.podman.compose.project=${app.composeProject}`,
      "--filter", `label=io.podman.compose.service=${app.service}`,
      "--format", "{{.ID}}",
    ], { capture: true });
    containerId = labeled.exitCode === 0 ? labeled.stdout.trim().split(/\s+/)[0] : undefined;
  }
  if (!containerId) return undefined;
  const [imageId, imageName] = await Promise.all([
    dependencies.runner.run("podman", ["container", "inspect", "--format", "{{.Image}}", containerId], { capture: true }),
    dependencies.runner.run("podman", ["container", "inspect", "--format", "{{.Config.Image}}", containerId], { capture: true }),
  ]);
  if (imageId.exitCode !== 0 || imageName.exitCode !== 0 || !imageId.stdout.trim() || !imageName.stdout.trim()) return undefined;
  return { imageId: imageId.stdout.trim(), imageName: imageName.stdout.trim() };
}

async function restoreRelease(
  app: AppConfig,
  release: RunningRelease | undefined,
  composeExecutable: string,
  compose: string[],
  options: CommandOptions,
  dependencies: DeployDependencies,
): Promise<void> {
  try {
    if (!release) {
      await runChecked(dependencies, "restore", composeExecutable, [...compose, "down"], options);
      return;
    }
    await runChecked(dependencies, "restore", "podman", ["image", "tag", release.imageId, release.imageName], { capture: true });
    await runChecked(
      dependencies,
      "restore",
      composeExecutable,
      [...compose, "up", "-d", "--no-build", "--force-recreate", app.service],
      options,
    );
    await waitForHealth(app, dependencies);
  } catch (error) {
    throw new DeploymentError("restore", `previous release could not be restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function deploy(
  appId: string,
  app: AppConfig,
  commit: string,
  dependencies: DeployDependencies,
  deployOptions: DeployOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  await dependencies.onStage?.("preflight");
  await checkResources(app, dependencies);
  const git = (args: string[], stage: string, capture = false) =>
    runChecked(dependencies, stage, "git", ["-C", app.checkout, ...args], { capture });

  const status = await git(["status", "--porcelain"], "checkout", true);
  if (status.stdout.trim()) throw new DeploymentError("checkout", "deployment checkout has local changes");

  await git(["fetch", "--prune", "origin", app.ref], "fetch");
  const fetched = await git(["rev-parse", "FETCH_HEAD"], "verify", true);
  if (deployOptions.allowAncestor) {
    await git(["merge-base", "--is-ancestor", commit, "FETCH_HEAD"], "verify");
  } else if (fetched.stdout.trim().toLowerCase() !== commit) {
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

  await runChecked(dependencies, "config", composeExecutable, [...compose, "config", "--quiet"], options);
  await runChecked(
    dependencies,
    "build",
    composeExecutable,
    [...compose, "build"],
    { ...options, timeoutMs: app.buildTimeoutMs },
  );
  if (app.testCommand) {
    await runChecked(
      dependencies,
      "test",
      composeExecutable,
      [...compose, "run", "--rm", app.service, ...app.testCommand],
      options,
    );
  }
  const previous = await runningRelease(app, composeExecutable, compose, options, dependencies);
  try {
    await runChecked(dependencies, "start", composeExecutable, [...compose, "up", "-d", "--remove-orphans", "--force-recreate"], options);
    await dependencies.onStage?.("health");
    await waitForHealth(app, dependencies);
  } catch (error) {
    await restoreRelease(app, previous, composeExecutable, compose, options, dependencies);
    throw error;
  }
  await retainReleaseImages(appId, app, commit, startedAt, composeExecutable, compose, options, dependencies);

  dependencies.logger.info("deployment succeeded", {
    app: appId,
    commit,
    durationMs: Date.now() - startedAt,
  });
}

export function defaultDeployDependencies(logger: DeploymentLogger = console): DeployDependencies {
  return {
    runner: new BunCommandRunner(),
    resources: new HostResourceInspector(),
    fetch,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    logger,
  };
}
