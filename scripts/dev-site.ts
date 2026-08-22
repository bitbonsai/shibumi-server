#!/usr/bin/env bun

import { watch } from "node:fs";
import packageJson from "../package.json";
import { buildSite } from "./build-site";

await buildSite(false);

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
const broadcast = (file: string) => {
  const message = encoder.encode(`data: ${file}\n\n`);
  for (const client of clients) {
    try { client.enqueue(message); } catch { clients.delete(client); }
  }
};
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
const rebuild = (file: string) => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    await buildSite(false);
    broadcast(file);
  }, 40);
};
const watchers = [
  watch("site", { recursive: true }, (_event, file) => rebuild(String(file ?? "site"))),
  watch("docs", { recursive: true }, (_event, file) => rebuild(String(file ?? "docs"))),
  watch("README.md", () => rebuild("README.md")),
  watch("package.json", () => rebuild("package.json")),
];

const files: Record<string, [string, string]> = {
  "/styles.css": ["site/styles.css", "text/css; charset=utf-8"],
  "/shibumi.css": ["site/shibumi.css", "text/css; charset=utf-8"],
  "/favicon.png": ["site/favicon.png", "image/png"],
  "/shibumistack-light.webp": ["site/shibumistack-light.webp", "image/webp"],
  "/shibumistack-dark.webp": ["site/shibumistack-dark.webp", "image/webp"],
  "/docs.css": ["site/docs.css", "text/css; charset=utf-8"],
  "/app.js": ["site/app.js", "application/javascript; charset=utf-8"],
  "/docs.js": ["site/docs.js", "application/javascript; charset=utf-8"],
  "/favicon.svg": ["site/favicon.svg", "image/svg+xml"],
  "/index.md": ["README.md", "text/plain; charset=utf-8"],
};
const reload = `<script>new EventSource("/__hmr").onmessage=({data})=>{if(data.endsWith(".css")){for(const link of document.querySelectorAll('link[rel="stylesheet"]')){const next=link.cloneNode();next.href=new URL(link.href);next.href+=(next.href.includes("?")?"&":"?")+Date.now();next.onload=()=>link.remove();link.after(next)}}else location.reload()}</script>`;

const server = Bun.serve({
  hostname: "localhost",
  port: Number(process.env.PORT ?? 9100),
  idleTimeout: 0, // HMR EventSource stays open between file changes.
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/" || pathname === "/index.html") {
      const html = (await Bun.file("site/index.html").text())
        .replaceAll("{{version}}", packageJson.version)
        .replace("</body>", `${reload}</body>`);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/__hmr") {
      let client: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { client = controller; clients.add(controller); },
        cancel() { clients.delete(client); },
      });
      return new Response(body, { headers: { "Cache-Control": "no-cache", "Content-Type": "text/event-stream" } });
    }
    if (pathname === "/install") {
      return new Response(`#!/bin/sh\nset -eu\ncurl -fsSL https://raw.githubusercontent.com/bitbonsai/shibumi-server/v${packageJson.version}/install.sh | bash\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const file = files[pathname];
    if (file) return new Response(Bun.file(file[0]), { headers: { "Content-Type": file[1] } });
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(pathname) || pathname.includes("..")) return new Response("Not found\n", { status: 404 });
    const relative = pathname.replace(/^\//, "").replace(/\/$/, "");
    const path = /\.[a-z0-9]+$/i.test(relative) ? `dist/${relative}` : `dist/${relative}/index.html`;
    const staticFile = Bun.file(path);
    if (!await staticFile.exists()) return new Response("Not found\n", { status: 404 });
    const body = path.endsWith(".html") ? (await staticFile.text()).replace("</body>", `${reload}</body>`) : staticFile;
    const contentType = path.endsWith(".html") ? "text/html; charset=utf-8"
      : path.endsWith(".md") || path.endsWith(".txt") ? "text/plain; charset=utf-8"
      : path.endsWith(".xml") ? "application/xml; charset=utf-8"
      : path.endsWith(".css") ? "text/css; charset=utf-8"
      : path.endsWith(".js") ? "application/javascript; charset=utf-8"
      : path.endsWith(".png") ? "image/png"
      : path.endsWith(".webp") ? "image/webp"
      : path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
    return new Response(body, { headers: { "Content-Type": contentType } });
  },
});

const shutdown = () => {
  clearTimeout(rebuildTimer);
  for (const watcher of watchers) watcher.close();
  server.stop(true);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`server.shibumistack.dev preview with live reload: http://${server.hostname}:${server.port}`);
