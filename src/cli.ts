#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { DEFAULT_POLICY_PATH, runCheck } from './commands/check.js';
import { fetchReviewState } from './github/review-state.js';
import type { Approval, ReviewState } from './policy/evaluate.js';
import { parsePolicy, type Policy } from './policy/schema.js';
import { collectProvenance } from './provenance/collect.js';
import { git, revParse } from './provenance/git.js';

const program = new Command();

program
  .name('provenance-gate')
  .description('Merge-policy enforcement driven by AI code provenance (git-ai notes, commit trailers).')
  .version('0.1.0');

program
  .command('check')
  .description('Evaluate a policy against the changes between --base and --head and exit non-zero on failure.')
  .option('-C, --repo <path>', 'repository path', process.cwd())
  .option('-b, --base <ref>', 'base ref (merge-base semantics)', 'origin/main')
  .option('-h, --head <ref>', 'head ref', 'HEAD')
  .option('-p, --policy <path>', 'policy file, relative to the repo', DEFAULT_POLICY_PATH)
  .option(
    '--policy-ref <ref>',
    'read the policy from this commit instead of the working tree; use the base so a pull request cannot edit its own policy',
  )
  .option('--notes-ref <ref>', 'git notes ref holding authorship logs', 'refs/notes/ai')
  .option('-a, --approval <login[:team1,team2]>', 'an existing human approval (repeatable)', collect, [] as string[])
  .option('--bot-approval <login>', 'an existing approval from a bot account (repeatable)', collect, [] as string[])
  .option('--label <name>', 'a label currently on the pull request (repeatable)', collect, [] as string[])
  .option('--github <owner/repo#number>', 'fetch approvals and labels from GitHub; uses GITHUB_TOKEN')
  .option('--json', 'print the full result as JSON instead of markdown', false)
  .option('--fail-on-warn', 'exit non-zero when the verdict is "warn"', false)
  .action(async (opts: CheckCliOptions) => {
    const repo = resolve(opts.repo);
    const policyText = opts.policyRef
      ? await git(repo, ['show', `${opts.policyRef}:${opts.policy}`])
      : await readFile(resolve(repo, opts.policy), 'utf8');
    const review = opts.github
      ? await reviewFromGitHub(opts.github, parsePolicy(policyText), await revParse(repo, opts.head))
      : reviewFromFlags(opts);
    const result = await runCheck({
      repo,
      base: opts.base,
      head: opts.head,
      policyText,
      notesRef: opts.notesRef,
      review,
    });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ verdict: result.verdict, provenance: result.provenance }, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.markdown}\n`);
    }

    const failed = result.verdict.status === 'fail' || (opts.failOnWarn && result.verdict.status === 'warn');
    process.exitCode = failed ? 1 : 0;
  });

program
  .command('inspect')
  .description('Print the provenance picture of a change without evaluating any policy.')
  .option('-C, --repo <path>', 'repository path', process.cwd())
  .option('-b, --base <ref>', 'base ref', 'origin/main')
  .option('-h, --head <ref>', 'head ref', 'HEAD')
  .option('--notes-ref <ref>', 'git notes ref holding authorship logs', 'refs/notes/ai')
  .action(async (opts: { repo: string; base: string; head: string; notesRef: string }) => {
    const provenance = await collectProvenance({
      repo: resolve(opts.repo),
      base: opts.base,
      head: opts.head,
      notesRef: opts.notesRef,
    });
    process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
  });

program
  .command('init')
  .description(`Write an example policy to ${DEFAULT_POLICY_PATH} in the current directory.`)
  .option('-C, --repo <path>', 'repository path', process.cwd())
  .option('--force', 'overwrite an existing policy file', false)
  .action(async (opts: { repo: string; force: boolean }) => {
    const target = resolve(opts.repo, DEFAULT_POLICY_PATH);
    if (!opts.force && (await exists(target))) {
      process.stderr.write(`${target} already exists (use --force to overwrite)\n`);
      process.exitCode = 1;
      return;
    }
    const example = await readFile(resolve(packageRoot(), 'policies', 'example.yml'), 'utf8');
    parsePolicy(example);
    await writeFile(target, example, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
  });

program
  .command('validate')
  .description('Validate a policy file and print the normalised result.')
  .argument('[path]', 'policy file', DEFAULT_POLICY_PATH)
  .action(async (path: string) => {
    const policy = parsePolicy(await readFile(resolve(path), 'utf8'));
    process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exitCode = 2;
});

interface CheckCliOptions {
  repo: string;
  base: string;
  head: string;
  policy: string;
  policyRef?: string;
  notesRef: string;
  approval: string[];
  botApproval: string[];
  label: string[];
  github?: string;
  json: boolean;
  failOnWarn: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function reviewFromFlags(opts: CheckCliOptions): ReviewState {
  const approvals: Approval[] = opts.approval.map((spec) => {
    const [login, teams] = spec.split(':', 2);
    return {
      login: login ?? spec,
      ...(teams ? { teams: teams.split(',').filter((t) => t.length > 0) } : {}),
      isBot: false,
    };
  });
  for (const login of opts.botApproval) {
    approvals.push({ login, isBot: true });
  }
  return { approvals, labels: opts.label };
}

async function reviewFromGitHub(spec: string, policy: Policy, headSha: string): Promise<ReviewState> {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(spec);
  if (!match) {
    throw new Error('--github expects owner/repo#number');
  }
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  if (!token) {
    throw new Error('--github requires GITHUB_TOKEN (or GH_TOKEN) in the environment');
  }
  const { Octokit } = await import('@octokit/core');
  const octokit = new Octokit({ auth: token });
  const teams = policy.rules.flatMap((rule) => rule.require?.teams ?? []);
  return fetchReviewState(
    octokit,
    { owner: match[1] ?? '', repo: match[2] ?? '', number: Number(match[3]) },
    { teams, headSha },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function packageRoot(): string {
  // dist/cli.js or src/cli.ts -> package root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
