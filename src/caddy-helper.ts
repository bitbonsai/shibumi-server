#!/usr/bin/env bun

import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderCaddyManagedSnippet, renderCaddySite, renderCaddyWebhookSnippet, type CaddySiteOptions } from "./caddy";

const HELPER_VERSION = 2;
const MAIN_CONFIG = "/etc/caddy/Caddyfile";
const SITE_DIRECTORY = "/etc/caddy/sites.d";
const BACKUP_DIRECTORY = "/var/lib/shibumi-server/caddy-backups";
const LOCK_DIRECTORY = "/run/lock/shibumi-caddy-helper.lock";
const INSTALLED_SOURCE = "/usr/local/libexec/shibumi-caddy-helper.ts";
const INSTALLED_RENDERER = "/usr/local/libexec/caddy.ts";
const INSTALLED_COMMAND = "/usr/local/sbin/shibumi-caddy-helper";
const GLOBAL_IMPORT = `import ${SITE_DIRECTORY}/*.caddy`;

interface ApplyRequest {
  version: 1;
  action: "apply";
  mode: "new" | "preserve" | "rewrite" | "cutover";
  site: CaddySiteOptions;
}

interface RemoveRequest {
  version: 1;
  action: "remove";
  appId: string;
  domain: string;
}

type HelperRequest = ApplyRequest | RemoveRequest;

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function withoutComment(line: string): string {
  let quoted = false;
  let escaped = false;
  let result = "";
  for (const character of line) {
    if (escaped) {
      result += character;
      escaped = false;
    } else if (character === "\\" && quoted) {
      result += character;
      escaped = true;
    } else if (character === '"') {
      result += character;
      quoted = !quoted;
    } else if (character === "#" && !quoted) {
      break;
    } else {
      result += character;
    }
  }
  return result;
}

function braceDelta(line: string): number {
  let quoted = false;
  let escaped = false;
  let delta = 0;
  const source = withoutComment(line).replace(/\{[A-Za-z][A-Za-z0-9_.:-]*\}/g, "");
  for (const character of source) {
    if (escaped) escaped = false;
    else if (character === "\\" && quoted) escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === "{") delta += 1;
    else if (!quoted && character === "}") delta -= 1;
  }
  return delta;
}

interface SiteBlock { start: number; end: number }

export function findSiteBlock(source: string, domain: string): SiteBlock | undefined {
  const lines = source.split(/(?<=\n)/);
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutComment(lines[index]);
    if (depth === 0 && line.includes("{")) {
      const header = line.slice(0, line.indexOf("{")).trim();
      const hosts = header.split(/[\s,]+/).filter(Boolean);
      if (hosts.includes(domain)) {
        const start = index;
        depth += braceDelta(lines[index]);
        while (depth > 0 && ++index < lines.length) depth += braceDelta(lines[index]);
        if (depth !== 0) throw new Error(`cannot safely parse Caddy block for ${domain}`);
        return { start, end: index };
      }
    }
    depth += braceDelta(lines[index]);
    if (depth < 0) throw new Error("cannot safely parse Caddyfile");
  }
  if (depth !== 0) throw new Error("cannot safely parse Caddyfile");
  return undefined;
}

function ensureGlobalImport(source: string): string {
  if (source.split(/\r?\n/).some((line) => withoutComment(line).trim() === GLOBAL_IMPORT)) return source;
  return `${source.trimEnd()}\n\n${GLOBAL_IMPORT}\n`;
}

export function preserveSite(source: string, domain: string, importPath: string): string {
  if (source.includes(`import ${importPath}`)) return source;
  const block = findSiteBlock(source, domain);
  if (!block) throw new Error(`Caddy has no site block for ${domain}`);
  const lines = source.split(/(?<=\n)/);
  const opening = lines[block.start];
  const indent = /^(\s*)/.exec(opening)?.[1] ?? "";
  lines.splice(block.start + 1, 0, `${indent}    import ${importPath}\n`);
  return lines.join("");
}

export function rewriteSite(source: string, domain: string): string {
  const block = findSiteBlock(source, domain);
  if (!block) throw new Error(`Caddy has no site block for ${domain}`);
  const lines = source.split(/(?<=\n)/);
  lines.splice(block.start, block.end - block.start + 1);
  return ensureGlobalImport(lines.join("").replace(/\n{3,}/g, "\n\n"));
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

function parseRequest(value: unknown): HelperRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const request = value as Record<string, unknown>;
  if (request.action === "remove") {
    exactKeys(request, ["version", "action", "appId", "domain"], "request");
    if (request.version !== 1 || typeof request.appId !== "string" || !APP_ID.test(request.appId)
      || typeof request.domain !== "string" || !DOMAIN.test(request.domain)) {
      throw new Error("unsupported Caddy helper request");
    }
    return request as unknown as RemoveRequest;
  }
  exactKeys(request, ["version", "action", "mode", "site"], "request");
  if (request.version !== 1 || request.action !== "apply" || !["new", "preserve", "rewrite", "cutover"].includes(String(request.mode))) {
    throw new Error("unsupported Caddy helper request");
  }
  if (!request.site || typeof request.site !== "object" || Array.isArray(request.site)) throw new Error("site must be an object");
  exactKeys(request.site as Record<string, unknown>, [
    "domain", "appId", "appPort", "webhookPort", "aliases", "aliasMode", "compression", "indexing", "headers", "logs",
    "logRollSizeMb", "logRollKeep",
  ], "site");
  return request as unknown as ApplyRequest;
}

async function ensureLogFile(appId: string): Promise<void> {
  const path = `/var/log/caddy/${appId}.log`;
  try {
    await lstat(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, "", { mode: 0o640 });
  const owner = Bun.spawnSync(["/usr/bin/chown", "caddy:caddy", path], { stderr: "pipe" });
  if (owner.exitCode !== 0) throw new Error(owner.stderr.toString().trim() || "cannot assign Caddy log ownership");
}

async function runCaddy(args: string[]): Promise<void> {
  const result = Bun.spawnSync(["/usr/bin/caddy", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `caddy ${args[0]} failed`);
}

async function atomicWrite(path: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function install(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("helper installation requires root");
  await mkdir(dirname(INSTALLED_SOURCE), { recursive: true });
  await mkdir(dirname(INSTALLED_COMMAND), { recursive: true });
  await cp(import.meta.path, INSTALLED_SOURCE);
  await cp(join(import.meta.dir, "caddy.ts"), INSTALLED_RENDERER);
  await writeFile(INSTALLED_COMMAND, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(INSTALLED_SOURCE)} "$@"\n`, { mode: 0o755 });
  console.log(`Installed ${INSTALLED_COMMAND}`);
}

export function removeRouteImport(source: string, appId: string): string {
  const routePath = join(SITE_DIRECTORY, `${appId}.routes`);
  return source.split(/(?<=\n)/).filter((line) => withoutComment(line).trim() !== `import ${routePath}`).join("")
    .replace(/\n{3,}/g, "\n\n");
}

async function removeApp(request: RemoveRequest): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("Caddy helper requires root");
  await mkdir(LOCK_DIRECTORY, { mode: 0o700 });
  const sitePath = join(SITE_DIRECTORY, `${request.appId}.caddy`);
  const routePath = join(SITE_DIRECTORY, `${request.appId}.routes`);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backup = join(BACKUP_DIRECTORY, `${request.appId}-remove-${timestamp}`);
  let originalMain = "";
  let originalSite: string | undefined;
  let originalRoute: string | undefined;
  try {
    originalMain = await readFile(MAIN_CONFIG, "utf8");
    originalSite = await readFile(sitePath, "utf8").catch(() => undefined);
    originalRoute = await readFile(routePath, "utf8").catch(() => undefined);
    if (originalSite === undefined && originalRoute === undefined && removeRouteImport(originalMain, request.appId) === originalMain) {
      console.log(JSON.stringify({ ok: true, action: "remove", removed: false, domain: request.domain }));
      return;
    }
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(join(backup, "Caddyfile"), originalMain, { mode: 0o600 });
    if (originalSite !== undefined) await writeFile(join(backup, `${request.appId}.caddy`), originalSite, { mode: 0o600 });
    if (originalRoute !== undefined) await writeFile(join(backup, `${request.appId}.routes`), originalRoute, { mode: 0o600 });
    const nextMain = removeRouteImport(originalMain, request.appId);
    if (nextMain !== originalMain) await atomicWrite(MAIN_CONFIG, nextMain);
    await rm(sitePath, { force: true });
    await rm(routePath, { force: true });
    await runCaddy(["validate", "--config", MAIN_CONFIG, "--adapter", "caddyfile"]);
    await runCaddy(["reload", "--config", MAIN_CONFIG, "--adapter", "caddyfile"]);
    console.log(JSON.stringify({ ok: true, action: "remove", domain: request.domain, backup }));
  } catch (error) {
    if (originalMain) await atomicWrite(MAIN_CONFIG, originalMain).catch(() => {});
    if (originalSite !== undefined) await atomicWrite(sitePath, originalSite).catch(() => {});
    if (originalRoute !== undefined) await atomicWrite(routePath, originalRoute).catch(() => {});
    await runCaddy(["reload", "--config", MAIN_CONFIG, "--adapter", "caddyfile"]).catch(() => {});
    throw error;
  } finally {
    await rm(LOCK_DIRECTORY, { recursive: true, force: true }).catch(() => {});
  }
}

async function apply(request: ApplyRequest): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("Caddy helper requires root");
  renderCaddySite(request.site);
  await mkdir(LOCK_DIRECTORY, { mode: 0o700 });
  const sitePath = join(SITE_DIRECTORY, `${request.site.appId}.caddy`);
  const routePath = join(SITE_DIRECTORY, `${request.site.appId}.routes`);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backup = join(BACKUP_DIRECTORY, `${request.site.appId}-${timestamp}`);
  let originalMain = "";
  let originalSite: string | undefined;
  let originalRoute: string | undefined;
  try {
    originalMain = await readFile(MAIN_CONFIG, "utf8");
    originalSite = await readFile(sitePath, "utf8").catch(() => undefined);
    originalRoute = await readFile(routePath, "utf8").catch(() => undefined);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(join(backup, "Caddyfile"), originalMain, { mode: 0o600 });
    if (originalSite !== undefined) await writeFile(join(backup, `${request.site.appId}.caddy`), originalSite, { mode: 0o600 });
    if (originalRoute !== undefined) await writeFile(join(backup, `${request.site.appId}.routes`), originalRoute, { mode: 0o600 });

    let nextMain = originalMain;
    if (request.mode === "preserve" || request.mode === "cutover") {
      nextMain = preserveSite(originalMain, request.site.domain, routePath);
      await atomicWrite(routePath, request.mode === "cutover"
        ? renderCaddyManagedSnippet(request.site.appId, request.site.webhookPort, request.site.appPort)
        : renderCaddyWebhookSnippet(request.site.appId, request.site.webhookPort));
    } else {
      const existing = findSiteBlock(originalMain, request.site.domain);
      if (request.mode === "new" && existing) throw new Error(`Caddy already manages ${request.site.domain}; use preserve or rewrite`);
      nextMain = request.mode === "rewrite" ? rewriteSite(originalMain, request.site.domain) : ensureGlobalImport(originalMain);
      await atomicWrite(sitePath, renderCaddySite(request.site));
    }
    if (nextMain !== originalMain) await atomicWrite(MAIN_CONFIG, nextMain);
    if (request.mode !== "preserve" && request.mode !== "cutover" && (request.site.logs ?? true)) await ensureLogFile(request.site.appId);
    await runCaddy(["validate", "--config", MAIN_CONFIG, "--adapter", "caddyfile"]);
    await runCaddy(["reload", "--config", MAIN_CONFIG, "--adapter", "caddyfile"]);
    console.log(JSON.stringify({ ok: true, mode: request.mode, domain: request.site.domain, backup }));
  } catch (error) {
    if (originalMain) await atomicWrite(MAIN_CONFIG, originalMain).catch(() => {});
    if (originalSite === undefined) await rm(sitePath, { force: true }).catch(() => {});
    else await atomicWrite(sitePath, originalSite).catch(() => {});
    if (originalRoute === undefined) await rm(routePath, { force: true }).catch(() => {});
    else await atomicWrite(routePath, originalRoute).catch(() => {});
    await runCaddy(["reload", "--config", MAIN_CONFIG, "--adapter", "caddyfile"]).catch(() => {});
    throw error;
  } finally {
    await rm(LOCK_DIRECTORY, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.main) {
  try {
    const argument = process.argv[2];
    if (argument === "--version") console.log(HELPER_VERSION);
    else if (argument === "--install") await install();
    else if (!argument) {
      const input = await new Response(Bun.stdin.stream()).text();
      if (input.length > 65_536) throw new Error("Caddy helper request is too large");
      const request = parseRequest(JSON.parse(input));
      if (request.action === "remove") await removeApp(request);
      else await apply(request);
    } else throw new Error("unknown Caddy helper argument");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
