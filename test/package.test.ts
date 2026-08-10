import { expect, test } from "bun:test";
import packageJson from "../package.json";

test("published files use an explicit allowlist", () => {
  expect(packageJson.files).toEqual(expect.arrayContaining(["src", "docs", "examples", "install.sh", "README.md", "LICENSE"]));
  expect(packageJson.files).not.toContain("config.json");
  expect(packageJson.files).not.toContain(".env");
});
