import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeploymentQueueStore } from "../src/queue";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const firstDelivery = "72d3162e-cc78-41e3-81ab-4c9367dc0958";
const secondDelivery = "82d3162e-cc78-41e3-81ab-4c9367dc0958";

test("queue atomically keeps only latest deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shibumi-queue-"));
  roots.push(directory);
  const store = new DeploymentQueueStore(directory);

  expect(await store.replace("example-com", "a".repeat(40), firstDelivery)).toBeUndefined();
  expect(await store.replace("example-com", "b".repeat(40), secondDelivery)).toMatchObject({ commit: "a".repeat(40) });
  expect(await store.read("example-com")).toMatchObject({ commit: "b".repeat(40), delivery: secondDelivery });
  expect((await stat(join(directory, "example-com.json"))).mode & 0o777).toBe(0o600);
  expect(await store.list()).toHaveLength(1);
  await store.remove("example-com");
  expect(await store.read("example-com")).toBeUndefined();
});
