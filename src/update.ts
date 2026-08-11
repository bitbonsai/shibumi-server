const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LATEST_URL = "https://registry.npmjs.org/shibumi-server/latest";
const UPDATE_COMMAND = "shibumi-server update";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function parts(version: string): number[] | undefined {
  const match = VERSION.exec(version);
  return match?.slice(1).map(Number);
}

export function isNewerVersion(current: string, candidate: string): boolean {
  const currentParts = parts(current);
  const candidateParts = parts(candidate);
  if (!currentParts || !candidateParts) return false;
  for (let index = 0; index < currentParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
  }
  return false;
}

async function latestVersion(fetcher: Fetcher, timeoutMs: number): Promise<string> {
  const response = await fetcher(LATEST_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const value: unknown = await response.json();
  const latest = value && typeof value === "object" && "version" in value
    ? (value as { version?: unknown }).version
    : undefined;
  if (typeof latest !== "string" || !VERSION.test(latest)) throw new Error("npm registry returned an invalid release version");
  return latest;
}

export async function updateToLatest(
  current: string,
  install: (version: string) => Promise<number>,
  fetcher: Fetcher = fetch,
): Promise<{ updated: boolean; version: string }> {
  const latest = await latestVersion(fetcher, 10_000);
  if (!isNewerVersion(current, latest)) return { updated: false, version: current };
  if (await install(latest) !== 0) throw new Error(`shibumi-server ${latest} installation failed`);
  return { updated: true, version: latest };
}

export async function warnIfUpdateAvailable(
  current: string,
  fetcher: Fetcher = fetch,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    const latest = await latestVersion(fetcher, 1_500);
    if (isNewerVersion(current, latest)) warn(`Update available: shibumi-server ${current} → ${latest}\nRun: ${UPDATE_COMMAND}`);
  } catch {
    // Update checks never block local commands when the registry is unavailable.
  }
}
