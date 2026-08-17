import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/deploy";
import { loadPrebuiltImage, serverPlatform, uploadedImage } from "../src/prebuilt";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];

  async run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    if (args[0] === "image" && args[1] === "inspect") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{
          Os: "linux",
          Architecture: process.arch === "arm64" ? "arm64" : "amd64",
          RepoTags: [args[2]],
          Labels: {
            "dev.shibumistack.app-id": "myapp",
            "org.opencontainers.image.revision": "a".repeat(40),
            "org.opencontainers.image.source": "https://github.com/owner/repo",
            "dev.shibumistack.source-tree": "b".repeat(40),
          },
        }]),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

async function config(mode: "build" | "prebuilt", minimumFreeDiskMb = 4_096): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shibumi-prebuilt-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({
    listen: { hostname: "127.0.0.1", port: 8787 },
    apps: {
      myapp: {
        repository: "owner/repo",
        ref: "refs/heads/main",
        checkout: root,
        composeFile: "compose.yaml",
        composeProject: "myapp",
        service: "web",
        hostPort: 9100,
        healthUrl: "http://127.0.0.1:9100/healthz",
        secretEnvironmentVariable: "SHIBUMI_SECRET_MYAPP",
        deploymentMode: mode,
        minimumFreeDiskMb,
      },
    },
  }));
  return path;
}

describe("prebuilt images", () => {
  test("loads only the exact registered app and commit tag from stdin", async () => {
    const runner = new FakeRunner();
    const commit = "a".repeat(40);
    const image = await loadPrebuiltImage(await config("prebuilt"), "myapp", commit, 1024, runner);

    expect(image).toBe(uploadedImage("myapp", commit));
    expect(runner.calls.map(({ args }) => args.slice(0, 2))).toEqual([
      ["image", "rm"],
      ["image", "load"],
      ["image", "inspect"],
    ]);
    expect(runner.calls[1].options?.stdin).toBe("inherit");
  });

  test("rejects images whose identity labels do not match", async () => {
    const runner = new FakeRunner();
    const path = await config("prebuilt");
    runner.run = async (command, args, options) => {
      runner.calls.push({ command, args, options });
      if (args[0] === "image" && args[1] === "inspect") return {
        exitCode: 0,
        stdout: JSON.stringify([{ Os: "linux", Architecture: process.arch === "arm64" ? "arm64" : "amd64", RepoTags: [args[2]], Labels: {} }]),
        stderr: "",
      };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(loadPrebuiltImage(path, "myapp", "a".repeat(40), 1024, runner)).rejects.toThrow("app identity");
    expect(runner.calls.at(-1)?.args.slice(0, 2)).toEqual(["image", "rm"]);
  });

  test("rejects uploads until prebuilt mode is enabled", async () => {
    const runner = new FakeRunner();
    await expect(loadPrebuiltImage(await config("build"), "myapp", "a".repeat(40), 1024, runner)).rejects.toThrow("enable-prebuilt");
    expect(runner.calls).toHaveLength(0);
  });

  test("rejects an image before loading when disk headroom is too small", async () => {
    const runner = new FakeRunner();
    await expect(loadPrebuiltImage(
      await config("prebuilt", 16_777_216),
      "myapp",
      "a".repeat(40),
      1024,
      runner,
    )).rejects.toThrow("free disk");
    expect(runner.calls).toHaveLength(0);
  });

  test("maps supported server architectures to Linux image platforms", () => {
    expect(serverPlatform("arm64")).toBe("linux/arm64");
    expect(serverPlatform("x64")).toBe("linux/amd64");
    expect(() => serverPlatform("riscv64")).toThrow("unsupported");
  });
});
