import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCheck } from '../src/commands/check.js';
import { collectProvenance } from '../src/provenance/collect.js';
import { GitFixture, authorshipNote, lines } from './helpers/git-fixture.js';

describe('collectProvenance against a real repository', () => {
  let fixture: GitFixture;
  let examplePolicy: string;

  beforeAll(async () => {
    fixture = await GitFixture.create();
    examplePolicy = await readFile(resolve(__dirname, '..', 'policies', 'example.yml'), 'utf8');

    await fixture.commit('initial', {
      'README.md': '# demo\n',
      'src/auth/login.ts': lines(5, 'human'),
      'src/util.ts': lines(3, 'util'),
    });
    await fixture.git('checkout', '--quiet', '-b', 'feature');

    // Commit A: agent rewrote login.ts (lines 1-20 AI, 21-25 human) and added a migration. Exact attribution via git-ai note.
    const a = await fixture.commit('feat(auth): rewrite login flow', {
      'src/auth/login.ts': lines(25, 'new'),
      'migrations/001_users.sql': lines(10, 'sql'),
    });
    await fixture.addNote(
      a,
      authorshipNote(
        [
          { path: 'src/auth/login.ts', entries: ['s_aaaaaaaaaaaaaa::t_bbbbbbbbbbbbbb 1-20', 'h_cccccccccccccc 21-25'] },
          { path: 'migrations/001_users.sql', entries: ['s_aaaaaaaaaaaaaa::t_dddddddddddddd 1-10'] },
        ],
        {
          base_commit_sha: a,
          sessions: {
            s_aaaaaaaaaaaaaa: { agent_id: { tool: 'claude', id: 'conv1', model: 'claude-opus-4-1' }, human_author: 'dev@example.com' },
          },
          humans: { h_cccccccccccccc: { author: 'Test User <test@example.com>' } },
        },
      ),
    );

    // Commit B: commit-level signal only (Cursor trailer), touches util.ts.
    await fixture.commit('chore: tidy util\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', {
      'src/util.ts': lines(8, 'util'),
    });

    // Commit C: no provenance at all, touches README.
    await fixture.commit('docs: expand readme', { 'README.md': '# demo\n\nMore words.\n' });
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('aggregates line-level, commit-level and missing provenance per file', async () => {
    const prov = await collectProvenance({ repo: fixture.dir, base: 'main', head: 'feature' });

    expect(prov.stats).toEqual({ commits: 3, exact: 1, commitLevel: 1, none: 1 });
    expect(prov.commits.map((c) => c.source)).toEqual(['git-ai', 'trailer', 'none']);
    expect(prov.agents).toEqual([{ tool: 'claude', model: 'claude-opus-4-1' }, { tool: 'cursor' }]);

    const byPath = new Map(prov.files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(['README.md', 'migrations/001_users.sql', 'src/auth/login.ts', 'src/util.ts']);

    const login = byPath.get('src/auth/login.ts')!;
    expect(login).toMatchObject({ addedLines: 25, deletedLines: 5, aiLines: 20, humanLines: 5, confidence: 'exact', assumedAi: false });
    expect(login.aiShare).toBeCloseTo(0.8);
    expect(login.agents).toEqual([{ tool: 'claude', model: 'claude-opus-4-1' }]);

    const migration = byPath.get('migrations/001_users.sql')!;
    expect(migration).toMatchObject({ addedLines: 10, aiLines: 10, aiShare: 1, confidence: 'exact' });

    const util = byPath.get('src/util.ts')!;
    expect(util).toMatchObject({ aiLines: 0, confidence: 'commit-level', assumedAi: true });
    expect(util.agents).toEqual([{ tool: 'cursor' }]);

    const readme = byPath.get('README.md')!;
    expect(readme).toMatchObject({ aiLines: 0, confidence: 'unknown', assumedAi: false });

    // util.ts grew from 3 to 8 identical-prefix lines, so numstat reports +5.
    expect(prov.totals.addedLines).toBe(25 + 10 + 5 + 2);
    expect(prov.totals.aiLines).toBe(30);
    expect(prov.commits[0]!.humanAuthors).toEqual(['Test User <test@example.com>']);
  });

  it('uses merge-base semantics so unrelated base commits are ignored', async () => {
    await fixture.git('checkout', '--quiet', 'main');
    await fixture.commit('main moves on', { 'CHANGELOG.md': 'x\n' });
    await fixture.git('checkout', '--quiet', 'feature');

    const prov = await collectProvenance({ repo: fixture.dir, base: 'main', head: 'feature' });
    expect(prov.stats.commits).toBe(3);
    expect(prov.files.some((f) => f.path === 'CHANGELOG.md')).toBe(false);
  });

  it('runs the example policy end to end', async () => {
    const noApprovals = await runCheck({
      repo: fixture.dir,
      base: 'main',
      head: 'feature',
      policyText: examplePolicy,
      review: { approvals: [] },
    });
    expect(noApprovals.verdict.status).toBe('fail');
    const byRule = new Map(noApprovals.verdict.results.map((r) => [r.rule, r]));
    expect(byRule.get('sensitive-paths-need-two-humans')).toMatchObject({ status: 'fail' });
    expect(byRule.get('sensitive-paths-need-two-humans')!.files.sort()).toEqual(['migrations/001_users.sql', 'src/auth/login.ts']);
    expect(byRule.get('ci-and-secrets-are-human-only')).toMatchObject({ status: 'not-applicable' });
    // README (unknown provenance) counts as AI by default, so the whole change is ~0.84 AI.
    expect(byRule.get('mostly-ai-changes-need-a-reviewer')).toMatchObject({ status: 'fail' });
    expect(byRule.get('untracked-provenance-is-visible')).toMatchObject({ status: 'warn' });
    expect(noApprovals.markdown).toContain('## Provenance gate: FAIL');
    expect(noApprovals.markdown).toContain('src/auth/login.ts');

    const approved = await runCheck({
      repo: fixture.dir,
      base: 'main',
      head: 'feature',
      policyText: examplePolicy,
      review: { approvals: [{ login: 'alice', teams: ['security'] }, { login: 'bob' }] },
    });
    expect(approved.verdict.status).toBe('warn');
    expect(approved.verdict.results.filter((r) => r.status === 'fail')).toEqual([]);
    expect(approved.verdict.requirements.labels.sort()).toEqual(['ai-heavy', 'ai-touched-sensitive-path']);
  });

  it('reads notes from a custom ref and tolerates repositories without notes', async () => {
    const prov = await collectProvenance({ repo: fixture.dir, base: 'main', head: 'feature', notesRef: 'refs/notes/nothing-here' });
    expect(prov.stats.exact).toBe(0);
    expect(prov.stats.commitLevel).toBe(1);
    expect(prov.stats.none).toBe(2);
  });
});

describe('collectProvenance counts only lines that survive to head', () => {
  let fixture: GitFixture;

  beforeAll(async () => {
    fixture = await GitFixture.create();
    await fixture.commit('initial', { 'README.md': '# demo\n' });
    await fixture.git('checkout', '--quiet', '-b', 'feature');
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('credits a human rewrite of agent-written lines to the human', async () => {
    const agentVersion = ['name: deploy', 'on: push', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    steps:', '      - run: ./deploy.sh', '        env: { TOKEN: x }', '      - run: echo done'];
    const a = await fixture.commit('ci: agent adds deploy', { '.github/workflows/deploy.yml': `${agentVersion.join('\n')}\n` });
    await fixture.addNote(
      a,
      authorshipNote([{ path: '.github/workflows/deploy.yml', entries: ['s_aaaaaaaaaaaaaa::t_bbbbbbbbbbbbbb 1-9'] }], {
        sessions: { s_aaaaaaaaaaaaaa: { agent_id: { tool: 'claude', id: 'c', model: 'unknown' } } },
      }),
    );

    // Human keeps lines 1-6, replaces the last three with five new lines.
    const humanVersion = [...agentVersion.slice(0, 6), '      - uses: actions/checkout@v4', '      - run: ./deploy.sh', '        env:', '          TOKEN: ${{ secrets.TOKEN }}', '    environment: production'];
    const b = await fixture.commit('ci: human hardens deploy', { '.github/workflows/deploy.yml': `${humanVersion.join('\n')}\n` });
    await fixture.addNote(
      b,
      authorshipNote([{ path: '.github/workflows/deploy.yml', entries: ['h_cccccccccccccc 7,9-11'] }], {
        humans: { h_cccccccccccccc: { author: 'Test User <test@example.com>' } },
      }),
    );

    const prov = await collectProvenance({ repo: fixture.dir, base: 'main', head: 'feature' });
    const deploy = prov.files.find((f) => f.path === '.github/workflows/deploy.yml')!;
    expect(deploy.addedLines).toBe(11);
    // Lines 1-6 survive from the agent commit; line 8 ("- run: ./deploy.sh") is unchanged text that blame
    // also attributes to the agent commit. Lines 7 and 9-11 are the human's.
    expect(deploy.aiLines).toBe(7);
    expect(deploy.humanLines).toBe(4);
    expect(deploy.aiShare).toBeCloseTo(7 / 11);
    expect(deploy.agents).toEqual([{ tool: 'claude' }]);
    // Summing per-commit logs would have reported 9 AI lines.
    expect(prov.commits[0]!.files[0]!.aiLines).toBe(9);
  });

  it('counts only the surviving lines of trailer-only and untracked commits', async () => {
    await fixture.commit('feat: agent drafts module\n\nCo-authored-by: Claude <noreply@anthropic.com>', {
      'src/mod.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n',
    });
    await fixture.commit('refactor: human trims module', { 'src/mod.ts': 'export const a = 1;\nexport const z = 26;\n' });

    const prov = await collectProvenance({ repo: fixture.dir, base: 'main', head: 'feature' });
    const mod = prov.files.find((f) => f.path === 'src/mod.ts')!;
    expect(mod).toMatchObject({ addedLines: 2, assumedAiLines: 1, unknownLines: 1, aiLines: 0, confidence: 'unknown', assumedAi: true });
    expect(mod.agents).toEqual([{ tool: 'claude' }]);
  });
});
