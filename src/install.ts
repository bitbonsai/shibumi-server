import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, chmod, cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseConfig, type AppConfig, type ServerConfig } from "./config";
import { BunCommandRunner, type CommandRunner } from "./deploy";
import { SHIP_INSTALL_COMMAND } from "./terminal-ui";
import { appEnvPath } from "./app-env";

const PACKAGE_FILES = ["src", "docs", "examples", "README.md", "LICENSE", "package.json", "runtime-lock.json"];
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface InstallationPaths {
  configDirectory: string;
  config: string;
  secrets: string;
  dataDirectory: string;
  statusDirectory: string;
  historyDirectory: string;
  logsDirectory: string;
  releasesDirectory: string;
  currentRelease: string;
  binDirectory: string;
  launcher: string;
  shortLauncher: string;
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
  deploymentMode?: "build" | "prebuilt";
  caddyMode?: "preserve" | "managed";
}

export interface AddAppResult {
  appId: string;
  secretEnvironmentVariable: string;
  config: ServerConfig;
}

export interface RegisteredApp {
  appId: string;
  domain: string;
  repository: string;
  checkout: string;
  hostPort: number;
  healthUrl: string;
  healthIntervalMs: number;
  caddyMode?: "preserve" | "managed";
}

export interface RemoveAppResult {
  app: RegisteredApp;
  remainingApps: number;
  containerWarning?: string;
}

export interface CheckoutManager {
  prepare(options: Pick<AddAppOptions, "repository" | "ref" | "checkout" | "composeFile">): Promise<string>;
}

export interface CheckoutMismatch {
  checkout: string;
  backup: string;
  repository: string;
}

export type ConfirmCheckoutReplacement = (mismatch: CheckoutMismatch) => Promise<boolean>;

export class GitCheckoutManager implements CheckoutManager {
  constructor(
    private readonly runner: CommandRunner = new BunCommandRunner(),
    private readonly confirmReplacement?: ConfirmCheckoutReplacement,
  ) {}

  async prepare(options: Pick<AddAppOptions, "repository" | "ref" | "checkout" | "composeFile">): Promise<string> {
    const existingCheckout = await exists(options.checkout);
    if (!existingCheckout) {
      await mkdir(dirname(options.checkout), { recursive: true, mode: 0o700 });
      const branch = (options.ref ?? "refs/heads/main").slice("refs/heads/".length);
      const clone = await this.runner.run("git", [
        "clone", "--branch", branch, "--single-branch", `https://github.com/${options.repository}.git`, options.checkout,
      ], { capture: true, timeoutMs: 120_000 });
      if (clone.exitCode !== 0) {
        throw new Error(`cannot clone ${options.repository}.\n\nNext: verify repository access, then rerun add. Private repositories need a read-only deploy key or Git credential on this server.`);
      }
    }
    const origin = await this.runner.run("git", ["-C", options.checkout, "remote", "get-url", "origin"], { capture: true });
    if (origin.exitCode !== 0) throw new Error(`checkout ${options.checkout} is not a Git repository with an origin.\n\nNext: move it aside or choose another deployment path, then rerun add.`);
    const expected = options.repository.toLowerCase();
    const actual = origin.stdout.trim().toLowerCase().replace(/\.git$/, "");
    if (!actual.endsWith(`/${expected}`) && !actual.endsWith(`:${expected}`)) {
      const backup = `${options.checkout}.bak`;
      if (await exists(backup)) {
        throw new Error(`checkout origin does not match ${options.repository}, and ${backup} already exists.\n\nNext: remove or rename ${backup}, then rerun add.`);
      }
      const proceed = this.confirmReplacement
        ? await this.confirmReplacement({ checkout: options.checkout, backup, repository: options.repository })
        : false;
      if (!proceed) {
        throw new Error(`checkout origin does not match ${options.repository}.\n\nNext: choose the checkout for ${options.repository}, fix its origin, or rerun add --yes to move it to ${backup} and clone fresh.`);
      }
      await rename(options.checkout, backup);
      return this.prepare(options);
    }
    const access = await this.runner.run("git", [
      "-C", options.checkout, "ls-remote", "--exit-code", "origin", options.ref ?? "refs/heads/main",
    ], { capture: true, timeoutMs: 30_000 });
    if (access.exitCode !== 0) {
      throw new Error(`server cannot fetch ${options.repository}.\n\nNext: configure a read-only deploy key or Git credential, then rerun add.`);
    }
    const remoteCommit = access.stdout.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40}$/.test(remoteCommit)) throw new Error(`cannot resolve ${options.ref ?? "refs/heads/main"} on origin.\n\nNext: push that branch, then rerun add.`);

    if (existingCheckout) {
      const status = await this.runner.run("git", ["-C", options.checkout, "status", "--porcelain"], { capture: true });
      if (status.exitCode !== 0 || status.stdout.trim()) {
        throw new Error(`checkout has uncommitted changes.\n\nNext: commit and push them, or clean the checkout, then rerun add.`);
      }
      const fetch = await this.runner.run("git", ["-C", options.checkout, "fetch", "--quiet", "origin", options.ref ?? "refs/heads/main"], { capture: true, timeoutMs: 120_000 });
      if (fetch.exitCode !== 0) throw new Error(`cannot update checkout from origin.\n\nNext: verify Git access and branch name, then rerun add.`);
      const fetched = await this.runner.run("git", ["-C", options.checkout, "rev-parse", "FETCH_HEAD"], { capture: true });
      if (fetched.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(fetched.stdout.trim())) throw new Error(`cannot resolve fetched branch.\n\nNext: verify the branch on origin, then rerun add.`);
      const merge = await this.runner.run("git", ["-C", options.checkout, "merge", "--ff-only", "FETCH_HEAD"], { capture: true, timeoutMs: 30_000 });
      if (merge.exitCode !== 0) throw new Error(`checkout cannot fast-forward to origin.\n\nNext: push local commits or reset the checkout to origin, then rerun add.`);
      const head = await this.runner.run("git", ["-C", options.checkout, "rev-parse", "HEAD"], { capture: true });
      if (head.exitCode !== 0 || head.stdout.trim() !== fetched.stdout.trim()) {
        throw new Error(`checkout does not match ${options.ref ?? "refs/heads/main"} on origin.\n\nNext: push local commits or reset the checkout to origin, then rerun add.`);
      }
    }

    const composeFile = options.composeFile ?? "compose.yaml";
    if (await exists(resolve(options.checkout, composeFile))) return composeFile;
    const tracked = await this.runner.run("git", ["-C", options.checkout, "ls-files"], { capture: true });
    const candidates = tracked.stdout.split(/\r?\n/).filter((file) => /(^|\/)(?:compose\.ya?ml|docker-compose\.ya?ml)$/.test(file));
    if (options.composeFile === undefined && candidates.length === 1) return candidates[0];
    const found = candidates.length === 1 ? `\n\nFound ${candidates[0]}. Rerun add with --compose-file ${candidates[0]}.` : "";
    throw new Error(`repository is missing ${composeFile}.${found}\n\nNext: from the local project root, run:\n${SHIP_INSTALL_COMMAND}\n\nThe installer adds ship scripts and uses one detected Compose file without overwriting owned files.`);
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
    historyDirectory: join(dataDirectory, "history"),
    logsDirectory: join(dataDirectory, "logs"),
    releasesDirectory: join(dataDirectory, "releases"),
    currentRelease: join(dataDirectory, "current"),
    binDirectory: join(home, ".local", "bin"),
    launcher: join(home, ".local", "bin", "shibumi-server"),
    shortLauncher: join(home, ".local", "bin", "shis"),
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

const DEFAULT_SYSTEM_BIN_DIRECTORY = "/usr/local/bin";
const PROFILE_PATH_MARK = "# shibumi-server: keep shis on PATH for non-interactive SSH sessions";

export interface PathIntegrationResult {
  method: "symlink" | "profile-appended" | "profile-existing" | "skipped";
  detail: string;
}

async function canWrite(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// True only for a symlink shibumi-server itself created (its target lives
// inside our own ~/.local/bin). Anything else at that path — a real binary,
// or someone else's symlink — is left alone rather than clobbered.
async function isManagedLink(link: string, binDirectory: string): Promise<boolean> {
  try {
    const stats = await lstat(link);
    if (!stats.isSymbolicLink()) return false;
    const target = await readlink(link);
    const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(link), target);
    return resolvedTarget === binDirectory || resolvedTarget.startsWith(`${binDirectory}/`);
  } catch {
    return false;
  }
}

interface CreatedLink {
  link: string;
  // Set when this link previously pointed at one of our own launchers, so a
  // failed second link can restore it instead of just deleting it — a rolled
  // back attempt must never leave the host worse off than before it started.
  priorTarget?: string;
}

async function rollbackLinks(created: CreatedLink[], restore: (link: string, priorTarget?: string) => Promise<void>): Promise<void> {
  for (const { link, priorTarget } of created) await restore(link, priorTarget).catch(() => {});
}

interface SymlinkOutcome {
  ok: boolean;
  reason?: string;
}

async function symlinkLaunchers(
  paths: InstallationPaths,
  systemBinDirectory: string,
  runner: CommandRunner,
  tryPasswordlessSudo: boolean,
): Promise<SymlinkOutcome> {
  const links: Array<[string, string]> = [
    [paths.shortLauncher, join(systemBinDirectory, "shis")],
    [paths.launcher, join(systemBinDirectory, "shibumi-server")],
  ];
  if (await canWrite(systemBinDirectory)) {
    const created: CreatedLink[] = [];
    try {
      for (const [target, link] of links) {
        const managed = await isManagedLink(link, paths.binDirectory);
        if (await exists(link) && !managed) {
          throw new Error(`${link} already exists and is not a shibumi-server symlink`);
        }
        const priorTarget = managed ? await readlink(link).catch(() => undefined) : undefined;
        await rm(link, { force: true }).catch(() => {});
        await symlink(target, link);
        created.push({ link, priorTarget });
      }
      return { ok: true };
    } catch (error) {
      await rollbackLinks(created, async (link, priorTarget) => {
        await rm(link, { force: true });
        if (priorTarget) await symlink(priorTarget, link);
      });
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!tryPasswordlessSudo) return { ok: false };
  const created: CreatedLink[] = [];
  for (const [target, link] of links) {
    const priorTarget = (await isManagedLink(link, paths.binDirectory)) ? await readlink(link).catch(() => undefined) : undefined;
    const result = await runner.run("sudo", ["-n", "ln", "-sf", target, link], { capture: true, timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      await rollbackLinks(created, async (createdLink, createdPriorTarget) => {
        if (createdPriorTarget) await runner.run("sudo", ["-n", "ln", "-sf", createdPriorTarget, createdLink], { capture: true, timeoutMs: 10_000 });
        else await runner.run("sudo", ["-n", "rm", "-f", createdLink], { capture: true, timeoutMs: 10_000 });
      });
      return { ok: false, reason: result.stderr.trim() || `sudo could not link ${link}` };
    }
    created.push({ link, priorTarget });
  }
  return { ok: true };
}

function profileDetail(outcome: "appended" | "existing", paths: InstallationPaths, systemBinDirectory: string, reason?: string): string {
  const lead = outcome === "existing" ? `${paths.binDirectory} is already on PATH via ~/.profile` : `${paths.binDirectory} added to ~/.profile`;
  const why = reason ? ` (symlink skipped: ${reason})` : "";
  return `${lead}${why} — only takes effect for login shells, so some "ssh host shis ..." sessions still won't see it. For a fix that always works, run: sudo ln -sf ${paths.shortLauncher} ${systemBinDirectory}/shis`;
}

async function appendProfilePath(home: string, binDirectory: string): Promise<"appended" | "existing"> {
  const profilePath = join(home, ".profile");
  let content = "";
  try {
    content = await readFile(profilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const exportLine = `export PATH="${binDirectory}:$PATH"`;
  // Distros commonly ship ~/.profile with the $HOME-relative spelling; treat
  // it as equivalent so an already-correct profile doesn't get a duplicate.
  const homeRelative = binDirectory.startsWith(`${home}/`) ? binDirectory.slice(home.length) : undefined;
  const homeExportLine = homeRelative !== undefined ? `export PATH="$HOME${homeRelative}:$PATH"` : undefined;
  if (content.includes(PROFILE_PATH_MARK) || content.includes(exportLine) || (homeExportLine !== undefined && content.includes(homeExportLine))) {
    return "existing";
  }
  let addition = "";
  if (content.length > 0) {
    if (!content.endsWith("\n")) addition += "\n";
    addition += "\n";
  }
  addition += `${PROFILE_PATH_MARK}\n${exportLine}\n`;
  // Append-only, never replace: a temp-file-then-rename would swap out a
  // ~/.profile that's a symlink into a dotfile manager's repo for a plain
  // file, and would force a mode instead of preserving whatever the file
  // already had (0600, say). appendFile does neither: it writes through an
  // existing symlink and only sets a mode when the file doesn't exist yet.
  await appendFile(profilePath, addition, { mode: 0o644 });
  return "appended";
}

// Writes only the ~/.profile fallback, without retrying any symlink attempt.
// Callers that already know the user declined sudo (or that it failed) must
// use this directly rather than ensurePathIntegration, which would otherwise
// retry a passwordless `sudo -n` symlink regardless of that decision — and
// succeed anyway if sudo credentials happen to be cached.
export async function applyProfileFallback(
  home: string,
  paths: InstallationPaths,
  systemBinDirectory: string = DEFAULT_SYSTEM_BIN_DIRECTORY,
  reason?: string,
): Promise<PathIntegrationResult> {
  const outcome = await appendProfilePath(home, paths.binDirectory);
  return { method: outcome === "existing" ? "profile-existing" : "profile-appended", detail: profileDetail(outcome, paths, systemBinDirectory, reason) };
}

// Tries the part of PATH integration that never prompts or mutates ~/.profile:
// a direct write, or a passwordless (`sudo -n`) symlink, into systemBinDirectory.
// Callers decide separately whether to ask for a real sudo password afterward.
export async function trySymlinkPath(
  paths: InstallationPaths,
  options: { allowSudoPrompt?: boolean; systemBinDirectory?: string } = {},
  runner: CommandRunner = new BunCommandRunner(),
): Promise<{ symlinked: boolean; systemBinDirectory: string; reason?: string }> {
  const systemBinDirectory = options.systemBinDirectory ?? DEFAULT_SYSTEM_BIN_DIRECTORY;
  let outcome = await symlinkLaunchers(paths, systemBinDirectory, runner, true);
  if (!outcome.ok && options.allowSudoPrompt) {
    try {
      const authorization = await runner.run("sudo", ["-v"], { capture: false, stdin: "inherit", timeoutMs: 120_000 });
      if (authorization.exitCode === 0) outcome = await symlinkLaunchers(paths, systemBinDirectory, runner, true);
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { symlinked: outcome.ok, systemBinDirectory, reason: outcome.ok ? undefined : outcome.reason };
}

// Non-interactive `ssh host shis ...` sessions often skip ~/.local/bin: many
// shells only read ~/.profile for login shells, and some skip it entirely for
// a single remote command. A real symlink in /usr/local/bin is the only fix
// that works everywhere, so it is tried first; ~/.profile is a best-effort
// fallback that only helps when the remote shell treats the session as login.
export async function ensurePathIntegration(
  home: string,
  paths: InstallationPaths,
  options: { allowSudoPrompt?: boolean; systemBinDirectory?: string; profileFallback?: boolean } = {},
  runner: CommandRunner = new BunCommandRunner(),
): Promise<PathIntegrationResult> {
  const { symlinked, systemBinDirectory, reason } = await trySymlinkPath(paths, options, runner);
  if (symlinked) {
    return { method: "symlink", detail: `${systemBinDirectory}/shis -> ${paths.shortLauncher}` };
  }
  if (options.profileFallback === false) {
    return {
      method: "skipped",
      detail: `${paths.binDirectory} may not be reachable from non-interactive SSH sessions${reason ? ` (${reason})` : ""}. Run shis init to retry, or symlink manually: sudo ln -sf ${paths.shortLauncher} ${systemBinDirectory}/shis`,
    };
  }
  return applyProfileFallback(home, paths, systemBinDirectory, reason);
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
  return `[Unit]\nDescription=Shibumi webhook deploy service\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${workingDirectory}\nEnvironmentFile=${environmentFile}\nExecStart=${systemdQuote(bunExecutable)} ${systemdQuote(join(paths.currentRelease, "src", "cli.ts"))} serve --config ${systemdQuote(paths.config)}\nRestart=on-failure\nRestartSec=5\nKillMode=process\nTimeoutStopSec=30\nMemoryHigh=1280M\nMemoryMax=1536M\nMemorySwapMax=256M\nCPUQuota=200%\nTasksMax=512\nOOMPolicy=stop\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
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
  await mkdir(paths.historyDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 });
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
      await rename(join(staging, "runtime-lock.json"), join(staging, "bun.lock"));
      const dependencies = Bun.spawn([
        bunExecutable, "install", "--frozen-lockfile", "--production", "--ignore-scripts",
      ], { cwd: staging, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const [exitCode, stderr] = await Promise.all([
        dependencies.exited,
        new Response(dependencies.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(stderr.trim() || "cannot install pinned runtime dependencies");
      await rename(staging, release);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  const nextLink = `${paths.currentRelease}.${process.pid}.next`;
  await rm(nextLink, { force: true });
  await symlink(relative(paths.dataDirectory, release), nextLink);
  await rename(nextLink, paths.currentRelease);

  const launcherSource = launcher(paths, bunExecutable);
  await atomicWrite(paths.launcher, launcherSource, 0o755);
  await atomicWrite(paths.shortLauncher, launcherSource, 0o755);

  if (!await exists(paths.config)) {
    await atomicWrite(paths.config, `${JSON.stringify(initialConfig(), null, 2)}\n`, 0o600);
  } else {
    const config = await rawConfig(paths.config);
    const apps = config.apps;
    let migrated = false;
    if (apps && typeof apps === "object" && !Array.isArray(apps)) {
      for (const app of Object.values(apps)) {
        if (app && typeof app === "object" && !Array.isArray(app) && Number((app as Record<string, unknown>).retainedRollbackImages) > 1) {
          (app as Record<string, unknown>).retainedRollbackImages = 1;
          migrated = true;
        }
      }
    }
    if (migrated) await atomicWrite(paths.config, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    else await chmod(paths.config, 0o600);
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
  await rm(paths.shortLauncher, { force: true });
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

  let composeFile = options.composeFile ?? "compose.yaml";
  const candidateWithCompose = (file: string) => ({
    ...root,
    apps: {
      ...(apps as Record<string, unknown>),
      [appId]: {
        domain: options.domain,
        repository: options.repository,
        ref: options.ref ?? "refs/heads/main",
        checkout: options.checkout,
        composeFile: file,
        composeCommand: options.composeCommand ?? ["podman", "compose"],
        composeProject: appId,
        service: options.service ?? "web",
        hostPort: options.hostPort,
        testCommand: options.testCommand,
        healthUrl: `http://127.0.0.1:${options.hostPort}${healthPath}`,
        secretEnvironmentVariable,
        minimumFreeMemoryMb: options.deploymentMode === "prebuilt" ? 512 : 2_048,
        minimumFreeDiskMb: 4_096,
        buildTimeoutMs: 600_000,
        healthAttempts: 20,
        healthIntervalMs: 500,
        releaseRetention: 2,
        deploymentMode: options.deploymentMode ?? "build",
        caddyMode: options.caddyMode,
      },
    },
  });
  let candidate = candidateWithCompose(composeFile);
  let parsed = parseConfig(candidate);
  const existing = (apps as Record<string, unknown>)[appId];
  if (existing !== undefined) {
    const existingConfig = parseConfig(root).apps[appId];
    if (!sameApp(existingConfig, parsed.apps[appId])) throw new Error(`app ${appId} already exists with different settings`);
  }
  if (options.dryRun) return { appId, secretEnvironmentVariable, config: parsed };

  if (existing === undefined) {
    composeFile = await checkouts.prepare(options);
    candidate = candidateWithCompose(composeFile);
    parsed = parseConfig(candidate);
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

export async function setDeploymentMode(
  home: string,
  appId: string,
  mode: "build" | "prebuilt",
  services: ServiceManager = new SystemdUserServiceManager(),
): Promise<void> {
  const paths = installationPaths(resolve(home));
  const root = await rawConfig(paths.config);
  const apps = root.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) throw new Error("config.apps must be an object");
  const app = (apps as Record<string, unknown>)[appId];
  if (!app || typeof app !== "object" || Array.isArray(app)) throw new Error(`unknown app: ${appId}`);
  const candidate = {
    ...root,
    apps: {
      ...apps as Record<string, unknown>,
      [appId]: { ...app as Record<string, unknown>, deploymentMode: mode, minimumFreeMemoryMb: mode === "prebuilt" ? 512 : 2_048 },
    },
  };
  parseConfig(candidate);
  await atomicWrite(paths.config, `${JSON.stringify(candidate, null, 2)}\n`, 0o600);
  await services.enableAndRestart();
}

export async function enablePrebuiltApp(
  home: string,
  appId: string,
  services: ServiceManager = new SystemdUserServiceManager(),
): Promise<void> {
  await setDeploymentMode(home, appId, "prebuilt", services);
}

export async function registeredApps(home: string): Promise<RegisteredApp[]> {
  const paths = installationPaths(resolve(home));
  const root = await rawConfig(paths.config);
  const rawApps = root.apps;
  if (!rawApps || typeof rawApps !== "object" || Array.isArray(rawApps)) throw new Error("config.apps must be an object");
  if (Object.keys(rawApps).length === 0) return [];
  const apps = parseConfig(root).apps;
  return Object.entries(apps).map(([appId, app]) => ({
    appId,
    domain: app.domain ?? appId,
    repository: app.repository,
    checkout: app.checkout,
    hostPort: app.hostPort,
    healthUrl: app.healthUrl,
    healthIntervalMs: app.healthIntervalMs,
    caddyMode: app.caddyMode,
  })).sort((left, right) => left.domain.localeCompare(right.domain));
}

export async function removeApp(
  home: string,
  selector: string,
  services: ServiceManager = new SystemdUserServiceManager(),
  runner: CommandRunner = new BunCommandRunner(),
): Promise<RemoveAppResult> {
  const paths = installationPaths(resolve(home));
  const root = await rawConfig(paths.config);
  const parsed = parseConfig(root);
  const match = Object.entries(parsed.apps).find(([appId, app]) => appId === selector || app.domain === selector);
  if (!match) throw new Error(`unknown app: ${selector}.\n\nNext: run shis list and choose a domain or app ID.`);
  const [appId, app] = match;
  const appRecord: RegisteredApp = {
    appId,
    domain: app.domain ?? appId,
    repository: app.repository,
    checkout: app.checkout,
    hostPort: app.hostPort,
    healthUrl: app.healthUrl,
    healthIntervalMs: app.healthIntervalMs,
    caddyMode: app.caddyMode,
  };

  const nextApps = { ...(root.apps as Record<string, unknown>) };
  delete nextApps[appId];
  const candidate = { ...root, apps: nextApps };
  if (Object.keys(nextApps).length > 0) parseConfig(candidate);

  const secrets = await readFile(paths.secrets, "utf8");
  const nextSecrets = secrets.split(/(?<=\n)/).filter((line) => !line.startsWith(`${app.secretEnvironmentVariable}=`)).join("");
  await atomicWrite(paths.config, `${JSON.stringify(candidate, null, 2)}\n`, 0o600);
  await atomicWrite(paths.secrets, nextSecrets, 0o600);
  await rm(join(paths.statusDirectory, `${appId}.json`), { force: true });
  await rm(join(paths.statusDirectory, "queue", `${appId}.json`), { force: true });
  await rm(join(paths.historyDirectory, `${appId}.jsonl`), { force: true });
  await rm(join(paths.logsDirectory, `${appId}.log`), { force: true });
  // The per-app environment store holds secrets; removal must not leave them
  // on disk after the app is gone.
  await rm(appEnvPath(paths.configDirectory, appId), { force: true });

  let containerWarning: string | undefined;
  const [executable, ...prefix] = app.composeCommand;
  const stopped = await runner.run(executable, [
    ...prefix,
    "--project-name", app.composeProject,
    "--file", resolve(app.checkout, app.composeFile),
    "down",
  ], { capture: true, timeoutMs: 120_000, env: { SHIBUMI_PORT: String(app.hostPort) } });
  if (stopped.exitCode !== 0) containerWarning = stopped.stderr.trim() || `${executable} compose down failed`;

  if (Object.keys(nextApps).length === 0) await services.disableAndStop();
  else await services.enableAndRestart();
  return { app: appRecord, remainingApps: Object.keys(nextApps).length, containerWarning };
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

export interface SetRepositoryResult {
  appId: string;
  domain: string;
  checkout: string;
  backup: string;
  repository: string;
  ref: string;
}

export async function setAppRepository(
  home: string,
  selector: string,
  repository: string,
  ref: string | undefined,
  services: ServiceManager = new SystemdUserServiceManager(),
  checkouts: CheckoutManager = new GitCheckoutManager(),
): Promise<SetRepositoryResult> {
  const paths = installationPaths(resolve(home));
  const root = await rawConfig(paths.config);
  const rawApps = root.apps;
  if (!rawApps || typeof rawApps !== "object" || Array.isArray(rawApps)) throw new Error("config.apps must be an object");
  if (Object.keys(rawApps).length === 0) throw new Error(`unknown app: ${selector}.\n\nNext: run shis list and choose a domain or app ID.`);
  const parsed = parseConfig(root);
  const match = Object.entries(parsed.apps).find(([appId, app]) => appId === selector || app.domain === selector);
  if (!match) throw new Error(`unknown app: ${selector}.\n\nNext: run shis list and choose a domain or app ID.`);
  const [appId, app] = match;
  const backup = `${app.checkout}.bak`;
  if (await exists(backup)) {
    throw new Error(`${backup} already exists.\n\nNext: remove or rename ${backup}, then rerun set-repository.`);
  }
  const nextRef = ref ?? app.ref;

  // Validate the new repository/ref against config.apps.*.repository|ref grammar
  // before touching the checkout, so a bad value never leaves the app mid-move.
  const apps = root.apps as Record<string, unknown>;
  const existingApp = apps[appId] as Record<string, unknown>;
  parseConfig({ ...root, apps: { ...apps, [appId]: { ...existingApp, repository, ref: nextRef } } });

  await rename(app.checkout, backup);
  // Re-detects the Compose file for the new repository rather than reusing the
  // old app.composeFile: set-repository exists precisely to swap in an
  // unrelated repo, so assuming its layout matches the old one is unsafe.
  let candidate: { apps: Record<string, unknown> } & Record<string, unknown>;
  try {
    const composeFile = await checkouts.prepare({ repository, ref: nextRef, checkout: app.checkout });
    candidate = {
      ...root,
      apps: { ...apps, [appId]: { ...existingApp, repository, ref: nextRef, composeFile } },
    };
    parseConfig(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      // The failure may have happened after a real clone already populated
      // app.checkout (e.g. during Compose-file detection); a plain rename
      // back onto that non-empty directory would fail, so clear it first.
      await rm(app.checkout, { recursive: true, force: true });
      await rename(backup, app.checkout);
    } catch (revertError) {
      throw new Error(`${message}\n\nThe original checkout could not be restored from ${backup}: ${revertError instanceof Error ? revertError.message : String(revertError)}.\n\nNext: manually move ${backup} back to ${app.checkout}.`);
    }
    throw error;
  }

  await atomicWrite(paths.config, `${JSON.stringify(candidate, null, 2)}\n`, 0o600);
  await services.enableAndRestart();
  return { appId, domain: app.domain ?? appId, checkout: app.checkout, backup, repository, ref: nextRef };
}
