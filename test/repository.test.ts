import { describe, expect, test } from "bun:test";
import { normalizeGitHubRepository } from "../src/repository";

describe("GitHub repository input", () => {
  test("normalizes shorthand and HTTPS clone URLs", () => {
    expect(normalizeGitHubRepository("github:owner/repo")).toBe("owner/repo");
    expect(normalizeGitHubRepository("owner/repo")).toBe("owner/repo");
    expect(normalizeGitHubRepository("https://github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeGitHubRepository("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(normalizeGitHubRepository("https://github.com/owner/repo/")).toBe("owner/repo");
  });

  test("rejects non-GitHub URLs and extra URL data", () => {
    expect(normalizeGitHubRepository("https://example.com/owner/repo")).toBeUndefined();
    expect(normalizeGitHubRepository("https://github.com/owner/repo/issues")).toBeUndefined();
    expect(normalizeGitHubRepository("https://github.com/owner/repo?tab=readme")).toBeUndefined();
  });
});
