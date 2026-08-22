import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const build = Bun.spawnSync([process.execPath, "scripts/build-site.ts"], { stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());

const pages = ["index", "install", "add-app", "ship", "deployments", "history-rollback", "operations", "security", "commands", "architecture", "prebuilt-benchmark"];

describe("documentation site", () => {
  test("builds browsable HTML and byte-identical Markdown", async () => {
    for (const page of pages) {
      const htmlPath = page === "index" ? "dist/docs/index.html" : `dist/docs/${page}/index.html`;
      const html = await readFile(htmlPath, "utf8");
      expect(html).toContain('class="docs-frame"');
      expect(html).toContain(`type="text/markdown" href="/docs/${page}.md"`);
      expect(await readFile(`dist/docs/${page}.md`, "utf8")).toBe(await readFile(`docs/${page}.md`, "utf8"));
    }
  });

  test("llms.txt points agents to every Markdown page", async () => {
    const llms = await readFile("dist/llms.txt", "utf8");
    for (const page of pages) expect(llms).toContain(`/docs/${page}.md`);
    expect(llms).toContain("/index.md");
  });

  test("highlights shell, YAML, and ini code", async () => {
    const install = await readFile("dist/docs/install/index.html", "utf8");
    expect(install).toContain('<span class="syntax-command">curl</span>');
    expect(install).toContain('<span class="syntax-command">shis</span>');

    const architecture = await readFile("dist/docs/architecture/index.html", "utf8");
    expect(architecture).toContain('<span class="syntax-key">MemoryHigh</span>');
    expect(architecture).toContain('<span class="syntax-key">services</span>');
  });

  test("sets one theme icon before first paint", async () => {
    const themeSetup = 'document.documentElement.dataset.theme=(t==="light"||t==="dark")';
    expect(await readFile("dist/index.html", "utf8")).toContain(themeSetup);
    expect(await readFile("dist/docs/index.html", "utf8")).toContain(themeSetup);
    expect(await readFile("dist/styles.css", "utf8")).toContain(".theme-toggle .icon-moon { display:none; }");
  });

  test("uses standalone install URL", async () => {
    expect(await readFile("dist/docs/install.md", "utf8")).toContain("https://server.shibumistack.dev/install");
  });
});
