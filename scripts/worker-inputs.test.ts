import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { snapshotWorkerInputs, verifyWorkerInputs, rejectWorkerInputPaths } from './worker-inputs';

function fixture(ignore = '.shawshank/runs/\n') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worker-inputs-')));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', repo, ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q');
  writeFileSync(join(repo, '.gitignore'), ignore);
  git('add', '.gitignore');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Baseline');
  const source = join(root, 'brief.md'); writeFileSync(source, 'Approved input');
  const run = join(repo, '.shawshank/runs/test');
  const snapshot = (worktree = repo) => snapshotWorkerInputs(worktree, run, 'brief', { 'brief.md': source });
  return { root, repo, git, source, run, snapshot };
}

test('worker inputs reuse existing ignore rules and pin original bytes across source edits', () => {
  const f = fixture('.shawshank/runs/\n.shawshank/inputs/\n');
  const exclude = join(f.repo, '.git/info/exclude'), before = readFileSync(exclude, 'utf8');
  const files = f.snapshot();
  writeFileSync(f.source, 'Later unapproved source');
  expect(f.snapshot()).toEqual(files);
  expect(readFileSync(files['brief.md'], 'utf8')).toBe('Approved input');
  expect(readFileSync(exclude, 'utf8')).toBe(before);
  expect(f.git('status', '--porcelain')).toBe('');
  chmodSync(files['brief.md'], 0o644); writeFileSync(files['brief.md'], 'Changed copy');
  expect(() => verifyWorkerInputs(f.repo, f.run)).toThrow('snapshot changed');
  expect(() => f.snapshot()).toThrow('snapshot changed');
});

test('linked worktree gets local copies and a resolved exclude rule without tracked edits', () => {
  const f = fixture();
  const linked = join(f.root, 'linked'); f.git('worktree', 'add', '--detach', linked);
  const before = readFileSync(join(f.repo, '.gitignore'), 'utf8');
  const files = f.snapshot(linked);
  expect(relative(linked, files['brief.md']).startsWith('.shawshank/inputs/')).toBe(true);
  expect(existsSync(join(f.repo, relative(linked, files['brief.md'])))).toBe(false);
  expect(readFileSync(join(f.repo, '.git/info/exclude'), 'utf8')).toContain('/.shawshank/inputs/');
  expect(readFileSync(join(f.repo, '.gitignore'), 'utf8')).toBe(before);
  const exclude = readFileSync(join(f.repo, '.git/info/exclude'), 'utf8');
  f.snapshot(linked);
  expect(readFileSync(join(f.repo, '.git/info/exclude'), 'utf8')).toBe(exclude);
  expect(Bun.spawnSync(['git', '-C', linked, 'status', '--porcelain']).stdout.toString()).toBe('');
  verifyWorkerInputs(linked, f.run);
});

test('worker inputs reject symlink escapes, tracked collisions, and lost ignores', () => {
  const f = fixture();
  mkdirSync(join(f.repo, '.shawshank'));
  symlinkSync(join(f.root, 'missing'), join(f.repo, '.shawshank/inputs'));
  expect(() => f.snapshot()).toThrow('symlink');
  const g = fixture();
  const files = g.snapshot();
  g.git('add', '-f', files['brief.md']);
  expect(() => verifyWorkerInputs(g.repo, g.run)).toThrow('must not be tracked');
  const h = fixture(); h.snapshot();
  writeFileSync(join(h.repo, '.git/info/exclude'), '');
  expect(() => verifyWorkerInputs(h.repo, h.run)).toThrow('no longer ignored');
  const j = fixture('.shawshank/runs/\n!.shawshank/inputs/\n');
  expect(() => j.snapshot()).toThrow('not ignored');
  const exclude = readFileSync(join(j.repo, '.git/info/exclude'), 'utf8');
  expect(() => j.snapshot()).toThrow('not ignored');
  expect(readFileSync(join(j.repo, '.git/info/exclude'), 'utf8')).toBe(exclude);
});

test('explicit instruction layout preserves linked paths without crawling other resources', () => {
  const f = fixture();
  const sources = { 'references/role.md': f.source, 'references/checklist.md': f.source };
  const files = snapshotWorkerInputs(f.repo, f.run, 'instructions', sources);
  expect(readFileSync(join(files['references/role.md'], '../checklist.md'), 'utf8')).toBe('Approved input');
  expect(existsSync(join(files['references/role.md'], '../../SKILL.md'))).toBe(false);
  expect(() => snapshotWorkerInputs(f.repo, f.run, 'instructions', { ...sources, 'SKILL.md': f.source })).toThrow('contract changed');
  expect(() => snapshotWorkerInputs(f.repo, f.run, 'bad', { '../outside': f.source })).toThrow('Invalid');
});

test('missing retained snapshots and symlinked excludes fail without refreshing or editing tracked files', () => {
  const f = fixture(); const files = f.snapshot();
  const dispatch = join(f.run, 'dispatch.md'); writeFileSync(dispatch, `Read ${files['brief.md']}`);
  renameSync(join(f.run, 'worker-inputs'), join(f.run, 'preserved-inputs'));
  expect(() => verifyWorkerInputs(f.repo, f.run, dispatch)).toThrow();
  expect(() => f.snapshot()).toThrow('Incomplete');
  const g = fixture(); const exclude = join(g.repo, '.git/info/exclude');
  renameSync(exclude, exclude + '.original');
  symlinkSync(join(g.repo, '.gitignore'), exclude);
  const before = readFileSync(join(g.repo, '.gitignore'), 'utf8');
  expect(() => g.snapshot()).toThrow('symlinked Git exclude');
  expect(readFileSync(join(g.repo, '.gitignore'), 'utf8')).toBe(before);
  expect(g.git('status', '--porcelain')).toBe('');
});

test('existing commit walks can reject snapshot additions even after later deletion', () => {
  const f = fixture(); const files = f.snapshot(); const base = f.git('rev-parse', 'HEAD');
  f.git('add', '-f', files['brief.md']);
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Accidental snapshot');
  f.git('rm', '-f', files['brief.md']);
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Remove snapshot');
  expect(f.git('diff', '--name-only', `${base}..HEAD`)).toBe('');
  for (const commit of f.git('rev-list', `${base}..HEAD`).split('\n')) {
    const changed = f.git('diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit).split('\0').filter(Boolean);
    expect(() => rejectWorkerInputPaths(changed)).toThrow('must not be tracked or committed');
  }
});

test('snapshot enumeration ignores Finder files, unrelated directories and hash-named plain files', () => {
  const f = fixture(); const files = f.snapshot();
  const root = join(f.run, 'worker-inputs');
  writeFileSync(join(root, '.DS_Store'), 'Finder metadata');
  writeFileSync(join(root, 'a'.repeat(64)), 'Not a snapshot directory');
  mkdirSync(join(root, 'notes'));
  verifyWorkerInputs(f.repo, f.run);
  expect(f.snapshot()).toEqual(files);
  expect(readFileSync(join(root, '.DS_Store'), 'utf8')).toBe('Finder metadata');
});

for (const phase of ['manifest', 'retained-rename', 'local-write', 'local-rename', 'completion'] as const)
test(`interrupted ${phase} publication retries without partial snapshots or refreshing committed bytes`, () => {
  const f = fixture();
  const id = createHash('sha256').update('brief').digest('hex');
  const retained = join(f.run, 'worker-inputs', id), local = join(f.repo, '.shawshank/inputs/test', id);
  const originalWrite = fs.writeFileSync, originalRename = fs.renameSync, originalRemove = fs.rmSync;
  let hit = false;
  const fail = () => { hit = true; throw new Error('Synthetic interrupted publication'); };
  const write = spyOn(fs, 'writeFileSync').mockImplementation(((path: any, ...args: any[]) => {
    if ((phase === 'manifest' && String(path).endsWith('/manifest.json')) ||
      (phase === 'local-write' && String(path).startsWith(dirname(local) + '/.snapshot-'))) fail();
    return (originalWrite as any)(path, ...args);
  }) as any);
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if ((phase === 'retained-rename' && to === retained) || (phase === 'local-rename' && to === local)) fail();
    return originalRename(from, to);
  });
  const remove = spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (phase === 'completion' && path === join(retained, '.pending')) fail();
    return originalRemove(path, options);
  });
  try { expect(() => f.snapshot()).toThrow('Synthetic interrupted publication'); }
  finally { write.mockRestore(); rename.mockRestore(); remove.mockRestore(); }
  expect(hit).toBe(true);
  const published = !['manifest', 'retained-rename'].includes(phase);
  expect(existsSync(retained)).toBe(published);
  expect(existsSync(local)).toBe(phase === 'completion');
  if (published) expect(existsSync(join(retained, 'manifest.json'))).toBe(true);
  // Unreferenced pending inputs do not break validation of another dispatch.
  verifyWorkerInputs(f.repo, f.run);
  for (const parent of [dirname(retained), dirname(local)]) {
    if (existsSync(parent)) expect(fs.readdirSync(parent).filter(name => name.startsWith('.snapshot-'))).toEqual([]);
  }
  if (published) writeFileSync(f.source, 'Source changed after canonical publication');
  const files = f.snapshot();
  expect(readFileSync(files['brief.md'], 'utf8')).toBe('Approved input');
  expect(existsSync(join(retained, '.pending'))).toBe(false);
  verifyWorkerInputs(f.repo, f.run);
  // A completed snapshot missing its local copy is not a pending publication.
  renameSync(local, join(f.run, 'preserved-local'));
  expect(() => f.snapshot()).toThrow();
  expect(existsSync(local)).toBe(false);
});

test('dead publisher staging is cleaned on both sides without deleting live or unrelated directories', async () => {
  const f = fixture(); const files = f.snapshot();
  const child = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  const id = createHash('sha256').update('brief').digest('hex');
  const parents = [join(f.run, 'worker-inputs'), dirname(dirname(files['brief.md']))];
  for (const parent of parents) {
    for (const name of [`.snapshot-${id}-${child.pid}-abcdef`, `.snapshot-${id}-${process.pid}-abcdef`, 'unrelated-temp']) {
      mkdirSync(join(parent, name));
      writeFileSync(join(parent, name, 'partial.md'), 'Interrupted bytes', { mode: 0o444 });
    }
  }
  expect(f.snapshot()).toEqual(files);
  for (const parent of parents) {
    expect(existsSync(join(parent, `.snapshot-${id}-${child.pid}-abcdef`))).toBe(false);
    expect(existsSync(join(parent, `.snapshot-${id}-${process.pid}-abcdef`))).toBe(true);
    expect(existsSync(join(parent, 'unrelated-temp'))).toBe(true);
  }
});
