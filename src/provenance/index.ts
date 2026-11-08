export * from './types.js';
export { parseLineRanges, countLines } from './ranges.js';
export { parseAuthorshipLog, isAuthorshipLog } from './gitai.js';
export type { AuthorshipLog, AuthorshipFile, AuthorshipEntry } from './gitai.js';
export { parseTrailers, detectAgentsFromMessage } from './trailers.js';
export { collectProvenance, DEFAULT_NOTES_REF } from './collect.js';
export type { CollectOptions } from './collect.js';
