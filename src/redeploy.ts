import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readWebhookSecret } from "./client-config";
import { loadConfig } from "./config";
import { installationPaths } from "./install";

const COMMIT = /^[a-f0-9]{40}$/;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function triggerRedeploy(home: string, appId: string, commit: string, fetcher: Fetcher = fetch): Promise<void> {
  if (!COMMIT.test(commit)) throw new Error("redeploy commit must be a full lowercase SHA");
  const paths = installationPaths(resolve(home));
  const config = await loadConfig(paths.config);
  const app = config.apps[appId];
  if (!app) throw new Error(`unknown app: ${appId}.\n\nNext: run shis list and choose an app ID.`);
  const secret = await readWebhookSecret(paths.config, paths.secrets, appId);
  const body = JSON.stringify({ repository: { full_name: app.repository }, ref: app.ref, after: commit });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const hostname = config.listen.hostname === "::1" ? "[::1]" : config.listen.hostname;
  const response = await fetcher(`http://${hostname}:${config.listen.port}/hooks/github/${appId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 202) return;
  if (response.status === 409) throw new Error(`deployment already in progress for ${appId}.\n\nNext: update shibumi-server to enable deployment queueing, then rerun bun run ship.`);
  throw new Error(`redeploy request failed with HTTP ${response.status}.\n\nNext: inspect systemctl --user status shibumi-server, then rerun bun run ship.`);
}
