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
};

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
  responses: CommandResult[] = [];

  async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    return this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
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

    expect(runner.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["git", "-C", app.checkout, "status", "--porcelain"],
      ["git", "-C", app.checkout, "fetch", "--prune", "origin", app.ref],
      ["git", "-C", app.checkout, "rev-parse", "FETCH_HEAD"],
      ["git", "-C", app.checkout, "reset", "--hard", commit],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "config", "--quiet"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "build"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "run", "--rm", "web", "bun", "test"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "up", "-d", "--remove-orphans"],
    ]);
    expect(runner.calls.at(-1)?.options?.env).toEqual({ SHIBUMI_PORT: "9100" });
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

  test("reports a health timeout after starting", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${commit}\n`, stderr: "" },
    ];
    const unavailable: Fetcher = async () => new Response("no", { status: 503 });
    await expect(deploy("myapp", app, commit, dependencies(runner, unavailable))).rejects.toThrow("health check did not pass");
  });
});
