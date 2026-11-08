import { afterEach, describe, expect, it } from 'vitest';

import { evaluatePullRequest, redact, writeRemoteAuth } from '../src/github/app.js';
import { fetchReviewState, type MinimalOctokit } from '../src/github/review-state.js';
import { evaluatePolicy } from '../src/policy/evaluate.js';
import { parsePolicy } from '../src/policy/schema.js';
import { collectProvenance } from '../src/provenance/collect.js';
import { unquoteGitPath } from '../src/provenance/git.js';
import { GitFixture, authorshipNote, lines } from './helpers/git-fixture.js';

const AGENT_TRAILER = 'Co-authored-by: Claude <noreply@anthropic.com>';

const protectAuth = parsePolicy(`
version: 1
rules:
  - name: ai-touches-auth
    when:
      paths: ["src/auth/**"]
      ai_share_gte: 0.5
    action: block
`);

describe('collection edge cases', () => {
  let fixture: GitFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it('attributes a pure rename out of a protected path to the agent that moved it', async () => {
    fixture = await GitFixture.create();
    await fixture.commit('initial', { 'src/auth/session.ts': lines(30, 'session') });
    const base = await fixture.git('rev-parse', 'HEAD');
    await fixture.git('mv', 'src/auth/session.ts', 'src/session.ts');
    await fixture.git('commit', '--quiet', '-m', `refactor: move session\n\n${AGENT_TRAILER}`);

    const provenance = await collectProvenance({ repo: fixture.dir, base, head: 'HEAD' });
    expect(provenance.files).toHaveLength(1);
    const [file] = provenance.files;
    expect(file).toMatchObject({ path: 'src/session.ts', previousPath: 'src/auth/session.ts', addedLines: 0, aiShare: 1 });

    const verdict = evaluatePolicy(protectAuth, provenance, { approvals: [] });
    expect(verdict.status).toBe('fail');
    expect(verdict.results[0]?.files).toEqual(['src/session.ts']);
  });

  it('counts a deletion as AI when the git-ai tracked commit involved an agent', async () => {
    fixture = await GitFixture.create();
    await fixture.commit('initial', { 'src/auth/legacy.ts': lines(12, 'legacy'), 'src/app.ts': lines(2, 'app') });
    const base = await fixture.git('rev-parse', 'HEAD');
    await fixture.git('rm', '--quiet', 'src/auth/legacy.ts');
    const sha = await fixture.commit('chore: drop legacy auth', { 'src/app.ts': lines(4, 'app') });
    await fixture.addNote(
      sha,
      authorshipNote([{ path: 'src/app.ts', entries: ['s_aaaaaaaaaaaaaa::t_bbbbbbbbbbbbbb 3-4'] }], {
        base_commit_sha: sha,
        sessions: { s_aaaaaaaaaaaaaa: { agent_id: { tool: 'codex', id: 'c1', model: 'gpt-5' } } },
      }),
    );

    const provenance = await collectProvenance({ repo: fixture.dir, base, head: 'HEAD' });
    const deleted = provenance.files.find((f) => f.path === 'src/auth/legacy.ts');
    expect(deleted).toMatchObject({ addedLines: 0, deletedLines: 12, confidence: 'exact', aiShare: 1 });
    expect(evaluatePolicy(protectAuth, provenance, { approvals: [] }).status).toBe('fail');
  });

  it('keeps a deletion by a human-only git-ai commit at zero AI share', async () => {
    fixture = await GitFixture.create();
    await fixture.commit('initial', { 'src/auth/legacy.ts': lines(12, 'legacy'), 'src/app.ts': lines(2, 'app') });
    const base = await fixture.git('rev-parse', 'HEAD');
    await fixture.git('rm', '--quiet', 'src/auth/legacy.ts');
    const sha = await fixture.commit('chore: drop legacy auth', { 'src/app.ts': lines(4, 'app') });
    await fixture.addNote(
      sha,
      authorshipNote([{ path: 'src/app.ts', entries: ['h_cccccccccccccc 3-4'] }], {
        base_commit_sha: sha,
        humans: { h_cccccccccccccc: { author: 'Test User <test@example.com>' } },
      }),
    );

    const provenance = await collectProvenance({ repo: fixture.dir, base, head: 'HEAD' });
    expect(provenance.files.find((f) => f.path === 'src/auth/legacy.ts')).toMatchObject({ confidence: 'exact', aiShare: 0 });
    expect(evaluatePolicy(protectAuth, provenance, { approvals: [] }).status).toBe('pass');
  });

  it('handles non-ASCII and quoted file names', async () => {
    fixture = await GitFixture.create();
    await fixture.commit('initial', { 'README.md': '# demo\n' });
    const base = await fixture.git('rev-parse', 'HEAD');
    const name = 'src/auth/café "v2".ts';
    await fixture.commit(`feat: add file\n\n${AGENT_TRAILER}`, { [name]: lines(6, 'x') });

    const provenance = await collectProvenance({ repo: fixture.dir, base, head: 'HEAD' });
    expect(provenance.files).toEqual([expect.objectContaining({ path: name, addedLines: 6, assumedAiLines: 6 })]);
  });

  it('decodes git C-style quoting, including octal UTF-8 bytes', () => {
    expect(unquoteGitPath('"src/caf\\303\\251 \\"v2\\".ts"')).toBe('src/café "v2".ts');
    expect(unquoteGitPath('"tab\\there"')).toBe('tab\there');
    expect(unquoteGitPath('plain.ts')).toBe('plain.ts');
  });
});

describe('review state', () => {
  const reviews = [
    { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: 'old' },
    { user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: 'head' },
    { user: { login: 'carol', type: 'User' }, state: 'APPROVED', commit_id: null },
  ];
  const octokit: MinimalOctokit = {
    request: async (route) => ({ data: route.includes('/reviews') ? reviews : { labels: [] } }),
  };

  it('ignores approvals that were not left on the current head commit', async () => {
    const state = await fetchReviewState(octokit, { owner: 'o', repo: 'r', number: 1 }, { headSha: 'head' });
    expect(state.approvals.map((a) => a.login)).toEqual(['bob']);
  });
});

describe('GitHub App', () => {
  it('reads the policy from the base commit, not the pull request head', async () => {
    const calls: Array<{ route: string; params?: Record<string, unknown> }> = [];
    const octokit = {
      request: async (route: string, params?: Record<string, unknown>) => {
        calls.push({ route, ...(params ? { params } : {}) });
        if (route.startsWith('GET /repos/{owner}/{repo}/contents/')) {
          throw new Error('404');
        }
        return { data: { id: 7 } };
      },
      auth: async () => ({ token: 'unused' }),
    };
    await evaluatePullRequest({
      octokit,
      owner: 'o',
      repo: 'r',
      cloneUrl: 'https://github.com/o/r.git',
      pull: { number: 1, head: { sha: 'headsha', ref: 'feature' }, base: { sha: 'basesha', ref: 'main' } },
      config: { appId: 1, privateKey: '', webhookSecret: '' },
    });
    const contents = calls.find((c) => c.route.startsWith('GET /repos/{owner}/{repo}/contents/'));
    expect(contents?.params?.['ref']).toBe('basesha');
  });

  it('stores the token in the clone config, where lazy blob fetches can use it', async () => {
    const fixture = await GitFixture.create();
    try {
      await writeRemoteAuth(fixture.dir, 'ghs_secretsecretsecret');
      const header = await fixture.git('config', '--get', 'http.extraHeader');
      const encoded = header.replace('Authorization: Basic ', '');
      expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('x-access-token:ghs_secretsecretsecret');
    } finally {
      await fixture.cleanup();
    }
  });

  it('redacts credentials from check run output', () => {
    const token = 'ghs_secretsecretsecret';
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const leaked = `git fetch https://x-access-token:${token}@github.com/o/r.git failed\nAuthorization: Basic ${basic}`;
    const cleaned = redact(leaked, token);
    expect(cleaned).not.toContain(token);
    expect(cleaned).not.toContain(basic);
  });
});
