# provenance-gate

Merge-policy enforcement driven by AI code provenance. Branch protection that understands who, or what, wrote the code.

[中文说明](./README.zh-CN.md)

## Why

More than 40% of pull requests on GitHub now start with an agent, and agent-written PRs merge faster than human ones. Tools such as [git-ai](https://github.com/git-ai-project/git-ai) already record *which lines* an agent wrote, with which model and prompt. Nothing enforces anything based on that record.

provenance-gate reads the provenance that already exists in your repository and turns it into merge rules:

- "Any AI-touched change under `src/auth/**` or `**/migrations/**` needs two human approvals, one from `@security`."
- "Agents may not modify `.github/**` or secret files."
- "PRs that are 80%+ AI-written need an explicit human approval and get an `ai-heavy` label."
- "Commits with no provenance record are flagged (or blocked) so reviewers know what they are looking at."

It runs as a CLI (in CI, or locally) and as a GitHub App that publishes a Check Run you can mark as required in branch protection.

## How it reads provenance

| Signal | Source | Confidence |
| --- | --- | --- |
| Line-level attribution | [Git AI Standard v3.0.0](https://github.com/git-ai-project/git-ai/blob/main/specs/git_ai_standard_v3.0.0.md) authorship logs in `refs/notes/ai` (sessions, legacy and known-human keys) | `exact` |
| Commit-level agent involvement | Commit trailers: `Co-authored-by: Claude <noreply@anthropic.com>`, `Co-authored-by: Cursor Agent <cursoragent@cursor.com>`, `Agent: codex`, `AI-Model: ...`, and similar for Copilot, Gemini, Devin, OpenCode, Aider, Windsurf, DeepSeek, Qwen, Kimi | `commit-level` |
| Nothing | - | `unknown`, handled by `defaults.unknown_provenance` |

provenance-gate does not try to *detect* AI code with heuristics. It consumes explicit records and is honest about confidence.

## Quick start

```bash
pnpm install && pnpm build

# write an example .provenance-policy.yml into the current repo
node dist/cli.js init

# evaluate the current branch against main, supplying known approvals
node dist/cli.js check --base origin/main --head HEAD -a alice:security -a bob

# or pull approvals and labels from GitHub
GITHUB_TOKEN=... node dist/cli.js check --base origin/main --head HEAD --github owner/repo#123
```

`check` exits `1` when the verdict is `fail`, `0` otherwise (`--fail-on-warn` to also fail on warnings). `--json` prints the full verdict and provenance.

Make sure the authorship notes are available locally: `git fetch origin '+refs/notes/ai:refs/notes/ai'`.

## Policy file

`.provenance-policy.yml` at the repository root:

```yaml
version: 1

defaults:
  unknown_provenance: treat-as-ai   # treat-as-ai | treat-as-human | block
  count_bot_approvals: false

rules:
  - name: sensitive-paths-need-two-humans
    when:
      paths: ["src/auth/**", "**/migrations/**", "**/*.sql"]
      ai_share_gte: 0.0001            # any AI touch
    require:
      human_approvals: 2
      teams: ["security"]
      labels: ["ai-touched-sensitive-path"]

  - name: ci-is-human-only
    when:
      paths: [".github/**"]
      ai_share_gte: 0.5
    action: block
    message: CI definitions must be authored by a human.

  - name: mostly-ai-changes-need-a-reviewer
    when:
      ai_share_gte: 0.8
      min_changed_lines: 20
    require:
      human_approvals: 1
      labels: ["ai-heavy"]

  - name: untracked-provenance-is-visible
    when:
      provenance_missing: true
    action: warn
```

Semantics:

- A rule with `when.paths` is evaluated per matching file; a rule without `paths` is evaluated against the whole change.
- `ai_share_*` is the fraction of added lines attributed to AI. `exact` files use the measured share; `commit-level` files count as fully AI; `unknown` files follow `defaults.unknown_provenance`.
- `agents` matches tool (`claude`, `codex`), model (`gpt-*`) or `tool/model` globs.
- `require` is checked against current approvals; `action: block` fails outright; `action: warn` downgrades to a warning. `labels` are applied by the GitHub App and reported by the CLI.
- `defaults.unknown_provenance: block` fails the check when any commit has no provenance at all.

Validate with `node dist/cli.js validate .provenance-policy.yml`. The full example lives in [`policies/example.yml`](./policies/example.yml).

## GitHub Actions

See [`examples/github-actions.yml`](./examples/github-actions.yml). The workflow fetches `refs/notes/ai`, runs `check` with `--github` so approvals and labels come from the API, and fails the job on a `fail` verdict. Mark the job as a required status check.

## GitHub App

`src/server.ts` runs a webhook server that, on pull request and review events, shallow-clones the repository with the installation token (including `refs/notes/ai`), reads `.provenance-policy.yml` from the PR head, fetches approvals and team memberships, evaluates the policy and publishes a `provenance-gate` Check Run with the full report. Required permissions: `checks: write`, `contents: read`, `pull_requests: read`, `metadata: read`, and `members: read` on the organization if you use `teams`. Subscribe to `pull_request` and `pull_request_review`.

```bash
APP_ID=... PRIVATE_KEY="$(cat key.pem)" WEBHOOK_SECRET=... node dist/server.js
```

Set `APPLY_LABELS=false` to stop the App from adding labels from `require.labels`.

## Library

```ts
import { collectProvenance, parsePolicy, evaluatePolicy, renderMarkdown } from 'provenance-gate';

const provenance = await collectProvenance({ repo: '.', base: 'origin/main', head: 'HEAD' });
const verdict = evaluatePolicy(parsePolicy(yamlText), provenance, { approvals: [{ login: 'alice', teams: ['security'] }] });
console.log(renderMarkdown(provenance, verdict));
```

## Limitations

- AI shares are estimates. Authorship logs describe line numbers at their own commit, so a line rewritten by two sessions is counted twice; shares are clamped to 100% and err towards reporting more AI.
- Commit trailers only say an agent was involved somewhere in the commit. Those files are treated as fully AI-written.
- Team membership requires organization read access; without it, `teams` requirements cannot be satisfied.
- The GitHub App has not been exercised against a live installation yet; the CLI and evaluator are covered by tests against real git repositories.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

Apache-2.0
