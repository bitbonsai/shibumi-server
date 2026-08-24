import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appEnvPath, mergeAppEnv, parseEnv, readAppEnv, serializeEnv, writeAppEnv } from "../src/app-env";

describe("parseEnv", () => {
  test("parses KEY=VALUE, ignores comments/blanks, strips quotes", () => {
    const env = parseEnv(`# comment\n\nAPP_ORIGIN=https://app.example.com\nQUOTED="a b"\nSINGLE='x'\nbad-key=nope\nNOEQ\n`);
    expect(env).toEqual({ APP_ORIGIN: "https://app.example.com", QUOTED: "a b", SINGLE: "x" });
  });
});

describe("serializeEnv", () => {
  test("sorts keys and round-trips", () => {
    const env = { B: "2", A: "1" };
    expect(serializeEnv(env)).toBe("A=1\nB=2\n");
    expect(parseEnv(serializeEnv(env))).toEqual(env);
  });
  test("empty is empty string", () => {
    expect(serializeEnv({})).toBe("");
  });
});

describe("mergeAppEnv", () => {
  test("merges and overrides, rejects bad keys and newline values", () => {
    expect(mergeAppEnv({ A: "1" }, { B: "2", A: "9" })).toEqual({ A: "9", B: "2" });
    expect(() => mergeAppEnv({}, { "bad-key": "x" })).toThrow("invalid environment variable name");
    expect(() => mergeAppEnv({}, { A: "line1\nline2" })).toThrow("newline");
  });

  test("rejects reserved SHIBUMI_ deploy keys", () => {
    expect(() => mergeAppEnv({}, { SHIBUMI_COMMIT: "spoof" })).toThrow("reserved");
    expect(() => mergeAppEnv({}, { SHIBUMI_DEPLOYED_AT: "t" })).toThrow("reserved");
  });
});

describe("read/write", () => {
  test("writes 0600, reads back, and removes the file when empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "appenv-"));
    const path = appEnvPath(dir, "my-app");
    expect(path.endsWith(join("env", "my-app.env"))).toBe(true);
    writeAppEnv(path, { RESEND_API_KEY: "re_x", APP_ORIGIN: "https://a.example" });
    expect(readAppEnv(path)).toEqual({ RESEND_API_KEY: "re_x", APP_ORIGIN: "https://a.example" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("APP_ORIGIN=https://a.example\nRESEND_API_KEY=re_x\n");
    writeAppEnv(path, {});
    expect(readAppEnv(path)).toEqual({});
  });

  test("env directory is created 0700 and leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "appenv-"));
    const path = appEnvPath(dir, "my-app");
    writeAppEnv(path, { A: "1" });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("rewrite of a file with loosened permissions ends up 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "appenv-"));
    const path = appEnvPath(dir, "my-app");
    writeAppEnv(path, { A: "1" });
    chmodSync(path, 0o644);
    writeAppEnv(path, { A: "2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readAppEnv(path)).toEqual({ A: "2" });
  });

  test("missing file reads as empty", () => {
    expect(readAppEnv(join(tmpdir(), "does-not-exist-shibumi.env"))).toEqual({});
  });
});
