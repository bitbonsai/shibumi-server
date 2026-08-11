const PART = "[A-Za-z0-9_.-]+";
const SHORTHAND = new RegExp(`^(?:github:)?(${PART})/(${PART})$`);
const URL = new RegExp(`^https://github\\.com/(${PART})/(${PART}?)(?:\\.git)?/?$`);

export function normalizeGitHubRepository(value: string): string | undefined {
  const match = SHORTHAND.exec(value) ?? URL.exec(value);
  return match ? `${match[1]}/${match[2]}` : undefined;
}
