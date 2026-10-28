export interface DispatchInput {
  owner: string;
  repo: string;
  ref: string;
  jobId: string;
  callbackUrl: string;
  token: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Directory the GitHub-hosted runner can create. Never a Windows path from the API machine. */
export function actionsRunDir(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error('job id is not a uuid');
  return `runs/${jobId}`;
}

export function actionsTarget(owner: string, repo: string): { owner: string; repo: string } {
  if (!NAME.test(owner) || !NAME.test(repo)) throw new Error('GitHub owner or repo is not allowed');
  return { owner, repo };
}

/** Builds the workflow_dispatch request. The token stays in the header. */
export function dispatchRequest(input: DispatchInput): { url: string; init: RequestInit } {
  const target = actionsTarget(input.owner, input.repo);
  const callback = input.callbackUrl.replace(/\/$/, '');
  if (!callback.startsWith('https://') && !callback.startsWith('http://')) throw new Error('PERFPILOT_URL must be an http(s) URL');
  return {
    url: `https://api.github.com/repos/${target.owner}/${target.repo}/actions/workflows/perfpilot-job.yml/dispatches`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'perfpilot',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: input.ref || 'main',
        inputs: { job_id: input.jobId, callback_url: callback },
      }),
    },
  };
}

export function cancelRequest(owner: string, repo: string, runId: number, token: string): { url: string; init: RequestInit } {
  const target = actionsTarget(owner, repo);
  return {
    url: `https://api.github.com/repos/${target.owner}/${target.repo}/actions/runs/${runId}/cancel`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'perfpilot',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  };
}

export function scrubToken(text: string, token: string): string {
  if (!token) return text.slice(0, 300);
  return text.split(token).join('<redacted>').slice(0, 300);
}
