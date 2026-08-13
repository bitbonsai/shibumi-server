import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface QueuedDeployment {
  version: 1;
  appId: string;
  commit: string;
  delivery: string;
  queuedAt: string;
}

export class DeploymentQueueStore {
  constructor(readonly directory: string) {}

  async replace(appId: string, commit: string, delivery: string): Promise<QueuedDeployment | undefined> {
    validate(appId, commit, delivery);
    const previous = await this.read(appId);
    const value: QueuedDeployment = { version: 1, appId, commit, delivery, queuedAt: new Date().toISOString() };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${appId}.json`);
    const temporary = join(this.directory, `.${appId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return previous;
  }

  async read(appId: string): Promise<QueuedDeployment | undefined> {
    if (!APP_ID.test(appId)) throw new Error("invalid queue app id");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(this.directory, `${appId}.json`), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`cannot read deployment queue: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment queue is invalid");
    const queued = value as Partial<QueuedDeployment>;
    validate(queued.appId ?? "", queued.commit ?? "", queued.delivery ?? "");
    if (queued.version !== 1 || typeof queued.queuedAt !== "string") throw new Error("deployment queue is invalid");
    return queued as QueuedDeployment;
  }

  async list(): Promise<QueuedDeployment[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const queued: QueuedDeployment[] = [];
    for (const name of names.filter((value) => /^[a-z0-9-]+\.json$/.test(value))) {
      const value = await this.read(name.slice(0, -5));
      if (value) queued.push(value);
    }
    return queued;
  }

  async remove(appId: string): Promise<void> {
    if (!APP_ID.test(appId)) throw new Error("invalid queue app id");
    await rm(join(this.directory, `${appId}.json`), { force: true });
  }
}

function validate(appId: string, commit: string, delivery: string): void {
  if (!APP_ID.test(appId)) throw new Error("invalid queue app id");
  if (!COMMIT.test(commit)) throw new Error("invalid queue commit");
  if (!DELIVERY.test(delivery)) throw new Error("invalid queue delivery");
}
