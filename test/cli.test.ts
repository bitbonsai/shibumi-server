import { expect, test } from "bun:test";
import { join } from "node:path";
import packageJson from "../package.json";

async function cli(args: string[]) {
  const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("CLI help documents interactive installation, pinned installation, and app registration", async () => {
  const result = await cli(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Interactive installation");
  expect(result.stdout).toContain("shibumi-server --version");
  expect(result.stdout).toContain("shibumi-server init");
  expect(result.stdout).toContain("shibumi-server add <domain>");
  expect(result.stderr).toBe("");
});

test("CLI prints its package version", async () => {
  const result = await cli(["--version"]);
  expect(result).toEqual({ exitCode: 0, stdout: `${packageJson.version}\n`, stderr: "" });
});

test("CLI rejects installation on hosts without systemd", async () => {
  if (process.platform === "linux") return;
  const result = await cli(["init"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("require Linux with a systemd user session");
});
