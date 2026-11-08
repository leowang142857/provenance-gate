import { describe, expect, it } from 'vitest';

import { evaluatePolicy } from '../src/policy/evaluate.js';
import { parsePolicy } from '../src/policy/schema.js';
import type { ChangeProvenance, FileProvenance } from '../src/provenance/types.js';

function file(partial: Partial<FileProvenance> & { path: string }): FileProvenance {
  return {
    addedLines: 10,
    deletedLines: 0,
    aiLines: 0,
    humanLines: 0,
    assumedAiLines: 0,
    unknownLines: 0,
    aiShare: 0,
    confidence: 'exact',
    assumedAi: false,
    agents: [],
    ...partial,
  };
}

function change(files: FileProvenance[], extra: Partial<ChangeProvenance> = {}): ChangeProvenance {
  const addedLines = files.reduce((s, f) => s + f.addedLines, 0);
  const aiLines = files.reduce((s, f) => s + f.aiLines, 0);
  return {
    base: 'base',
    head: 'head',
    mergeBase: 'base',
    commits: [],
    files,
    totals: {
      addedLines,
      deletedLines: files.reduce((s, f) => s + f.deletedLines, 0),
      aiLines,
      humanLines: 0,
      assumedAiLines: files.reduce((s, f) => s + f.assumedAiLines, 0),
      unknownLines: files.reduce((s, f) => s + f.unknownLines, 0),
      aiShare: addedLines === 0 ? 0 : Math.min(1, aiLines / addedLines),
    },
    agents: [...new Map(files.flatMap((f) => f.agents).map((a) => [a.tool, a])).values()],
    stats: { commits: 1, exact: 1, commitLevel: 0, none: 0 },
    ...extra,
  };
}

const POLICY = parsePolicy(`
version: 1
rules:
  - name: sensitive
    when:
      paths: ["src/auth/**", "**/*.sql"]
      ai_share_gte: 0.0001
    require:
      human_approvals: 2
      teams: ["security"]
      labels: ["ai-touched-sensitive-path"]
  - name: ai-heavy
    when:
      ai_share_gte: 0.8
      min_changed_lines: 20
    require:
      human_approvals: 1
  - name: no-ai-in-ci
    when:
      paths: [".github/**"]
      ai_share_gte: 0.5
    action: block
    message: CI is human-only.
  - name: visibility
    when:
      provenance_missing: true
    action: warn
`);

describe('evaluatePolicy', () => {
  it('passes when nothing matches', () => {
    const verdict = evaluatePolicy(POLICY, change([file({ path: 'src/util.ts', addedLines: 10 })]), { approvals: [] });
    expect(verdict.status).toBe('pass');
    expect(verdict.results.every((r) => r.status === 'not-applicable')).toBe(true);
    expect(verdict.effectiveAiShare).toBe(0);
  });

  it('requires two human approvals including security on AI-touched sensitive paths', () => {
    const prov = change([
      file({ path: 'src/auth/login.ts', addedLines: 40, aiLines: 20, aiShare: 0.5, agents: [{ tool: 'claude' }] }),
      file({ path: 'README.md', addedLines: 5 }),
    ]);

    const none = evaluatePolicy(POLICY, prov, { approvals: [] });
    expect(none.status).toBe('fail');
    const sensitive = none.results.find((r) => r.rule === 'sensitive')!;
    expect(sensitive.status).toBe('fail');
    expect(sensitive.files).toEqual(['src/auth/login.ts']);
    expect(sensitive.missing).toHaveLength(2);
    expect(none.requirements).toEqual({ humanApprovals: 2, teams: ['security'], reviewers: [], labels: ['ai-touched-sensitive-path'] });

    const one = evaluatePolicy(POLICY, prov, { approvals: [{ login: 'alice', teams: ['security'] }] });
    expect(one.status).toBe('fail');
    expect(one.results.find((r) => r.rule === 'sensitive')!.missing).toEqual(['2 human approval(s) required, 1 present']);

    const two = evaluatePolicy(POLICY, prov, {
      approvals: [{ login: 'alice', teams: ['acme/security'] }, { login: 'bob' }],
    });
    expect(two.status).toBe('pass');
    expect(two.humanApprovalCount).toBe(2);
  });

  it('does not count bot approvals unless configured', () => {
    const prov = change([file({ path: 'src/auth/x.ts', addedLines: 10, aiLines: 10, aiShare: 1 })]);
    const bots = evaluatePolicy(POLICY, prov, {
      approvals: [
        { login: 'alice', teams: ['security'] },
        { login: 'review-bot[bot]', isBot: true, teams: ['security'] },
      ],
    });
    expect(bots.status).toBe('fail');

    const lenient = parsePolicy(`
version: 1
defaults: { count_bot_approvals: true }
rules:
  - name: sensitive
    when: { paths: ["src/auth/**"], ai_share_gte: 0.0001 }
    require: { human_approvals: 2 }
`);
    expect(
      evaluatePolicy(lenient, prov, { approvals: [{ login: 'alice' }, { login: 'bot', isBot: true }] }).status,
    ).toBe('pass');
  });

  it('evaluates PR-level share with added-line weighting', () => {
    const prov = change([
      file({ path: 'src/a.ts', addedLines: 90, aiLines: 90, aiShare: 1 }),
      file({ path: 'src/b.ts', addedLines: 10, aiLines: 0, aiShare: 0 }),
    ]);
    const verdict = evaluatePolicy(POLICY, prov, { approvals: [] });
    expect(verdict.effectiveAiShare).toBeCloseTo(0.9);
    expect(verdict.results.find((r) => r.rule === 'ai-heavy')!.status).toBe('fail');
    expect(evaluatePolicy(POLICY, prov, { approvals: [{ login: 'carol' }] }).status).toBe('pass');
  });

  it('skips PR-level rules below min_changed_lines', () => {
    const prov = change([file({ path: 'src/a.ts', addedLines: 5, aiLines: 5, aiShare: 1 })]);
    expect(evaluatePolicy(POLICY, prov, { approvals: [] }).results.find((r) => r.rule === 'ai-heavy')!.status).toBe(
      'not-applicable',
    );
  });

  it('blocks outright with action: block and uses the custom message', () => {
    const prov = change([file({ path: '.github/workflows/ci.yml', addedLines: 10, aiLines: 10, aiShare: 1 })]);
    const verdict = evaluatePolicy(POLICY, prov, { approvals: [{ login: 'a' }, { login: 'b', teams: ['security'] }] });
    expect(verdict.status).toBe('fail');
    const rule = verdict.results.find((r) => r.rule === 'no-ai-in-ci')!;
    expect(rule.status).toBe('fail');
    expect(rule.message).toBe('CI is human-only.');
  });

  it('treats commit-level agent signals as fully AI', () => {
    const prov = change([file({ path: 'src/auth/x.ts', addedLines: 10, assumedAiLines: 10, confidence: 'commit-level', assumedAi: true })]);
    const verdict = evaluatePolicy(POLICY, prov, { approvals: [] });
    expect(verdict.results.find((r) => r.rule === 'sensitive')!.status).toBe('fail');
    expect(verdict.effectiveAiShare).toBe(1);
  });

  it('applies defaults.unknown_provenance', () => {
    const prov = change([file({ path: 'src/auth/x.ts', addedLines: 10, unknownLines: 10, confidence: 'unknown' })], {
      stats: { commits: 1, exact: 0, commitLevel: 0, none: 1 },
      commits: [{ sha: 'deadbeefcafe', source: 'none', confidence: 'unknown', files: [], changedFiles: ['src/auth/x.ts'], agents: [], humanAuthors: [] }],
    });

    const asAi = evaluatePolicy(POLICY, prov, { approvals: [] });
    expect(asAi.status).toBe('fail');
    expect(asAi.results.find((r) => r.rule === 'visibility')!.status).toBe('warn');

    const asHuman = evaluatePolicy(
      parsePolicy(`
version: 1
defaults: { unknown_provenance: treat-as-human }
rules:
  - name: sensitive
    when: { paths: ["src/auth/**"], ai_share_gte: 0.0001 }
    require: { human_approvals: 2 }
`),
      prov,
      { approvals: [] },
    );
    expect(asHuman.status).toBe('pass');

    const block = evaluatePolicy(
      parsePolicy(`
version: 1
defaults: { unknown_provenance: block }
rules:
  - name: anything
    when: { ai_share_gte: 0.99 }
    action: warn
`),
      prov,
      { approvals: [] },
    );
    expect(block.status).toBe('fail');
    expect(block.results[0]).toMatchObject({ rule: 'unknown-provenance', status: 'fail' });
    expect(block.results[0]!.message).toContain('deadbeefca');
  });

  it('matches agents by tool, model or tool/model glob', () => {
    const policy = parsePolicy(`
version: 1
rules:
  - name: no-codex-on-infra
    when: { paths: ["infra/**"], agents: ["codex", "gpt-*"] }
    action: block
  - name: flag-opus
    when: { agents: ["claude/claude-opus*"] }
    action: warn
`);
    const prov = change([
      file({ path: 'infra/main.tf', addedLines: 10, aiLines: 10, aiShare: 1, agents: [{ tool: 'codex', model: 'gpt-5-codex' }] }),
      file({ path: 'src/x.ts', addedLines: 10, aiLines: 10, aiShare: 1, agents: [{ tool: 'claude', model: 'claude-opus-4-1' }] }),
    ]);
    const verdict = evaluatePolicy(policy, prov, { approvals: [] });
    expect(verdict.results.map((r) => [r.rule, r.status])).toEqual([
      ['no-codex-on-infra', 'fail'],
      ['flag-opus', 'warn'],
    ]);
  });

  it('requires a named reviewer when configured', () => {
    const policy = parsePolicy(`
version: 1
rules:
  - name: owner
    when: { paths: ["core/**"], ai_share_gte: 0.0001 }
    require: { reviewers: ["Maintainer"] }
`);
    const prov = change([file({ path: 'core/a.ts', addedLines: 1, aiLines: 1, aiShare: 1 })]);
    expect(evaluatePolicy(policy, prov, { approvals: [{ login: 'someone' }] }).status).toBe('fail');
    expect(evaluatePolicy(policy, prov, { approvals: [{ login: 'maintainer' }] }).status).toBe('pass');
  });
});

describe('parsePolicy', () => {
  it('rejects unknown keys and rules without an effect', () => {
    expect(() => parsePolicy('version: 1\nrules:\n  - name: x\n    when: {}\n')).toThrow(/require.*action|action/);
    expect(() => parsePolicy('version: 1\nrules:\n  - name: x\n    action: block\n    extra: 1\n')).toThrow(/unrecognized|Unrecognized/i);
    expect(() => parsePolicy('version: 2\nrules: []')).toThrow();
    expect(() => parsePolicy(':: not yaml ::')).toThrow(/YAML|validation/);
  });

  it('fills defaults', () => {
    const policy = parsePolicy('version: 1\nrules:\n  - name: x\n    action: warn\n');
    expect(policy.defaults).toEqual({ unknown_provenance: 'treat-as-ai', count_bot_approvals: false });
    expect(policy.rules[0]!.when).toEqual({});
  });
});
