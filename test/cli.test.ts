import { expect, test } from "bun:test";
import { join } from "node:path";
import packageJson from "../package.json";

async function cli(args: string[]) {
  const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, SHIBUMI_SKIP_UPDATE_CHECK: "1" },
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
  expect(result.stdout).toContain("渋み  shis (shibumi-server)");
  expect(result.stdout).toContain("Guided installation");
  expect(result.stdout).toContain("shis --version");
  expect(result.stdout).toContain("shis init");
  expect(result.stdout).toContain("shis update");
  expect(result.stdout).toContain("shis uninstall");
  expect(result.stdout).toContain("shis add <domain>");
  expect(result.stdout).toContain("shis set-repository <domain|app-id> <repository>");
  expect(result.stdout).toContain("--dry-run");
  expect(result.stdout).toContain("client-config");
  expect(result.stdout).toContain("status <app-id>");
  expect(result.stdout).toContain("--repository <repository> \\");
  expect(result.stdout).not.toContain("\x1b[");
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
  expect(result.stderr).toContain("requires Linux with a systemd user session");
  expect(result.stderr).not.toContain("USAGE");
});
