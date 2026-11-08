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

export interface FileProvenance {
  path: string;
  addedLines: number;
  deletedLines: number;
  /** Lines attributed to an AI session via line-level logs. */
  aiLines: number;
  /** Lines attributed to a known human via line-level logs. */
  humanLines: number;
  /** aiLines / addedLines, clamped to [0, 1]. Only meaningful when confidence is `exact`. */
  aiShare: number;
  /** Worst-case confidence across every commit in the range that touched this file. */
  confidence: Confidence;
  /** True when at least one commit touching this file had only a commit-level AI signal. */
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
