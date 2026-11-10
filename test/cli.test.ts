import { afterEach, describe, expect, it } from 'vitest';

import type { MinimalOctokit } from '../src/github/review-state.js';
import { createProgram, type CliIo } from '../src/program.js';
import { GitFixture, lines } from './helpers/git-fixture.js';

const AGENT_TRAILER = 'Co-authored-by: Claude <noreply@anthropic.com>';
const POLICY_PATH = '.provenance-policy.yml';

const BLOCK_AI_IN_AUTH = `version: 1
rules:
  - name: ai-touches-auth
    when:
      paths: ["src/auth/**"]
      ai_share_gte: 0.5
    action: block
`;

const WARN_ONLY = BLOCK_AI_IN_AUTH.replace('action: block', 'action: warn');

const AI_IN_AUTH_NEEDS_APPROVAL = `version: 1
rules:
  - name: ai-touches-auth
    when:
      paths: ["src/auth/**"]
      ai_share_gte: 0.5
    require:
      human_approvals: 1
`;

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

/** Runs the real command definitions in-process, with output and the exit code captured. */
async function runCli(args: string[], overrides: Partial<CliIo> = {}): Promise<CliRun> {
  const run: CliRun = { stdout: '', stderr: '', exitCode: undefined };
  const program = createProgram({
    stdout: (text) => {
      run.stdout += text;
    },
    stderr: (text) => {
      run.stderr += text;
    },
    setExitCode: (code) => {
      run.exitCode = code;
    },
    env: {},
    createOctokit: async () => {
      throw new Error('this test must not reach GitHub');
    },
    ...overrides,
  });
  await program.parseAsync(args, { from: 'user' });
  return run;
}

describe('provenance-gate check', () => {
  let fixture: GitFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  /** A repository whose base commit carries `policy` and a small auth module. Returns the base SHA. */
  async function createRepo(policy: string): Promise<{ repo: GitFixture; base: string }> {
    fixture = await GitFixture.create();
    const base = await fixture.commit('initial', { [POLICY_PATH]: policy, 'src/auth/login.ts': lines(3, 'login') });
    await fixture.git('checkout', '--quiet', '-b', 'feature');
    return { repo: fixture, base };
  }

  describe('--policy-ref', () => {
    it('keeps enforcing the base policy after the pull request deletes the policy file', async () => {
      const { repo, base } = await createRepo(BLOCK_AI_IN_AUTH);
      await repo.git('rm', '--quiet', POLICY_PATH);
      await repo.commit(`feat(auth): rewrite login\n\n${AGENT_TRAILER}`, { 'src/auth/login.ts': lines(20, 'rewritten') });

      const run = await runCli(['check', '-C', repo.dir, '--base', base, '--head', 'HEAD', '--policy-ref', base]);
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toContain('## Provenance gate: FAIL');
      expect(run.stdout).toContain('ai-touches-auth');

      // Without the flag the CLI looks at the checkout, where the pull request removed the rules.
      await expect(runCli(['check', '-C', repo.dir, '--base', base, '--head', 'HEAD'])).rejects.toThrow(/ENOENT/);
    });

    it('keeps enforcing the base policy after the pull request weakens it', async () => {
      const { repo, base } = await createRepo(BLOCK_AI_IN_AUTH);
      await repo.commit(`feat(auth): rewrite login\n\n${AGENT_TRAILER}`, {
        [POLICY_PATH]: WARN_ONLY,
        'src/auth/login.ts': lines(20, 'rewritten'),
      });

      const pinned = await runCli(['check', '-C', repo.dir, '--base', base, '--head', 'HEAD', '--policy-ref', base]);
      expect(pinned.exitCode).toBe(1);
      expect(pinned.stdout).toContain('## Provenance gate: FAIL');

      // The same change judged by its own copy of the policy gets away with a warning.
      const selfJudged = await runCli(['check', '-C', repo.dir, '--base', base, '--head', 'HEAD']);
      expect(selfJudged.exitCode).toBe(0);
      expect(selfJudged.stdout).toContain('## Provenance gate: WARN');
    });
  });

  describe('--github', () => {
    interface Review {
      user: { login: string; type: string };
      state: string;
      commit_id: string;
    }

    function fakeGitHub(reviews: Review[]) {
      const requests: Array<{ route: string; params: Record<string, unknown> | undefined }> = [];
      const tokens: string[] = [];
      const octokit: MinimalOctokit = {
        request: async (route, params) => {
          requests.push({ route, params });
          return { data: route.includes('/reviews') ? reviews : { labels: [] } };
        },
      };
      const io: Partial<CliIo> = {
        env: { GITHUB_TOKEN: 'test-token' },
        createOctokit: async (token) => {
          tokens.push(token);
          return octokit;
        },
      };
      return { io, requests, tokens };
    }

    const approval = (login: string, commit: string): Review => ({
      user: { login, type: 'User' },
      state: 'APPROVED',
      commit_id: commit,
    });

    /** Two agent commits on the feature branch; an approval on the first one is stale once the second lands. */
    async function createPullRequest(): Promise<{ args: string[]; stale: string; head: string }> {
      const { repo, base } = await createRepo(AI_IN_AUTH_NEEDS_APPROVAL);
      const stale = await repo.commit(`feat(auth): rewrite login\n\n${AGENT_TRAILER}`, {
        'src/auth/login.ts': lines(20, 'rewritten'),
      });
      const head = await repo.commit(`feat(auth): add a backdoor\n\n${AGENT_TRAILER}`, {
        'src/auth/login.ts': lines(30, 'rewritten'),
      });
      // --head is a symbolic ref on purpose: the CLI has to resolve it before filtering reviews.
      const args = ['check', '-C', repo.dir, '--base', base, '--head', 'feature', '--policy-ref', base, '--github', 'o/r#7', '--json'];
      return { args, stale, head };
    }

    it('does not count an approval left on an earlier commit of the pull request', async () => {
      const { args, stale } = await createPullRequest();
      const github = fakeGitHub([approval('alice', stale)]);

      const run = await runCli(args, github.io);
      expect(run.exitCode).toBe(1);
      const { verdict } = JSON.parse(run.stdout) as { verdict: { status: string; humanApprovalCount: number } };
      expect(verdict).toMatchObject({ status: 'fail', humanApprovalCount: 0 });

      expect(github.tokens).toEqual(['test-token']);
      const reviews = github.requests.find((r) => r.route.includes('/reviews'));
      expect(reviews?.params).toMatchObject({ owner: 'o', repo: 'r', pull_number: 7 });
    });

    it('counts an approval left on the head commit', async () => {
      const { args, head } = await createPullRequest();
      const github = fakeGitHub([approval('alice', head)]);

      const run = await runCli(args, github.io);
      expect(run.exitCode).toBe(0);
      const { verdict } = JSON.parse(run.stdout) as { verdict: { status: string; humanApprovalCount: number } };
      expect(verdict).toMatchObject({ status: 'pass', humanApprovalCount: 1 });
    });

    it('refuses to run without a token instead of evaluating with no approvals', async () => {
      const { args } = await createPullRequest();
      await expect(runCli(args, { env: {} })).rejects.toThrow(/GITHUB_TOKEN/);
    });
  });
});
