import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { triggerRedeploy } from "../src/redeploy";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("redeploy signs an exact configured push for the loopback service", async () => {
  const home = await mkdtemp(join(tmpdir(), "shibumi-redeploy-"));
  roots.push(home);
  const directory = join(home, ".config", "shibumi-server");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), JSON.stringify({
    listen: { hostname: "127.0.0.1", port: 8787, maxBodyBytes: 1_048_576 },
    apps: {
      "example-com": {
        domain: "example.com", repository: "owner/repo", ref: "refs/heads/main", checkout: "/srv/example",
        composeFile: "compose.yaml", composeCommand: ["podman", "compose"], composeProject: "example-com", service: "app",
        hostPort: 9100, healthUrl: "http://127.0.0.1:9100/healthz", secretEnvironmentVariable: "SHIBUMI_SECRET_EXAMPLE_COM",
      },
    },
  }));
  await writeFile(join(directory, "secrets.env"), `SHIBUMI_SECRET_EXAMPLE_COM=${"a".repeat(64)}\n`);
  let request: Request | undefined;

  await triggerRedeploy(home, "example-com", "b".repeat(40), async (input, init) => {
    request = new Request(input, init);
    return new Response(null, { status: 202 });
  });

  expect(request?.url).toBe("http://127.0.0.1:8787/hooks/github/example-com");
  expect(request?.headers.get("x-github-event")).toBe("push");
  expect(request?.headers.get("x-hub-signature-256")).toMatch(/^sha256=[a-f0-9]{64}$/);
  expect(await request?.json()).toEqual({ repository: { full_name: "owner/repo" }, ref: "refs/heads/main", after: "b".repeat(40) });
});
