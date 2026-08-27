#!/usr/bin/env bun
import { createHash } from "node:crypto";

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import packageJson from "../package.json";

const output = "dist";
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package version must be stable semver");

const pages = [
  { path: "", title: "Server docs", description: "Install shis, connect a project, and deploy the image you built.", section: "Start", source: "docs/index.md" },
  { path: "install", title: "Install shibumi-server", description: "Prepare a Linux server and install one fixed release.", section: "Start", source: "docs/install.md" },
  { path: "add-app", title: "Add an app", description: "Register a domain, repository, checkout, and Caddy route.", section: "Start", source: "docs/add-app.md" },
  { path: "ship", title: "Connect project", description: "Add project-owned Ship tooling and point it at shibumi-server.", section: "Start", source: "docs/ship.md" },
  { path: "deployments", title: "Deployments", description: "Follow local builds, server checks, health checks, and replacement.", section: "Operate", source: "docs/deployments.md" },
  { path: "history-rollback", title: "History and rollback", description: "See recent deploys and restore the previous retained image.", section: "Operate", source: "docs/history-rollback.md" },
  { path: "app-env", title: "Environment and secrets", description: "Manage per-app runtime values with ship:env and shis env.", section: "Operate", source: "docs/app-env.md" },
  { path: "operations", title: "Operations", description: "Check status, update, remove, inspect, and uninstall.", section: "Operate", source: "docs/operations.md" },
  { path: "security", title: "Security model", description: "See what Shibumi trusts and where secrets live.", section: "Reference", source: "docs/security.md" },
  { path: "commands", title: "Command reference", description: "Commands and options available through shis.", section: "Reference", source: "docs/commands.md" },
  { path: "architecture", title: "Architecture", description: "Trace webhook validation, image checks, replacement, retention, and host limits.", section: "Reference", source: "docs/architecture.md" },
  { path: "prebuilt-benchmark", title: "Prebuilt benchmark", description: "Measured local-build and VPS deploy results.", section: "Reference", source: "docs/prebuilt-benchmark.md" },
] as const;

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const slug = (value: string) => value.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const copyIcon = '<svg class="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><svg class="check-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';

const decodeEntities = (value: string) => value
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replaceAll("&#x27;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&amp;", "&");

function highlightCode(text: string, language = "text"): string {
  let code = escapeHtml(decodeEntities(text));
  const stash: string[] = [];
  const token = (className: string, value: string) => {
    const key = String.fromCodePoint(0xe000 + stash.length);
    stash.push(`<span class="syntax-${className}">${value}</span>`);
    return key;
  };

  if (["sh", "bash", "shell"].includes(language)) {
    code = code
      .replace(/(^|\s)(#[^\n]*)/gm, (_match, lead, value) => `${lead}${token("comment", value)}`)
      .replace(/(&quot;[^\n]*?&quot;|'[^\n]*?')/g, (value) => token("string", value))
      .replace(/(^|[;&|]\s*)(bun|shis|shibumi-server|git|curl|cd|systemctl|journalctl|podman|podman-compose|colima|docker|gh|openssl|brew)(?=\s|$)/gm, (_match, lead, value) => `${lead}${token("command", value)}`)
      .replace(/(^|\s)(--?[a-z][a-z0-9-]*)(?=\s|$)/g, (_match, lead, value) => `${lead}${token("option", value)}`);
  } else if (["yaml", "yml"].includes(language)) {
    code = code
      .replace(/(^|\s)(#[^\n]*)/gm, (_match, lead, value) => `${lead}${token("comment", value)}`)
      .replace(/(&quot;[^\n]*?&quot;|'[^\n]*?')/g, (value) => token("string", value))
      .replace(/(^|\s)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/gm, (_match, lead, value, colon) => `${lead}${token("key", value)}${colon}`)
      .replace(/\b(true|false|null)\b/g, (value) => token("literal", value));
  } else if (language === "ini") {
    code = code.replace(/^([A-Za-z][A-Za-z0-9_-]*)(=)/gm, (_match, key, equals) => `${token("key", key)}${equals}`);
  }

  return code.replace(/[\ue000-\uf8ff]/g, (key) => stash[key.codePointAt(0)! - 0xe000]);
}

function renderMarkdown(markdown: string): string {
  return Bun.markdown.html(markdown)
    .replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_match, level, text) => {
      const id = slug(text);
      return `<h${level} id="${id}">${text}<a class="docs-anchor" href="#${id}" aria-label="Link to ${id}">#</a></h${level}>`;
    })
    .replace(/<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_match, language = "text", code) => `<div class="docs-code"><div class="docs-code-bar"><span>${escapeHtml(language)}</span><button class="docs-copy" type="button" data-copy-code aria-label="Copy code">${copyIcon}</button></div><pre><code>${highlightCode(code, language)}</code></pre></div>`)
    .replace(/<table>([\s\S]*?)<\/table>/g, '<div class="docs-table-wrap"><table>$1</table></div>');
}

function sidebar(activePath: string): string {
  return [...new Set(pages.map(({ section }) => section))].map((section) => {
    const links = pages.filter((page) => page.section === section).map((page) => {
      const href = page.path ? `/docs/${page.path}` : "/docs";
      return `<a href="${href}"${page.path === activePath ? ' aria-current="page"' : ""}>${escapeHtml(page.title)}</a>`;
    }).join("");
    return `<div class="docs-nav-group"><h2>${escapeHtml(section)}</h2>${links}</div>`;
  }).join("");
}

function pager(index: number): string {
  const link = (page: typeof pages[number], direction: "prev" | "next") => `<a class="docs-pager-${direction}" href="${page.path ? `/docs/${page.path}` : "/docs"}"><span>${direction === "prev" ? "Previous" : "Next"}</span><strong>${escapeHtml(page.title)}</strong></a>`;
  return `${index ? link(pages[index - 1]!, "prev") : ""}${index < pages.length - 1 ? link(pages[index + 1]!, "next") : ""}`;
}

export async function buildSite(log = true): Promise<void> {
  await rm(output, { recursive: true, force: true });
  await cp("site", output, { recursive: true });
  await rm(`${output}/docs-template.html`);

  // CSS/JS links carry a content hash so CDN caches drop stale copies.
  const assetVersion = createHash("sha256")
    .update(await readFile("site/shibumi.css"))
    .update(await readFile("site/styles.css"))
    .update(await readFile("site/docs.css"))
    .digest("hex")
    .slice(0, 12);
  const versionAssets = (html: string) =>
    html.replaceAll(/(href|src)="\/((?:shibumi|styles|docs)\.css|(?:app|docs)\.js)"/g, `$1="/$2?v=${assetVersion}"`);

  const home = versionAssets((await readFile(`${output}/index.html`, "utf8")).replaceAll("{{version}}", version));
  if (home.includes("{{")) throw new Error("unresolved home template token");
  await writeFile(`${output}/index.html`, home);
  await writeFile(`${output}/index.md`, await readFile("README.md"));

  const template = await readFile("site/docs-template.html", "utf8");
  for (const [index, page] of pages.entries()) {
    const markdown = await readFile(page.source, "utf8");
    const path = page.path ? `/docs/${page.path}` : "/docs";
    const values: Record<string, string> = {
      title: escapeHtml(page.title),
      description: escapeHtml(page.description),
      section: escapeHtml(page.section),
      path,
      markdown: `/docs/${page.path ? `${page.path}.md` : "index.md"}`,
      sidebar: sidebar(page.path),
      content: renderMarkdown(markdown),
      pager: pager(index),
    };
    let html = versionAssets(template);
    for (const [name, value] of Object.entries(values)) html = html.replaceAll(`{{${name}}}`, value);
    if (/{{[a-z-]+}}/.test(html)) throw new Error(`unresolved docs template token for ${path}`);
    const directory = page.path ? `${output}/docs/${page.path}` : `${output}/docs`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/index.html`, html);
    await writeFile(`${output}/docs/${page.path ? `${page.path}.md` : "index.md"}`, markdown);
  }

  await writeFile(`${output}/install`, `#!/bin/sh\nset -eu\ncurl -fsSL https://raw.githubusercontent.com/shibumistack/shibumi-server/v${version}/install.sh | bash\n`);
  await writeFile(`${output}/robots.txt`, "User-agent: *\nAllow: /\nSitemap: https://server.shibumistack.dev/sitemap.xml\n");
  const routes = ["", ...pages.map(({ path }) => path ? `docs/${path}` : "docs")];
  await writeFile(`${output}/sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map((route) => `<url><loc>https://server.shibumistack.dev/${route}</loc></url>`).join("")}</urlset>\n`);
  await writeFile(`${output}/httpd.conf`, [
    "I:index.html",
    ".css:text/css",
    ".js:application/javascript",
    ".md:text/plain",
    ".txt:text/plain",
    ".sh:text/plain",
    ".xml:application/xml",
    ".svg:image/svg+xml",
    ".png:image/png",
    ".webp:image/webp",
    "",
  ].join("\n"));
  if (log) console.log(`Built server.shibumistack.dev v${version}`);
}

if (import.meta.main) await buildSite();
