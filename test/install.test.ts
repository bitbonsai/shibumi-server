import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { addApp, appIdForDomain, GitCheckoutManager, initializeInstallation, installationPaths, markCaddyManaged, SystemdUserServiceManager, uninstallInstallation, type CheckoutManager, type ServiceManager } from "../src/install";
import packageJson from "../package.json";
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

const checkouts: CheckoutManager = { async prepare() {} };

class FakeServices implements ServiceManager {
  reloads = 0;
  unitReloads = 0;
  restarts = 0;
  stops = 0;

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  async reloadUnits(): Promise<void> {
    this.unitReloads += 1;
  }

  async enableAndRestart(): Promise<void> {
    this.restarts += 1;
  }

  async disableAndStop(): Promise<void> {
    this.stops += 1;
  }
}

async function initialized(home: string, services = new FakeServices()) {
  const result = await initializeInstallation({
    home,
    packageRoot,
    bunExecutable: process.execPath,
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
    ...overrides,
  } as Parameters<typeof addApp>[0];
}

describe("pinned installation", () => {
  test("copies the exact package release and writes restricted local files", async () => {
    const home = await temporaryHome();
    const { result, services } = await initialized(home);
    const paths = installationPaths(home);

    expect(result.version).toBe(packageJson.version);
    expect(await readlink(paths.currentRelease)).toBe(`releases/${packageJson.version}`);
    const launcher = await readFile(paths.launcher, "utf8");
    expect(launcher).toContain(`exec '${process.execPath}'`);
    expect((await stat(paths.launcher)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(paths.currentRelease, "src", "cli.ts"), "utf8")).toContain("initializeInstallation");
    expect(JSON.parse(await readFile(join(paths.currentRelease, "node_modules", "@clack", "prompts", "package.json"), "utf8")).name)
      .toBe("@clack/prompts");
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toEqual({
      listen: { hostname: "127.0.0.1", port: 8787, maxBodyBytes: 1_048_576 },
      apps: {},
    });
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.secrets)).mode & 0o777).toBe(0o600);

    const unit = await readFile(paths.service, "utf8");
    expect(unit).toContain(`WorkingDirectory=${paths.currentRelease}`);
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).toContain(`ExecStart="${process.execPath}"`);
    expect(unit).toContain("MemoryMax=1536M");
    expect(unit).not.toContain("bunx");

    const check = Bun.spawn([
      paths.launcher,
      "--help",
    ], { cwd: paths.currentRelease, env: { PATH: "/usr/bin:/bin", SHIBUMI_SKIP_UPDATE_CHECK: "1" }, stdout: "pipe", stderr: "pipe" });
    const [checkExit, checkStdout, checkStderr] = await Promise.all([
      check.exited,
      new Response(check.stdout).text(),
      new Response(check.stderr).text(),
    ]);
    expect(checkStderr).toBe("");
    expect(checkExit).toBe(0);
    expect(checkStdout).toContain("Guided installation");

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

describe("uninstall", () => {
  test("removes installed code while preserving config and secrets", async () => {
    const home = await temporaryHome();
    const services = new FakeServices();
    const { result } = await initialized(home, services);

    await uninstallInstallation(home, false, services);

    await expect(stat(result.paths.launcher)).rejects.toThrow();
    await expect(stat(result.paths.dataDirectory)).rejects.toThrow();
    await expect(stat(result.paths.service)).rejects.toThrow();
    expect(await readFile(result.paths.config, "utf8")).toContain('"apps"');
    expect(await readFile(result.paths.secrets, "utf8")).toBe("");
    expect(services.stops).toBe(1);
    expect(services.unitReloads).toBe(1);
  });

  test("purges config and secrets only when requested", async () => {
    const home = await temporaryHome();
    const services = new FakeServices();
    const { result } = await initialized(home, services);

    await uninstallInstallation(home, true, services);

    await expect(stat(result.paths.configDirectory)).rejects.toThrow();
  });
});

describe("app registration", () => {
  test("creates distinct ids for dots and literal hyphens", () => {
    expect(appIdForDomain("something-some.org")).toBe("something--some-org");
    expect(appIdForDomain("something.some-org")).toBe("something-some--org");
  });

  test("adds a validated app, generates one secret, and starts the service", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const result = await addApp(appOptions(home, {
      composeCommand: ["podman-compose"],
      testCommand: ["bun", "test"],
    }), services, checkouts);
    const paths = installationPaths(home);

    expect(result.appId).toBe("example-com");
    expect(result.secretEnvironmentVariable).toBe("SHIBUMI_SECRET_EXAMPLE_COM");
    expect(result.config.apps["example-com"].composeCommand).toEqual(["podman-compose"]);
    expect(result.config.apps["example-com"].healthUrl).toBe("http://127.0.0.1:9100/healthz");
    expect(result.config.apps["example-com"].minimumFreeMemoryMb).toBe(2_048);
    expect(result.config.apps["example-com"].retainedRollbackImages).toBe(2);

    const config = JSON.parse(await readFile(paths.config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/repository");
    expect(config.apps["example-com"].testCommand).toEqual(["bun", "test"]);
    const secrets = await readFile(paths.secrets, "utf8");
    expect(secrets).toMatch(/^SHIBUMI_SECRET_EXAMPLE_COM=[a-f0-9]{64}\n$/);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.secrets)).mode & 0o777).toBe(0o600);
    expect(services.restarts).toBe(1);
  });

  test("previews the complete app without changing config, secrets, or systemd", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const paths = installationPaths(home);
    const configBefore = await readFile(paths.config, "utf8");
    const secretsBefore = await readFile(paths.secrets, "utf8");

    const result = await addApp(appOptions(home, { dryRun: true }), services, checkouts);

    expect(result.appId).toBe("example-com");
    expect(result.config.apps["example-com"].hostPort).toBe(9_100);
    expect(await readFile(paths.config, "utf8")).toBe(configBefore);
    expect(await readFile(paths.secrets, "utf8")).toBe(secretsBefore);
    expect(services.restarts).toBe(0);
  });

  test("marks a staged Caddy migration as managed after cutover", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home, { caddyMode: "preserve" }), services, checkouts);

    await markCaddyManaged(home, "example-com");

    const config = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(config.apps["example-com"].caddyMode).toBe("managed");
  });

  test("is idempotent for the same app and does not rotate its secret", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home), services, checkouts);
    const before = await readFile(installationPaths(home).secrets, "utf8");

    await addApp(appOptions(home), services, checkouts);

    expect(await readFile(installationPaths(home).secrets, "utf8")).toBe(before);
    expect(services.restarts).toBe(2);
  });

  test("recovers an already-written valid secret without rotating it", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const existing = "b".repeat(64);
    await writeFile(installationPaths(home).secrets, `SHIBUMI_SECRET_EXAMPLE_COM=${existing}\n`);

    await addApp(appOptions(home), services, checkouts);

    expect(await readFile(installationPaths(home).secrets, "utf8")).toBe(`SHIBUMI_SECRET_EXAMPLE_COM=${existing}\n`);
  });

  test("rejects conflicting registrations and unsafe local values", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home), services, checkouts);

    await expect(addApp(appOptions(home, { hostPort: 9_101 }), services, checkouts)).rejects.toThrow("different settings");
    await expect(addApp(appOptions(home, { domain: "not-a-domain" }), services, checkouts)).rejects.toThrow("public hostname");
    await expect(addApp(appOptions(home, { checkout: "relative/path" }), services, checkouts)).rejects.toThrow("absolute path");
    await expect(addApp(appOptions(home, { healthPath: "//other-host/path" }), services, checkouts)).rejects.toThrow("health path");
  });

  test("requires init and rejects ports already assigned to another app", async () => {
    const uninitialized = await temporaryHome();
    await expect(addApp(appOptions(uninitialized), new FakeServices(), checkouts)).rejects.toThrow("run init first");

    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home), services, checkouts);
    await expect(addApp(appOptions(home, {
      domain: "second.example",
      repository: "owner/second",
      checkout: "/srv/shibumi/apps/second-example",
    }), services, checkouts)).rejects.toThrow("assigned more than once");
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

describe("Git checkout preparation", () => {
  test("accepts a matching existing checkout with Compose config", async () => {
    const root = await temporaryHome();
    const checkout = join(root, "app");
    await mkdir(checkout, { recursive: true });
    await Bun.write(join(checkout, "compose.yaml"), "services: {}\n");
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 0, stdout: "git@github.com:owner/repository.git\n", stderr: "" },
      { exitCode: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n`, stderr: "" },
    ];

    await new GitCheckoutManager(runner).prepare({
      repository: "owner/repository",
      checkout,
      composeFile: "compose.yaml",
    });

    expect(runner.calls).toEqual([
      ["git", "-C", checkout, "remote", "get-url", "origin"],
      ["git", "-C", checkout, "ls-remote", "--exit-code", "origin", "refs/heads/main"],
    ]);
  });

  test("rejects a mismatched checkout origin", async () => {
    const root = await temporaryHome();
    const checkout = join(root, "app");
    await mkdir(checkout, { recursive: true });
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 0, stdout: "https://github.com/other/repository.git\n", stderr: "" }];

    await expect(new GitCheckoutManager(runner).prepare({
      repository: "owner/repository",
      checkout,
      composeFile: "compose.yaml",
    })).rejects.toThrow("does not match");
  });
});

describe("systemd service management", () => {
  test("reloads, enables, and restarts the pinned user service", async () => {
    const runner = new FakeRunner();
    const services = new SystemdUserServiceManager(runner);

    await services.reload();
    await services.enableAndRestart();
    await services.disableAndStop();

    expect(runner.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "try-restart", "shibumi-server.service"],
      ["systemctl", "--user", "enable", "shibumi-server.service"],
      ["systemctl", "--user", "restart", "shibumi-server.service"],
      ["systemctl", "--user", "disable", "--now", "shibumi-server.service"],
    ]);
  });

  test("surfaces systemd failures", async () => {
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 1, stdout: "", stderr: "user manager unavailable" }];
    await expect(new SystemdUserServiceManager(runner).reload()).rejects.toThrow("user manager unavailable");
  });
});
