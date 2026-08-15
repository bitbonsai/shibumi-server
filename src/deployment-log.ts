import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMMIT = /^[a-f0-9]{40}$/;

export class DeploymentLogStore {
  readonly #sizes = new Map<string, number>();

  constructor(readonly directory: string, readonly maximumBytes = 256 * 1024) {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1024 || maximumBytes > 1024 * 1024) {
      throw new Error("deployment log size must be between 1024 and 1048576 bytes");
    }
  }

  async start(appId: string, commit: string): Promise<void> {
    validateApp(appId);
    if (!COMMIT.test(commit)) throw new Error("invalid deployment log commit");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.#path(appId);
    const content = `commit ${commit}\nstarted ${new Date().toISOString()}\n`;
    const temporary = join(this.directory, `.${appId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      this.#sizes.set(appId, Buffer.byteLength(content));
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async append(appId: string, stage: string, value: string): Promise<void> {
    validateApp(appId);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(stage)) throw new Error("invalid deployment log stage");
    const clean = stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").replace(/[\r\n]+/g, " ").trim();
    if (!clean) return;
    const line = `[${stage}] ${clean.slice(0, 4096)}\n`;
    const size = this.#sizes.get(appId) ?? 0;
    const available = this.maximumBytes - size;
    if (available <= 0) return;
    const content = Buffer.from(line).subarray(0, available);
    await appendFile(this.#path(appId), content, { mode: 0o600 });
    this.#sizes.set(appId, size + content.byteLength);
  }

  async read(appId: string): Promise<string | undefined> {
    validateApp(appId);
    try {
      return await readFile(this.#path(appId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  #path(appId: string): string {
    return join(this.directory, `${appId}.log`);
  }
}

function validateApp(appId: string): void {
  if (!APP_ID.test(appId)) throw new Error("invalid deployment log app id");
}
