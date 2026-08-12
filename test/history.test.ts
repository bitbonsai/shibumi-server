import { expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentHistoryStore } from "../src/history";

const appId = "example-com";
const commit = "a".repeat(40);

test("deployment history stays bounded and preserves safe metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shibumi-history-"));
  const history = new DeploymentHistoryStore(directory, 2);
  await history.append({ appId, commit, kind: "webhook", state: "accepted", delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958" });
  await history.append({ appId, commit, kind: "webhook", state: "succeeded", durationMs: 12 });
  await history.append({ appId, commit: "b".repeat(40), kind: "rollback", state: "failed", stage: "health", durationMs: 24 });

  const entries = await history.read(appId);
  expect(entries).toHaveLength(2);
  expect(entries.map(({ kind, state }) => [kind, state])).toEqual([["webhook", "succeeded"], ["rollback", "failed"]]);
  expect(entries[0].version).toBe(1);
  expect(entries[0].at).toBeString();
  expect((await stat(join(directory, `${appId}.jsonl`))).mode & 0o777).toBe(0o600);
});

test("deployment history rejects unsafe records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shibumi-history-"));
  const history = new DeploymentHistoryStore(directory);
  await expect(history.append({ appId: "../bad", commit, kind: "webhook", state: "accepted" })).rejects.toThrow("invalid history app id");
});
