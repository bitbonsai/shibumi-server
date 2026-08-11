import { describe, expect, test } from "bun:test";
import { isNewerVersion, updateToLatest, warnIfUpdateAvailable } from "../src/update";

describe("update checks", () => {
  test("compares stable semantic versions", () => {
    expect(isNewerVersion("0.1.2", "0.1.4")).toBe(true);
    expect(isNewerVersion("0.2.1", "0.1.9")).toBe(false);
    expect(isNewerVersion("0.1.2", "0.1.2")).toBe(false);
    expect(isNewerVersion("invalid", "0.1.4")).toBe(false);
  });

  test("installs the exact latest stable release", async () => {
    const installed: string[] = [];
    expect(await updateToLatest(
      "0.1.2",
      async (version) => { installed.push(version); return 0; },
      async () => Response.json({ version: "0.1.4" }),
    )).toEqual({ updated: true, version: "0.1.4" });
    expect(installed).toEqual(["0.1.4"]);

    expect(await updateToLatest("0.1.4", async () => 0, async () => Response.json({ version: "0.1.4" })))
      .toEqual({ updated: false, version: "0.1.4" });
  });

  test("rejects registry and installation failures", async () => {
    await expect(updateToLatest("0.1.2", async () => 1, async () => Response.json({ version: "0.1.4" })))
      .rejects.toThrow("installation failed");
    await expect(updateToLatest("0.1.2", async () => 0, async () => Response.json({ version: "latest" })))
      .rejects.toThrow("invalid release version");
  });

  test("warns with the update command when an update exists", async () => {
    const warnings: string[] = [];
    await warnIfUpdateAvailable(
      "0.1.2",
      async () => Response.json({ version: "0.1.4" }),
      (message) => warnings.push(message),
    );

    expect(warnings).toEqual([
      "Update available: shibumi-server 0.1.2 → 0.1.4\nRun: shibumi-server update",
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
