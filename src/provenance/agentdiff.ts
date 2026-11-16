/**
 * Reader for agentdiff traces (https://github.com/codeprakhar25/agentdiff).
 *
 * agentdiff writes one Agent Trace v0.1 record per commit from a post-commit hook and stores them as
 * JSON Lines in a `traces.jsonl` file, in the tree of a commit pointed to by
 *
 *   refs/agentdiff/traces/{branch}   per branch, pushed by developers ("/" in the branch is "%2F")
 *   refs/agentdiff/meta              consolidated by CI after merge
 *
 * A record names its commit in `vcs.revision` and lists, per file, the lines that commit added:
 *
 *   {"version":"0.1.0","id":"…","vcs":{"type":"git","revision":"<sha>"},"tool":{"name":"claude-code"},
 *    "files":[{"path":"src/auth.rs","conversations":[
 *      {"contributor":{"type":"ai","model_id":"anthropic/claude-sonnet-4-6"},
 *       "ranges":[{"start_line":17,"end_line":20}]}]}]}
 *
 * Line numbers are 1-indexed, inclusive, and refer to the file at that commit, which is what
 * `git blame` reports as the original line. That makes a trace interchangeable with a git-ai
 * authorship log for our purposes.
 *
 * Everything here leans towards "AI": only the contributor type `human` is human, a record we cannot
 * read is an error instead of a skipped line, and where two records disagree about a line the one
 * that says AI wins. Signatures (`sig`) are not verified.
 */
import type { AuthorshipEntry } from './gitai.js';
import { git } from './git.js';
import { countLines } from './ranges.js';
import { knownAgentTool } from './trailers.js';
import type { AgentId, LineRange } from './types.js';

export const AGENTDIFF_META_REF = 'refs/agentdiff/meta';
export const AGENTDIFF_TRACES_PREFIX = 'refs/agentdiff/traces';
export const AGENTDIFF_TRACE_FILE = 'traces.jsonl';

/** Trace entries per file path, keyed by the full sha of the commit the trace describes. */
export type AgentdiffTraces = Map<string, Map<string, AuthorshipEntry[]>>;

const COMMIT_SHA = /^[0-9a-f]{40,64}$/;

/**
 * Parses the contents of a `traces.jsonl` file into `into`. Records for the same commit, from this or
 * an earlier call, are merged.
 *
 * Records that are not tied to a git commit are skipped: they cannot be matched to a blamed line, so
 * the commit they meant is handled as if agentdiff had recorded nothing about it.
 */
export function parseAgentdiffTraces(jsonl: string, into: AgentdiffTraces = new Map(), origin = AGENTDIFF_TRACE_FILE): AgentdiffTraces {
  const lines = jsonl.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (text.trim().length === 0) {
      continue;
    }
    const where = `${origin} line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`agentdiff trace at ${where} is not valid JSON: ${(error as Error).message}`);
    }
    if (!isObject(raw)) {
      throw new Error(`agentdiff trace at ${where} is not a JSON object`);
    }
    if (typeof raw['version'] !== 'string' || !raw['version'].startsWith('0.')) {
      throw new Error(`agentdiff trace at ${where} has unsupported version ${JSON.stringify(raw['version'])}`);
    }

    const vcs = raw['vcs'];
    if (!isObject(vcs) || vcs['type'] !== 'git' || typeof vcs['revision'] !== 'string') {
      continue;
    }
    const sha = vcs['revision'].toLowerCase();
    if (!COMMIT_SHA.test(sha)) {
      continue;
    }

    if (!Array.isArray(raw['files'])) {
      throw new Error(`agentdiff trace at ${where} has no "files" array`);
    }
    const key = typeof raw['id'] === 'string' ? raw['id'] : sha;
    const tool = isObject(raw['tool']) && typeof raw['tool']['name'] === 'string' ? raw['tool']['name'] : undefined;

    let files = into.get(sha);
    if (!files) {
      files = new Map();
      into.set(sha, files);
    }
    for (const file of raw['files'] as unknown[]) {
      if (!isObject(file) || typeof file['path'] !== 'string' || !Array.isArray(file['conversations'])) {
        throw new Error(`agentdiff trace at ${where} has a file entry without "path" and "conversations"`);
      }
      let entries = files.get(file['path']);
      if (!entries) {
        entries = [];
        files.set(file['path'], entries);
      }
      for (const conversation of file['conversations'] as unknown[]) {
        if (!isObject(conversation) || !Array.isArray(conversation['ranges'])) {
          throw new Error(`agentdiff trace at ${where} has a conversation without "ranges"`);
        }
        for (const range of conversation['ranges'] as unknown[]) {
          if (!isObject(range)) {
            throw new Error(`agentdiff trace at ${where} has a range that is not an object`);
          }
          const lineRange = toLineRange(range, where);
          // A range may carry its own contributor, which overrides the conversation's.
          const contributor = isObject(range['contributor']) ? range['contributor'] : conversation['contributor'];
          entries.push(toEntry(key, contributor, tool, lineRange));
        }
      }
    }
  }
  return into;
}

/**
 * Reads every agentdiff trace available in the local repository: the consolidated store and all
 * per-branch refs. A pull request's traces live in its branch ref until CI consolidates them, and a
 * record is keyed by commit, so reading other branches' refs as well only adds records for commits
 * that are not in the range under review. Returns an empty map when the repository has no agentdiff refs.
 */
export async function readAgentdiffTraces(repo: string): Promise<AgentdiffTraces> {
  const traces: AgentdiffTraces = new Map();
  // Ref names cannot contain newlines or other control characters, so line splitting is exact here.
  const listed = await git(repo, ['for-each-ref', '--format=%(refname)', AGENTDIFF_META_REF, AGENTDIFF_TRACES_PREFIX]);
  for (const ref of listed.split('\n').filter((line) => line.length > 0)) {
    // ls-tree prints nothing for a tree without the file, and fails for a ref that is not a tree-ish.
    const entry = await git(repo, ['ls-tree', '-z', ref, '--', AGENTDIFF_TRACE_FILE]);
    if (entry.length === 0) {
      continue;
    }
    parseAgentdiffTraces(await git(repo, ['show', `${ref}:${AGENTDIFF_TRACE_FILE}`]), traces, `${ref}:${AGENTDIFF_TRACE_FILE}`);
  }
  return traces;
}

/**
 * The entry that decides a line: an AI entry covering it if there is one, otherwise a human entry,
 * otherwise nothing (the trace does not mention the line).
 */
export function findTraceEntry(entries: readonly AuthorshipEntry[] | undefined, lineNumber: number): AuthorshipEntry | undefined {
  let human: AuthorshipEntry | undefined;
  for (const entry of entries ?? []) {
    if (!entry.ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end)) {
      continue;
    }
    if (entry.kind === 'ai') {
      return entry;
    }
    human ??= entry;
  }
  return human;
}

function toLineRange(range: Record<string, unknown>, where: string): LineRange {
  const start = range['start_line'];
  const end = range['end_line'];
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`agentdiff trace at ${where} has an invalid line range ${JSON.stringify({ start_line: start, end_line: end })}`);
  }
  return { start, end };
}

function toEntry(key: string, contributor: unknown, tool: string | undefined, range: LineRange): AuthorshipEntry {
  const type = isObject(contributor) ? contributor['type'] : undefined;
  const base = { key, ranges: [range], lineCount: countLines([range]) };
  // "mixed" (AI output a human edited, or the reverse), "unknown" and anything unrecognised involve
  // an agent or cannot rule one out.
  if (type === 'human') {
    return { ...base, kind: 'human' };
  }
  const modelId = isObject(contributor) && typeof contributor['model_id'] === 'string' ? contributor['model_id'] : undefined;
  return { ...base, kind: 'ai', agent: toAgentId(tool, modelId) };
}

function toAgentId(tool: string | undefined, modelId: string | undefined): AgentId {
  const name = tool?.trim() ?? '';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Agent Trace writes models as "provider/model-name"; policies match on the model name.
  const model = (modelId ?? '').slice((modelId ?? '').lastIndexOf('/') + 1).trim();
  return {
    tool: knownAgentTool(name) ?? (slug.length > 0 ? slug : 'unknown'),
    ...(model.length > 0 && model.toLowerCase() !== 'unknown' ? { model } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
