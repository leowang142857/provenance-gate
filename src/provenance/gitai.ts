/**
 * Parser for Git AI Authorship Logs (Git AI Standard v3.0.0).
 *
 * A log lives in a git note under `refs/notes/ai` and has two sections separated
 * by a line containing exactly `---`:
 *
 *   src/main.rs
 *     s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10,15-20
 *     h_31dce776f88375 42-50
 *   ---
 *   { "schema_version": "authorship/3.0.0", ... }
 *
 * Attestation keys are routed by prefix: `s_` to `metadata.sessions`, `h_` to
 * `metadata.humans`, bare hex to the legacy `metadata.prompts` map.
 */
import { countLines, parseLineRanges } from './ranges.js';
import type { AgentId, LineRange } from './types.js';

export interface AuthorshipEntry {
  key: string;
  kind: 'ai' | 'human';
  ranges: LineRange[];
  lineCount: number;
  agent?: AgentId;
  humanAuthor?: string;
  sessionId?: string;
}

export interface AuthorshipFile {
  path: string;
  entries: AuthorshipEntry[];
}

export interface AuthorshipLog {
  schemaVersion: string;
  baseCommitSha?: string;
  gitAiVersion?: string;
  files: AuthorshipFile[];
  /** Attestation keys that had no matching metadata record. Still counted as AI. */
  unresolvedKeys: string[];
}

interface RawAgentId {
  tool?: unknown;
  model?: unknown;
  id?: unknown;
}

interface RawSession {
  agent_id?: RawAgentId;
  human_author?: unknown;
}

interface RawHuman {
  author?: unknown;
}

interface RawMetadata {
  schema_version?: unknown;
  base_commit_sha?: unknown;
  git_ai_version?: unknown;
  prompts?: Record<string, RawSession>;
  sessions?: Record<string, RawSession>;
  humans?: Record<string, RawHuman>;
}

const DIVIDER = '---';
const LEGACY_KEY = /^[0-9a-f]{7,16}$/i;

export function isAuthorshipLog(note: string): boolean {
  return note.split(/\r?\n/).some((line) => line === DIVIDER);
}

export function parseAuthorshipLog(note: string): AuthorshipLog {
  const lines = note.split(/\r?\n/);
  const dividerIndex = lines.indexOf(DIVIDER);
  if (dividerIndex === -1) {
    throw new Error('authorship log is missing the "---" divider');
  }

  const metadataText = lines.slice(dividerIndex + 1).join('\n').trim();
  let metadata: RawMetadata;
  try {
    metadata = JSON.parse(metadataText) as RawMetadata;
  } catch (error) {
    throw new Error(`authorship log metadata is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof metadata.schema_version !== 'string' || !metadata.schema_version.startsWith('authorship/')) {
    throw new Error(`unsupported authorship schema_version: ${String(metadata.schema_version)}`);
  }

  const sessions = metadata.sessions ?? {};
  const humans = metadata.humans ?? {};
  const prompts = metadata.prompts ?? {};
  const unresolvedKeys: string[] = [];
  const files: AuthorshipFile[] = [];
  let current: AuthorshipFile | undefined;

  for (const rawLine of lines.slice(0, dividerIndex)) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    if (rawLine.startsWith('  ')) {
      if (!current) {
        throw new Error(`attestation entry before any file path: "${rawLine}"`);
      }
      current.entries.push(parseEntry(rawLine.trim(), { sessions, humans, prompts }, unresolvedKeys));
      continue;
    }
    current = { path: unquotePath(rawLine), entries: [] };
    files.push(current);
  }

  return {
    schemaVersion: metadata.schema_version,
    ...(typeof metadata.base_commit_sha === 'string' ? { baseCommitSha: metadata.base_commit_sha } : {}),
    ...(typeof metadata.git_ai_version === 'string' ? { gitAiVersion: metadata.git_ai_version } : {}),
    files,
    unresolvedKeys,
  };
}

interface Lookup {
  sessions: Record<string, RawSession>;
  humans: Record<string, RawHuman>;
  prompts: Record<string, RawSession>;
}

function parseEntry(line: string, lookup: Lookup, unresolvedKeys: string[]): AuthorshipEntry {
  const space = line.indexOf(' ');
  if (space === -1) {
    throw new Error(`attestation entry is missing a line range: "${line}"`);
  }
  const key = line.slice(0, space);
  const ranges = parseLineRanges(line.slice(space + 1).trim());
  const lineCount = countLines(ranges);

  if (key.startsWith('s_')) {
    const sessionId = key.split('::')[0] ?? key;
    const session = lookup.sessions[sessionId];
    if (!session) {
      unresolvedKeys.push(key);
    }
    return {
      key,
      kind: 'ai',
      ranges,
      lineCount,
      sessionId,
      agent: toAgentId(session?.agent_id),
      ...(typeof session?.human_author === 'string' ? { humanAuthor: session.human_author } : {}),
    };
  }

  if (key.startsWith('h_')) {
    const human = lookup.humans[key];
    if (!human) {
      unresolvedKeys.push(key);
    }
    return {
      key,
      kind: 'human',
      ranges,
      lineCount,
      ...(typeof human?.author === 'string' ? { humanAuthor: human.author } : {}),
    };
  }

  if (!LEGACY_KEY.test(key)) {
    throw new Error(`unrecognised attestation key "${key}"`);
  }
  const prompt = lookup.prompts[key];
  if (!prompt) {
    unresolvedKeys.push(key);
  }
  return {
    key,
    kind: 'ai',
    ranges,
    lineCount,
    agent: toAgentId(prompt?.agent_id),
    ...(typeof prompt?.human_author === 'string' ? { humanAuthor: prompt.human_author } : {}),
  };
}

function toAgentId(raw: RawAgentId | undefined): AgentId {
  const tool = typeof raw?.tool === 'string' && raw.tool.length > 0 ? raw.tool.toLowerCase() : 'unknown';
  const model = typeof raw?.model === 'string' ? raw.model.trim() : '';
  return {
    tool,
    ...(model.length > 0 && model.toLowerCase() !== 'unknown' ? { model } : {}),
    ...(typeof raw?.id === 'string' && raw.id.length > 0 ? { id: raw.id } : {}),
  };
}

function unquotePath(line: string): string {
  if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
    return line.slice(1, -1);
  }
  return line;
}
