# provenance-gate

基于 AI 代码溯源的合并策略执行层。让分支保护规则读懂"这段代码是谁、或者什么写的"。

[English](./README.md)

## 为什么做这个

GitHub 上超过 40% 的 PR 现在由 agent 发起，而且 agent 写的 PR 合并得比人写的还快。[git-ai](https://github.com/git-ai-project/git-ai) 这类工具已经能记录"哪几行是哪个 agent 用哪个模型、哪条 prompt 写的"，但没有任何东西基于这份记录做强制执行。

provenance-gate 读取仓库里已经存在的溯源记录，把它变成可执行的合并规则：

- "任何被 AI 触碰的 `src/auth/**` 或 `**/migrations/**` 改动，需要两位人类审批，其中一位来自 `@security`。"
- "Agent 不得修改 `.github/**` 或密钥文件。"
- "AI 占比 80% 以上的 PR 必须有一位人类明确批准，并自动打上 `ai-heavy` 标签。"
- "没有任何溯源记录的提交要被标出来（或直接拦下），让审查者知道自己在看什么。"

它既可以作为 CLI（在 CI 或本地运行），也可以作为 GitHub App 发布一个可设为 required 的 Check Run。

## 溯源信号来源

| 信号 | 来源 | 置信度 |
| --- | --- | --- |
| 行级归因 | `refs/notes/ai` 中符合 [Git AI Standard v3.0.0](https://github.com/git-ai-project/git-ai/blob/main/specs/git_ai_standard_v3.0.0.md) 的 authorship log（支持 sessions、legacy 和 known-human 三种 key） | `exact` |
| 提交级 agent 参与 | commit trailer：`Co-authored-by: Claude <noreply@anthropic.com>`、`Co-authored-by: Cursor Agent <cursoragent@cursor.com>`、`Agent: codex`、`AI-Model: ...`，以及 Copilot、Gemini、Devin、OpenCode、Aider、Windsurf、DeepSeek、通义/Qwen、Kimi 等 | `commit-level` |
| 无 | - | `unknown`，由 `defaults.unknown_provenance` 决定如何处理 |

provenance-gate 不用启发式去"猜"哪些代码是 AI 写的。它只消费显式记录，并如实标注置信度。

## 快速开始

```bash
pnpm install && pnpm build

# 在当前仓库写入示例策略 .provenance-policy.yml
node dist/cli.js init

# 用已知的审批信息评估当前分支相对 main 的改动
node dist/cli.js check --base origin/main --head HEAD -a alice:security -a bob

# 或者直接从 GitHub 拉取审批和标签
GITHUB_TOKEN=... node dist/cli.js check --base origin/main --head HEAD --github owner/repo#123
```

`check` 在结论为 `fail` 时退出码为 `1`，否则为 `0`（加 `--fail-on-warn` 可让警告也失败）。`--json` 输出完整的结论和溯源数据。

记得先把 authorship notes 拉到本地：`git fetch origin '+refs/notes/ai:refs/notes/ai'`。

## 策略文件

仓库根目录的 `.provenance-policy.yml`：

```yaml
version: 1

defaults:
  unknown_provenance: treat-as-ai   # treat-as-ai | treat-as-human | block
  count_bot_approvals: false

rules:
  - name: sensitive-paths-need-two-humans
    when:
      paths: ["src/auth/**", "**/migrations/**", "**/*.sql"]
      ai_share_gte: 0.0001            # 只要被 AI 碰过
    require:
      human_approvals: 2
      teams: ["security"]
      labels: ["ai-touched-sensitive-path"]

  - name: ci-is-human-only
    when:
      paths: [".github/**"]
      ai_share_gte: 0.5
    action: block
    message: CI 定义必须由人类编写。

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

语义：

- 带 `when.paths` 的规则按匹配到的文件逐个评估；不带 `paths` 的规则针对整个改动评估。
- `ai_share_*` 是新增行中归因于 AI 的比例。`exact` 文件用实测值；`commit-level` 文件按 100% AI 计；`unknown` 文件按 `defaults.unknown_provenance` 处理。
- `agents` 可以按工具（`claude`、`codex`）、模型（`gpt-*`）或 `tool/model` 的 glob 匹配。
- `require` 会对照当前审批检查；`action: block` 直接失败；`action: warn` 降级为警告。`labels` 由 GitHub App 自动打上，CLI 只报告。
- `defaults.unknown_provenance: block` 时，只要有任何提交完全没有溯源记录就直接失败。

用 `node dist/cli.js validate .provenance-policy.yml` 校验。完整示例见 [`policies/example.yml`](./policies/example.yml)。

## GitHub Actions

见 [`examples/github-actions.yml`](./examples/github-actions.yml)。该 workflow 拉取 `refs/notes/ai`，用 `--github` 从 API 获取审批和标签，并在结论为 `fail` 时让 job 失败。把这个 job 设为 required status check 即可。

## GitHub App

`src/server.ts` 启动一个 webhook 服务：收到 PR 或 review 事件后，用安装 token 浅克隆仓库（含 `refs/notes/ai`），从 PR head 读取 `.provenance-policy.yml`，获取审批与团队成员关系，评估策略，然后发布名为 `provenance-gate` 的 Check Run 并附完整报告。需要的权限：`checks: write`、`contents: read`、`pull_requests: read`、`metadata: read`；如果用到 `teams`，还需要组织级 `members: read`。订阅 `pull_request` 和 `pull_request_review` 事件。

```bash
APP_ID=... PRIVATE_KEY="$(cat key.pem)" WEBHOOK_SECRET=... node dist/server.js
```

设置 `APPLY_LABELS=false` 可禁止 App 自动添加 `require.labels` 中的标签。

## 真实环境演示

`scripts/demo-with-git-ai.sh` 会在需要时安装 [git-ai](https://usegitai.com)，搭建一个带有真实 git-ai 归因笔记的仓库（通过 git-ai 的 `claude` 钩子预设模拟 Claude Code 编辑、一次 known-human 编辑、一个只有 Cursor co-author trailer 的同事提交），然后对它运行 `check`：

```bash
pnpm build && bash scripts/demo-with-git-ai.sh
```

已在 Linux 虚拟机上用 git-ai 1.7.6 验证：每个文件的 AI 行数与 `git-ai blame` 逐行一致，包括人类改写了一部分 agent 输出的文件。

## 局限

- 只统计 PR 最终版本中存活下来的行：每一行通过 blame 定位到引入它的提交，再到该提交的 authorship log 中查归属。纯删除的改动没有存活行，按触碰该文件的提交的置信度判断。
- commit trailer 只能说明 agent 参与了这个提交，无法定位到行，这些提交中存活下来的行按 AI 计。
- git-ai 是异步写入笔记的；在它识别为 agent 环境的机器上（云端 agent、带 agent 环境变量的 CI），可能会把编辑归到 `cloud-agent`。
- 团队成员关系需要组织读权限，没有权限时 `teams` 要求无法满足。
- GitHub App 尚未在真实安装上跑过；CLI 和求值器有针对真实 git 仓库的测试覆盖。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 许可证

Apache-2.0
