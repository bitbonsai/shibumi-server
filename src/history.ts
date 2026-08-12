import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DeploymentKind = "webhook" | "rollback";
export type DeploymentHistoryState = "accepted" | "succeeded" | "failed";

export interface DeploymentHistoryEntry {
  version: 1;
  at: string;
  appId: string;
  commit: string;
  kind: DeploymentKind;
  state: DeploymentHistoryState;
  delivery?: string;
  stage?: string;
  durationMs?: number;
}

export class DeploymentHistoryStore {
  constructor(readonly directory: string, readonly maximumEntries = 100) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 10_000) {
      throw new Error("deployment history size must be between 1 and 10000");
    }
  }

  async append(entry: Omit<DeploymentHistoryEntry, "version" | "at">): Promise<DeploymentHistoryEntry> {
    validate(entry);
    const value: DeploymentHistoryEntry = { version: 1, at: new Date().toISOString(), ...entry };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${entry.appId}.jsonl`);
    const existing = await this.read(entry.appId);
    const content = [...existing, value].slice(-this.maximumEntries).map((item) => JSON.stringify(item)).join("\n") + "\n";
    const temporary = join(this.directory, `.${entry.appId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return value;
  }

  async read(appId: string): Promise<DeploymentHistoryEntry[]> {
    if (!APP_ID.test(appId)) throw new Error("invalid history app id");
    let content: string;
    try {
      content = await readFile(join(this.directory, `${appId}.jsonl`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`cannot read deployment history: ${error instanceof Error ? error.message : String(error)}`);
    }
    return content.split("\n").filter(Boolean).map((line) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment history is invalid");
      validate(value as Partial<DeploymentHistoryEntry>);
      const item = value as DeploymentHistoryEntry;
      if (item.version !== 1 || typeof item.at !== "string") throw new Error("deployment history is invalid");
      return item;
    });
  }
}

function validate(entry: Partial<DeploymentHistoryEntry>): void {
  if (!entry.appId || !APP_ID.test(entry.appId)) throw new Error("invalid history app id");
  if (!entry.commit || !COMMIT.test(entry.commit)) throw new Error("invalid history commit");
  if (entry.kind !== "webhook" && entry.kind !== "rollback") throw new Error("invalid history kind");
  if (!entry.state || !["accepted", "succeeded", "failed"].includes(entry.state)) throw new Error("invalid history state");
  if (entry.delivery !== undefined && !DELIVERY.test(entry.delivery)) throw new Error("invalid history delivery");
  if (entry.stage !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(entry.stage)) throw new Error("invalid history stage");
  if (entry.durationMs !== undefined && (!Number.isInteger(entry.durationMs) || entry.durationMs < 0)) throw new Error("invalid history duration");
}
