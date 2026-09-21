import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const prefix = '.shawshank/inputs';
const snapshotID = /^[a-f0-9]{64}$/;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function git(worktree: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', worktree, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString().trim() || 'Worker input Git check failed');
  return result.stdout.toString().trim();
}

export function rejectWorkerInputPaths(files: string[]) {
  if (files.some(file => file === prefix || file.startsWith(prefix + '/')))
    throw new Error('Workflow input snapshots must not be tracked or committed');
}

function placement(worktree: string, file: string) {
  const root = realpathSync(worktree);
  const rel = relative(root, file);
  if (!rel.startsWith(prefix + '/') || rel.split('/').includes('..')) throw new Error('Worker input escaped worktree');
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Worker input symlink is forbidden');
  }
}

function ignored(worktree: string, files: string[]) {
  const targets = [join(realpathSync(worktree), prefix) + '/', ...files];
  const result = Bun.spawnSync(['git', '-C', worktree, 'check-ignore', '-z', '--stdin'], { stdin: Buffer.from(targets.join('\0') + '\0') });
  return result.exitCode === 0 && result.stdout.toString().split('\0').filter(Boolean).length === targets.length;
}

function cleanStaging(parent: string) {
  if (!existsSync(parent)) return;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const match = /^\.snapshot-[a-f0-9]{64}-(\d+)-[a-zA-Z0-9]+$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    try { process.kill(Number(match[1]), 0); }
    catch (error: any) {
      if (error.code === 'ESRCH') rmSync(join(parent, entry.name), { recursive: true, force: true });
    }
  }
}

function publish(directory: string, files: Record<string, Buffer>) {
  mkdirSync(dirname(directory), { recursive: true });
  const staging = mkdtempSync(join(dirname(directory), `.snapshot-${basename(directory)}-${process.pid}-`));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(staging, name)), { recursive: true });
      writeFileSync(join(staging, name), bytes, { flag: 'wx', mode: 0o444 });
    }
    try { renameSync(staging, directory); }
    catch (error: any) {
      // Another preflight may have published first; the caller verifies its bytes.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// Canonical bytes and digests stay with the run; only verified input copies live
// inside the worker tree. Source paths identify revisions, not mutable contents.
export function snapshotWorkerInputs(worktree: string, runPath: string, key: string, sources: Record<string, string>) {
  const id = digest(key);
  const retained = join(runPath, 'worker-inputs', id);
  const destination = join(realpathSync(worktree), prefix, basename(runPath), id);
  const manifest = join(retained, 'manifest.json');
  const pending = join(retained, '.pending');
  const names = Object.keys(sources).sort();
  rejectWorkerInputPaths(git(worktree, 'ls-files', '-z', '--', prefix).split('\0').filter(Boolean));
  for (const name of names) {
    if (!name || ['manifest.json', '.pending'].includes(name) || name.split('/').some(p => !p || p === '.' || p === '..'))
      throw new Error('Invalid worker input filename');
    placement(worktree, join(destination, name));
  }
  cleanStaging(dirname(retained));
  cleanStaging(dirname(destination));
  if (!existsSync(manifest)) {
    if (existsSync(retained) || existsSync(destination)) throw new Error('Incomplete worker input snapshot; inspect retained files');
    const bytes = Object.fromEntries(names.map(name => [name, readFileSync(sources[name])]));
    const localFiles = names.map(name => join(destination, name));
    if (!ignored(worktree, localFiles)) {
      const exclude = git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
      const common = realpathSync(git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
      if (!exclude.startsWith(common + '/')) throw new Error('Refusing symlinked Git exclude file outside Git metadata');
      mkdirSync(dirname(exclude), { recursive: true });
      if (realpathSync(dirname(exclude)) !== dirname(exclude) || lstatSync(exclude, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new Error('Refusing symlinked Git exclude file');
      const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!existing.split(/\r?\n/).includes('/.shawshank/inputs/')) appendFileSync(exclude, '\n/.shawshank/inputs/\n');
    }
    if (!ignored(worktree, localFiles)) throw new Error('Worker inputs are not ignored');
    publish(retained, { ...bytes, '.pending': Buffer.from('Local input publication pending\n'),
      'manifest.json': Buffer.from(JSON.stringify({ destination, files: Object.fromEntries(names.map(name => [name, digest(bytes[name])])) }, null, 2)) });
  }
  const saved = readSnapshot(retained);
  if (saved.destination !== destination || JSON.stringify(Object.keys(saved.files).sort()) !== JSON.stringify(names))
    throw new Error('Worker input snapshot contract changed');
  // Two directories cannot be renamed atomically together. Only an explicitly
  // pending publication may finish from retained bytes; completed copies never refresh.
  if (existsSync(pending) && !existsSync(destination)) {
    if (!ignored(worktree, names.map(name => join(destination, name)))) throw new Error('Worker inputs are not ignored');
    publish(destination, Object.fromEntries(names.map(name => [name, readFileSync(join(retained, name))])));
  }
  verifySnapshot(worktree, retained);
  if (existsSync(pending)) rmSync(pending, { force: true });
  return Object.fromEntries(names.map(name => [name, join(destination, name)]));
}

function readSnapshot(retained: string) {
  const saved = JSON.parse(readFileSync(join(retained, 'manifest.json'), 'utf8'));
  for (const [name, hash] of Object.entries(saved.files)) {
    if (digest(readFileSync(join(retained, name))) !== hash) throw new Error('Worker input snapshot changed');
  }
  return saved;
}

function verifySnapshot(worktree: string, retained: string) {
  const saved = readSnapshot(retained);
  if (!ignored(worktree, Object.keys(saved.files).map(name => join(saved.destination, name))))
    throw new Error('Worker inputs are no longer ignored');
  for (const [name, hash] of Object.entries(saved.files)) {
    const file = join(saved.destination, name);
    placement(worktree, file);
    if (digest(readFileSync(file)) !== hash)
      throw new Error('Worker input snapshot changed');
  }
}

export function verifyWorkerInputs(worktree: string, runPath: string, dispatch?: string) {
  rejectWorkerInputPaths(git(worktree, 'ls-files', '-z', '--', prefix).split('\0').filter(Boolean));
  const retained = join(runPath, 'worker-inputs');
  const ids = new Set(existsSync(retained) ? readdirSync(retained, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && snapshotID.test(entry.name) && !existsSync(join(retained, entry.name, '.pending')))
    .map(entry => entry.name) : []);
  if (dispatch) {
    const local = join(realpathSync(worktree), prefix, basename(runPath)) + '/';
    for (const part of readFileSync(dispatch, 'utf8').split(local).slice(1)) {
      const id = part.split('/')[0];
      if (snapshotID.test(id)) ids.add(id);
    }
  }
  for (const id of ids) verifySnapshot(worktree, join(retained, id));
}
