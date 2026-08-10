const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LATEST_URL = "https://registry.npmjs.org/shibumi-server/latest";
const INSTALL_COMMAND = "curl -fsSL https://shibumistack.dev/install/server | bash";

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

export async function warnIfUpdateAvailable(
  current: string,
  fetcher: Fetcher = fetch,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    const response = await fetcher(LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return;
    const value: unknown = await response.json();
    const latest = value && typeof value === "object" && "version" in value
      ? (value as { version?: unknown }).version
      : undefined;
    if (typeof latest !== "string" || !isNewerVersion(current, latest)) return;
    warn(`Update available: shibumi-server ${current} → ${latest}\nRun: ${INSTALL_COMMAND}`);
  } catch {
    // Update checks never block local commands when the registry is unavailable.
  }
}
