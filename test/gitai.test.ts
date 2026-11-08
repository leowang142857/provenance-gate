import { describe, expect, it } from 'vitest';

import { isAuthorshipLog, parseAuthorshipLog } from '../src/provenance/gitai.js';
import { countLines, parseLineRanges } from '../src/provenance/ranges.js';

const SESSIONS_NOTE = `src/main.rs
  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10,15-20
  s_c9883b05a2487d::t_a1b2c3d4e5f678 25,30-35
  h_31dce776f88375 42-50
src/lib.rs
  s_e7f2a90b31cc48::t_deadbeef012345 1-50
---
{
  "schema_version": "authorship/3.0.0",
  "git_ai_version": "1.4.5",
  "base_commit_sha": "7734793b756b3921c88db5375a8c156e9532447b",
  "prompts": {},
  "humans": {
    "h_31dce776f88375": { "author": "Developer <dev@example.com>" }
  },
  "sessions": {
    "s_c9883b05a2487d": {
      "agent_id": { "tool": "cursor", "id": "6ef2299e", "model": "claude-sonnet-4-5-20250514" },
      "human_author": "dev@example.com"
    },
    "s_e7f2a90b31cc48": {
      "agent_id": { "tool": "claude", "id": "conv_abc123def456", "model": "claude-sonnet-4-5-20250514" },
      "human_author": "dev@example.com",
      "custom_attributes": { "team": "backend" }
    }
  }
}`;

const LEGACY_NOTE = `src/main.rs
  abcd1234abcd1234 1-10,15-20
  ef0b5678ef0b5678 25,30-35
"src/with space.rs"
  abcd1234abcd1234 1-50
---
{
  "schema_version": "authorship/3.0.0",
  "git_ai_version": "1.0.23",
  "base_commit_sha": "7734793b756b3921c88db5375a8c156e9532447b",
  "prompts": {
    "abcd1234abcd1234": {
      "agent_id": { "tool": "cursor", "id": "6ef2299e", "model": "claude-4.5-opus" },
      "human_author": "Developer <dev@example.com>",
      "total_additions": 25, "total_deletions": 5, "accepted_lines": 20, "overriden_lines": 0
    },
    "ef0b5678ef0b5678": {
      "agent_id": { "tool": "cursor", "id": "a1b2c3d4", "model": "claude-3-sonnet" },
      "human_author": "Developer <dev@example.com>",
      "total_additions": 6, "total_deletions": 0, "accepted_lines": 6, "overriden_lines": 0
    }
  }
}`;

describe('parseLineRanges', () => {
  it('parses singles and ranges', () => {
    const ranges = parseLineRanges('1-4,9-10,12,14,16');
    expect(ranges).toEqual([
      { start: 1, end: 4 },
      { start: 9, end: 10 },
      { start: 12, end: 12 },
      { start: 14, end: 14 },
      { start: 16, end: 16 },
    ]);
    expect(countLines(ranges)).toBe(9);
  });

  it('rejects malformed specifications', () => {
    expect(() => parseLineRanges('')).toThrow();
    expect(() => parseLineRanges('0')).toThrow();
    expect(() => parseLineRanges('5-3')).toThrow();
    expect(() => parseLineRanges('1, 2')).toThrow();
    expect(() => parseLineRanges('a-b')).toThrow();
  });
});

describe('parseAuthorshipLog', () => {
  it('parses the sessions + known-human format', () => {
    const log = parseAuthorshipLog(SESSIONS_NOTE);
    expect(log.schemaVersion).toBe('authorship/3.0.0');
    expect(log.gitAiVersion).toBe('1.4.5');
    expect(log.files.map((f) => f.path)).toEqual(['src/main.rs', 'src/lib.rs']);

    const main = log.files[0]!;
    expect(main.entries).toHaveLength(3);
    expect(main.entries[0]).toMatchObject({
      kind: 'ai',
      sessionId: 's_c9883b05a2487d',
      lineCount: 16,
      agent: { tool: 'cursor', model: 'claude-sonnet-4-5-20250514' },
      humanAuthor: 'dev@example.com',
    });
    expect(main.entries[1]).toMatchObject({ kind: 'ai', lineCount: 7 });
    expect(main.entries[2]).toMatchObject({ kind: 'human', lineCount: 9, humanAuthor: 'Developer <dev@example.com>' });

    const lib = log.files[1]!;
    expect(lib.entries[0]).toMatchObject({ kind: 'ai', lineCount: 50, agent: { tool: 'claude' } });
    expect(log.unresolvedKeys).toEqual([]);
  });

  it('parses the legacy format and quoted paths', () => {
    const log = parseAuthorshipLog(LEGACY_NOTE);
    expect(log.files.map((f) => f.path)).toEqual(['src/main.rs', 'src/with space.rs']);
    expect(log.files[0]!.entries[0]).toMatchObject({
      kind: 'ai',
      key: 'abcd1234abcd1234',
      lineCount: 16,
      agent: { tool: 'cursor', model: 'claude-4.5-opus' },
    });
    expect(log.files[1]!.entries[0]!.lineCount).toBe(50);
  });

  it('keeps counting AI lines when a key has no metadata record', () => {
    const note = `src/a.ts\n  s_0000000000000a::t_0000000000000b 1-3\n---\n{"schema_version":"authorship/3.0.0","prompts":{}}`;
    const log = parseAuthorshipLog(note);
    expect(log.unresolvedKeys).toEqual(['s_0000000000000a::t_0000000000000b']);
    expect(log.files[0]!.entries[0]).toMatchObject({ kind: 'ai', lineCount: 3, agent: { tool: 'unknown' } });
  });

  it('handles CRLF and empty attestation sections', () => {
    const note = `---\r\n{"schema_version":"authorship/3.0.0","prompts":{},"base_commit_sha":"abc"}\r\n`;
    const log = parseAuthorshipLog(note);
    expect(log.files).toEqual([]);
    expect(log.baseCommitSha).toBe('abc');
  });

  it('rejects notes that are not authorship logs', () => {
    expect(isAuthorshipLog('just a plain note')).toBe(false);
    expect(() => parseAuthorshipLog('just a plain note')).toThrow(/divider/);
    expect(() => parseAuthorshipLog('---\n{not json')).toThrow(/JSON/);
    expect(() => parseAuthorshipLog('---\n{"schema_version":"other/1.0"}')).toThrow(/schema_version/);
    expect(() => parseAuthorshipLog('src/a.ts\n  zz 1-2\n---\n{"schema_version":"authorship/3.0.0","prompts":{}}')).toThrow(
      /unrecognised attestation key/,
    );
  });
});
