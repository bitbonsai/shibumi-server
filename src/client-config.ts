import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { loadConfig } from "./config";

export interface ClientConfig {
  version: 1;
  provider: "shibumi-server";
  server: { hostname: string };
  domain: string;
  appId: string;
  repository: `github:${string}`;
  branch: string;
  webhookUrl: string;
  service: string;
  healthPath: string;
  cutoverRequired: boolean;
}

type HostnameResolver = () => Promise<string>;

const SAFE_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

async function systemHostname(): Promise<string> {
  const result = Bun.spawnSync(["hostname", "-f"], { stdout: "pipe", stderr: "ignore" });
  const value = result.exitCode === 0 ? result.stdout.toString().trim() : hostname();
  return value || hostname();
}

export async function readWebhookSecret(configPath: string, secretsPath: string, appId: string): Promise<string> {
  const config = await loadConfig(configPath);
  const app = config.apps[appId];
  if (!app) throw new Error(`unknown app: ${appId}`);
  const secrets = await readFile(secretsPath, "utf8");
  const escaped = app.secretEnvironmentVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const secret = new RegExp(`^${escaped}=([a-f0-9]{64})$`, "m").exec(secrets)?.[1];
  if (!secret) throw new Error(`webhook secret for ${appId} is unavailable`);
  return secret;
}

export async function createClientConfig(
  configPath: string,
  appId: string,
  resolveHostname: HostnameResolver = systemHostname,
): Promise<ClientConfig> {
  const config = await loadConfig(configPath);
  const app = config.apps[appId];
  if (!app) throw new Error(`unknown app: ${appId}`);
  if (!app.domain) throw new Error(`app ${appId} predates client config; register it again with its domain`);
  const serverHostname = await resolveHostname();
  if (!SAFE_HOSTNAME.test(serverHostname)) throw new Error("server hostname is unsafe");

  return {
    version: 1,
    provider: "shibumi-server",
    server: { hostname: serverHostname.toLowerCase() },
    domain: app.domain,
    appId,
    repository: `github:${app.repository}`,
    branch: app.ref.slice("refs/heads/".length),
    webhookUrl: `https://${app.domain}/hooks/github/${appId}`,
    service: app.service,
    healthPath: new URL(app.healthUrl).pathname,
    cutoverRequired: app.caddyMode === "preserve",
  };
}
