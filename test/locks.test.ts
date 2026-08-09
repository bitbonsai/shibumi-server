import { expect, test } from "bun:test";
import { AppLocks } from "../src/locks";

test("locks deployments per app", () => {
  const locks = new AppLocks();
  expect(locks.acquire("one")).toBe(true);
  expect(locks.acquire("one")).toBe(false);
  expect(locks.acquire("two")).toBe(true);
  locks.release("one");
  expect(locks.acquire("one")).toBe(true);
});
