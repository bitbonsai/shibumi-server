import { randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseConfig, type AppConfig, type ServerConfig } from "./config";
import { BunCommandRunner, type CommandRunner } from "./deploy";

const PACKAGE_FILES = ["src", "docs", "examples", "README.md", "LICENSE", "package.json"];
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface InstallationPaths {
  configDirectory: string;
  config: string;
  secrets: string;
  dataDirectory: string;
  statusDirectory: string;
  releasesDirectory: string;
  currentRelease: string;
  binDirectory: string;
  launcher: string;
  systemdDirectory: string;
  service: string;
}

export interface InitializeOptions {
  home: string;
  packageRoot: string;
  bunExecutable: string;
}

export interface AddAppOptions {
  home: string;
  domain: string;
  repository: string;
  dryRun?: boolean;
  checkout: string;
  hostPort: number;
  testCommand?: string[];
  ref?: string;
  composeFile?: string;
  composeCommand?: string[];
  service?: string;
  healthPath?: string;
  caddyMode?: "preserve" | "managed";
}

export interface AddAppResult {
  appId: string;
  secretEnvironmentVariable: string;
  config: ServerConfig;
}

export interface CheckoutManager {
  prepare(options: Pick<AddAppOptions, "repository" | "ref" | "checkout" | "composeFile">): Promise<void>;
}

export class GitCheckoutManager implements CheckoutManager {
  constructor(private readonly runner: CommandRunner = new BunCommandRunner()) {}

  async prepare(options: Pick<AddAppOptions, "repository" | "ref" | "checkout" | "composeFile">): Promise<void> {
    if (!await exists(options.checkout)) {
      await mkdir(dirname(options.checkout), { recursive: true, mode: 0o700 });
      const branch = (options.ref ?? "refs/heads/main").slice("refs/heads/".length);
      const clone = await this.runner.run("git", [
        "clone", "--branch", branch, "--single-branch", `https://github.com/${options.repository}.git`, options.checkout,
      ], { capture: true, timeoutMs: 120_000 });
      if (clone.exitCode !== 0) {
        throw new Error(`cannot clone ${options.repository}; configure server Git access for private repositories, then clone it into ${options.checkout}`);
      }
    }
    const origin = await this.runner.run("git", ["-C", options.checkout, "remote", "get-url", "origin"], { capture: true });
    if (origin.exitCode !== 0) throw new Error(`checkout ${options.checkout} is not a Git repository with an origin`);
    const expected = options.repository.toLowerCase();
    const actual = origin.stdout.trim().toLowerCase().replace(/\.git$/, "");
    if (!actual.endsWith(`/${expected}`) && !actual.endsWith(`:${expected}`)) {
      throw new Error(`checkout origin does not match ${options.repository}`);
    }
    const access = await this.runner.run("git", [
      "-C", options.checkout, "ls-remote", "--exit-code", "origin", options.ref ?? "refs/heads/main",
    ], { capture: true, timeoutMs: 30_000 });
    if (access.exitCode !== 0) {
      throw new Error(`server cannot fetch ${options.repository}; configure a read-only deploy key or Git credential, then rerun add`);
    }
    if (!await exists(resolve(options.checkout, options.composeFile ?? "compose.yaml"))) {
      throw new Error(`checkout is missing ${options.composeFile ?? "compose.yaml"}`);
    }
  }
}

export interface ServiceManager {
  reload(): Promise<void>;
  reloadUnits(): Promise<void>;
  enableAndRestart(): Promise<void>;
  disableAndStop(): Promise<void>;
}

export class SystemdUserServiceManager implements ServiceManager {
  constructor(private readonly runner: CommandRunner = new BunCommandRunner()) {}

  async reload(): Promise<void> {
    await this.reloadUnits();
    await this.run(["--user", "try-restart", "shibumi-server.service"]);
  }

  async reloadUnits(): Promise<void> {
    await this.run(["--user", "daemon-reload"]);
  }

  async enableAndRestart(): Promise<void> {
    await this.run(["--user", "enable", "shibumi-server.service"]);
    await this.run(["--user", "restart", "shibumi-server.service"]);
  }

  async disableAndStop(): Promise<void> {
    await this.run(["--user", "disable", "--now", "shibumi-server.service"]);
  }

  private async run(args: string[]): Promise<void> {
    const result = await this.runner.run("systemctl", args, { capture: true, timeoutMs: 30_000 });
    if (result.timedOut) throw new Error(`systemctl ${args.slice(1).join(" ")} timed out`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `systemctl ${args.slice(1).join(" ")} failed`);
    }
  }
}

export function installationPaths(home: string): InstallationPaths {
  const configDirectory = join(home, ".config", "shibumi-server");
  const dataDirectory = join(home, ".local", "share", "shibumi-server");
  return {
    configDirectory,
    config: join(configDirectory, "config.json"),
    secrets: join(configDirectory, "secrets.env"),
    dataDirectory,
    statusDirectory: join(dataDirectory, "status"),
    releasesDirectory: join(dataDirectory, "releases"),
    currentRelease: join(dataDirectory, "current"),
    binDirectory: join(home, ".local", "bin"),
    launcher: join(home, ".local", "bin", "shibumi-server"),
    systemdDirectory: join(home, ".config", "systemd", "user"),
    service: join(home, ".config", "systemd", "user", "shibumi-server.service"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function systemdPath(value: string): string {
  if (!isAbsolute(value) || /[\s'"\\%]/.test(value)) {
    throw new Error(`path is unsafe for a systemd unit: ${value}`);
  }
  return value;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function launcher(paths: InstallationPaths, bunExecutable: string): string {
  return `#!/bin/sh\nexec ${shellQuote(bunExecutable)} ${shellQuote(join(paths.currentRelease, "src", "cli.ts"))} "$@"\n`;
}

function serviceUnit(paths: InstallationPaths, bunExecutable: string): string {
  const workingDirectory = systemdPath(paths.currentRelease);
  const environmentFile = systemdPath(paths.secrets);
  systemdPath(bunExecutable);
  systemdPath(join(paths.currentRelease, "src", "cli.ts"));
  systemdPath(paths.config);
  return `[Unit]\nDescription=Shibumi webhook deploy service\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${workingDirectory}\nEnvironmentFile=${environmentFile}\nExecStart=${systemdQuote(bunExecutable)} ${systemdQuote(join(paths.currentRelease, "src", "cli.ts"))} serve --config ${systemdQuote(paths.config)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nMemoryHigh=1280M\nMemoryMax=1536M\nMemorySwapMax=256M\nCPUQuota=200%\nTasksMax=512\nOOMPolicy=stop\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
}

function initialConfig(): Record<string, unknown> {
  return {
    listen: {
      hostname: "127.0.0.1",
      port: 8787,
      maxBodyBytes: 1_048_576,
    },
    apps: {},
  };
}

export async function initializeInstallation(
  options: InitializeOptions,
  services: ServiceManager = new SystemdUserServiceManager(),
): Promise<{ version: string; paths: InstallationPaths }> {
  const packageRoot = resolve(options.packageRoot);
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
    throw new Error("package version is missing or unsafe");
  }

  const paths = installationPaths(resolve(options.home));
  const bunExecutable = resolve(options.bunExecutable);
  const unit = serviceUnit(paths, bunExecutable);
  await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.configDirectory, 0o700);
  await mkdir(paths.releasesDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.statusDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.binDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.systemdDirectory, { recursive: true, mode: 0o700 });

  const release = join(paths.releasesDirectory, packageJson.version);
  if (!await exists(release)) {
    const staging = join(paths.releasesDirectory, `.${packageJson.version}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const entry of PACKAGE_FILES) {
        const source = join(packageRoot, entry);
        if (!await exists(source)) throw new Error(`package is missing ${entry}`);
        await cp(source, join(staging, entry), { recursive: true });
      }
      await rename(staging, release);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  const nextLink = `${paths.currentRelease}.${process.pid}.next`;
  await rm(nextLink, { force: true });
  await symlink(relative(paths.dataDirectory, release), nextLink);
  await rename(nextLink, paths.currentRelease);

  await atomicWrite(paths.launcher, launcher(paths, bunExecutable), 0o755);

  if (!await exists(paths.config)) {
    await atomicWrite(paths.config, `${JSON.stringify(initialConfig(), null, 2)}\n`, 0o600);
  } else {
    await chmod(paths.config, 0o600);
  }
  if (!await exists(paths.secrets)) await atomicWrite(paths.secrets, "", 0o600);
  else await chmod(paths.secrets, 0o600);
  await atomicWrite(paths.service, unit, 0o600);
  await services.reload();

  return { version: packageJson.version, paths };
}

export async function uninstallInstallation(
  home: string,
  purge = false,
  services: ServiceManager = new SystemdUserServiceManager(),
): Promise<InstallationPaths> {
  const paths = installationPaths(resolve(home));
  if (await exists(paths.service)) {
    await services.disableAndStop();
    await rm(paths.service, { force: true });
    await services.reloadUnits();
  }
  await rm(paths.launcher, { force: true });
  await rm(paths.dataDirectory, { recursive: true, force: true });
  if (purge) await rm(paths.configDirectory, { recursive: true, force: true });
  return paths;
}

export function appIdForDomain(domain: string): string {
  const normalized = domain.toLowerCase();
  if (!DOMAIN.test(normalized)) throw new Error("domain must be a lowercase public hostname such as example.com");
  const appId = normalized.replaceAll("-", "--").replaceAll(".", "-");
  if (appId.length > 63) throw new Error("domain is too long to use as an app id");
  return appId;
}

function secretName(appId: string): string {
  return `SHIBUMI_SECRET_${appId.replaceAll("-", "_").toUpperCase()}`;
}

async function rawConfig(path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
  return value as Record<string, unknown>;
}

function sameApp(left: AppConfig, right: AppConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function addApp(
  options: AddAppOptions,
  services: ServiceManager = new SystemdUserServiceManager(),
  checkouts: CheckoutManager = new GitCheckoutManager(),
): Promise<AddAppResult> {
  const paths = installationPaths(resolve(options.home));
  if (!await exists(paths.currentRelease) || !await exists(paths.service)) {
    throw new Error("shibumi-server is not initialized; run init first");
  }
  if (!Number.isInteger(options.hostPort)) throw new Error("port must be an integer");
  if (!isAbsolute(options.checkout)) throw new Error("checkout must be an absolute path");
  if (options.testCommand?.length === 0) throw new Error("test command must not be empty");
  const healthPath = options.healthPath ?? "/healthz";
  if (!/^\/(?!\/)[^?#\0]*$/.test(healthPath)) {
    throw new Error("health path must be an absolute path without a query or fragment");
  }

  const appId = appIdForDomain(options.domain);
  const secretEnvironmentVariable = secretName(appId);
  const root = await rawConfig(paths.config);
  const apps = root.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) throw new Error("config.apps must be an object");

  const candidate = {
    ...root,
    apps: {
      ...(apps as Record<string, unknown>),
      [appId]: {
        domain: options.domain,
        repository: options.repository,
        ref: options.ref ?? "refs/heads/main",
        checkout: options.checkout,
        composeFile: options.composeFile ?? "compose.yaml",
        composeCommand: options.composeCommand ?? ["podman", "compose"],
        composeProject: appId,
        service: options.service ?? "web",
        hostPort: options.hostPort,
        testCommand: options.testCommand,
        healthUrl: `http://127.0.0.1:${options.hostPort}${healthPath}`,
        secretEnvironmentVariable,
        minimumFreeMemoryMb: 2_048,
        minimumFreeDiskMb: 4_096,
        buildTimeoutMs: 600_000,
        healthAttempts: 20,
        healthIntervalMs: 500,
        retainedRollbackImages: 2,
        caddyMode: options.caddyMode,
      },
    },
  };
  const parsed = parseConfig(candidate);
  const existing = (apps as Record<string, unknown>)[appId];
  if (existing !== undefined) {
    const existingConfig = parseConfig(root).apps[appId];
    if (!sameApp(existingConfig, parsed.apps[appId])) throw new Error(`app ${appId} already exists with different settings`);
  }
  if (options.dryRun) return { appId, secretEnvironmentVariable, config: parsed };

  if (existing === undefined) {
    await checkouts.prepare(options);
    const secrets = await readFile(paths.secrets, "utf8");
    const existingSecret = new RegExp(`^${secretEnvironmentVariable}=([^\\r\\n]*)$`, "m").exec(secrets)?.[1];
    if (existingSecret !== undefined && !/^[a-f0-9]{64}$/.test(existingSecret)) {
      throw new Error(`${secretEnvironmentVariable} exists but is not a 32-byte hex secret`);
    }
    if (existingSecret === undefined) {
      const secret = randomBytes(32).toString("hex");
      const prefix = secrets.length === 0 || secrets.endsWith("\n") ? secrets : `${secrets}\n`;
      await atomicWrite(paths.secrets, `${prefix}${secretEnvironmentVariable}=${secret}\n`, 0o600);
    }
    await atomicWrite(paths.config, `${JSON.stringify(candidate, null, 2)}\n`, 0o600);
  }

  await services.enableAndRestart();
  return { appId, secretEnvironmentVariable, config: parsed };
}

export async function markCaddyManaged(home: string, appId: string): Promise<void> {
  const paths = installationPaths(resolve(home));
  const root = await rawConfig(paths.config);
  const apps = root.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) throw new Error("config.apps must be an object");
  const app = (apps as Record<string, unknown>)[appId];
  if (!app || typeof app !== "object" || Array.isArray(app)) throw new Error(`unknown app: ${appId}`);
  const candidate = {
    ...root,
    apps: { ...apps as Record<string, unknown>, [appId]: { ...app as Record<string, unknown>, caddyMode: "managed" } },
  };
  parseConfig(candidate);
  await atomicWrite(paths.config, `${JSON.stringify(candidate, null, 2)}\n`, 0o600);
}
