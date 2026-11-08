/**
 * Pulls the review state of a pull request from the GitHub REST API into the
 * shape the policy evaluator expects. Works with any Octokit-compatible client
 * (installation token in the App, GITHUB_TOKEN in Actions, a PAT locally).
 */
import type { Approval, ReviewState } from '../policy/evaluate.js';

export interface MinimalOctokit {
  request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

interface ReviewRecord {
  user: { login: string; type: string } | null;
  state: string;
  submitted_at?: string | null;
  commit_id?: string | null;
}

interface IssueLabel {
  name: string;
}

export interface FetchReviewStateOptions {
  /** Team slugs referenced by the policy. Membership is resolved only for these. */
  teams?: string[];
  /** When set, only approvals submitted for this head SHA count (GitHub's "dismiss stale reviews" semantics). */
  headSha?: string;
}

export async function fetchReviewState(
  octokit: MinimalOctokit,
  pull: PullRef,
  options: FetchReviewStateOptions = {},
): Promise<ReviewState> {
  const reviews = (await paginate<ReviewRecord>(octokit, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner: pull.owner,
    repo: pull.repo,
    pull_number: pull.number,
    per_page: 100,
  })) as ReviewRecord[];

  // Latest non-comment review per user decides that user's state.
  const latest = new Map<string, ReviewRecord>();
  for (const review of reviews) {
    if (!review.user || review.state === 'COMMENTED' || review.state === 'PENDING') {
      continue;
    }
    latest.set(review.user.login, review);
  }

  const approvals: Approval[] = [];
  for (const review of latest.values()) {
    if (review.state !== 'APPROVED' || !review.user) {
      continue;
    }
    if (options.headSha && review.commit_id && review.commit_id !== options.headSha) {
      continue;
    }
    const approval: Approval = { login: review.user.login, isBot: review.user.type === 'Bot' };
    if (options.teams && options.teams.length > 0) {
      approval.teams = await resolveTeams(octokit, pull.owner, review.user.login, options.teams);
    }
    approvals.push(approval);
  }

  const { data: issue } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner: pull.owner,
    repo: pull.repo,
    issue_number: pull.number,
  });
  const labels = ((issue as { labels?: Array<IssueLabel | string> }).labels ?? []).map((l) =>
    typeof l === 'string' ? l : l.name,
  );

  return { approvals, labels };
}

async function resolveTeams(octokit: MinimalOctokit, org: string, login: string, teams: string[]): Promise<string[]> {
  const member: string[] = [];
  for (const team of teams) {
    const slug = team.includes('/') ? team.slice(team.lastIndexOf('/') + 1) : team;
    try {
      const { data } = await octokit.request('GET /orgs/{org}/teams/{team_slug}/memberships/{username}', {
        org,
        team_slug: slug,
        username: login,
      });
      if ((data as { state?: string }).state === 'active') {
        member.push(slug);
      }
    } catch {
      // 404 means not a member (or no permission to read the team); either way, not counted.
    }
  }
  return member;
}

async function paginate<T>(octokit: MinimalOctokit, route: string, params: Record<string, unknown>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page += 1) {
    const { data } = await octokit.request(route, { ...params, page });
    const items = data as T[];
    all.push(...items);
    if (items.length < Number(params['per_page'] ?? 30)) {
      return all;
    }
  }
}
