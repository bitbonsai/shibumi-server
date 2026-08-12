const PART = "[A-Za-z0-9_.-]+";
const BRANCH = "[A-Za-z0-9._/-]+";
const SHORTHAND = new RegExp(`^(?:github:)?(${PART})/(${PART})$`);
const URL = new RegExp(`^https://github\\.com/(${PART})/(${PART}?)(?:\\.git)?/?$`);
const TREE_URL = new RegExp(`^https://github\\.com/(${PART})/(${PART})/tree/(${BRANCH})/?$`);

export interface GitHubRepositoryTarget {
  repository: string;
  ref?: string;
}

export function parseGitHubRepositoryTarget(value: string): GitHubRepositoryTarget | undefined {
  const tree = TREE_URL.exec(value);
  if (tree && !tree[3].includes("..") && !tree[3].includes("//") && !tree[3].endsWith("/")) {
    return { repository: `${tree[1]}/${tree[2]}`, ref: `refs/heads/${tree[3]}` };
  }
  const match = SHORTHAND.exec(value) ?? URL.exec(value);
  return match ? { repository: `${match[1]}/${match[2]}` } : undefined;
}

export function normalizeGitHubRepository(value: string): string | undefined {
  return parseGitHubRepositoryTarget(value)?.repository;
}
