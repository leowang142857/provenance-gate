export * from './types.js';
export { parseLineRanges, countLines } from './ranges.js';
export { parseAuthorshipLog, isAuthorshipLog } from './gitai.js';
export type { AuthorshipLog, AuthorshipFile, AuthorshipEntry } from './gitai.js';
export { parseAgentdiffTraces, readAgentdiffTraces, AGENTDIFF_META_REF, AGENTDIFF_TRACES_PREFIX } from './agentdiff.js';
export type { AgentdiffTraces } from './agentdiff.js';
export { parseTrailers, detectAgentsFromMessage } from './trailers.js';
export { collectProvenance, DEFAULT_NOTES_REF } from './collect.js';
export type { CollectOptions } from './collect.js';
