import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/deploy";
import { addApp, initializeInstallation, installationPaths, type CheckoutManager, type ServiceManager } from "../src/install";
import { checkAppHealth, confirmCheckoutReplacement, defaultCheckout, findCommand, formatReadySummary, mergeSetupAnswers, nextAvailablePort, registrationOutcome, resolveComposeCommand, resolvePathIntegration, runSetRepository, setupRequirementIssues, withSpinnerPause, type InteractiveUi } from "../src/setup";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shibumi-setup-"));
  roots.push(root);
  return root;
}

class NoopServices implements ServiceManager {
  restarts = 0;
  async reload(): Promise<void> {}
  async reloadUnits(): Promise<void> {}
  async enableAndRestart(): Promise<void> { this.restarts += 1; }
  async disableAndStop(): Promise<void> {}
}

function fakeUi(overrides: Partial<{ confirmResult: boolean }> = {}): InteractiveUi & {
  calls: { intro: number; outro: string[]; cancel: string[]; confirm: number; logInfo: string[]; spinnerStart: string[]; spinnerStop: string[]; spinnerError: string[] };
} {
  const calls = { intro: 0, outro: [] as string[], cancel: [] as string[], confirm: 0, logInfo: [] as string[], spinnerStart: [] as string[], spinnerStop: [] as string[], spinnerError: [] as string[] };
  return {
    calls,
    intro: () => { calls.intro += 1; },
    outro: (message?: string) => { calls.outro.push(message ?? ""); },
    cancel: (message?: string) => { calls.cancel.push(message ?? ""); },
    confirm: (async () => { calls.confirm += 1; return overrides.confirmResult ?? true; }) as InteractiveUi["confirm"],
    spinner: (() => ({
      start: (msg?: string) => calls.spinnerStart.push(msg ?? ""),
      stop: (msg?: string) => calls.spinnerStop.push(msg ?? ""),
      cancel: () => {},
      error: (msg?: string) => calls.spinnerError.push(msg ?? ""),
      message: () => {},
      clear: () => {},
      isCancelled: false,
    })) as InteractiveUi["spinner"],
    log: {
      message: () => {},
      info: (msg: string) => { calls.logInfo.push(msg); },
      success: () => {},
      step: () => {},
      warn: () => {},
      warning: () => {},
      error: () => {},
    },
  };
}

class RequirementRunner implements CommandRunner {
  constructor(
    private readonly rootless = true,
    private readonly userSystemd = true,
    private readonly podmanCompose = true,
    private readonly standaloneCompose = false,
  ) {}

  async run(command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    if (command === "podman" && args[0] === "info") {
      return { exitCode: this.rootless ? 0 : 1, stdout: this.rootless ? "true\n" : "false\n", stderr: "" };
    }
    if (command === "podman" && args[0] === "compose") {
      return { exitCode: this.podmanCompose ? 0 : 125, stdout: "", stderr: this.podmanCompose ? "" : "unrecognized command" };
    }
    if (command.endsWith("/podman-compose") || command === "podman-compose") {
      return { exitCode: this.standaloneCompose ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command === "systemctl") {
      return { exitCode: this.userSystemd ? 0 : 1, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  }
}

describe("interactive setup", () => {
  test("reports missing server requirements before setup", async () => {
    expect(await setupRequirementIssues(() => null, new RequirementRunner())).toEqual([
      "Git is not installed",
      "Podman is not installed",
      "Caddy is not installed",
      "systemd is not installed",
    ]);
  });

  test("reports configured app health for list status", async () => {
    expect(await checkAppHealth("http://127.0.0.1:9100/healthz", 1_000, async () => new Response(null, { status: 204 })))
      .toEqual({ healthy: true, detail: "healthy (HTTP 204)" });
    expect(await checkAppHealth("http://127.0.0.1:9100/healthz", 1_000, async () => new Response(null, { status: 503 })))
      .toEqual({ healthy: false, detail: "unhealthy (HTTP 503)" });
    expect(await checkAppHealth("http://127.0.0.1:9100/healthz", 1_000, async () => { throw new Error("refused"); }))
      .toEqual({ healthy: false, detail: "unreachable" });
  });

  test("checks rootless Podman and the systemd user session", async () => {
    const available = (command: string) => `/usr/bin/${command}`;
    expect(await setupRequirementIssues(available, new RequirementRunner())).toEqual([]);
    expect(await setupRequirementIssues(available, new RequirementRunner(false, false))).toEqual([
      "Podman is not configured for the current user (rootless mode)",
      "a systemd user session is not available",
    ]);
    expect(await setupRequirementIssues(available, new RequirementRunner(true, true, false, false))).toContain(
      "Podman Compose is not installed or usable (install podman-compose, then run podman-compose version)",
    );
  });

  test("finds user-local commands outside the process PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "shibumi-commands-"));
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "podman-compose"), "#!/bin/sh\n");
    expect(findCommand("podman-compose", home, () => null)).toBe(join(bin, "podman-compose"));
  });

  test("selects an available Podman Compose frontend", async () => {
    expect(await resolveComposeCommand(undefined, () => null, new RequirementRunner())).toEqual(["podman", "compose"]);
    expect(await resolveComposeCommand(
      undefined,
      (command) => command === "podman-compose" ? "/usr/bin/podman-compose" : null,
      new RequirementRunner(true, true, false, true),
    )).toEqual(["/usr/bin/podman-compose"]);
    await expect(resolveComposeCommand(undefined, () => null, new RequirementRunner(true, true, false, false)))
      .rejects.toThrow("install podman-compose");
  });

  test("keeps registered values when CLI options are undefined", () => {
    expect(mergeSetupAnswers(
      { checkout: "/home/user/shibumi/example-com", hostPort: 9_001 },
      { checkout: undefined, hostPort: undefined, repository: "owner/example" },
    )).toEqual({ checkout: "/home/user/shibumi/example-com", hostPort: 9_001, repository: "owner/example" });
  });

  test("derives a collision-free default checkout from the domain", () => {
    expect(defaultCheckout("www.example.com", "/home/user")).toBe("/home/user/shibumi/www-example-com");
    expect(defaultCheckout("something-some.org", "/home/user")).toBe("/home/user/shibumi/something--some-org");
    expect(defaultCheckout("something.some-org", "/home/user")).toBe("/home/user/shibumi/something-some--org");
  });

  test("guides manual registration while keeping ship setup concise", () => {
    expect(registrationOutcome(false, false)).toBe("Next: from your local project root, run:\n   curl -fsSL https://shibumistack.dev/install/ship.sh | sh");
    expect(registrationOutcome(true, false)).toBe("Registration is current.");
  });

  test("formats a concise ready summary without client placeholders or secret paths", () => {
    const summary = formatReadySummary({
      domain: "vibetoolbox.dev",
      appId: "vibetoolbox-dev",
      hostPort: 9_100,
      caddy: "configured and reloaded",
    });

    expect(summary).toBe([
      "Domain    vibetoolbox.dev",
      "Webhook   https://vibetoolbox.dev/hooks/github/vibetoolbox-dev",
      "Upstream  127.0.0.1:9100",
      "Caddy     configured and reloaded",
      "Secret    stored on server",
    ].join("\n"));
    expect(summary).not.toContain("<ssh-host>");
    expect(summary).not.toContain("secrets.env");
  });

  test("skips the checkout-replacement prompt with --yes", async () => {
    expect(await confirmCheckoutReplacement({
      checkout: "/home/user/shibumi/example-com",
      backup: "/home/user/shibumi/example-com.bak",
      repository: "owner/repo",
    }, true)).toBe(true);
  });

  test("asks for confirmation without --yes, and honors the answer", async () => {
    const mismatch = { checkout: "/home/user/shibumi/example-com", backup: "/home/user/shibumi/example-com.bak", repository: "owner/repo" };
    const warnings: string[] = [];
    const logUi = { warn: (message: string) => { warnings.push(message); } };
    let promptedWith: unknown;

    const accepted = await confirmCheckoutReplacement(mismatch, false, {
      log: logUi,
      confirm: async (opts) => { promptedWith = opts; return true; },
    });
    expect(accepted).toBe(true);

    const declined = await confirmCheckoutReplacement(mismatch, false, {
      log: logUi,
      confirm: async () => false,
    });
    expect(declined).toBe(false);

    expect(warnings).toHaveLength(2);
    expect((promptedWith as { message: string }).message).toBe("Move it to example-com.bak and clone owner/repo?");
  });

  test("withSpinnerPause pauses for the confirm and resumes only when accepted", async () => {
    const events: string[] = [];
    const progress = {
      start: (msg?: string) => events.push(`start:${msg}`),
      stop: (msg?: string) => events.push(`stop:${msg}`),
      error: (msg?: string) => events.push(`error:${msg}`),
    };
    const mismatch = { checkout: "/srv/shibumi/example-com", backup: "/srv/shibumi/example-com.bak", repository: "owner/repo" };

    const pause = withSpinnerPause(progress, () => "Adding example.com", async () => true);
    pause.start();
    expect(pause.active()).toBe(true);
    expect(await pause.confirm(mismatch)).toBe(true);
    expect(pause.active()).toBe(true);
    expect(events).toEqual(["start:Adding example.com", "stop:Checkout example-com needs attention", "start:Adding example.com"]);
  });

  test("withSpinnerPause leaves the spinner stopped when the replacement is declined", async () => {
    const events: string[] = [];
    const progress = {
      start: (msg?: string) => events.push(`start:${msg}`),
      stop: (msg?: string) => events.push(`stop:${msg}`),
      error: (msg?: string) => events.push(`error:${msg}`),
    };
    const mismatch = { checkout: "/srv/shibumi/example-com", backup: "/srv/shibumi/example-com.bak", repository: "owner/repo" };

    const pause = withSpinnerPause(progress, () => "Adding example.com", async () => false);
    pause.start();
    expect(await pause.confirm(mismatch)).toBe(false);
    expect(pause.active()).toBe(false);
    expect(events).toEqual(["start:Adding example.com", "stop:Checkout example-com needs attention"]);
  });

  test("assigns the first unassigned and locally available port", async () => {
    const checked: number[] = [];
    const available = async (port: number) => {
      checked.push(port);
      return port !== 9_003;
    };
    expect(await nextAvailablePort(new Set([9_001, 9_002]), available)).toBe(9_004);
    expect(checked).toEqual([9_003, 9_004]);
  });
});

describe("runSetRepository", () => {
  const noopCheckouts: CheckoutManager = { async prepare() { return "compose.yaml"; } };

  test("throws for an unknown app before ever prompting", async () => {
    const home = await temporaryHome();
    await initializeInstallation({ home, packageRoot: resolve(import.meta.dir, ".."), bunExecutable: process.execPath }, new NoopServices());
    const ui = fakeUi();

    await expect(runSetRepository(home, "missing", "owner/new-repo", undefined, false, new NoopServices(), noopCheckouts, ui))
      .rejects.toThrow("unknown app");
    expect(ui.calls.confirm).toBe(0);
    expect(ui.calls.logInfo).toHaveLength(0);
  });

  test("refuses when .bak already exists, without printing the plan or prompting first", async () => {
    const home = await temporaryHome();
    await initializeInstallation({ home, packageRoot: resolve(import.meta.dir, ".."), bunExecutable: process.execPath }, new NoopServices());
    const checkoutRoot = await temporaryHome();
    const checkout = join(checkoutRoot, "example-com");
    await mkdir(checkout, { recursive: true });
    await mkdir(`${checkout}.bak`, { recursive: true });
    await addApp({ home, domain: "example.com", repository: "owner/repository", checkout, hostPort: 9_100 }, new NoopServices(), noopCheckouts);
    const ui = fakeUi();

    await expect(runSetRepository(home, "example-com", "owner/new-repo", undefined, false, new NoopServices(), noopCheckouts, ui))
      .rejects.toThrow("already exists");
    expect(ui.calls.confirm).toBe(0);
    expect(ui.calls.logInfo).toHaveLength(0);
  });

  test("cancels without repointing when the prompt is declined", async () => {
    const home = await temporaryHome();
    await initializeInstallation({ home, packageRoot: resolve(import.meta.dir, ".."), bunExecutable: process.execPath }, new NoopServices());
    const checkoutRoot = await temporaryHome();
    const checkout = join(checkoutRoot, "example-com");
    await mkdir(checkout, { recursive: true });
    await addApp({ home, domain: "example.com", repository: "owner/repository", checkout, hostPort: 9_100 }, new NoopServices(), noopCheckouts);
    const services = new NoopServices();
    const ui = fakeUi({ confirmResult: false });

    await runSetRepository(home, "example-com", "owner/new-repo", undefined, false, services, noopCheckouts, ui);

    expect(ui.calls.cancel).toEqual(["set-repository cancelled."]);
    expect(ui.calls.outro).toHaveLength(0);
    expect(services.restarts).toBe(0);
    const config = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/repository");
  });

  test("repoints the app and reports success once the prompt is accepted", async () => {
    const home = await temporaryHome();
    await initializeInstallation({ home, packageRoot: resolve(import.meta.dir, ".."), bunExecutable: process.execPath }, new NoopServices());
    const checkoutRoot = await temporaryHome();
    const checkout = join(checkoutRoot, "example-com");
    await mkdir(checkout, { recursive: true });
    await addApp({ home, domain: "example.com", repository: "owner/repository", checkout, hostPort: 9_100 }, new NoopServices(), noopCheckouts);
    const services = new NoopServices();
    const ui = fakeUi({ confirmResult: true });

    await runSetRepository(home, "example-com", "owner/new-repo", undefined, false, services, noopCheckouts, ui);

    expect(ui.calls.outro).toEqual(["Repository updated. Next deploy ships from github:owner/new-repo."]);
    expect(ui.calls.spinnerStart).toEqual(["Cloning github:owner/new-repo"]);
    expect(ui.calls.spinnerStop).toEqual(["Repository updated for example.com"]);
    expect(services.restarts).toBe(1);
    const config = JSON.parse(await readFile(installationPaths(home).config, "utf8"));
    expect(config.apps["example-com"].repository).toBe("owner/new-repo");
  });

  test("preserves private environment files in the fresh checkout", async () => {
    const home = await temporaryHome();
    await initializeInstallation({ home, packageRoot: resolve(import.meta.dir, ".."), bunExecutable: process.execPath }, new NoopServices());
    const checkoutRoot = await temporaryHome();
    const checkout = join(checkoutRoot, "example-com");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, ".env"), "PUBLIC_URL=https://example.com\n", { mode: 0o600 });
    await writeFile(join(checkout, ".env.production"), "EMAIL_PROVIDER=discard\n", { mode: 0o600 });
    await addApp({ home, domain: "example.com", repository: "owner/repository", checkout, hostPort: 9_100 }, new NoopServices(), noopCheckouts);
    const clonedCheckout: CheckoutManager = {
      async prepare(options) {
        await mkdir(options.checkout, { recursive: true });
        return "compose.yaml";
      },
    };

    await runSetRepository(home, "example-com", "owner/new-repo", undefined, true, new NoopServices(), clonedCheckout, fakeUi());

    expect(await readFile(join(checkout, ".env"), "utf8")).toBe("PUBLIC_URL=https://example.com\n");
    expect(await readFile(join(checkout, ".env.production"), "utf8")).toBe("EMAIL_PROVIDER=discard\n");
    expect((await stat(join(checkout, ".env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(checkout, ".env.production"))).mode & 0o777).toBe(0o600);
    expect(await readFile(`${checkout}.bak/.env`, "utf8")).toBe("PUBLIC_URL=https://example.com\n");
  });

  test("skips the prompt with --yes", async () => {
    const home = await temporaryHome();
    await initializeInstallation({ home, packageRoot: resolve(import.meta.dir, ".."), bunExecutable: process.execPath }, new NoopServices());
    const checkoutRoot = await temporaryHome();
    const checkout = join(checkoutRoot, "example-com");
    await mkdir(checkout, { recursive: true });
    await addApp({ home, domain: "example.com", repository: "owner/repository", checkout, hostPort: 9_100 }, new NoopServices(), noopCheckouts);
    const ui = fakeUi();

    await runSetRepository(home, "example-com", "owner/new-repo", undefined, true, new NoopServices(), noopCheckouts, ui);

    expect(ui.calls.confirm).toBe(0);
    expect(ui.calls.outro).toEqual(["Repository updated. Next deploy ships from github:owner/new-repo."]);
  });

  test("reports spinner failure and rethrows when the underlying repoint fails", async () => {
    const home = await temporaryHome();
    await initializeInstallation({ home, packageRoot: resolve(import.meta.dir, ".."), bunExecutable: process.execPath }, new NoopServices());
    const checkoutRoot = await temporaryHome();
    const checkout = join(checkoutRoot, "example-com");
    await mkdir(checkout, { recursive: true });
    await addApp({ home, domain: "example.com", repository: "owner/repository", checkout, hostPort: 9_100 }, new NoopServices(), noopCheckouts);
    const failingCheckouts: CheckoutManager = { async prepare() { throw new Error("cannot clone owner/new-repo"); } };
    const ui = fakeUi({ confirmResult: true });

    await expect(runSetRepository(home, "example-com", "owner/new-repo", undefined, false, new NoopServices(), failingCheckouts, ui))
      .rejects.toThrow("cannot clone");
    expect(ui.calls.spinnerError).toEqual(["Could not repoint example.com"]);
    expect(ui.calls.outro).toHaveLength(0);
  });
});

describe("resolvePathIntegration", () => {
  const paths = installationPaths("/home/deploy");

  test("skips the sudo question entirely when the initial passwordless attempt already succeeds", async () => {
    let confirmCalled = false;
    const trySymlink = async () => ({ symlinked: true, systemBinDirectory: "/usr/local/bin" });
    const profileFallback = async (): Promise<never> => { throw new Error("must not be called"); };

    const result = await resolvePathIntegration("/home/deploy", paths, async () => {
      confirmCalled = true;
      return true;
    }, trySymlink, profileFallback);

    expect(confirmCalled).toBe(false);
    expect(result).toEqual({ method: "symlink", detail: `/usr/local/bin/shis -> ${paths.shortLauncher}` });
  });

  test("does not retry the sudo symlink after the user declines, even once", async () => {
    // A cached sudo credential could make `sudo -n` succeed on a second try
    // despite the decline; the fix is to never attempt it again, not to hope
    // it fails.
    const trySymlinkCalls: Array<{ allowSudoPrompt?: boolean } | undefined> = [];
    const trySymlink = async (_paths: typeof paths, options?: { allowSudoPrompt?: boolean }) => {
      trySymlinkCalls.push(options);
      return { symlinked: false, systemBinDirectory: "/usr/local/bin", reason: "not writable" };
    };
    const profileFallbackCalls: Array<[string | undefined, string | undefined]> = [];
    const profileFallback = async (_home: string, _paths: typeof paths, systemBinDirectory?: string, reason?: string) => {
      profileFallbackCalls.push([systemBinDirectory, reason]);
      return { method: "profile-appended" as const, detail: "fallback detail" };
    };

    const result = await resolvePathIntegration("/home/deploy", paths, async () => false, trySymlink, profileFallback);

    expect(trySymlinkCalls).toEqual([undefined]);
    expect(profileFallbackCalls).toEqual([["/usr/local/bin", "not writable"]]);
    expect(result).toEqual({ method: "profile-appended", detail: "fallback detail" });
  });

  test("retries with allowSudoPrompt only when the user accepts", async () => {
    const trySymlinkCalls: Array<{ allowSudoPrompt?: boolean } | undefined> = [];
    const trySymlink = async (_paths: typeof paths, options?: { allowSudoPrompt?: boolean }) => {
      trySymlinkCalls.push(options);
      return options?.allowSudoPrompt
        ? { symlinked: true, systemBinDirectory: "/usr/local/bin" }
        : { symlinked: false, systemBinDirectory: "/usr/local/bin", reason: "not writable" };
    };
    const profileFallback = async (): Promise<never> => { throw new Error("must not be called"); };

    const result = await resolvePathIntegration("/home/deploy", paths, async () => true, trySymlink, profileFallback);

    expect(trySymlinkCalls).toEqual([undefined, { allowSudoPrompt: true }]);
    expect(result).toEqual({ method: "symlink", detail: `/usr/local/bin/shis -> ${paths.shortLauncher}` });
  });
});
