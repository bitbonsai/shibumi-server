import { expect, test } from "bun:test";
import { caddyHelperNeedsInstall } from "../src/caddy-sudo";

test("Caddy helper upgrade reinstalls stale root-owned versions", () => {
  expect(caddyHelperNeedsInstall(0, "5:20000\n")).toBe(false);
  expect(caddyHelperNeedsInstall(0, "4:20000\n")).toBe(true);
  expect(caddyHelperNeedsInstall(0, "3\n")).toBe(true);
  expect(caddyHelperNeedsInstall(1, "5:20000\n")).toBe(true);
});
