import { statfs } from "node:fs/promises";
import { loadConfig } from "./config";
import type { CommandRunner } from "./deploy";

const COMMIT = /^[a-f0-9]{40}$/;

export function uploadedImage(appId: string, commit: string): string {
  return `localhost/shibumi-server/upload/${appId}:${commit}`;
}

export function runtimeImage(appId: string): string {
  return `localhost/shibumi-server/runtime/${appId}:current`;
}

export function serverPlatform(architecture = process.arch): string {
  if (architecture === "arm64") return "linux/arm64";
  if (architecture === "x64") return "linux/amd64";
  throw new Error(`unsupported server architecture: ${architecture}`);
}

interface ImageInspect {
  Os?: unknown;
  Architecture?: unknown;
  RepoTags?: unknown;
}

export async function inspectPrebuiltImage(
  runner: CommandRunner,
  appId: string,
  commit: string,
): Promise<string> {
  const image = uploadedImage(appId, commit);
  const inspected = await runner.run("podman", ["image", "inspect", image], { capture: true });
  if (inspected.exitCode !== 0) throw new Error(`prebuilt image ${commit} is not loaded`);
  let details: ImageInspect;
  try {
    const value = JSON.parse(inspected.stdout) as unknown;
    if (!Array.isArray(value) || !value[0] || typeof value[0] !== "object") throw new Error("invalid inspect result");
    details = value[0] as ImageInspect;
  } catch {
    throw new Error("Podman returned invalid prebuilt image metadata");
  }
  const platform = `${details.Os}/${details.Architecture}`;
  if (platform !== serverPlatform()) throw new Error(`prebuilt image platform is ${platform}; ${serverPlatform()} required`);
  if (!Array.isArray(details.RepoTags) || !details.RepoTags.includes(image)) throw new Error("prebuilt image tag does not match commit");
  return image;
}

export async function loadPrebuiltImage(
  configPath: string,
  appId: string,
  commit: string,
  archiveBytes: number,
  runner: CommandRunner,
): Promise<string> {
  if (!COMMIT.test(commit)) throw new Error("image-load commit must be a full lowercase SHA");
  const app = (await loadConfig(configPath)).apps[appId];
  if (!app) throw new Error(`unknown app: ${appId}`);
  if (app.deploymentMode !== "prebuilt") {
    throw new Error(`app ${appId} does not accept prebuilt images.\n\nNext: run shis enable-prebuilt ${appId}.`);
  }
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1 || archiveBytes > 16 * 1024 ** 3) {
    throw new Error("prebuilt image archive size is invalid");
  }
  const filesystem = await statfs(app.checkout);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  const floorBytes = app.minimumFreeDiskMb * 1024 ** 2;
  if (availableBytes - archiveBytes < floorBytes) {
    throw new Error(`prebuilt image needs ${Math.ceil(archiveBytes / 1024 ** 2)} MiB plus ${app.minimumFreeDiskMb} MiB free disk.\n\nNext: free server disk space, then rerun bun run ship.`);
  }

  const image = uploadedImage(appId, commit);
  await runner.run("podman", ["image", "rm", image], { capture: true });
  const loaded = await runner.run("podman", ["image", "load"], { capture: true, stdin: "inherit" });
  if (loaded.exitCode !== 0) throw new Error(loaded.stderr.trim() || "Podman could not load prebuilt image");
  try {
    await inspectPrebuiltImage(runner, appId, commit);
  } catch (error) {
    await runner.run("podman", ["image", "rm", image], { capture: true });
    throw error;
  }
  return image;
}
