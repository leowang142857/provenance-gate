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

export interface GitOptions {
  /** Extra environment variables. Use for secrets: unlike args, they never appear in GitError messages. */
  env?: Record<string, string>;
}

export async function git(repo: string, args: string[], options: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repo,
      maxBuffer: MAX_BUFFER,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
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
  const out = await git(repo, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha]);
  return out.split('\0').filter((path) => path.length > 0);
}

/** Environment that makes git send `Authorization: Basic x-access-token:<token>` to HTTPS remotes. */
export function gitTokenEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  };
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

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Decodes git's C-style quoted paths, including octal-escaped UTF-8 bytes (core.quotePath). */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? '';
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next] ?? 0);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface NumstatEntry {
  path: string;
  /** Source path when git detected a rename or copy. */
  previousPath?: string;
  added: number;
  deleted: number;
}

/**
 * Added / deleted line counts for every file between two commits, with rename detection so a
 * moved file reports only the lines that actually changed. Binary files report 0/0.
 */
export async function diffNumstat(repo: string, from: string, to: string): Promise<NumstatEntry[]> {
  const out = await git(repo, ['diff', '--numstat', '-z', '-M', from, to]);
  const fields = out.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? '';
    if (field.length === 0) {
      continue;
    }
    const [added = '-', deleted = '-', path = ''] = field.split('\t');
    const counts = { added: added === '-' ? 0 : Number(added), deleted: deleted === '-' ? 0 : Number(deleted) };
    if (path.length > 0) {
      entries.push({ path, ...counts });
      continue;
    }
    // Renames are written as "added\tdeleted\t\0old\0new\0".
    const previousPath = fields[i + 1] ?? '';
    const newPath = fields[i + 2] ?? '';
    i += 2;
    if (newPath.length > 0) {
      entries.push({ path: newPath, previousPath, ...counts });
    }
  }
  return entries;
}
