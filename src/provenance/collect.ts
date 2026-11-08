import { isAuthorshipLog, parseAuthorshipLog, type AuthorshipEntry } from './gitai.js';
import {
  blameRange,
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

interface CommitRecord {
  provenance: CommitProvenance;
  /** Authorship entries per path, as written in that commit's log. */
  entries: Map<string, AuthorshipEntry[]>;
}

interface FileAccumulator {
  aiLines: number;
  humanLines: number;
  assumedAiLines: number;
  unknownLines: number;
  blamedLines: number;
  agents: Map<string, AgentId>;
  confidences: Set<Confidence>;
}

/**
 * Builds a provenance picture for everything that `head` adds on top of `base`
 * (merge-base semantics, the same diff a pull request shows).
 *
 * Every line of each changed file at `head` is blamed back to the commit in the range
 * that introduced it, then looked up in that commit's authorship log. Shares therefore
 * describe the code that will actually merge: lines an agent wrote and a human later
 * rewrote count as human.
 */
export async function collectProvenance(options: CollectOptions): Promise<ChangeProvenance> {
  const notesRef = options.notesRef ?? DEFAULT_NOTES_REF;
  const baseSha = await revParse(options.repo, options.base);
  const headSha = await revParse(options.repo, options.head);
  const mb = await mergeBase(options.repo, baseSha, headSha);

  const records = new Map<string, CommitRecord>();
  const touchedBy = new Map<string, Set<Confidence>>();
  const allAgents = new Map<string, AgentId>();
  const stats = { commits: 0, exact: 0, commitLevel: 0, none: 0 };

  for (const sha of await listCommits(options.repo, mb, headSha)) {
    const record = await describeCommit(options.repo, sha, notesRef);
    records.set(sha, record);
    stats.commits += 1;
    stats[confidenceBucket(record.provenance.confidence)] += 1;
    for (const path of record.provenance.changedFiles) {
      let set = touchedBy.get(path);
      if (!set) {
        set = new Set();
        touchedBy.set(path, set);
      }
      set.add(record.provenance.confidence);
    }
  }

  const numstat = await diffNumstat(options.repo, mb, headSha);
  const files: FileProvenance[] = [];
  const totals = { addedLines: 0, deletedLines: 0, aiLines: 0, humanLines: 0, assumedAiLines: 0, unknownLines: 0, aiShare: 0 };

  for (const entry of numstat) {
    const acc: FileAccumulator = {
      aiLines: 0,
      humanLines: 0,
      assumedAiLines: 0,
      unknownLines: 0,
      blamedLines: 0,
      agents: new Map(),
      confidences: new Set(),
    };

    if (entry.added > 0) {
      for (const line of await blameRange(options.repo, mb, headSha, entry.path)) {
        const record = line.boundary ? undefined : records.get(line.sha);
        if (!record) {
          continue;
        }
        acc.blamedLines += 1;
        attributeLine(acc, record, line.origPath, line.origLine);
      }
    }
    // No surviving line to blame (deletion, pure rename, binary): line logs cannot say who removed
    // or moved content, so any agent involvement in a commit that touched the file counts as AI.
    let agentTouched = false;
    if (acc.blamedLines === 0) {
      const paths = entry.previousPath ? [entry.path, entry.previousPath] : [entry.path];
      for (const record of records.values()) {
        if (!paths.some((p) => record.provenance.changedFiles.includes(p))) {
          continue;
        }
        acc.confidences.add(record.provenance.confidence);
        if (record.provenance.agents.length > 0) {
          agentTouched = true;
          mergeAgents(acc.agents, record.provenance.agents);
        }
      }
    }
    mergeAgents(allAgents, acc.agents.values());

    const denominator = Math.max(acc.blamedLines, entry.added);
    files.push({
      path: entry.path,
      ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
      addedLines: entry.added,
      deletedLines: entry.deleted,
      aiLines: acc.aiLines,
      humanLines: acc.humanLines,
      assumedAiLines: acc.assumedAiLines,
      unknownLines: acc.unknownLines,
      aiShare: acc.blamedLines === 0 ? (agentTouched ? 1 : 0) : share(acc.aiLines, denominator),
      confidence: worst(acc.confidences),
      assumedAi: acc.assumedAiLines > 0 || (entry.added === 0 && acc.confidences.has('commit-level')),
      agents: [...acc.agents.values()],
    });
    totals.addedLines += entry.added;
    totals.deletedLines += entry.deleted;
    totals.aiLines += acc.aiLines;
    totals.humanLines += acc.humanLines;
    totals.assumedAiLines += acc.assumedAiLines;
    totals.unknownLines += acc.unknownLines;
  }
  totals.aiShare = share(totals.aiLines, totals.addedLines);

  return {
    base: baseSha,
    head: headSha,
    mergeBase: mb,
    commits: [...records.values()].map((r) => r.provenance),
    files,
    totals,
    agents: [...allAgents.values()],
    stats,
  };
}

function attributeLine(acc: FileAccumulator, record: CommitRecord, path: string, lineNumber: number): void {
  const commit = record.provenance;
  acc.confidences.add(commit.confidence);

  if (commit.confidence === 'commit-level') {
    acc.assumedAiLines += 1;
    mergeAgents(acc.agents, commit.agents);
    return;
  }
  if (commit.confidence === 'unknown') {
    acc.unknownLines += 1;
    return;
  }
  const entry = (record.entries.get(path) ?? []).find((e) =>
    e.ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end),
  );
  if (!entry) {
    // Inside a logged commit but not attested: git-ai has no record, which it reports as human.
    return;
  }
  if (entry.kind === 'ai') {
    acc.aiLines += 1;
    if (entry.agent) {
      mergeAgents(acc.agents, [entry.agent]);
    }
  } else {
    acc.humanLines += 1;
  }
}

async function describeCommit(repo: string, sha: string, notesRef: string): Promise<CommitRecord> {
  const changedFiles = await commitChangedFiles(repo, sha);
  const note = await readNote(repo, sha, notesRef);

  if (note !== null && isAuthorshipLog(note)) {
    const log = parseAuthorshipLog(note);
    const agents = new Map<string, AgentId>();
    const humans = new Set<string>();
    const files: FileLineAttribution[] = [];
    const entries = new Map<string, AuthorshipEntry[]>();
    for (const file of log.files) {
      entries.set(file.path, file.entries);
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
      provenance: {
        sha,
        source: 'git-ai',
        confidence: 'exact',
        files,
        changedFiles,
        agents: [...agents.values()],
        humanAuthors: [...humans],
      },
      entries,
    };
  }

  const agents = detectAgentsFromMessage(await commitMessage(repo, sha));
  const provenance: CommitProvenance =
    agents.length > 0
      ? { sha, source: 'trailer', confidence: 'commit-level', files: [], changedFiles, agents, humanAuthors: [] }
      : { sha, source: 'none', confidence: 'unknown', files: [], changedFiles, agents: [], humanAuthors: [] };
  return { provenance, entries: new Map() };
}

function worst(confidences: Set<Confidence>): Confidence {
  if (confidences.size === 0 || confidences.has('unknown')) {
    return 'unknown';
  }
  if (confidences.has('commit-level')) {
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
