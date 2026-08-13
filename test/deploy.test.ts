import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { BunCommandRunner, deploy, DeploymentError, type CommandOptions, type CommandResult, type CommandRunner, type DeployDependencies, type Fetcher, type ResourceAvailability } from "../src/deploy";

const commit = "a".repeat(40);
const app: AppConfig = {
  repository: "owner/repo",
  ref: "refs/heads/main",
  checkout: "/srv/shibumi/apps/myapp",
  composeFile: "compose.yaml",
  composeCommand: ["podman", "compose"],
  composeProject: "myapp",
  service: "web",
  hostPort: 9100,
  testCommand: ["bun", "test"],
  healthUrl: "http://127.0.0.1:9100/healthz",
  secretEnvironmentVariable: "SHIBUMI_SECRET_MYAPP",
  minimumFreeMemoryMb: 1_536,
  minimumFreeDiskMb: 4_096,
  buildTimeoutMs: 600_000,
  healthAttempts: 2,
  healthIntervalMs: 10,
  retainedRollbackImages: 1,
};

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
  responses: CommandResult[] = [];

  async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const response = this.responses.shift();
    if (response) return response;
    if (args.includes("ps") && args.includes("--quiet")) return { exitCode: 0, stdout: "container-id\n", stderr: "" };
    if (args[0] === "container" && args[1] === "list") return { exitCode: 0, stdout: "container-id\n", stderr: "" };
    if (args[0] === "container" && args[1] === "inspect") return { exitCode: 0, stdout: "sha256:image-id\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function dependencies(
  runner: FakeRunner,
  fetchImplementation: Fetcher = async () => new Response("ok"),
  resources: ResourceAvailability = { memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 },
): DeployDependencies {
  return {
    runner,
    resources: { available: async () => resources },
    fetch: fetchImplementation,
    sleep: async () => {},
    logger: { info() {}, error() {} },
  };
}

describe("deployment pipeline", () => {
  test("fetches the exact commit, builds, tests, starts, and checks health", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await deploy("myapp", app, commit, dependencies(runner));

    const calls = runner.calls.map(({ command, args }) => [command, ...args]);
    expect(calls.slice(0, 7)).toEqual([
      ["git", "-C", app.checkout, "status", "--porcelain"],
      ["git", "-C", app.checkout, "fetch", "--prune", "origin", app.ref],
      ["git", "-C", app.checkout, "rev-parse", "FETCH_HEAD"],
      ["git", "-C", app.checkout, "reset", "--hard", commit],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "config", "--quiet"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "build"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "run", "--rm", "web", "bun", "test"],
    ]);
    expect(calls[7]).toEqual(["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "ps", "--quiet", "web"]);
    expect(calls[10]).toEqual(["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "up", "-d", "--remove-orphans"]);
    expect(calls[11]).toEqual([
      "podman", "container", "list",
      "--filter", "label=io.podman.compose.project=myapp",
      "--filter", "label=io.podman.compose.service=web",
      "--format", "{{.ID}}",
    ]);
    expect(calls[12]).toEqual(["podman", "container", "inspect", "--format", "{{.Image}}", "container-id"]);
    expect(calls[13]?.slice(0, 4)).toEqual(["podman", "image", "tag", "sha256:image-id"]);
    expect(calls[13]?.[4]).toMatch(/^localhost\/shibumi-server\/myapp:release-\d{13}-a{12}$/);
    expect(calls[14]).toEqual(["podman", "image", "list", "--filter", "reference=localhost/shibumi-server/myapp:release-*", "--format", "{{.Tag}}"]);
    expect(calls[15]).toEqual(["podman", "image", "prune", "--force"]);
    expect(runner.calls.find(({ args }) => args.includes("up"))?.options?.env).toEqual({ SHIBUMI_PORT: "9100" });
    expect(runner.calls.find(({ args }) => args.at(-1) === "build")?.options?.timeoutMs).toBe(600_000);
  });

  test("always validates Compose and allows app-owned tests to be omitted", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await deploy("myapp", { ...app, testCommand: undefined }, commit, dependencies(runner));

    expect(runner.calls.some(({ args }) => args.includes("config") && args.includes("--quiet"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("run"))).toBe(false);
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(true);
    expect(runner.calls.at(-1)?.args).toEqual(["image", "prune", "--force"]);
  });

  test("does not fail a healthy deployment when image cleanup fails", async () => {
    class PruneFailingRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        const result = await super.run(command, args, options);
        if (command === "podman" && args[0] === "image" && args[1] === "prune") {
          return { exitCode: 1, stdout: "", stderr: "cleanup failed" };
        }
        return result;
      }
    }
    const runner = new PruneFailingRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await expect(deploy("myapp", app, commit, dependencies(runner))).resolves.toBeUndefined();
    expect(runner.calls.at(-1)?.args).toEqual(["image", "prune", "--force"]);
  });

  test("keeps two successful images total", async () => {
    class RetentionRunner extends FakeRunner {
      override async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "podman" && args[0] === "image" && args[1] === "list") {
          this.calls.push({ command, args, options });
          return {
            exitCode: 0,
            stdout: [
              "release-1700000004000-bbbbbbbbbbbb",
              "release-1700000003000-cccccccccccc",
              "release-1700000002000-dddddddddddd",
              "release-1700000001000-eeeeeeeeeeee",
            ].join("\n"),
            stderr: "",
          };
        }
        return super.run(command, args, options);
      }
    }
    const runner = new RetentionRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];

    await deploy("myapp", app, commit, dependencies(runner));

    const removed = runner.calls
      .filter(({ command, args }) => command === "podman" && args[0] === "image" && args[1] === "rm")
      .map(({ args }) => args[2]);
    expect(removed).toEqual([
      "localhost/shibumi-server/myapp:release-1700000003000-cccccccccccc",
      "localhost/shibumi-server/myapp:release-1700000002000-dddddddddddd",
      "localhost/shibumi-server/myapp:release-1700000001000-eeeeeeeeeeee",
    ]);
    expect(runner.calls.at(-1)?.args).toEqual(["image", "prune", "--force"]);
  });

  test("stops before building when the Compose config is invalid", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "invalid compose" },
    ];

    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("config failed: invalid compose");
    expect(runner.calls.some(({ args }) => args.includes("build"))).toBe(false);
  });

  test("refuses to deploy when available memory is below the configured floor", async () => {
    const runner = new FakeRunner();
    await expect(deploy(
      "myapp",
      app,
      commit,
      dependencies(runner, undefined, { memoryBytes: 1_535 * 1024 ** 2, diskBytes: 100 * 1024 ** 3 }),
    )).rejects.toEqual(
      new DeploymentError("preflight", "resource preflight failed: 1535 MiB memory available; 1536 MiB required"),
    );
    expect(runner.calls).toHaveLength(0);
  });

  test("refuses to deploy when available disk is below the configured floor", async () => {
    const runner = new FakeRunner();
    await expect(deploy(
      "myapp",
      app,
      commit,
      dependencies(runner, undefined, { memoryBytes: 8 * 1024 ** 3, diskBytes: 4_095 * 1024 ** 2 }),
    )).rejects.toThrow("4095 MiB disk available; 4096 MiB required");
    expect(runner.calls).toHaveLength(0);
  });

  test("refuses a dirty checkout before fetching", async () => {
    const runner = new FakeRunner();
    runner.responses = [{ exitCode: 0, stdout: " M compose.yaml\n", stderr: "" }];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("local changes");
    expect(runner.calls).toHaveLength(1);
  });

  test("rejects a fetched SHA mismatch", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("no longer matches");
    expect(runner.calls).toHaveLength(3);
  });

  test("allows rollback only when the SHA is an ancestor of the configured branch", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    await deploy("myapp", app, commit, dependencies(runner), { allowAncestor: true });

    expect(runner.calls[3]).toMatchObject({ command: "git", args: ["-C", app.checkout, "merge-base", "--is-ancestor", commit, "FETCH_HEAD"] });
    expect(runner.calls[4]).toMatchObject({ command: "git", args: ["-C", app.checkout, "reset", "--hard", commit] });
  });

  test("does not start the app when the build fails", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "broken build" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toEqual(
      new DeploymentError("build", "build failed: broken build"),
    );
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  test("cancels a build that exceeds its deadline", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 137, stdout: "", stderr: "", timedOut: true },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toEqual(
      new DeploymentError("build", "build timed out after 600000ms"),
    );
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  test("does not start the app when its container tests fail", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "failed tests" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("test failed: failed tests");
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  test("the Bun runner kills a process after its timeout", async () => {
    const result = await new BunCommandRunner().run(
      process.execPath,
      ["--eval", "await Bun.sleep(10_000)"],
      { capture: true, timeoutMs: 25 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("restores the previous image when the new release fails health checks", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];
    let healthChecks = 0;
    const health: Fetcher = async () => new Response("health", { status: ++healthChecks <= app.healthAttempts ? 503 : 200 });

    await expect(deploy("myapp", app, commit, dependencies(runner, health))).rejects.toThrow("health check did not pass");

    expect(runner.calls.some(({ command, args }) => command === "podman" && args[0] === "image" && args[1] === "tag" && args[2] === "sha256:image-id")).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("--no-build") && args.includes("--force-recreate"))).toBe(true);
  });

  test("reports a health timeout after starting", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];
    const unavailable: Fetcher = async () => new Response("no", { status: 503 });
    await expect(deploy("myapp", app, commit, dependencies(runner, unavailable))).rejects.toThrow("health check did not pass");
    expect(runner.calls.some(({ args }) => args[0] === "image" && args[1] === "prune")).toBe(false);
  });
});
