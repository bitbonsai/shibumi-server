import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { parseGitHubPush, verifyGitHubSignature } from "../src/github";

const secret = "a".repeat(32);
const body = new TextEncoder().encode('{"ok":true}');

describe("GitHub webhook verification", () => {
  test("accepts a valid sha256 signature", () => {
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGitHubSignature(secret, body, signature)).toBe(true);
  });

  test("rejects missing, malformed, and mismatched signatures", () => {
    expect(verifyGitHubSignature(secret, body, null)).toBe(false);
    expect(verifyGitHubSignature(secret, body, "sha1=abc")).toBe(false);
    expect(verifyGitHubSignature(secret, body, `sha256=${"0".repeat(64)}`)).toBe(false);
  });
});

describe("GitHub push parsing", () => {
  test("extracts a valid push", () => {
    expect(parseGitHubPush({
      ref: "refs/heads/main",
      after: "a".repeat(40),
      repository: { full_name: "owner/repo" },
    })).toEqual({ repository: "owner/repo", ref: "refs/heads/main", commit: "a".repeat(40) });
  });

  test("rejects deleted branches and abbreviated SHAs", () => {
    expect(() => parseGitHubPush({
      ref: "refs/heads/main",
      after: "a".repeat(40),
      deleted: true,
      repository: { full_name: "owner/repo" },
    })).toThrow("deleted branches");
    expect(() => parseGitHubPush({
      ref: "refs/heads/main",
      after: "abc1234",
      repository: { full_name: "owner/repo" },
    })).toThrow("full lowercase commit SHA");
  });
});
