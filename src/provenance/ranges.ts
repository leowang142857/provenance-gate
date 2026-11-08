import type { LineRange } from './types.js';

const SINGLE = /^\d+$/;
const RANGE = /^(\d+)-(\d+)$/;

/**
 * Parses a git-ai line range specification such as `1-4,9-10,12,14`.
 * Line numbers are 1-indexed and ranges are inclusive.
 */
export function parseLineRanges(spec: string): LineRange[] {
  if (spec.length === 0) {
    throw new Error('empty line range specification');
  }
  const ranges: LineRange[] = [];
  for (const part of spec.split(',')) {
    if (SINGLE.test(part)) {
      const n = Number(part);
      assertPositive(n, part);
      ranges.push({ start: n, end: n });
      continue;
    }
    const match = RANGE.exec(part);
    if (!match) {
      throw new Error(`invalid line range "${part}" in "${spec}"`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    assertPositive(start, part);
    if (end < start) {
      throw new Error(`descending line range "${part}" in "${spec}"`);
    }
    ranges.push({ start, end });
  }
  return ranges;
}

export function countLines(ranges: readonly LineRange[]): number {
  let total = 0;
  for (const range of ranges) {
    total += range.end - range.start + 1;
  }
  return total;
}

function assertPositive(n: number, raw: string): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`line numbers must be positive integers, got "${raw}"`);
  }
}
