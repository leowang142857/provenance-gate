import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync('git', args, { cwd: this.dir });
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
    await this.git('notes', `--ref=${ref}`, 'add', '-F', notePath, sha);
    await rm(notePath, { force: true });
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
