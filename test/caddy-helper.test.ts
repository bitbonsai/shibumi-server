import { describe, expect, test } from "bun:test";
import { findSiteBlock, preserveSite, refreshManagedUpstream, removeRouteImport, rewriteSite } from "../src/caddy-helper";

const source = `{
    email admin@example.com
}

other.example.com {
    reverse_proxy localhost:3000
}

example.com {
    encode gzip
    header {
        Content-Security-Policy "default-src 'self';
img-src 'self' data:"
    }
    reverse_proxy localhost:9001
}
`;

describe("Caddy source changes", () => {
  test("finds a top-level domain block with multiline quoted values", () => {
    expect(findSiteBlock(source, "example.com")).toEqual({ start: 8, end: 15 });
    expect(findSiteBlock(source, "missing.example")).toBeUndefined();
    expect(findSiteBlock("www.example.com {\n    redir https://example.com{uri} permanent\n}\n\nnext.example.com {\n}\n", "next.example.com"))
      .toEqual({ start: 4, end: 5 });
  });

  test("preserves existing config and inserts one route import", () => {
    const changed = preserveSite(source, "example.com", "/etc/caddy/sites.d/example-com.routes");
    expect(changed).toContain("example.com {\n    import /etc/caddy/sites.d/example-com.routes\n    encode gzip");
    expect(preserveSite(changed, "example.com", "/etc/caddy/sites.d/example-com.routes")).toBe(changed);
    expect(changed).toContain("Content-Security-Policy");
  });

  test("removes only the selected Shibumi route import", () => {
    const preserved = preserveSite(source, "example.com", "/etc/caddy/sites.d/example-com.routes");
    const changed = removeRouteImport(preserved, "example-com");
    expect(changed).toBe(source);
    expect(changed).toContain("other.example.com");
  });

  test("rewrites only the selected site and enables managed fragments", () => {
    const changed = rewriteSite(source, "example.com");
    expect(changed).not.toContain("example.com {\n    encode gzip");
    expect(changed).toContain("other.example.com");
    expect(changed).toContain("import /etc/caddy/sites.d/*.caddy");
  });

  test("adds retry budget only to exact managed app upstream", () => {
    const managed = "handle {\n    reverse_proxy 127.0.0.1:9100\n}\n";
    const changed = refreshManagedUpstream(managed, 9100);
    expect(changed).toBe("handle {\n    reverse_proxy 127.0.0.1:9100 {\n        lb_try_duration 20000ms\n    }\n}\n");
    expect(refreshManagedUpstream(changed, 9100)).toBe(changed);
    expect(refreshManagedUpstream(changed.replace("20000ms", "5000ms"), 9100)).toBe(changed);
    expect(() => refreshManagedUpstream("reverse_proxy localhost:9100\n", 9100)).toThrow("could not be identified safely");
    expect(() => refreshManagedUpstream("reverse_proxy 127.0.0.1:9100 {\n    header_up X-Test value\n}\n", 9100)).toThrow("unexpected options");
  });
});
