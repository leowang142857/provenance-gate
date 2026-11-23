import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { GitFixture, authorshipNote, lines } from './helpers/git-fixture.js';

const execFileAsync = promisify(execFile);

const EXAMPLE = new URL('../examples/github-actions.yml', import.meta.url);

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
}

/** The script of the step that fetches refs/notes/ai, with the GitHub expression for the base SHA filled in. */
async function notesStepScript(baseSha: string): Promise<string> {
  const workflow = parseYaml(await readFile(EXAMPLE, 'utf8')) as Workflow;
  const steps = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .filter((s) => s.run?.includes('refs/notes/ai'));
  expect(steps).toHaveLength(1);
  const step = steps[0];
  if (!step?.run) {
    throw new Error('no step in the example workflow fetches refs/notes/ai');
  }
  const script = step.run.replace(/\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/g, baseSha);
  expect(script).not.toContain('${{');
  return script;
}

/**
 * A directory holding a `git` that fails the way a network or permission error would for the given
 * subcommands when they mention refs/notes/ai, and behaves normally for everything else.
 */
async function failingGitBin(subcommands: string[]): Promise<string> {
  const realGit = (await execFileAsync('sh', ['-c', 'command -v git'])).stdout.trim();
  const bin = await mkdtemp(join(tmpdir(), 'provenance-gate-bin-'));
  const wrapper = join(bin, 'git');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      'case "$1 $*" in',
      `  ${subcommands.map((c) => `"${c} "*refs/notes/ai*`).join('|')})`,
      '    echo "fatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 403" >&2',
      '    exit 128 ;;',
      'esac',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(wrapper, 0o755);
  return bin;
}

describe('examples/github-actions.yml authorship notes step', () => {
  // The CLI cannot tell "this repository has no notes" from "the notes were never fetched", so the
  // workflow step has to: swallowing a failed fetch evaluates an agent-written change without its
  // authorship log, which a policy that treats untracked commits as human lets through.
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  async function setup(options: { withNotes: boolean }): Promise<{ checkout: GitFixture; base: string; head: string }> {
    const remote = await GitFixture.create();
    cleanup.push(() => remote.cleanup());
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

    // What actions/checkout leaves behind: the PR head checked out, with origin pointing at the repository.
    const checkout = await GitFixture.create();
    cleanup.push(() => checkout.cleanup());
    await checkout.git('remote', 'add', 'origin', remote.dir);
    await checkout.git('fetch', '--quiet', 'origin', 'feature');
    await checkout.git('checkout', '--quiet', '--detach', head);
    return { checkout, base, head };
  }

  /** Runs the step the way GitHub runs a `run:` script (`bash --noprofile --norc -eo pipefail`). */
  async function runStep(
    checkout: GitFixture,
    base: string,
    failing: string[] = [],
  ): Promise<{ exitCode: number; stderr: string }> {
    const script = await notesStepScript(base);
    let path = process.env['PATH'] ?? '';
    if (failing.length > 0) {
      const bin = await failingGitBin(failing);
      cleanup.push(() => rm(bin, { recursive: true, force: true }));
      path = `${bin}${delimiter}${path}`;
    }
    const env = { ...process.env, PATH: path, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    try {
      const { stderr } = await execFileAsync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        cwd: checkout.dir,
        env,
      });
      return { exitCode: 0, stderr };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stderr: failure.stderr ?? '' };
    }
  }

  it('fetches the notes and the base when the repository has notes', async () => {
    const { checkout, base, head } = await setup({ withNotes: true });
    const result = await runStep(checkout, base);
    expect(result.exitCode).toBe(0);
    expect(await checkout.git('notes', '--ref=ai', 'show', head)).toContain('codex');
    expect(await checkout.git('cat-file', '-t', base)).toBe('commit');
  });

  it('succeeds when the repository has no notes ref', async () => {
    const { checkout, base } = await setup({ withNotes: false });
    const result = await runStep(checkout, base);
    expect(result.exitCode).toBe(0);
    expect(await checkout.git('cat-file', '-t', base)).toBe('commit');
  });

  it('fails when the notes exist but cannot be fetched', async () => {
    const { checkout, base } = await setup({ withNotes: true });
    const result = await runStep(checkout, base, ['fetch']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('403');
  });

  it('fails when the remote cannot be asked whether the notes exist', async () => {
    const { checkout, base } = await setup({ withNotes: true });
    const result = await runStep(checkout, base, ['fetch', 'ls-remote']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('403');
  });
});
