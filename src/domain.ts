import { lookup, resolve4, resolve6, resolveNs } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsState = "ready" | "cloudflare" | "missing" | "elsewhere" | "resolved" | "unknown";

export interface DomainDnsStatus {
  domain: string;
  state: DnsState;
  addresses: string[];
  expectedAddresses: string[];
  nameservers: string[];
  errors: string[];
}

export interface DnsResolver {
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
  resolveNs(domain: string): Promise<string[]>;
  lookup?(domain: string): Promise<string[]>;
  retryDelayMs?: number;
}

const systemResolver: DnsResolver = {
  resolve4: (domain) => resolve4(domain),
  resolve6: (domain) => resolve6(domain),
  resolveNs: (domain) => resolveNs(domain),
  lookup: async (domain) => (await lookup(domain, { all: true })).map(({ address }) => address),
  retryDelayMs: 120,
};

interface QueryResult {
  records: string[];
  confirmedEmpty: boolean;
  error?: string;
}

const EMPTY_CODES = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);
const TRANSIENT_CODES = new Set(["EAI_AGAIN", "ECONNREFUSED", "ESERVFAIL", "ETIMEOUT", "SERVFAIL", "TIMEOUT"]);

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

async function queryRecords(
  label: string,
  operation: () => Promise<string[]>,
  retryDelayMs: number,
): Promise<QueryResult> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const records = await operation();
      return { records, confirmedEmpty: records.length === 0 };
    } catch (error) {
      const code = errorCode(error);
      if (EMPTY_CODES.has(code)) return { records: [], confirmedEmpty: true };
      if (attempt === 3 || !TRANSIENT_CODES.has(code)) {
        return { records: [], confirmedEmpty: false, error: `${label}: ${code}` };
      }
      await wait(retryDelayMs * attempt);
    }
  }
  return { records: [], confirmedEmpty: false, error: `${label}: lookup failed` };
}

async function nameservers(domain: string, resolver: DnsResolver): Promise<QueryResult> {
  const labels = domain.split(".");
  const errors: string[] = [];
  for (let offset = 0; offset < labels.length - 1; offset += 1) {
    const name = labels.slice(offset).join(".");
    const result = await queryRecords("NS", () => resolver.resolveNs(name), resolver.retryDelayMs ?? 0);
    if (result.records.length > 0) {
      return { records: result.records.map((value) => value.toLowerCase()), confirmedEmpty: false };
    }
    if (result.error) errors.push(result.error);
  }
  return { records: [], confirmedEmpty: errors.length === 0, error: errors[0] };
}

export async function checkDomainDns(
  domain: string,
  expectedAddresses: string[],
  resolver: DnsResolver = systemResolver,
): Promise<DomainDnsStatus> {
  const delay = resolver.retryDelayMs ?? 0;
  const [ipv4, ipv6, ns] = await Promise.all([
    queryRecords("A", () => resolver.resolve4(domain), delay),
    queryRecords("AAAA", () => resolver.resolve6(domain), delay),
    nameservers(domain, resolver),
  ]);
  let addresses = [...new Set([...ipv4.records, ...ipv6.records])];
  let fallback: QueryResult | undefined;
  if (addresses.length === 0 && resolver.lookup) {
    fallback = await queryRecords("system resolver", () => resolver.lookup!(domain), delay);
    addresses = [...new Set(fallback.records)];
  }

  const expected = [...new Set(expectedAddresses.filter((value) => isIP(value) !== 0))];
  const cloudflare = ns.records.some((value) => value === "cloudflare.com" || value.endsWith(".cloudflare.com"));
  const lookupFailed = addresses.length === 0 && (
    (!ipv4.confirmedEmpty || !ipv6.confirmedEmpty) && (!fallback || !fallback.confirmedEmpty)
  );
  let state: DnsState;
  if (lookupFailed) state = "unknown";
  else if (addresses.length === 0) state = "missing";
  else if (expected.some((value) => addresses.includes(value))) state = "ready";
  else if (cloudflare) state = "cloudflare";
  else if (expected.length === 0) state = "resolved";
  else state = "elsewhere";

  return {
    domain,
    state,
    addresses,
    expectedAddresses: expected,
    nameservers: ns.records,
    errors: [...new Set([ipv4.error, ipv6.error, ns.error, fallback?.error].filter((value): value is string => Boolean(value)))],
  };
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
