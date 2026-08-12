import { describe, expect, test } from "bun:test";
import { normalizeGitHubRepository, parseGitHubRepositoryTarget } from "../src/repository";

describe("GitHub repository input", () => {
  test("normalizes shorthand and HTTPS clone URLs", () => {
    expect(normalizeGitHubRepository("github:owner/repo")).toBe("owner/repo");
    expect(normalizeGitHubRepository("owner/repo")).toBe("owner/repo");
    expect(normalizeGitHubRepository("https://github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeGitHubRepository("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(normalizeGitHubRepository("https://github.com/owner/repo/")).toBe("owner/repo");
  });

  test("extracts branches from GitHub tree URLs", () => {
    expect(parseGitHubRepositoryTarget("https://github.com/bitbonsai/mcpvault/tree/shibumi")).toEqual({
      repository: "bitbonsai/mcpvault",
      ref: "refs/heads/shibumi",
    });
  });

  test("rejects non-GitHub URLs and extra URL data", () => {
    expect(normalizeGitHubRepository("https://example.com/owner/repo")).toBeUndefined();
    expect(normalizeGitHubRepository("https://github.com/owner/repo/issues")).toBeUndefined();
    expect(normalizeGitHubRepository("https://github.com/owner/repo?tab=readme")).toBeUndefined();
  });
});
