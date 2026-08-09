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
  test("applies safe defaults", () => {
    const parsed = parseConfig(config());
    expect(parsed.listen.maxBodyBytes).toBe(1_048_576);
    expect(parsed.apps.myapp.healthAttempts).toBe(20);
  });

  test("requires loopback listeners and health URLs", () => {
    const publicListener = config();
    publicListener.listen.hostname = "0.0.0.0";
    expect(() => parseConfig(publicListener)).toThrow("loopback");
    expect(() => parseConfig(config({ healthUrl: "https://example.com/healthz" }))).toThrow("loopback HTTP URL");
  });

  test("requires the health URL to use the assigned app port", () => {
    expect(() => parseConfig(config({ healthUrl: "http://127.0.0.1:9200/healthz" }))).toThrow("must use hostPort 9100");
  });

  test("keeps compose files inside the checkout", () => {
    expect(() => parseConfig(config({ composeFile: "../../etc/passwd" }))).toThrow("inside checkout");
  });

  test("rejects unsafe refs", () => {
    expect(() => parseConfig(config({ ref: "refs/heads/../../bad" }))).toThrow("safe refs/heads");
  });
});
