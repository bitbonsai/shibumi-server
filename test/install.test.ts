import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { addApp, appIdForDomain, enablePrebuiltApp, ensurePathIntegration, GitCheckoutManager, initializeInstallation, installationPaths, markCaddyManaged, registeredApps, removeApp, setAppRepository, setDeploymentMode, SystemdUserServiceManager, uninstallInstallation, type CheckoutManager, type ServiceManager } from "../src/install";
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

const checkouts: CheckoutManager = { async prepare(options) { return options.composeFile ?? "compose.yaml"; } };

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
    expect(await readFile(paths.shortLauncher, "utf8")).toBe(launcher);
    expect((await stat(paths.shortLauncher)).mode & 0o777).toBe(0o755);
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
    expect(unit).toContain("KillMode=process");
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

  test("caps existing app retention at two successful images during update", async () => {
    const home = await temporaryHome();
    const { result, services } = await initialized(home);
    const config = JSON.parse(await readFile(result.paths.config, "utf8"));
    config.apps.example = { retainedRollbackImages: 2 };
    await writeFile(result.paths.config, `${JSON.stringify(config)}\n`);

    await initialized(home, services);

    expect(JSON.parse(await readFile(result.paths.config, "utf8")).apps.example.retainedRollbackImages).toBe(1);
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
    await expect(stat(result.paths.shortLauncher)).rejects.toThrow();
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
    expect(result.config.apps["example-com"].releaseRetention).toBe(2);

    const config = JSON.parse(await readFile(paths.config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/repository");
    expect(config.apps["example-com"].testCommand).toEqual(["bun", "test"]);
    const secrets = await readFile(paths.secrets, "utf8");
    expect(secrets).toMatch(/^SHIBUMI_SECRET_EXAMPLE_COM=[a-f0-9]{64}\n$/);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.secrets)).mode & 0o777).toBe(0o600);
    expect(services.restarts).toBe(1);
  });

  test("switches deployment mode without changing app identity", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home), services, checkouts);

    await enablePrebuiltApp(home, "example-com", services);

    const parsed = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(parsed.apps["example-com"].deploymentMode).toBe("prebuilt");
    expect(parsed.apps["example-com"].minimumFreeMemoryMb).toBe(512);
    expect(parsed.apps["example-com"].repository).toBe("owner/repository");

    await setDeploymentMode(home, "example-com", "build", services);
    const built = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(built.apps["example-com"].deploymentMode).toBe("build");
    expect(built.apps["example-com"].minimumFreeMemoryMb).toBe(2_048);
    expect(services.restarts).toBe(3);
  });

  test("persists a discovered nested Compose config", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const nested: CheckoutManager = { async prepare() { return "website/compose.yaml"; } };

    const result = await addApp(appOptions(home), services, nested);

    expect(result.config.apps["example-com"].composeFile).toBe("website/compose.yaml");
    const config = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(config.apps["example-com"].composeFile).toBe("website/compose.yaml");
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

  test("lists and removes apps while preserving deployment data", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    await addApp(appOptions(home, { caddyMode: "managed", composeCommand: ["podman"] }), services, checkouts);
    await addApp(appOptions(home, {
      domain: "second.example",
      repository: "owner/second",
      checkout: "/srv/shibumi/apps/second-example",
      hostPort: 9_101,
      caddyMode: "preserve",
    }), services, checkouts);
    const paths = installationPaths(home);
    await mkdir(join(paths.statusDirectory, "queue"), { recursive: true });
    await mkdir(paths.historyDirectory, { recursive: true });
    await mkdir(paths.logsDirectory, { recursive: true });
    await writeFile(join(paths.statusDirectory, "example-com.json"), "{}\n");
    await writeFile(join(paths.statusDirectory, "queue", "example-com.json"), "{}\n");
    await writeFile(join(paths.historyDirectory, "example-com.jsonl"), "{}\n");
    await writeFile(join(paths.logsDirectory, "example-com.log"), "build output\n");
    await mkdir(join(paths.configDirectory, "env"), { recursive: true });
    await writeFile(join(paths.configDirectory, "env", "example-com.env"), "API_KEY=secret\n");
    const runner = new FakeRunner();

    expect((await registeredApps(home)).map((app) => app.domain)).toEqual(["example.com", "second.example"]);
    const first = await removeApp(home, "example.com", services, runner);
    expect(first.remainingApps).toBe(1);
    expect(first.app.checkout).toBe("/srv/shibumi/apps/example-com");
    expect(runner.calls[0]).toEqual([
      "podman", "compose", "--project-name", "example-com", "--file", "/srv/shibumi/apps/example-com/compose.yaml", "down",
    ]);
    expect(await Bun.file(join(paths.statusDirectory, "example-com.json")).exists()).toBe(false);
    expect(await Bun.file(join(paths.statusDirectory, "queue", "example-com.json")).exists()).toBe(false);
    expect(await Bun.file(join(paths.historyDirectory, "example-com.jsonl")).exists()).toBe(false);
    expect(await Bun.file(join(paths.logsDirectory, "example-com.log")).exists()).toBe(false);
    expect(await Bun.file(join(paths.configDirectory, "env", "example-com.env")).exists()).toBe(false);
    expect(await readFile(paths.secrets, "utf8")).not.toContain("SHIBUMI_SECRET_EXAMPLE_COM=");
    expect(await readFile(paths.secrets, "utf8")).toContain("SHIBUMI_SECRET_SECOND_EXAMPLE=");
    expect(services.restarts).toBe(3);

    const last = await removeApp(home, "second-example", services, runner);
    expect(last.remainingApps).toBe(0);
    expect(await registeredApps(home)).toEqual([]);
    expect(JSON.parse(await readFile(paths.config, "utf8")).apps).toEqual({});
    expect(services.stops).toBe(1);
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
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" },
    ];

    expect(await new GitCheckoutManager(runner).prepare({
      repository: "owner/repository",
      checkout,
      composeFile: "compose.yaml",
    })).toBe("compose.yaml");

    expect(runner.calls).toEqual([
      ["git", "-C", checkout, "remote", "get-url", "origin"],
      ["git", "-C", checkout, "ls-remote", "--exit-code", "origin", "refs/heads/main"],
      ["git", "-C", checkout, "status", "--porcelain"],
      ["git", "-C", checkout, "fetch", "--quiet", "origin", "refs/heads/main"],
      ["git", "-C", checkout, "rev-parse", "FETCH_HEAD"],
      ["git", "-C", checkout, "merge", "--ff-only", "FETCH_HEAD"],
      ["git", "-C", checkout, "rev-parse", "HEAD"],
    ]);
  });

  test("selects one tracked nested Compose config when none was specified", async () => {
    const root = await temporaryHome();
    const checkout = join(root, "app");
    await mkdir(checkout, { recursive: true });
    const sha = "a".repeat(40);
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 0, stdout: "https://github.com/owner/repository.git\n", stderr: "" },
      { exitCode: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${sha}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${sha}\n`, stderr: "" },
      { exitCode: 0, stdout: "website/compose.yaml\n", stderr: "" },
    ];

    expect(await new GitCheckoutManager(runner).prepare({
      repository: "owner/repository",
      checkout,
    })).toBe("website/compose.yaml");
  });

  test("gives a source-owned next step when an explicit Compose config is absent", async () => {
    const root = await temporaryHome();
    const checkout = join(root, "app");
    await mkdir(checkout, { recursive: true });
    const sha = "a".repeat(40);
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 0, stdout: "https://github.com/owner/repository.git\n", stderr: "" },
      { exitCode: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${sha}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${sha}\n`, stderr: "" },
      { exitCode: 0, stdout: "website/compose.yaml\n", stderr: "" },
    ];

    await expect(new GitCheckoutManager(runner).prepare({
      repository: "owner/repository",
      checkout,
      composeFile: "compose.yaml",
    })).rejects.toThrow("Found website/compose.yaml. Rerun add with --compose-file website/compose.yaml");
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

  test("offers to move a mismatched checkout to .bak and clone fresh when a replacement is confirmed", async () => {
    const root = await temporaryHome();
    const checkout = join(root, "app");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "marker.txt"), "original checkout\n");
    const sha = "a".repeat(40);
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 0, stdout: "https://github.com/other/repository.git\n", stderr: "" }, // mismatched origin
      { exitCode: 0, stdout: "", stderr: "" }, // clone
      { exitCode: 0, stdout: "https://github.com/owner/repository.git\n", stderr: "" }, // matching origin after clone
      { exitCode: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: "" }, // ls-remote
      { exitCode: 0, stdout: "compose.yaml\n", stderr: "" }, // ls-files
    ];
    const seen: Array<{ checkout: string; backup: string; repository: string }> = [];
    const confirmReplacement = async (mismatch: { checkout: string; backup: string; repository: string }) => {
      seen.push(mismatch);
      return true;
    };

    const composeFile = await new GitCheckoutManager(runner, confirmReplacement).prepare({
      repository: "owner/repository",
      checkout,
    });

    expect(composeFile).toBe("compose.yaml");
    expect(seen).toEqual([{ checkout, backup: `${checkout}.bak`, repository: "owner/repository" }]);
    expect(await readFile(join(`${checkout}.bak`, "marker.txt"), "utf8")).toBe("original checkout\n");
    expect(runner.calls[1]).toEqual([
      "git", "clone", "--branch", "main", "--single-branch", "https://github.com/owner/repository.git", checkout,
    ]);
  });

  test("declines the replacement when the confirmation is rejected, preserving the checkout", async () => {
    const root = await temporaryHome();
    const checkout = join(root, "app");
    await mkdir(checkout, { recursive: true });
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 0, stdout: "https://github.com/other/repository.git\n", stderr: "" }];

    await expect(new GitCheckoutManager(runner, async () => false).prepare({
      repository: "owner/repository",
      checkout,
    })).rejects.toThrow("does not match");

    expect(await stat(checkout).then(() => true)).toBe(true);
    expect(await stat(`${checkout}.bak`).then(() => true, () => false)).toBe(false);
  });

  test("refuses to replace a mismatched checkout when the .bak destination already exists", async () => {
    const root = await temporaryHome();
    const checkout = join(root, "app");
    const backup = `${checkout}.bak`;
    await mkdir(checkout, { recursive: true });
    await mkdir(backup, { recursive: true });
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 0, stdout: "https://github.com/other/repository.git\n", stderr: "" }];
    let confirmed = false;
    const confirmReplacement = async () => {
      confirmed = true;
      return true;
    };

    await expect(new GitCheckoutManager(runner, confirmReplacement).prepare({
      repository: "owner/repository",
      checkout,
    })).rejects.toThrow(`${backup} already exists`);
    expect(confirmed).toBe(false);
  });
});

describe("app repository repointing", () => {
  test("moves the checkout to .bak, clones the new repository, and updates config", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const root = await temporaryHome();
    const originalCheckout = join(root, "example-com");
    await mkdir(originalCheckout, { recursive: true });
    await addApp(appOptions(home, { checkout: originalCheckout }), services, checkouts);
    const paths = installationPaths(home);
    const cloneInto: CheckoutManager = {
      async prepare(options) {
        expect(options.repository).toBe("owner/new-repository");
        expect(options.checkout).toBe(originalCheckout);
        return "compose.yaml";
      },
    };

    const result = await setAppRepository(home, "example-com", "owner/new-repository", undefined, services, cloneInto);

    expect(result).toEqual({
      appId: "example-com",
      domain: "example.com",
      checkout: originalCheckout,
      backup: `${originalCheckout}.bak`,
      repository: "owner/new-repository",
      ref: "refs/heads/main",
    });
    const config = JSON.parse(await readFile(paths.config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/new-repository");
    expect(config.apps["example-com"].checkout).toBe(originalCheckout);
    expect(services.restarts).toBe(2);
  });

  test("reverts the checkout rename when the fresh clone fails", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const root = await temporaryHome();
    const checkout = join(root, "example-com");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "marker.txt"), "kept\n");
    await addApp(appOptions(home, { checkout }), services, checkouts);
    const failingClone: CheckoutManager = { async prepare() { throw new Error("cannot clone owner/new-repository"); } };

    await expect(setAppRepository(home, "example-com", "owner/new-repository", undefined, services, failingClone))
      .rejects.toThrow("cannot clone");

    expect(await readFile(join(checkout, "marker.txt"), "utf8")).toBe("kept\n");
    const config = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/repository");
  });

  test("refuses to repoint when the .bak destination already exists", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const root = await temporaryHome();
    const checkout = join(root, "example-com");
    await mkdir(checkout, { recursive: true });
    await mkdir(`${checkout}.bak`, { recursive: true });
    await addApp(appOptions(home, { checkout }), services, checkouts);

    await expect(setAppRepository(home, "example-com", "owner/new-repository", undefined, services, checkouts))
      .rejects.toThrow("already exists");
  });

  test("rejects an unknown app selector", async () => {
    const home = await temporaryHome();
    await initialized(home);

    await expect(setAppRepository(home, "missing", "owner/new-repository", undefined)).rejects.toThrow("unknown app");
  });
});

describe("PATH integration", () => {
  test("symlinks the launchers into a writable system bin directory", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "usr-local-bin");
    await mkdir(systemBinDirectory, { recursive: true });
    const runner = new FakeRunner();

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).toBe("symlink");
    expect(await readFile(join(systemBinDirectory, "shis"), "utf8")).toBe(await readFile(result.paths.shortLauncher, "utf8"));
    expect(await readFile(join(systemBinDirectory, "shibumi-server"), "utf8")).toBe(await readFile(result.paths.launcher, "utf8"));
    expect(runner.calls).toEqual([]);
  });

  test("falls back to passwordless sudo when the system bin directory is not directly writable", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-directly");
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).toBe("symlink");
    expect(runner.calls).toEqual([
      ["sudo", "-n", "ln", "-sf", result.paths.shortLauncher, join(systemBinDirectory, "shis")],
      ["sudo", "-n", "ln", "-sf", result.paths.launcher, join(systemBinDirectory, "shibumi-server")],
    ]);
  });

  test("falls back to ~/.profile, with an honest caveat, when sudo is unavailable", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-at-all");
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 1, stdout: "", stderr: "sudo: a password is required" }];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).toBe("profile-appended");
    expect(outcome.detail).toContain("only takes effect for login shells");
    expect(outcome.detail).toContain(`sudo ln -sf ${result.paths.shortLauncher} ${systemBinDirectory}/shis`);
    const profile = await readFile(join(home, ".profile"), "utf8");
    expect(profile).toContain(`export PATH="${result.paths.binDirectory}:$PATH"`);
  });

  test("does not duplicate the ~/.profile entry on a second run", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-at-all");
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
    ];

    await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);
    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).toBe("profile-existing");
    const profile = await readFile(join(home, ".profile"), "utf8");
    expect(profile.split(result.paths.binDirectory)).toHaveLength(2);
  });

  test("prompts for sudo authorization only when the caller opts in", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-at-all-2");
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 1, stdout: "", stderr: "" }, // passwordless sudo -n for shis fails
      { exitCode: 0, stdout: "", stderr: "" }, // sudo -v succeeds (password entered)
      { exitCode: 0, stdout: "", stderr: "" }, // sudo -n ln for shis
      { exitCode: 0, stdout: "", stderr: "" }, // sudo -n ln for shibumi-server
    ];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory, allowSudoPrompt: true }, runner);

    expect(outcome.method).toBe("symlink");
    expect(runner.calls[1]).toEqual(["sudo", "-v"]);
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
