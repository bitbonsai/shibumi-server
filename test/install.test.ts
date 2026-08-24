import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { addApp, appIdForDomain, applyProfileFallback, enablePrebuiltApp, ensurePathIntegration, GitCheckoutManager, initializeInstallation, installationPaths, markCaddyManaged, registeredApps, removeApp, setAppRepository, setDeploymentMode, SystemdUserServiceManager, trySymlinkPath, uninstallInstallation, type CheckoutManager, type ServiceManager } from "../src/install";
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

// Bun.spawn rejects rather than resolving with a non-zero exit code when the
// executable itself is missing (e.g. no `sudo` on a minimal container or a
// hardened deploy user's PATH). FakeRunner alone can't reproduce that.
class RejectingRunner implements CommandRunner {
  calls: string[][] = [];

  constructor(private readonly rejectCommand: string, private readonly error: Error) {}

  async run(command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (command === this.rejectCommand) throw this.error;
    return { exitCode: 0, stdout: "", stderr: "" };
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

  test("reverts the checkout rename when the fresh clone fails after already writing files", async () => {
    // A real clone can fail partway through a later step (e.g. Compose-file
    // detection) after it has already populated the checkout directory. The
    // fake here reproduces that by writing into options.checkout before
    // throwing, so the revert has to clear a non-empty directory rather than
    // rename onto empty space.
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const root = await temporaryHome();
    const checkout = join(root, "example-com");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "marker.txt"), "kept\n");
    await addApp(appOptions(home, { checkout }), services, checkouts);
    const failingClone: CheckoutManager = {
      async prepare(options) {
        await mkdir(options.checkout, { recursive: true });
        await writeFile(join(options.checkout, "partial.txt"), "new repo content\n");
        throw new Error("cannot clone owner/new-repository");
      },
    };

    await expect(setAppRepository(home, "example-com", "owner/new-repository", undefined, services, failingClone))
      .rejects.toThrow("cannot clone");

    expect(await readFile(join(checkout, "marker.txt"), "utf8")).toBe("kept\n");
    expect(await stat(join(checkout, "partial.txt")).then(() => true, () => false)).toBe(false);
    const config = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/repository");
  });

  test("wraps the clone error with the .bak location when the revert itself fails", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const root = await temporaryHome();
    const checkout = join(root, "example-com");
    await mkdir(checkout, { recursive: true });
    await addApp(appOptions(home, { checkout }), services, checkouts);
    const backup = `${checkout}.bak`;
    const sabotagedClone: CheckoutManager = {
      async prepare() {
        // Simulate the backup disappearing out from under us mid-clone, so
        // the revert (renaming it back) cannot succeed either.
        await rm(backup, { recursive: true, force: true });
        throw new Error("cannot clone owner/new-repository");
      },
    };

    const failure = await setAppRepository(home, "example-com", "owner/new-repository", undefined, services, sabotagedClone)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("cannot clone");
    expect((failure as Error).message).toContain(backup);
  });

  test("reverts the checkout when the post-clone config candidate fails validation", async () => {
    const home = await temporaryHome();
    const { services } = await initialized(home);
    const root = await temporaryHome();
    const checkout = join(root, "example-com");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "marker.txt"), "kept\n");
    await addApp(appOptions(home, { checkout }), services, checkouts);
    const escapingCompose: CheckoutManager = {
      async prepare(options) {
        await mkdir(options.checkout, { recursive: true });
        await writeFile(join(options.checkout, "cloned.txt"), "new repo\n");
        return "../escape.yaml";
      },
    };

    await expect(setAppRepository(home, "example-com", "owner/new-repository", undefined, services, escapingCompose))
      .rejects.toThrow("composeFile must stay inside checkout");

    expect(await readFile(join(checkout, "marker.txt"), "utf8")).toBe("kept\n");
    expect(await stat(join(checkout, "cloned.txt")).then(() => true, () => false)).toBe(false);
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

  test("appends through a symlinked ~/.profile instead of replacing it", async () => {
    // Dotfile managers commonly symlink ~/.profile into a managed repo; a
    // temp-file-then-rename write would silently swap that symlink out for a
    // plain file, so the appended line would never reach the real dotfile.
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const dotfilesRoot = await temporaryHome();
    const realProfile = join(dotfilesRoot, "profile");
    await writeFile(realProfile, "# managed by dotfiles\n");
    await symlink(realProfile, join(home, ".profile"));

    await applyProfileFallback(home, result.paths, "/usr/local/bin");

    expect((await lstat(join(home, ".profile"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(home, ".profile"))).toBe(realProfile);
    const content = await readFile(realProfile, "utf8");
    expect(content).toContain("# managed by dotfiles");
    expect(content).toContain(`export PATH="${result.paths.binDirectory}:$PATH"`);
  });

  test("preserves an existing ~/.profile's mode instead of forcing 0644", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const profilePath = join(home, ".profile");
    await writeFile(profilePath, "umask 077\n");
    await chmod(profilePath, 0o600);

    await applyProfileFallback(home, result.paths, "/usr/local/bin");

    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(profilePath, "utf8")).toContain(`export PATH="${result.paths.binDirectory}:$PATH"`);
  });

  test("treats the $HOME-relative spelling as already on PATH", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    await writeFile(join(home, ".profile"), 'export PATH="$HOME/.local/bin:$PATH"\n');

    const outcome = await applyProfileFallback(home, result.paths, "/usr/local/bin");

    expect(outcome.method).toBe("profile-existing");
    const profile = await readFile(join(home, ".profile"), "utf8");
    expect(profile).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
  });

  test("does not duplicate the ~/.profile entry on a second run", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-at-all");
    const runner = new FakeRunner();
    // Each attempt now rolls back the just-failed link too (a harmless no-op
    // restore), so a failed `sudo -n ln` is followed by a rollback call.
    runner.results = [
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);
    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).toBe("profile-existing");
    // The login-shell caveat and sudo remedy must survive even when the
    // fallback finds the line already there, not just on the first write.
    expect(outcome.detail).toContain("only takes effect for login shells");
    expect(outcome.detail).toContain(`sudo ln -sf ${result.paths.shortLauncher} ${systemBinDirectory}/shis`);
    const profile = await readFile(join(home, ".profile"), "utf8");
    expect(profile.split(result.paths.binDirectory)).toHaveLength(2);
  });

  test("does not treat an unrelated mention of the bin directory as already on PATH", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-at-all-mention");
    await writeFile(join(home, ".profile"), `# I mention ${result.paths.binDirectory} here but never export it\n`);
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 1, stdout: "", stderr: "" }];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).toBe("profile-appended");
    const profile = await readFile(join(home, ".profile"), "utf8");
    expect(profile).toContain(`export PATH="${result.paths.binDirectory}:$PATH"`);
  });

  test("does not clobber a pre-existing file at the launcher path that shibumi-server did not create", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "usr-local-bin-foreign");
    await mkdir(systemBinDirectory, { recursive: true });
    await writeFile(join(systemBinDirectory, "shis"), "#!/bin/sh\necho not shibumi\n");
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 1, stdout: "", stderr: "" }];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).not.toBe("symlink");
    expect(await readFile(join(systemBinDirectory, "shis"), "utf8")).toBe("#!/bin/sh\necho not shibumi\n");
    // The reason must survive into the fallback detail; silently degrading
    // with no explanation leaves the user guessing why the symlink failed.
    expect(outcome.detail).toContain("symlink skipped:");
    expect(outcome.detail).toContain(`${join(systemBinDirectory, "shis")} already exists and is not a shibumi-server symlink`);
  });

  test.skipIf(process.getuid?.() === 0)(
    "does not clobber a pre-existing foreign binary through the sudo branch either",
    async () => {
      // The foreign-binary guard used to live only in the writable branch:
      // on a root-owned /usr/local/bin with a cached sudo credential, this
      // exact scenario would silently replace someone else's `shis` via
      // `sudo -n ln -sf`. Force the sudo path with a readable-but-not-
      // directly-writable directory so this actually exercises that branch.
      const home = await temporaryHome();
      const { result } = await initialized(home);
      const systemBinRoot = await temporaryHome();
      const systemBinDirectory = join(systemBinRoot, "bin");
      await mkdir(systemBinDirectory, { recursive: true });
      await writeFile(join(systemBinDirectory, "shis"), "#!/bin/sh\necho not shibumi\n");
      await chmod(systemBinDirectory, 0o555);
      const runner = new FakeRunner();

      try {
        const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

        expect(outcome.method).not.toBe("symlink");
        expect(runner.calls).toEqual([]); // refused before ever invoking sudo
        expect(await readFile(join(systemBinDirectory, "shis"), "utf8")).toBe("#!/bin/sh\necho not shibumi\n");
        expect(outcome.detail).toContain("symlink skipped:");
        expect(outcome.detail).toContain(`${join(systemBinDirectory, "shis")} already exists and is not a shibumi-server symlink`);
      } finally {
        await chmod(systemBinDirectory, 0o755);
      }
    },
  );

  test("degrades to the ~/.profile fallback instead of crashing when sudo is not on PATH", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-no-sudo-binary");
    const runner = new RejectingRunner("sudo", new Error('Executable not found in $PATH: "sudo"'));

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).toBe("profile-appended");
    expect(outcome.detail).toContain("symlink skipped:");
    expect(outcome.detail).toContain("sudo");
    const profile = await readFile(join(home, ".profile"), "utf8");
    expect(profile).toContain(`export PATH="${result.paths.binDirectory}:$PATH"`);
  });

  test("degrades instead of crashing when an authorized sudo -v retry rejects", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-no-sudo-binary-2");
    const runner = new RejectingRunner("sudo", new Error('Executable not found in $PATH: "sudo"'));

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory, allowSudoPrompt: true }, runner);

    expect(outcome.method).toBe("profile-appended");
  });

  test.skipIf(process.getuid?.() === 0)(
    "restores the prior working sudo-linked target instead of deleting it when a re-link fails",
    async () => {
      // A failed re-link must never leave the host worse off: if `shis` was
      // already correctly symlinked from an earlier run, a failure linking
      // `shibumi-server` must put the `shis` link back, not just remove it.
      const home = await temporaryHome();
      const { result } = await initialized(home);
      const systemBinRoot = await temporaryHome();
      const systemBinDirectory = join(systemBinRoot, "bin");
      await mkdir(systemBinDirectory, { recursive: true });
      // isManagedLink only recognizes a target inside our own ~/.local/bin as
      // "ours", so the prior link has to point at the real launcher, exactly
      // like a link an earlier successful run would have created.
      const priorTarget = result.paths.shortLauncher;
      await symlink(priorTarget, join(systemBinDirectory, "shis"));
      await chmod(systemBinDirectory, 0o555); // force the sudo path: readable, not directly writable
      const runner = new FakeRunner();
      runner.results = [
        { exitCode: 0, stdout: "", stderr: "" }, // sudo -n ln -sf for shis succeeds, replacing the prior link
        { exitCode: 1, stdout: "", stderr: "restart required" }, // sudo -n ln -sf for shibumi-server fails
        { exitCode: 0, stdout: "", stderr: "" }, // rollback: sudo -n ln -sf restores the prior target for shis
        { exitCode: 0, stdout: "", stderr: "" }, // rollback: sudo -n rm -f cleans up shibumi-server (had no prior target)
      ];

      try {
        const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

        expect(outcome.method).not.toBe("symlink");
        expect(runner.calls).toEqual([
          ["sudo", "-n", "ln", "-sf", result.paths.shortLauncher, join(systemBinDirectory, "shis")],
          ["sudo", "-n", "ln", "-sf", result.paths.launcher, join(systemBinDirectory, "shibumi-server")],
          ["sudo", "-n", "ln", "-sf", priorTarget, join(systemBinDirectory, "shis")],
          ["sudo", "-n", "rm", "-f", join(systemBinDirectory, "shibumi-server")],
        ]);
      } finally {
        await chmod(systemBinDirectory, 0o755);
      }
    },
  );

  test("re-linking a second time safely replaces its own prior symlink", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "usr-local-bin-idempotent");
    await mkdir(systemBinDirectory, { recursive: true });
    const runner = new FakeRunner();

    const first = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);
    const second = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(first.method).toBe("symlink");
    expect(second.method).toBe("symlink");
  });

  test("rolls back the first passwordless-sudo link when the second one fails", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-partial-sudo");
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 0, stdout: "", stderr: "" }, // sudo -n ln for shis succeeds
      { exitCode: 1, stdout: "", stderr: "" }, // sudo -n ln for shibumi-server fails
      { exitCode: 0, stdout: "", stderr: "" }, // rollback: sudo -n rm -f for shis
      { exitCode: 0, stdout: "", stderr: "" }, // rollback: sudo -n rm -f for shibumi-server (never had a prior link either)
    ];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory }, runner);

    expect(outcome.method).not.toBe("symlink");
    expect(runner.calls).toEqual([
      ["sudo", "-n", "ln", "-sf", result.paths.shortLauncher, join(systemBinDirectory, "shis")],
      ["sudo", "-n", "ln", "-sf", result.paths.launcher, join(systemBinDirectory, "shibumi-server")],
      ["sudo", "-n", "rm", "-f", join(systemBinDirectory, "shis")],
      ["sudo", "-n", "rm", "-f", join(systemBinDirectory, "shibumi-server")],
    ]);
  });

  test("skips the ~/.profile fallback entirely when profileFallback is disabled", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-quiet");
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 1, stdout: "", stderr: "" }];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory, profileFallback: false }, runner);

    expect(outcome.method).toBe("skipped");
    expect(await Bun.file(join(home, ".profile")).exists()).toBe(false);
  });

  test("trySymlinkPath never writes to ~/.profile even when the symlink attempt fails", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-detection-only");
    const runner = new FakeRunner();
    runner.results = [{ exitCode: 1, stdout: "", stderr: "" }];

    const outcome = await trySymlinkPath(result.paths, { systemBinDirectory }, runner);

    expect(outcome.symlinked).toBe(false);
    expect(await Bun.file(join(home, ".profile")).exists()).toBe(false);
  });

  test("prompts for sudo authorization only when the caller opts in", async () => {
    const home = await temporaryHome();
    const { result } = await initialized(home);
    const systemBinDirectory = join(await temporaryHome(), "not-writable-at-all-2");
    const runner = new FakeRunner();
    runner.results = [
      { exitCode: 1, stdout: "", stderr: "" }, // passwordless sudo -n for shis fails
      { exitCode: 0, stdout: "", stderr: "" }, // rollback of that just-failed link (harmless no-op)
      { exitCode: 0, stdout: "", stderr: "" }, // sudo -v succeeds (password entered)
      { exitCode: 0, stdout: "", stderr: "" }, // retry: sudo -n ln for shis
      { exitCode: 0, stdout: "", stderr: "" }, // retry: sudo -n ln for shibumi-server
    ];

    const outcome = await ensurePathIntegration(home, result.paths, { systemBinDirectory, allowSudoPrompt: true }, runner);

    expect(outcome.method).toBe("symlink");
    expect(runner.calls[2]).toEqual(["sudo", "-v"]);
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
