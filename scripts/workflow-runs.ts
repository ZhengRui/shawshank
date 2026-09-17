#!/usr/bin/env bun
// Read-only status viewer for shawshank SQLite records.
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const usage = `Usage: bun .agents/skills/shawshank/scripts/workflow-runs.ts [workflow.sqlite | run-directory]
  No argument: list runs in the current Git common repository.
  Database path: list that database's runs.
  Run directory: show one run and its attempts.
Read-only; no Herdr polling, migrations, dispatch, or acceptance.`;

type Run = {
  id: string; worktree_path: string; task_path: string; stage: string;
  controller_id: string; created_at: string; updated_at: string;
  base_sha: string; accepted_head: string | null; repair_count: number;
  blocked_reason: string | null;
};
type Attempt = {
  id: string; action: string; status: string; worker_kind: string | null;
  model: string | null; worker_name: string | null; pane_id: string | null;
  started_at: string; finished_at: string | null; report_path: string;
  cleanup_state?: string | null; cleanup_error?: string | null;
};

// Artifact text must not inject terminal escapes or break table rows.
const cell = (value: unknown) => String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function table(headers: string[], rows: unknown[][]): string {
  const values = [headers, ...rows].map(row => row.map(cell));
  const widths = headers.map((_, i) => Math.max(...values.map(row => row[i].length)));
  return values.map(row => row.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

export function elapsed(start: string, end: string | null): string {
  if (!end) return 'not settled';
  const milliseconds = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function taskLabel(database: string, run: Run): string {
  // Prefer the registered snapshot; caller-owned briefs can move or change.
  for (const path of [join(dirname(database), run.id, 'task.json'), run.task_path]) {
    try {
      const task = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof task.goal === 'string' && task.goal.trim()) return task.goal;
    } catch { /* Historical inputs may no longer exist; still display the row. */ }
  }
  return `[input unavailable] ${run.task_path}`;
}

export function renderDatabase(database: string, runId?: string): string {
  if (!existsSync(database)) throw new Error(`Database not found: ${database}`);
  const db = new Database(database, { readonly: true });
  try {
    db.exec('BEGIN');
    const runs = (runId
      ? db.query('SELECT * FROM runs WHERE id = ?').all(runId)
      : db.query('SELECT * FROM runs ORDER BY created_at, id').all()) as Run[];
    if (runId && !runs.length) throw new Error(`Run not found: ${runId}`);
    const output = [`Database: ${cell(database)}`, 'Times: UTC. Live workers: NOT QUERIED (saved state is not liveness).'];
    if (!runId) {
      output.push(runs.length ? table(['RUN', 'TASK', 'STAGE', 'CONTROLLER', 'UPDATED'], runs.map(run =>
        [run.id, taskLabel(database, run), run.stage, run.controller_id, run.updated_at])) : 'No runs recorded.');
      output.push('Details: pass the run directory beside workflow.sqlite.');
    } else {
      const run = runs[0];
      output.push(`Task: ${cell(taskLabel(database, run))}`, table(['FIELD', 'VALUE'], [
        ['Run', run.id], ['Stage (saved)', run.stage], ['Controller', run.controller_id],
        ['Worktree', run.worktree_path], ['Created', run.created_at], ['Last update', run.updated_at],
        ['Baseline', run.base_sha], ['Accepted HEAD', run.accepted_head],
        ['Repair rounds', run.repair_count], ['Blocked reason', run.blocked_reason],
      ]));
      const attempts = db.query('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid').all(run.id) as Attempt[];
      output.push('\nAttempts', attempts.length ? table(
        ['#', 'ACTION', 'KIND / MODEL', 'RESULT (saved)', 'DISPATCH → SETTLED', 'PANE', 'CLEANUP (saved)'],
        attempts.map((a, i) => [i + 1, a.action, `${a.worker_kind ?? '-'} / ${a.model ?? '-'}`,
          a.status, elapsed(a.started_at, a.finished_at), a.pane_id, a.cleanup_state ?? 'not recorded'])
      ) : 'No attempts recorded.');
      for (const [i, a] of attempts.entries()) {
        output.push(`\n${i + 1}. ${cell(a.id)} | worker: ${cell(a.worker_name)}`,
          `   Started: ${cell(a.started_at)} | Finished: ${cell(a.finished_at)}`,
          `   Report: ${cell(a.report_path)}${existsSync(a.report_path) ? '' : ' [missing]'}`);
        if (a.cleanup_error) output.push(`   Cleanup error: ${cell(a.cleanup_error)}`);
      }
      output.push('\nDuration includes startup, execution and controller acceptance; it is not model-only time.',
        'Cleanup closed means the worker ended; a reusable shell may remain. Feature-tab cleanup is controller-managed.',
        'A missing finish means not settled in the ledger, not necessarily still running.',
        'Experiment shutdown may leave an incomplete stage and no recorded cleanup.');
    }
    db.exec('COMMIT');
    return output.join('\n');
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      console.log(usage);
    } else {
      if (args.length > 1 || args[0]?.startsWith('-')) throw new Error(usage);
      let database: string;
      let runId: string | undefined;
      if (args[0]) {
        const target = resolve(args[0]);
        if (basename(target) === 'workflow.sqlite') database = target;
        else { database = join(dirname(target), 'workflow.sqlite'); runId = basename(target); }
      } else {
        const result = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']);
        if (result.exitCode !== 0) throw new Error('Not in a Git repository; supply an explicit database or run directory.');
        database = join(dirname(result.stdout.toString().trim()), '.shawshank/runs/workflow.sqlite');
      }
      console.log(renderDatabase(database, runId));
    }
  } catch (error) {
    console.error(`workflow-runs: ${cell(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  }
}
