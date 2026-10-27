import type { Project } from '../types.js';

export interface SuspectCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

const NO_REPO = 'No repository connected: connect one to get suspect commits.';

export async function suspectCommits(project: Project, sinceIso: string, token: string, fetchImpl: typeof fetch = fetch): Promise<{ text: string; commits: SuspectCommit[] }> {
  if (project.mode !== 'repo' || !project.repoOwner || !project.repoName) return { text: NO_REPO, commits: [] };
  if (!token) return { text: 'Commit lookup failed.', commits: [] };
  const sha = project.baseBranch || 'main';
  const url = `https://api.github.com/repos/${encodeURIComponent(project.repoOwner)}/${encodeURIComponent(project.repoName)}/commits?sha=${encodeURIComponent(sha)}&since=${encodeURIComponent(sinceIso)}&per_page=10`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'perfpilot',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    return { text: 'Commit lookup failed.', commits: [] };
  }
  if (!response.ok) return { text: 'Commit lookup failed.', commits: [] };
  const body = (await response.json()) as Array<{ sha?: string; html_url?: string; commit?: { message?: string; author?: { name?: string; date?: string } } }>;
  const commits = (Array.isArray(body) ? body : []).slice(0, 10).map((row) => {
    const message = (row.commit?.message ?? '').split('\n')[0] ?? '';
    return {
      sha: (row.sha ?? '').slice(0, 7),
      message,
      author: row.commit?.author?.name ?? '',
      date: row.commit?.author?.date ?? '',
      url: row.html_url ?? '',
    };
  }).filter((row) => row.sha);
  if (commits.length === 0) return { text: 'No commits on the base branch since the last healthy check.', commits: [] };
  const text = commits.map((row) => `${row.sha} ${row.message} (${row.author}, ${row.date}) ${row.url}`).join('\n');
  return { text, commits };
}
