import { describe, expect, test } from "bun:test";
import { formatHelp, parseCliArgs } from "../src/cli-args";

describe("CLI arguments", () => {
  test("formats branded help with optional terminal color", () => {
    expect(formatHelp()).toContain("渋み  shis (shibumi-server)");
    expect(formatHelp()).not.toContain("\x1b[");
    expect(formatHelp(true)).toContain("\x1b[38;5;208m渋み");
    expect(formatHelp()).toContain("shis list");
    expect(formatHelp()).toContain("shis remove <domain|app-id>");
  });

  test("parses help, version, and interactive setup", () => {
    expect(parseCliArgs(["--help"])).toEqual({ name: "help" });
    expect(parseCliArgs(["help"])).toEqual({ name: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ name: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ name: "version" });
    expect(parseCliArgs(["version"])).toEqual({ name: "version" });
    expect(parseCliArgs([])).toEqual({ name: "setup" });
    expect(parseCliArgs(["setup"])).toEqual({ name: "setup" });
    expect(parseCliArgs(["update"])).toEqual({ name: "update" });
    expect(parseCliArgs(["list"])).toEqual({ name: "list" });
  });

  test("parses app removal", () => {
    expect(parseCliArgs(["remove", "example.com"])).toEqual({ name: "remove", app: "example.com", yes: false });
    expect(parseCliArgs(["remove", "example-com", "--yes"])).toEqual({ name: "remove", app: "example-com", yes: true });
  });

  test("parses uninstall modes", () => {
    expect(parseCliArgs(["uninstall"])).toEqual({ name: "uninstall", purge: false, yes: false });
    expect(parseCliArgs(["uninstall", "--yes"])).toEqual({ name: "uninstall", purge: false, yes: true });
    expect(parseCliArgs(["uninstall", "--purge"])).toEqual({ name: "uninstall", purge: true, yes: false });
    expect(parseCliArgs(["uninstall", "--purge", "--yes"])).toEqual({ name: "uninstall", purge: true, yes: true });
  });

  test("parses client config, secret handoff, and deployment status", () => {
    expect(parseCliArgs(["client-config", "example-com", "--server-hostname", "server.example.com"])).toEqual({
      name: "client-config",
      appId: "example-com",
      serverHostname: "server.example.com",
    });
    expect(parseCliArgs(["webhook-secret", "example-com"])).toEqual({ name: "webhook-secret", appId: "example-com" });
    expect(parseCliArgs(["caddy-cutover", "example-com"])).toEqual({ name: "caddy-cutover", appId: "example-com" });
    expect(parseCliArgs(["status", "example-com", "--commit", "a".repeat(40), "--json"])).toEqual({
      name: "status",
      appId: "example-com",
      commit: "a".repeat(40),
      json: true,
    });
    expect(parseCliArgs(["history", "example-com", "--json"])).toEqual({
      name: "history", appId: "example-com", json: true,
    });
    expect(parseCliArgs(["rollback", "example-com", "abcdef0", "--yes"])).toEqual({
      name: "rollback", appId: "example-com", commit: "abcdef0", yes: true,
    });
  });

  test("parses check and serve config paths", () => {
    expect(parseCliArgs(["check", "--config", "/tmp/config.json"])).toEqual({
      name: "check",
      config: "/tmp/config.json",
    });
    expect(parseCliArgs(["serve", "--config", "/tmp/config.json"])).toEqual({
      name: "serve",
      config: "/tmp/config.json",
    });
  });

  test("parses explicit app registration and preserves test arguments", () => {
    expect(parseCliArgs([
      "add",
      "example.com",
      "--repository", "github:owner/repo",
      "--checkout", "/srv/apps/example",
      "--port", "9100",
      "--compose-command", "podman-compose",
      "--service", "app",
      "--health-path", "/ready",
      "--",
      "bun", "test", "--timeout", "10000",
    ])).toEqual({
      name: "add",
      domain: "example.com",
      dryRun: false,
      repository: "owner/repo",
      checkout: "/srv/apps/example",
      hostPort: 9100,
      testCommand: ["bun", "test", "--timeout", "10000"],
      ref: undefined,
      composeFile: undefined,
      composeCommand: ["podman-compose"],
      service: "app",
      healthPath: "/ready",
    });
  });

  test("accepts GitHub repository URLs", () => {
    expect(parseCliArgs([
      "add", "example.com",
      "--repository", "https://github.com/owner/repo.git",
      "--checkout", "/srv/apps/example",
      "--port", "9100",
    ])).toMatchObject({ repository: "owner/repo" });
    expect(() => parseCliArgs([
      "add", "example.com",
      "--repository", "https://example.com/owner/repo",
      "--checkout", "/srv/apps/example",
      "--port", "9100",
    ])).toThrow("GitHub");
  });

  test("allows interactive app registration and dry-run previews", () => {
    expect(parseCliArgs(["add", "sub.example.com", "--dry-run"])).toMatchObject({
      name: "add",
      domain: "sub.example.com",
      dryRun: true,
      repository: undefined,
      checkout: undefined,
      hostPort: undefined,
    });
  });

  test("makes app-owned tests optional", () => {
    expect(parseCliArgs([
      "add", "example.com",
      "--repository", "owner/repo",
      "--checkout", "/srv/apps/example",
      "--port", "9100",
    ])).toMatchObject({
      name: "add",
      composeCommand: undefined,
      testCommand: undefined,
    });
  });

  test("rejects missing, duplicate, and unknown values", () => {
    expect(() => parseCliArgs(["setup", "extra"])).toThrow("does not accept");
    expect(() => parseCliArgs(["version", "extra"])).toThrow("does not accept");
    expect(() => parseCliArgs(["init", "extra"])).toThrow("does not accept");
    expect(() => parseCliArgs(["update", "extra"])).toThrow("does not accept");
    expect(() => parseCliArgs(["list", "extra"])).toThrow("does not accept");
    expect(() => parseCliArgs(["remove"])).toThrow("domain or app id");
    expect(() => parseCliArgs(["remove", "example.com", "--purge"])).toThrow("unknown option");
    expect(() => parseCliArgs(["uninstall", "--purge", "--purge"])).toThrow("only be used once");
    expect(() => parseCliArgs(["check"])).toThrow("--config");
    expect(() => parseCliArgs(["client-config"])).toThrow("app id");
    expect(() => parseCliArgs(["status", "example-com", "--json", "--json"])).toThrow("only be used once");
    expect(() => parseCliArgs(["check", "--config", "a", "--config", "b"])).toThrow("only be used once");
    expect(() => parseCliArgs(["add", "example.com", "--dry-run", "--dry-run"])).toThrow("only be used once");
    expect(() => parseCliArgs([
      "add", "example.com",
      "--repository", "owner/repo",
      "--checkout", "/srv/app",
      "--port", "not-a-port",
      "--", "bun", "test",
    ])).toThrow("integer");
    expect(() => parseCliArgs([
      "add", "example.com",
      "--repository", "owner/repo",
      "--checkout", "/srv/app",
      "--port", "9100",
      "--",
    ])).toThrow("test command");
  });
});
