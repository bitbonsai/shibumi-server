import { describe, expect, test } from "bun:test";
import { detectCaddySite, renderCaddyManagedSnippet, renderCaddySite, renderCaddyWebhookSnippet } from "../src/caddy";

describe("Caddy integration", () => {
  test("renders constrained recommended site configuration", () => {
    const config = renderCaddySite({
      domain: "example.com",
      appId: "example-com",
      appPort: 9100,
      webhookPort: 8787,
      aliases: ["www.example.com"],
    });

    expect(config).toContain("www.example.com {\n    redir https://example.com{uri} permanent");
    expect(config).toContain("path /hooks/github/example-com");
    expect(config).toContain("reverse_proxy 127.0.0.1:8787");
    expect(config).toContain("reverse_proxy 127.0.0.1:9100");
    expect(config).toContain("encode zstd gzip");
    expect(config).toContain("X-Content-Type-Options");
    expect(config).toContain("output file /var/log/caddy/example-com.log");
    expect(config).not.toContain("Content-Security-Policy");
  });

  test("renders private and minimal choices without arbitrary directives", () => {
    const privateConfig = renderCaddySite({
      domain: "example.com",
      appId: "example-com",
      appPort: 9100,
      webhookPort: 8787,
      indexing: "private",
      compression: "off",
      headers: "off",
      logs: false,
    });
    expect(privateConfig).toContain("X-Robots-Tag");
    expect(privateConfig).toContain("Disallow: /");
    expect(privateConfig).not.toContain("encode ");
    expect(privateConfig).not.toContain("output file");
    expect(() => renderCaddySite({
      domain: "../../etc/passwd",
      appId: "bad",
      appPort: 9100,
      webhookPort: 8787,
    })).toThrow("invalid Caddy domain");
    expect(() => renderCaddySite({
      domain: "example.com",
      appId: "example-com",
      appPort: 9100,
      webhookPort: 8787,
      compression: "gzip\nimport /etc/passwd" as "gzip",
    })).toThrow("invalid Caddy compression");
  });

  test("renders staged and cutover snippets for existing domains", () => {
    expect(renderCaddyWebhookSnippet("example-com", 8787)).toBe(
      "@shibumi_webhook path /hooks/github/example-com\nhandle @shibumi_webhook {\n    reverse_proxy 127.0.0.1:8787\n}\n",
    );
    expect(renderCaddyManagedSnippet("example-com", 8787, 9100)).toContain(
      "handle {\n    reverse_proxy 127.0.0.1:9100",
    );
  });

  test("detects an existing domain and only its upstreams", async () => {
    const config = {
      apps: { http: { servers: { srv0: { routes: [
        { match: [{ host: ["example.com"] }], handle: [{ handler: "subroute", routes: [
          { handle: [{ handler: "encode" }] },
          { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:9001" }] }] },
        ] }] },
        { match: [{ host: ["other.com"] }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }] },
      ] } } } },
    };
    const detected = await detectCaddySite("example.com", async () => Response.json(config));
    expect(detected).toMatchObject({ exists: true, upstreams: ["localhost:9001"], compression: true });
  });
});
