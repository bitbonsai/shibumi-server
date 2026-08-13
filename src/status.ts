import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMMIT = /^[a-f0-9]{40}$/;

export type DeploymentState = "accepted" | "running" | "succeeded" | "failed";

export interface DeploymentStatus {
  version: 1;
  appId: string;
  commit: string;
  state: DeploymentState;
  stage: string;
  message?: string;
  output?: string;
  url?: string;
  queuedCommit?: string;
  updatedAt: string;
}

export class DeploymentStatusStore {
  constructor(readonly directory: string) {}

  async write(status: Omit<DeploymentStatus, "version" | "updatedAt">): Promise<DeploymentStatus> {
    if (!APP_ID.test(status.appId)) throw new Error("invalid status app id");
    if (!COMMIT.test(status.commit)) throw new Error("invalid status commit");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(status.stage)) throw new Error("invalid status stage");
    if (status.message !== undefined && (status.message.length > 256 || /[\r\n\0]/.test(status.message))) throw new Error("invalid status message");
    if (status.output !== undefined && (status.output.length > 512 || /[\r\n\0\x1b]/.test(status.output))) throw new Error("invalid status output");
    if (status.url !== undefined && (!status.url.startsWith("https://") || status.url.length > 512)) throw new Error("invalid status URL");
    if (status.queuedCommit !== undefined && !COMMIT.test(status.queuedCommit)) throw new Error("invalid queued commit");
    const value: DeploymentStatus = {
      version: 1,
      ...status,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${status.appId}.json`);
    const temporary = join(this.directory, `.${status.appId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return value;
  }

  async read(appId: string, commit?: string): Promise<DeploymentStatus | undefined> {
    if (!APP_ID.test(appId)) throw new Error("invalid status app id");
    if (commit !== undefined && !COMMIT.test(commit)) throw new Error("invalid status commit");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(this.directory, `${appId}.json`), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`cannot read deployment status: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment status is invalid");
    const status = value as Partial<DeploymentStatus>;
    if (status.version !== 1 || status.appId !== appId || typeof status.commit !== "string" || !COMMIT.test(status.commit)
      || !["accepted", "running", "succeeded", "failed"].includes(status.state ?? "")
      || typeof status.stage !== "string" || typeof status.updatedAt !== "string"
      || (status.output !== undefined && (typeof status.output !== "string" || status.output.length > 512 || /[\r\n\0\x1b]/.test(status.output)))
      || (status.queuedCommit !== undefined && (typeof status.queuedCommit !== "string" || !COMMIT.test(status.queuedCommit)))) {
      throw new Error("deployment status is invalid");
    }
    if (commit !== undefined && status.commit !== commit && status.queuedCommit !== commit) return undefined;
    return status as DeploymentStatus;
  }
}
