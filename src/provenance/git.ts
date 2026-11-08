import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: repo, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    throw new GitError(`git ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`, args, err.stderr ?? '');
  }
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return (await git(repo, ['merge-base', a, b])).trim();
}

/** Commits reachable from `head` but not from `base`, oldest first. */
export async function listCommits(repo: string, base: string, head: string): Promise<string[]> {
  const out = await git(repo, ['rev-list', '--reverse', `${base}..${head}`]);
  return out.split('\n').filter((line) => line.length > 0);
}

export async function readNote(repo: string, sha: string, notesRef: string): Promise<string | null> {
  try {
    return await git(repo, ['notes', `--ref=${notesRef}`, 'show', sha]);
  } catch (error) {
    if (error instanceof GitError && /no note found/i.test(error.stderr)) {
      return null;
    }
    throw error;
  }
}

export async function commitMessage(repo: string, sha: string): Promise<string> {
  return git(repo, ['log', '-1', '--format=%B', sha]);
}

export async function commitAuthor(repo: string, sha: string): Promise<string> {
  return (await git(repo, ['log', '-1', '--format=%an <%ae>', sha])).trim();
}

/** Files changed by a single commit. Merge commits yield no files (we only read their resolution via notes). */
export async function commitChangedFiles(repo: string, sha: string): Promise<string[]> {
  const out = await git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
  return out.split('\n').filter((line) => line.length > 0);
}

export interface BlamedLine {
  /** Commit that introduced the line. */
  sha: string;
  /** Line number in that commit's version of the file. */
  origLine: number;
  /** Path of the file in that commit (differs from the head path after renames). */
  origPath: string;
  /** True when the line predates `from` (unchanged by the range). */
  boundary: boolean;
}

/**
 * Blames every line of `path` at `to`, limited to commits in `from..to`.
 * Lines older than the range are marked `boundary`.
 */
export async function blameRange(repo: string, from: string, to: string, path: string): Promise<BlamedLine[]> {
  const out = await git(repo, ['blame', '--line-porcelain', `${from}..${to}`, '--', path]);
  const lines: BlamedLine[] = [];
  let current: BlamedLine | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      if (current) {
        lines.push(current);
      }
      current = undefined;
      continue;
    }
    if (!current) {
      const [sha, origLine] = line.split(' ');
      if (sha && /^[0-9a-f]{40,64}$/.test(sha)) {
        current = { sha, origLine: Number(origLine), origPath: path, boundary: false };
      }
      continue;
    }
    if (line === 'boundary') {
      current.boundary = true;
    } else if (line.startsWith('filename ')) {
      current.origPath = unquoteGitPath(line.slice('filename '.length));
    }
  }
  return lines;
}

function unquoteGitPath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return JSON.parse(path) as string;
  }
  return path;
}

export interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
}

/** Added / deleted line counts for every file between two commits. Binary files report 0/0. */
export async function diffNumstat(repo: string, from: string, to: string): Promise<NumstatEntry[]> {
  const out = await git(repo, ['diff', '--numstat', '--no-renames', from, to]);
  const entries: NumstatEntry[] = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const [added, deleted, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) {
      continue;
    }
    entries.push({
      path,
      added: added === '-' ? 0 : Number(added),
      deleted: deleted === '-' ? 0 : Number(deleted),
    });
  }
  return entries;
}
