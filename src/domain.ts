import { resolve4, resolve6, resolveNs } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsState = "ready" | "cloudflare" | "missing" | "elsewhere" | "resolved";

export interface DomainDnsStatus {
  domain: string;
  state: DnsState;
  addresses: string[];
  expectedAddresses: string[];
  nameservers: string[];
}

export interface DnsResolver {
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
  resolveNs(domain: string): Promise<string[]>;
}

const systemResolver: DnsResolver = {
  resolve4: (domain) => resolve4(domain),
  resolve6: (domain) => resolve6(domain),
  resolveNs: (domain) => resolveNs(domain),
};

async function optional<T>(operation: Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation;
  } catch {
    return fallback;
  }
}

async function nameservers(domain: string, resolver: DnsResolver): Promise<string[]> {
  const labels = domain.split(".");
  for (let offset = 0; offset < labels.length - 1; offset += 1) {
    const values = await optional(resolver.resolveNs(labels.slice(offset).join(".")), []);
    if (values.length > 0) return values.map((value) => value.toLowerCase());
  }
  return [];
}

export async function checkDomainDns(
  domain: string,
  expectedAddresses: string[],
  resolver: DnsResolver = systemResolver,
): Promise<DomainDnsStatus> {
  const [ipv4, ipv6, ns] = await Promise.all([
    optional(resolver.resolve4(domain), []),
    optional(resolver.resolve6(domain), []),
    nameservers(domain, resolver),
  ]);
  const addresses = [...new Set([...ipv4, ...ipv6])];
  const expected = [...new Set(expectedAddresses.filter((value) => isIP(value) !== 0))];
  const cloudflare = ns.some((value) => value === "cloudflare.com" || value.endsWith(".cloudflare.com"));
  let state: DnsState;
  if (addresses.length === 0) state = "missing";
  else if (expected.some((value) => addresses.includes(value))) state = "ready";
  else if (cloudflare) state = "cloudflare";
  else if (expected.length === 0) state = "resolved";
  else state = "elsewhere";
  return { domain, state, addresses, expectedAddresses: expected, nameservers: ns };
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function detectPublicAddresses(fetcher: Fetcher = fetch): Promise<string[]> {
  const endpoints = ["https://api.ipify.org", "https://api6.ipify.org"];
  const values = await Promise.all(endpoints.map(async (url) => {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) return undefined;
      const value = (await response.text()).trim();
      return isIP(value) === 0 ? undefined : value;
    } catch {
      return undefined;
    }
  }));
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}
