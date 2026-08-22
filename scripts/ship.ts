#!/usr/bin/env bun

/**
 * Project-owned client for shibumi-server.
 *
 * `bun ship:setup` connects this repository to one server and creates its
 * deployment trigger. Later, `bun ship` checks local work, pushes one commit,
 * triggers it over SSH by default, and follows status until the app is healthy.
 *
 * Commit this file and shibumi-server.json. SSH targets stay in machine-local
 * Shibumi config. Webhook secrets stay on the server and pass directly to GitHub CLI.
 */

import { cancel, confirm, intro, isCancel, log, outro, select, spinner as animatedSpinner, text } from "@clack/prompts";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const configPath = join(root, "shibumi-server.json");
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SSH_TARGET = /^(?!-)[A-Za-z0-9_.@:-]+$/;
const SERVER_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SERVER_CLI = "~/.local/bin/shibumi-server";
const LATEST_SOURCE = "https://shibumistack.dev/ship/latest.ts";
const CURRENT_SOURCE = "https://shibumistack.dev/ship/v41.ts";
let sshControlDirectory: string | undefined;
let sshControlTarget: string | undefined;

export function supportsTerminalColor(env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean {
  return isTTY && !("NO_COLOR" in env) && env.TERM !== "dumb";
}

const accent = (value: string) => supportsTerminalColor()
  ? `\x1b[38;5;208m${value}\x1b[0m`
  : value;

interface ClientConfig {
  version: 1;
  provider: "shibumi-server";
  server: { hostname: string };
  domain: string;
  appId: string;
  repository: `github:${string}`;
  branch: string;
  webhookUrl: string;
  service: string;
  port: number;
  healthPath: string;
  deploymentMode: "build" | "prebuilt";
  trigger: "ship" | "github-push";
  platform?: `linux/${string}`;
  cutoverRequired: boolean;
}

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DeployStatus {
  commit: string;
  state: "accepted" | "running" | "succeeded" | "failed";
  stage: string;
  message?: string;
  output?: string;
  url?: string;
  queuedCommit?: string;
  updatedAt: string;
}

interface HistoryEntry {
  commit?: string;
  kind?: string;
  state?: string;
  stage?: string;
  durationMs?: number;
}

interface ShipOptions {
  setup: boolean;
  update: boolean;
  rollback: boolean;
  logs: boolean;
  status: boolean;
  dev: boolean;
  rebuild: boolean;
  yes: boolean;
  server?: string;
  domain?: string;
  trigger?: "ship" | "github-push";
}

let options: ShipOptions = { setup: false, update: false, rollback: false, logs: false, status: false, dev: false, rebuild: false, yes: false };
let agentRun = false;

export function isAgentExecution(env: NodeJS.ProcessEnv = process.env, stdinTTY = Boolean(process.stdin.isTTY), stdoutTTY = Boolean(process.stdout.isTTY)): boolean {
  return !stdinTTY || !stdoutTTY || env.PI_CODING_AGENT === "true" || env.CLAUDECODE === "1"
    || Object.keys(env).some((key) => /^(?:CODEX_|CURSOR_AGENT|AIDER_)/.test(key));
}

export function shouldAnimateProgress(agentExecution: boolean, stdoutTTY: boolean): boolean {
  return !agentExecution && stdoutTTY;
}

type ShipSpinner = {
  start(message?: string): void;
  message(message?: string): void;
  stop(message?: string, code?: number): void;
};

function spinner(): ShipSpinner {
  if (shouldAnimateProgress(agentRun, Boolean(process.stdout.isTTY))) {
    // Clack 1.x split error stops into error(); 0.7 (pinned by older installers)
    // only has stop(message, code). Support both at runtime.
    const animated = animatedSpinner() as ShipSpinner & { error?: (message?: string) => void };
    return {
      start: (message) => animated.start(message),
      message: (message) => animated.message(message),
      stop: (message, code) => code && typeof animated.error === "function"
        ? animated.error(message)
        : animated.stop(message, code),
    };
  }
  const write = (message?: string, error = false) => {
    if (message) (error ? process.stderr : process.stdout).write(`${message}\n`);
  };
  return {
    start: (message) => write(message),
    message: (message) => write(message),
    stop: (message, code) => write(message, Boolean(code)),
  };
}

export function parseShipArgs(args: string[]): ShipOptions {
  const parsed: ShipOptions = { setup: false, update: false, rollback: false, logs: false, status: false, dev: false, rebuild: false, yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--setup") parsed.setup = true;
    else if (argument === "--update") parsed.update = true;
    else if (argument === "--rollback") parsed.rollback = true;
    else if (argument === "--logs") parsed.logs = true;
    else if (argument === "--status") parsed.status = true;
    else if (argument === "--dev") parsed.dev = true;
    else if (argument === "--rebuild") parsed.rebuild = true;
    else if (argument === "--yes" || argument === "-y") parsed.yes = true;
    else if (argument === "--server" || argument === "--domain" || argument === "--trigger") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
      if (argument === "--server") parsed.server = value;
      else if (argument === "--domain") parsed.domain = value;
      else if (value === "ship" || value === "github-push") parsed.trigger = value;
      else throw new Error("--trigger must be ship or github-push");
      index += 1;
    } else throw new Error(`unknown ship option: ${argument}`);
  }
  if ([parsed.setup, parsed.update, parsed.rollback, parsed.logs, parsed.status, parsed.dev].filter(Boolean).length > 1) throw new Error("choose only one ship action");
  if (parsed.rebuild && (parsed.setup || parsed.update || parsed.rollback || parsed.logs || parsed.status || parsed.dev)) throw new Error("--rebuild applies only to shipping");
  if (parsed.trigger && !parsed.setup) throw new Error("--trigger requires --setup");
  if (parsed.server && !SSH_TARGET.test(parsed.server)) throw new Error("--server must be an SSH host or user@host without spaces");
  if (parsed.domain && !DOMAIN.test(parsed.domain)) throw new Error("--domain must be a lowercase public hostname");
  return parsed;
}

export function stripDockerDesktopLinks(value: string): string {
  return value.split(/\r?\n/).filter((line) => !/docker-desktop:\/\//i.test(line)).join("\n");
}

export function dockerCredentialHelpers(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const config = value as Record<string, unknown>;
  const helpers = new Set<string>();
  if (typeof config.credsStore === "string" && config.credsStore) helpers.add(config.credsStore);
  if (config.credHelpers && typeof config.credHelpers === "object" && !Array.isArray(config.credHelpers)) {
    for (const helper of Object.values(config.credHelpers)) if (typeof helper === "string" && helper) helpers.add(helper);
  }
  return [...helpers];
}

export function removeDockerCredentialHelper(value: Record<string, unknown>, helper: string): void {
  if (value.credsStore === helper) delete value.credsStore;
  if (!value.credHelpers || typeof value.credHelpers !== "object" || Array.isArray(value.credHelpers)) return;
  const helpers = value.credHelpers as Record<string, unknown>;
  for (const [registry, configured] of Object.entries(helpers)) if (configured === helper) delete helpers[registry];
  if (Object.keys(helpers).length === 0) delete value.credHelpers;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"}${remainder ? ` ${remainder} second${remainder === 1 ? "" : "s"}` : ""}`;
}

export function latestDeployDuration(history: HistoryEntry[]): number | undefined {
  return [...history].reverse().find((entry) => entry.kind === "webhook" && entry.state === "succeeded"
    && Number.isInteger(entry.durationMs) && entry.durationMs! > 0)?.durationMs;
}

interface ClientSettings {
  version: 1;
  defaultServer?: string;
  servers: Record<string, { sshTarget: string }>;
}

export function clientSettingsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "shibumi", "config.json");
}

async function readClientSettings(): Promise<ClientSettings> {
  try {
    const value: unknown = JSON.parse(await readFile(clientSettingsPath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1) throw new Error("invalid client settings");
    const servers = (value as { servers?: unknown }).servers;
    const defaultServer = (value as { defaultServer?: unknown }).defaultServer;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)
      || Object.entries(servers).some(([hostname, entry]) => !SERVER_HOSTNAME.test(hostname)
        || !entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof (entry as { sshTarget?: unknown }).sshTarget !== "string"
        || !SSH_TARGET.test((entry as { sshTarget: string }).sshTarget))
      || (defaultServer !== undefined && (typeof defaultServer !== "string" || !(defaultServer in servers)))) throw new Error("invalid client settings");
    return value as ClientSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, servers: {} };
    throw new Error(`${clientSettingsPath()} is invalid.\n\nNext: repair or remove this local client config, then retry.`);
  }
}

async function savedSshTarget(hostname?: string): Promise<string | undefined> {
  const settings = await readClientSettings();
  const configured = hostname ? settings.servers[hostname]?.sshTarget : undefined;
  if (configured) {
    log.info(`Server  ${configured}\nConfig  ${clientSettingsPath()}`);
    return configured;
  }
  if (hostname) return undefined;
  const servers = Object.entries(settings.servers);
  if (servers.length === 0) return undefined;
  const fallback = settings.defaultServer && settings.servers[settings.defaultServer]
    ? settings.servers[settings.defaultServer].sshTarget
    : servers[0][1].sshTarget;
  if (options.yes) {
    log.info(`Server  ${fallback}\nConfig  ${clientSettingsPath()}`);
    return fallback;
  }
  if (agentRun) throw new Error(`Deployment server confirmation required.\n\nAgent: ask user whether to use ${fallback}, then run bun ship:setup --server <target>.`);
  const answer = await text({
    message: "SSH server",
    placeholder: fallback,
    validate: (value) => SSH_TARGET.test(value || fallback) ? undefined : "Use an SSH host, user@host, or SSH alias without spaces",
  });
  return isCancel(answer) ? undefined : answer || fallback;
}

async function rememberSshTarget(hostname: string, sshTarget: string): Promise<void> {
  if (!SERVER_HOSTNAME.test(hostname) || !SSH_TARGET.test(sshTarget)) throw new Error("resolved SSH server is unsafe");
  const settings = await readClientSettings();
  if (settings.servers[hostname]?.sshTarget === sshTarget) return;
  settings.servers[hostname] = { sshTarget };
  settings.defaultServer = hostname;
  const path = clientSettingsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  log.success(`Saved server ${sshTarget} in ${path}`);
}

async function approve(message: string): Promise<boolean> {
  if (options.yes || agentRun) return true;
  const accepted = await confirm({ message, initialValue: true });
  return !isCancel(accepted) && accepted;
}

function explain(title: string, message: string): void {
  log.info(`${title}\n${message}`);
}

// Run argument arrays directly. Avoiding a shell keeps repository and SSH input
// from becoming executable command text.
async function run(args: string[], options: {
  input?: string;
  inputFile?: string;
  cwd?: string;
  inherit?: boolean;
  allowFailure?: boolean;
} = {}): Promise<Result> {
  const inherit = options.inherit ?? false;
  const child = Bun.spawn(args, {
    cwd: options.cwd ?? root,
    stdin: options.inputFile ? Bun.file(options.inputFile) : options.input === undefined ? (inherit ? "inherit" : "ignore") : "pipe",
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  if (options.input !== undefined) {
    if (!child.stdin || typeof child.stdin === "number") throw new Error("cannot open command input");
    child.stdin.write(options.input);
    child.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    inherit ? Promise.resolve("") : new Response(child.stdout).text(),
    inherit ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !options.allowFailure) throw new Error(stripDockerDesktopLinks(stderr).trim() || `${args[0]} exited with ${exitCode}`);
  return { exitCode, stdout, stderr };
}

async function git(...args: string[]): Promise<string> {
  return (await run(["git", ...args])).stdout.trim();
}

const setupFiles = ["package.json", "bun.lock", "scripts/ship.ts", "shibumi-server.json"];

async function offerSetupCommit(config: ClientConfig): Promise<"none" | "committed" | "declined"> {
  const changed: string[] = [];
  for (const file of setupFiles) {
    const status = await run(["git", "status", "--porcelain", "--", file]);
    if (status.stdout.trim()) changed.push(file);
  }
  if (changed.length === 0) return "none";
  const updateOnly = changed.length === 1 && changed[0] === "scripts/ship.ts";
  if (await githubBranchIsProtected(config)) {
    log.warn(`Branch ${config.branch} is protected. Ship will not commit setup changes directly.\nNext: git switch -c shibumi/setup, commit the Shibumi files, then open a pull request.`);
    return "declined";
  }
  const trackedConfig = (await run(["git", "ls-files", "--error-unmatch", "shibumi-server.json"], { allowFailure: true })).exitCode === 0;
  if (!await approve(updateOnly ? "Commit ship client update now?" : "Commit deployment setup now?")) return "declined";
  await run(["git", "add", "--", ...changed]);
  await run(["git", "commit", "--only", "-m", trackedConfig ? "Update Shibumi deployment" : "Add Shibumi deployment", "--", ...changed], { inherit: true });
  log.success(updateOnly ? "Committed ship client update" : "Committed Shibumi deployment setup");
  return "committed";
}

// Double literal hyphens before replacing dots so different domains cannot
// collapse to the same server app ID.
export function appIdForDomain(domain: string): string {
  return domain.replaceAll("-", "--").replaceAll(".", "-");
}

export function terminalHistory(entries: HistoryEntry[], commit: string): HistoryEntry | undefined {
  return entries.findLast((entry) => entry.commit === commit && ["succeeded", "failed"].includes(entry.state ?? ""));
}

export function canFollowDeployment(status: Pick<DeployStatus, "commit" | "state"> | undefined, commit: string): boolean {
  return status?.commit === commit && ["accepted", "running", "succeeded"].includes(status.state ?? "");
}

export function shouldTriggerRedeploy(trigger: ClientConfig["trigger"], ahead: number): boolean {
  return trigger === "ship" || ahead === 0;
}

export function protectedPushBlocked(value: unknown, login?: string, admin = false): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const protection = value as {
    enforce_admins?: { enabled?: unknown };
    required_pull_request_reviews?: {
      bypass_pull_request_allowances?: { users?: Array<{ login?: unknown }> };
    } | null;
  };
  const reviews = protection.required_pull_request_reviews;
  if (!reviews) return false;
  const bypassed = login && reviews.bypass_pull_request_allowances?.users
    ?.some((user) => user.login === login);
  if (bypassed || (admin && protection.enforce_admins?.enabled === false)) return false;
  return true;
}

const branchProtection = new Map<string, boolean | undefined>();

async function githubBranchIsProtected(config: ClientConfig): Promise<boolean> {
  const repository = config.repository.slice("github:".length);
  const key = `${repository}#${config.branch}`;
  if (!branchProtection.has(key)) {
    const endpoint = `repos/${repository}/branches/${encodeURIComponent(config.branch)}/protection`;
    try {
      if (Bun.which("gh")) {
        const details = await run(["gh", "api", endpoint], { allowFailure: true });
        if (details.exitCode === 0) {
          const protection: unknown = JSON.parse(details.stdout);
          if (protectedPushBlocked(protection) === false) branchProtection.set(key, false);
          else {
            const [viewer, repo] = await Promise.all([
              run(["gh", "api", "user", "--jq", ".login"], { allowFailure: true }),
              run(["gh", "api", `repos/${repository}`, "--jq", ".permissions.admin"], { allowFailure: true }),
            ]);
            branchProtection.set(key, protectedPushBlocked(
              protection,
              viewer.exitCode === 0 ? viewer.stdout.trim() : undefined,
              repo.exitCode === 0 && repo.stdout.trim() === "true",
            ));
          }
        }
      }
      if (!branchProtection.has(key)) {
        const response = await fetch(`https://api.github.com/${endpoint}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "shibumi-ship" },
          signal: AbortSignal.timeout(5_000),
        });
        branchProtection.set(key, response.status === 404 ? false : response.ok ? protectedPushBlocked(await response.json()) : undefined);
      }
    } catch {
      branchProtection.set(key, undefined);
    }
  }
  return branchProtection.get(key) === true;
}

export function deploymentModeForTrigger(trigger: ClientConfig["trigger"]): ClientConfig["deploymentMode"] {
  return trigger === "ship" ? "prebuilt" : "build";
}

export function repositoryFromRemote(remote: string): string {
  const match = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error("origin must be a GitHub repository");
  return match[1];
}

// Infer safe defaults from owned project files. Interactive server setup still
// previews these values before changing Caddy, systemd, or server config.
export function setupDomain(explicit: string | undefined, configured: string | undefined, inferred: string | undefined): string | undefined {
  return explicit ?? configured ?? inferred;
}

export function domainFromProject(packageName: unknown, compose: string): string | undefined {
  if (typeof packageName === "string" && DOMAIN.test(packageName)) return packageName;
  const siteUrlDomain = /^\s*(?:-\s*)?SITE_URL(?:=|:\s*)["']?https:\/\/([^/:\s"']+)/m.exec(compose)?.[1]?.toLowerCase();
  return siteUrlDomain && DOMAIN.test(siteUrlDomain) ? siteUrlDomain : undefined;
}

function composeCandidates(files: string[]): string[] {
  return files.filter((file) => /(^|\/)(?:compose\.ya?ml|docker-compose\.ya?ml)$/.test(file));
}

export function deploymentFileTemplates(hasBuildScript: boolean): Record<string, string> {
  return {
    Dockerfile: `FROM oven/bun:alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
${hasBuildScript ? "RUN bun run build\n\n" : ""}ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "start"]
`,
    "compose.yaml": `services:
  app:
    build: .
    ports:
      - "127.0.0.1:\${SHIBUMI_PORT:-9001}:3000"
    environment:
      HOST: 0.0.0.0
      PORT: "3000"
    init: true
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
`,
    ".dockerignore": `.git
node_modules
.env
.env.*
!.env.example
data
*.log
`,
  };
}

export function composeFileFromTracked(files: string[]): string {
  const candidates = composeCandidates(files);
  for (const preferred of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
    if (candidates.includes(preferred)) return preferred;
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new Error("no Compose file found");
  throw new Error(`multiple Compose files found:\n${candidates.map((file) => `  ${file}`).join("\n")}\n\nNext: keep one deployment Compose file or configure the intended path explicitly.`);
}

interface WorktreeCompose {
  branch: string;
  path: string;
  composeFile: string;
}

export function missingComposeMessage(branch: string, alternatives: WorktreeCompose[]): string {
  const heading = `no tracked Compose file found on current branch ${branch}.`;
  if (alternatives.length === 0) return `${heading}\n\nNext: add compose.yaml, or run ship from a branch containing deployment files.`;
  const rows = alternatives.map((item) => `  ${item.branch} → ${join(item.path, item.composeFile)}`).join("\n");
  const next = alternatives.length === 1
    ? `cd '${alternatives[0].path.replaceAll("'", "'\\''")}' and rerun installer.`
    : "choose one listed worktree, cd to it, and rerun installer.";
  return `${heading}\n\nCompose found in another local worktree:\n${rows}\n\nNext: ${next}`;
}

async function otherWorktreeCompose(): Promise<WorktreeCompose[]> {
  const listed = await run(["git", "worktree", "list", "--porcelain", "-z"], { allowFailure: true });
  if (listed.exitCode !== 0) return [];
  const alternatives: WorktreeCompose[] = [];
  for (const record of listed.stdout.split("\0\0")) {
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18);
    if (!path || !branch || resolve(path) === resolve(root)) continue;
    const tracked = await run(["git", "-C", path, "ls-files"], { allowFailure: true });
    if (tracked.exitCode !== 0) continue;
    for (const composeFile of composeCandidates(tracked.stdout.split("\n").filter(Boolean))) {
      alternatives.push({ branch, path, composeFile });
    }
  }
  return alternatives;
}

async function prepareCompose(): Promise<boolean> {
  const branch = await git("branch", "--show-current");
  if (!branch) throw new Error("ship requires a named Git branch");
  const tracked = (await git("ls-files")).split("\n").filter(Boolean);
  if (composeCandidates(tracked).length > 0) return false;
  const alternatives = await otherWorktreeCompose();
  if (alternatives.length > 0) throw new Error(missingComposeMessage(branch, alternatives));

  const names = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
  const existingCompose = (await Promise.all(names.map(async (name) => await Bun.file(join(root, name)).exists() ? name : undefined))).find(Boolean);
  if (existingCompose) {
    outro(`Found uncommitted ${existingCompose}.\n\nNext: review it, commit and push it, then run bun ship:setup.`);
    return true;
  }

  if (agentRun && !options.yes) {
    throw new Error("Compose deployment files are missing.\n\nAgent: ask user for permission to generate Dockerfile, compose.yaml, and .dockerignore, then run bun ship:setup -y.");
  }
  if (!options.yes) {
    const accepted = await confirm({ message: "No Compose deployment found. Generate recommended Bun deployment files?", initialValue: true });
    if (isCancel(accepted) || !accepted) throw new Error(missingComposeMessage(branch, []));
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  const dockerfileExists = await Bun.file(join(root, "Dockerfile")).exists();
  if (!dockerfileExists && typeof packageJson.scripts?.start !== "string") {
    throw new Error("Dockerfile generation requires a package.json start script.\n\nNext: add a start script that binds to 0.0.0.0 and reads PORT, then run bun ship:setup.");
  }
  const templates = deploymentFileTemplates(typeof packageJson.scripts?.build === "string");
  const written: string[] = [];
  for (const [name, contents] of Object.entries(templates)) {
    if (name === "Dockerfile" && dockerfileExists) continue;
    if (await Bun.file(join(root, name)).exists()) continue;
    await writeFile(join(root, name), contents, { mode: 0o644 });
    written.push(name);
  }
  log.success(`Generated ${written.join(", ")}`);
  outro("Review generated deployment files and verify app binds to 0.0.0.0 and reads PORT.\n\nNext: commit and push these changes, then run bun ship:setup.");
  return true;
}

async function inferredProject() {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown; scripts?: Record<string, unknown> };
  const repository = repositoryFromRemote(await git("remote", "get-url", "origin"));
  const branch = await git("branch", "--show-current");
  if (!branch) throw new Error("ship requires a named Git branch");
  const tracked = (await git("ls-files")).split("\n").filter(Boolean);
  if (composeCandidates(tracked).length === 0) throw new Error(missingComposeMessage(branch, await otherWorktreeCompose()));
  const composeFile = composeFileFromTracked(tracked);
  const compose = await readFile(join(root, composeFile), "utf8");
  const domain = domainFromProject(packageJson.name, compose);
  const service = /^services:\s*\n\s{2}([A-Za-z0-9_.-]+):/m.exec(compose)?.[1] ?? "web";
  const healthPath = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+(\/[^\s"'\\]*)/.exec(compose)?.[1] ?? "/healthz";
  return { packageJson, repository, branch, domain, composeFile, service, healthPath };
}

// Treat downloaded and committed JSON as untrusted input. Derived fields must
// agree with the domain before any value reaches GitHub, Git, or SSH.
export function validateConfig(value: unknown): ClientConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shibumi-server.json must be an object");
  const config = value as Partial<ClientConfig>;
  if (config.version !== 1 || config.provider !== "shibumi-server" || typeof config.domain !== "string" || !DOMAIN.test(config.domain)
    || typeof config.appId !== "string" || config.appId !== appIdForDomain(config.domain)
    || typeof config.repository !== "string" || !/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)
    || typeof config.branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(config.branch)
    || typeof config.webhookUrl !== "string" || config.webhookUrl !== `https://${config.domain}/hooks/github/${config.appId}`
    || typeof config.service !== "string" || typeof config.port !== "number" || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65_535
    || typeof config.healthPath !== "string" || typeof config.cutoverRequired !== "boolean"
    || (config.deploymentMode !== undefined && config.deploymentMode !== "build" && config.deploymentMode !== "prebuilt")
    || (config.trigger !== undefined && config.trigger !== "ship" && config.trigger !== "github-push")
    || (config.platform !== undefined && !/^linux\/(?:arm64|amd64)$/.test(config.platform))
    || (config.deploymentMode === "prebuilt" && config.platform === undefined)
    || !config.server || typeof config.server.hostname !== "string") {
    throw new Error("shibumi-server.json is invalid");
  }
  return { ...config, deploymentMode: config.deploymentMode ?? "build", trigger: config.trigger ?? "ship" } as ClientConfig;
}

async function readConfig(): Promise<ClientConfig | undefined> {
  try {
    return validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Read legacy project-local targets, then migrate them into machine-local
// client settings instead of committed shibumi-server.json.
async function localSshTarget(): Promise<string | undefined> {
  const result = await run(["git", "config", "--local", "--get", "shibumi.server"], { allowFailure: true });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

async function configuredSshTarget(hostname?: string): Promise<string | undefined> {
  if (options.server) {
    log.info(`Server  ${options.server}\nSource  --server`);
    return options.server;
  }
  const saved = await savedSshTarget(hostname);
  if (saved) return saved;
  const legacy = await localSshTarget();
  if (legacy) log.info(`Server  ${legacy}\nSource  project .git/config (migrating)`);
  return legacy;
}

async function suggestedSshTarget(): Promise<string | undefined> {
  try {
    const env = await readFile(join(root, ".env"), "utf8");
    const host = /^DEPLOY_HOST=(.+)$/m.exec(env)?.[1]?.trim();
    const user = /^DEPLOY_USER=(.+)$/m.exec(env)?.[1]?.trim();
    if (host && user && SSH_TARGET.test(`${user}@${host}`)) return `${user}@${host}`;
  } catch {}
  return undefined;
}

async function requestSshTarget(configHostname?: string): Promise<string | undefined> {
  if (options.server) return options.server;
  const suggestion = await suggestedSshTarget() ?? configHostname;
  if (options.yes) {
    if (!suggestion) throw new Error("--yes requires a configured server or --server <target>");
    return suggestion;
  }
  if (agentRun) {
    if (!suggestion) throw new Error("SSH server could not be inferred.\n\nAgent: ask user for their SSH target (user@host or SSH alias), then run bun ship:setup --server <target>");
    return suggestion;
  }
  explain(
    "Local configuration",
    `Use the same user@server target or SSH alias you use in your terminal.\nIt will be saved in ${clientSettingsPath()} on this computer and will not be committed.\nResolved server hostname, app domain, and deploy settings go in committed shibumi-server.json.`,
  );
  const answer = await text({
    message: "SSH target (user@server or alias)",
    placeholder: suggestion ?? "user@example-vps.com",
    validate: (value) => SSH_TARGET.test(value || suggestion || "") ? undefined : "Use an SSH host or user@host without spaces",
  });
  if (isCancel(answer)) return undefined;
  const target = answer || suggestion;
  if (!target) return undefined;
  if (!await approve(`Save ${target} locally and connect?`)) return undefined;
  return target;
}

async function resolvedSshHostname(target: string): Promise<string> {
  if (!SSH_TARGET.test(target)) throw new Error("local SSH target is unsafe");
  const result = await run(["ssh", "-G", "--", target]);
  const hostname = /^hostname\s+(.+)$/m.exec(result.stdout)?.[1]?.trim();
  if (!hostname || !SERVER_HOSTNAME.test(hostname)) {
    throw new Error("cannot resolve SSH server hostname");
  }
  return hostname.toLowerCase();
}

// Pass remote arguments separately and reject control characters. Interactive
// setup gets a TTY so SSH and sudo prompts remain attached to this terminal.
async function sshControlPath(): Promise<string> {
  if (!sshControlDirectory) {
    sshControlDirectory = await mkdtemp("/tmp/shibumi-ssh-");
    await chmod(sshControlDirectory, 0o700);
  }
  return join(sshControlDirectory, "control");
}

async function closeSshControl(): Promise<void> {
  if (!sshControlDirectory) return;
  if (sshControlTarget) {
    await run(["ssh", "-S", join(sshControlDirectory, "control"), "-O", "exit", "--", sshControlTarget], { allowFailure: true });
  }
  await rm(sshControlDirectory, { recursive: true, force: true });
  sshControlDirectory = undefined;
  sshControlTarget = undefined;
}

async function ssh(target: string, remoteArgs: string[], options: { tty?: boolean; allowFailure?: boolean; inputFile?: string } = {}): Promise<Result> {
  if (!SSH_TARGET.test(target)) throw new Error("local SSH target is unsafe");
  if (sshControlTarget && sshControlTarget !== target) throw new Error("ship supports one SSH target per run");
  sshControlTarget = target;
  for (const arg of remoteArgs) if (/[\0\r\n]/.test(arg)) throw new Error("remote argument is unsafe");
  return run([
    "ssh", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-S", await sshControlPath(),
    ...(agentRun ? ["-o", "BatchMode=yes"] : []), ...(options.inputFile ? ["-C"] : []), ...(options.tty ? ["-t"] : []), "--", target, ...remoteArgs,
  ], { inherit: options.tty, allowFailure: options.allowFailure, inputFile: options.inputFile });
}

function versionAtLeast(current: string, minimum: string): boolean {
  const left = /^\d+\.\d+\.\d+$/.test(current) ? current.split(".").map(Number) : [];
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < right.length; index += 1) {
    if ((left[index] ?? -1) !== right[index]) return (left[index] ?? -1) > right[index];
  }
  return left.length === right.length;
}

// Install only through the reviewed, version-pinned website endpoint.
async function ensureServer(target: string): Promise<void> {
  const version = await ssh(target, [SERVER_CLI, "--version"], { allowFailure: true });
  if (version.exitCode === 0 && versionAtLeast(version.stdout.trim(), "0.8.1")) return;
  if (agentRun) throw new Error(version.exitCode === 0
    ? `shibumi-server ${version.stdout.trim()} needs an upgrade.\n\nAgent: ask user to run bun ship:setup from this project in their terminal, then retry.`
    : "shibumi-server is not installed.\n\nAgent: ask user to run bun ship:setup from this project in their terminal, then retry.");
  explain(
    version.exitCode === 0 ? `shibumi-server ${version.stdout.trim()} needs an upgrade` : "shibumi-server is not installed",
    "This runs the reviewed installer on the SSH server. SSH and sudo prompts stay attached directly to your terminal.",
  );
  if (!await approve("Install or upgrade shibumi-server now?")) throw new Error("server setup cancelled");
  const result = await ssh(target, ["curl -fsSL https://shibumistack.dev/install/server | bash"], { tty: true, allowFailure: true });
  if (result.exitCode !== 0) throw new Error("remote shibumi-server installation failed");
  const installed = await ssh(target, [SERVER_CLI, "--version"], { allowFailure: true });
  if (installed.exitCode !== 0 || !versionAtLeast(installed.stdout.trim(), "0.8.1")) {
    throw new Error("shibumi-server 0.8.1 or newer was not installed.\n\nNext: run shis update on the server, then rerun bun ship:setup.");
  }
}

// Reuse an existing registration silently. New apps retain interactive SSH so
// server and sudo prompts stay attached to the local terminal.
async function remoteSetup(target: string, _force: boolean, current?: ClientConfig): Promise<ClientConfig> {
  const project = await inferredProject();
  let domain = setupDomain(options.domain, current?.domain, project.domain);
  if (!domain && (agentRun || options.yes)) throw new Error("App domain could not be inferred.\n\nAgent: ask user for the app domain, then run bun ship:setup --domain <domain>");
  if (!domain) {
    const answer = await text({
      message: "App domain",
      placeholder: "example.com",
      validate: (value) => value && DOMAIN.test(value) ? undefined : "Use a lowercase public hostname",
    });
    if (isCancel(answer)) throw new Error("setup cancelled");
    domain = answer;
  }
  const serverHostname = await resolvedSshHostname(target);
  await rememberSshTarget(serverHostname, target);
  await ensureServer(target);
  const appId = appIdForDomain(domain);
  let downloaded = await ssh(target, [
    "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "client-config", appId, "--server-hostname", serverHostname,
  ], { allowFailure: true });

  if (downloaded.exitCode !== 0) {
    if (agentRun) throw new Error("Server app registration needs interactive SSH and sudo.\n\nAgent: ask user to run bun ship:setup from this project in their terminal, then retry.");
    explain(
      "Server setup required",
      `SSH target  ${target}\nDomain      ${domain}\nRepository  github:${project.repository}\n\nSSH and sudo prompts stay attached to this terminal.`,
    );
    if (!await approve("Continue through SSH?")) throw new Error("server setup cancelled");
    const setup = await ssh(target, [
      "env", "SHIBUMI_SHIP_SETUP=1", SERVER_CLI, "add", domain,
      "--repository", `github:${project.repository}`,
      "--ref", `refs/heads/${project.branch}`,
      "--compose-file", project.composeFile,
      "--service", project.service,
      "--health-path", project.healthPath,
      "--deployment-mode", "prebuilt",
      ...(options.yes ? ["--yes"] : []),
    ], { tty: true, allowFailure: true });
    if (setup.exitCode !== 0) throw new Error("server app setup is incomplete.\n\nNext: complete the DNS or server action above, then run bun ship:setup.");
    downloaded = await ssh(target, [
      "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "client-config", appId, "--server-hostname", serverHostname,
    ], { allowFailure: true });
  }
  if (downloaded.exitCode !== 0) throw new Error("server app registration is incomplete.\n\nNext: complete the DNS or server action above, then run bun ship:setup.");
  const config = validateConfig(JSON.parse(downloaded.stdout));
  if (config.repository !== `github:${project.repository}`) throw new Error(`registered domain belongs to ${config.repository}\n\nNext: use the matching project or remove the conflicting server registration.`);
  if (config.branch !== project.branch) throw new Error(`registered domain deploys ${config.branch}, but current branch is ${project.branch}.\n\nNext: check out ${config.branch}, or register another domain for ${project.branch}.`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  log.success(`Found ${domain} on ${serverHostname}`);
  log.success("Wrote shibumi-server.json");
  return config;
}

interface GitHubWebhook { id: number; active: boolean; needsRepair: boolean }

export function matchingWebhook(value: unknown, webhookUrl: string): GitHubWebhook | undefined {
  if (!Array.isArray(value)) return undefined;
  const hook = value.find((item) => item && typeof item === "object"
    && (item as { config?: { url?: unknown } }).config?.url === webhookUrl) as { id?: unknown; active?: unknown; last_response?: { code?: unknown } } | undefined;
  if (!hook || typeof hook.id !== "number" || typeof hook.active !== "boolean") return undefined;
  const code = hook.last_response?.code;
  return { id: hook.id, active: hook.active, needsRepair: !hook.active || (typeof code === "number" && code !== 0 && (code < 200 || code >= 300)) };
}

async function ensureGitHubAuth(): Promise<void> {
  const status = await run(["gh", "auth", "status", "-h", "github.com"], { allowFailure: true });
  if (status.exitCode === 0) return;
  explain("GitHub sign-in required", "GitHub CLI stores your credentials. Shibumi never reads them.");
  if (agentRun || options.yes) throw new Error("GitHub sign-in required.\n\nAgent: ask user to run gh auth login -h github.com -p https -w, then retry.");
  if (!await approve("Sign in to GitHub now?")) throw new Error("Next: run gh auth login -h github.com -p https -w, then rerun bun ship.");
  const login = await run(["gh", "auth", "login", "-h", "github.com", "-p", "https", "-w"], { inherit: true, allowFailure: true });
  if (login.exitCode !== 0 || (await run(["gh", "auth", "status", "-h", "github.com"], { allowFailure: true })).exitCode !== 0) {
    throw new Error("GitHub sign-in did not complete.\n\nNext: run gh auth login -h github.com -p https -w, then rerun bun ship.");
  }
}

async function authorizeWebhookAccess(): Promise<void> {
  explain("GitHub webhook access required", "GitHub CLI needs admin:repo_hook to create or repair this repository webhook.");
  if (agentRun || options.yes) throw new Error("GitHub webhook access required.\n\nAgent: ask user to run gh auth refresh -h github.com -s admin:repo_hook, then retry.");
  if (!await approve("Authorize webhook access now?")) throw new Error("Next: run gh auth refresh -h github.com -s admin:repo_hook, then rerun bun ship.");
  const refresh = await run(["gh", "auth", "refresh", "-h", "github.com", "-s", "admin:repo_hook"], { inherit: true, allowFailure: true });
  if (refresh.exitCode !== 0) throw new Error("GitHub webhook authorization did not complete.\n\nNext: run gh auth refresh -h github.com -s admin:repo_hook, then rerun bun ship.");
}

async function findWebhook(config: ClientConfig): Promise<GitHubWebhook | undefined> {
  const repository = config.repository.slice("github:".length);
  await ensureGitHubAuth();
  let hooks = await run(["gh", "api", `repos/${repository}/hooks?per_page=100`], { allowFailure: true });
  if (hooks.exitCode !== 0) {
    await authorizeWebhookAccess();
    hooks = await run(["gh", "api", `repos/${repository}/hooks?per_page=100`], { allowFailure: true });
  }
  if (hooks.exitCode !== 0) throw new Error(`${hooks.stderr.trim() || "GitHub CLI could not read repository webhooks"}\n\nNext: confirm repository admin access, then rerun bun ship.`);
  return matchingWebhook(JSON.parse(hooks.stdout), config.webhookUrl);
}

// Fetch the secret only when GitHub needs it. It moves through process memory
// from server output to `gh` input and is never printed or written locally.
async function ensureWebhook(config: ClientConfig, target: string): Promise<void> {
  const existing = await findWebhook(config);
  if (existing && !existing.needsRepair) {
    log.success("GitHub webhook is active");
    return;
  }
  const repository = config.repository.slice("github:".length);
  explain(
    existing ? "GitHub webhook needs repair" : "GitHub webhook is missing",
    `Repository  ${repository}\nPayload URL ${config.webhookUrl}\nEvents      push\n\nThe secret travels from server to GitHub CLI through memory only.`,
  );
  if (!existing && !await approve("Create webhook with GitHub CLI?")) throw new Error(`Next: review ${config.webhookUrl} at https://github.com/${repository}/settings/hooks`);
  if (existing) log.info("Refreshing webhook secret from server configuration");
  const secretResult = await ssh(target, ["env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "webhook-secret", config.appId]);
  const secretValue: unknown = JSON.parse(secretResult.stdout);
  const secret = secretValue && typeof secretValue === "object" ? (secretValue as { secret?: unknown }).secret : undefined;
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("server returned an invalid webhook secret");
  const args = existing
    ? ["gh", "api", "-X", "PATCH", `repos/${repository}/hooks/${existing.id}/config`, "--input", "-"]
    : ["gh", "api", "-X", "POST", `repos/${repository}/hooks`, "--input", "-"];
  const input = existing
    ? JSON.stringify({ secret })
    : JSON.stringify({ name: "web", active: true, events: ["push"], config: { url: config.webhookUrl, content_type: "json", insecure_ssl: "0", secret } });
  let result = await run(args, { input, allowFailure: true });
  if (result.exitCode !== 0) {
    await authorizeWebhookAccess();
    result = await run(args, { input, allowFailure: true });
  }
  if (result.exitCode !== 0) throw new Error(`${result.stderr.trim() || "GitHub CLI could not configure webhook"}\n\nNext: confirm repository admin access, then rerun bun ship.`);
  const hookId = existing?.id ?? (JSON.parse(result.stdout) as { id?: unknown }).id;
  if (typeof hookId !== "number") throw new Error("GitHub returned an invalid webhook");
  if (existing && !existing.active) {
    result = await run(["gh", "api", "-X", "PATCH", `repos/${repository}/hooks/${hookId}`, "--input", "-"], {
      input: JSON.stringify({ active: true, events: ["push"] }), allowFailure: true,
    });
    if (result.exitCode !== 0) throw new Error(`${result.stderr.trim() || "GitHub CLI could not enable webhook"}\n\nNext: confirm repository admin access, then rerun bun ship:setup.`);
  }
  const ping = await run(["gh", "api", "-X", "POST", `repos/${repository}/hooks/${hookId}/pings`], { allowFailure: true });
  if (ping.exitCode !== 0) throw new Error(`${ping.stderr.trim() || "GitHub CLI could not test webhook"}\n\nNext: review https://github.com/${repository}/settings/hooks.`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Bun.sleep(1_000);
    const checked = await run(["gh", "api", `repos/${repository}/hooks/${hookId}`], { allowFailure: true });
    if (checked.exitCode === 0 && (JSON.parse(checked.stdout) as { last_response?: { code?: unknown } }).last_response?.code === 200) {
      log.success(existing ? "GitHub webhook repaired and tested" : "GitHub webhook created and tested");
      return;
    }
  }
  throw new Error(`GitHub webhook is configured but not reachable yet.\n\nNext: confirm ${config.domain} DNS and TLS, then run bun ship:setup. For proxied Cloudflare domains, use Full (strict) SSL/TLS mode.\n\nGitHub: https://github.com/${repository}/settings/hooks`);
}

async function disableWebhook(config: ClientConfig): Promise<void> {
  const repository = config.repository.slice("github:".length);
  const settings = `https://github.com/${repository}/settings/hooks`;
  if (!Bun.which("gh") || (await run(["gh", "auth", "status", "-h", "github.com"], { allowFailure: true })).exitCode !== 0) {
    log.warn(`Direct shipping enabled. GitHub webhook cleanup skipped because GitHub CLI is not authenticated.\nNext: disable ${config.webhookUrl} at ${settings}, or rerun bun ship:setup after GitHub sign-in.`);
    return;
  }
  const hooks = await run(["gh", "api", `repos/${repository}/hooks?per_page=100`], { allowFailure: true });
  if (hooks.exitCode !== 0) {
    log.warn(`Direct shipping enabled. GitHub webhook cleanup could not reach GitHub.\nNext: disable ${config.webhookUrl} at ${settings}, or rerun bun ship:setup later.`);
    return;
  }
  const existing = matchingWebhook(JSON.parse(hooks.stdout), config.webhookUrl);
  if (!existing || !existing.active) {
    log.success("GitHub webhook is disabled");
    return;
  }
  explain("Disable deploy-on-push", `Repository  ${repository}\nPayload URL ${config.webhookUrl}\n\nGit pushes will stop changing production. Run bun ship to deploy.`);
  if (!await approve("Disable GitHub webhook?")) throw new Error("webhook change cancelled");
  const result = await run(["gh", "api", "-X", "PATCH", `repos/${repository}/hooks/${existing.id}`, "--input", "-"], {
    input: JSON.stringify({ active: false }), allowFailure: true,
  });
  if (result.exitCode !== 0) {
    log.warn(`Direct shipping enabled. GitHub webhook cleanup failed.\nNext: disable ${config.webhookUrl} at ${settings}, or rerun bun ship:setup later.`);
    return;
  }
  log.success("GitHub webhook disabled");
}

async function setDeploymentMode(config: ClientConfig, target: string, trigger: ClientConfig["trigger"]): Promise<ClientConfig> {
  const mode = deploymentModeForTrigger(trigger);
  if (config.deploymentMode === mode) return config;
  const changed = await ssh(target, [
    "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "deployment-mode", config.appId, mode,
  ], { allowFailure: true });
  if (changed.exitCode !== 0) throw new Error(`${changed.stderr.trim() || `could not enable ${mode} deployments`}\n\nNext: update shibumi-server, then rerun bun ship:setup.`);
  const downloaded = await ssh(target, [
    "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "client-config", config.appId, "--server-hostname", config.server.hostname,
  ]);
  return { ...validateConfig(JSON.parse(downloaded.stdout)), trigger };
}

async function selectTrigger(current: ClientConfig["trigger"], force: boolean): Promise<ClientConfig["trigger"]> {
  if (options.trigger) return options.trigger;
  if (!force || options.yes || agentRun) return current;
  log.info(`Current deployment: ${current === "ship" ? "Run bun ship" : "Every GitHub push"}`);
  const answer = await select({
    message: "How do you want to deploy?",
    initialValue: current,
    options: [
      { value: "ship", label: "Run bun ship", hint: "recommended" },
      { value: "github-push", label: "Deploy every GitHub push" },
    ],
  });
  if (isCancel(answer)) throw new Error("setup cancelled");
  return answer as ClientConfig["trigger"];
}

async function setup(force: boolean): Promise<{ config: ClientConfig; target: string; changed: boolean } | undefined> {
  let config = await readConfig();
  if ((force || !config) && await prepareCompose()) return undefined;
  if (force || !config) await inferredProject();
  let target = await configuredSshTarget(config?.server.hostname);
  if (!target) target = await requestSshTarget(config?.server.hostname);
  if (!target) throw new Error("SSH server is required");
  const previous = config;
  if (force || !config) config = await remoteSetup(target, force, config);
  if (!config) throw new Error("deployment setup did not return client configuration");
  await rememberSshTarget(config.server.hostname, target);
  const trigger = await selectTrigger(previous?.trigger ?? config.trigger, force);
  config = await setDeploymentMode({ ...config, trigger }, target, trigger);
  if (force) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    if (trigger === "github-push") await ensureWebhook(config, target);
    else if (previous) await disableWebhook(config);
    else log.success("Deployments run through bun ship");
  }
  return { config, target, changed: !previous || JSON.stringify(previous) !== JSON.stringify(config) };
}

// Refuse ambiguous deploys: wrong origin, wrong branch, dirty work, or remote
// work not present locally. Run project-owned checks before every deployment.
async function preflight(config: ClientConfig): Promise<number> {
  const project = await inferredProject();
  if (`github:${project.repository}` !== config.repository) throw new Error(`origin does not match ${config.repository}`);
  if (project.branch !== config.branch) throw new Error(`current branch must be ${config.branch}`);
  const status = await git("status", "--short");
  if (status) throw new Error(`Ship paused: working tree has uncommitted changes.\n\n${status}\n\nNext: commit or stash these changes, then run bun ship.`);

  const progress = spinner();
  progress.start(`Fetching origin/${config.branch}`);
  await run(["git", "fetch", "origin", config.branch]);
  const counts = (await git("rev-list", "--left-right", "--count", `HEAD...origin/${config.branch}`)).split(/\s+/).map(Number);
  if (counts[1] > 0) {
    progress.stop("Branch is behind or diverged", 1);
    throw new Error(`pull origin/${config.branch} before shipping`);
  }
  if (counts[0] > 0 && await githubBranchIsProtected(config)) {
    progress.stop(`${config.branch} is protected`, 1);
    throw new Error(`Ship cannot push ${counts[0]} local commit${counts[0] === 1 ? "" : "s"} directly to protected branch ${config.branch}.\n\nNext: push a feature branch, merge its pull request, update local ${config.branch}, then run bun ship.`);
  }
  progress.stop(counts[0] > 0
    ? `${counts[0]} commit${counts[0] === 1 ? "" : "s"} ready to push`
    : "Current commit already pushed and ready to deploy");

  const scripts = project.packageJson.scripts ?? {};
  for (const name of ["test", "check"]) {
    if (typeof scripts[name] !== "string") continue;
    const check = spinner();
    check.start(`Running bun run ${name}`);
    const result = await run(["bun", "run", name], { allowFailure: true });
    if (result.exitCode !== 0) {
      check.stop(`${name} failed`, 1);
      process.stderr.write(result.stderr || result.stdout);
      throw new Error(`bun run ${name} failed`);
    }
    check.stop(`${name} passed`);
  }
  return counts[0];
}

export function prebuiltImage(appId: string, commit: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appId) || !COMMIT.test(commit)) throw new Error("invalid prebuilt image identity");
  return `localhost/shibumi-server/upload/${appId}:${commit}`;
}

export function prebuiltLabels(appId: string, commit: string, repository: string, sourceTree: string, version?: unknown): Record<string, string> {
  prebuiltImage(appId, commit);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !COMMIT.test(sourceTree)) throw new Error("invalid prebuilt image source");
  return {
    "dev.shibumistack.app-id": appId,
    "dev.shibumistack.source-tree": sourceTree,
    "org.opencontainers.image.revision": commit,
    "org.opencontainers.image.source": `https://github.com/${repository}`,
    ...(typeof version === "string" && version.length <= 128 ? { "org.opencontainers.image.version": version } : {}),
  };
}

export function composeFrontend(plugin: boolean, standalone: boolean): string[] | undefined {
  if (plugin) return ["docker", "compose"];
  if (standalone) return ["docker-compose"];
  return undefined;
}

async function verifyDockerCredentialHelpers(): Promise<void> {
  const path = join(process.env.DOCKER_CONFIG || join(homedir(), ".docker"), "config.json");
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected object");
    value = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Docker CLI config is invalid: ${path}\n\nNext: fix its JSON, verify docker info, then run bun ship.`);
  }
  for (const helper of dockerCredentialHelpers(value)) {
    const executable = `docker-credential-${helper}`;
    if (Bun.which(executable)) continue;
    const canOfferRepair = !agentRun && !options.yes && process.stdin.isTTY && process.stdout.isTTY;
    const accepted = canOfferRepair && await confirm({
      message: `${executable} is configured but unavailable. Remove its stale entries from ${path}?`,
      initialValue: true,
    });
    if (accepted && !isCancel(accepted)) {
      const backup = `${path}.shibumi-backup`;
      const temporary = `${path}.tmp-${process.pid}`;
      removeDockerCredentialHelper(value, helper);
      await copyFile(path, backup);
      await chmod(backup, 0o600);
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      log.success(`Removed stale ${executable} entries; backup saved to ${backup}`);
      continue;
    }
    const next = helper === "desktop"
      ? `edit ${path}, remove \"credsStore\": \"desktop\" and any credHelpers entries set to \"desktop\"`
      : `install ${executable} or remove its stale entry from ${path}`;
    throw new Error(`Docker credential helper ${executable} is configured but unavailable.\n\nNext: ${next}; verify docker pull oven/bun:alpine, then run bun ship.`);
  }
}

async function localBuildFrontend(config: ClientConfig): Promise<string[] | undefined> {
  if (config.deploymentMode !== "prebuilt") return undefined;
  if (!config.platform) throw new Error("server image platform is missing.\n\nNext: run bun ship:setup.");
  const docker = await run(["docker", "info"], { allowFailure: true });
  if (docker.exitCode !== 0) throw new Error("Docker CLI cannot reach a compatible engine.\n\nNext: start Colima with colima start, verify docker info, then run bun ship.");
  const plugin = await run(["docker", "compose", "version"], { allowFailure: true });
  const standalone = plugin.exitCode === 0
    ? undefined
    : await run(["docker-compose", "version"], { allowFailure: true });
  const compose = composeFrontend(plugin.exitCode === 0, standalone?.exitCode === 0);
  if (!compose) throw new Error("Docker Compose is unavailable.\n\nNext: install docker compose or docker-compose, verify its version, then run bun ship.");
  await verifyDockerCredentialHelpers();
  const buildx = await run(["docker", "buildx", "version"], { allowFailure: true });
  if (buildx.exitCode !== 0) {
    const detail = buildx.stderr.trim() || buildx.stdout.trim() || "docker buildx version failed";
    const next = process.platform === "darwin"
      ? 'brew install docker-buildx; mkdir -p "${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"; ln -sfn "$(brew --prefix docker-buildx)/bin/docker-buildx" "${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins/docker-buildx"'
      : "install Docker Buildx plugin for your Docker CLI";
    throw new Error(`Buildx is unavailable: ${detail}\n\nNext: ${next}; verify docker buildx version, then run bun ship.`);
  }
  return compose;
}

async function buildAndUpload(config: ClientConfig, target: string, commit: string, compose?: string[]): Promise<void> {
  if (config.deploymentMode !== "prebuilt") return;
  if (!compose) throw new Error("Docker Compose preflight was not completed");
  const submodules = (await git("ls-files", "--stage")).split("\n").filter((line) => line.startsWith("160000 "));
  if (submodules.length > 0) throw new Error("Prebuilt shipping does not support Git submodules yet.\n\nNext: remove the submodule dependency or use server build mode.");

  const project = await inferredProject();
  const temporary = await mkdtemp("/tmp/shibumi-build-");
  const context = join(temporary, "context");
  const sourceArchive = join(temporary, "source.tar");
  const imageArchive = join(temporary, "image.tar");
  const override = join(temporary, "compose.prebuilt.yaml");
  const image = prebuiltImage(config.appId, commit);
  const progress = spinner();
  try {
    progress.start(`Building ${config.platform} image from ${commit.slice(0, 7)}`);
    await mkdir(context);
    await run(["git", "archive", "--format=tar", "--output", sourceArchive, commit]);
    await run(["tar", "-xf", sourceArchive, "-C", context]);
    const sourceTree = (await git("rev-parse", `${commit}^{tree}`)).toLowerCase();
    const labels = prebuiltLabels(config.appId, commit, project.repository, sourceTree, project.packageJson.version);
    const buildLabels = Object.entries(labels).map(([name, value]) => `        ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join("\n");
    await writeFile(override, `services:\n  ${JSON.stringify(config.service)}:\n    image: ${JSON.stringify(image)}\n    platform: ${JSON.stringify(config.platform)}\n    build:\n      labels:\n${buildLabels}\n`);
    // An older ship client may have left this exact tag pointing at an unlabeled image.
    // Remove only the temporary upload tag so Compose must export current identity labels;
    // BuildKit layer cache remains available unless --rebuild was requested.
    await run(["docker", "image", "rm", image], { allowFailure: true });
    await run([
      ...compose,
      "--project-name", `shibumi-build-${config.appId}`,
      "--file", join(context, project.composeFile),
      "--file", override,
      "build", ...(options.rebuild ? ["--no-cache"] : []), config.service,
    ], { cwd: context });
    const inspected = await run(["docker", "image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", image]);
    const [imageId, platform] = inspected.stdout.trim().split(/\s+/, 2);
    if (platform !== config.platform) throw new Error(`built image platform is ${platform || "unknown"}; ${config.platform} required`);
    progress.message("Packing image for SSH upload");
    await run(["docker", "image", "save", "--output", imageArchive, image]);
    progress.message(`Uploading image to ${target}`);
    const archiveBytes = (await stat(imageArchive)).size;
    const loaded = await ssh(target, [
      "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "image-load", config.appId, commit, String(archiveBytes),
    ], { inputFile: imageArchive, allowFailure: true });
    if (loaded.exitCode !== 0) throw new Error(loaded.stderr.trim() || loaded.stdout.trim() || "server rejected prebuilt image");
    progress.stop(`Built and uploaded ${commit.slice(0, 7)} (${Math.ceil(archiveBytes / 1024 ** 2)} MiB, ${imageId?.replace(/^sha256:/, "").slice(0, 12) || "unknown digest"})`);
    await run(["docker", "image", "rm", image], { allowFailure: true });
  } catch (error) {
    progress.stop("Prebuilt image failed", 1);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes("\n\nNext:")
      ? message
      : `${message}\n\nNext: fix the local Docker or Compose error above, verify docker compose build, then run bun ship.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function estimatedDeployDuration(config: ClientConfig, target: string): Promise<number | undefined> {
  const result = await ssh(target, [
    "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "history", config.appId, "--json",
  ], { allowFailure: true });
  if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
  try {
    const history: unknown = JSON.parse(result.stdout);
    return Array.isArray(history) ? latestDeployDuration(history as HistoryEntry[]) : undefined;
  } catch {
    return undefined;
  }
}

// Follow status for the exact pushed commit. This prevents an older or parallel
// deployment from being reported as success for current ship.
async function followStatus(config: ClientConfig, target: string, commit: string, estimateMs?: number): Promise<void> {
  const progress = spinner();
  const fit = (value: string) => {
    const width = Math.max(24, (process.stdout.columns ?? 80) - 8);
    return value.length > width ? `${value.slice(0, width - 1)}…` : value;
  };
  progress.start(estimateMs ? `Waiting for deployment (ETA: ${formatDuration(estimateMs)})` : "Waiting for deployment");
  const startedAt = Date.now();
  const deadline = startedAt + 12 * 60_000;
  const webhookDeadline = startedAt + 45_000;
  let lastStage = "";
  let lastOutput = "";
  let sawQueued = false;
  while (Date.now() < deadline) {
    const result = await ssh(target, [
      "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "status", config.appId, "--commit", commit, "--json",
    ], { allowFailure: true });
    if (result.exitCode === 0 && result.stdout.trim() && result.stdout.trim() !== "null") {
      const status = parseDeployStatus(JSON.parse(result.stdout))!;
      const queued = status.commit !== commit && status.queuedCommit === commit;
      sawQueued ||= queued;
      const displayStage = queued ? `Queued ${commit.slice(0, 7)} next. Current ${status.commit!.slice(0, 7)} ${status.stage}` : status.stage;
      if (status.stage && (`${status.commit}:${status.stage}` !== lastStage || (status.output ?? "") !== lastOutput)) {
        lastStage = `${status.commit}:${status.stage}`;
        lastOutput = status.output ?? "";
        progress.message(status.stage === "shipped" && !queued
          ? "Deployment complete"
          : status.output ? fit(`${displayStage}: ${status.output}`) : fit(`${displayStage}…`));
      }
      if (!queued && status.state === "succeeded") {
        progress.stop(config.cutoverRequired
          ? "New upstream healthy at 127.0.0.1 (Caddy cutover pending)"
          : "Deployment complete");
        return;
      }
      if (!queued && status.state === "failed") {
        progress.stop(`Deployment failed during ${status.stage ?? "unknown"}`, 1);
        throw new Error(`${[status.message ?? "deployment failed", status.output].filter(Boolean).join("\n")}\n\nNext: run bun ship --logs.`);
      }
    } else if (lastStage) {
      const history = await ssh(target, [
        "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "history", config.appId, "--json",
      ], { allowFailure: true });
      if (history.exitCode === 0 && history.stdout.trim()) {
        const terminal = terminalHistory(JSON.parse(history.stdout) as HistoryEntry[], commit);
        if (terminal?.state === "succeeded") {
          progress.stop(config.cutoverRequired
            ? "New upstream healthy at 127.0.0.1 (Caddy cutover pending)"
            : "Deployment complete");
          return;
        }
        if (terminal?.state === "failed") {
          progress.stop(`Deployment failed during ${terminal.stage ?? "unknown"}`, 1);
          throw new Error(`deployment failed during ${terminal.stage ?? "unknown"}.\n\nNext: run bun ship --logs.`);
        }
      }
    }
    if (sawQueued) {
      const current = await ssh(target, [
        "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "status", config.appId, "--json",
      ], { allowFailure: true });
      if (current.exitCode === 0 && current.stdout.trim() && current.stdout.trim() !== "null") {
        const status = parseDeployStatus(JSON.parse(current.stdout))!;
        if (status.queuedCommit && status.queuedCommit !== commit) {
          progress.stop(`Queued commit replaced by ${status.queuedCommit.slice(0, 7)}`, 1);
          throw new Error(`deployment ${commit.slice(0, 7)} was superseded by newer commit ${status.queuedCommit.slice(0, 7)}.\n\nNext: pull latest changes before shipping again.`);
        }
      }
    }
    if (!lastStage && Date.now() >= webhookDeadline) {
      progress.stop("Webhook did not start deployment", 1);
      throw new Error(`GitHub webhook did not reach shibumi-server.\n\nNext: check https://github.com/${config.repository.slice("github:".length)}/settings/hooks, then rerun bun ship after repairing delivery.`);
    }
    await Bun.sleep(2_000);
  }
  progress.stop("Deployment status timed out", 1);
  throw new Error(`deployment may still be running. Check: ssh ${target} shibumi-server status ${config.appId}`);
}

// Existing domains keep serving their previous upstream until new app is
// healthy and user explicitly approves Caddy cutover.
async function completeCutover(config: ClientConfig, target: string): Promise<boolean> {
  if (!config.cutoverRequired) return false;
  if (agentRun) throw new Error("Existing-domain cutover needs interactive SSH and sudo.\n\nAgent: ask user to run bun ship from this project in their terminal.");
  explain(
    "Existing-domain cutover",
    `The new app is healthy, but ${config.domain} still serves its previous upstream.\nCaddy cutover validates and reloads configuration without stopping active connections.`,
  );
  if (!await approve("Switch public traffic to the new upstream through SSH?")) {
    log.warn("Cutover skipped. Previous upstream remains public.");
    return false;
  }
  const result = await ssh(target, [SERVER_CLI, "caddy-cutover", config.appId], { tty: true, allowFailure: true });
  if (result.exitCode !== 0) throw new Error("Caddy cutover failed; previous upstream remains active");
  const hostname = await resolvedSshHostname(target);
  const downloaded = await ssh(target, [
    "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "client-config", config.appId, "--server-hostname", hostname,
  ]);
  const next = validateConfig(JSON.parse(downloaded.stdout));
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  Object.assign(config, next);
  log.success(`Caddy now serves ${config.domain} from the Shibumi upstream`);
  return true;
}

async function projectTarget(config: ClientConfig): Promise<string> {
  const target = await configuredSshTarget(config.server.hostname) ?? await requestSshTarget(config.server.hostname);
  if (!target) throw new Error("SSH server is required");
  await rememberSshTarget(config.server.hostname, target);
  return target;
}

async function showLogs(): Promise<void> {
  try {
    const config = await readConfig();
    if (!config) throw new Error("Shibumi setup is missing.\n\nNext: run bun ship:setup.");
    const result = await ssh(await projectTarget(config), [
      "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "logs", config.appId,
    ], { allowFailure: true });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "deployment log is unavailable");
    process.stdout.write(result.stdout);
  } finally {
    await closeSshControl();
  }
}

export function parseDeployStatus(value: unknown): DeployStatus | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment status is invalid");
  const status = value as Partial<DeployStatus>;
  if (typeof status.commit !== "string" || !COMMIT.test(status.commit)
    || !["accepted", "running", "succeeded", "failed"].includes(status.state ?? "")
    || typeof status.stage !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(status.stage)
    || typeof status.updatedAt !== "string" || Number.isNaN(Date.parse(status.updatedAt))
    || (status.message !== undefined && (typeof status.message !== "string" || status.message.length > 256 || /[\r\n\0]/.test(status.message)))
    || (status.output !== undefined && (typeof status.output !== "string" || status.output.length > 512 || /[\r\n\0\x1b]/.test(status.output)))
    || (status.url !== undefined && (typeof status.url !== "string" || status.url.length > 512 || !status.url.startsWith("https://")))
    || (status.queuedCommit !== undefined && (typeof status.queuedCommit !== "string" || !COMMIT.test(status.queuedCommit)))) {
    throw new Error("deployment status is invalid");
  }
  return status as DeployStatus;
}

export function deploymentStatusSummary(status: DeployStatus | undefined, localCommit: string, config: Pick<ClientConfig, "domain" | "cutoverRequired">): string {
  if (!status) return `No deployment status for https://${config.domain}`;
  return [
    `Status  ${status.state}`,
    `Commit  ${status.commit}${status.commit === localCommit ? " (matches HEAD)" : ""}`,
    status.commit === localCommit ? undefined : `HEAD    ${localCommit}`,
    `Stage   ${status.stage}${status.message ? `: ${status.message}` : ""}`,
    status.queuedCommit ? `Queued  ${status.queuedCommit}` : undefined,
    `Updated ${status.updatedAt}`,
    config.cutoverRequired && status.state === "succeeded"
      ? "Traffic previous upstream (Caddy cutover pending)"
      : `URL     ${status.url ?? `https://${config.domain}`}`,
  ].filter(Boolean).join("\n");
}

async function showStatus(): Promise<void> {
  try {
    const config = await readConfig();
    if (!config) throw new Error("Shibumi setup is missing.\n\nNext: run bun ship:setup.");
    const result = await ssh(await projectTarget(config), [
      "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "status", config.appId, "--json",
    ], { allowFailure: true });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "deployment status is unavailable");
    const status = parseDeployStatus(JSON.parse(result.stdout));
    process.stdout.write(`${deploymentStatusSummary(status, await git("rev-parse", "HEAD"), config)}\n`);
  } finally {
    await closeSshControl();
  }
}

function portIsBusy(port: number): Promise<boolean> {
  return new Promise((resolveBusy) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolveBusy(true); });
    socket.once("timeout", () => { socket.destroy(); resolveBusy(false); });
    socket.once("error", () => resolveBusy(false));
  });
}

export function formatDevStartup(port: number, domain: string, time: string, color = false): string {
  const paint = (code: string, value: string) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const row = (label: string, url: string) => `${paint("2", "┃")} ${label.padEnd(8)} ${paint("34", url)}`;
  return [
    `${paint("38;5;208", "渋み")}  ship dev`,
    row("Local", `http://localhost:${port}/`),
    row("Remote", `https://${domain}`),
    `${paint("2", time)} starting app dev server...`,
  ].join("\n");
}

function localTime(date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}

async function runDev(): Promise<void> {
  const config = await readConfig();
  if (!config) throw new Error("Shibumi setup is missing.\n\nNext: run bun ship:setup.");
  if (await portIsBusy(config.port)) {
    const lsof = Bun.which("lsof");
    const fuser = Bun.which("fuser");
    if (!lsof && !fuser) throw new Error(`Port ${config.port} is already in use.\n\nNext: stop that process, then run bun dev again.`);
    const found = lsof
      ? await run([lsof, "-nP", `-iTCP:${config.port}`, "-sTCP:LISTEN", "-t"], { allowFailure: true })
      : await run([fuser!, "-n", "tcp", String(config.port)], { allowFailure: true });
    const pids = [...new Set(`${found.stdout} ${found.stderr}`.split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number))];
    if (pids.length === 0) throw new Error(`Port ${config.port} is already in use.\n\nNext: stop that process, then run bun dev again.`);
    const details = await run(["ps", "-o", "pid=,comm=", "-p", pids.join(",")], { allowFailure: true });
    log.warn(`Port ${config.port} is in use${details.stdout.trim() ? `:\n${details.stdout.trim()}` : ""}`);
    const accepted = await confirm({ message: "Stop it and start this project?", initialValue: false });
    if (isCancel(accepted) || !accepted) return;
    for (const pid of pids) process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (await portIsBusy(config.port) && Date.now() < deadline) await Bun.sleep(100);
    if (await portIsBusy(config.port)) throw new Error(`Port ${config.port} did not stop.\n\nNext: stop PID ${pids.join(", ")} manually, then run bun dev again.`);
  }
  process.stdout.write(`${formatDevStartup(config.port, config.domain, localTime(), supportsTerminalColor())}\n`);
  const child = Bun.spawn([process.execPath, "run", "dev:app"], {
    cwd: root,
    env: { ...process.env, PORT: String(config.port), SHIBUMI_PORT: String(config.port) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

async function rollbackShip(): Promise<void> {
  intro("渋み  ship rollback");
  try {
    const config = await readConfig();
    if (!config) throw new Error("Shibumi setup is missing.\n\nNext: run bun ship:setup.");
    const target = await projectTarget(config);
    const status = await ssh(target, [
      "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "status", config.appId, "--json",
    ], { allowFailure: true });
    if (status.exitCode === 0 && status.stdout.trim() && status.stdout.trim() !== "null") {
      const current = parseDeployStatus(JSON.parse(status.stdout))!;
      if (current.state === "accepted" || current.state === "running") {
        throw new Error(`Deployment ${current.commit?.slice(0, 7) ?? ""} is still ${current.state}.\n\nNext: wait for it to finish, then retry bun ship --rollback.`);
      }
    }
    if (!await approve(`Restore the previous retained image for ${config.domain}?`)) {
      cancel("Rollback cancelled");
      return;
    }
    const startedAt = Date.now();
    const progress = spinner();
    progress.start("Restoring previous image");
    const rollback = await ssh(target, [
      "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "rollback", config.appId, "--yes",
    ], { allowFailure: true });
    if (rollback.exitCode !== 0) {
      progress.stop("Rollback failed", 1);
      throw new Error(rollback.stderr.trim() || rollback.stdout.trim() || "server rollback failed");
    }
    progress.stop(`Rolled back in ${formatDuration(Date.now() - startedAt)}`);
    outro(`https://${config.domain}`);
  } finally {
    await closeSshControl();
  }
}

// Setup exits after configuration changes so user can review and commit them.
// Normal ship reaches push only when configuration is already stable.
export async function runShip(): Promise<void> {
  intro("渋み  ship");
  try {
    const forceSetup = options.setup;
    const result = await setup(forceSetup);
    if (!result) return;
    const setupCommit = await offerSetupCommit(result.config);
    if (forceSetup || result.changed || setupCommit === "declined") {
      outro(setupCommit === "declined"
        ? `${accent("Next:")} review and commit Shibumi setup files, then run bun ship.`
        : `${accent("Next:")} bun ship`);
      return;
    }
    const compose = await localBuildFrontend(result.config);
    const estimateMs = await estimatedDeployDuration(result.config, result.target);
    const startedAt = Date.now();
    const ahead = await preflight(result.config);
    const commit = await git("rev-parse", "HEAD");
    if (!COMMIT.test(commit)) throw new Error("cannot determine shipped commit");
    await buildAndUpload(result.config, result.target, commit, compose);
    if (ahead > 0) await run(["git", "push", "origin", result.config.branch], { inherit: true });
    if (shouldTriggerRedeploy(result.config.trigger, ahead)) {
      const redeploy = await ssh(result.target, [
        "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "redeploy", result.config.appId, commit,
      ], { allowFailure: true });
      if (redeploy.exitCode !== 0) {
        const current = await ssh(result.target, [
          "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", SERVER_CLI, "status", result.config.appId, "--commit", commit, "--json",
        ], { allowFailure: true });
        const status = current.exitCode === 0 && current.stdout.trim() && current.stdout.trim() !== "null"
          ? parseDeployStatus(JSON.parse(current.stdout))
          : undefined;
        if (!canFollowDeployment(status, commit)) throw new Error(redeploy.stderr.trim() || "redeploy request failed");
        log.info("Deployment already running for this commit. Following its progress.");
      }
    }
    await followStatus(result.config, result.target, commit, estimateMs);
    const changed = await completeCutover(result.config, result.target);
    if (changed) log.info("Updated shibumi-server.json after Caddy cutover");
    const complete = spinner();
    complete.start("Finishing ship");
    complete.stop(`Shipped in ${formatDuration(Date.now() - startedAt)} (--rollback if needed)`);
    outro(`https://${result.config.domain}`);
  } finally {
    await closeSshControl();
  }
}

export function immutableShipSource(source: string): string | undefined {
  return /const CURRENT_SOURCE = "(https:\/\/shibumistack\.dev\/ship\/v\d+\.ts)";/.exec(source)?.[1];
}

export function shouldCheckForShipUpdate(value: ShipOptions): boolean {
  return !(value.setup || value.update || value.rollback || value.logs || value.status || value.dev);
}

async function runLatestShipClient(args: string[]): Promise<boolean> {
  if (process.env.SHIBUMI_SHIP_LATEST === "1") return false;
  let parsed: ShipOptions;
  try {
    parsed = parseShipArgs(args);
  } catch {
    return false;
  }
  if (!shouldCheckForShipUpdate(parsed)) return false;

  const sourcePath = join(root, "scripts/ship.ts");
  let current: string;
  let latest: string;
  try {
    current = await readFile(sourcePath, "utf8");
    const [latestResponse, reviewedResponse] = await Promise.all([
      fetch(LATEST_SOURCE, { headers: { accept: "text/plain" } }),
      fetch(CURRENT_SOURCE, { headers: { accept: "text/plain" } }),
    ]);
    if (!latestResponse.ok || !reviewedResponse.ok || await reviewedResponse.text() !== current) return false;
    latest = await latestResponse.text();
    if (latest === current || !latest.startsWith("#!/usr/bin/env bun") || !latest.includes("export function runShipCli")) return false;
    const immutable = immutableShipSource(latest);
    if (!immutable) return false;
    const immutableResponse = await fetch(immutable, { headers: { accept: "text/plain" } });
    if (!immutableResponse.ok || await immutableResponse.text() !== latest) return false;
  } catch {
    return false;
  }

  const latestVersion = immutableShipSource(latest)?.match(/v(\d+)\.ts$/)?.[1] ?? "latest";
  if (!(parsed.yes || isAgentExecution())) {
    const accepted = await confirm({
      message: `Ship client v${latestVersion} is available. Use it now and save it after a successful deployment?`,
      initialValue: true,
    });
    if (isCancel(accepted) || !accepted) return false;
  }

  log.info(`Using ship client v${latestVersion} for this deployment`);
  const temporaryDirectory = await mkdtemp("/tmp/shibumi-ship-client-");
  const temporarySource = join(temporaryDirectory, "ship.ts");
  try {
    await writeFile(temporarySource, latest, { mode: 0o644 });
    const child = Bun.spawn([process.execPath, temporarySource, ...args], {
      cwd: root,
      env: { ...process.env, SHIBUMI_SHIP_LATEST: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return true;
    }
    let sourceUnchanged = false;
    try {
      sourceUnchanged = await readFile(sourcePath, "utf8") === current;
    } catch {}
    if (sourceUnchanged) {
      const temporaryUpdate = `${sourcePath}.tmp-${process.pid}`;
      await writeFile(temporaryUpdate, latest, { mode: 0o644 });
      await chmod(temporaryUpdate, 0o644);
      await rename(temporaryUpdate, sourcePath);
      log.success(`Updated scripts/ship.ts to v${latestVersion}. Review and commit it.`);
    }
    return true;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function updateShipClient(): Promise<void> {
  intro("渋み  ship update");
  const response = await fetch(LATEST_SOURCE, { headers: { accept: "text/plain" } });
  if (!response.ok) throw new Error(`ship client returned HTTP ${response.status}`);
  const source = await response.text();
  if (!source.startsWith("#!/usr/bin/env bun") || !source.includes("export function runShipCli")) {
    throw new Error("downloaded ship client is invalid");
  }
  const current = await readFile(import.meta.path, "utf8");
  if (source === current) {
    outro("Ship client is current");
    return;
  }
  const reviewed = await fetch(CURRENT_SOURCE, { headers: { accept: "text/plain" } });
  if (!reviewed.ok || await reviewed.text() !== current) {
    throw new Error(`scripts/ship.ts contains owned changes.\n\nNext: review and merge ${LATEST_SOURCE} manually.`);
  }
  const temporary = `${import.meta.path}.tmp-${process.pid}`;
  await writeFile(temporary, source, { mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, import.meta.path);
  outro("Ship client updated. Review and commit scripts/ship.ts.");
}

export function runShipCli(): void {
  try {
    options = parseShipArgs(process.argv.slice(2));
    agentRun = isAgentExecution();
  } catch (error) {
    cancel(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const action = options.update ? updateShipClient()
    : options.rollback ? rollbackShip()
    : options.logs ? showLogs()
    : options.status ? showStatus()
    : options.dev ? runDev()
    : runShip();
  action.catch((error) => {
    cancel(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

if (import.meta.main) {
  runLatestShipClient(process.argv.slice(2)).then((ranLatest) => {
    if (!ranLatest) runShipCli();
  }).catch((error) => {
    cancel(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
