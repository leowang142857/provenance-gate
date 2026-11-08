import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { evaluatePolicy, type ReviewState, type Verdict } from '../policy/evaluate.js';
import { parsePolicy, type Policy } from '../policy/schema.js';
import { collectProvenance } from '../provenance/collect.js';
import type { ChangeProvenance } from '../provenance/types.js';
import { renderMarkdown } from '../report/markdown.js';

export const DEFAULT_POLICY_PATH = '.provenance-policy.yml';

export interface CheckOptions {
  repo: string;
  base: string;
  head: string;
  /** Either a path to a policy file (resolved against `repo`) or inline policy text via `policyText`. */
  policyPath?: string;
  policyText?: string;
  notesRef?: string;
  review: ReviewState;
}

export interface CheckResult {
  policy: Policy;
  provenance: ChangeProvenance;
  verdict: Verdict;
  markdown: string;
}

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const policyText =
    options.policyText ?? (await readFile(resolve(options.repo, options.policyPath ?? DEFAULT_POLICY_PATH), 'utf8'));
  const policy = parsePolicy(policyText);
  const provenance = await collectProvenance({
    repo: options.repo,
    base: options.base,
    head: options.head,
    ...(options.notesRef ? { notesRef: options.notesRef } : {}),
  });
  const verdict = evaluatePolicy(policy, provenance, options.review);
  return { policy, provenance, verdict, markdown: renderMarkdown(provenance, verdict) };
}
