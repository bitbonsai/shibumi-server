import { join } from "node:path";
import { CADDY_HELPER_VERSION, type CaddySiteOptions } from "./caddy";

const HELPER = "/usr/local/sbin/shibumi-caddy-helper";

export interface CaddyApplyRequest {
  version: 1;
  action: "apply";
  mode: "new" | "preserve" | "rewrite" | "cutover" | "refresh";
  site: CaddySiteOptions;
}

export interface CaddyRemoveRequest {
  version: 1;
  action: "remove";
  appId: string;
  domain: string;
}

export function caddyHelperNeedsInstall(exitCode: number, output: string): boolean {
  return exitCode !== 0 || output.trim() !== CADDY_HELPER_VERSION;
}

async function command(args: string[], input?: string, inherit = false): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? (inherit ? "inherit" : "ignore") : "pipe",
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  if (input !== undefined) {
    if (!child.stdin) throw new Error("cannot open helper input");
    child.stdin.write(input);
    child.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    inherit ? Promise.resolve("") : new Response(child.stdout).text(),
    inherit ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function authorizeCaddySudo(): Promise<void> {
  const authorization = await command(["sudo", "-v"], undefined, true);
  if (authorization.exitCode !== 0) throw new Error("sudo authorization failed");
}

export async function applyCaddyWithSudo(request: CaddyApplyRequest | CaddyRemoveRequest): Promise<void> {
  await authorizeCaddySudo();

  const version = await command(["sudo", "-n", HELPER, "--version"]);
  if (caddyHelperNeedsInstall(version.exitCode, version.stdout)) {
    const source = join(import.meta.dir, "caddy-helper.ts");
    const install = await command(["sudo", "-n", process.execPath, source, "--install"]);
    if (install.exitCode !== 0) throw new Error(install.stderr.trim() || "cannot install Caddy helper");
  }

  const result = await command(["sudo", "-n", HELPER], `${JSON.stringify(request)}\n`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Caddy configuration failed");
}
