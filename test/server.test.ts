import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";
import type { CommandOptions, CommandResult, CommandRunner, DeployDependencies } from "../src/deploy";
import { WebhookService } from "../src/server";

const secret = "s".repeat(32);
const commit = "a".repeat(40);
const config = parseConfig({
  listen: { hostname: "127.0.0.1", port: 8787, maxBodyBytes: 1_000 },
  apps: {
    myapp: {
      repository: "owner/repo",
      ref: "refs/heads/main",
      checkout: "/srv/shibumi/apps/myapp",
      composeFile: "compose.yaml",
      composeProject: "myapp",
      service: "web",
      hostPort: 9100,
      testCommand: ["bun", "test"],
      healthUrl: "http://127.0.0.1:9100/healthz",
      secretEnvironmentVariable: "SHIBUMI_SECRET_MYAPP",
      healthAttempts: 1,
      healthIntervalMs: 10,
    },
  },
});

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: commit,
    repository: { full_name: "owner/repo" },
    ...overrides,
  });
}

function request(body: string, event = "push", signatureSecret = secret): Request {
  const signature = createHmac("sha256", signatureSecret).update(body).digest("hex");
  return new Request("https://example.com/hooks/github/myapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

class SuccessfulRunner implements CommandRunner {
  async run(_command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    if (args.includes("rev-parse")) return { exitCode: 0, stdout: `${commit}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function dependencies(runner: CommandRunner = new SuccessfulRunner()): DeployDependencies {
  return {
    runner,
    resources: { available: async () => ({ memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 }) },
    fetch: async () => new Response("ok"),
    sleep: async () => {},
    logger: { info() {}, error() {} },
  };
}

function service(runner?: CommandRunner) {
  return new WebhookService(config, {
    environment: { SHIBUMI_SECRET_MYAPP: secret },
    deployDependencies: dependencies(runner),
    logger: { info() {}, error() {} },
  });
}

describe("webhook server", () => {
  test("accepts a signed push and runs asynchronously", async () => {
    const receiver = service();
    const response = await receiver.handle(request(payload()));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted", app: "myapp", commit });
    await receiver.waitForIdle();
  });

  test("accepts GitHub's signed ping without deploying", async () => {
    const receiver = service();
    const response = await receiver.handle(request("{}", "ping"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects an invalid signature before payload handling", async () => {
    const response = await service().handle(request(payload(), "push", "wrong-secret".repeat(3)));
    expect(response.status).toBe(401);
  });

  test("rejects repository and branch mismatches", async () => {
    expect((await service().handle(request(payload({ repository: { full_name: "other/repo" } })))).status).toBe(400);
    expect((await service().handle(request(payload({ ref: "refs/heads/other" })))).status).toBe(400);
  });

  test("rejects oversized request bodies", async () => {
    const body = JSON.stringify({ padding: "x".repeat(2_000) });
    const response = await service().handle(request(body));
    expect(response.status).toBe(413);
  });

  test("returns 409 while the same app is deploying", async () => {
    let releaseBuild!: () => void;
    const buildBlocked = new Promise<void>((resolve) => { releaseBuild = resolve; });
    class BlockingRunner extends SuccessfulRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "podman" && args.at(-1) === "build") await buildBlocked;
        return super.run(command, args, options);
      }
    }

    const receiver = service(new BlockingRunner());
    expect((await receiver.handle(request(payload()))).status).toBe(202);
    const conflict = await receiver.handle(request(payload()));
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("retry-after")).toBe("60");
    expect(await conflict.json()).toEqual({
      error: "deployment_in_progress",
      message: "A deployment for myapp is already running.",
    });
    releaseBuild();
    await receiver.waitForIdle();
  });
});
