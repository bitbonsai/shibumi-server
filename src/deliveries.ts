export type DeliveryClock = () => number;

export class DeliveryCache {
  readonly #entries = new Map<string, number>();

  constructor(
    readonly ttlMs = 24 * 60 * 60 * 1_000,
    readonly maximumEntries = 10_000,
    readonly clock: DeliveryClock = Date.now,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("delivery cache TTL must be positive");
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) throw new Error("delivery cache size must be positive");
  }

  seen(appId: string, deliveryId: string): boolean {
    const now = this.clock();
    this.prune(now);
    const key = `${appId}:${deliveryId}`;
    const expiresAt = this.#entries.get(key);
    return expiresAt !== undefined && expiresAt > now;
  }

  forget(appId: string, deliveryId: string): void {
    this.#entries.delete(`${appId}:${deliveryId}`);
  }

  remember(appId: string, deliveryId: string): void {
    const now = this.clock();
    this.prune(now);
    const key = `${appId}:${deliveryId}`;
    this.#entries.delete(key);
    while (this.#entries.size >= this.maximumEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, now + this.ttlMs);
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt > now) continue;
      this.#entries.delete(key);
    }
  }
}
