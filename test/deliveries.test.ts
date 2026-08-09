import { describe, expect, test } from "bun:test";
import { DeliveryCache } from "../src/deliveries";

describe("delivery replay cache", () => {
  test("remembers a delivery per app until its TTL expires", () => {
    let now = 1_000;
    const cache = new DeliveryCache(100, 10, () => now);
    cache.remember("first", "delivery");

    expect(cache.seen("first", "delivery")).toBe(true);
    expect(cache.seen("second", "delivery")).toBe(false);
    cache.forget("first", "delivery");
    expect(cache.seen("first", "delivery")).toBe(false);
    cache.remember("first", "delivery");
    now = 1_100;
    expect(cache.seen("first", "delivery")).toBe(false);
  });

  test("evicts the oldest delivery at its hard size bound", () => {
    const cache = new DeliveryCache(1_000, 2, () => 1_000);
    cache.remember("app", "first");
    cache.remember("app", "second");
    cache.remember("app", "third");

    expect(cache.seen("app", "first")).toBe(false);
    expect(cache.seen("app", "second")).toBe(true);
    expect(cache.seen("app", "third")).toBe(true);
  });

  test("requires positive bounded settings", () => {
    expect(() => new DeliveryCache(0, 1)).toThrow("TTL");
    expect(() => new DeliveryCache(1, 0)).toThrow("size");
  });
});
