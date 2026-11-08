# Architecture

```
                 ┌──────────────────────────┐
  git repo ───►  │ provenance/collect       │  ChangeProvenance
  refs/notes/ai  │  gitai.ts  (line-level)  │  ─ per-file AI share, confidence, agents
  commit msgs    │  trailers.ts (commit)    │  ─ per-commit source
                 └────────────┬─────────────┘
                              │
  .provenance-policy.yml ──►  │ policy/evaluate (pure)  ◄── ReviewState (approvals, labels)
                              ▼
                          Verdict ──► report/markdown ──► CLI stdout / Check Run
```

## Modules

| Module | Responsibility |
| --- | --- |
| `src/provenance/gitai.ts` | Parse Git AI Standard v3.0.0 authorship logs. Routes `s_`, `h_` and legacy keys to their metadata maps; tolerates missing records. |
| `src/provenance/trailers.ts` | Detect agents from commit trailers (git trailer semantics: the final paragraph only). |
| `src/provenance/git.ts` | Thin `git` CLI wrapper: rev-list, notes show, diff-tree, numstat, merge-base. |
| `src/provenance/collect.ts` | Walk `merge-base(base, head)..head`, combine both signals, produce `ChangeProvenance`. |
| `src/policy/schema.ts` | Zod schema for `.provenance-policy.yml`; strict keys, defaults, validation errors with paths. |
| `src/policy/evaluate.ts` | Pure evaluator: `(policy, provenance, review) -> Verdict`. No I/O, fully unit-tested. |
| `src/report/markdown.ts` | Render a verdict for humans (CLI output and Check Run body). |
| `src/commands/check.ts` | Glue shared by CLI and App: load policy, collect, evaluate, render. |
| `src/github/review-state.ts` | Approvals, labels and team membership from the REST API into `ReviewState`. |
| `src/github/app.ts` | GitHub App webhook handler: clone with installation token, evaluate, publish Check Run. |
| `src/cli.ts` | `check`, `inspect`, `init`, `validate`. |
| `src/server.ts` | HTTP entry point for the App. |

## Design decisions

**Consume provenance, do not detect it.** Heuristic "AI detection" is unreliable and adversarial. git-ai is an open standard with line-level data that the major agents already write, and commit trailers are a universal, cheap fallback. We report confidence explicitly (`exact` / `commit-level` / `unknown`) instead of pretending.

**Conservative by default.** Unknown lines count as AI unless the policy says otherwise; commit-level signals count as fully AI for the files they touch. The gate should make a team look at a change, not quietly wave it through.

**Pure evaluation.** `evaluatePolicy` takes plain data in and returns plain data out. That keeps policy semantics testable without git or GitHub, and lets the CLI and the App share one implementation.

**Merge-base semantics.** Provenance is computed for `merge-base(base, head)..head`, the same diff a pull request shows, so a moving base branch never changes the verdict.

**Two deployment shapes.** The CLI runs anywhere (Actions, GitLab CI, locally) with zero infrastructure. The App adds Check Runs and automatic labels for teams that want a required status without a workflow file.

## Known approximations

- Per-file `aiShare = sum(AI lines over commits) / added lines`, clamped to `[0, 1]`. Lines rewritten across several commits are over-counted. A future version can replay authorship logs through the diff to obtain exact blame.
- Merge commits contribute no changed files (we rely on their notes only), so conflict-resolution lines are only attributed when git-ai recorded them.
- Approvals are matched by login; team membership is resolved only for teams named in the policy.

## Roadmap

1. Exact blame via log replay instead of summed counts.
2. Support agentdiff records and GitHub's native agent-authored PR signal as additional sources.
3. GitLab / Gitee merge-request integration (same evaluator, different review-state adapter).
4. Policy test harness: `provenance-gate test` runs a policy against fixture changes and asserts verdicts.
5. Org-level reporting: revert rate per model / agent / skill to inform `agents` rules.
