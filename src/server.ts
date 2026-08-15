import type { ServerConfig } from "./config";
import { DeliveryCache } from "./deliveries";
import { defaultDeployDependencies, deploy, DeploymentError, type DeployDependencies, type DeploymentLogger } from "./deploy";
import { isGitHubSignature, normalizeGitHubDeliveryId, parseGitHubPush, verifyGitHubSignature } from "./github";
import { AppLocks } from "./locks";
import { DeploymentStatusStore, type DeploymentState } from "./status";
import { DeploymentHistoryStore } from "./history";
import { DeploymentLogStore } from "./deployment-log";
import { DeploymentQueueStore, type QueuedDeployment } from "./queue";

class BodyTooLargeError extends Error {}

async function readBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new BodyTooLargeError();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function json(status: number, body: Record<string, unknown>, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

export interface WebhookServiceOptions {
  environment?: Record<string, string | undefined>;
  locks?: AppLocks;
  deployDependencies?: DeployDependencies;
  deliveries?: DeliveryCache;
  logger?: DeploymentLogger;
  statusStore?: DeploymentStatusStore;
  historyStore?: DeploymentHistoryStore;
  logStore?: DeploymentLogStore;
  queueStore?: DeploymentQueueStore;
}

export class WebhookService {
  readonly #environment: Record<string, string | undefined>;
  readonly #locks: AppLocks;
  readonly #deployDependencies: DeployDependencies;
  readonly #deliveries: DeliveryCache;
  readonly #logger: DeploymentLogger;
  readonly #statusStore?: DeploymentStatusStore;
  readonly #historyStore?: DeploymentHistoryStore;
  readonly #logStore?: DeploymentLogStore;
  readonly #queueStore?: DeploymentQueueStore;
  readonly #tasks = new Set<Promise<void>>();
  readonly #queueOperations = new Map<string, Promise<void>>();
  readonly #activeStatuses = new Map<string, { commit: string; state: DeploymentState; stage: string; message?: string; output?: string }>();

  constructor(
    readonly config: ServerConfig,
    options: WebhookServiceOptions = {},
  ) {
    this.#environment = options.environment ?? process.env;
    this.#locks = options.locks ?? new AppLocks();
    this.#logger = options.logger ?? console;
    this.#deployDependencies = options.deployDependencies ?? defaultDeployDependencies(this.#logger);
    this.#deliveries = options.deliveries ?? new DeliveryCache();
    this.#statusStore = options.statusStore;
    this.#historyStore = options.historyStore;
    this.#logStore = options.logStore;
    this.#queueStore = options.queueStore;
  }

  async #writeStatus(appId: string, commit: string, state: DeploymentState, stage: string, message?: string, output?: string): Promise<void> {
    this.#activeStatuses.set(appId, { commit, state, stage, message, output });
    if (!this.#statusStore) return;
    try {
      const queuedCommit = (await this.#queueStore?.read(appId))?.commit;
      await this.#statusStore.write({
        appId,
        commit,
        state,
        stage,
        message,
        output,
        url: this.config.apps[appId]?.domain ? `https://${this.config.apps[appId].domain}` : undefined,
        queuedCommit,
      });
    } catch (error) {
      this.#logger.error("cannot write deployment status", {
        app: appId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #writeHistory(entry: Parameters<DeploymentHistoryStore["append"]>[0]): Promise<void> {
    if (!this.#historyStore) return;
    try {
      await this.#historyStore.append(entry);
    } catch (error) {
      this.#logger.error("cannot write deployment history", {
        app: entry.appId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #startLog(appId: string, commit: string): Promise<void> {
    try {
      await this.#logStore?.start(appId, commit);
    } catch (error) {
      this.#logger.error("cannot start deployment log", { app: appId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #appendLog(appId: string, stage: string, value: string): Promise<void> {
    try {
      let redacted = value;
      for (const [key, secret] of Object.entries(this.#environment)) {
        if (secret && secret.length >= 8 && /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i.test(key)) redacted = redacted.replaceAll(secret, "[redacted]");
      }
      await this.#logStore?.append(appId, stage, redacted);
    } catch (error) {
      this.#logger.error("cannot append deployment log", { app: appId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #withQueue<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queueOperations.get(appId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.#queueOperations.set(appId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queueOperations.get(appId) === current) this.#queueOperations.delete(appId);
    }
  }

  #start(appId: string, initial: QueuedDeployment): void {
    const app = this.config.apps[appId];
    if (!app) return;
    const task = (async () => {
      let request: QueuedDeployment | undefined = initial;
      while (request) {
        const { commit, delivery } = request;
        const startedAt = Date.now();
        await this.#startLog(appId, commit);
        await this.#appendLog(appId, "accepted", "Deployment accepted");
        await this.#writeStatus(appId, commit, "accepted", "accepted");
        await this.#writeHistory({ appId, commit, kind: "webhook", state: "accepted", delivery });
        let latestOutput: string | undefined;
        const dependencies: DeployDependencies = {
          ...this.#deployDependencies,
          onStage: async (stage) => {
            latestOutput = undefined;
            await this.#deployDependencies.onStage?.(stage);
            await this.#appendLog(appId, stage, "Started");
            await this.#writeStatus(appId, commit, "running", stage);
          },
          onOutput: async (stage, line) => {
            await this.#deployDependencies.onOutput?.(stage, line);
            const output = line.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512);
            if (output) {
              latestOutput = output;
              await this.#appendLog(appId, stage, output);
              await this.#writeStatus(appId, commit, "running", stage, undefined, output);
            }
          },
        };
        try {
          await deploy(appId, app, commit, dependencies);
          await this.#writeStatus(appId, commit, "succeeded", "shipped");
          await this.#appendLog(appId, "shipped", `Succeeded in ${Date.now() - startedAt}ms`);
          await this.#writeHistory({ appId, commit, kind: "webhook", state: "succeeded", delivery, durationMs: Date.now() - startedAt });
        } catch (error) {
          this.#deliveries.forget(appId, delivery);
          const stage = error instanceof DeploymentError ? error.stage : "unknown";
          await this.#writeStatus(
            appId,
            commit,
            "failed",
            stage,
            (error instanceof Error ? error.message : "deployment failed").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512),
            latestOutput,
          );
          await this.#appendLog(appId, stage, error instanceof Error ? error.message : String(error));
          await this.#writeHistory({ appId, commit, kind: "webhook", state: "failed", delivery, stage, durationMs: Date.now() - startedAt });
          this.#logger.error("deployment failed", { app: appId, commit, error: error instanceof Error ? error.message : String(error) });
        }
        request = await this.#withQueue(appId, async () => {
          const queued = await this.#queueStore?.read(appId);
          if (queued) await this.#queueStore?.remove(appId);
          else this.#locks.release(appId);
          return queued;
        });
      }
    })().catch((error) => {
      this.#locks.release(appId);
      this.#logger.error("deployment queue failed", { app: appId, error: error instanceof Error ? error.message : String(error) });
    });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  async resumeQueued(): Promise<void> {
    for (const queued of await this.#queueStore?.list() ?? []) {
      await this.#withQueue(queued.appId, async () => {
        if (!this.#locks.acquire(queued.appId)) return;
        await this.#queueStore?.remove(queued.appId);
        this.#start(queued.appId, queued);
      });
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/hooks\/github\/([a-z0-9-]+)$/);
    if (!match) return json(404, { error: "not_found" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });

    const appId = match[1];
    const app = this.config.apps[appId];
    if (!app) return json(404, { error: "not_found" });

    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") return json(415, { error: "unsupported_media_type" });
    const event = request.headers.get("x-github-event");
    if (event !== "ping" && event !== "push") return json(400, { error: "unsupported_event" });
    const deliveryId = normalizeGitHubDeliveryId(request.headers.get("x-github-delivery"));
    if (!deliveryId) return json(400, { error: "invalid_delivery" });
    const signature = request.headers.get("x-hub-signature-256");
    if (!isGitHubSignature(signature)) return json(401, { error: "invalid_signature" });

    const secret = this.#environment[app.secretEnvironmentVariable];
    if (!secret) {
      this.#logger.error("webhook secret is unavailable", { app: appId });
      return json(503, { error: "service_unavailable" });
    }

    let body: Uint8Array;
    try {
      body = await readBody(request, this.config.listen.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json(413, { error: "payload_too_large" });
      throw error;
    }

    if (!verifyGitHubSignature(secret, body, signature)) {
      return json(401, { error: "invalid_signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    if (event === "ping") return json(200, { ok: true });

    let push;
    try {
      push = parseGitHubPush(payload);
    } catch (error) {
      return json(400, { error: "invalid_payload", message: error instanceof Error ? error.message : "invalid payload" });
    }
    if (push.repository !== app.repository) return json(400, { error: "repository_mismatch" });
    if (push.ref !== app.ref) return json(400, { error: "ref_mismatch" });
    if (this.#deliveries.seen(appId, deliveryId)) {
      return json(200, { status: "duplicate", app: appId, delivery: deliveryId });
    }

    this.#deliveries.remember(appId, deliveryId);
    return this.#withQueue(appId, async () => {
      if (this.#locks.has(appId)) {
        const active = this.#activeStatuses.get(appId) ?? await this.#statusStore?.read(appId);
        if (active?.commit === push.commit && ["accepted", "running"].includes(active.state)) {
          return json(202, { status: "active", app: appId, commit: push.commit });
        }
        if (!this.#queueStore) {
          this.#deliveries.forget(appId, deliveryId);
          return json(409, { error: "deployment_in_progress", message: `A deployment for ${appId} is already running.` });
        }
        const previous = await this.#queueStore.replace(appId, push.commit, deliveryId);
        if (previous && previous.delivery !== deliveryId) this.#deliveries.forget(appId, previous.delivery);
        if (active) await this.#writeStatus(appId, active.commit, active.state, active.stage, active.message, active.output);
        return json(202, {
          status: previous?.commit === push.commit ? "queued" : previous ? "replaced" : "queued",
          app: appId,
          commit: push.commit,
          ...(previous && previous.commit !== push.commit ? { replaced: previous.commit } : {}),
        });
      }

      this.#locks.acquire(appId);
      this.#start(appId, { version: 1, appId, commit: push.commit, delivery: deliveryId, queuedAt: new Date().toISOString() });
      return json(202, { status: "accepted", app: appId, commit: push.commit });
    });
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#tasks]);
  }
}
