import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { addApp, initializeInstallation, installationPaths, SystemdUserServiceManager, type ServiceManager } from "../src/install";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/deploy";

const roots: string[] = [];
const packageRoot = resolve(import.meta.dir, "..");

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shibumi-install-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeServices implements ServiceManager {
  reloads = 0;
  restarts = 0;

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  async enableAndRestart(): Promise<void> {
    this.restarts += 1;
  }
}

async function initialized(home: string, services = new FakeServices()) {
  const result = await initializeInstallation({
    home,
    packageRoot,
    bunExecutable: "/home/example/.bun/bin/bun",
  }, services);
  return { result, services };
}

function appOptions(home: string, overrides: Record<string, unknown> = {}) {
  return {
    home,
    domain: "example.com",
    repository: "owner/repository",
    checkout: "/srv/shibumi/apps/example-com",
    hostPort: 9_100,
    testCommand: ["bun", "test"],
    ...overrides,
  } as Parameters<typeof addApp>[0];
}

describe("pinned installation", () => {
  test("copies the exact package release and writes restricted local files", async () => {
    const home = await temporaryHome();
    const { result, services } = await initialized(home);
    const paths = installationPaths(home);

    expect(result.version).toBe("0.1.0");
    expect(await readlink(paths.currentRelease)).toBe("releases/0.1.0");
    expect(await readFile(join(paths.currentRelease, "src", "cli.ts"), "utf8")).toContain("initializeInstallation");
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toEqual({
      listen: { hostname: "127.0.0.1", port: 8787, maxBodyBytes: 1_048_576 },
      apps: {},
    });
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.secrets)).mode & 0o777).toBe(0o600);

    const unit = await readFile(paths.service, "utf8");
    expect(unit).toContain(`WorkingDirectory="${paths.currentRelease}"`);
    expect(unit).toContain('ExecStart="/home/example/.bun/bin/bun"');
    expect(unit).toContain("MemoryMax=1536M");
    expect(unit).not.toContain("bunx");
    expect(services.reloads).toBe(1);
    expect(services.restarts).toBe(0);
  });

  test("does not overwrite machine config or secrets when init is rerun", async () => {
    const home = await temporaryHome();
    const { result, services } = await initialized(home);
    await writeFile(result.paths.config, '{"machine":"owned"}\n');
    await writeFile(result.paths.secrets, "KEEP=this-value\n");
    await chmod(result.paths.config, 0o644);
    await chmod(result.paths.secrets, 0o644);

    await initialized(home, services);

    expect(await readFile(result.paths.config, "utf8")).toBe('{"machine":"owned"}\n');
    expect(await readFile(result.paths.secrets, "utf8")).toBe("KEEP=this-value\n");
    expect((await stat(result.paths.config)).mode & 0o777).toBe(0o600);
    expect((await stat(result.paths.secrets)).mode & 0o777).toBe(0o600);
    expect(services.reloads).toBe(2);
  });
});

describe("app registration", () => {
  test("adds a validated app, generates one secret, and starts the service", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const result = await addApp(appOptions(home, { composeCommand: ["podman-compose"] }), services);
    const paths = installationPaths(home);

    expect(result.appId).toBe("example-com");
    expect(result.secretEnvironmentVariable).toBe("SHIBUMI_SECRET_EXAMPLE_COM");
    expect(result.config.apps["example-com"].composeCommand).toEqual(["podman-compose"]);
    expect(result.config.apps["example-com"].healthUrl).toBe("http://127.0.0.1:9100/healthz");
    expect(result.config.apps["example-com"].minimumFreeMemoryMb).toBe(2_048);

    const config = JSON.parse(await readFile(paths.config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/repository");
    expect(config.apps["example-com"].testCommand).toEqual(["bun", "test"]);
    const secrets = await readFile(paths.secrets, "utf8");
    expect(secrets).toMatch(/^SHIBUMI_SECRET_EXAMPLE_COM=[a-f0-9]{64}\n$/);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.secrets)).mode & 0o777).toBe(0o600);
    expect(services.restarts).toBe(1);
  });

  test("is idempotent for the same app and does not rotate its secret", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home), services);
    const before = await readFile(installationPaths(home).secrets, "utf8");

    await addApp(appOptions(home), services);

    expect(await readFile(installationPaths(home).secrets, "utf8")).toBe(before);
    expect(services.restarts).toBe(2);
  });

  test("recovers an already-written valid secret without rotating it", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const existing = "b".repeat(64);
    await writeFile(installationPaths(home).secrets, `SHIBUMI_SECRET_EXAMPLE_COM=${existing}\n`);

    await addApp(appOptions(home), services);

    expect(await readFile(installationPaths(home).secrets, "utf8")).toBe(`SHIBUMI_SECRET_EXAMPLE_COM=${existing}\n`);
  });

  test("rejects conflicting registrations and unsafe local values", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home), services);

    await expect(addApp(appOptions(home, { hostPort: 9_101 }), services)).rejects.toThrow("different settings");
    await expect(addApp(appOptions(home, { domain: "not-a-domain" }), services)).rejects.toThrow("public hostname");
    await expect(addApp(appOptions(home, { checkout: "relative/path" }), services)).rejects.toThrow("absolute path");
    await expect(addApp(appOptions(home, { healthPath: "//other-host/path" }), services)).rejects.toThrow("health path");
  });

  test("requires init and rejects ports already assigned to another app", async () => {
    const uninitialized = await temporaryHome();
    await expect(addApp(appOptions(uninitialized), new FakeServices())).rejects.toThrow("run init first");

    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home), services);
    await expect(addApp(appOptions(home, {
      domain: "second.example",
      repository: "owner/second",
      checkout: "/srv/shibumi/apps/second-example",
    }), services)).rejects.toThrow("assigned more than once");
  });
});

class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  results: CommandResult[] = [];

  async run(command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("systemd service management", () => {
  test("reloads, enables, and restarts the pinned user service", async () => {
    const runner = new FakeRunner();
    const services = new SystemdUserServiceManager(runner);

    await services.reload();
    await services.enableAndRestart();

    expect(runner.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "try-restart", "shibumi-server.service"],
      ["systemctl", "--user", "enable", "shibumi-server.service"],
      ["systemctl", "--user", "restart", "shibumi-server.service"],
    ]);
  });

  test("surfaces systemd failures", async () => {
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 1, stdout: "", stderr: "user manager unavailable" }];
    await expect(new SystemdUserServiceManager(runner).reload()).rejects.toThrow("user manager unavailable");
  });
});
