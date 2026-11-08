#!/usr/bin/env bash
# End-to-end demo against a real git-ai installation.
#
# Creates /tmp/demo-shop with a feature branch whose commits carry real git-ai
# authorship notes (Claude Code edits via the `claude` checkpoint preset, a
# known-human edit), one commit with only a Cursor co-author trailer, then runs
# provenance-gate against it.
#
#   pnpm build && bash scripts/demo-with-git-ai.sh
#
# Installs git-ai (https://usegitai.com) into ~/.git-ai if it is missing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="${DEMO_DIR:-/tmp/demo-shop}"
CLI="node $ROOT/dist/cli.js"
export PATH="$HOME/.git-ai/bin:$PATH"

if ! command -v git-ai >/dev/null; then
  curl -sSfL https://usegitai.com/install.sh | bash
fi
git-ai --version

rm -rf "$DEMO" && mkdir -p "$DEMO" && cd "$DEMO"
git init -q --initial-branch=main
git config user.name "Demo Human" && git config user.email human@example.com && git config commit.gpgsign false

# git-ai writes notes asynchronously from its trace2 daemon.
wait_note() {
  for _ in $(seq 1 40); do git notes --ref=ai show "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "warning: no git-ai note for $1" >&2
}

TRANSCRIPT="$DEMO/.git/claude-session.jsonl"
cat > "$TRANSCRIPT" <<'EOF'
{"type":"user","message":{"role":"user","content":"Make login async and issue sessions"},"sessionId":"demo-1"}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-5","content":[{"type":"text","text":"Done."}]},"sessionId":"demo-1"}
EOF
# What Claude Code's PostToolUse hook sends to git-ai after it writes a file.
claude_wrote() {
  printf '{"session_id":"demo-1","transcript_path":"%s","cwd":"%s","hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"%s/%s"}}' \
    "$TRANSCRIPT" "$DEMO" "$DEMO" "$1" | git-ai checkpoint claude --hook-input stdin >/dev/null
}

mkdir -p src/auth
printf 'export function login(u: string, p: string) {\n  return u.length > 0 && p.length > 0;\n}\n' > src/auth/login.ts
printf 'export const sum = (a: number, b: number) => a + b;\n' > src/util.ts
printf '# demo-shop\n' > README.md
git add -A && git commit -qm "initial commit"
git checkout -qb feature/oauth

cat > src/auth/login.ts <<'EOF'
import { verifyPassword } from './hash';
import { issueSession } from './session';

export async function login(user: string, password: string) {
  if (!user || !password) return { ok: false as const };
  if (!(await verifyPassword(user, password))) return { ok: false as const };
  return { ok: true as const, token: await issueSession(user) };
}
EOF
claude_wrote src/auth/login.ts
git add -A && git commit -qm "feat(auth): async login with sessions"; wait_note HEAD

mkdir -p db/migrations
cat > db/migrations/001_sessions.sql <<'EOF'
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
EOF
claude_wrote db/migrations/001_sessions.sql
git add -A && git commit -qm "feat(db): sessions table"; wait_note HEAD

cat >> src/util.ts <<'EOF'
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const isEmail = (s: string) => /^[^@\s]+@[^@\s]+$/.test(s);
EOF
git-ai checkpoint mock_known_human src/util.ts >/dev/null
git add -A && git commit -qm "chore(util): helpers"; wait_note HEAD

mkdir -p .github/workflows
cat > .github/workflows/deploy.yml <<'EOF'
name: deploy
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/deploy.sh
        env: { DEPLOY_TOKEN: "${{ secrets.DEPLOY_TOKEN }}" }
EOF
claude_wrote .github/workflows/deploy.yml
git add -A && git commit -qm "ci: add deploy workflow"; wait_note HEAD

# A teammate without git-ai: only a co-author trailer.
printf '# demo-shop\n\nLogin now issues session tokens. See db/migrations.\n' > README.md
git add -A && git commit -qm "docs: describe sessions

Co-authored-by: Cursor Agent <cursoragent@cursor.com>"
wait_note HEAD && git notes --ref=ai remove HEAD >/dev/null 2>&1 || true

cp "$ROOT/policies/example.yml" .provenance-policy.yml
sed -i 's#"src/payments/\*\*"#"src/payments/**"\n        - "db/**"#' .provenance-policy.yml

echo
echo "=== git-ai's view ==="
git-ai log --oneline main..HEAD | grep -v '^\s*$' || true

set +e
echo
echo "=== provenance-gate: no approvals ==="
$CLI check -C "$DEMO" --base main --head feature/oauth
echo "exit=$?"
echo
echo "=== provenance-gate: alice (security) and bob approved ==="
$CLI check -C "$DEMO" --base main --head feature/oauth -a alice:security -a bob
echo "exit=$?"
