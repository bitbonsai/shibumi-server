import { describe, expect, test } from "bun:test";
import { defaultCheckout, parseCommandLine } from "../src/setup";

describe("interactive setup", () => {
  test("derives a stable default checkout from the domain", () => {
    expect(defaultCheckout("www.example.com")).toBe("/srv/shibumi/apps/www-example-com");
  });

  test("stores test commands as argument arrays without invoking a shell", () => {
    expect(parseCommandLine("bun test --timeout 10000")).toEqual([
      "bun",
      "test",
      "--timeout",
      "10000",
    ]);
    expect(parseCommandLine("bun test --filter 'deploy pipeline'")).toEqual([
      "bun",
      "test",
      "--filter",
      "deploy pipeline",
    ]);
    expect(parseCommandLine('printf "hello world"')).toEqual(["printf", "hello world"]);
  });

  test("rejects empty, multiline, and malformed commands", () => {
    expect(() => parseCommandLine("   ")).toThrow("at least one");
    expect(() => parseCommandLine("bun test\nrm -rf /")).toThrow("one line");
    expect(() => parseCommandLine("bun 'test")).toThrow("unterminated quote");
    expect(() => parseCommandLine("bun test\\")).toThrow("escape");
  });
});
