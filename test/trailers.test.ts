import { describe, expect, it } from 'vitest';

import { detectAgentsFromMessage, parseTrailers } from '../src/provenance/trailers.js';

describe('parseTrailers', () => {
  it('reads the trailing block only', () => {
    const message = `Add login\n\nThis body has a Note: that is not a trailer.\n\nCo-authored-by: Claude <noreply@anthropic.com>\nSigned-off-by: Dev <dev@example.com>\n`;
    expect(parseTrailers(message)).toEqual([
      { token: 'co-authored-by', value: 'Claude <noreply@anthropic.com>' },
      { token: 'signed-off-by', value: 'Dev <dev@example.com>' },
    ]);
  });

  it('returns nothing when the last paragraph is prose', () => {
    expect(parseTrailers('Fix bug\n\nSome explanation: with a colon but also words.\nAnd a second line.')).toEqual([]);
    expect(parseTrailers('')).toEqual([]);
  });
});

describe('detectAgentsFromMessage', () => {
  it('recognises Claude Code with a model in the display name', () => {
    const agents = detectAgentsFromMessage('feat: x\n\nCo-authored-by: Claude Opus 4.1 <noreply@anthropic.com>');
    expect(agents).toEqual([{ tool: 'claude', model: 'Claude Opus 4.1' }]);
  });

  it('recognises Cursor, Copilot, Codex and Gemini identities', () => {
    expect(detectAgentsFromMessage('x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>')).toEqual([{ tool: 'cursor' }]);
    expect(detectAgentsFromMessage('x\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>')).toEqual([
      { tool: 'copilot' },
    ]);
    expect(detectAgentsFromMessage('x\n\nAgent: codex\nAI-Model: gpt-5-codex')).toEqual([{ tool: 'codex', model: 'gpt-5-codex' }]);
    expect(detectAgentsFromMessage('x\n\nGenerated-by: Gemini CLI')).toEqual([{ tool: 'gemini', model: 'Gemini CLI' }]);
  });

  it('ignores human co-authors and plain commits', () => {
    expect(detectAgentsFromMessage('x\n\nCo-authored-by: Alice <alice@example.com>')).toEqual([]);
    expect(detectAgentsFromMessage('plain commit message')).toEqual([]);
  });

  it('accepts explicit agent trailers for unknown tools', () => {
    expect(detectAgentsFromMessage('x\n\nAgent: My In-House Bot')).toEqual([{ tool: 'my-in-house-bot', model: 'My In-House Bot' }]);
  });

  it('dedupes repeated trailers', () => {
    const agents = detectAgentsFromMessage(
      'x\n\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: Claude <noreply@anthropic.com>',
    );
    expect(agents).toEqual([{ tool: 'claude' }]);
  });
});
