import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/deploy";
import { defaultCheckout, findCommand, formatReadySummary, mergeSetupAnswers, nextAvailablePort, registrationOutcome, resolveComposeCommand, setupRequirementIssues } from "../src/setup";

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
      { checkout: "/home/user/shibumi/example-com", hostPort: 9_100 },
      { checkout: undefined, hostPort: undefined, repository: "owner/example" },
    )).toEqual({ checkout: "/home/user/shibumi/example-com", hostPort: 9_100, repository: "owner/example" });
  });

  test("derives a collision-free default checkout from the domain", () => {
    expect(defaultCheckout("www.example.com", "/home/user")).toBe("/home/user/shibumi/www-example-com");
    expect(defaultCheckout("something-some.org", "/home/user")).toBe("/home/user/shibumi/something--some-org");
    expect(defaultCheckout("something.some-org", "/home/user")).toBe("/home/user/shibumi/something-some--org");
  });

  test("guides manual registration while keeping ship setup concise", () => {
    expect(registrationOutcome(false, false)).toBe("Next: https://shibumistack.dev/ship\nRun bun run ship:setup from your local project root.");
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

  test("assigns the first unassigned and locally available port", async () => {
    const checked: number[] = [];
    const available = async (port: number) => {
      checked.push(port);
      return port !== 9_102;
    };
    expect(await nextAvailablePort(new Set([9_100, 9_101]), available)).toBe(9_103);
    expect(checked).toEqual([9_102, 9_103]);
  });
});
