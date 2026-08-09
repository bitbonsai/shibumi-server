export class AppLocks {
  readonly #active = new Set<string>();

  acquire(appId: string): boolean {
    if (this.#active.has(appId)) return false;
    this.#active.add(appId);
    return true;
  }

  release(appId: string): void {
    this.#active.delete(appId);
  }

  has(appId: string): boolean {
    return this.#active.has(appId);
  }
}
