import { describe, expect, test } from "bun:test";
import { isNewerVersion, warnIfUpdateAvailable } from "../src/update";

describe("update checks", () => {
  test("compares stable semantic versions", () => {
    expect(isNewerVersion("0.1.2", "0.1.4")).toBe(true);
    expect(isNewerVersion("0.2.1", "0.1.9")).toBe(false);
    expect(isNewerVersion("0.1.2", "0.1.2")).toBe(false);
    expect(isNewerVersion("invalid", "0.1.4")).toBe(false);
  });

  test("warns with the safe installer command when an update exists", async () => {
    const warnings: string[] = [];
    await warnIfUpdateAvailable(
      "0.1.2",
      async () => Response.json({ version: "0.1.4" }),
      (message) => warnings.push(message),
    );

    expect(warnings).toEqual([
      "Update available: shibumi-server 0.1.2 → 0.1.4\nRun: curl -fsSL https://shibumistack.dev/install/server | bash",
    ]);
  });

  test("stays quiet for current versions and registry failures", async () => {
    const warnings: string[] = [];
    await warnIfUpdateAvailable("0.1.4", async () => Response.json({ version: "0.1.4" }), warnings.push.bind(warnings));
    await warnIfUpdateAvailable("0.1.4", async () => { throw new Error("offline"); }, warnings.push.bind(warnings));
    await warnIfUpdateAvailable("0.1.4", async () => new Response("bad", { status: 503 }), warnings.push.bind(warnings));

    expect(warnings).toEqual([]);
  });
});
