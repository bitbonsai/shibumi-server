import { describe, expect, test } from "bun:test";
import { checkDomainDns, detectPublicAddresses, type DnsResolver } from "../src/domain";

function resolver(values: { ipv4?: string[]; ipv6?: string[]; nameservers?: string[]; lookup?: string[] }): DnsResolver {
  return {
    async resolve4() { return values.ipv4 ?? []; },
    async resolve6() { return values.ipv6 ?? []; },
    async resolveNs() { return values.nameservers ?? []; },
    lookup: values.lookup ? async () => values.lookup as string[] : undefined,
  };
}

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("domain detection", () => {
  test("recognizes direct DNS pointing to the server", async () => {
    expect(await checkDomainDns("example.com", ["203.0.113.10"], resolver({ ipv4: ["203.0.113.10"] }))).toMatchObject({
      state: "ready",
      addresses: ["203.0.113.10"],
    });
  });

  test("distinguishes missing, elsewhere, and Cloudflare-proxied DNS", async () => {
    expect((await checkDomainDns("example.com", ["203.0.113.10"], resolver({}))).state).toBe("missing");
    expect((await checkDomainDns("example.com", ["203.0.113.10"], resolver({ ipv4: ["198.51.100.2"] }))).state).toBe("elsewhere");
    expect((await checkDomainDns("example.com", ["203.0.113.10"], resolver({
      ipv4: ["104.16.1.1"],
      nameservers: ["ada.ns.cloudflare.com"],
    }))).state).toBe("cloudflare");
  });

  test("retries transient failures and falls back to the system resolver", async () => {
    let attempts = 0;
    const flaky: DnsResolver = {
      async resolve4() {
        attempts += 1;
        if (attempts < 3) throw dnsError("ESERVFAIL");
        return ["104.16.1.1"];
      },
      async resolve6() { return []; },
      async resolveNs() { return ["ada.ns.cloudflare.com"]; },
      retryDelayMs: 0,
    };
    expect((await checkDomainDns("example.com", ["203.0.113.10"], flaky)).state).toBe("cloudflare");
    expect(attempts).toBe(3);

    const fallback: DnsResolver = {
      async resolve4() { throw dnsError("ETIMEOUT"); },
      async resolve6() { throw dnsError("ETIMEOUT"); },
      async resolveNs() { return ["ada.ns.cloudflare.com"]; },
      async lookup() { return ["104.16.1.1"]; },
      retryDelayMs: 0,
    };
    expect((await checkDomainDns("example.com", ["203.0.113.10"], fallback)).state).toBe("cloudflare");
  });

  test("reports resolver failure separately from missing DNS", async () => {
    const unavailable: DnsResolver = {
      async resolve4() { throw dnsError("ETIMEOUT"); },
      async resolve6() { throw dnsError("ESERVFAIL"); },
      async resolveNs() { throw dnsError("ETIMEOUT"); },
      async lookup() { throw dnsError("EAI_AGAIN"); },
      retryDelayMs: 0,
    };
    expect(await checkDomainDns("example.com", ["203.0.113.10"], unavailable)).toMatchObject({
      state: "unknown",
      addresses: [],
      errors: ["A: ETIMEOUT", "AAAA: ESERVFAIL", "NS: ETIMEOUT", "system resolver: EAI_AGAIN"],
    });
  });

  test("keeps only valid public-address responses", async () => {
    const responses = new Map([
      ["https://api.ipify.org", "203.0.113.10"],
      ["https://api6.ipify.org", "not-an-ip"],
    ]);
    expect(await detectPublicAddresses(async (input) => new Response(responses.get(String(input)), { status: 200 }))).toEqual(["203.0.113.10"]);
  });
});
