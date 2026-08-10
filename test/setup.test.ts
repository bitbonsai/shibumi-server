import { describe, expect, test } from "bun:test";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/deploy";
import { defaultCheckout, nextAvailablePort, setupRequirementIssues } from "../src/setup";

class RequirementRunner implements CommandRunner {
  constructor(
    private readonly rootless = true,
    private readonly userSystemd = true,
  ) {}

  async run(command: string, _args: string[], _options?: CommandOptions): Promise<CommandResult> {
    if (command === "podman") {
      return { exitCode: this.rootless ? 0 : 1, stdout: this.rootless ? "true\n" : "false\n", stderr: "" };
    }
    if (command === "systemctl") {
      return { exitCode: this.userSystemd ? 0 : 1, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${command}`);
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
  });

  test("derives a collision-free default checkout from the domain", () => {
    expect(defaultCheckout("www.example.com")).toBe("/srv/shibumi/apps/www-example-com");
    expect(defaultCheckout("something-some.org")).toBe("/srv/shibumi/apps/something--some-org");
    expect(defaultCheckout("something.some-org")).toBe("/srv/shibumi/apps/something-some--org");
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
