import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClientConfig, readWebhookSecret } from "../src/client-config";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function files() {
  const root = await mkdtemp(join(tmpdir(), "shibumi-client-config-"));
  roots.push(root);
  const config = join(root, "config.json");
  const secrets = join(root, "secrets.env");
  await writeFile(config, JSON.stringify({
    listen: { hostname: "127.0.0.1", port: 8787, maxBodyBytes: 1_048_576 },
    apps: {
      "example-com": {
        domain: "example.com",
        repository: "owner/repo",
        ref: "refs/heads/main",
        checkout: "/srv/example",
        composeFile: "compose.yaml",
        composeCommand: ["podman", "compose"],
        composeProject: "example-com",
        service: "app",
        hostPort: 9100,
        healthUrl: "http://127.0.0.1:9100/healthz",
        secretEnvironmentVariable: "SHIBUMI_SECRET_EXAMPLE_COM",
        caddyMode: "preserve",
      },
    },
  }));
  await writeFile(secrets, `SHIBUMI_SECRET_EXAMPLE_COM=${"a".repeat(64)}\n`);
  return { config, secrets };
}

describe("client configuration", () => {
  test("exports commit-safe app settings", async () => {
    const paths = await files();
    expect(await createClientConfig(paths.config, "example-com", async () => "server.example.com")).toEqual({
      version: 1,
      provider: "shibumi-server",
      server: { hostname: "server.example.com" },
      domain: "example.com",
      appId: "example-com",
      repository: "github:owner/repo",
      branch: "main",
      webhookUrl: "https://example.com/hooks/github/example-com",
      service: "app",
      port: 9100,
      healthPath: "/healthz",
      deploymentMode: "build",
      platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
      cutoverRequired: true,
    });
  });

  test("reads the matching secret without including it in client config", async () => {
    const paths = await files();
    expect(await readWebhookSecret(paths.config, paths.secrets, "example-com")).toBe("a".repeat(64));
    expect(JSON.stringify(await createClientConfig(paths.config, "example-com", async () => "server.example.com"))).not.toContain("aaaa");
  });
});
