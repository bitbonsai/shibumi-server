import { describe, expect, test } from "bun:test";
import { checkDomainDns, detectPublicAddresses, type DnsResolver } from "../src/domain";

function resolver(values: { ipv4?: string[]; ipv6?: string[]; nameservers?: string[] }): DnsResolver {
  return {
    async resolve4() { return values.ipv4 ?? []; },
    async resolve6() { return values.ipv6 ?? []; },
    async resolveNs() { return values.nameservers ?? []; },
  };
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

  test("keeps only valid public-address responses", async () => {
    const responses = new Map([
      ["https://api.ipify.org", "203.0.113.10"],
      ["https://api6.ipify.org", "not-an-ip"],
    ]);
    expect(await detectPublicAddresses(async (input) => new Response(responses.get(String(input)), { status: 200 }))).toEqual(["203.0.113.10"]);
  });
});
