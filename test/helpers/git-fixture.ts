import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Ignore user/system git config so tools hooked into git (e.g. git-ai's trace2 daemon)
// cannot attach their own notes to fixture commits.
const HERMETIC_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export class GitFixture {
  private constructor(public readonly dir: string) {}

  static async create(): Promise<GitFixture> {
    const dir = await mkdtemp(join(tmpdir(), 'provenance-gate-test-'));
    const fixture = new GitFixture(dir);
    await fixture.git('init', '--quiet', '--initial-branch=main');
    await fixture.git('config', 'user.name', 'Test User');
    await fixture.git('config', 'user.email', 'test@example.com');
    await fixture.git('config', 'commit.gpgsign', 'false');
    return fixture;
  }

  async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.dir, env: HERMETIC_ENV });
    return stdout.trim();
  }

  async write(path: string, content: string): Promise<void> {
    const full = join(this.dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  async commit(message: string, files: Record<string, string>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      await this.write(path, content);
    }
    await this.git('add', '-A');
    await this.git('commit', '--quiet', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  async addNote(sha: string, note: string, ref = 'ai'): Promise<void> {
    const notePath = join(this.dir, '..', `note-${sha.slice(0, 8)}.txt`);
    await writeFile(notePath, note, 'utf8');
    await this.git('notes', `--ref=${ref}`, 'add', '-f', '-F', notePath, sha);
    await rm(notePath, { force: true });
  }

  /**
   * Stores agentdiff trace records the way agentdiff does: as `traces.jsonl` in the tree of a commit
   * that `ref` points to. A temporary index keeps the working tree and the real index untouched.
   */
  async addAgentdiffTraces(records: unknown[], ref = 'refs/agentdiff/meta'): Promise<void> {
    const scratch = await mkdtemp(join(tmpdir(), 'provenance-gate-traces-'));
    try {
      const file = join(scratch, 'traces.jsonl');
      await writeFile(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
      const blob = await this.git('hash-object', '-w', file);
      const env = { ...HERMETIC_ENV, GIT_INDEX_FILE: join(scratch, 'index') };
      await execFileAsync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},traces.jsonl`], { cwd: this.dir, env });
      const tree = (await execFileAsync('git', ['write-tree'], { cwd: this.dir, env })).stdout.trim();
      const commit = await this.git('commit-tree', tree, '-m', 'agentdiff traces');
      await this.git('update-ref', ref, commit);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

export function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
}

export function authorshipNote(
  files: Array<{ path: string; entries: string[] }>,
  metadata: Record<string, unknown>,
): string {
  const attestation = files.flatMap((f) => [f.path, ...f.entries.map((e) => `  ${e}`)]).join('\n');
  return `${attestation}\n---\n${JSON.stringify({ schema_version: 'authorship/3.0.0', prompts: {}, ...metadata }, null, 2)}\n`;
}

/** An agentdiff (Agent Trace v0.1) record for one commit. */
export function agentdiffTrace(
  sha: string,
  files: Array<{ path: string; type: string; ranges: Array<[number, number]>; modelId?: string }>,
  tool = 'claude-code',
): Record<string, unknown> {
  return {
    version: '0.1.0',
    id: `trace-${sha.slice(0, 12)}-${files.map((f) => f.path).join('+')}`,
    timestamp: '2026-11-16T00:00:00Z',
    vcs: { type: 'git', revision: sha },
    tool: { name: tool },
    files: files.map((file) => ({
      path: file.path,
      conversations: [
        {
          contributor: { type: file.type, ...(file.modelId ? { model_id: file.modelId } : {}) },
          ranges: file.ranges.map(([start_line, end_line]) => ({ start_line, end_line })),
        },
      ],
    })),
  };
}
