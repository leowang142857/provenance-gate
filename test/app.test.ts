import { describe, expect, it } from 'vitest';

import { evaluatePullRequest } from '../src/github/app.js';

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
