import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { evaluatePullRequest } from '../src/github/app.js';
import { GitFixture, authorshipNote, lines } from './helpers/git-fixture.js';

const execFileAsync = promisify(execFile);

interface CheckRunUpdate {
  conclusion: string;
  title: string;
  summary: string;
}

const TOKEN = 'ghs_testtesttesttest';

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * An Octokit stand-in that records every completed Check Run. `contents` produces the body of the
 * contents API response for the policy file, or throws the way Octokit does on an HTTP error.
 */
function fakeOctokit(contents: () => unknown) {
  const updates: CheckRunUpdate[] = [];
  const octokit = {
    request: async (route: string, params?: Record<string, unknown>) => {
      if (route.startsWith('POST /repos/{owner}/{repo}/check-runs')) {
        return { data: { id: 7 } };
      }
      if (route.startsWith('PATCH /repos/{owner}/{repo}/check-runs/')) {
        const output = params?.['output'] as { title: string; summary: string };
        updates.push({ conclusion: String(params?.['conclusion']), title: output.title, summary: output.summary });
        return { data: {} };
      }
      if (route.startsWith('GET /repos/{owner}/{repo}/contents/')) {
        return { data: contents() };
      }
      if (route.includes('/reviews')) {
        return { data: [] };
      }
      return { data: { labels: [] } };
    },
    auth: async () => ({ token: TOKEN }),
  };
  return { octokit, updates };
}

describe('GitHub App policy lookup', () => {
  const evaluate = (octokit: ReturnType<typeof fakeOctokit>['octokit']): Promise<void> =>
    evaluatePullRequest({
      octokit,
      owner: 'o',
      repo: 'r',
      cloneUrl: 'https://github.com/o/r.git',
      pull: { number: 1, head: { sha: 'headsha', ref: 'feature' }, base: { sha: 'basesha', ref: 'main' } },
      config: { appId: 1, privateKey: '', webhookSecret: '' },
    });

  it('reports a neutral check when the base commit has no policy file', async () => {
    const { octokit, updates } = fakeOctokit(() => {
      throw httpError(404, 'Not Found');
    });
    await evaluate(octokit);
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'neutral', title: 'No policy found' })]);
  });

  // GitHub treats a neutral required check as passing, so "could not read" must never look like "no policy".
  it.each([
    [500, 'Internal Server Error'],
    [503, 'Service Unavailable'],
    [403, 'Resource not accessible by integration'],
  ])('fails the check when reading the policy returns HTTP %i', async (status, message) => {
    const { octokit, updates } = fakeOctokit(() => {
      throw httpError(status, message);
    });
    await expect(evaluate(octokit)).rejects.toThrow(message);
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'failure', title: 'Could not read policy' })]);
    expect(updates[0]?.summary).toContain(message);
  });

  it('fails the check when the policy cannot be read for a reason that is not an HTTP status', async () => {
    const { octokit, updates } = fakeOctokit(() => {
      throw new Error('socket hang up');
    });
    await expect(evaluate(octokit)).rejects.toThrow('socket hang up');
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'failure', title: 'Could not read policy' })]);
  });

  it('fails the check when the contents API omits the content (files over 1 MB)', async () => {
    const { octokit, updates } = fakeOctokit(() => ({ type: 'file', size: 2_000_000, encoding: 'none', content: '' }));
    await expect(evaluate(octokit)).rejects.toThrow(/without content/);
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'failure', title: 'Could not read policy' })]);
  });

  it('fails the check when the policy path is not a regular file', async () => {
    const { octokit, updates } = fakeOctokit(() => [{ type: 'file', name: 'nested.yml' }]);
    await expect(evaluate(octokit)).rejects.toThrow(/not a regular file/);
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'failure', title: 'Could not read policy' })]);
  });
});

/** The contents API response for a policy file. */
function policyFile(yaml: string): () => unknown {
  return () => ({ type: 'file', encoding: 'base64', content: Buffer.from(yaml, 'utf8').toString('base64') });
}

/**
 * Runs `run` with a `git` on PATH that refuses to talk to the remote about refs/notes/ai, the way a
 * network or permission error would, and behaves normally for everything else.
 */
async function withUnreachableNotes<T>(run: () => Promise<T>): Promise<T> {
  const realGit = (await execFileAsync('sh', ['-c', 'command -v git'])).stdout.trim();
  const bin = await mkdtemp(join(tmpdir(), 'provenance-gate-bin-'));
  const wrapper = join(bin, 'git');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      'case "$1 $*" in',
      '  "fetch "*refs/notes/ai*|"ls-remote "*refs/notes/ai*)',
      '    echo "fatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 403" >&2',
      '    exit 128 ;;',
      'esac',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(wrapper, 0o755);
  const originalPath = process.env['PATH'] ?? '';
  process.env['PATH'] = `${bin}${delimiter}${originalPath}`;
  try {
    return await run();
  } finally {
    process.env['PATH'] = originalPath;
    await rm(bin, { recursive: true, force: true });
  }
}

describe('GitHub App authorship notes', () => {
  // Untracked commits count as human here, so the gate only blocks when it actually sees the agent's
  // authorship log. Losing the notes silently would turn a blocked change into a passing one.
  const policy = `
version: 1
defaults:
  unknown_provenance: treat-as-human
rules:
  - name: ai-touches-auth
    when:
      paths: ["src/auth/**"]
      ai_share_gte: 0.5
    action: block
`;

  let remote: GitFixture | undefined;

  afterEach(async () => {
    await remote?.cleanup();
    remote = undefined;
  });

  /** A repository standing in for github.com: a base commit and a pull request head written by an agent. */
  async function createRemote(options: { withNotes: boolean }): Promise<{ dir: string; base: string; head: string }> {
    remote = await GitFixture.create();
    await remote.git('config', 'uploadpack.allowFilter', 'true');
    await remote.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    const base = await remote.commit('initial', { 'README.md': '# demo\n', 'src/auth/login.ts': lines(2, 'login') });
    await remote.git('checkout', '--quiet', '-b', 'feature');
    const head = await remote.commit('feat(auth): rewrite login', { 'src/auth/login.ts': lines(12, 'rewritten') });
    if (options.withNotes) {
      await remote.addNote(
        head,
        authorshipNote([{ path: 'src/auth/login.ts', entries: ['s_aaaaaaaaaaaaaa::t_bbbbbbbbbbbbbb 1-12'] }], {
          base_commit_sha: head,
          sessions: { s_aaaaaaaaaaaaaa: { agent_id: { tool: 'codex', id: 'c1', model: 'gpt-5' } } },
        }),
      );
    }
    return { dir: remote.dir, base, head };
  }

  const evaluate = (
    octokit: ReturnType<typeof fakeOctokit>['octokit'],
    repo: { dir: string; base: string; head: string },
  ): Promise<void> =>
    evaluatePullRequest({
      octokit,
      owner: 'o',
      repo: 'r',
      cloneUrl: repo.dir,
      pull: { number: 1, head: { sha: repo.head, ref: 'feature' }, base: { sha: repo.base, ref: 'main' } },
      config: { appId: 1, privateKey: '', webhookSecret: '' },
    });

  it('fetches the notes and applies line-level attribution', async () => {
    const repo = await createRemote({ withNotes: true });
    const { octokit, updates } = fakeOctokit(policyFile(policy));
    await evaluate(octokit, repo);
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'failure', title: 'Provenance gate: fail' })]);
    expect(updates[0]?.summary).toContain('codex/gpt-5');
  });

  it('evaluates with commit trailers only when the remote has no notes ref', async () => {
    const repo = await createRemote({ withNotes: false });
    const { octokit, updates } = fakeOctokit(policyFile(policy));
    await evaluate(octokit, repo);
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'success', title: 'Provenance gate: pass' })]);
  });

  it('fails the check when the notes exist but cannot be fetched', async () => {
    const repo = await createRemote({ withNotes: true });
    const { octokit, updates } = fakeOctokit(policyFile(policy));
    await withUnreachableNotes(async () => {
      await expect(evaluate(octokit, repo)).rejects.toThrow(/403/);
    });
    expect(updates).toEqual([expect.objectContaining({ conclusion: 'failure', title: 'provenance-gate crashed' })]);
    expect(updates[0]?.summary).toContain('403');
    expect(updates[0]?.summary).not.toContain(TOKEN);
  });
});
