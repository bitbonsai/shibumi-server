import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import packageJson from "../package.json";

test("release version uses a preferred digit sum", () => {
  const sum = (packageJson.version.match(/\d/g) ?? []).reduce((total, digit) => total + Number(digit), 0);
  expect([1, 2, 3, 5, 7, 9]).toContain(sum);
});

test("published files use an explicit allowlist", () => {
  expect(packageJson.files).toEqual(expect.arrayContaining(["src", "docs", "examples", "install.sh", "README.md", "LICENSE", "runtime-lock.json"]));
  expect(packageJson.files).not.toContain("config.json");
  expect(packageJson.files).not.toContain(".env");
});

test("published runtime lock matches Bun lock", async () => {
  const root = resolve(import.meta.dir, "..");
  expect(await readFile(resolve(root, "runtime-lock.json"), "utf8"))
    .toBe(await readFile(resolve(root, "bun.lock"), "utf8"));
});
