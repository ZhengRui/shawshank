import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elapsed, renderDatabase } from './workflow-runs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-view-test-'));
  const path = join(root, 'workflow.sqlite');
  const db = new Database(path);
  db.exec(`CREATE TABLE runs (id TEXT, worktree_path TEXT, task_path TEXT, stage TEXT,
    controller_id TEXT, created_at TEXT, updated_at TEXT, base_sha TEXT,
    accepted_head TEXT, repair_count INTEGER, blocked_reason TEXT);
    CREATE TABLE attempts (id TEXT, run_id TEXT, action TEXT, status TEXT,
    worker_kind TEXT, model TEXT, worker_name TEXT, pane_id TEXT, started_at TEXT,
    finished_at TEXT, report_path TEXT);`);
  db.query('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('run-1', root,
    join(root, 'missing-task.json'), 'implementing', 'new-controller',
    '2026-09-15T00:00:00Z', '2026-09-15T00:03:00Z', 'base', null, 0, null);
  db.query('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('attempt-1', 'run-1',
    'implementation', 'submitted', 'opencode', 'deepseek/test', 'worker', 'w1:p2',
    '2026-09-15T00:00:00Z', null, join(root, 'missing-report.json'));
  db.close();
  return {root, path};
}

test('list and detail preserve database bytes and support old cleanup schema', () => {
  const f = fixture();
  const before = readFileSync(f.path);
  expect(renderDatabase(f.path)).toContain('[input unavailable]');
  const detail = renderDatabase(f.path, 'run-1');
  expect(detail).toContain('new-controller');
  expect(detail).toContain('NOT QUERIED');
  expect(detail).toContain('not settled');
  expect(detail).toContain('not recorded');
  expect(detail).toContain('[missing]');
  expect(readFileSync(f.path).equals(before)).toBe(true);
});

test('snapshot goal wins and terminal control characters are sanitized', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'run-1'));
  writeFileSync(join(f.root, 'run-1/task.json'), JSON.stringify({goal: 'Saved\nTask\u001b[2J'}));
  writeFileSync(join(f.root, 'missing-task.json'), JSON.stringify({goal: 'Changed task'}));
  const output = renderDatabase(f.path);
  expect(output).toContain('Saved Task');
  expect(output).not.toContain('\u001b');
  expect(output).not.toContain('Changed task');
});

test('durations are settled intervals, never elapsed-until-now guesses', () => {
  expect(elapsed('2026-09-15T00:00:00Z', '2026-09-15T00:02:05Z')).toBe('2m 5s');
  expect(elapsed('2026-09-15T00:00:00Z', '2026-09-15T00:00:12Z')).toBe('12s');
  expect(elapsed('bad', null)).toBe('not settled');
  expect(elapsed('bad', 'bad')).toBe('unknown');
  expect(elapsed('2026-09-15T00:02:00Z', '2026-09-15T00:01:00Z')).toBe('unknown');
});

test('missing database and unknown run fail without creating files', () => {
  const f = fixture();
  const absent = join(f.root, 'absent.sqlite');
  expect(() => renderDatabase(absent)).toThrow('Database not found');
  expect(existsSync(absent)).toBe(false);
  expect(() => renderDatabase(f.path, 'wrong')).toThrow('Run not found');
});

test('real CLI supports explicit database and run paths and rejects bad arguments', () => {
  const f = fixture();
  const cli = (...args: string[]) => Bun.spawnSync(['bun', join(import.meta.dir, 'workflow-runs.ts'), ...args]);
  expect(cli(f.path).stdout.toString()).toContain('run-1');
  expect(cli(join(f.root, 'run-1')).stdout.toString()).toContain('attempt-1');
  expect(cli('--help').exitCode).toBe(0);
  expect(cli('--unknown').exitCode).toBe(1);
  expect(cli(f.path, 'extra').exitCode).toBe(1);
});

test('default CLI resolves the Git common repository without creating a database', () => {
  const f = fixture();
  const git = Bun.spawnSync(['git', 'init', f.root]);
  expect(git.exitCode).toBe(0);
  const storage = join(f.root, '.shawshank/runs');
  const cli = () => Bun.spawnSync(['bun', join(import.meta.dir, 'workflow-runs.ts')], {cwd:f.root});
  expect(cli().exitCode).toBe(1);
  expect(existsSync(storage)).toBe(false);
  mkdirSync(storage, {recursive:true});
  writeFileSync(join(storage, 'workflow.sqlite'), readFileSync(f.path));
  expect(cli().exitCode).toBe(0);
  expect(cli().stdout.toString()).toContain('run-1');
});

test('empty and invalid databases do not get initialized or migrated', () => {
  const f = fixture();
  const db = new Database(f.path);
  db.exec('DELETE FROM attempts; DELETE FROM runs');
  db.close();
  expect(renderDatabase(f.path)).toContain('No runs recorded.');
  const invalid = join(f.root, 'invalid.sqlite');
  new Database(invalid).close();
  const before = readFileSync(invalid);
  expect(() => renderDatabase(invalid)).toThrow();
  expect(readFileSync(invalid).equals(before)).toBe(true);
});
