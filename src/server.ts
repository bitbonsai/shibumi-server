import type { ServerConfig } from "./config";
import { DeliveryCache } from "./deliveries";
import { defaultDeployDependencies, deploy, type DeployDependencies, type DeploymentLogger } from "./deploy";
import { isGitHubSignature, normalizeGitHubDeliveryId, parseGitHubPush, verifyGitHubSignature } from "./github";
import { AppLocks } from "./locks";

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
}

export class WebhookService {
  readonly #environment: Record<string, string | undefined>;
  readonly #locks: AppLocks;
  readonly #deployDependencies: DeployDependencies;
  readonly #deliveries: DeliveryCache;
  readonly #logger: DeploymentLogger;
  readonly #tasks = new Set<Promise<void>>();

  constructor(
    readonly config: ServerConfig,
    options: WebhookServiceOptions = {},
  ) {
    this.#environment = options.environment ?? process.env;
    this.#locks = options.locks ?? new AppLocks();
    this.#logger = options.logger ?? console;
    this.#deployDependencies = options.deployDependencies ?? defaultDeployDependencies(this.#logger);
    this.#deliveries = options.deliveries ?? new DeliveryCache();
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

    if (!this.#locks.acquire(appId)) {
      return json(
        409,
        {
          error: "deployment_in_progress",
          message: `A deployment for ${appId} is already running.`,
        },
        { "Retry-After": "60" },
      );
    }

    this.#deliveries.remember(appId, deliveryId);
    const task = deploy(appId, app, push.commit, this.#deployDependencies)
      .catch((error) => {
        this.#deliveries.forget(appId, deliveryId);
        this.#logger.error("deployment failed", {
          app: appId,
          commit: push.commit,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#locks.release(appId);
      });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));

    return json(202, { status: "accepted", app: appId, commit: push.commit });
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#tasks]);
  }
}
