export type Compression = "zstd-gzip" | "zstd" | "gzip" | "off";
export type Indexing = "allow" | "private";
export type HeaderProfile = "safe" | "off";

export interface CaddySiteOptions {
  domain: string;
  appId: string;
  appPort: number;
  webhookPort: number;
  aliases?: string[];
  aliasMode?: "redirect" | "serve";
  compression?: Compression;
  indexing?: Indexing;
  headers?: HeaderProfile;
  logs?: boolean;
  logRollSizeMb?: number;
  logRollKeep?: number;
}

export interface DetectedCaddySite {
  exists: boolean;
  upstreams: string[];
  aliases: string[];
  compression: boolean;
  headers: boolean;
  logs: boolean;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const APP_RETRY_BUDGET_MS = 5_000;

function validate(options: CaddySiteOptions): void {
  if (!DOMAIN.test(options.domain)) throw new Error("invalid Caddy domain");
  if (!APP_ID.test(options.appId)) throw new Error("invalid Caddy app id");
  if (!Number.isInteger(options.appPort) || options.appPort < 1024 || options.appPort > 65_535) throw new Error("invalid Caddy app port");
  if (!Number.isInteger(options.webhookPort) || options.webhookPort < 1024 || options.webhookPort > 65_535) throw new Error("invalid Caddy webhook port");
  if (options.appPort === options.webhookPort) throw new Error("Caddy ports must differ");
  if (options.aliases !== undefined && (!Array.isArray(options.aliases) || options.aliases.length > 20)) throw new Error("invalid Caddy aliases");
  for (const alias of options.aliases ?? []) if (typeof alias !== "string" || !DOMAIN.test(alias) || alias === options.domain) throw new Error("invalid Caddy alias");
  if (options.aliasMode !== undefined && options.aliasMode !== "redirect" && options.aliasMode !== "serve") throw new Error("invalid Caddy alias mode");
  if (options.compression !== undefined && !["zstd-gzip", "zstd", "gzip", "off"].includes(options.compression)) throw new Error("invalid Caddy compression");
  if (options.indexing !== undefined && options.indexing !== "allow" && options.indexing !== "private") throw new Error("invalid Caddy indexing");
  if (options.headers !== undefined && options.headers !== "safe" && options.headers !== "off") throw new Error("invalid Caddy headers");
  if (options.logs !== undefined && typeof options.logs !== "boolean") throw new Error("invalid Caddy logs");
  const rollSize = options.logRollSizeMb ?? 10;
  const rollKeep = options.logRollKeep ?? 5;
  if (!Number.isInteger(rollSize) || rollSize < 1 || rollSize > 1_024) throw new Error("invalid Caddy log roll size");
  if (!Number.isInteger(rollKeep) || rollKeep < 1 || rollKeep > 100) throw new Error("invalid Caddy log retention");
}

function siteBody(options: CaddySiteOptions): string[] {
  const compression = options.compression ?? "zstd-gzip";
  const lines = [
    `    @shibumi_webhook path /hooks/github/${options.appId}`,
    "    handle @shibumi_webhook {",
    `        reverse_proxy 127.0.0.1:${options.webhookPort}`,
    "    }",
    "",
    "    handle {",
    `        reverse_proxy 127.0.0.1:${options.appPort} {`,
    `            lb_try_duration ${APP_RETRY_BUDGET_MS}ms`,
    "        }",
    "    }",
  ];
  if (compression !== "off") {
    lines.push("", `    encode ${compression === "zstd-gzip" ? "zstd gzip" : compression}`);
  }
  if ((options.headers ?? "safe") === "safe" || (options.indexing ?? "allow") === "private") {
    lines.push("", "    header {");
    if ((options.headers ?? "safe") === "safe") {
      lines.push(
        "        X-Content-Type-Options \"nosniff\"",
        "        Referrer-Policy \"strict-origin-when-cross-origin\"",
        "        -Server",
      );
    }
    if ((options.indexing ?? "allow") === "private") {
      lines.push("        X-Robots-Tag \"noindex, nofollow, noarchive, nosnippet\"");
    }
    lines.push("    }");
  }
  if ((options.indexing ?? "allow") === "private") {
    lines.push(
      "",
      "    @robots path /robots.txt",
      "    respond @robots \"User-agent: *\\nDisallow: /\\n\" 200",
    );
  }
  if (options.logs ?? true) {
    lines.push(
      "",
      "    log {",
      `        output file /var/log/caddy/${options.appId}.log {`,
      `            roll_size ${options.logRollSizeMb ?? 10}MB`,
      `            roll_keep ${options.logRollKeep ?? 5}`,
      "        }",
      "        format json",
      "    }",
    );
  }
  return lines;
}

export function renderCaddySite(options: CaddySiteOptions): string {
  validate(options);
  const aliases = [...new Set(options.aliases ?? [])];
  const blocks: string[] = [];
  if (aliases.length > 0 && (options.aliasMode ?? "redirect") === "redirect") {
    blocks.push(`${aliases.join(", ")} {\n    redir https://${options.domain}{uri} permanent\n}`);
  }
  const hosts = (options.aliasMode ?? "redirect") === "serve" ? [options.domain, ...aliases] : [options.domain];
  blocks.push(`${hosts.join(", ")} {\n${siteBody(options).join("\n")}\n}`);
  return `${blocks.join("\n\n")}\n`;
}

export function renderCaddyWebhookSnippet(appId: string, webhookPort: number): string {
  if (!APP_ID.test(appId)) throw new Error("invalid Caddy app id");
  if (!Number.isInteger(webhookPort) || webhookPort < 1024 || webhookPort > 65_535) throw new Error("invalid Caddy webhook port");
  return `@shibumi_webhook path /hooks/github/${appId}\nhandle @shibumi_webhook {\n    reverse_proxy 127.0.0.1:${webhookPort}\n}\n`;
}

export function renderCaddyManagedSnippet(appId: string, webhookPort: number, appPort: number): string {
  const webhook = renderCaddyWebhookSnippet(appId, webhookPort);
  if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65_535 || appPort === webhookPort) throw new Error("invalid Caddy app port");
  return `${webhook}\nhandle {\n    reverse_proxy 127.0.0.1:${appPort} {\n        lb_try_duration ${APP_RETRY_BUDGET_MS}ms\n    }\n}\n`;
}

function walk(value: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    visit(object);
    for (const child of Object.values(object)) walk(child, visit);
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function detectCaddySite(
  domain: string,
  fetcher: Fetcher = fetch,
  adminUrl = "http://127.0.0.1:2019/config/",
): Promise<DetectedCaddySite> {
  if (!DOMAIN.test(domain)) throw new Error("invalid Caddy domain");
  try {
    const response = await fetcher(adminUrl, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) throw new Error(`Caddy Admin API returned ${response.status}`);
    const config: unknown = await response.json();
    const matchingRoutes: Record<string, unknown>[] = [];
    const aliases = new Set<string>();
    let logs = false;
    walk(config, (object) => {
      if (object.logger_names && typeof object.logger_names === "object" && !Array.isArray(object.logger_names)
        && domain in (object.logger_names as Record<string, unknown>)) logs = true;
      const matches = object.match;
      if (Array.isArray(matches) && matches.some((match) => {
        if (!match || typeof match !== "object") return false;
        const hosts = (match as { host?: unknown }).host;
        if (!Array.isArray(hosts) || !hosts.includes(domain)) return false;
        for (const host of hosts) if (typeof host === "string" && host !== domain) aliases.add(host);
        return true;
      })) matchingRoutes.push(object);
    });
    const upstreams = new Set<string>();
    let compression = false;
    let headers = false;
    for (const route of matchingRoutes) walk(route, (object) => {
      if (object.handler === "reverse_proxy" && Array.isArray(object.upstreams)) {
        for (const upstream of object.upstreams) {
          if (upstream && typeof upstream === "object" && typeof (upstream as { dial?: unknown }).dial === "string") {
            upstreams.add((upstream as { dial: string }).dial);
          }
        }
      }
      if (object.handler === "encode") compression = true;
      if (object.handler === "headers") headers = true;
    });
    return { exists: matchingRoutes.length > 0, upstreams: [...upstreams], aliases: [...aliases], compression, headers, logs };
  } catch {
    return { exists: false, upstreams: [], aliases: [], compression: false, headers: false, logs: false };
  }
}
