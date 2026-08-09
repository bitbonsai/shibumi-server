import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { deploy, DeploymentError, type CommandOptions, type CommandResult, type CommandRunner, type DeployDependencies, type Fetcher } from "../src/deploy";

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

function dependencies(runner: FakeRunner, fetchImplementation: Fetcher = async () => new Response("ok")): DeployDependencies {
  return {
    runner,
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
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "build"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "run", "--rm", "web", "bun", "test"],
      ["podman", "compose", "--project-name", "myapp", "--file", `${app.checkout}/compose.yaml`, "up", "-d", "--remove-orphans"],
    ]);
    expect(runner.calls.at(-1)?.options?.env).toEqual({ SHIBUMI_PORT: "9100" });
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
      { exitCode: 1, stdout: "", stderr: "broken build" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toEqual(
      new DeploymentError("build", "build failed: broken build"),
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
      { exitCode: 1, stdout: "", stderr: "failed tests" },
    ];
    await expect(deploy("myapp", app, commit, dependencies(runner))).rejects.toThrow("test failed: failed tests");
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
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
