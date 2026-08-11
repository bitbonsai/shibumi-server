import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

function config(overrides: Record<string, unknown> = {}) {
  return {
    listen: { hostname: "127.0.0.1", port: 8787 },
    apps: {
      myapp: {
        repository: "owner/repo",
        ref: "refs/heads/main",
        checkout: "/srv/shibumi/apps/myapp",
        composeFile: "compose.yaml",
        composeProject: "myapp",
        service: "web",
        hostPort: 9100,
        testCommand: ["bun", "test"],
        healthUrl: "http://127.0.0.1:9100/healthz",
        secretEnvironmentVariable: "SHIBUMI_SECRET_MYAPP",
        ...overrides,
      },
    },
  };
}

describe("configuration", () => {
  test("applies safe defaults and allows app-owned tests to be omitted", () => {
    const parsed = parseConfig(config());
    expect(parsed.listen.maxBodyBytes).toBe(1_048_576);
    expect(parsed.apps.myapp.minimumFreeMemoryMb).toBe(2_048);
    expect(parsed.apps.myapp.minimumFreeDiskMb).toBe(4_096);
    expect(parsed.apps.myapp.buildTimeoutMs).toBe(600_000);
    expect(parsed.apps.myapp.healthAttempts).toBe(20);
    expect(parsed.apps.myapp.retainedRollbackImages).toBe(2);
    expect(parseConfig(config({ testCommand: undefined })).apps.myapp.testCommand).toBeUndefined();
    expect(() => parseConfig(config({ testCommand: [] }))).toThrow("non-empty array");
  });

  test("requires loopback listeners and health URLs", () => {
    const publicListener = config();
    publicListener.listen.hostname = "0.0.0.0";
    expect(() => parseConfig(publicListener)).toThrow("loopback");
    expect(() => parseConfig(config({ healthUrl: "https://example.com/healthz" }))).toThrow("loopback HTTP URL");
  });

  test("requires meaningful resource floors and build deadlines", () => {
    expect(() => parseConfig(config({ minimumFreeMemoryMb: 128 }))).toThrow("between 256");
    expect(() => parseConfig(config({ minimumFreeDiskMb: 128 }))).toThrow("between 256");
    expect(() => parseConfig(config({ buildTimeoutMs: 999 }))).toThrow("between 1000");
    expect(() => parseConfig(config({ retainedRollbackImages: 11 }))).toThrow("between 0 and 10");
  });

  test("requires the health URL to use the assigned app port", () => {
    expect(() => parseConfig(config({ healthUrl: "http://127.0.0.1:9200/healthz" }))).toThrow("must use hostPort 9100");
  });

  test("keeps compose files inside the checkout", () => {
    expect(() => parseConfig(config({ composeFile: "../../etc/passwd" }))).toThrow("inside checkout");
  });

  test("rejects unsafe refs and Caddy state", () => {
    expect(() => parseConfig(config({ ref: "refs/heads/../../bad" }))).toThrow("safe refs/heads");
    expect(() => parseConfig(config({ caddyMode: "root" }))).toThrow("preserve or managed");
  });
});
