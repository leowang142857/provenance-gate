/**
 * GitHub App integration.
 *
 * On pull request and review events we:
 *   1. shallow-clone the repository with the installation token, including refs/notes/ai
 *   2. read .provenance-policy.yml from the PR head
 *   3. fetch approvals and labels
 *   4. evaluate the policy and publish a Check Run that can be marked "required" in branch protection
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from '@octokit/app';

import { runCheck } from '../commands/check.js';
import { git } from '../provenance/git.js';
import { parsePolicy } from '../policy/schema.js';
import { summaryLine } from '../report/markdown.js';
import { fetchReviewState, type MinimalOctokit } from './review-state.js';

export const CHECK_NAME = 'provenance-gate';
export const DEFAULT_POLICY_PATH = '.provenance-policy.yml';

export interface AppConfig {
  appId: string | number;
  privateKey: string;
  webhookSecret: string;
  policyPath?: string;
  /** Apply `require.labels` from matched rules to the pull request. */
  applyLabels?: boolean;
}

interface PullRequestPayload {
  number: number;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  labels?: Array<{ name: string }>;
}

interface RepositoryPayload {
  name: string;
  owner: { login: string };
  clone_url: string;
}

export function createApp(config: AppConfig): App {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhooks: { secret: config.webhookSecret },
  });

  const events: Array<
    | 'pull_request.opened'
    | 'pull_request.synchronize'
    | 'pull_request.reopened'
    | 'pull_request.ready_for_review'
    | 'pull_request_review.submitted'
    | 'pull_request_review.dismissed'
  > = [
    'pull_request.opened',
    'pull_request.synchronize',
    'pull_request.reopened',
    'pull_request.ready_for_review',
    'pull_request_review.submitted',
    'pull_request_review.dismissed',
  ];

  app.webhooks.on(events, async ({ octokit, payload }) => {
    const pull = payload.pull_request as unknown as PullRequestPayload;
    const repository = payload.repository as unknown as RepositoryPayload;
    const installationId = payload.installation?.id;
    if (installationId === undefined) {
      return;
    }
    await evaluatePullRequest({
      octokit: octokit as unknown as MinimalOctokit & { auth: (opts: { type: string }) => Promise<unknown> },
      owner: repository.owner.login,
      repo: repository.name,
      cloneUrl: repository.clone_url,
      pull,
      config,
    });
  });

  app.webhooks.onError((error) => {
    process.stderr.write(`webhook handler failed: ${error.message}\n`);
  });

  return app;
}

interface EvaluateInput {
  octokit: MinimalOctokit & { auth: (opts: { type: string }) => Promise<unknown> };
  owner: string;
  repo: string;
  cloneUrl: string;
  pull: PullRequestPayload;
  config: AppConfig;
}

export async function evaluatePullRequest(input: EvaluateInput): Promise<void> {
  const { octokit, owner, repo, pull, config } = input;
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;

  const { data: created } = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: pull.head.sha,
    status: 'in_progress',
  });
  const checkRunId = (created as { id: number }).id;

  const finish = (conclusion: string, title: string, summary: string, text?: string): Promise<unknown> =>
    octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
      owner,
      repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      output: { title, summary, ...(text ? { text: text.slice(0, 60_000) } : {}) },
    });

  const policyText = await readPolicyFromRepo(octokit, owner, repo, pull.head.sha, policyPath);
  if (policyText === null) {
    await finish('neutral', 'No policy found', `Add \`${policyPath}\` to the repository to enable provenance-gate.`);
    return;
  }

  let policy;
  try {
    policy = parsePolicy(policyText);
  } catch (error) {
    await finish('failure', 'Invalid policy', `\`${policyPath}\` could not be parsed:\n\n\`\`\`\n${(error as Error).message}\n\`\`\``);
    return;
  }

  const workdir = await mkdtemp(join(tmpdir(), 'provenance-gate-'));
  try {
    const { token } = (await octokit.auth({ type: 'installation' })) as { token: string };
    const authedUrl = input.cloneUrl.replace('https://', `https://x-access-token:${token}@`);
    await git(workdir, ['init', '--quiet']);
    await git(workdir, ['remote', 'add', 'origin', authedUrl]);
    await git(workdir, ['fetch', '--quiet', '--filter=blob:none', 'origin', pull.base.sha, pull.head.sha]);
    try {
      await git(workdir, ['fetch', '--quiet', 'origin', '+refs/notes/ai:refs/notes/ai']);
    } catch {
      // Repository has no authorship notes yet; commit trailers are the only signal.
    }

    const teams = policy.rules.flatMap((rule) => rule.require?.teams ?? []);
    const review = await fetchReviewState(octokit, { owner, repo, number: pull.number }, { teams, headSha: pull.head.sha });

    const result = await runCheck({
      repo: workdir,
      base: pull.base.sha,
      head: pull.head.sha,
      policyText,
      review,
    });

    if (config.applyLabels && result.verdict.requirements.labels.length > 0) {
      const existing = new Set((pull.labels ?? []).map((l) => l.name));
      const missing = result.verdict.requirements.labels.filter((l) => !existing.has(l));
      if (missing.length > 0) {
        await octokit
          .request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: pull.number,
            labels: missing,
          })
          .catch(() => undefined);
      }
    }

    const conclusion = result.verdict.status === 'fail' ? 'failure' : result.verdict.status === 'warn' ? 'neutral' : 'success';
    await finish(conclusion, `Provenance gate: ${result.verdict.status}`, summaryLine(result.provenance, result.verdict), result.markdown);
  } catch (error) {
    await finish('failure', 'provenance-gate crashed', `\`\`\`\n${(error as Error).message}\n\`\`\``);
    throw error;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function readPolicyFromRepo(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref });
    const file = data as { content?: string; encoding?: string };
    if (!file.content) {
      return null;
    }
    return Buffer.from(file.content, (file.encoding as BufferEncoding | undefined) ?? 'base64').toString('utf8');
  } catch {
    return null;
  }
}
