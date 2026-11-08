import picomatch from 'picomatch';

import type { AgentId, ChangeProvenance, FileProvenance } from '../provenance/types.js';
import { agentKey } from '../provenance/types.js';
import type { Policy, PolicyRule } from './schema.js';

export interface Approval {
  login: string;
  /** Team slugs the approver belongs to, when known. Accepts `team` or `org/team`. */
  teams?: string[];
  isBot?: boolean;
}

export interface ReviewState {
  approvals: Approval[];
  labels?: string[];
}

export type RuleStatus = 'pass' | 'fail' | 'warn' | 'not-applicable';

export interface RuleResult {
  rule: string;
  description?: string;
  matched: boolean;
  status: RuleStatus;
  /** Files that triggered a file-scoped rule. Empty for PR-scoped rules. */
  files: string[];
  message: string;
  missing: string[];
}

export interface Requirements {
  humanApprovals: number;
  teams: string[];
  reviewers: string[];
  labels: string[];
}

export interface Verdict {
  status: 'pass' | 'fail' | 'warn';
  results: RuleResult[];
  requirements: Requirements;
  /** Added-line weighted AI share after applying `defaults.unknown_provenance`. */
  effectiveAiShare: number;
  humanApprovalCount: number;
}

interface ScopedFile {
  file: FileProvenance;
  effectiveShare: number;
}

export function evaluatePolicy(policy: Policy, provenance: ChangeProvenance, review: ReviewState): Verdict {
  const scoped = provenance.files.map((file) => ({ file, effectiveShare: effectiveFileShare(file, policy) }));
  const prShare = weightedShare(scoped);
  const humanApprovals = review.approvals.filter((a) => policy.defaults.count_bot_approvals || !a.isBot);
  const results: RuleResult[] = [];
  const requirements: Requirements = { humanApprovals: 0, teams: [], reviewers: [], labels: [] };

  if (policy.defaults.unknown_provenance === 'block' && provenance.stats.none > 0) {
    const shas = provenance.commits.filter((c) => c.source === 'none').map((c) => c.sha.slice(0, 10));
    results.push({
      rule: 'unknown-provenance',
      description: 'defaults.unknown_provenance is "block"',
      matched: true,
      status: 'fail',
      files: [],
      message: `${shas.length} commit(s) carry no provenance signal: ${shas.join(', ')}`,
      missing: ['provenance record on every commit'],
    });
  }

  for (const rule of policy.rules) {
    const match = matchRule(rule, provenance, scoped, prShare);
    if (!match.matched) {
      results.push({
        rule: rule.name,
        ...(rule.description ? { description: rule.description } : {}),
        matched: false,
        status: 'not-applicable',
        files: [],
        message: 'conditions not met',
        missing: [],
      });
      continue;
    }

    const severity: 'fail' | 'warn' = rule.action === 'warn' ? 'warn' : 'fail';
    const missing: string[] = [];

    if (rule.require) {
      const req = rule.require;
      if (req.human_approvals !== undefined) {
        requirements.humanApprovals = Math.max(requirements.humanApprovals, req.human_approvals);
        if (humanApprovals.length < req.human_approvals) {
          missing.push(`${req.human_approvals} human approval(s) required, ${humanApprovals.length} present`);
        }
      }
      if (req.teams) {
        requirements.teams = union(requirements.teams, req.teams);
        if (!humanApprovals.some((a) => approverInTeams(a, req.teams ?? []))) {
          missing.push(`an approval from team ${req.teams.map((t) => `@${t}`).join(' or ')}`);
        }
      }
      if (req.reviewers) {
        requirements.reviewers = union(requirements.reviewers, req.reviewers);
        const wanted = new Set(req.reviewers.map((r) => r.toLowerCase()));
        if (!humanApprovals.some((a) => wanted.has(a.login.toLowerCase()))) {
          missing.push(`an approval from ${req.reviewers.map((r) => `@${r}`).join(' or ')}`);
        }
      }
      if (req.labels) {
        requirements.labels = union(requirements.labels, req.labels);
      }
    }

    let status: RuleStatus;
    if (rule.require) {
      status = missing.length === 0 ? 'pass' : severity;
    } else {
      status = severity;
    }

    results.push({
      rule: rule.name,
      ...(rule.description ? { description: rule.description } : {}),
      matched: true,
      status,
      files: match.files,
      message: rule.message ?? defaultMessage(rule, match, status),
      missing,
    });
  }

  const status = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'warn') ? 'warn' : 'pass';

  return {
    status,
    results,
    requirements,
    effectiveAiShare: prShare,
    humanApprovalCount: humanApprovals.length,
  };
}

interface RuleMatch {
  matched: boolean;
  files: string[];
  share: number;
}

function matchRule(rule: PolicyRule, provenance: ChangeProvenance, scoped: ScopedFile[], prShare: number): RuleMatch {
  const when = rule.when;

  if (when.paths) {
    const isMatch = picomatch(when.paths, { dot: true });
    const candidates = scoped.filter(
      (s) => isMatch(s.file.path) || (s.file.previousPath !== undefined && isMatch(s.file.previousPath)),
    );
    const hits = candidates.filter((s) => {
      if (when.ai_share_gte !== undefined && s.effectiveShare < when.ai_share_gte) return false;
      if (when.ai_share_lt !== undefined && s.effectiveShare >= when.ai_share_lt) return false;
      if (when.agents && !agentsMatch(s.file.agents, when.agents)) return false;
      if (when.provenance_missing !== undefined && (s.file.confidence === 'unknown') !== when.provenance_missing) return false;
      return true;
    });
    if (hits.length === 0) {
      return { matched: false, files: [], share: 0 };
    }
    const changed = hits.reduce((sum, s) => sum + s.file.addedLines + s.file.deletedLines, 0);
    if (when.min_changed_lines !== undefined && changed < when.min_changed_lines) {
      return { matched: false, files: [], share: 0 };
    }
    return { matched: true, files: hits.map((s) => s.file.path), share: weightedShare(hits) };
  }

  if (when.ai_share_gte !== undefined && prShare < when.ai_share_gte) return { matched: false, files: [], share: prShare };
  if (when.ai_share_lt !== undefined && prShare >= when.ai_share_lt) return { matched: false, files: [], share: prShare };
  if (when.agents && !agentsMatch(provenance.agents, when.agents)) return { matched: false, files: [], share: prShare };
  if (when.provenance_missing !== undefined && provenance.stats.none > 0 !== when.provenance_missing) {
    return { matched: false, files: [], share: prShare };
  }
  if (when.min_changed_lines !== undefined) {
    const changed = provenance.totals.addedLines + provenance.totals.deletedLines;
    if (changed < when.min_changed_lines) return { matched: false, files: [], share: prShare };
  }
  return { matched: true, files: [], share: prShare };
}

/**
 * Share of the file's surviving added lines that count as AI:
 *   AI-attested lines + lines from commits with only an agent trailer
 *   + lines from commits with no signal, unless the policy treats those as human.
 * Deletions and pure renames have no attributable lines, so they fall back to the file's
 * confidence and to whether an agent touched the file (see FileProvenance.aiShare).
 */
export function effectiveFileShare(file: FileProvenance, policy: Policy): number {
  const unknownCountsAsAi = policy.defaults.unknown_provenance !== 'treat-as-human';
  const attributed = file.aiLines + file.humanLines + file.assumedAiLines + file.unknownLines;
  if (file.addedLines === 0 || attributed === 0) {
    if (file.confidence === 'commit-level') return 1;
    if (file.confidence === 'unknown') return unknownCountsAsAi ? 1 : 0;
    return file.aiShare;
  }
  const aiLike = file.aiLines + file.assumedAiLines + (unknownCountsAsAi ? file.unknownLines : 0);
  return Math.min(1, aiLike / file.addedLines);
}

function weightedShare(files: ScopedFile[]): number {
  let weight = 0;
  let sum = 0;
  for (const s of files) {
    weight += s.file.addedLines;
    sum += s.effectiveShare * s.file.addedLines;
  }
  if (weight === 0) {
    return files.some((s) => s.effectiveShare > 0) ? 1 : 0;
  }
  return sum / weight;
}

function agentsMatch(agents: AgentId[], patterns: string[]): boolean {
  const isMatch = picomatch(
    patterns.map((p) => p.toLowerCase()),
    { nocase: true },
  );
  return agents.some((agent) => {
    const candidates = [agent.tool, agent.model ?? '', agentKey(agent)].filter((c) => c.length > 0);
    return candidates.some((c) => isMatch(c.toLowerCase()));
  });
}

function approverInTeams(approval: Approval, teams: string[]): boolean {
  const wanted = new Set(teams.map(normalizeTeam));
  return (approval.teams ?? []).some((t) => wanted.has(normalizeTeam(t)));
}

function normalizeTeam(team: string): string {
  const slug = team.includes('/') ? team.slice(team.lastIndexOf('/') + 1) : team;
  return slug.replace(/^@/, '').toLowerCase();
}

function union(a: string[], b: string[]): string[] {
  const seen = new Set(a.map((x) => x.toLowerCase()));
  const out = [...a];
  for (const item of b) {
    if (!seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      out.push(item);
    }
  }
  return out;
}

function defaultMessage(rule: PolicyRule, match: RuleMatch, status: RuleStatus): string {
  const pct = `${Math.round(match.share * 100)}% AI`;
  const scope = match.files.length > 0 ? `${match.files.length} file(s), ${pct}` : `change is ${pct}`;
  if (status === 'pass') {
    return `${scope}; requirements satisfied`;
  }
  if (!rule.require) {
    return `${scope}; rule "${rule.name}" ${status === 'warn' ? 'warns on' : 'blocks'} this change`;
  }
  return `${scope}; requirements not met`;
}
