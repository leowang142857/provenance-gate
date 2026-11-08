import { isAuthorshipLog, parseAuthorshipLog } from './gitai.js';
import {
  commitChangedFiles,
  commitMessage,
  diffNumstat,
  listCommits,
  mergeBase,
  readNote,
  revParse,
} from './git.js';
import { detectAgentsFromMessage } from './trailers.js';
import {
  mergeAgents,
  type AgentId,
  type ChangeProvenance,
  type CommitProvenance,
  type Confidence,
  type FileLineAttribution,
  type FileProvenance,
} from './types.js';

export const DEFAULT_NOTES_REF = 'refs/notes/ai';

export interface CollectOptions {
  repo: string;
  base: string;
  head: string;
  notesRef?: string;
}

interface FileAccumulator {
  aiLines: number;
  humanLines: number;
  agents: Map<string, AgentId>;
  touchedBy: number;
  exactCommits: number;
  commitLevelCommits: number;
  unknownCommits: number;
}

/**
 * Builds a provenance picture for everything that `head` adds on top of `base`
 * (merge-base semantics, the same diff a pull request shows).
 *
 * Line counts from authorship logs are summed per file across commits. Because each
 * log describes line numbers at its own commit, a line rewritten by two sessions is
 * counted twice; `aiShare` is therefore an estimate clamped to [0, 1], not an exact
 * blame. It is accurate enough to gate on and errs on the side of reporting more AI.
 */
export async function collectProvenance(options: CollectOptions): Promise<ChangeProvenance> {
  const notesRef = options.notesRef ?? DEFAULT_NOTES_REF;
  const baseSha = await revParse(options.repo, options.base);
  const headSha = await revParse(options.repo, options.head);
  const mb = await mergeBase(options.repo, baseSha, headSha);

  const commits: CommitProvenance[] = [];
  const files = new Map<string, FileAccumulator>();
  const allAgents = new Map<string, AgentId>();
  const stats = { commits: 0, exact: 0, commitLevel: 0, none: 0 };

  for (const sha of await listCommits(options.repo, mb, headSha)) {
    const commit = await describeCommit(options.repo, sha, notesRef);
    commits.push(commit);
    stats.commits += 1;
    stats[confidenceBucket(commit.confidence)] += 1;
    mergeAgents(allAgents, commit.agents);

    if (commit.confidence === 'exact') {
      for (const file of commit.files) {
        const acc = accumulator(files, file.path);
        acc.aiLines += file.aiLines;
        acc.humanLines += file.humanLines;
        mergeAgents(acc.agents, file.agents);
      }
    }
    for (const path of commit.changedFiles) {
      const acc = accumulator(files, path);
      acc.touchedBy += 1;
      if (commit.confidence === 'exact') {
        acc.exactCommits += 1;
      } else if (commit.confidence === 'commit-level') {
        acc.commitLevelCommits += 1;
        mergeAgents(acc.agents, commit.agents);
      } else {
        acc.unknownCommits += 1;
      }
    }
  }

  const numstat = await diffNumstat(options.repo, mb, headSha);
  const fileProvenance: FileProvenance[] = [];
  const totals = { addedLines: 0, deletedLines: 0, aiLines: 0, humanLines: 0, aiShare: 0 };

  for (const entry of numstat) {
    const acc = files.get(entry.path);
    const aiLines = acc?.aiLines ?? 0;
    const humanLines = acc?.humanLines ?? 0;
    totals.addedLines += entry.added;
    totals.deletedLines += entry.deleted;
    totals.aiLines += aiLines;
    totals.humanLines += humanLines;
    fileProvenance.push({
      path: entry.path,
      addedLines: entry.added,
      deletedLines: entry.deleted,
      aiLines,
      humanLines,
      aiShare: share(aiLines, entry.added),
      confidence: fileConfidence(acc),
      assumedAi: (acc?.commitLevelCommits ?? 0) > 0,
      agents: [...(acc?.agents.values() ?? [])],
    });
  }
  totals.aiShare = share(totals.aiLines, totals.addedLines);

  return {
    base: baseSha,
    head: headSha,
    mergeBase: mb,
    commits,
    files: fileProvenance,
    totals,
    agents: [...allAgents.values()],
    stats,
  };
}

async function describeCommit(repo: string, sha: string, notesRef: string): Promise<CommitProvenance> {
  const changedFiles = await commitChangedFiles(repo, sha);
  const note = await readNote(repo, sha, notesRef);

  if (note !== null && isAuthorshipLog(note)) {
    const log = parseAuthorshipLog(note);
    const agents = new Map<string, AgentId>();
    const humans = new Set<string>();
    const files: FileLineAttribution[] = [];
    for (const file of log.files) {
      let aiLines = 0;
      let humanLines = 0;
      const fileAgents = new Map<string, AgentId>();
      for (const entry of file.entries) {
        if (entry.kind === 'ai') {
          aiLines += entry.lineCount;
          if (entry.agent) {
            mergeAgents(fileAgents, [entry.agent]);
          }
        } else {
          humanLines += entry.lineCount;
          if (entry.humanAuthor) {
            humans.add(entry.humanAuthor);
          }
        }
      }
      mergeAgents(agents, fileAgents.values());
      files.push({ path: file.path, aiLines, humanLines, agents: [...fileAgents.values()] });
    }
    return {
      sha,
      source: 'git-ai',
      confidence: 'exact',
      files,
      changedFiles,
      agents: [...agents.values()],
      humanAuthors: [...humans],
    };
  }

  const agents = detectAgentsFromMessage(await commitMessage(repo, sha));
  if (agents.length > 0) {
    return { sha, source: 'trailer', confidence: 'commit-level', files: [], changedFiles, agents, humanAuthors: [] };
  }
  return { sha, source: 'none', confidence: 'unknown', files: [], changedFiles, agents: [], humanAuthors: [] };
}

function accumulator(files: Map<string, FileAccumulator>, path: string): FileAccumulator {
  let acc = files.get(path);
  if (!acc) {
    acc = {
      aiLines: 0,
      humanLines: 0,
      agents: new Map(),
      touchedBy: 0,
      exactCommits: 0,
      commitLevelCommits: 0,
      unknownCommits: 0,
    };
    files.set(path, acc);
  }
  return acc;
}

function fileConfidence(acc: FileAccumulator | undefined): Confidence {
  if (!acc || acc.touchedBy === 0) {
    return 'unknown';
  }
  if (acc.unknownCommits > 0) {
    return 'unknown';
  }
  if (acc.commitLevelCommits > 0) {
    return 'commit-level';
  }
  return 'exact';
}

function confidenceBucket(confidence: Confidence): 'exact' | 'commitLevel' | 'none' {
  if (confidence === 'exact') {
    return 'exact';
  }
  if (confidence === 'commit-level') {
    return 'commitLevel';
  }
  return 'none';
}

function share(aiLines: number, addedLines: number): number {
  if (addedLines <= 0) {
    return aiLines > 0 ? 1 : 0;
  }
  return Math.min(1, aiLines / addedLines);
}
