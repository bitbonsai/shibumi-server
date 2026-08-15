import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeploymentLogStore } from "../src/deployment-log";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("keeps one bounded restricted deployment log per app", async () => {
  const root = await mkdtemp(join(tmpdir(), "shibumi-log-"));
  roots.push(root);
  const store = new DeploymentLogStore(root, 1024);
  await store.start("example-com", "a".repeat(40));
  await store.append("example-com", "build", `\x1b[31m${"x".repeat(2000)}\x1b[0m`);
  const first = await store.read("example-com");
  expect(Buffer.byteLength(first!)).toBeLessThanOrEqual(1024);
  expect(first).not.toContain("\x1b");
  expect((await stat(join(root, "example-com.log"))).mode & 0o777).toBe(0o600);

  await store.start("example-com", "b".repeat(40));
  expect(await store.read("example-com")).toContain(`commit ${"b".repeat(40)}`);
  expect(await store.read("example-com")).not.toContain(`commit ${"a".repeat(40)}`);
});
