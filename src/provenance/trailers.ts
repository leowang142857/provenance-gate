/**
 * Commit-level provenance fallback.
 *
 * When a commit has no git-ai authorship log we look at its message trailers.
 * Most coding agents add a `Co-authored-by:` trailer with a recognisable identity,
 * and some teams add explicit `Agent:` / `AI-Model:` trailers. This only tells us
 * that an agent was involved in the commit, not which lines it wrote.
 */
import type { AgentId } from './types.js';

export interface Trailer {
  token: string;
  value: string;
}

const AGENT_TRAILER_TOKENS = new Set([
  'co-authored-by',
  'generated-by',
  'ai-agent',
  'agent',
  'assisted-by',
  'ai-assisted-by',
]);

const MODEL_TRAILER_TOKENS = new Set(['ai-model', 'model']);

interface KnownAgent {
  pattern: RegExp;
  tool: string;
}

const KNOWN_AGENTS: KnownAgent[] = [
  { pattern: /noreply@anthropic\.com|\bclaude\b/i, tool: 'claude' },
  { pattern: /cursoragent@cursor\.com|\bcursor\b/i, tool: 'cursor' },
  { pattern: /\bcopilot\b/i, tool: 'copilot' },
  { pattern: /\bcodex\b|noreply@openai\.com|\bchatgpt\b/i, tool: 'codex' },
  { pattern: /\bgemini\b|\bjules\b/i, tool: 'gemini' },
  { pattern: /\bdevin\b/i, tool: 'devin' },
  { pattern: /\bopencode\b/i, tool: 'opencode' },
  { pattern: /\baider\b/i, tool: 'aider' },
  { pattern: /\bwindsurf\b|\bcascade\b/i, tool: 'windsurf' },
  { pattern: /\bamp\b.*sourcegraph|sourcegraph.*\bamp\b/i, tool: 'amp' },
  { pattern: /\bdeepseek\b/i, tool: 'deepseek' },
  { pattern: /\bqwen\b|\btongyi\b|\blingma\b/i, tool: 'qwen' },
  { pattern: /\bkimi\b/i, tool: 'kimi' },
];

const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/;

/**
 * Extracts trailers from the final paragraph of a commit message, following
 * git's interpretation: a trailing block where every line is `Token: value`.
 */
export function parseTrailers(message: string): Trailer[] {
  const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/);
  const last = paragraphs[paragraphs.length - 1];
  if (!last) {
    return [];
  }
  const trailers: Trailer[] = [];
  for (const line of last.split('\n')) {
    const match = TRAILER_LINE.exec(line);
    if (!match) {
      return [];
    }
    trailers.push({ token: (match[1] ?? '').toLowerCase(), value: match[2] ?? '' });
  }
  return trailers;
}

/** Returns the agents a commit message declares via trailers. Empty when none are recognised. */
export function detectAgentsFromMessage(message: string): AgentId[] {
  const trailers = parseTrailers(message);
  const agents = new Map<string, AgentId>();
  let explicitModel: string | undefined;

  for (const trailer of trailers) {
    if (MODEL_TRAILER_TOKENS.has(trailer.token)) {
      explicitModel = trailer.value;
    }
  }

  for (const trailer of trailers) {
    if (!AGENT_TRAILER_TOKENS.has(trailer.token)) {
      continue;
    }
    const tool = matchKnownAgent(trailer.value) ?? (trailer.token === 'co-authored-by' ? undefined : slug(trailer.value));
    if (!tool) {
      continue;
    }
    const model = explicitModel ?? inferModel(trailer.value, tool);
    const agent: AgentId = { tool, ...(model ? { model } : {}) };
    agents.set(`${tool}/${model ?? ''}`, agent);
  }

  return [...agents.values()];
}

function matchKnownAgent(value: string): string | undefined {
  for (const known of KNOWN_AGENTS) {
    if (known.pattern.test(value)) {
      return known.tool;
    }
  }
  return undefined;
}

/**
 * `Co-authored-by: Claude Opus 4.1 <noreply@anthropic.com>` carries a model name in the
 * display-name part. We keep it when it is more specific than the bare tool name.
 */
function inferModel(value: string, tool: string): string | undefined {
  const name = value.split('<')[0]?.trim() ?? '';
  if (name.length === 0) {
    return undefined;
  }
  if (name.toLowerCase() === tool) {
    return undefined;
  }
  if (/^(cursor agent|github copilot|copilot|codex|gemini|devin|opencode|aider|windsurf|claude)$/i.test(name)) {
    return undefined;
  }
  return name;
}

function slug(value: string): string {
  const name = value.split('<')[0]?.trim() ?? value;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}
