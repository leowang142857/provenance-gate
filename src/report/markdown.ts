import type { Verdict } from '../policy/evaluate.js';
import type { ChangeProvenance, FileProvenance } from '../provenance/types.js';
import { agentKey } from '../provenance/types.js';

const MAX_FILE_ROWS = 50;

export function renderMarkdown(provenance: ChangeProvenance, verdict: Verdict): string {
  const out: string[] = [];
  out.push(`## Provenance gate: ${verdict.status.toUpperCase()}`);
  out.push('');
  out.push(summaryLine(provenance, verdict));
  out.push('');

  out.push('### Rules');
  out.push('');
  out.push('| Rule | Status | Scope | Detail |');
  out.push('| --- | --- | --- | --- |');
  for (const result of verdict.results) {
    const scope = result.files.length > 0 ? `${result.files.length} file(s)` : result.matched ? 'change' : '-';
    const detail = [result.message, ...result.missing.map((m) => `missing: ${m}`)].join('<br>');
    out.push(`| ${escapeCell(result.rule)} | ${result.status} | ${scope} | ${escapeCell(detail)} |`);
  }
  out.push('');

  if (verdict.requirements.humanApprovals > 0 || verdict.requirements.teams.length > 0 || verdict.requirements.reviewers.length > 0) {
    out.push('### Required for merge');
    out.push('');
    if (verdict.requirements.humanApprovals > 0) {
      out.push(`- ${verdict.requirements.humanApprovals} human approval(s) (${verdict.humanApprovalCount} present)`);
    }
    if (verdict.requirements.teams.length > 0) {
      out.push(`- approval from team: ${verdict.requirements.teams.map((t) => `@${t}`).join(', ')}`);
    }
    if (verdict.requirements.reviewers.length > 0) {
      out.push(`- approval from: ${verdict.requirements.reviewers.map((r) => `@${r}`).join(', ')}`);
    }
    out.push('');
  }

  out.push('### Files');
  out.push('');
  out.push('| File | +/- | AI lines | AI share | Confidence | Agents |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  const files = [...provenance.files].sort(byInterest);
  for (const file of files.slice(0, MAX_FILE_ROWS)) {
    out.push(
      `| ${escapeCell(file.path)} | +${file.addedLines}/-${file.deletedLines} | ${file.aiLines} | ${formatShare(file)} | ${file.confidence}${file.assumedAi ? ' (agent in commit)' : ''} | ${file.agents.map(agentKey).join(', ') || '-'} |`,
    );
  }
  if (files.length > MAX_FILE_ROWS) {
    out.push(`| ... ${files.length - MAX_FILE_ROWS} more file(s) | | | | | |`);
  }
  out.push('');

  out.push('### Commits');
  out.push('');
  out.push(
    `${provenance.stats.commits} commit(s): ${provenance.stats.exact} with line-level attribution, ${provenance.stats.commitLevel} with commit-level agent trailers, ${provenance.stats.none} with no provenance signal.`,
  );
  out.push('');
  out.push('<sub>Line-level data is read from git-ai authorship logs (refs/notes/ai). Shares are estimates relative to added lines.</sub>');
  return out.join('\n');
}

export function summaryLine(provenance: ChangeProvenance, verdict: Verdict): string {
  const agents = provenance.agents.map(agentKey);
  const agentText = agents.length > 0 ? agents.join(', ') : 'no agents detected';
  return `${Math.round(verdict.effectiveAiShare * 100)}% of added lines attributed to AI (${agentText}); ${provenance.totals.addedLines} lines added across ${provenance.files.length} file(s).`;
}

function formatShare(file: FileProvenance): string {
  if (file.confidence === 'exact') {
    return `${Math.round(file.aiShare * 100)}%`;
  }
  if (file.confidence === 'commit-level') {
    return 'n/a';
  }
  return file.aiLines > 0 ? `${Math.round(file.aiShare * 100)}%*` : 'unknown';
}

function byInterest(a: FileProvenance, b: FileProvenance): number {
  const score = (f: FileProvenance): number => (f.confidence === 'unknown' ? 2 : 0) + f.aiShare + (f.assumedAi ? 1 : 0);
  return score(b) - score(a) || b.addedLines - a.addedLines;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
