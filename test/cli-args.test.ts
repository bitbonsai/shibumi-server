import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli-args";

describe("CLI arguments", () => {
  test("parses help and interactive setup", () => {
    expect(parseCliArgs(["--help"])).toEqual({ name: "help" });
    expect(parseCliArgs(["help"])).toEqual({ name: "help" });
    expect(parseCliArgs([])).toEqual({ name: "setup" });
    expect(parseCliArgs(["setup"])).toEqual({ name: "setup" });
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
      "--repository", "owner/repo",
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

  test("allows interactive app registration with only a domain", () => {
    expect(parseCliArgs(["add", "sub.example.com"])).toMatchObject({
      name: "add",
      domain: "sub.example.com",
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
    expect(() => parseCliArgs(["init", "extra"])).toThrow("does not accept");
    expect(() => parseCliArgs(["check"])).toThrow("--config");
    expect(() => parseCliArgs(["check", "--config", "a", "--config", "b"])).toThrow("only be used once");
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
