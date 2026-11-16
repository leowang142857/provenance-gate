import { afterEach, describe, expect, it } from 'vitest';

import { evaluatePolicy } from '../src/policy/evaluate.js';
import { parsePolicy } from '../src/policy/schema.js';
import { parseAgentdiffTraces } from '../src/provenance/agentdiff.js';
import { collectProvenance } from '../src/provenance/collect.js';
import { GitFixture, agentdiffTrace, authorshipNote, lines } from './helpers/git-fixture.js';

const SHA = 'a'.repeat(40);
const jsonl = (...records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');

describe('parseAgentdiffTraces', () => {
  it('reads AI and human conversations with their line ranges', () => {
    const traces = parseAgentdiffTraces(
      jsonl(
        agentdiffTrace(SHA, [
          { path: 'src/auth.rs', type: 'ai', ranges: [[17, 20], [30, 30]], modelId: 'anthropic/claude-sonnet-4-6' },
          { path: 'README.md', type: 'human', ranges: [[1, 3]] },
        ]),
      ),
    );
    expect([...traces.keys()]).toEqual([SHA]);
    expect(traces.get(SHA)?.get('src/auth.rs')).toEqual([
      expect.objectContaining({ kind: 'ai', ranges: [{ start: 17, end: 20 }], lineCount: 4, agent: { tool: 'claude', model: 'claude-sonnet-4-6' } }),
      expect.objectContaining({ kind: 'ai', ranges: [{ start: 30, end: 30 }], lineCount: 1 }),
    ]);
    expect(traces.get(SHA)?.get('README.md')).toEqual([expect.objectContaining({ kind: 'human', lineCount: 3 })]);
    expect(traces.get(SHA)?.get('README.md')?.[0]).not.toHaveProperty('agent');
  });

  // Only an explicit "human" is human. The other Agent Trace types involve an agent or cannot rule one out.
  it.each([['mixed'], ['unknown'], ['robot'], [undefined]])('counts contributor type %s as AI', (type) => {
    const record = agentdiffTrace(SHA, [{ path: 'a.ts', type: 'ai', ranges: [[1, 2]] }]) as {
      files: Array<{ conversations: Array<{ contributor: Record<string, unknown> }> }>;
    };
    const contributor = record.files[0]?.conversations[0]?.contributor ?? {};
    if (type === undefined) {
      delete contributor['type'];
    } else {
      contributor['type'] = type;
    }
    expect(parseAgentdiffTraces(jsonl(record)).get(SHA)?.get('a.ts')?.[0]?.kind).toBe('ai');
  });

  it('lets a range override the contributor of its conversation', () => {
    const record = {
      version: '0.1.0',
      id: 't1',
      vcs: { type: 'git', revision: SHA },
      tool: { name: 'cursor' },
      files: [
        {
          path: 'a.ts',
          conversations: [
            {
              contributor: { type: 'human' },
              ranges: [
                { start_line: 1, end_line: 2 },
                { start_line: 3, end_line: 9, contributor: { type: 'ai', model_id: 'openai/gpt-5' } },
              ],
            },
          ],
        },
      ],
    };
    expect(parseAgentdiffTraces(jsonl(record)).get(SHA)?.get('a.ts')).toEqual([
      expect.objectContaining({ kind: 'human', lineCount: 2 }),
      expect.objectContaining({ kind: 'ai', lineCount: 7, agent: { tool: 'cursor', model: 'gpt-5' } }),
    ]);
  });

  it('merges records for the same commit from several files', () => {
    const traces = parseAgentdiffTraces(jsonl(agentdiffTrace(SHA, [{ path: 'a.ts', type: 'human', ranges: [[1, 5]] }])));
    parseAgentdiffTraces(jsonl(agentdiffTrace(SHA, [{ path: 'a.ts', type: 'ai', ranges: [[1, 5]] }])), traces);
    expect(traces.get(SHA)?.get('a.ts')?.map((e) => e.kind)).toEqual(['human', 'ai']);
  });

  it('skips records that are not tied to a git commit', () => {
    const noVcs = { version: '0.1.0', id: 't1', files: [] };
    const otherVcs = { version: '0.1.0', id: 't2', vcs: { type: 'jj', revision: SHA }, files: [] };
    const shortSha = { version: '0.1.0', id: 't3', vcs: { type: 'git', revision: 'abc1234' }, files: [] };
    expect(parseAgentdiffTraces(jsonl(noVcs, otherVcs, shortSha)).size).toBe(0);
  });

  // A record we cannot read might be the one that says "AI", so it is an error, not a skipped line.
  it.each([
    ['a line that is not JSON', '{"version":"0.1.0",', /not valid JSON/],
    ['an unsupported version', JSON.stringify({ version: '1.0.0', vcs: { type: 'git', revision: SHA }, files: [] }), /unsupported version/],
    ['a missing files array', JSON.stringify({ version: '0.1.0', vcs: { type: 'git', revision: SHA } }), /no "files" array/],
    [
      'a descending line range',
      JSON.stringify({
        version: '0.1.0',
        vcs: { type: 'git', revision: SHA },
        files: [{ path: 'a.ts', conversations: [{ contributor: { type: 'ai' }, ranges: [{ start_line: 9, end_line: 3 }] }] }],
      }),
      /invalid line range/,
    ],
  ])('rejects %s', (_name, line, message) => {
    expect(() => parseAgentdiffTraces(`${line}\n`)).toThrow(message);
  });
});

describe('collectProvenance with agentdiff traces', () => {
  // Untracked lines count as human here, so the gate only blocks on what the traces actually say.
  const policy = parsePolicy(`
version: 1
defaults:
  unknown_provenance: treat-as-human
rules:
  - name: ai-touches-auth
    when:
      paths: ["src/auth/**"]
      ai_share_gte: 0.5
    action: block
`);

  let fixture: GitFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  async function createRepo(): Promise<{ repo: GitFixture; base: string }> {
    fixture = await GitFixture.create();
    const base = await fixture.commit('initial', { 'README.md': '# demo\n', 'src/auth/login.ts': lines(2, 'login') });
    await fixture.git('checkout', '--quiet', '-b', 'feature/login');
    return { repo: fixture, base };
  }

  it('attributes surviving lines from the consolidated store', async () => {
    const { repo, base } = await createRepo();
    const sha = await repo.commit('feat(auth): rewrite login', {
      'src/auth/login.ts': lines(12, 'rewritten'),
      'README.md': '# demo\n\nMore words.\n',
    });
    await repo.addAgentdiffTraces([
      agentdiffTrace(sha, [
        { path: 'src/auth/login.ts', type: 'ai', ranges: [[1, 12]], modelId: 'anthropic/claude-sonnet-4-6' },
        { path: 'README.md', type: 'human', ranges: [[2, 3]] },
      ]),
    ]);

    const provenance = await collectProvenance({ repo: repo.dir, base, head: 'HEAD' });
    expect(provenance.commits).toEqual([expect.objectContaining({ sha, source: 'agentdiff', confidence: 'exact' })]);
    expect(provenance.files.find((f) => f.path === 'src/auth/login.ts')).toMatchObject({
      aiLines: 12,
      humanLines: 0,
      unknownLines: 0,
      aiShare: 1,
      confidence: 'exact',
      agents: [{ tool: 'claude', model: 'claude-sonnet-4-6' }],
    });
    expect(provenance.files.find((f) => f.path === 'README.md')).toMatchObject({ aiLines: 0, humanLines: 2, confidence: 'exact' });
    expect(provenance.stats).toEqual({ commits: 1, exact: 1, commitLevel: 0, none: 0 });
    expect(evaluatePolicy(policy, provenance, { approvals: [] }).status).toBe('fail');
  });

  it('reads the per-branch ref a pull request uses before CI consolidates it', async () => {
    const { repo, base } = await createRepo();
    const sha = await repo.commit('feat(auth): rewrite login', { 'src/auth/login.ts': lines(12, 'rewritten') });
    await repo.addAgentdiffTraces(
      [agentdiffTrace(sha, [{ path: 'src/auth/login.ts', type: 'ai', ranges: [[1, 12]] }], 'cursor')],
      'refs/agentdiff/traces/feature%2Flogin',
    );

    const provenance = await collectProvenance({ repo: repo.dir, base, head: 'HEAD' });
    expect(provenance.files[0]).toMatchObject({ aiLines: 12, agents: [{ tool: 'cursor' }] });
    expect(evaluatePolicy(policy, provenance, { approvals: [] }).status).toBe('fail');
  });

  it('only counts lines that survive to the head', async () => {
    const { repo, base } = await createRepo();
    const agent = await repo.commit('feat(auth): rewrite login', { 'src/auth/login.ts': lines(12, 'rewritten') });
    // A human then replaces the last eight lines.
    const human = await repo.commit('fix(auth): harden login', { 'src/auth/login.ts': lines(4, 'rewritten') + lines(8, 'hardened') });
    await repo.addAgentdiffTraces([
      agentdiffTrace(agent, [{ path: 'src/auth/login.ts', type: 'ai', ranges: [[1, 12]] }]),
      agentdiffTrace(human, [{ path: 'src/auth/login.ts', type: 'human', ranges: [[5, 12]] }], 'Test User'),
    ]);

    const provenance = await collectProvenance({ repo: repo.dir, base, head: 'HEAD' });
    expect(provenance.files[0]).toMatchObject({ addedLines: 12, aiLines: 4, humanLines: 8 });
    expect(evaluatePolicy(policy, provenance, { approvals: [] }).status).toBe('pass');
  });

  it('treats a line the trace does not mention as untracked, not as human', async () => {
    const { repo, base } = await createRepo();
    const sha = await repo.commit('feat(auth): rewrite login', { 'src/auth/login.ts': lines(12, 'rewritten') });
    await repo.addAgentdiffTraces([agentdiffTrace(sha, [{ path: 'src/auth/login.ts', type: 'human', ranges: [[1, 4]] }], 'Test User')]);

    const provenance = await collectProvenance({ repo: repo.dir, base, head: 'HEAD' });
    expect(provenance.files[0]).toMatchObject({ humanLines: 4, unknownLines: 8, confidence: 'unknown' });

    const strict = parsePolicy(`
version: 1
rules:
  - name: ai-touches-auth
    when:
      paths: ["src/auth/**"]
      ai_share_gte: 0.5
    action: block
`);
    expect(evaluatePolicy(strict, provenance, { approvals: [] }).status).toBe('fail');
  });

  it('counts a line as AI when either the git-ai log or the agentdiff trace says so', async () => {
    const { repo, base } = await createRepo();
    const sha = await repo.commit('feat(auth): rewrite login', { 'src/auth/login.ts': lines(12, 'rewritten') });
    // git-ai calls the whole file human; agentdiff saw an agent write lines 1-8.
    await repo.addNote(
      sha,
      authorshipNote([{ path: 'src/auth/login.ts', entries: ['h_cccccccccccccc 1-12'] }], {
        base_commit_sha: sha,
        humans: { h_cccccccccccccc: { author: 'Test User <test@example.com>' } },
      }),
    );
    await repo.addAgentdiffTraces([agentdiffTrace(sha, [{ path: 'src/auth/login.ts', type: 'ai', ranges: [[1, 8]] }], 'codex')]);

    const provenance = await collectProvenance({ repo: repo.dir, base, head: 'HEAD' });
    expect(provenance.commits[0]).toMatchObject({ source: 'git-ai', agents: [{ tool: 'codex' }] });
    expect(provenance.files[0]).toMatchObject({ aiLines: 8, humanLines: 4, agents: [{ tool: 'codex' }] });
    expect(evaluatePolicy(policy, provenance, { approvals: [] }).status).toBe('fail');
  });

  it('fails instead of ignoring a trace file it cannot read', async () => {
    const { repo, base } = await createRepo();
    await repo.commit('feat(auth): rewrite login', { 'src/auth/login.ts': lines(12, 'rewritten') });
    await repo.addAgentdiffTraces([{ version: '9.0.0', files: [] }]);
    await expect(collectProvenance({ repo: repo.dir, base, head: 'HEAD' })).rejects.toThrow(/refs\/agentdiff\/meta:traces\.jsonl line 1/);
  });

  it('changes nothing for a repository without agentdiff refs', async () => {
    const { repo, base } = await createRepo();
    await repo.commit('feat(auth): rewrite login', { 'src/auth/login.ts': lines(12, 'rewritten') });
    const provenance = await collectProvenance({ repo: repo.dir, base, head: 'HEAD' });
    expect(provenance.commits[0]).toMatchObject({ source: 'none', confidence: 'unknown' });
    expect(provenance.files[0]).toMatchObject({ unknownLines: 12 });
  });
});
