export interface LineRange {
  start: number;
  end: number;
}

export interface AgentId {
  /** Tool / harness identifier, e.g. "claude", "cursor", "codex", "copilot". */
  tool: string;
  model?: string;
  id?: string;
}

/** Where a commit's provenance signal came from. */
export type AttributionSource = 'git-ai' | 'trailer' | 'none';

/**
 * exact        - line-level attribution from a git-ai authorship log
 * commit-level - we know an agent was involved (commit trailer) but not which lines
 * unknown      - no provenance signal at all
 */
export type Confidence = 'exact' | 'commit-level' | 'unknown';

export interface FileLineAttribution {
  path: string;
  aiLines: number;
  humanLines: number;
  agents: AgentId[];
}

export interface CommitProvenance {
  sha: string;
  source: AttributionSource;
  confidence: Confidence;
  /** Populated only when `confidence === 'exact'`. */
  files: FileLineAttribution[];
  changedFiles: string[];
  agents: AgentId[];
  humanAuthors: string[];
}

/**
 * Line counts describe lines that exist in the head version of the file and were
 * introduced inside the range (git blame), so rewritten or deleted lines are not counted.
 */
export interface FileProvenance {
  path: string;
  addedLines: number;
  deletedLines: number;
  /** Surviving lines attributed to an AI session via line-level logs. */
  aiLines: number;
  /** Surviving lines attributed to a known human via line-level logs. */
  humanLines: number;
  /** Surviving lines from commits that only carry a commit-level agent signal. */
  assumedAiLines: number;
  /** Surviving lines from commits with no provenance signal at all. */
  unknownLines: number;
  /** aiLines / addedLines, clamped to [0, 1]. */
  aiShare: number;
  /** Worst-case confidence across the commits that contributed surviving lines (or touched the file, for deletions). */
  confidence: Confidence;
  /** True when some surviving lines come from a commit with only a commit-level agent signal. */
  assumedAi: boolean;
  agents: AgentId[];
}

export interface ChangeProvenance {
  base: string;
  head: string;
  mergeBase: string;
  commits: CommitProvenance[];
  files: FileProvenance[];
  totals: {
    addedLines: number;
    deletedLines: number;
    aiLines: number;
    humanLines: number;
    assumedAiLines: number;
    unknownLines: number;
    /** Exact-attribution share across the whole change: aiLines / addedLines, clamped. */
    aiShare: number;
  };
  agents: AgentId[];
  stats: {
    commits: number;
    exact: number;
    commitLevel: number;
    none: number;
  };
}

export function agentKey(agent: AgentId): string {
  return agent.model ? `${agent.tool}/${agent.model}` : agent.tool;
}

export function mergeAgents(into: Map<string, AgentId>, agents: Iterable<AgentId>): void {
  for (const agent of agents) {
    const key = agentKey(agent);
    if (!into.has(key)) {
      into.set(key, { tool: agent.tool, ...(agent.model ? { model: agent.model } : {}) });
    }
  }
}
