import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeploymentStatusStore } from "../src/status";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("deployment status", () => {
  test("writes restricted status atomically and filters by commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shibumi-status-"));
    roots.push(directory);
    const store = new DeploymentStatusStore(directory);
    const commit = "a".repeat(40);

    await store.write({ appId: "example-com", commit, state: "running", stage: "build", output: "STEP 4/13: RUN bun install" });

    expect(await store.read("example-com", commit)).toMatchObject({ state: "running", stage: "build", output: "STEP 4/13: RUN bun install" });
    expect(await store.read("example-com", "b".repeat(40))).toBeUndefined();
    expect((await stat(join(directory, "example-com.json"))).mode & 0o777).toBe(0o600);
  });

  test("rejects unsafe identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shibumi-status-"));
    roots.push(directory);
    const store = new DeploymentStatusStore(directory);

    await expect(store.read("../secret")).rejects.toThrow("invalid status app id");
    await expect(store.write({ appId: "example-com", commit: "short", state: "failed", stage: "verify" })).rejects.toThrow("invalid status commit");
    await expect(store.write({ appId: "example-com", commit: "a".repeat(40), state: "failed", stage: "verify", message: "secret\nvalue" }))
      .rejects.toThrow("invalid status message");
    await expect(store.write({ appId: "example-com", commit: "a".repeat(40), state: "running", stage: "build", output: "bad\nline" }))
      .rejects.toThrow("invalid status output");
  });
});
