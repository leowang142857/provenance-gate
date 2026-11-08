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
| `src/provenance/collect.ts` | Walk `merge-base(base, head)..head`, blame each changed file at head, look every surviving line up in its commit's authorship log (or trailer signal), produce `ChangeProvenance`. |
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

**The change under review never configures its own gate.** The App reads the policy from the base commit and the Actions example passes `--policy-ref <base sha>`; only approvals left on the current head commit count.

**Two deployment shapes.** The CLI runs anywhere (Actions, GitLab CI, locally) with zero infrastructure. The App adds Check Runs and automatic labels for teams that want a required status without a workflow file.

## Known approximations

- Per-file attribution uses `git blame merge-base..head`: each surviving line maps to the commit and original line number that introduced it, which is then looked up in that commit's authorship log. Git's blame heuristics decide which commit "owns" an unchanged line of text; this matches `git-ai blame` on real repositories, but identical lines moved within a file can be credited to the earlier commit.
- Merge commits contribute no changed files (we rely on their notes only), so conflict-resolution lines are only attributed when git-ai recorded them.
- Deletions and pure renames have no surviving lines to blame. They count as fully AI when any commit that touched the file (under either name) involved an agent, which is conservative for mixed commits.
- Approvals are matched by login; team membership is resolved only for teams named in the policy.

## Roadmap

1. Support agentdiff records and GitHub's native agent-authored PR signal as additional sources.
2. GitLab / Gitee merge-request integration (same evaluator, different review-state adapter).
3. Policy test harness: `provenance-gate test` runs a policy against fixture changes and asserts verdicts.
4. Org-level reporting: revert rate per model / agent / skill to inform `agents` rules.
