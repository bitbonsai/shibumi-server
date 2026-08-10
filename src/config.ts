import { isAbsolute, relative, resolve } from "node:path";

export interface ListenConfig {
  hostname: string;
  port: number;
  maxBodyBytes: number;
}

export interface AppConfig {
  repository: string;
  ref: string;
  checkout: string;
  composeFile: string;
  composeCommand: string[];
  composeProject: string;
  service: string;
  hostPort: number;
  testCommand?: string[];
  healthUrl: string;
  secretEnvironmentVariable: string;
  minimumFreeMemoryMb: number;
  minimumFreeDiskMb: number;
  buildTimeoutMs: number;
  healthAttempts: number;
  healthIntervalMs: number;
}

export interface ServerConfig {
  listen: ListenConfig;
  apps: Record<string, AppConfig>;
}

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, and hyphens`);
  }
  return result;
}

function command(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((part, index) => string(part, `${label}[${index}]`));
}

function parseRef(value: unknown, label: string): string {
  const ref = string(value, label);
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/")) {
    throw new Error(`${label} must be a safe refs/heads/* ref`);
  }
  return ref;
}

function parseHealthUrl(value: unknown, label: string): string {
  const raw = string(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error(`${label} must be an unauthenticated loopback HTTP URL`);
  }
  return url.toString();
}

export function composePath(app: AppConfig): string {
  const path = resolve(app.checkout, app.composeFile);
  const relation = relative(app.checkout, path);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("composeFile must stay inside checkout");
  }
  return path;
}

export function parseConfig(value: unknown): ServerConfig {
  const root = object(value, "config");
  const listenValue = object(root.listen, "listen");
  const hostname = string(listenValue.hostname ?? "127.0.0.1", "listen.hostname");
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("listen.hostname must be a loopback address");
  }

  const appsValue = object(root.apps, "apps");
  const apps: Record<string, AppConfig> = {};
  const ports = new Set<number>();

  for (const [appId, rawApp] of Object.entries(appsValue)) {
    if (!APP_ID.test(appId)) throw new Error(`invalid app id: ${appId}`);
    const appValue = object(rawApp, `apps.${appId}`);
    const repository = string(appValue.repository, `apps.${appId}.repository`);
    if (!REPOSITORY.test(repository)) throw new Error(`apps.${appId}.repository must be owner/name`);
    const checkout = string(appValue.checkout, `apps.${appId}.checkout`);
    if (!isAbsolute(checkout)) throw new Error(`apps.${appId}.checkout must be absolute`);
    const secretEnvironmentVariable = string(
      appValue.secretEnvironmentVariable,
      `apps.${appId}.secretEnvironmentVariable`,
    );
    if (!ENVIRONMENT_VARIABLE.test(secretEnvironmentVariable)) {
      throw new Error(`apps.${appId}.secretEnvironmentVariable must be an environment variable name`);
    }

    const hostPort = integer(appValue.hostPort, `apps.${appId}.hostPort`, 1024, 65535);
    if (ports.has(hostPort)) throw new Error(`host port ${hostPort} is assigned more than once`);
    ports.add(hostPort);

    const healthUrl = parseHealthUrl(appValue.healthUrl, `apps.${appId}.healthUrl`);
    const healthPort = Number(new URL(healthUrl).port || 80);
    if (healthPort !== hostPort) {
      throw new Error(`apps.${appId}.healthUrl must use hostPort ${hostPort}`);
    }

    const app: AppConfig = {
      repository,
      ref: parseRef(appValue.ref, `apps.${appId}.ref`),
      checkout,
      composeFile: string(appValue.composeFile, `apps.${appId}.composeFile`),
      composeCommand: command(appValue.composeCommand ?? ["podman", "compose"], `apps.${appId}.composeCommand`),
      composeProject: identifier(appValue.composeProject, `apps.${appId}.composeProject`),
      service: identifier(appValue.service, `apps.${appId}.service`),
      hostPort,
      testCommand: appValue.testCommand === undefined
        ? undefined
        : command(appValue.testCommand, `apps.${appId}.testCommand`),
      healthUrl,
      secretEnvironmentVariable,
      minimumFreeMemoryMb: integer(
        appValue.minimumFreeMemoryMb ?? 2_048,
        `apps.${appId}.minimumFreeMemoryMb`,
        256,
        1_048_576,
      ),
      minimumFreeDiskMb: integer(
        appValue.minimumFreeDiskMb ?? 4_096,
        `apps.${appId}.minimumFreeDiskMb`,
        256,
        16_777_216,
      ),
      buildTimeoutMs: integer(appValue.buildTimeoutMs ?? 600_000, `apps.${appId}.buildTimeoutMs`, 1_000, 3_600_000),
      healthAttempts: integer(appValue.healthAttempts ?? 20, `apps.${appId}.healthAttempts`, 1, 120),
      healthIntervalMs: integer(appValue.healthIntervalMs ?? 500, `apps.${appId}.healthIntervalMs`, 10, 60_000),
    };
    composePath(app);
    apps[appId] = app;
  }

  if (Object.keys(apps).length === 0) throw new Error("apps must contain at least one app");
  const listenPort = integer(listenValue.port ?? 8787, "listen.port", 1024, 65535);
  if (ports.has(listenPort)) throw new Error("listen.port must not match an app hostPort");

  return {
    listen: {
      hostname,
      port: listenPort,
      maxBodyBytes: integer(listenValue.maxBodyBytes ?? 1_048_576, "listen.maxBodyBytes", 1, 10_485_760),
    },
    apps,
  };
}

export async function loadConfig(path: string): Promise<ServerConfig> {
  let value: unknown;
  try {
    value = await Bun.file(path).json();
  } catch (error) {
    throw new Error(`cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(value);
}

export function validateSecrets(config: ServerConfig, environment: Record<string, string | undefined> = process.env): void {
  for (const [appId, app] of Object.entries(config.apps)) {
    const secret = environment[app.secretEnvironmentVariable];
    if (!secret || secret.length < 32) {
      throw new Error(`${app.secretEnvironmentVariable} for ${appId} must contain at least 32 characters`);
    }
  }
}
