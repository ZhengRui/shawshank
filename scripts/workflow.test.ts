import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync, readFileSync, renameSync } from 'node:fs';
import { acceptImplementation, dispatchImplementation, dispatchReview, acceptReview, recordTriage, dispatchRepair, correctReport, cleanupWorkers, takeOver, replaceWorker, dispatchFinalReview, acceptFinalReview, recordFinalTriage, dispatchFinalWork, acceptFinalWork, completeFinalReview } from './workflow';
import { HerdrError } from './herdr';
import { startupError } from './startup';
import { resolveNoLaunch } from './workflow';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'workflow.ts');

function finalCoverageFixture(f: any) {
  return { scope: { primary_files: Bun.spawnSync(['git', '-C', f.root, 'diff', '--name-only', '--no-renames', '-z', `${f.finalInput.base}..${f.finalInput.reviewedHEAD}`]).stdout.toString().split('\0').filter(Boolean), extended: [], excluded: [] },
    coverage: [...new Set([...f.finalInput.requiredChecks, ...f.finalInput.runtimeMissions, 'fixture behavior'])]
      .map(requirement => ({ requirement, status: 'PASS', evidence: 'Synthetic coverage only; not live review evidence' })),
    observations: [], cleanup: 'Synthetic fixture; no runtime data' };
}

function finalFindingFixture(f: any) {
  return { ...f, location: 'sample.ts:1', expected: 'Declared fixture behavior', actual: 'Synthetic deviation', reproduction: 'Synthetic fixture only' };
}

function finalFixture() {
  const f = fixture(true);
  mkdirSync(join(f.root, '.shawshank'), { recursive: true });
  const role = { kind: 'codex', model: 'fixture-only', args: [] };
  writeFileSync(join(f.root, '.shawshank/config.json'), JSON.stringify({ roles: {
    reviewer: role, verifier: { default: role }, implementer: { standard: [role] } } }));
  f.git('add', '.shawshank/config.json');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Configure fixture');
  const head = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const input = { worktree: f.root, base: head, reviewedHEAD: head, intent: 'report_only', entry: 'standalone',
    scope: { reference: 'fixture scope', description: 'Registration only', allowedPaths: [], nonGoals: [] },
    requiredChecks: [], runtimeMissions: [], environmentConstraints: [], taskEvidence: [],
    authorization: { source: 'Synthetic test authorization', intent: 'report_only' } };
  const save = () => writeFileSync(f.input, JSON.stringify(input));
  save();
  return { ...f, finalInput: input, save,
    register: () => cli('register-final-review', '--input', f.input, '--controller', 'final-controller') };
}

async function finalDispatchFixture(intent = 'report_only', setup?: (f: ReturnType<typeof finalFixture>) => void) {
  const f = finalFixture();
  f.finalInput.intent = intent; f.finalInput.authorization.intent = intent;
  if (intent === 'repair_loop') {
    (f.finalInput.authorization as any).localCommits = true;
    f.finalInput.scope.allowedPaths = ['sample.ts'] as never[];
  }
  setup?.(f);
  f.save();
  const run = JSON.parse(f.register().out).run;
  let agent: any, closed = false, failPrompt = false;
  const calls: string[][] = [];
  const call = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'pane') {
      if (args[1] === 'close') { closed = true; return { type: 'ok' }; }
      if (args[1] === 'get' && args[2] === 'review-pane' && closed) throw new HerdrError('closed', 'pane_not_found');
      return { pane: { pane_id: args[1] === 'split' ? 'review-pane' : args[2], tab_id: 'test-tab' } };
    }
    if (args[1] === 'start') agent = { name: args[2], pane_id: 'review-pane', tab_id: 'test-tab', agent: 'codex',
      agent_status: 'idle', cwd: f.root, foreground_cwd: f.root };
    if (args[1] === 'prompt' && failPrompt) throw new Error('Fixture uncertain delivery');
    return { agent };
  };
  return { ...f, run, call, calls, failPrompt: () => { failPrompt = true; },
    dispatch: () => dispatchFinalReview(run, 'final-controller', 'parent', 'test-tab', call) };
}

test('final dispatch preserves approved browser boundaries without requiring a solved investigation', async () => {
  const constraints = [
    'No profile restriction; use Chrome DevTools and create a new owned test window, not a tab in an existing window.',
    'Identify owned window and page IDs; never operate existing user tabs or change shared login state.',
    'Keep one test window: reuse the initial page only when this run launched its dedicated browser; do not create a second context. Close the exclusively owned browser at completion.',
    'Browser launch: fixture-only command; never launch a real browser in this test.',
    'Only http://localhost:43210; test account access is in the approved brief; no service restart.',
  ];
  const f = await finalDispatchFixture('report_only', f => {
    f.finalInput.scope.description = 'Investigate material upload failure and associated effects; root cause unknown';
    f.finalInput.environmentConstraints = constraints as never[];
  });
  await f.dispatch();
  const saved = JSON.parse(cli('status', f.run).out);
  const prompt = readFileSync(saved.attempts[0].dispatch_path, 'utf8');
  const inputStart = prompt.indexOf('Approved input:\n') + 'Approved input:\n'.length;
  // Parse the serialized input, not instruction wording: this is transport evidence.
  const serialized = JSON.stringify(JSON.parse(readFileSync(f.input, 'utf8')), null, 2);
  const delivered = JSON.parse(prompt.slice(inputStart, inputStart + serialized.length));
  expect(delivered.environmentConstraints).toEqual(constraints);
  expect(delivered.scope.description).toBe(f.finalInput.scope.description);
  expect(delivered.requiredChecks).toEqual([]);
  expect(delivered.runtimeMissions).toEqual([]);
  expect(f.calls.filter(c => c[1] === 'prompt')).toHaveLength(1);
});

test('final report-only and repair-loop acceptance preserve reports and close reviewer', async () => {
  for (const intent of ['report_only', 'repair_loop']) {
    const f = await finalDispatchFixture(intent), attempt = await f.dispatch();
    const dispatched = JSON.parse(cli('status', f.run).out).attempts[0];
    expect(readFileSync(dispatched.dispatch_path, 'utf8')).toContain('category: code|security|ux|runtime (test-code issues use code)');
    const report = { attempt_id: attempt.attempt_id, base_sha: f.finalInput.base,
      head_sha: f.finalInput.reviewedHEAD, evidence: 'Synthetic transport fixture; no real reviewer', findings: [], ...finalCoverageFixture(f) };
    writeFileSync(attempt.report, JSON.stringify(report));
    const accepted = await acceptFinalReview(f.run, 'final-controller', f.call);
    expect(accepted.stage).toBe(intent === 'report_only' ? 'review_reported' : 'final_triage');
    expect(accepted.cleanup.state).toBe('complete');
    expect(JSON.parse(readFileSync(attempt.report, 'utf8'))).toEqual(report);
    const saved = JSON.parse(cli('status', f.run).out);
    expect(saved.attempts).toHaveLength(1);
    expect(saved.attempts[0].report_path).not.toBe(attempt.report);
    expect(saved.attempts[0].cleanup_state).toBe('closed');
    expect(f.calls.filter(c => c[1] === 'start')).toHaveLength(1);
  }
});

async function finalRecoveryFixture(intent = 'report_only') {
  const f = await finalDispatchFixture(intent), attempt = await f.dispatch();
  const report = { attempt_id: attempt.attempt_id, base_sha: f.finalInput.base,
    head_sha: f.finalInput.reviewedHEAD, evidence: 'Synthetic recovery fixture', findings: [], ...finalCoverageFixture(f) };
  const reportBytes = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(attempt.report, reportBytes);
  const saved = JSON.parse(cli('status', f.run).out);
  const decision = { run_id: saved.run.id, previous_controller: 'final-controller', stage: 'final_reviewing',
    attempt_id: attempt.attempt_id, head_sha: saved.observed_head, worktree_fingerprint: saved.worktree_fingerprint,
    previous_command_stopped: true, evidence: 'Synthetic stopped command', session_evidence: 'Synthetic verified session',
    worker_stopped: true, worker_stop_evidence: 'Synthetic worker and background writers stopped',
    report_sha256: createHash('sha256').update(reportBytes).digest('hex') };
  const decisionFile = join(f.run, 'recovery-input.json');
  writeFileSync(decisionFile, JSON.stringify(decision));
  const calls: string[][] = [];
  const absent = async (...args: string[]): Promise<any> => {
    calls.push(args);
    if (args[1] !== 'get') throw new Error('Unexpected mutation during recovery');
    throw new HerdrError('Synthetic absent target', args[0] === 'agent' ? 'agent_not_found' : 'pane_not_found');
  };
  return { ...f, attempt, report, reportBytes, decision, decisionFile, saved, absent, recoveryCalls: calls };
}

test('explicit final recovery accepts exact bytes for both intents without contacting a new worker', async () => {
  for (const intent of ['report_only', 'repair_loop']) {
    const f = await finalRecoveryFixture(intent);
    await expect(acceptFinalReview(f.run, 'final-controller', f.absent)).rejects.toThrow('absent');
    const accepted = await acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile);
    expect(accepted.stage).toBe(intent === 'report_only' ? 'review_reported' : 'final_triage');
    expect(accepted.cleanup.state).toBe('complete');
    const saved = JSON.parse(cli('status', f.run).out);
    expect(saved.run.controller_id).toBe('final-controller');
    expect(saved.attempts[0].cleanup_state).toBe('closed');
    expect(readFileSync(saved.attempts[0].report_path, 'utf8')).toBe(f.reportBytes);
    expect(readFileSync(f.attempt.report, 'utf8')).toBe(f.reportBytes);
    const evidence = JSON.parse(saved.run.config_json).finalReportRecoveryDecision;
    expect(evidence).not.toBe(f.decisionFile);
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toEqual(f.decision);
    await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow('Expected final_reviewing');
    expect(JSON.parse(cli('status', f.run).out)).toEqual(saved);
    expect(f.recoveryCalls.every(c => c[1] === 'get')).toBe(true);
    expect(f.recoveryCalls.every(c => c[2] === f.saved.attempts[0].worker_name || c[2] === f.saved.attempts[0].pane_id)).toBe(true);
  }
});

test('final recovery accepts an exited reviewer in a reusable shell and rejects unsafe shells', async () => {
  const f = await finalRecoveryFixture();
  const pane = f.saved.attempts[0].pane_id;
  const db = new Database(join(f.run, '..', 'workflow.sqlite'));
  db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify({
    ...JSON.parse(f.saved.run.config_json), reusePane: true, parentPane: pane, controllerPane: 'controller',
  }), f.saved.run.id);
  db.close();
  let busy = true, cwd = f.root, tab = 'test-tab';
  const call = async (...args: string[]) => {
    if (args[0] === 'agent') throw new HerdrError('Exited', 'agent_not_found');
    if (args[1] === 'get') return { pane: {pane_id:pane,tab_id:tab,terminal_id:'original'} };
    if (args[1] === 'process-info') return { process_info: {pane_id:pane,shell_pid:42,
      foreground_process_group_id:busy ? 99 : 42,
      foreground_processes:[{pid:busy ? 99 : 42,argv0:busy ? 'vim' : 'zsh',cwd}]} };
    throw new Error('Recovery must not mutate the pane');
  };
  await expect(acceptFinalReview(f.run, 'final-controller', call, f.decisionFile)).rejects.toThrow('foreground');
  busy = false; cwd = realpathSync(tmpdir());
  await expect(acceptFinalReview(f.run, 'final-controller', call, f.decisionFile)).rejects.toThrow('directory differs');
  cwd = f.root; tab = 'unrelated-tab';
  await expect(acceptFinalReview(f.run, 'final-controller', call, f.decisionFile)).rejects.toThrow('identity changed');
  tab = 'test-tab';
  const accepted = await acceptFinalReview(f.run, 'final-controller', call, f.decisionFile);
  expect(accepted.stage).toBe('review_reported');
  expect(accepted.cleanup.state).toBe('complete');
  expect(readFileSync(f.attempt.report, 'utf8')).toBe(f.reportBytes);
});

test('final recovery rejects missing or stale evidence and live or unknown targets', async () => {
  const f = await finalRecoveryFixture();
  await expect(acceptFinalReview(f.run, 'final-controller', f.call, '')).rejects.toThrow('recovery decision file');
  for (const key of Object.keys(f.decision)) {
    const changed: any = { ...f.decision }; delete changed[key];
    writeFileSync(f.decisionFile, JSON.stringify(changed));
    await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow();
  }
  for (const key of ['run_id', 'previous_controller', 'stage', 'attempt_id', 'head_sha', 'worktree_fingerprint', 'report_sha256']) {
    writeFileSync(f.decisionFile, JSON.stringify({ ...f.decision, [key]: 'stale' }));
    await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow();
  }
  writeFileSync(f.decisionFile, JSON.stringify(f.decision));
  for (const kind of ['agent', 'pane']) {
    for (const outcome of ['present', 'timeout', 'wrong-code', 'untyped-error']) {
      const call = async (...args: string[]) => {
        if (args[0] !== kind) return f.absent(...args);
        if (outcome === 'present') return { [kind]: {} };
        if (outcome === 'untyped-error') throw Object.assign(new Error('Not trusted'), { code: `${kind}_not_found` });
        throw new HerdrError('Transport error', outcome === 'timeout' ? 'timeout' : 'unknown');
      };
      await expect(acceptFinalReview(f.run, 'final-controller', call, f.decisionFile)).rejects.toThrow();
    }
  }
  expect(JSON.parse(cli('status', f.run).out)).toEqual(f.saved);
  expect(readFileSync(f.attempt.report, 'utf8')).toBe(f.reportBytes);
});

test('final recovery retains ordinary report and clean worktree gates', async () => {
  const f = await finalRecoveryFixture();
  for (const report of ['{', JSON.stringify({ ...f.report, attempt_id: 'wrong' }),
    JSON.stringify({ ...f.report, coverage: [] }), JSON.stringify({ ...f.report, findings: [{}] })]) {
    writeFileSync(f.attempt.report, report);
    writeFileSync(f.decisionFile, JSON.stringify({ ...f.decision, report_sha256: createHash('sha256').update(report).digest('hex') }));
    await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow();
    expect(readFileSync(f.attempt.report, 'utf8')).toBe(report);
  }
  writeFileSync(f.attempt.report, f.reportBytes);
  writeFileSync(join(f.root, 'unexpected.txt'), 'Preserve this work');
  const dirty = JSON.parse(cli('status', f.run).out);
  writeFileSync(f.decisionFile, JSON.stringify({ ...f.decision, worktree_fingerprint: dirty.worktree_fingerprint }));
  await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow('Git state');
  expect(readFileSync(join(f.root, 'unexpected.txt'), 'utf8')).toBe('Preserve this work');
});

test('final recovery requires saved identities and a resolved submitted attempt', async () => {
  const f = await finalRecoveryFixture();
  const db = new Database(join(f.run, '..', 'workflow.sqlite'));
  try {
    for (const field of ['worker_name', 'pane_id', 'worker_kind']) {
      db.query(`UPDATE attempts SET ${field}=? WHERE id=?`).run('', f.attempt.attempt_id);
      await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow('saved');
      db.query(`UPDATE attempts SET ${field}=? WHERE id=?`).run(f.saved.attempts[0][field], f.attempt.attempt_id);
    }
    db.query('UPDATE attempts SET status=? WHERE id=?').run('prompting', f.attempt.attempt_id);
    await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow('No submitted');
    db.query('UPDATE attempts SET status=? WHERE id=?').run('submitted', f.attempt.attempt_id);
    db.query('UPDATE runs SET blocked_reason=? WHERE id=?').run('Final dispatch unresolved', f.saved.run.id);
    await expect(acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile)).rejects.toThrow('blocked');
    expect(f.recoveryCalls).toHaveLength(0);
  } finally { db.close(); }
});

test('final recovery refuses evidence or ledger changes during live checks', async () => {
  for (const mutation of ['report', 'decision', 'owner', 'stage', 'attempt', 'concurrent']) {
    const f = await finalRecoveryFixture();
    let changed = false;
    const call = async (...args: string[]): Promise<any> => {
      if (!changed) {
        changed = true;
        if (mutation === 'report') writeFileSync(f.attempt.report, f.reportBytes + ' ');
        else if (mutation === 'decision') writeFileSync(f.decisionFile, JSON.stringify({ ...f.decision, evidence: 'Changed evidence' }));
        else if (mutation === 'concurrent') await acceptFinalReview(f.run, 'final-controller', f.absent, f.decisionFile);
        else {
          const db = new Database(join(f.run, '..', 'workflow.sqlite'));
          if (mutation === 'owner') db.query('UPDATE runs SET controller_id=? WHERE id=?').run('new-owner', f.saved.run.id);
          if (mutation === 'stage') db.query('UPDATE runs SET stage=? WHERE id=?').run('final_dispatching', f.saved.run.id);
          if (mutation === 'attempt') db.query('UPDATE attempts SET status=? WHERE id=?').run('prompting', f.attempt.attempt_id);
          db.close();
        }
      }
      return f.absent(...args);
    };
    await expect(acceptFinalReview(f.run, 'final-controller', call, f.decisionFile)).rejects.toThrow();
    const saved = JSON.parse(cli('status', f.run).out);
    expect(saved.attempts[0].status).toBe(mutation === 'concurrent' ? 'accepted' : mutation === 'attempt' ? 'prompting' : 'submitted');
    if (mutation !== 'concurrent') expect(JSON.parse(saved.run.config_json).finalReportRecoveryDecision).toBeUndefined();
  }
});

test('final acceptance rejects missing/stale reports and preserves unexpected edits; correction is bounded', async () => {
  const f = await finalDispatchFixture(), attempt = await f.dispatch();
  await expect(acceptFinalReview(f.run, 'final-controller', f.call)).rejects.toThrow();
  const report = { attempt_id: attempt.attempt_id, base_sha: f.finalInput.base,
    head_sha: 'wrong', evidence: 'Synthetic fixture', findings: [], ...finalCoverageFixture(f) };
  writeFileSync(attempt.report, JSON.stringify(report));
  await expect(acceptFinalReview(f.run, 'final-controller', f.call)).rejects.toThrow('provenance');
  const changed = join(f.root, '.shawshank/config.json'), original = readFileSync(changed, 'utf8');
  writeFileSync(changed, original + '\n');
  await expect(acceptFinalReview(f.run, 'final-controller', f.call)).rejects.toThrow('Git state');
  expect(readFileSync(changed, 'utf8')).toBe(original + '\n');
  writeFileSync(changed, original); // Test-owned mutation, not workflow auto-revert.
  const decision = join(f.run, 'correction-decision.json');
  writeFileSync(decision, JSON.stringify({ attempt_id: attempt.attempt_id, evidence: 'Fixture wrong SHA' }));
  const corrected = await correctReport(f.run, 'final-controller', 'final_review', decision, f.call);
  expect(corrected.correction_count).toBe(1);
  await expect(correctReport(f.run, 'final-controller', 'final_review', decision, f.call)).rejects.toThrow('No report correction');
  writeFileSync(corrected.report, JSON.stringify({ ...report, head_sha: f.finalInput.reviewedHEAD }));
  expect((await acceptFinalReview(f.run, 'final-controller', f.call)).stage).toBe('review_reported');
});

test('uncertain final prompt cannot be replayed', async () => {
  const f = await finalDispatchFixture(); f.failPrompt();
  await expect(f.dispatch()).rejects.toThrow('uncertain delivery');
  await expect(f.dispatch()).rejects.toThrow('replay is forbidden');
  expect(f.calls.filter(c => c[1] === 'prompt')).toHaveLength(1);
  expect(JSON.parse(cli('status', f.run).out).run.stage).toBe('final_dispatching');
});

test('final standard rejects omitted coverage, changed files and incomplete finding evidence', async () => {
  const f = await finalDispatchFixture('report_only', f => {
    f.finalInput.base = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD^']).stdout.toString().trim();
    f.finalInput.runtimeMissions = ['Save and recover'] as never[];
  });
  const a = await f.dispatch();
  const report: any = { attempt_id: a.attempt_id, base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD,
    evidence: 'Synthetic missing-access case', findings: [], ...finalCoverageFixture(f) };
  const submit = (value: any) => { writeFileSync(a.report, JSON.stringify(value)); return acceptFinalReview(f.run, 'final-controller', f.call); };
  await expect(submit({ ...report, coverage: [] })).rejects.toThrow('Coverage records');
  await expect(submit({ ...report, scope: { ...report.scope, primary_files: [] } })).rejects.toThrow('every changed file');
  await expect(submit({ ...report, scope: { ...report.scope, primary_files: ['.gitignore'] } })).rejects.toThrow('every changed file');
  await expect(submit({ ...report, coverage: report.coverage.slice(1) })).rejects.toThrow('Missing declared');
  await expect(submit({ ...report, coverage: [report.coverage[0], report.coverage[0]] })).rejects.toThrow('duplicate coverage');
  await expect(submit({ ...report, findings: [{ id: 'F', severity: 'major', category: 'ux', status: 'open', description: 'Synthetic', evidence: 'Synthetic' }] })).rejects.toThrow('finding location');
  report.coverage[0] = { requirement: 'Save and recover', status: 'NOT_RUN', evidence: 'Synthetic unavailable authorized runtime' };
  expect((await submit(report)).stage).toBe('review_reported');
  const state = JSON.parse(cli('status', f.run).out);
  expect(JSON.parse(readFileSync(state.attempts[0].report_path, 'utf8')).coverage[0].status).toBe('NOT_RUN');
  const dispatch = readFileSync(state.attempts[0].dispatch_path, 'utf8');
  expect(dispatch).toContain(join(import.meta.dir, '../references/final-reviewer.md').replace('/scripts/..', ''));
});

test('final scope permits approved existing files with or without a Git diff', async () => {
  for (const withDiff of [false, true]) {
    const f = await finalDispatchFixture('report_only', f => {
      if (withDiff) f.finalInput.base = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD^']).stdout.toString().trim();
      f.finalInput.scope.description = 'Review existing tracked files and associated effects';
    });
    const a = await f.dispatch();
    const report = { attempt_id: a.attempt_id, base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD,
      evidence: 'Synthetic approved existing-file review', findings: [], ...finalCoverageFixture(f) };
    const unchanged = '.gitignore'; // Tracked before the configuration commit.
    expect(unchanged).toBeTruthy();
    report.scope.primary_files.push(unchanged, unchanged);
    writeFileSync(a.report, JSON.stringify(report));
    await expect(acceptFinalReview(f.run, 'final-controller', f.call)).rejects.toThrow('every changed file');
    report.scope.primary_files.pop();
    writeFileSync(a.report, JSON.stringify(report));
    expect((await acceptFinalReview(f.run, 'final-controller', f.call)).stage).toBe('review_reported');
  }
});

test('genuinely inapplicable additional coverage needs a reason but no user waiver', async () => {
  const f = await finalDispatchFixture('repair_loop');
  const a = await f.dispatch();
  const report = { attempt_id: a.attempt_id, base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD,
    evidence: 'Synthetic pure-function review', findings: [], ...finalCoverageFixture(f),
    coverage: [{ requirement: 'Browser interaction', status: 'NOT_APPLICABLE', evidence: 'Pure function with no UI or browser consumers' }] };
  writeFileSync(a.report, JSON.stringify(report));
  await acceptFinalReview(f.run, 'final-controller', f.call);
  const decision = join(f.run, 'triage.json');
  writeFileSync(decision, JSON.stringify({ review_id: a.attempt_id, head_sha: f.finalInput.reviewedHEAD, verification_id: null, decisions: [] }));
  recordFinalTriage(f.run, 'final-controller', decision);
  const evidence = { head_sha: f.finalInput.reviewedHEAD, deferred_ids: [], coverage_assessment: 'No browser surface exists in the approved scope', checks: report.coverage };
  const complete = () => { writeFileSync(decision, JSON.stringify(evidence)); return completeFinalReview(f.run, 'final-controller', decision, f.call); };
  evidence.checks[0].evidence = '';
  await expect(complete()).rejects.toThrow('coverage evidence');
  evidence.checks[0].evidence = 'Pure function with no UI or browser consumers';
  expect((await complete()).stage).toBe('final_passed');
});

test('declared missions cannot be waived merely by reporting them inapplicable', async () => {
  const f = await finalDispatchFixture('repair_loop', f => {
    f.finalInput.runtimeMissions = ['Browser interaction'] as never[];
  });
  const a = await f.dispatch();
  const report = { attempt_id: a.attempt_id, base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD,
    evidence: 'Synthetic scope conflict', findings: [], ...finalCoverageFixture(f) };
  report.coverage[0] = { requirement: 'Browser interaction', status: 'NOT_APPLICABLE', evidence: 'Reviewer claims no UI' };
  writeFileSync(a.report, JSON.stringify(report));
  await acceptFinalReview(f.run, 'final-controller', f.call);
  const decision = join(f.run, 'triage.json');
  writeFileSync(decision, JSON.stringify({ review_id: a.attempt_id, head_sha: f.finalInput.reviewedHEAD, verification_id: null, decisions: [] }));
  recordFinalTriage(f.run, 'final-controller', decision);
  const evidence = { head_sha: f.finalInput.reviewedHEAD, deferred_ids: [], coverage_assessment: 'Synthetic scope conflict', checks: report.coverage };
  writeFileSync(decision, JSON.stringify(evidence));
  await expect(completeFinalReview(f.run, 'final-controller', decision, f.call)).rejects.toThrow('Required check/runtime');
});

test('reviewer-discovered missing runtime blocks completion until evidence or explicit scope change', async () => {
  const f = await finalDispatchFixture('repair_loop');
  const a = await f.dispatch();
  const report = { attempt_id: a.attempt_id, base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD,
    evidence: 'Synthetic runtime gap; no findings invented', findings: [], ...finalCoverageFixture(f),
    coverage: [{ requirement: 'Cross-context undo', status: 'NOT_RUN', evidence: 'Synthetic unavailable runtime; controller omitted mission' }] };
  writeFileSync(a.report, JSON.stringify(report));
  await acceptFinalReview(f.run, 'final-controller', f.call);
  const decision = join(f.run, 'triage.json');
  writeFileSync(decision, JSON.stringify({ review_id: a.attempt_id, head_sha: f.finalInput.reviewedHEAD, verification_id: null, decisions: [] }));
  recordFinalTriage(f.run, 'final-controller', decision);
  const evidence: any = { head_sha: f.finalInput.reviewedHEAD, deferred_ids: [], coverage_assessment: 'Synthetic scope assessment', checks: report.coverage };
  const complete = () => { writeFileSync(decision, JSON.stringify(evidence)); return completeFinalReview(f.run, 'final-controller', decision, f.call); };
  await expect(complete()).rejects.toThrow('Required check/runtime');
  evidence.checks = [{ requirement: 'Unrelated green test', status: 'PASS', evidence: 'Synthetic' }];
  await expect(complete()).rejects.toThrow('Required check/runtime');
  evidence.checks = [{ ...report.coverage[0], status: 'NOT_APPLICABLE' }];
  await expect(complete()).rejects.toThrow('Required check/runtime');
  evidence.checks[0].authorization_source = 'Synthetic explicit user decision to exclude runtime from this acceptance';
  evidence.checks[0].evidence = 'Runtime intentionally excluded; cross-context undo remains untested';
  expect((await complete()).stage).toBe('final_passed');
  const state = JSON.parse(cli('status', f.run).out);
  const saved = JSON.parse(readFileSync(JSON.parse(state.run.config_json).completion_path, 'utf8'));
  expect(saved.checks[0].status).toBe('NOT_APPLICABLE');
  expect(saved.checks[0].authorization_source).toBe(evidence.checks[0].authorization_source);
  expect(JSON.parse(readFileSync(state.attempts[0].report_path, 'utf8')).coverage[0].status).toBe('NOT_RUN');
  expect(state.attempts).toHaveLength(1);
});

test('unmarked historical final runs retain their report schema without rewriting reports', async () => {
  const f = await finalDispatchFixture();
  // Simulate a pre-standard ledger only in this disposable test fixture.
  const db = new Database(join(f.run, '../workflow.sqlite'));
  const row = db.query('SELECT id,config_json FROM runs').get() as any;
  const config = JSON.parse(row.config_json); delete config.finalReviewStandard;
  db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify(config), row.id); db.close();
  const a = await f.dispatch();
  const report = { attempt_id: a.attempt_id, base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD, evidence: 'Synthetic historical report', findings: [] };
  writeFileSync(a.report, JSON.stringify(report));
  expect((await acceptFinalReview(f.run, 'final-controller', f.call)).stage).toBe('review_reported');
  const state = JSON.parse(cli('status', f.run).out);
  expect(JSON.parse(readFileSync(state.attempts[0].report_path, 'utf8'))).toEqual(report);
});

async function finalLoopFixture(findings: any[] = [{ id: 'F1', severity: 'major', category: 'code', status: 'open', description: 'Declared synthetic defect', evidence: 'Synthetic fixture only' }]) {
  const f = finalFixture();
  f.finalInput.intent = 'repair_loop'; f.finalInput.authorization.intent = 'repair_loop';
  (f.finalInput.authorization as any).localCommits = true;
  f.finalInput.scope.allowedPaths = ['sample.ts'] as never[];
  f.finalInput.requiredChecks = ['fixture test'] as never[];
  f.finalInput.runtimeMissions = ['fixture mission'] as never[];
  const configPath = join(f.root, '.shawshank/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.project = { commitTrailer: 'Co-Authored-By: Test <noreply@test.invalid>' };
  writeFileSync(configPath, JSON.stringify(config));
  f.git('add', '.shawshank/config.json');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Set fixture trailer');
  f.finalInput.reviewedHEAD = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD']).stdout.toString().trim(); f.save();
  const run = JSON.parse(f.register().out).run;
  const agents = new Map<string, any>(), panes = new Set(['parent']); let splits = 0;
  const calls: string[][] = [];
  const call = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'pane') {
      if (args[1] === 'split') { const id = `pane-${++splits}`; panes.add(id); return { pane: { pane_id: id, tab_id: 'tab' } }; }
      if (args[1] === 'close') { panes.delete(args[2]); return { type: 'ok' }; }
      if (!panes.has(args[2])) throw new HerdrError('gone', 'pane_not_found');
      return { pane: { pane_id: args[2], tab_id: 'tab' } };
    }
    if (args[1] === 'start') agents.set(args[2], { name: args[2], pane_id: args[6], tab_id: 'tab', agent: args[4], agent_status: 'idle', cwd: f.root, foreground_cwd: f.root });
    return { agent: agents.get(args[2]) };
  };
  const review = await dispatchFinalReview(run, 'final-controller', 'parent', 'tab', call);
  writeFileSync(review.report, JSON.stringify({ attempt_id: review.attempt_id, base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD, evidence: 'Synthetic final review fixture', findings: findings.map(finalFindingFixture), ...finalCoverageFixture(f) }));
  await acceptFinalReview(run, 'final-controller', call);
  const observe = () => JSON.parse(cli('status', run).out);
  const triage = (decisions: any[]) => {
    const state = observe();
    const decision = { review_id: review.attempt_id, head_sha: state.run.accepted_head,
      verification_id: state.attempts.filter((a: any) => a.action === 'verification' && a.status === 'accepted').at(-1)?.id ?? null,
      decisions };
    const file = join(run, 'test-triage.json'); writeFileSync(file, JSON.stringify(decision));
    return recordFinalTriage(run, 'final-controller', file);
  };
  const repair = async (round: number) => {
    const attempt = await dispatchFinalWork(run, 'final-controller', 'repair', call);
    const base = observe().run.accepted_head;
    writeFileSync(join(f.root, 'sample.ts'), `export const repaired = ${round};\n`);
    f.git('add', 'sample.ts'); f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', `Repair fixture ${round}\n\nCo-Authored-By: Test <noreply@test.invalid>`);
    const head = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD']).stdout.toString().trim();
    const decision = JSON.parse(readFileSync(observe().run.decision_path, 'utf8'));
    const report = { attempt_id: attempt.attempt_id, review_id: review.attempt_id, round, base_sha: base, head_sha: head, status: 'DONE', evidence: 'Synthetic repair',
      addressed_ids: decision.decisions.filter((d: any) => d.action === 'fix').map((d: any) => d.id), checks: [{ requirement: 'fixture test', status: 'PASS', evidence: 'Synthetic check' }] };
    writeFileSync(attempt.report, JSON.stringify(report));
    return { attempt, report };
  };
  const verify = async (r: any, result: string, regressions: any[] = []) => {
    const attempt = await dispatchFinalWork(run, 'final-controller', 'verification', call);
    const report = { attempt_id: attempt.attempt_id, review_id: review.attempt_id, repair_id: r.attempt.attempt_id,
      round: r.report.round, base_sha: r.report.head_sha, head_sha: r.report.head_sha, evidence: 'Synthetic verification',
      results: r.report.addressed_ids.map((id: string) => ({ id, status: result, evidence: 'Synthetic verification evidence' })), regressions: regressions.map(finalFindingFixture), coverage: finalCoverageFixture(f).coverage };
    writeFileSync(attempt.report, JSON.stringify(report));
    return { attempt, report };
  };
  return { ...f, run, call, calls, panes, observe, triage, repair, verify };
}

const replacementEvidence = { worker_stopped: true,
  worker_stop_evidence: 'Synthetic worker settled; all commands and background writers stopped.',
  partial_work: 'Preserve prior work and finish only the interrupted contract.' };

test('final reviewer replacement preserves scope and accepts delivery without reopening accepted review', async () => {
  const f = await finalDispatchFixture();
  const first = await f.dispatch();
  const decide = (extra = {}) => recoveryDecision(f.run, { ...replacementEvidence, ...extra });
  await expect(replaceWorker(f.run, 'other', decide(), f.call)).rejects.toThrow('Controller');
  await expect(takeOver(f.run, 'other', decide(), f.call)).rejects.toThrow('Wrong run kind');
  await expect(replaceWorker(f.run, 'final-controller', decide({ worker_index: 0 }), f.call)).rejects.toThrow('selected role');
  writeFileSync(first.report, '{}');
  await expect(replaceWorker(f.run, 'final-controller', decide(), f.call)).rejects.toThrow('report exists');
  // Move the partial report to retained evidence, modelling operator inspection.
  renameSync(first.report, join(f.run, 'inspected-partial-report.json'));
  writeFileSync(join(f.root, 'sample.ts'), 'unexpected reviewer edit');
  await expect(replaceWorker(f.run, 'final-controller', decide(), f.call)).rejects.toThrow('clean');
  // Preserve the observation in ignored run evidence, restoring fixture contents only.
  renameSync(join(f.root, 'sample.ts'), join(f.run, 'unexpected-edit.txt'));
  let agent: any;
  const transport = async (...args: string[]) => {
    if (args[1] === 'split') return { pane: { pane_id: 'replacement-pane', tab_id: 'test-tab' } };
    if (args[1] === 'start') agent = { name: args[2], agent: args[4], pane_id: 'replacement-pane',
      tab_id: 'test-tab', agent_status: 'idle', cwd: f.root, foreground_cwd: f.root };
    if (args[0] === 'agent' && agent) return { agent };
    if (args[0] === 'pane' && args[2] === 'replacement-pane' && args[1] === 'get')
      throw new HerdrError('Closed fixture replacement', 'pane_not_found');
    return f.call(...args);
  };
  const replacement = await replaceWorker(f.run, 'final-controller', decide(), transport);
  const state = JSON.parse(cli('status', f.run).out);
  expect(state.run.stage).toBe('final_reviewing');
  expect(state.run.repair_count).toBe(0);
  expect(state.attempts[0].status).toBe('replaced');
  expect(state.attempts[1].base_sha).toBe(state.attempts[0].base_sha);
  expect(state.attempts[1].head_sha).toBe(state.attempts[0].head_sha);
  writeFileSync(replacement.report, JSON.stringify({ attempt_id: replacement.attempt_id,
    base_sha: f.finalInput.base, head_sha: f.finalInput.reviewedHEAD, evidence: 'Synthetic replacement review',
    findings: [], ...finalCoverageFixture(f) }));
  expect((await acceptFinalReview(f.run, 'final-controller', transport)).stage).toBe('review_reported');
  await expect(replaceWorker(f.run, 'final-controller', decide(), transport)).rejects.toThrow('outstanding attempt');
});

test('final repair and verifier replacement preserve relationships, partial work and round budget', async () => {
  const f = await finalLoopFixture();
  f.triage([{ id: 'F1', action: 'fix', evidence: 'Synthetic defect' }]);
  const first = await dispatchFinalWork(f.run, 'final-controller', 'repair', f.call);
  const baseline = f.observe().run.accepted_head;
  const reviewID = f.observe().attempts[0].id;
  writeFileSync(join(f.root, 'sample.ts'), 'export const repaired = 1;\n');
  f.git('add', 'sample.ts');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '-qm', 'Partial repair\n\nCo-Authored-By: Test <noreply@test.invalid>');
  writeFileSync(join(f.root, 'sample.ts'), 'export const repaired = 2;\n');
  const before = f.observe();
  await expect(replaceWorker(f.run, 'final-controller', recoveryDecision(f.run, replacementEvidence), async (...args) => {
    if (args[1] === 'start') {
      await f.call(...args);
      throw new HerdrError('Fixture approval', 'agent_not_ready');
    }
    return f.call(...args);
  })).rejects.toThrow('Fixture approval');
  const repaired = await dispatchFinalWork(f.run, 'final-controller', 'repair', f.call);
  expect(f.observe().worktree_fingerprint).toBe(before.worktree_fingerprint);
  expect(f.observe().run.repair_count).toBe(1);
  expect(f.observe().attempts.find((a: any) => a.id === first.attempt_id).status).toBe('replaced');
  f.git('add', 'sample.ts');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '-qm', 'Finish repair\n\nCo-Authored-By: Test <noreply@test.invalid>');
  const head = f.observe().observed_head;
  writeFileSync(repaired.report, JSON.stringify({ attempt_id: repaired.attempt_id, review_id: reviewID, round: 1,
    base_sha: baseline, head_sha: head, status: 'DONE', evidence: 'Synthetic repaired delivery', addressed_ids: ['F1'],
    checks: [{ requirement: 'fixture test', status: 'PASS', evidence: 'Synthetic test' }] }));
  await acceptFinalWork(f.run, 'final-controller', 'repair', f.call);
  const verifier = await dispatchFinalWork(f.run, 'final-controller', 'verification', f.call);
  const next = await replaceWorker(f.run, 'final-controller', recoveryDecision(f.run, replacementEvidence), f.call);
  expect(f.observe().attempts.find((a: any) => a.id === verifier.attempt_id).status).toBe('replaced');
  expect(f.observe().run.repair_count).toBe(1);
  writeFileSync(next.report, JSON.stringify({ attempt_id: next.attempt_id, review_id: reviewID,
    repair_id: repaired.attempt_id, round: 1, base_sha: head, head_sha: head, evidence: 'Synthetic verification',
    results: [{ id: 'F1', status: 'PASS', evidence: 'Synthetic check' }], regressions: [], coverage: finalCoverageFixture(f).coverage }));
  expect((await acceptFinalWork(f.run, 'final-controller', 'verification', f.call)).stage).toBe('final_completion_ready');
});

test('final repair commit correction preserves evidence and repair budget before verification', async () => {
  const f = await finalLoopFixture();
  f.triage([{ id: 'F1', action: 'fix', evidence: 'Synthetic valid finding' }]);
  const r = await f.repair(1);
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--amend', '-qm', 'Missing attribution');
  const head = () => Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD']).stdout.toString().trim();
  r.report.head_sha = head();
  writeFileSync(r.attempt.report, JSON.stringify(r.report));
  await expect(acceptFinalWork(f.run, 'final-controller', 'repair', f.call)).rejects.toThrow('commit trailer');
  const decision = join(f.run, 'commit-correction.json');
  writeFileSync(decision, JSON.stringify({ attempt_id: r.attempt.attempt_id, head_sha: head(),
    evidence: 'Missing commit trailer', unpushed: true, unpushed_evidence: 'Local fixture without remote or push' }));
  const correction = await correctReport(f.run, 'final-controller', 'final_repair', decision, f.call, true);
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--amend', '-qm', 'Repair fixture\n\nCo-Authored-By: Test <noreply@test.invalid>');
  r.report.head_sha = head();
  writeFileSync(correction.report, JSON.stringify({ ...r.report, evidence: 'Changed evidence' }));
  await expect(acceptFinalWork(f.run, 'final-controller', 'repair', f.call)).rejects.toThrow('only report head_sha');
  writeFileSync(correction.report, JSON.stringify(r.report));
  expect((await acceptFinalWork(f.run, 'final-controller', 'repair', f.call)).stage).toBe('final_verification_ready');
  expect(f.observe().run.repair_count).toBe(1);
  expect(f.observe().attempts.at(-1).correction_count).toBe(1);
});

test('final loop reuses implementer, uses fresh verifiers and gates exact completion evidence', async () => {
  const f = await finalLoopFixture();
  for (const [index, result] of ['FAIL', 'PARTIAL', 'PASS'].entries()) {
    f.triage([{ id: 'F1', action: 'fix', evidence: 'Synthetic valid finding' }]);
    const r = await f.repair(index + 1);
    await acceptFinalWork(f.run, 'final-controller', 'repair', f.call);
    const v = await f.verify(r, result);
    const bad = { ...v.report, head_sha: 'stale' };
    writeFileSync(v.attempt.report, JSON.stringify(bad));
    await expect(acceptFinalWork(f.run, 'final-controller', 'verification', f.call)).rejects.toThrow('provenance');
    writeFileSync(v.attempt.report, JSON.stringify(v.report));
    await acceptFinalWork(f.run, 'final-controller', 'verification', f.call);
  }
  const state = f.observe();
  expect(state.run.stage).toBe('final_completion_ready'); expect(state.run.repair_count).toBe(3);
  expect(new Set(state.attempts.filter((a: any) => a.action === 'repair').map((a: any) => a.worker_name)).size).toBe(1);
  expect(new Set(state.attempts.filter((a: any) => a.action === 'verification').map((a: any) => a.worker_name)).size).toBe(3);
  const evidence = join(f.run, 'test-completion.json');
  writeFileSync(evidence, JSON.stringify({ head_sha: state.run.accepted_head, deferred_ids: [], checks: [] }));
  await expect(completeFinalReview(f.run, 'final-controller', evidence, f.call)).rejects.toThrow('Required check/runtime');
  writeFileSync(evidence, JSON.stringify({ head_sha: state.run.accepted_head, deferred_ids: [], coverage_assessment: 'Synthetic requirement coverage assessment', checks: finalCoverageFixture(f).coverage }));
  expect((await completeFinalReview(f.run, 'final-controller', evidence, f.call)).stage).toBe('final_passed');
  expect([...f.panes]).toEqual(['parent']);
});

test('final triage rejects silent major waivers and carries introduced regressions', async () => {
  const f = await finalLoopFixture();
  expect(() => f.triage([])).toThrow('every finding');
  expect(() => f.triage([{ id: 'F1', action: 'wontfix', evidence: 'Skip' }])).toThrow('Major');
  expect(() => f.triage([{ id: 'F1', action: 'deferred', evidence: 'Skip' }])).toThrow('authorization');
  f.triage([{ id: 'F1', action: 'fix', evidence: 'Repair' }]);
  const r = await f.repair(1);
  const missing = { ...r.report, checks: [] }; writeFileSync(r.attempt.report, JSON.stringify(missing));
  await expect(acceptFinalWork(f.run, 'final-controller', 'repair', f.call)).rejects.toThrow('Required check');
  writeFileSync(r.attempt.report, JSON.stringify(r.report)); await acceptFinalWork(f.run, 'final-controller', 'repair', f.call);
  await f.verify(r, 'PASS', [{ id: 'R1', severity: 'major', category: 'code', status: 'open', description: 'Direct synthetic regression', evidence: 'Fixture regression' }]);
  await acceptFinalWork(f.run, 'final-controller', 'verification', f.call);
  expect(() => f.triage([{ id: 'F1', action: 'keep', evidence: 'Verified' }])).toThrow('every finding');
  expect(f.triage([{ id: 'F1', action: 'keep', evidence: 'Verified' }, { id: 'R1', action: 'fix', evidence: 'Repair regression' }]).stage).toBe('final_repair_ready');
});

test('verifier coverage gaps survive passing finding results and require final HEAD evidence', async () => {
  const f = await finalLoopFixture();
  f.triage([{ id: 'F1', action: 'fix', evidence: 'Synthetic confirmed finding' }]);
  const r = await f.repair(1);
  await acceptFinalWork(f.run, 'final-controller', 'repair', f.call);
  const v = await f.verify(r, 'PASS');
  writeFileSync(v.attempt.report, JSON.stringify({ ...v.report, coverage: [] }));
  await expect(acceptFinalWork(f.run, 'final-controller', 'verification', f.call)).rejects.toThrow('Coverage records');
  v.report.coverage.push({ requirement: 'Repair recovery mission', status: 'NOT_RUN', evidence: 'Synthetic missing runtime capability' });
  writeFileSync(v.attempt.report, JSON.stringify(v.report));
  await acceptFinalWork(f.run, 'final-controller', 'verification', f.call);
  const file = join(f.run, 'coverage-completion.json');
  const evidence: any = { head_sha: r.report.head_sha, deferred_ids: [], checks: finalCoverageFixture(f).coverage };
  const complete = () => { writeFileSync(file, JSON.stringify(evidence)); return completeFinalReview(f.run, 'final-controller', file, f.call); };
  await expect(complete()).rejects.toThrow('Required check/runtime');
  evidence.checks.push({ requirement: 'Repair recovery mission', status: 'PASS', evidence: 'Synthetic later runtime evidence at fix HEAD' });
  evidence.checks.push({ requirement: 'New completion-time mission', status: 'NOT_RUN', evidence: 'Synthetic newly identified gap' });
  await expect(complete()).rejects.toThrow('Required check/runtime');
  evidence.checks.pop(); // Remove this synthetic test-only extra requirement.
  await expect(complete()).rejects.toThrow('controller coverage assessment');
  evidence.coverage_assessment = 'Synthetic all promised behaviors accounted for';
  evidence.head_sha = f.finalInput.reviewedHEAD;
  await expect(complete()).rejects.toThrow('Stale completion');
  evidence.head_sha = r.report.head_sha;
  expect((await complete()).stage).toBe('final_passed');
  const state = f.observe();
  for (const [action, reference] of [['repair', 'implementer.md'], ['verification', 'final-verifier.md']]) {
    const dispatch = readFileSync(state.attempts.find((a: any) => a.action === action).dispatch_path, 'utf8');
    expect(dispatch).toContain(join(import.meta.dir, '../references', reference));
  }
});

test('final no-fix path skips verifier but requires explicit deferral disclosure', async () => {
  const f = await finalLoopFixture();
  f.triage([{ id: 'F1', action: 'deferred', evidence: 'Synthetic user decision', authorization_source: 'Fixture-only explicit approval' }]);
  const file = join(f.run, 'complete.json');
  const evidence = { head_sha: f.observe().run.accepted_head, deferred_ids: [] as string[], coverage_assessment: 'Synthetic requirement coverage assessment', checks: finalCoverageFixture(f).coverage };
  writeFileSync(file, JSON.stringify(evidence));
  await expect(completeFinalReview(f.run, 'final-controller', file, f.call)).rejects.toThrow('disclosed');
  evidence.deferred_ids = ['F1']; writeFileSync(file, JSON.stringify(evidence));
  expect((await completeFinalReview(f.run, 'final-controller', file, f.call)).deferred_ids).toEqual(['F1']);
  expect(f.calls.filter(c => c[1] === 'start')).toHaveLength(1);
});

test('final repair budget stops after three failed verification rounds', async () => {
  const f = await finalLoopFixture();
  for (let round = 1; round <= 3; round++) {
    f.triage([{ id: 'F1', action: 'fix', evidence: 'Synthetic unresolved issue' }]);
    const r = await f.repair(round);
    await acceptFinalWork(f.run, 'final-controller', 'repair', f.call);
    await f.verify(r, 'FAIL');
    await acceptFinalWork(f.run, 'final-controller', 'verification', f.call);
  }
  expect(() => f.triage([{ id: 'F1', action: 'fix', evidence: 'Fourth round' }])).toThrow('budget exhausted');
  expect(f.observe().run.repair_count).toBe(3);
  expect(f.observe().attempts.filter((a: any) => a.action === 'repair')).toHaveLength(3);
});

test('final repair rejects out-of-scope commits and verifier rejects dropped findings', async () => {
  const f = await finalLoopFixture();
  f.triage([{ id: 'F1', action: 'fix', evidence: 'Repair' }]);
  const r = await f.repair(1);
  await acceptFinalWork(f.run, 'final-controller', 'repair', f.call);
  const v = await f.verify(r, 'PASS');
  writeFileSync(v.attempt.report, JSON.stringify({ ...v.report, results: [] }));
  await expect(acceptFinalWork(f.run, 'final-controller', 'verification', f.call)).rejects.toThrow('every repaired finding');

  const other = await finalLoopFixture();
  other.triage([{ id: 'F1', action: 'fix', evidence: 'Repair' }]);
  const delivery = await other.repair(1);
  writeFileSync(join(other.root, 'outside.ts'), 'export const outside = true;');
  other.git('add', 'outside.ts');
  other.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Out-of-scope fixture\n\nCo-Authored-By: Test <noreply@test.invalid>');
  delivery.report.head_sha = Bun.spawnSync(['git', '-C', other.root, 'rev-parse', 'HEAD']).stdout.toString().trim();
  writeFileSync(delivery.attempt.report, JSON.stringify(delivery.report));
  await expect(acceptFinalWork(other.run, 'final-controller', 'repair', other.call)).rejects.toThrow('outside allowed scope');
  expect(existsSync(join(other.root, 'outside.ts'))).toBe(true);
});

test('report-only registration does not require a verifier but repair-loop does', () => {
  for (const intent of ['report_only', 'repair_loop']) {
    const f = finalFixture();
    const configPath = join(f.root, '.shawshank/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.roles.verifier;
    writeFileSync(configPath, JSON.stringify(config));
    f.git('add', '.shawshank/config.json');
    f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Remove unused verifier');
    f.finalInput.reviewedHEAD = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD']).stdout.toString().trim();
    f.finalInput.intent = intent; f.finalInput.authorization.intent = intent;
    if (intent === 'repair_loop') {
      (f.finalInput.authorization as any).localCommits = true;
      f.finalInput.scope.allowedPaths = ['sample.ts'] as never[];
    }
    f.save();
    const result = f.register();
    if (intent === 'report_only') expect(result.code).toBe(0);
    else expect(result.error).toContain('verifier configuration required');
  }
});

test('final registration snapshots inputs and reopens without workers', () => {
  const f = finalFixture();
  const result = f.register();
  expect(result.code).toBe(0);
  const run = JSON.parse(result.out).run;
  writeFileSync(f.input, '{}');
  const observed = JSON.parse(cli('status', run).out);
  expect(observed.run.kind).toBe('final_review');
  expect(observed.run.stage).toBe('final_ready');
  expect(observed.run.accepted_head).toBe(f.finalInput.reviewedHEAD);
  expect(observed.attempts).toEqual([]);
  expect(observed.discrepancies).toEqual([]);
  expect(JSON.parse(readFileSync(observed.run.task_path, 'utf8')).intent).toBe('report_only');
  expect(cli('dispatch-review', run, '--controller', 'final-controller').error).toContain('task commands cannot');
  f.save();
  expect(f.register().error).toContain('unfinished run');
  writeFileSync(f.input, JSON.stringify(f.task));
  expect(cli('register-task', f.input, '--controller', 'other').error).toContain('unfinished run');
});

test('final reviewer uses configured Claude permissions and keeps its registered snapshot', () => {
  const f = finalFixture();
  const configPath = join(f.root, '.shawshank/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const reviewer = JSON.parse(readFileSync(join(import.meta.dir, '../configs/config.example.json'), 'utf8')).roles.reviewer;
  expect(reviewer).toEqual({ kind: 'claude', provider: 'anthropic', model: 'opus', args: ['--model', 'opus', '--permission-mode', 'auto'] });
  config.roles.reviewer = reviewer;
  writeFileSync(configPath, JSON.stringify(config));
  f.git('add', '.shawshank/config.json');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Select final reviewer');
  f.finalInput.reviewedHEAD = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD']).stdout.toString().trim();
  f.save();
  const result = f.register();
  expect(result.code).toBe(0);
  const run = JSON.parse(result.out).run;
  config.roles.reviewer = { kind: 'codex', model: 'fixture-later', args: [] };
  writeFileSync(configPath, JSON.stringify(config));
  expect(JSON.parse(JSON.parse(cli('status', run).out).run.config_json).reviewer).toEqual(reviewer);
});

test('final registration rejects bad authorization, range, dirt and task evidence', () => {
  const f = finalFixture();
  f.finalInput.authorization.intent = 'repair_loop'; f.save();
  expect(f.register().error).toContain('Authorization intent');
  f.finalInput.authorization.intent = 'report_only';
  const head = f.finalInput.base;
  f.finalInput.base = 'HEAD'; f.save();
  expect(f.register().error).toContain('full commit SHA');
  f.finalInput.base = head;
  f.finalInput.entry = 'completed_plan'; f.save();
  expect(f.register().error).toContain('requires task evidence');
  (f.finalInput.taskEvidence as any[]).push({ kind: 'local_run', runId: 'missing' }); f.save();
  expect(f.register().error).toContain('passed local task');
  f.finalInput.entry = 'standalone'; f.finalInput.taskEvidence = []; f.save();
  writeFileSync(join(f.root, 'dirty.txt'), 'uncommitted');
  expect(f.register().error).toContain('must be clean');
});

test('final schema migration preserves old rows and supports terminal ownership', () => {
  const f = finalFixture();
  writeFileSync(f.input, JSON.stringify(f.task));
  const old = JSON.parse(cli('register-task', f.input, '--controller', 'task-controller').out);
  const database = join(f.root, '.shawshank/runs/workflow.sqlite');
  const db = new Database(database);
  // Reconstruct the pre-increment constraint as a declared migration fixture.
  db.exec('ALTER TABLE runs DROP COLUMN kind');
  db.exec("UPDATE runs SET stage='task_passed', accepted_head=base_sha");
  const schema = (db.query("SELECT sql FROM sqlite_schema WHERE name='attempts'").get() as any).sql;
  db.exec('DROP TABLE attempts');
  db.exec(schema.replace(/,\s*'final_review',\s*'verification'/, ''));
  db.query(`INSERT INTO attempts(rowid,id,run_id,action,status,dispatch_path,report_path,base_sha,started_at,cleanup_state)
    VALUES (17,'historical',?,'review','accepted','dispatch','report',?,'then','closed')`)
    .run(old.run.split('/').at(-1), f.finalInput.base);
  db.close();
  f.save();
  f.finalInput.entry = 'completed_plan';
  (f.finalInput.taskEvidence as any[]).push({ kind: 'local_run', runId: old.run.split('/').at(-1) });
  f.save();
  expect(f.register().code).toBe(0);
  const migrated = new Database(database);
  expect((migrated.query("SELECT rowid,* FROM attempts WHERE id='historical'").get() as any).rowid).toBe(17);
  expect((migrated.query('SELECT kind FROM runs WHERE id=?').get(old.run.split('/').at(-1)) as any).kind).toBe('task');
  expect(migrated.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(f.register().error).toContain('unfinished run');
  migrated.exec("UPDATE runs SET stage='review_reported' WHERE kind='final_review'");
  expect(f.register().code).toBe(0);
  migrated.exec("UPDATE runs SET stage='final_passed' WHERE kind='final_review'");
  migrated.exec("UPDATE attempts SET pane_id='fixture-pane',cleanup_state='pending'");
  expect(f.register().error).toContain('pending worker cleanup');
  migrated.close();
});

test('failed migration rolls back table, data and kind addition', () => {
  const f = finalFixture();
  const first = f.register();
  expect(first.code).toBe(0);
  const database = join(f.root, '.shawshank/runs/workflow.sqlite');
  const db = new Database(database);
  db.exec("UPDATE runs SET stage='task_passed'; ALTER TABLE runs DROP COLUMN kind");
  const schema = (db.query("SELECT sql FROM sqlite_schema WHERE name='attempts'").get() as any).sql;
  db.exec('DROP TABLE attempts');
  db.exec(schema.replace(/,\s*'final_review',\s*'verification'/, ''));
  // Deliberately corrupt fixture: migration must refuse and preserve evidence.
  db.exec("INSERT INTO attempts(id,run_id,action,status,dispatch_path,report_path,base_sha,started_at) VALUES ('orphan','missing','review','accepted','d','r','s','t')");
  const before = db.query("SELECT sql FROM sqlite_schema WHERE name='attempts'").get();
  expect(f.register().code).toBe(1);
  expect(db.query("SELECT sql FROM sqlite_schema WHERE name='attempts'").get()).toEqual(before);
  expect((db.query('PRAGMA table_info(runs)').all() as any[]).some(c => c.name === 'kind')).toBe(false);
  expect(db.query("SELECT id FROM attempts WHERE id='orphan'").get()).toEqual({ id: 'orphan' });
  expect(db.query("SELECT name FROM sqlite_schema WHERE name='attempts_final_migration'").get()).toBeNull();
  db.close();
});
function fixture(externalInputs = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shawshank-step1-')));
  function git(...args: string[]) {
    const result = Bun.spawnSync(['git', '-C', root, ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '.shawshank/runs/\ntask.json\nbrief.md\n');
  git('add', '.gitignore');
  git('-c', 'user.name=Workflow Test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initialize fixture');
  const inputs = externalInputs ? realpathSync(mkdtempSync(join(tmpdir(), 'workflow-inputs-'))) : root;
  writeFileSync(join(inputs, 'brief.md'), 'Implement only the approved fixture change.\n');
  const task = { worktree: root, goal: 'Fixture task', brief: 'brief.md',
    allowedPaths: ['sample.ts'], nonGoals: [], acceptance: ['Run covering tests'],
    dependencies: [], authorization: { source: 'Test fixture authorization', localCommits: true }, tier: 'standard' };
  const input = join(inputs, 'task.json');
  writeFileSync(input, JSON.stringify(task));
  return { root, input, task, git };
}
function cli(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, script, ...args]);
  return { code: result.exitCode, out: result.stdout.toString(), error: result.stderr.toString() };
}

test('real CLI processes persist and reopen a run without dispatching', () => {
  const f = fixture();
  const first = cli('register-task', f.input, '--controller', 'controller-a');
  expect(first.code).toBe(0);
  const registered = JSON.parse(first.out);
  const second = cli('status', registered.run);
  expect(second.code).toBe(0);
  const observed = JSON.parse(second.out);
  expect(observed.run.stage).toBe('registered');
  expect(observed.run.controller_id).toBe('controller-a');
  expect(observed.observed_head).toBe(registered.base_sha);
  expect(observed.discrepancies).toEqual([]);
  const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'), { readonly: true });
  expect(db.query('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
  db.close();
});

test('review report correction retains the original and is limited to one dispatch', async () => {
  const f = await reviewFixture();
  const review = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  writeFileSync(review.report, '{}');
  await expect(acceptReview(f.registered.run, 'a', f.reviewTransport)).rejects.toThrow('provenance');
  const decision = join(f.registered.run, 'correction-input.json');
  writeFileSync(decision, JSON.stringify({ attempt_id: review.attempt_id, evidence: 'Missing required provenance fields.' }));
  const correction = await correctReport(f.registered.run, 'a', 'review', decision, f.reviewTransport);
  expect(correction.report).not.toBe(review.report);
  expect(existsSync(review.report)).toBe(true);
  await expect(correctReport(f.registered.run, 'a', 'review', decision, f.reviewTransport)).rejects.toThrow('user judgment');
  writeFileSync(correction.report, JSON.stringify({ attempt_id: review.attempt_id, base_sha: f.registered.base_sha,
    head_sha: f.head, findings: [], evidence: 'Inspected the task and source.' }));
  await acceptReview(f.registered.run, 'a', f.reviewTransport);
  expect(JSON.parse(cli('status', f.registered.run).out).attempts.at(-1).correction_count).toBe(1);
});

test('uncertain review prompt is not replayed', async () => {
  const f = await reviewFixture();
  let prompts = 0;
  const transport = async (...args: string[]) => {
    if (args[1] === 'prompt') { prompts++; throw new Error('Lost response after submission'); }
    return f.reviewTransport(...args);
  };
  await expect(dispatchReview(f.registered.run, 'a', transport)).rejects.toThrow('Lost response');
  await expect(dispatchReview(f.registered.run, 'a', transport)).rejects.toThrow('replay is forbidden');
  expect(prompts).toBe(1);
  expect(JSON.parse(cli('status', f.registered.run).out).run.stage).toBe('review_dispatching');
});

test('report-only correction cannot accept an additional implementation commit', async () => {
  const f = dispatchFixture();
  const delivery = await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 42;\n');
  f.commit();
  writeFileSync(delivery.report, '{}');
  const decision = join(f.registered.run, 'correction.json');
  writeFileSync(decision, JSON.stringify({ attempt_id: delivery.attempt_id, evidence: 'Missing report fields.' }));
  const corrected = await correctReport(f.registered.run, 'a', 'implementation', decision, f.transport);
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 43;\n');
  f.commit();
  writeFileSync(corrected.report, JSON.stringify({ attempt_id: delivery.attempt_id,
    base_sha: f.registered.base_sha, head_sha: JSON.parse(cli('status', f.registered.run).out).observed_head,
    status: 'DONE', concerns: [], checks: [{ requirement: f.task.acceptance[0], status: 'PASS',
      evidence: { command: 'fixture assertion', result: 'passed' } }] }));
  await expect(acceptImplementation(f.registered.run, 'a', f.transport)).rejects.toThrow('Report-only correction changed Git HEAD');
});

test('duplicate registration preserves the first owner', () => {
  const f = fixture();
  const first = JSON.parse(cli('register-task', f.input, '--controller', 'a').out);
  const duplicate = cli('register-task', f.input, '--controller', 'b');
  expect(duplicate.code).toBe(1);
  expect(duplicate.error).toContain('unfinished run');
  expect(JSON.parse(cli('status', first.run).out).run.controller_id).toBe('a');
});

test('dirty work and absent commit authorization are rejected', () => {
  const f = fixture();
  f.task.authorization.localCommits = false;
  writeFileSync(f.input, JSON.stringify(f.task));
  expect(cli('register-task', f.input, '--controller', 'a').error).toContain('authorization');
  f.task.authorization.localCommits = true;
  writeFileSync(f.input, JSON.stringify(f.task));
  writeFileSync(join(f.root, 'unexpected.txt'), 'User work');
  expect(cli('register-task', f.input, '--controller', 'a').error).toContain('not clean');
});

test('status reports later changes without modifying progress', () => {
  const f = fixture();
  const run = JSON.parse(cli('register-task', f.input, '--controller', 'a').out).run;
  writeFileSync(join(f.root, 'unexpected.txt'), 'User work');
  const observed = JSON.parse(cli('status', run).out);
  expect(observed.discrepancies).toContain('Working tree is dirty');
  expect(observed.next_action).toBe('resolve_discrepancies');
  expect(observed.run.stage).toBe('registered');
});

test('concurrent registrations yield exactly one owner', async () => {
  const f = fixture();
  const children = ['a', 'b'].map(owner => Bun.spawn([process.execPath, script,
    'register-task', f.input, '--controller', owner], { stdout: 'pipe', stderr: 'pipe' }));
  const codes = await Promise.all(children.map(child => child.exited));
  expect(codes.sort()).toEqual([0, 1]);
  const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'), { readonly: true });
  expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  db.close();
});

test('cleanliness checks override hidden untracked-file preferences', () => {
  const f = fixture();
  f.git('config', 'status.showUntrackedFiles', 'no');
  const run = JSON.parse(cli('register-task', f.input, '--controller', 'a').out).run;
  writeFileSync(join(f.root, 'user-work.txt'), 'Preserve this');
  expect(JSON.parse(cli('status', run).out).discrepancies).toContain('Working tree is dirty');
  expect(cli('register-task', f.input, '--controller', 'b').error).toContain('not clean');
});

for (const ignored of [true, false]) {
  test(`linked worktree storage must be ignored in common checkout: ${ignored}`, () => {
    const f = fixture();
    if (!ignored) {
      writeFileSync(join(f.root, '.gitignore'), 'task.json\nbrief.md\n');
      f.git('add', '.gitignore');
      f.git('-c', 'user.name=Workflow Test', '-c', 'user.email=test@example.invalid',
        '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Remove runtime ignore');
    }
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'shawshank-linked-'))), 'tree');
    f.git('worktree', 'add', '-qb', 'linked', linked);
    f.task.worktree = linked;
    writeFileSync(f.input, JSON.stringify(f.task));
    const result = cli('register-task', f.input, '--controller', 'a');
    expect(result.code).toBe(ignored ? 0 : 1);
    const database = join(f.root, '.shawshank/runs/workflow.sqlite');
    expect(existsSync(database)).toBe(ignored);
    if (ignored) expect(JSON.parse(cli('status', JSON.parse(result.out).run).out).discrepancies).toEqual([]);
    else expect(result.error).toContain('Ignore .shawshank/runs/');
  });
}

test('dispatch and acceptance validate identity, provenance, and checks', async () => {
  const f = fixture();
  mkdirSync(join(f.root, '.shawshank'), { recursive: true });
  writeFileSync(join(f.root, '.shawshank/config.json'), JSON.stringify({
    roles: { implementer: { standard: [{ kind: 'codex', model: 'fixture', args: [] }] } },
    project: { commitTrailer: 'Co-Authored-By: Test <noreply@example.invalid>' },
  }));
  f.git('add', '.shawshank/config.json');
  const commit = (message: string) => f.git('-c', 'user.name=Workflow Test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message);
  commit('Configure fixture');
  const registered = JSON.parse(cli('register-task', f.input, '--controller', 'a').out);
  let name = '';
  let calls = 0;
  let splits = 0;
  let prompts = 0;
  const transport = async (...args: string[]) => {
    calls++;
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'p1', tab_id: 'test' } };
    if (args[0] === 'pane') { splits++; return { pane: { pane_id: 'p2', tab_id: 'test' } }; }
    if (args[1] === 'start') { name = args[2]; throw new HerdrError('Fixture startup approval', 'agent_not_ready'); }
    if (args[1] === 'prompt') prompts++;
    return { agent: { name, pane_id: 'p2', tab_id: 'test', agent: 'codex', agent_status: 'idle' } };
  };
  await expect(dispatchImplementation(registered.run, 'wrong', 'p1', 'test', transport)).rejects.toThrow('Controller');
  expect(calls).toBe(0);
  await expect(dispatchImplementation(registered.run, 'a', 'p1', 'test', transport)).rejects.toThrow('startup approval');
  expect(prompts).toBe(0);
  const dispatched = await dispatchImplementation(registered.run, 'a', 'p1', 'test', transport);
  expect(splits).toBe(1);
  expect(prompts).toBe(1);
  await expect(dispatchImplementation(registered.run, 'a', 'p1', 'test', transport)).rejects.toThrow('Expected registered');
  await expect(acceptImplementation(registered.run, 'a', async () => ({ agent: {
    name, pane_id: 'other-pane', tab_id: 'test', agent: 'codex', agent_status: 'idle',
  } }))).rejects.toThrow('identity/readiness');
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 42;\n');
  f.git('add', 'sample.ts');
  commit('Implement fixture\n\nCo-Authored-By: Test <noreply@example.invalid>');
  const head = JSON.parse(cli('status', registered.run).out).observed_head;
  const report = { attempt_id: dispatched.attempt_id, base_sha: registered.base_sha,
    head_sha: 'wrong', status: 'DONE', concerns: [], checks: [] as any[] };
  writeFileSync(dispatched.report, JSON.stringify(report));
  await expect(acceptImplementation(registered.run, 'a', transport)).rejects.toThrow('provenance');
  report.head_sha = head;
  writeFileSync(dispatched.report, JSON.stringify(report));
  await expect(acceptImplementation(registered.run, 'a', transport)).rejects.toThrow('acceptance evidence');
  report.checks = [{ requirement: f.task.acceptance[0], status: 'PASS', evidence: 'PASS' }];
  writeFileSync(dispatched.report, JSON.stringify(report));
  await expect(acceptImplementation(registered.run, 'a', transport)).rejects.toThrow('acceptance evidence');
  report.checks[0].evidence = { command: 'fixture assertion', result: 'answer equals 42' };
  writeFileSync(dispatched.report, JSON.stringify(report));
  const accepted = await acceptImplementation(registered.run, 'a', transport);
  expect(accepted.stage).toBe('implementation_accepted');
  expect(JSON.parse(cli('status', registered.run).out).next_action).toContain('dispatch-review');
});

function dispatchFixture(kind = 'codex', reviewerKind = 'codex', externalInputs = false, reviewerMetadata = {}) {
  const f = fixture(externalInputs);
  mkdirSync(join(f.root, '.shawshank'));
  writeFileSync(join(f.root, '.shawshank/config.json'), JSON.stringify({
    roles: { reviewer: { kind: 'codex', model: 'final-review-only', args: ['--model', 'final-review-only'] },
      taskReviewer: { kind: reviewerKind, model: 'review-fixture', args: ['--model', 'review-fixture'], ...reviewerMetadata },
      implementer: { standard: [{ kind, model: 'fixture', args: ['--model', 'fixture'] }],
        capable: [{ kind, model: 'capable-fixture', args: ['--model', 'capable-fixture'] }] } },
    project: { commitTrailer: 'Co-Authored-By: Test <noreply@example.invalid>' },
  }));
  const commit = () => {
    f.git('add', '.');
    f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm',
      'Fixture change\n\nCo-Authored-By: Test <noreply@example.invalid>');
  };
  commit();
  const registered = JSON.parse(cli('register-task', f.input, '--controller', 'a').out);
  let name = '';
  let prompts = 0;
  const closed = new Set<string>();
  const transport = async (...args: string[]) => {
    if (args[0] === 'pane') {
      if (args[1] === 'close') { closed.add(args[2]!); return { type: 'ok' }; }
      if (args[1] === 'get' && closed.has(args[2]!)) throw new HerdrError('Pane absent', 'pane_not_found');
      return { pane: { pane_id: args[1] === 'get' ? args[2]! : 'p2', tab_id: 'test' } };
    }
    if (args[1] === 'start') name = args[2];
    if (args[1] === 'prompt') prompts++;
    return { agent: { name, pane_id: 'p2', tab_id: 'test', agent: kind, agent_status: 'idle',
      cwd: f.root, foreground_cwd: f.root } };
  };
  return { ...f, registered, commit, transport, prompts: () => prompts };
}

function recoveryDecision(run: string, extra: any = {}) {
  const state = JSON.parse(cli('status', run).out);
  const file = join(run, `recovery-input-${crypto.randomUUID()}.json`);
  mkdirSync(run, {recursive:true});
  writeFileSync(file, JSON.stringify({previous_controller:state.run.controller_id,stage:state.run.stage,
    attempt_id:state.attempts.at(-1)?.id ?? null,head_sha:state.observed_head,
    worktree_fingerprint:state.worktree_fingerprint,previous_command_stopped:true,
    evidence:'Fixture command has returned; no in-flight transport remains.',
    session_evidence:'Same isolated fixture transport and test tab.',resolution:'retain',...extra}));
  return file;
}

const noLaunchEvidence = { resolution: 'no_launch', prompt_submitted: false,
  non_submission_evidence: 'Fixture transport rejected before prompt.', no_agent_evidence: 'Named worker absent; unused pane closed.',
  no_session_created: true, session_creation_evidence: 'Fixture prelaunch rejection; session.create never called.' };
const absentLaunch = async (...args: string[]) => {
  if (args[1] !== 'get') throw new Error('Recovery must be read-only');
  throw new HerdrError('Fixture absent', args[0] === 'agent' ? 'agent_not_found' : 'pane_not_found');
};

test('no-launch recovery releases task startup without replay and permits a fresh dispatch', async () => {
  const f = dispatchFixture('opencode');
  await expect(dispatchImplementation(f.registered.run, 'a', 'root', 'test', async (...args) => {
    if (args[1] === 'start') throw startupError(new Error('probe rejected'), 'prelaunch');
    return f.transport(...args);
  })).rejects.toThrow('pre-launch');
  const decide = (extra = {}) => recoveryDecision(f.registered.run, { ...noLaunchEvidence, ...extra });
  for (const extra of [{ prompt_submitted: true }, { no_session_created: false }, { no_agent_evidence: '' },
    { session_creation_evidence: '' }, { session_id: 'ses_conflict', session_unused: true }, { attempt_id: 'stale' }])
    await expect(resolveNoLaunch(f.registered.run, 'a', decide(extra), absentLaunch)).rejects.toThrow();
  await expect(resolveNoLaunch(f.registered.run, 'other', decide(), absentLaunch)).rejects.toThrow();
  await expect(resolveNoLaunch(f.registered.run, 'a', decide(), async () => ({ agent: { agent_status: 'idle' } }))).rejects.toThrow('still exists');
  await expect(resolveNoLaunch(f.registered.run, 'a', decide(), async () => { throw new Error('transport failure'); })).rejects.toThrow('transport failure');
  const original = JSON.parse(cli('status', f.registered.run).out).attempts[0];
  const dispatch = readFileSync(original.dispatch_path, 'utf8');
  const result = await resolveNoLaunch(f.registered.run, 'a', decide(), absentLaunch);
  expect(result.stage).toBe('registered');
  expect(f.prompts()).toBe(0);
  expect(readFileSync(original.dispatch_path, 'utf8')).toBe(dispatch);
  const saved = JSON.parse(JSON.parse(cli('status', f.registered.run).out).run.config_json).lastNoLaunchDecision;
  const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'));
  const config = JSON.parse((db.query('SELECT config_json FROM runs').get() as any).config_json);
  db.query('UPDATE runs SET config_json=?').run(JSON.stringify({ ...config, reusePane: true, controllerPane: 'stale' }));
  db.close();
  await dispatchImplementation(f.registered.run, 'a', 'root', 'test', f.transport);
  const state = JSON.parse(cli('status', f.registered.run).out);
  expect(JSON.parse(state.run.config_json).lastNoLaunchDecision).toBe(saved);
  expect(JSON.parse(state.run.config_json)).not.toHaveProperty('reusePane');
  expect(JSON.parse(state.run.config_json)).not.toHaveProperty('controllerPane');
  expect(state.attempts.map((a: any) => a.status)).toEqual(['no_launch', 'submitted']);
  expect(f.prompts()).toBe(1);
  await expect(resolveNoLaunch(f.registered.run, 'a', decide(), absentLaunch)).rejects.toThrow('No prepared dispatch');
});

test('no-launch creates missing run directory after the prepared-record crash window', async () => {
  const f = dispatchFixture('opencode');
  const run = f.registered.run;
  expect(existsSync(run)).toBe(false);
  const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'));
  const saved = db.query('SELECT * FROM runs').get() as any;
  // Model the committed dispatch intent before its first filesystem write.
  db.query(`INSERT INTO attempts(id,run_id,action,status,worker_kind,worker_name,dispatch_path,report_path,base_sha,started_at)
    VALUES ('crash-attempt',?,'implementation','prepared','opencode','crash-worker',?,?,?,?)`)
    .run(saved.id, join(run, 'dispatch.md'), join(run, 'report.json'), saved.base_sha, new Date().toISOString());
  db.query("UPDATE runs SET stage='dispatching'").run();
  db.close();
  const state = JSON.parse(cli('status', run).out);
  const external = mkdtempSync(join(tmpdir(), 'no-launch-decision-'));
  const decision = join(external, 'decision.json');
  writeFileSync(decision, JSON.stringify({ ...noLaunchEvidence, previous_controller: 'a', stage: 'dispatching',
    attempt_id: 'crash-attempt', previous_command_stopped: true, evidence: 'Simulated crash after intent commit.',
    session_evidence: 'Same isolated fixture session.', head_sha: state.observed_head,
    worktree_fingerprint: state.worktree_fingerprint, no_pane_created: true, no_pane_evidence: 'No transport calls occurred.' }));
  expect(existsSync(run)).toBe(false);
  expect((await resolveNoLaunch(run, 'a', decision, absentLaunch)).stage).toBe('registered');
  const after = JSON.parse(cli('status', run).out);
  const retained = JSON.parse(after.run.config_json).lastNoLaunchDecision;
  expect(JSON.parse(readFileSync(retained, 'utf8'))).toEqual(JSON.parse(readFileSync(decision, 'utf8')));
  expect(after.attempts[0].status).toBe('no_launch');
  await dispatchImplementation(run, 'a', 'root', 'test', f.transport);
  expect(f.prompts()).toBe(1);
});

test('retained task mismatch rejects before recording a new dispatch, including transaction-time drift', async () => {
  for (const duringCheck of [false, true]) {
    const f = dispatchFixture('opencode');
    await expect(dispatchImplementation(f.registered.run, 'a', 'root', 'test', async (...args) => {
      if (args[1] === 'start') throw startupError(new Error('probe'), 'prelaunch');
      return f.transport(...args);
    })).rejects.toThrow();
    await resolveNoLaunch(f.registered.run, 'a', recoveryDecision(f.registered.run, noLaunchEvidence), absentLaunch);
    const snapshot = join(f.registered.run, 'task.json');
    const change = () => writeFileSync(snapshot, JSON.stringify({ ...f.task, goal: 'Different retained contract' }));
    const before = JSON.parse(cli('status', f.registered.run).out);
    if (!duringCheck) change();
    let calls = 0;
    await expect(dispatchImplementation(f.registered.run, 'a', 'root', 'test', async (...args) => {
      calls++;
      if (duringCheck && args[0] === 'pane' && args[1] === 'get') change();
      return f.transport(...args);
    })).rejects.toThrow('Retained task input changed');
    const after = JSON.parse(cli('status', f.registered.run).out);
    expect(after.run).toEqual(before.run);
    expect(after.attempts).toEqual(before.attempts);
    expect(calls).toBe(duringCheck ? 1 : 0);
    expect(f.prompts()).toBe(0);
  }
});

test('no-launch rejects non-baseline work before observation and work changed during observation', async () => {
  for (const mode of ['dirty', 'commit', 'during']) {
    const f = dispatchFixture('opencode');
    await expect(dispatchImplementation(f.registered.run, 'a', 'root', 'test', async (...args) => {
      if (args[1] === 'start') throw startupError(new Error('probe'), 'prelaunch');
      return f.transport(...args);
    })).rejects.toThrow();
    const change = () => writeFileSync(join(f.root, 'partial.txt'), 'Preserve partial work');
    if (mode !== 'during') change();
    if (mode === 'commit') f.commit();
    const before = JSON.parse(cli('status', f.registered.run).out);
    let calls = 0;
    await expect(resolveNoLaunch(f.registered.run, 'a', recoveryDecision(f.registered.run, noLaunchEvidence), async (...args) => {
      calls++;
      if (mode === 'during') change();
      return absentLaunch(...args);
    })).rejects.toThrow();
    const after = JSON.parse(cli('status', f.registered.run).out);
    expect(after.run).toEqual(before.run);
    expect(after.attempts).toEqual(before.attempts);
    expect(readFileSync(join(f.root, 'partial.txt'), 'utf8')).toBe('Preserve partial work');
    if (mode !== 'during') expect(calls).toBe(0);
  }
});

test('failed-prelaunch replacement rejects rollback but another replacement preserves continuation', async () => {
  for (const mode of ['clean', 'partial', 'repair']) {
    const f = dispatchFixture('opencode');
    await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
    if (mode !== 'clean') {
      writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 41;\n'); f.commit();
      writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 42;\n');
      writeFileSync(join(f.root, 'partial.txt'), 'Preserve notes');
    }
    if (mode === 'repair') {
      const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'));
      db.query("UPDATE runs SET repair_count=4,tier='capable'").run();
      db.query("UPDATE attempts SET action='repair',correction_count=1").run();
      db.close();
    }
    const before = JSON.parse(cli('status', f.registered.run).out);
    const closed = new Set<string>();
    let split = 2, starts = 0, prompts = 0;
    let agent: any;
    const call = async (...args: string[]) => {
      if (args[0] === 'pane') {
        if (args[1] === 'close') { closed.add(args[2]); return { type: 'ok' }; }
        if (args[1] === 'get' && closed.has(args[2])) throw new HerdrError('Absent pane', 'pane_not_found');
        if (args[1] === 'split') return { pane: { pane_id: `p${++split}`, tab_id: 'test' } };
      }
      if (args[1] === 'start') {
        if (++starts === 1) throw startupError(new Error('fixture probe rejected'), 'prelaunch');
        agent = { name: args[2], pane_id: `p${split}`, tab_id: 'test', agent: 'opencode', agent_status: 'idle',
          cwd: f.root, foreground_cwd: f.root };
        return { agent };
      }
      if (args[1] === 'prompt') { prompts++; return {}; }
      return f.transport(...args);
    };
    const decision = () => recoveryDecision(f.registered.run, { worker_stopped: true,
      worker_stop_evidence: 'Fixture command stopped; no background writers or session creation.',
      partial_work: 'Preserve all prior continuation context, commits, dirty files and report-correction limits.' });
    await expect(replaceWorker(f.registered.run, 'a', decision(), call)).rejects.toThrow('pre-launch');
    const failed = JSON.parse(cli('status', f.registered.run).out);
    await expect(resolveNoLaunch(f.registered.run, 'a', recoveryDecision(f.registered.run, noLaunchEvidence), absentLaunch))
      .rejects.toThrow('Replacement continuation');
    const rejected = JSON.parse(cli('status', f.registered.run).out);
    expect(rejected.run).toEqual(failed.run);
    expect(rejected.attempts).toEqual(failed.attempts);
    // Operator confirms the unused failed-start split is closed before retrying replacement.
    await call('pane', 'close', failed.attempts.at(-1).pane_id);
    const result = await replaceWorker(f.registered.run, 'a', decision(), call);
    const after = JSON.parse(cli('status', f.registered.run).out);
    expect(after.run.stage).toBe('implementing');
    expect(after.run.repair_count).toBe(before.run.repair_count);
    expect(after.run.tier).toBe(before.run.tier);
    expect(after.observed_head).toBe(before.observed_head);
    expect(after.worktree_fingerprint).toBe(before.worktree_fingerprint);
    expect(after.attempts.at(-1).correction_count).toBe(before.attempts.at(-1).correction_count);
    expect(after.attempts.map((a: any) => a.status)).toEqual(['replaced', 'replaced', 'submitted']);
    expect(readFileSync(after.attempts.at(-1).dispatch_path, 'utf8')).toContain('Preserve all prior continuation context');
    expect(result.pane).toBe('p4');
    expect(starts).toBe(2);
    expect(prompts).toBe(1);
  }
});

test('no-launch recovery accepts only the assigned reusable shell and rechecks saved evidence', async () => {
  const f = dispatchFixture('opencode');
  await expect(dispatchImplementation(f.registered.run, 'a', 'root', 'test', async (...args) => {
    if (args[1] === 'start') throw startupError(new Error('probe'), 'prelaunch');
    return f.transport(...args);
  })).rejects.toThrow();
  const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'));
  const row = db.query('SELECT config_json FROM runs').get() as any;
  db.query('UPDATE runs SET config_json=?').run(JSON.stringify({ ...JSON.parse(row.config_json),
    reusePane: true, parentPane: 'p2', controllerPane: 'controller' }));
  db.close();
  const decision = recoveryDecision(f.registered.run, noLaunchEvidence);
  let changed = false;
  const call = async (...args: string[]) => {
    if (args[0] === 'agent') return absentLaunch(...args);
    if (args[1] === 'get') return { pane: { pane_id: 'p2', tab_id: changed ? 'other' : 'test' } };
    return { process_info: { pane_id: 'p2', shell_pid: 42, foreground_process_group_id: 42,
      foreground_processes: [{ pid: 42, argv0: 'zsh', cwd: f.root }] } };
  };
  changed = true;
  await expect(resolveNoLaunch(f.registered.run, 'a', decision, call)).rejects.toThrow('Pane identity');
  changed = false;
  await expect(resolveNoLaunch(f.registered.run, 'a', decision, async (...args) => {
    const result = await call(...args);
    if (args[1] === 'process-info') writeFileSync(decision, JSON.stringify({ ...JSON.parse(readFileSync(decision, 'utf8')), evidence: 'changed' }));
    return result;
  })).rejects.toThrow('evidence changed');
  expect((await resolveNoLaunch(f.registered.run, 'a', decision, call)).stage).toBe('registered');
  expect((await takeOver(f.registered.run, 'b', recoveryDecision(f.registered.run), call)).controller).toBe('b');
});

test('known unused sessions require OpenCode identity; other workers need no-session evidence', async () => {
  for (const kind of ['opencode', 'claude', 'codex']) {
    const f = await finalDispatchFixture();
    await expect(dispatchFinalReview(f.run, 'final-controller', 'parent', 'test-tab', async (...args) => {
      if (args[1] === 'start') throw startupError(new Error('prelaunch'), 'prelaunch');
      return f.call(...args);
    })).rejects.toThrow();
    const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'));
    db.query('UPDATE attempts SET worker_kind=?').run(kind);
    db.close();
    for (const id of ['ses', 'ses bad', 'other']) {
      const invalid = recoveryDecision(f.run, { ...noLaunchEvidence, no_session_created: false,
        session_id: id, session_unused: true });
      await expect(resolveNoLaunch(f.run, 'final-controller', invalid, absentLaunch)).rejects.toThrow('Establish no session');
    }
    const known = recoveryDecision(f.run, { ...noLaunchEvidence, no_session_created: false,
      session_id: 'ses_unused', session_unused: true });
    if (kind === 'opencode') {
      expect((await resolveNoLaunch(f.run, 'final-controller', known, absentLaunch)).stage).toBe('final_ready');
    } else {
      await expect(resolveNoLaunch(f.run, 'final-controller', known, absentLaunch)).rejects.toThrow('Establish no session');
      const absent = recoveryDecision(f.run, noLaunchEvidence);
      expect((await resolveNoLaunch(f.run, 'final-controller', absent, absentLaunch)).stage).toBe('final_ready');
    }
  }
});

for (const action of ['task-repair', 'task-rereview', 'final-repair']) {
test(`no-launch releases only the unprompted retained dispatch: ${action}`, async () => {
  let root: string, run: string, owner: string, call: (...args: string[]) => Promise<any>, dispatch: () => Promise<any>;
  if (action === 'final-repair') {
    const f = await finalLoopFixture();
    f.triage([{ id: 'F1', action: 'fix', evidence: 'Synthetic finding' }]);
    const r = await f.repair(1);
    await acceptFinalWork(f.run, 'final-controller', 'repair', f.call);
    await f.verify(r, 'FAIL');
    await acceptFinalWork(f.run, 'final-controller', 'verification', f.call);
    f.triage([{ id: 'F1', action: 'fix', evidence: 'Synthetic remaining finding' }]);
    root = f.root; run = f.run; owner = 'final-controller'; call = f.call;
    dispatch = () => dispatchFinalWork(run, owner, 'repair', call);
  } else {
    const f = await lifecycleFixture(true);
    await recordTriage(f.registered.run, 'a', f.decision, f.reviewTransport);
    root = f.root; run = f.registered.run; owner = 'a'; call = f.reviewTransport;
    if (action === 'task-rereview') {
      const r = await dispatchRepair(run, owner, call);
      writeFileSync(join(root, 'sample.ts'), 'export const answer = 43;\n'); f.commit();
      const head = JSON.parse(cli('status', run).out).observed_head;
      writeFileSync(r.report, JSON.stringify({ attempt_id: r.attempt_id, base_sha: f.registered.base_sha,
        head_sha: head, status: 'DONE', concerns: [], checks: [{ requirement: f.task.acceptance[0],
          status: 'PASS', evidence: { command: 'Synthetic test', result: 'passed' } }] }));
      await acceptImplementation(run, owner, call);
      dispatch = () => dispatchReview(run, owner, call);
    } else dispatch = () => dispatchRepair(run, owner, call);
  }
  const observe = () => JSON.parse(cli('status', run).out);
  const before = observe();
  const db = new Database(join(root, '.shawshank/runs/workflow.sqlite'));
  // Fail the durable pre-prompt update after the prepared intent is committed.
  db.exec(`CREATE TRIGGER fixture_crash BEFORE UPDATE OF status ON attempts
    WHEN NEW.status IN ('prompting','startup_blocked') BEGIN SELECT RAISE(ABORT,'fixture pre-prompt crash'); END`);
  await expect(dispatch()).rejects.toThrow('fixture pre-prompt crash');
  db.exec('DROP TRIGGER fixture_crash');
  const pending = observe().attempts.at(-1);
  const prior = before.attempts.findLast((a: any) => a.worker_name === pending.worker_name);
  expect(pending.status).toBe('prepared');
  const evidence = { resolution: 'no_launch', prompt_submitted: false,
    non_submission_evidence: 'Injected database failure before any prompt call for THIS attempt.',
    retained_attempt_id: prior.id, retained_worker_evidence: 'Same synthetic worker, no active command or writer.',
    no_session_created: true, session_creation_evidence: 'Existing accepted session reused; no start called.' };
  for (const extra of [{ retained_attempt_id: 'wrong' }, { retained_worker_evidence: '' },
    { non_submission_evidence: '' }, { previous_command_stopped: false }, { prompt_submitted: true }]) {
    await expect(resolveNoLaunch(run, owner, recoveryDecision(run, { ...evidence, ...extra }), call)).rejects.toThrow();
  }
  for (const live of [{ agent_status: 'working' }, { agent_status: 'blocked' }, { pane_id: 'other' }, { cwd: '/' }]) {
    await expect(resolveNoLaunch(run, owner, recoveryDecision(run, evidence), async (...args) => {
      const result = await call(...args); return { ...result, agent: { ...result.agent, ...live } };
    })).rejects.toThrow();
  }
  db.query("UPDATE attempts SET status='prompting' WHERE id=?").run(pending.id);
  await expect(resolveNoLaunch(run, owner, recoveryDecision(run, evidence), call)).rejects.toThrow('No prepared dispatch');
  db.query("UPDATE attempts SET status='prepared' WHERE id=?").run(pending.id);
  db.close();
  let reads = 0;
  await resolveNoLaunch(run, owner, recoveryDecision(run, evidence), async (...args) => {
    expect(args.slice(0, 2)).toEqual(['agent', 'get']); reads++; return call(...args);
  });
  const after = observe();
  expect(reads).toBe(1);
  expect(after.run.stage).toBe(before.run.stage);
  expect(after.run.repair_count).toBe(before.run.repair_count);
  expect(after.attempts.find((a: any) => a.id === prior.id)).toEqual(prior);
  expect(after.attempts.at(-1).status).toBe('no_launch');
  const resumed = await dispatch();
  expect(resumed.worker).toBe(prior.worker_name);
  expect(resumed.pane).toBe(prior.pane_id);
  expect(observe().run.repair_count).toBe(before.run.repair_count + (action === 'task-rereview' ? 0 : 1));
});
}

test('same no-launch resolution covers all task and final dispatch stages with bounded repair reservations', async () => {
  const cases = [
    ['review_dispatching', 'implementation_accepted', 'review'], ['repair_dispatching', 'repair_required', 'repair'],
    ['final_dispatching', 'final_ready', 'final_review'], ['final_repair_dispatching', 'final_repair_ready', 'repair'],
    ['final_verification_dispatching', 'final_verification_ready', 'verification'],
  ];
  for (const [stage, next, action] of cases) {
    const f = await finalDispatchFixture();
    await expect(dispatchFinalReview(f.run, 'final-controller', 'parent', 'test-tab', async (...args) => {
      if (args[1] === 'start') throw startupError(new Error('prelaunch'), 'prelaunch');
      return f.call(...args);
    })).rejects.toThrow();
    const db = new Database(join(f.root, '.shawshank/runs/workflow.sqlite'));
    // Declare a ledger fixture at each dispatch boundary; no live worker is used.
    const repair = action === 'repair';
    db.query('UPDATE runs SET stage=?,repair_count=?,tier=?').run(stage, repair ? 4 : 0, repair ? 'capable' : 'standard');
    db.query('UPDATE attempts SET action=?').run(action);
    db.close();
    const decision = recoveryDecision(f.run, noLaunchEvidence);
    expect((await resolveNoLaunch(f.run, 'final-controller', decision, absentLaunch)).stage).toBe(next);
    const state = JSON.parse(cli('status', f.run).out);
    expect(state.run.repair_count).toBe(repair ? 3 : 0);
    expect(state.run.tier).toBe(stage === 'repair_dispatching' ? 'standard' : repair ? 'capable' : 'standard');
    expect(state.attempts[0].status).toBe('no_launch');
    if (stage === 'final_dispatching') {
      await f.dispatch();
      expect(JSON.parse(cli('status', f.run).out).run.stage).toBe('final_reviewing');
    }
    expect(f.calls.filter(a => a[1] === 'prompt')).toHaveLength(stage === 'final_dispatching' ? 1 : 0);
  }
});

test('feature pane survives two complete task loops and final review without a spare shell split', async () => {
  const f = dispatchFixture();
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = 'controller';
  const panes = new Map<string, any>([['root', { pane_id: 'root', tab_id: 'test', terminal_id: 'root-terminal' }]]);
  const agents = new Map<string, any>();
  const calls: string[][] = [];
  let splits = 0;
  const transport = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'pane') {
      if (args[1] === 'process-info') return { process_info: { pane_id: args[3], shell_pid: 42,
        foreground_process_group_id: 42, foreground_processes: [{ pid: 42, argv0: 'zsh', cwd: f.root }] } };
      if (args[1] === 'split') {
        const pane = { pane_id: `review-${++splits}`, tab_id: 'test', terminal_id: `terminal-${splits}` };
        panes.set(pane.pane_id, pane); return { pane };
      }
      if (args[1] === 'close') { panes.delete(args[2]); return { type: 'ok' }; }
      const pane = panes.get(args[2]);
      if (!pane) throw new HerdrError('closed', 'pane_not_found');
      return { pane };
    }
    if (args[1] === 'start') {
      const pane = panes.get(args[args.indexOf('--pane') + 1]);
      const agent = { ...pane, name: args[2], agent: 'codex', agent_status: 'idle', cwd: f.root, foreground_cwd: f.root };
      pane.agent = 'codex'; agents.set(args[2], agent); return { agent };
    }
    const agent = agents.get(args[2]);
    if (args[1] === 'prompt' && args[3] === '/exit') {
      delete panes.get(agent.pane_id).agent; agents.delete(args[2]); return { type: 'ok' };
    }
    return { agent };
  };
  try {
    for (let index = 0; index < 2; index++) {
      const registration = index ? JSON.parse(cli('register-task', f.input, '--controller', 'a').out) : f.registered;
      const run = registration.run;
      const implementation = await dispatchImplementation(run, 'a', 'root', 'test', transport, undefined, true);
      expect(implementation.pane).toBe('root');
      expect(panes.size).toBe(1);
      writeFileSync(join(f.root, 'sample.ts'), `export const answer = ${42 + index};\n`);
      f.commit();
      const head = JSON.parse(cli('status', run).out).observed_head;
      writeFileSync(implementation.report, JSON.stringify({ attempt_id: implementation.attempt_id,
        base_sha: registration.base_sha, head_sha: head, status: 'DONE', concerns: [],
        checks: [{ requirement: f.task.acceptance[0], status: 'PASS', evidence: { command: 'fixture', result: 'passed' } }] }));
      await acceptImplementation(run, 'a', transport);
      const review = await dispatchReview(run, 'a', transport);
      expect(panes.size).toBe(2);
      writeFileSync(review.report, JSON.stringify({ attempt_id: review.attempt_id,
        base_sha: registration.base_sha, head_sha: head, evidence: 'Synthetic lifecycle review', findings: [] }));
      await acceptReview(run, 'a', transport);
      const decision = join(run, 'triage.json');
      writeFileSync(decision, JSON.stringify({ attempt_id: review.attempt_id, head_sha: head, decisions: [] }));
      const result = await recordTriage(run, 'a', decision, transport);
      expect(result.stage).toBe('task_passed');
      expect(result.cleanup.state).toBe('complete');
      expect([...panes.keys()]).toEqual(['root']);
      expect(panes.get('root').agent).toBeUndefined();
      await cleanupWorkers(run, 'a', transport);
    }
    expect(splits).toBe(2);
    expect(calls.filter(c => c[1] === 'prompt' && c[3] === '/exit')).toHaveLength(2);
    expect(calls.some(c => c[1] === 'close' && c[2] === 'root')).toBe(false);
    const head = Bun.spawnSync(['git', '-C', f.root, 'rev-parse', 'HEAD']).stdout.toString().trim();
    const finalInput = { worktree: f.root, base: f.registered.base_sha, reviewedHEAD: head,
      intent: 'report_only', entry: 'standalone',
      scope: { reference: 'fixture scope', description: 'Both completed fixture tasks', allowedPaths: [], nonGoals: [] },
      requiredChecks: [], runtimeMissions: [], environmentConstraints: [], taskEvidence: [],
      authorization: { source: 'Synthetic lifecycle test', intent: 'report_only' } };
    const finalInputPath = join(mkdtempSync(join(tmpdir(), 'shawshank-final-input-')), 'input.json');
    writeFileSync(finalInputPath, JSON.stringify(finalInput));
    const finalRegistration = cli('register-final-review', '--input', finalInputPath, '--controller', 'a');
    expect(finalRegistration.code).toBe(0);
    const finalRun = JSON.parse(finalRegistration.out).run;
    const finalAttempt = await dispatchFinalReview(finalRun, 'a', 'root', 'test', transport, true);
    expect(finalAttempt.pane).toBe('root');
    expect(panes.size).toBe(1);
    writeFileSync(finalAttempt.report, JSON.stringify({ attempt_id: finalAttempt.attempt_id,
      base_sha: finalInput.base, head_sha: head, evidence: 'Synthetic final review', findings: [],
      ...finalCoverageFixture({ ...f, finalInput }) }));
    expect((await acceptFinalReview(finalRun, 'a', transport)).stage).toBe('review_reported');
    expect([...panes.keys()]).toEqual(['root']);
    expect(panes.get('root').agent).toBeUndefined();
    expect(splits).toBe(2);
    expect(calls.filter(c => c[1] === 'prompt' && c[3] === '/exit')).toHaveLength(3);
  } finally {
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  }
});

test('fresh CLI controller takes over before dispatch without launching anything', () => {
  const f = dispatchFixture();
  const decision = recoveryDecision(f.registered.run);
  expect(cli('take-over',f.registered.run,'--controller','b','--decision',decision).code).toBe(0);
  const state = JSON.parse(cli('status',f.registered.run).out);
  expect(state.run.controller_id).toBe('b');
  expect(state.attempts).toHaveLength(0);
  expect(state.next_action).toBe('dispatch-implementation');
  expect(cli('take-over',f.registered.run,'--controller','c','--decision',decision).error).toContain('stale');
});

for (const point of ['after-start','after-prompt','after-result']) {
  test(`takeover reconciles ${point} without duplicate workers or prompts`, async () => {
    const f = dispatchFixture();
    let splits = 0;
    const transport = async (...args: string[]) => {
      if (args[1] === 'split') splits++;
      const result = await f.transport(...args);
      if (args[1] === (point === 'after-start' ? 'start' : 'prompt')) throw new Error('Injected lost receipt');
      return result;
    };
    await expect(dispatchImplementation(f.registered.run,'a','p1','test',transport)).rejects.toThrow('lost receipt');
    const snapshot = JSON.parse(cli('status',f.registered.run).out);
    const attempt = snapshot.attempts[0];
    if (point === 'after-result') {
      writeFileSync(join(f.root,'sample.ts'),'export const answer = 42;\n'); f.commit();
      const head = JSON.parse(cli('status',f.registered.run).out).observed_head;
      writeFileSync(attempt.report_path,JSON.stringify({attempt_id:attempt.id,base_sha:f.registered.base_sha,
        head_sha:head,status:'DONE',concerns:[],checks:[{requirement:f.task.acceptance[0],status:'PASS',
          evidence:{command:'fixture check',result:'passed'}}]}));
    }
    const decision = recoveryDecision(f.registered.run,{resolution:point === 'after-start' ? 'not_submitted' : 'submitted',
      non_submission_evidence:'Injected return interruption before prompt call; prompt count zero.',
      submission_evidence:'Fixture recorded prompt invocation before throwing its receipt.'});
    await takeOver(f.registered.run,'b',decision,f.transport);
    await expect(dispatchImplementation(f.registered.run,'a','p1','test',f.transport)).rejects.toThrow('Controller');
    if (point === 'after-start') await dispatchImplementation(f.registered.run,'b','p1','test',f.transport);
    if (point === 'after-result') expect((await acceptImplementation(f.registered.run,'b',f.transport)).stage).toBe('implementation_accepted');
    expect(f.prompts()).toBe(1);
    expect(splits).toBe(1);
    expect(JSON.parse(cli('status',f.registered.run).out).attempts).toHaveLength(1);
  });
}

test('unknown submission remains blocked after takeover and cannot replay', async () => {
  const f = dispatchFixture();
  await expect(dispatchImplementation(f.registered.run,'a','p1','test',async (...args) => {
    if (args[1] === 'prompt') throw new Error('Unknown submission');
    return f.transport(...args);
  })).rejects.toThrow();
  await expect(takeOver(f.registered.run,'b',recoveryDecision(f.registered.run),f.transport)).rejects.toThrow('explicit reconciliation');
  await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run,{resolution:'unresolved'}),f.transport);
  await expect(dispatchImplementation(f.registered.run,'b','p1','test',f.transport)).rejects.toThrow('Unresolved attempt');
  expect(f.prompts()).toBe(0);
});

for (const kind of ['codex', 'claude', 'opencode']) {
test(`replacement preserves partial commit and dirty contents without resetting counters: ${kind}`, async () => {
  const f = dispatchFixture(kind);
  const first = await dispatchImplementation(f.registered.run,'a','p1','test',f.transport);
  writeFileSync(join(f.root,'sample.ts'),'export const answer = 41;\n'); f.commit();
  writeFileSync(join(f.root,'sample.ts'),'export const answer = 42;\n');
  writeFileSync(join(f.root,'partial.txt'),'Retain uncommitted notes');
  const before = JSON.parse(cli('status',f.registered.run).out);
  let oldClosed = false;
  let newName = '';
  const transport = async (...args: string[]) => {
    if (args[1] === 'close') oldClosed = true;
    if (args[1] === 'split') { expect(oldClosed).toBe(true); return {pane:{pane_id:'p3',tab_id:'test'}}; }
    if (args[1] === 'start') { newName = args[2]!; throw new HerdrError('Replacement startup approval','agent_not_ready'); }
    if (newName && args[0] === 'agent') return {agent:{name:newName,pane_id:'p3',tab_id:'test',agent:kind,agent_status:'idle',cwd:f.root,foreground_cwd:f.root}};
    return f.transport(...args);
  };
  const decision = recoveryDecision(f.registered.run,{worker_stopped:true,worker_stop_evidence:'Idle fixture has no background writers.',partial_work:'Retain partial sample commit, dirty implementation, and partial.txt.'});
  await expect(replaceWorker(f.registered.run,'a',decision,transport)).rejects.toThrow('startup approval');
  const replacement = await dispatchImplementation(f.registered.run,'a','p1','test',transport);
  const after = JSON.parse(cli('status',f.registered.run).out);
  expect(after.observed_head).toBe(before.observed_head);
  expect(after.worktree_fingerprint).toBe(before.worktree_fingerprint);
  expect(after.run.base_sha).toBe(before.run.base_sha);
  expect(after.run.repair_count).toBe(before.run.repair_count);
  expect(after.attempts.find((a:any)=>a.id===first.attempt_id).status).toBe('replaced');
  expect(replacement.pane).toBe('p3');
  expect(readFileSync(join(f.root,'partial.txt'),'utf8')).toBe('Retain uncommitted notes');
});
}

test('repeated correction replacements preserve report-only context and accept without another commit', async () => {
  const f = dispatchFixture();
  const first = await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 42;\n'); f.commit();
  writeFileSync(first.report, '{}');
  const decision = join(f.registered.run, 'correction-input.json');
  writeFileSync(decision, JSON.stringify({attempt_id:first.attempt_id,evidence:'Missing check evidence.'}));
  await correctReport(f.registered.run, 'a', 'implementation', decision, f.transport);
  const head = JSON.parse(cli('status', f.registered.run).out).observed_head;
  const agents = new Map<string, any>();
  const closed = new Set<string>();
  let paneNumber = 2;
  const transport = async (...args: string[]) => {
    if (args[0] === 'pane') {
      if (args[1] === 'close') { closed.add(args[2]!); return {type:'ok'}; }
      if (args[1] === 'split') return {pane:{pane_id:`p${++paneNumber}`,tab_id:'test'}};
      if (closed.has(args[2]!)) throw new HerdrError('Absent fixture pane','pane_not_found');
      return {pane:{pane_id:args[2],tab_id:'test'}};
    }
    if (args[1] === 'start') agents.set(args[2]!, {name:args[2],pane_id:`p${paneNumber}`,tab_id:'test',
      agent:'codex',agent_status:'idle',cwd:f.root,foreground_cwd:f.root});
    return agents.has(args[2]!) ? {agent:agents.get(args[2]!)} : f.transport(...args);
  };
  let context = join(f.registered.run, `${first.attempt_id}-correction.md`);
  expect(readFileSync(context,'utf8')).toContain('Missing check evidence.');
  for (let round = 0; round < 2; round++) {
    const replacement = await replaceWorker(f.registered.run, 'a', recoveryDecision(f.registered.run, {
      worker_stopped:true,worker_stop_evidence:'Fixture has no writers.',partial_work:'Preserve committed implementation; correct report only.'
    }), transport);
    const attempt = JSON.parse(cli('status', f.registered.run).out).attempts.at(-1);
    const prompt = readFileSync(attempt.dispatch_path,'utf8');
    expect(prompt).toContain(`Do not modify code, commit, or change Git HEAD ${head}`);
    expect(prompt).toContain(context);
    expect(prompt).toContain(`attempt_id ${replacement.attempt_id}`);
    expect(prompt).toContain(replacement.report);
    expect(prompt).not.toContain('Implement, test, and commit.');
    expect(attempt.correction_count).toBe(1);
    expect(attempt.head_sha).toBe(head);
    context = attempt.dispatch_path;
    if (round === 1) {
      writeFileSync(replacement.report, JSON.stringify({attempt_id:replacement.attempt_id,base_sha:f.registered.base_sha,
        head_sha:head,status:'DONE',concerns:[],checks:[{requirement:f.task.acceptance[0],status:'PASS',
          evidence:{command:'fixture assertion',result:'passed'}}]}));
      expect((await acceptImplementation(f.registered.run,'a',transport)).stage).toBe('implementation_accepted');
    }
  }
});

test('replacement decision rejects modified partial work', async () => {
  const f = dispatchFixture();
  await dispatchImplementation(f.registered.run,'a','p1','test',f.transport);
  const decision = recoveryDecision(f.registered.run);
  writeFileSync(join(f.root,'new.txt'),'Unexpected new data');
  await expect(replaceWorker(f.registered.run,'a',decision,f.transport)).rejects.toThrow('Partial work differs');
  expect(JSON.parse(cli('status',f.registered.run).out).run.controller_id).toBe('a');
});

test('replacement before launch requires positive no-launch evidence', async () => {
  const f = dispatchFixture();
  await expect(dispatchImplementation(f.registered.run,'a','p1','test',async (...args) => {
    if (args[1] === 'split') throw new Error('Interrupted before launch');
    return f.transport(...args);
  })).rejects.toThrow('before launch');
  const extra = {worker_stopped:true,worker_stop_evidence:'No worker was ever started.',partial_work:'No partial edits; execute the original task.'};
  await expect(replaceWorker(f.registered.run,'a',recoveryDecision(f.registered.run,extra),f.transport)).rejects.toThrow('Missing pane receipt');
  const result = await replaceWorker(f.registered.run,'a',recoveryDecision(f.registered.run,{...extra,no_pane_created:true,
    no_pane_evidence:'Fixture throws before invoking split; zero external creation calls.'}),f.transport);
  expect(result.pane).toBe('p2');
  expect(f.prompts()).toBe(1);
  expect(JSON.parse(cli('status',f.registered.run).out).run.repair_count).toBe(0);
});

for (const workerState of ['working', 'blocked']) {
test(`controller takeover retains a ${workerState} worker without accepting delivery`, async () => {
  const f = dispatchFixture();
  await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
  writeFileSync(join(f.root, 'sample.ts'), 'export const partial = true;\n');
  const before = JSON.parse(cli('status', f.registered.run).out);
  const operations: string[] = [];
  const transport = async (...args: string[]) => {
    operations.push(args.slice(0, 2).join(' '));
    const result = await f.transport(...args);
    if (args[0] === 'agent' && args[1] === 'get') result.agent.agent_status = workerState;
    return result;
  };
  await takeOver(f.registered.run, 'b', recoveryDecision(f.registered.run), transport);
  const after = JSON.parse(cli('status', f.registered.run).out);
  expect(after.run.controller_id).toBe('b');
  expect(after.run.stage).toBe('implementing');
  expect(after.attempts).toEqual(before.attempts);
  expect(after.worktree_fingerprint).toBe(before.worktree_fingerprint);
  expect(operations).toEqual(['agent get']);
  expect(f.prompts()).toBe(1);
  await expect(acceptImplementation(f.registered.run, 'b', transport)).rejects.toThrow();
  expect(JSON.parse(cli('status', f.registered.run).out).run.stage).toBe('implementing');
});
}

test('ordinary takeover preserves worker edits and commits before and during identity checks', async () => {
  const f = dispatchFixture();
  await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
  const decision = recoveryDecision(f.registered.run);
  const before = JSON.parse(cli('status', f.registered.run).out);
  writeFileSync(join(f.root, 'sample.ts'), 'export const progress = 1;\n');
  f.commit();
  const operations: string[] = [];
  const transport = async (...args: string[]) => {
    operations.push(args.slice(0, 2).join(' '));
    const result = await f.transport(...args);
    if (args[0] === 'agent' && args[1] === 'get') {
      writeFileSync(join(f.root, 'sample.ts'), 'export const progress = 2;\n');
      f.commit();
      writeFileSync(join(f.root, 'sample.ts'), 'export const progress = 3;\n');
      result.agent.agent_status = 'working';
    }
    return result;
  };
  await takeOver(f.registered.run, 'b', decision, transport);
  const after = JSON.parse(cli('status', f.registered.run).out);
  expect(after.run.controller_id).toBe('b');
  expect(after.run.stage).toBe(before.run.stage);
  expect(after.run.accepted_head).toBe(before.run.accepted_head);
  expect(after.run.repair_count).toBe(before.run.repair_count);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.observed_head).not.toBe(before.observed_head);
  expect(readFileSync(join(f.root, 'sample.ts'), 'utf8')).toBe('export const progress = 3;\n');
  expect(operations).toEqual(['agent get']);
  expect(f.prompts()).toBe(1);
  await expect(acceptImplementation(f.registered.run, 'a', f.transport)).rejects.toThrow('Controller');
  await expect(acceptImplementation(f.registered.run, 'b', f.transport)).rejects.toThrow();
});

test('ordinary takeover still rejects changed identity, ledger or decision', async () => {
  for (const changed of ['identity', 'ledger', 'decision']) {
    const f = dispatchFixture();
    await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
    const decision = recoveryDecision(f.registered.run);
    await expect(takeOver(f.registered.run, 'b', decision, async (...args) => {
      const result = await f.transport(...args);
      if (args[0] === 'agent' && args[1] === 'get') {
        if (changed === 'identity') result.agent.name = 'unrelated-worker';
        else if (changed === 'ledger') {
          const db = new Database(join(f.registered.run, '../workflow.sqlite'));
          db.query('UPDATE runs SET controller_id=?').run('another-controller');
          db.close();
        } else {
          const input = JSON.parse(readFileSync(decision, 'utf8'));
          writeFileSync(decision, JSON.stringify({ ...input, evidence: 'Changed during inspection' }));
        }
      }
      return result;
    })).rejects.toThrow(changed === 'identity' ? 'identity' : changed === 'ledger' ? 'Run changed' : 'Recovery decision changed');
    expect(JSON.parse(cli('status', f.registered.run).out).run.controller_id).toBe(changed === 'ledger' ? 'another-controller' : 'a');
    expect(f.prompts()).toBe(1);
  }
});

test('only ordinary takeover omits worktree pins and still requires stopped-command evidence', async () => {
  const f = dispatchFixture();
  await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
  const decision = recoveryDecision(f.registered.run);
  const input = JSON.parse(readFileSync(decision, 'utf8'));
  delete input.head_sha; delete input.worktree_fingerprint;
  writeFileSync(decision, JSON.stringify({ ...input, previous_command_stopped: false }));
  await expect(takeOver(f.registered.run, 'b', decision, f.transport)).rejects.toThrow('previous command stopped');
  writeFileSync(decision, JSON.stringify({ ...input, resolution: 'unresolved' }));
  await expect(takeOver(f.registered.run, 'b', decision, f.transport)).rejects.toThrow('Partial work differs');
  writeFileSync(decision, JSON.stringify(input));
  expect((await takeOver(f.registered.run, 'b', decision, f.transport)).controller).toBe('b');
});

test('stale in-flight controller cannot persist or prompt after takeover', async () => {
  const f = dispatchFixture();
  let release!:()=>void;
  let entered!:()=>void;
  const gate = new Promise<void>(r=>{release=r;});
  const reached = new Promise<void>(r=>{entered=r;});
  const old = dispatchImplementation(f.registered.run,'a','p1','test',async (...args) => {
    const result = await f.transport(...args);
    if (args[1] === 'start') {entered(); await gate;}
    return result;
  });
  await reached;
  // Adversarial test: a lying termination assertion must not let a late callback
  // save its stale result or send the old prompt after ownership changes.
  await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run,{resolution:'unresolved'}),f.transport);
  const saved = cli('status',f.registered.run).out;
  release();
  await expect(old).rejects.toThrow('Controller');
  expect(cli('status',f.registered.run).out).toBe(saved);
  expect(f.prompts()).toBe(0);
});

test('takeover reconciles interrupted cleanup only after explicit termination evidence', async () => {
  const f = await lifecycleFixture();
  await recordTriage(f.registered.run,'a',f.decision,async (...args) => {
    if (args[1] === 'close') throw new Error('Fixture close unavailable');
    return f.reviewTransport(...args);
  });
  const db = new Database(join(f.root,'.shawshank/runs/workflow.sqlite'));
  db.query("UPDATE attempts SET cleanup_state='closing' WHERE run_id=?").run(f.registered.run.split('/').at(-1)!);
  db.close();
  await expect(takeOver(f.registered.run,'b',recoveryDecision(f.registered.run),f.reviewTransport)).rejects.toThrow('cleanup command');
  await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run,{cleanup_command_stopped:true}),f.reviewTransport);
  expect((await cleanupWorkers(f.registered.run,'b',f.reviewTransport)).state).toBe('complete');
  expect(JSON.parse(cli('status',f.registered.run).out).run.stage).toBe('task_passed');
});

test('replacement fingerprint detects index changes with identical working contents', async () => {
  const f = dispatchFixture();
  await dispatchImplementation(f.registered.run,'a','p1','test',f.transport);
  writeFileSync(join(f.root,'sample.ts'),'original'); f.commit();
  writeFileSync(join(f.root,'sample.ts'),'staged A'); f.git('add','sample.ts');
  writeFileSync(join(f.root,'sample.ts'),'working C');
  const decision = recoveryDecision(f.registered.run);
  writeFileSync(join(f.root,'sample.ts'),'staged B'); f.git('add','sample.ts');
  writeFileSync(join(f.root,'sample.ts'),'working C');
  await expect(replaceWorker(f.registered.run,'a',decision,f.transport)).rejects.toThrow('Partial work differs');
});

test('late cleanup receipt cannot overwrite the new controllers recovery state', async () => {
  const f = await lifecycleFixture();
  let release!:()=>void;
  let entered!:()=>void;
  const gate = new Promise<void>(r=>{release=r;});
  const reached = new Promise<void>(r=>{entered=r;});
  const old = recordTriage(f.registered.run,'a',f.decision,async (...args) => {
    const result = await f.reviewTransport(...args);
    if (args[1] === 'close' && args[2] === 'p2') {entered();await gate;}
    return result;
  });
  await reached;
  await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run,{cleanup_command_stopped:true}),f.reviewTransport);
  const before = cli('status',f.registered.run).out;
  release(); await old;
  expect(cli('status',f.registered.run).out).toBe(before);
  expect((await cleanupWorkers(f.registered.run,'b',f.reviewTransport)).state).toBe('complete');
});

test('positive settled reconciliation clears an unresolved takeover block', async () => {
  const f = dispatchFixture();
  await dispatchImplementation(f.registered.run,'a','p1','test',f.transport);
  await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run,{resolution:'unresolved'}),f.transport);
  await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run),f.transport);
  expect(JSON.parse(cli('status',f.registered.run).out).run.blocked_reason).toBeNull();
  expect(f.prompts()).toBe(1);
});

for (const submitted of [true,false]) {
  test(`lost correction receipt reconciles with submitted=${submitted} and retains budget`,async () => {
    const f = await reviewFixture();
    const review = await dispatchReview(f.registered.run,'a',f.reviewTransport);
    const correction = join(f.registered.run,'correction-input.json');
    writeFileSync(correction,JSON.stringify({attempt_id:review.attempt_id,evidence:'Malformed fixture report.'}));
    let prompts = 0;
    await expect(correctReport(f.registered.run,'a','review',correction,async (...args) => {
      if (args[1] === 'prompt') {if (submitted) prompts++; throw new Error('Correction receipt lost');}
      return f.reviewTransport(...args);
    })).rejects.toThrow('receipt lost');
    await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run,{resolution:submitted?'submitted':'not_submitted',
      submission_evidence:'Fixture recorded successful delivery.',non_submission_evidence:'Fixture threw before sending the prompt.'}),f.reviewTransport);
    if (!submitted) {
      await takeOver(f.registered.run,'c',recoveryDecision(f.registered.run,{resolution:'unresolved'}),f.reviewTransport);
      await takeOver(f.registered.run,'b',recoveryDecision(f.registered.run),f.reviewTransport);
    }
    if (!submitted) await correctReport(f.registered.run,'b','review',correction,async (...args) => {
      if (args[1] === 'prompt') prompts++;
      return f.reviewTransport(...args);
    });
    const attempt = JSON.parse(cli('status',f.registered.run).out).attempts.at(-1);
    expect(attempt.status).toBe('submitted');
    expect(attempt.correction_count).toBe(1);
    expect(attempt.head_sha).toBe(f.head);
    expect(prompts).toBe(1);
    writeFileSync(attempt.report_path,JSON.stringify({attempt_id:attempt.id,base_sha:f.registered.base_sha,
      head_sha:f.head,evidence:'Corrected fixture review.',findings:[]}));
    expect((await acceptReview(f.registered.run,'b',f.reviewTransport)).stage).toBe('review_accepted');
  });
}

for (const override of [{ agent: 'opencode' }, { tab_id: 'wrong' }, { agent_status: 'working' }]) {
  test(`initial startup rejects ${JSON.stringify(override)} before prompting`, async () => {
    const f = dispatchFixture();
    await expect(dispatchImplementation(f.registered.run, 'a', 'p1', 'test', async (...args) => {
      const result = await f.transport(...args);
      if (args[1] === 'start') Object.assign(result.agent!, override);
      return result;
    })).rejects.toThrow();
    expect(f.prompts()).toBe(0);
  });
}

test('V2 startup errors retain prepared state and cannot enter legacy automatic continuation', async () => {
  const f = dispatchFixture('opencode');
  const cause = new HerdrError('approval', 'agent_not_ready');
  await expect(dispatchImplementation(f.registered.run, 'a', 'p1', 'test', async (...args) => {
    const result = await f.transport(...args);
    if (args[1] === 'start') throw startupError(cause, 'session-start', 'ses_fixture');
    return result;
  })).rejects.toThrow('session-start unresolved');
  expect(JSON.parse(cli('status', f.registered.run).out).attempts.at(-1).status).toBe('prepared');
  await expect(dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport))
    .rejects.toThrow('explicit startup decision');
  expect(f.prompts()).toBe(0);
});

test('concurrent startup continuations claim the prompt exactly once', async () => {
  const f = dispatchFixture();
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const transport = async (...args: string[]) => {
    const result = await f.transport(...args);
    if (args[1] === 'start') throw new HerdrError('approval', 'agent_not_ready');
    if (args[0] === 'agent' && args[1] === 'get') {
      if (++arrivals === 2) release();
      await barrier;
    }
    return result;
  };
  await expect(dispatchImplementation(f.registered.run, 'a', 'p1', 'test', transport)).rejects.toThrow('approval');
  const outcomes = await Promise.allSettled([1, 2].map(() =>
    dispatchImplementation(f.registered.run, 'a', 'p1', 'test', transport)));
  expect(f.prompts()).toBe(1);
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  expect(JSON.parse(cli('status', f.registered.run).out).run.blocked_reason).toBeNull();
});

async function reviewFixture(startupDecision = false, kind = 'codex', reviewerKind = 'codex', externalInputs = false, reviewerMetadata = {}) {
  const f = dispatchFixture(kind, reviewerKind, externalInputs, reviewerMetadata);
  let decision: string | undefined;
  if (startupDecision) {
    await expect(dispatchImplementation(f.registered.run, 'a', 'p1', 'test', async (...args) => {
      const result = await f.transport(...args);
      if (args[1] === 'start') throw new HerdrError('approval', 'agent_not_ready');
      return result;
    })).rejects.toThrow('approval');
    const attempt = JSON.parse(cli('status', f.registered.run).out).attempts[0];
    decision = join(f.registered.run, 'startup-decision.json');
    writeFileSync(decision, JSON.stringify({ attempt_id: attempt.id, prompt_submitted: false,
      evidence: 'Observed startup approval before any prompt.' }));
  }
  const implementation = await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport, decision);
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 42;\n');
  f.commit();
  const head = JSON.parse(cli('status', f.registered.run).out).observed_head;
  writeFileSync(implementation.report, JSON.stringify({ attempt_id: implementation.attempt_id,
    base_sha: f.registered.base_sha, head_sha: head, status: 'DONE', concerns: [],
    checks: [{ requirement: f.task.acceptance[0], status: 'PASS',
      evidence: { command: 'fixture assertion', result: 'passed' } }] }));
  await acceptImplementation(f.registered.run, 'a', f.transport);
  let name = '';
  let prompts = 0;
  let sequence = 0;
  const reviewers = new Map<string, string>();
  const closed = new Set<string>();
  const transport = async (...args: string[]) => {
    if (args[0] === 'pane') {
      if (args[1] === 'split') return { pane: { pane_id: `review-pane-${++sequence}`, tab_id: 'test' } };
      if (!args[2]?.startsWith('review-pane-')) return f.transport(...args);
      if (args[1] === 'close') { closed.add(args[2]); return { type: 'ok' }; }
      if (closed.has(args[2])) throw new HerdrError('Pane absent', 'pane_not_found');
      return { pane: { pane_id: args[2], tab_id: 'test' } };
    }
    if (args[1] === 'start') { name = args[2]; reviewers.set(name, args[args.indexOf('--pane') + 1]!); }
    if (args[1] === 'prompt') prompts++;
    const target = args[2]!;
    if (!reviewers.has(target)) return f.transport(...args);
    return { agent: { name: target, pane_id: reviewers.get(target), tab_id: 'test', agent: reviewerKind, agent_status: 'idle',
      cwd: f.root, foreground_cwd: f.root } };
  };
  return { ...f, head, reviewTransport: transport, reviewPrompts: () => prompts };
}

test('new runs snapshot the configured Claude Opus task reviewer, not the final reviewer', async () => {
  const f = dispatchFixture();
  const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../configs/config.example.json'), 'utf8'));
  writeFileSync(join(f.root, '.git/info/exclude'), '.shawshank/config.local.json\n');
  writeFileSync(join(f.root, '.shawshank/config.local.json'), JSON.stringify({roles:{
    taskReviewer:defaults.roles.taskReviewer,reviewer:{kind:'codex',model:'final-only-fixture',args:[]}
  }}));
  await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
  const snapshot = JSON.parse(JSON.parse(cli('status', f.registered.run).out).run.config_json);
  expect(snapshot.reviewer).toEqual({kind:'claude',provider:'anthropic',model:'opus',args:['--model','opus','--permission-mode','auto']});
  expect(defaults.roles.taskReviewer).toMatchObject({kind:'claude',model:'opus',args:['--model','opus','--permission-mode','auto']});
  expect(snapshot.reviewer.model).not.toBe('final-only-fixture');
});

test('review dispatch preserves provider and effort without retaining unrelated fields', async () => {
  const f = await reviewFixture(false, 'codex', 'codex', false,
    { provider: 'openai', effort: 'medium', privateNote: 'synthetic excluded field' });
  const saved = () => JSON.parse(JSON.parse(cli('status', f.registered.run).out).run.config_json).reviewer;
  const before = saved();
  await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  expect(saved()).toEqual(before);
  expect(saved()).toMatchObject({ provider: 'openai', effort: 'medium' });
  expect(saved()).not.toHaveProperty('privateNote');
});

test('task reviewer snapshot survives later role overrides', async () => {
  const f = await reviewFixture(false, 'codex', 'claude');
  writeFileSync(join(f.root, '.shawshank/config.local.json'), JSON.stringify({roles:{
    taskReviewer:{kind:'opencode',model:'changed',args:[]},reviewer:{kind:'codex',model:'final-only',args:[]}
  }}));
  // Keep the overlay out of Git exactly as project-local configuration is stored.
  writeFileSync(join(f.root, '.git/info/exclude'), '.shawshank/config.local.json\n');
  const starts: string[][] = [];
  await dispatchReview(f.registered.run, 'a', async (...args) => {
    if (args[1] === 'start') starts.push(args);
    return f.reviewTransport(...args);
  });
  expect(starts[0]?.[starts[0].indexOf('--kind') + 1]).toBe('claude');
  expect(starts[0]?.slice(starts[0].indexOf('--'))).toEqual(['--','--model','review-fixture']);
});

for (const kind of ['claude', 'opencode']) {
  for (const reviewerKind of ['codex', 'claude', 'opencode']) {
    test(`configurable roles complete and repair: ${kind}/${reviewerKind}`, async () => {
      const f = await reviewFixture(true, kind, reviewerKind);
      const starts: string[][] = [];
      const transport = async (...args: string[]) => {
        if (args[1] === 'start') starts.push(args);
        return f.reviewTransport(...args);
      };
      const review = await dispatchReview(f.registered.run, 'a', transport);
      expect(starts[0]?.slice(starts[0].indexOf('--'))).toEqual(['--', '--model', 'review-fixture']);
      expect(starts[0]?.[starts[0].indexOf('--kind') + 1]).toBe(reviewerKind);
      writeFileSync(review.report, JSON.stringify({ attempt_id: review.attempt_id,
        base_sha: f.registered.base_sha, head_sha: f.head, evidence: 'Synthetic repair fixture.',
        findings: [{ id: 'F1', severity: 'major', category: 'in_scope', status: 'open', title: 'Fixture', evidence: 'Fixture-only finding.' }] }));
      await acceptReview(f.registered.run, 'a', transport);
      const decision = join(f.registered.run, 'role-triage.json');
      writeFileSync(decision, JSON.stringify({ attempt_id: review.attempt_id, head_sha: f.head,
        decisions: [{ id: 'F1', action: 'fix', evidence: 'Synthetic repair scenario.' }] }));
      await recordTriage(f.registered.run, 'a', decision, transport);
      const repair = await dispatchRepair(f.registered.run, 'a', transport);
      expect(repair.pane).toBe('p2');
      expect(starts).toHaveLength(1);
      writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 43;\n');
      f.commit();
      const head = JSON.parse(cli('status', f.registered.run).out).observed_head;
      writeFileSync(repair.report, JSON.stringify({ attempt_id: repair.attempt_id,
        base_sha: f.registered.base_sha, head_sha: head, status: 'DONE', concerns: [],
        checks: [{ requirement: f.task.acceptance[0], status: 'PASS', evidence: { command: 'fixture assertion', result: 'passed' } }] }));
      await acceptImplementation(f.registered.run, 'a', transport);
      const rereview = await dispatchReview(f.registered.run, 'a', transport);
      expect(rereview.pane).toBe(review.pane);
      expect(rereview.worker).toBe(review.worker);
      expect(rereview.attempt_id).not.toBe(review.attempt_id);
      expect(starts).toHaveLength(1);
      writeFileSync(rereview.report, JSON.stringify({ attempt_id: rereview.attempt_id,
        base_sha: f.registered.base_sha, head_sha: head, evidence: 'Fixture re-review.',
        findings: [{ id: 'F1', severity: 'major', category: 'in_scope', status: 'resolved', title: 'Fixture', evidence: 'Fixture resolved.' }] }));
      await acceptReview(f.registered.run, 'a', transport);
      writeFileSync(decision, JSON.stringify({ attempt_id: rereview.attempt_id, head_sha: head,
        decisions: [{ id: 'F1', action: 'resolved', evidence: 'Fixture re-review verified.' }] }));
      expect((await recordTriage(f.registered.run, 'a', decision, transport)).cleanup.state).toBe('complete');
      const state = JSON.parse(cli('status', f.registered.run).out);
      expect(state.run.repair_count).toBe(1);
      expect(state.attempts.every((a: any) => a.cleanup_state === 'closed')).toBe(true);
    });
  }
}

async function lifecycleFixture(fix = false) {
  const f = await reviewFixture();
  const review = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  writeFileSync(review.report, JSON.stringify({ attempt_id: review.attempt_id,
    base_sha: f.registered.base_sha, head_sha: f.head, evidence: 'Lifecycle fixture review.',
    findings: fix ? [{ id: 'F1', severity: 'minor', category: 'in_scope', status: 'open',
      title: 'Synthetic lifecycle test', evidence: 'Fixture-only repair request.' }] : [] }));
  await acceptReview(f.registered.run, 'a', f.reviewTransport);
  const decision = join(f.registered.run, 'lifecycle-triage.json');
  writeFileSync(decision, JSON.stringify({ attempt_id: review.attempt_id, head_sha: f.head,
    decisions: fix ? [{ id: 'F1', action: 'fix', evidence: 'Synthetic lifecycle fixture.' }] : [] }));
  return { ...f, review, decision };
}

test('triage automatically closes completed workers once and preserves files and success', async () => {
  const f = await lifecycleFixture();
  const closed: string[] = [];
  const transport = async (...args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'close') closed.push(args[2]!);
    return f.reviewTransport(...args);
  };
  expect((await cleanupWorkers(f.registered.run, 'a', transport)).state).toBe('not_due');
  expect(closed).toEqual([]);
  const report = readFileSync(f.review.report, 'utf8');
  const result = await recordTriage(f.registered.run, 'a', f.decision, transport);
  expect(result.stage).toBe('task_passed');
  expect(result.cleanup.state).toBe('complete');
  expect(closed.sort()).toEqual(['p2', f.review.pane].sort());
  expect(closed).not.toContain('p1');
  await cleanupWorkers(f.registered.run, 'a', transport);
  expect(closed).toHaveLength(2);
  expect(readFileSync(f.review.report, 'utf8')).toBe(report);
  expect(existsSync(join(f.root, 'sample.ts'))).toBe(true);
  const observed = JSON.parse(cli('status', f.registered.run).out);
  expect(observed.run.stage).toBe('task_passed');
  expect(observed.observed_head).toBe(f.head);
  expect(observed.cleanup.state).toBe('complete');
  expect(cli('register-task', f.input, '--controller', 'b').code).toBe(0);
});

test('repair triage retains both reviewer and original implementer', async () => {
  const f = await lifecycleFixture(true);
  const closed: string[] = [];
  const result = await recordTriage(f.registered.run, 'a', f.decision, async (...args) => {
    if (args[1] === 'close') closed.push(args[2]!);
    return f.reviewTransport(...args);
  });
  expect(result.stage).toBe('repair_required');
  expect(closed).toEqual([]);
  const repair = await dispatchRepair(f.registered.run, 'a', f.transport);
  expect(repair.pane).toBe('p2');
  expect(repair.repair_count).toBe(1);
  await cleanupWorkers(f.registered.run, 'a', f.reviewTransport);
  expect(closed).toEqual([]);
});

for (const override of [{agent_status: 'working'}, {agent_status: 'blocked'},
  {name: 'unrelated'}, {missing: true}]) {
test(`retained reviewer rejects ${JSON.stringify(override)} without relaunch or prompt`, async () => {
  const f = await lifecycleFixture(true);
  await recordTriage(f.registered.run, 'a', f.decision, f.reviewTransport);
  const repair = await dispatchRepair(f.registered.run, 'a', f.transport);
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 43;\n');
  f.commit();
  const head = JSON.parse(cli('status', f.registered.run).out).observed_head;
  writeFileSync(repair.report, JSON.stringify({attempt_id: repair.attempt_id,
    base_sha: f.registered.base_sha, head_sha: head, status: 'DONE', concerns: [],
    checks: [{requirement: f.task.acceptance[0], status: 'PASS',
      evidence: {command: 'fixture assertion', result: 'passed'}}]}));
  await acceptImplementation(f.registered.run, 'a', f.transport);
  const operations: string[] = [];
  await expect(dispatchReview(f.registered.run, 'a', async (...args) => {
    operations.push(args.slice(0, 2).join(' '));
    if (args[0] === 'agent' && args[1] === 'get' && args[2] === f.review.worker) {
      if ('missing' in override) throw new HerdrError('Fixture absent', 'agent_not_found');
      const result = await f.reviewTransport(...args);
      Object.assign(result.agent!, override);
      return result;
    }
    return f.reviewTransport(...args);
  })).rejects.toThrow();
  expect(operations).not.toContain('pane split');
  expect(operations).not.toContain('agent start');
  expect(operations).not.toContain('agent prompt');
  const state = JSON.parse(cli('status', f.registered.run).out);
  expect(state.run.stage).toBe('review_dispatching');
  expect(state.attempts.at(-1).pane_id).toBe(f.review.pane);
  expect(state.run.blocked_reason).toContain('Review dispatch unresolved');
  if ('missing' in override) {
    await replaceWorker(f.registered.run, 'a', recoveryDecision(f.registered.run, {
      worker_stopped: true, worker_stop_evidence: 'Fixture reviewer exited with no remaining writers.',
      partial_work: 'Preserve accepted implementation, repair, and prior review findings.'
    }), async (...args) => {
      if (args[0] === 'pane' && args[1] === 'get' && args[2] === f.review.pane)
        throw new HerdrError('Confirmed fixture pane absent', 'pane_not_found');
      return f.reviewTransport(...args);
    });
    const after = JSON.parse(cli('status', f.registered.run).out);
    expect(after.attempts.at(-1).pane_id).not.toBe(f.review.pane);
    expect(after.run.repair_count).toBe(1);
    expect(after.run.stage).toBe('reviewing');
    expect(after.attempts.find((a: any) => a.id === f.review.attempt_id).cleanup_state).toBe('closed');
    return;
  }
  // Once readiness is positively restored, continue the same unprompted attempt.
  const resumed = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  expect(resumed.attempt_id).toBe(state.attempts.at(-1).id);
  expect(resumed.worker).toBe(f.review.worker);
  expect(resumed.pane).toBe(f.review.pane);
});
}

test('close failure persists separately, blocks a new run, and retries safely', async () => {
  const f = await lifecycleFixture();
  let fail = true;
  let closes = 0;
  const transport = async (...args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'close' && args[2] === 'p2') {
      closes++;
      if (fail) throw new HerdrError('Fixture transport unavailable', 'unavailable');
    }
    return f.reviewTransport(...args);
  };
  const result = await recordTriage(f.registered.run, 'a', f.decision, transport);
  expect(result.stage).toBe('task_passed');
  expect(result.cleanup.pending).toHaveLength(1);
  const observed = JSON.parse(cli('status', f.registered.run).out);
  expect(observed.cleanup.pending[0].error).toContain('unavailable');
  expect(observed.run.stage).toBe('task_passed');
  expect(observed.next_action).toBe('cleanup-workers');
  expect(cli('register-task', f.input, '--controller', 'b').error).toContain('pending worker cleanup');
  fail = false;
  expect((await cleanupWorkers(f.registered.run, 'a', transport)).state).toBe('complete');
  expect(closes).toBe(2);
});

for (const override of [{ agent_status: 'working' }, { agent_status: 'blocked' },
  { agent_status: 'unknown' }, { name: 'replacement' }, { pane_id: 'other' },
  { tab_id: 'conversation' }, { cwd: '/private/tmp' }, { foreground_cwd: '/private/tmp' }]) {
  test(`cleanup preserves worker with ${JSON.stringify(override)}`, async () => {
    const f = await lifecycleFixture();
    let closed = false;
    const result = await recordTriage(f.registered.run, 'a', f.decision, async (...args) => {
      if (args[1] === 'close' && args[2] === 'p2') closed = true;
      const response = await f.reviewTransport(...args);
      if (args[0] === 'agent' && args[1] === 'get' && response.agent?.pane_id === 'p2')
        Object.assign(response.agent, override);
      return response;
    });
    expect(result.stage).toBe('task_passed');
    expect(closed).toBe(false);
    expect(result.cleanup.pending.map(a => a.pane)).toEqual(['p2']);
  });
}

test('lost close receipt is reconciled as already absent without a second close', async () => {
  const f = await lifecycleFixture();
  let closes = 0;
  const transport = async (...args: string[]) => {
    const result = await f.reviewTransport(...args);
    if (args[1] === 'close' && args[2] === 'p2') { closes++; throw new Error('Lost close receipt'); }
    return result;
  };
  const result = await recordTriage(f.registered.run, 'a', f.decision, transport);
  expect(result.cleanup.state).toBe('pending');
  expect((await cleanupWorkers(f.registered.run, 'a', transport)).state).toBe('complete');
  expect(closes).toBe(1);
});

test('close acknowledgment without actual disappearance stays pending', async () => {
  const f = await lifecycleFixture();
  const result = await recordTriage(f.registered.run, 'a', f.decision, async (...args) => {
    if (args[1] === 'close' && args[2] === 'p2') return { type: 'ok' };
    return f.reviewTransport(...args);
  });
  expect(result.cleanup.pending[0]?.error).toContain('still present');
  expect(result.stage).toBe('task_passed');
});

test('concurrent cleanup cannot claim a worker twice', async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closes = 0;
  const transport = async (...args: string[]) => {
    if (args[1] === 'get' && args[2] === 'p2') { entered(); await gate; }
    if (args[1] === 'close' && args[2] === 'p2') closes++;
    return f.reviewTransport(...args);
  };
  const first = recordTriage(f.registered.run, 'a', f.decision, transport);
  await waiting;
  try {
    await expect(cleanupWorkers(f.registered.run, 'a', transport)).rejects.toThrow('in progress');
    expect(JSON.parse(cli('status', f.registered.run).out).cleanup.pending[0].state).toBe('closing');
  } finally { release(); }
  expect((await first).cleanup.state).toBe('complete');
  expect(closes).toBe(1);
});

test('dirty worktree prevents cleanup without changing task success', async () => {
  const f = await lifecycleFixture();
  let dirty = false;
  let closes = 0;
  const result = await recordTriage(f.registered.run, 'a', f.decision, async (...args) => {
    if (!dirty) { writeFileSync(join(f.root, 'unaccepted.txt'), 'Preserve this output'); dirty = true; }
    if (args[1] === 'close') closes++;
    return f.reviewTransport(...args);
  });
  expect(result.stage).toBe('task_passed');
  expect(result.cleanup.state).toBe('pending');
  expect(closes).toBe(0);
  expect(readFileSync(join(f.root, 'unaccepted.txt'), 'utf8')).toBe('Preserve this output');
});

test('repair count persists through three reused rounds, escalation, and highest-tier stop', async () => {
  const f = await reviewFixture(false, 'codex', 'codex', true);
  let escalated = false;
  let starts = 0;
  let oldClosed = false;
  let rejectClose = true;
  const transport = async (...args: string[]) => {
    if (args[1] === 'close' && args[2] === 'p2') {
      if (rejectClose) { rejectClose = false; throw new Error('Synthetic close transport failure'); }
      oldClosed = true;
    }
    if (args[1] === 'start') expect(oldClosed).toBe(true);
    const result = await f.transport(...args);
    if (args[1] === 'split') result.pane!.pane_id = 'p3';
    if (args[1] === 'start') { escalated = true; starts++; }
    if (result.agent && escalated) result.agent.pane_id = 'p3';
    return result;
  };
  for (let round = 1; round <= 7; round++) {
    const head = JSON.parse(cli('status', f.registered.run).out).observed_head;
    const review = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
    writeFileSync(review.report, JSON.stringify({ attempt_id: review.attempt_id,
      base_sha: f.registered.base_sha, head_sha: head, evidence: 'Synthetic repair-budget fixture.',
      findings: [{ id: 'F1', severity: 'major', category: 'in_scope', status: 'open',
        title: 'Synthetic repeated finding', evidence: 'Labeled fixture, not an actual review.' }] }));
    await acceptReview(f.registered.run, 'a', f.reviewTransport);
    const decision = join(f.registered.run, `round-${round}.json`);
    writeFileSync(decision, JSON.stringify({ attempt_id: review.attempt_id, head_sha: head,
      decisions: [{ id: 'F1', action: 'fix', evidence: 'Synthetic budget test.' }] }));
    await recordTriage(f.registered.run, 'a', decision, f.reviewTransport);
    if (round === 7) {
      await expect(dispatchRepair(f.registered.run, 'a', transport)).rejects.toThrow('highest tier');
      break;
    }
    if (round === 4) {
      await expect(dispatchRepair(f.registered.run, 'a', transport)).rejects.toThrow('close transport failure');
      const failed = JSON.parse(cli('status', f.registered.run).out);
      expect(failed.run.repair_count).toBe(3);
      expect(failed.run.stage).toBe('repair_required');
      expect(failed.cleanup.pending[0].pane).toBe('p2');
      expect(starts).toBe(0);
    }
    const repair = await dispatchRepair(f.registered.run, 'a', transport);
    const attempt = JSON.parse(cli('status', f.registered.run).out).attempts.at(-1);
    const briefPath = join(f.input, '..', 'brief.md');
    expect(existsSync(join(f.root, 'brief.md'))).toBe(false);
    expect(readFileSync(attempt.dispatch_path, 'utf8')).toContain(briefPath);
    expect(readFileSync(briefPath, 'utf8')).toContain('approved fixture change');
    expect(repair.repair_count).toBe(round);
    expect(repair.pane).toBe(round <= 3 ? 'p2' : 'p3');
    writeFileSync(join(f.root, 'sample.ts'), `export const answer = ${42 + round};\n`);
    f.commit();
    writeFileSync(repair.report, JSON.stringify({ attempt_id: repair.attempt_id,
      base_sha: f.registered.base_sha, head_sha: JSON.parse(cli('status', f.registered.run).out).observed_head,
      status: 'DONE', concerns: [], checks: [{ requirement: f.task.acceptance[0], status: 'PASS',
        evidence: { command: 'fixture assertion', result: 'passed' } }] }));
    await acceptImplementation(f.registered.run, 'a', transport);
    if (round === 3) {
      await takeOver(f.registered.run,'replacement-controller',recoveryDecision(f.registered.run),transport);
      expect(JSON.parse(cli('status',f.registered.run).out).run.repair_count).toBe(3);
      await takeOver(f.registered.run,'a',recoveryDecision(f.registered.run),transport);
    }
  }
  expect(starts).toBe(1);
  const final = JSON.parse(cli('status', f.registered.run).out).run;
  expect(final.repair_count).toBe(6);
  expect(final.tier).toBe('capable');
  expect(final.stage).toBe('repair_required');
}, 20000);

test('independent review binds HEAD and requires explicit triage before passing', async () => {
  const f = await reviewFixture(true);
  await expect(dispatchReview(f.registered.run, 'wrong', f.reviewTransport)).rejects.toThrow('Controller');
  expect(f.reviewPrompts()).toBe(0);
  const review = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  expect(f.reviewPrompts()).toBe(1);
  await expect(dispatchReview(f.registered.run, 'a', f.reviewTransport)).rejects.toThrow();
  await expect(acceptReview(f.registered.run, 'a', f.reviewTransport)).rejects.toThrow();
  const report = { attempt_id: review.attempt_id, base_sha: f.registered.base_sha,
    head_sha: 'wrong', findings: [], evidence: 'Inspected sample.ts and task contract.' };
  writeFileSync(review.report, JSON.stringify(report));
  await expect(acceptReview(f.registered.run, 'a', f.reviewTransport)).rejects.toThrow('provenance');
  report.head_sha = f.head;
  writeFileSync(review.report, JSON.stringify(report));
  await acceptReview(f.registered.run, 'a', f.reviewTransport);
  expect(JSON.parse(cli('status', f.registered.run).out).run.stage).toBe('review_accepted');
  // The accepted artifact is snapshotted; rewriting the worker output cannot change triage.
  writeFileSync(review.report, '{}');
  const decision = join(f.registered.run, 'decision-input.json');
  writeFileSync(decision, JSON.stringify({ attempt_id: review.attempt_id, head_sha: f.head, decisions: [] }));
  expect((await recordTriage(f.registered.run, 'a', decision, f.reviewTransport)).stage).toBe('task_passed');
});

test('standalone repair and review retain dispatched task fields when caller input changes', async () => {
  const f = await reviewFixture(false, 'codex', 'codex', true);
  writeFileSync(f.input, JSON.stringify({ ...f.task, allowedPaths: ['outside.ts'], acceptance: ['Unapproved replacement check'] }));
  const review = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  const state = () => JSON.parse(cli('status', f.registered.run).out);
  expect(readFileSync(state().attempts.at(-1).dispatch_path, 'utf8')).not.toContain('Unapproved replacement check');
  writeFileSync(review.report, JSON.stringify({ attempt_id: review.attempt_id, base_sha: f.registered.base_sha,
    head_sha: f.head, evidence: 'Synthetic snapshot regression', findings: [{ id: 'F1', severity: 'major',
      category: 'in_scope', status: 'open', title: 'Synthetic repair', evidence: 'sample.ts:1 fixture' }] }));
  await acceptReview(f.registered.run, 'a', f.reviewTransport);
  const decision = join(f.registered.run, 'snapshot-triage.json');
  writeFileSync(decision, JSON.stringify({ attempt_id: review.attempt_id, head_sha: f.head,
    decisions: [{ id: 'F1', action: 'fix', evidence: 'Synthetic authorized repair' }] }));
  await recordTriage(f.registered.run, 'a', decision, f.reviewTransport);
  const repair = await dispatchRepair(f.registered.run, 'a', f.transport);
  expect(readFileSync(state().attempts.at(-1).dispatch_path, 'utf8')).not.toContain('Unapproved replacement check');
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 43;\n'); f.commit();
  writeFileSync(repair.report, JSON.stringify({ attempt_id: repair.attempt_id, base_sha: f.registered.base_sha,
    head_sha: state().observed_head, status: 'DONE', concerns: [], checks: [{ requirement: f.task.acceptance[0],
      status: 'PASS', evidence: { command: 'synthetic check', result: 'synthetic pass' } }] }));
  expect((await acceptImplementation(f.registered.run, 'a', f.transport)).stage).toBe('implementation_accepted');
});

test('major findings cannot disappear, be silently waived, or pass after reviewer edits', async () => {
  const f = await reviewFixture();
  const review = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  writeFileSync(review.report, JSON.stringify({ attempt_id: review.attempt_id,
    base_sha: f.registered.base_sha, head_sha: f.head, evidence: 'Concrete fixture review.',
    findings: [{ id: 'F1', severity: 'major', category: 'in_scope', status: 'open',
      title: 'Fixture defect', evidence: 'sample.ts:1 reproduction' },
      { id: 'F2', severity: 'major', category: 'in_scope', status: 'open',
        title: 'Synthetic deferred fixture finding', evidence: 'Labeled fixture for preserving user decisions.' }] }));
  writeFileSync(join(f.root, 'sample.ts'), 'Reviewer must not change this.\n');
  await expect(acceptReview(f.registered.run, 'a', f.reviewTransport)).rejects.toThrow('Git');
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 42;\n');
  await acceptReview(f.registered.run, 'a', f.reviewTransport);
  const decision = join(f.registered.run, 'decision-input.json');
  const data: any = { attempt_id: review.attempt_id, head_sha: f.head, decisions: [] };
  writeFileSync(decision, JSON.stringify(data));
  await expect(recordTriage(f.registered.run, 'a', decision, f.reviewTransport)).rejects.toThrow('every finding');
  data.decisions = [{ id: 'F1', action: 'wontfix', evidence: 'Too difficult' },
    { id: 'F2', action: 'deferred', evidence: 'Synthetic deferral for budget test.', user_authorization: 'Fixture user decision.' }];
  writeFileSync(decision, JSON.stringify(data));
  await expect(recordTriage(f.registered.run, 'a', decision, f.reviewTransport)).rejects.toThrow('user');
  data.decisions[0].action = 'fix';
  writeFileSync(decision, JSON.stringify(data));
  expect((await recordTriage(f.registered.run, 'a', decision, f.reviewTransport)).stage).toBe('repair_required');
  expect(JSON.parse(cli('status', f.registered.run).out).run.repair_count).toBe(0);
  const repaired = await dispatchRepair(f.registered.run, 'a', f.transport);
  expect(repaired.pane).toBe('p2');
  expect(repaired.repair_count).toBe(1);
  await expect(dispatchRepair(f.registered.run, 'a', f.transport)).rejects.toThrow();
  const delivery = { attempt_id: repaired.attempt_id, base_sha: f.registered.base_sha,
    head_sha: f.head, status: 'DONE', concerns: [], checks: [{ requirement: f.task.acceptance[0],
      status: 'PASS', evidence: { command: 'fixture assertion', result: 'passed' } }] };
  writeFileSync(repaired.report, JSON.stringify(delivery));
  await expect(acceptImplementation(f.registered.run, 'a', f.transport)).rejects.toThrow('no new commit');
  writeFileSync(join(f.root, 'sample.ts'), 'export const answer = 43;\n');
  f.commit();
  delivery.head_sha = JSON.parse(cli('status', f.registered.run).out).observed_head;
  writeFileSync(repaired.report, JSON.stringify(delivery));
  await acceptImplementation(f.registered.run, 'a', f.transport);
  const rereview = await dispatchReview(f.registered.run, 'a', f.reviewTransport);
  const result: any = { attempt_id: rereview.attempt_id, base_sha: f.registered.base_sha,
    head_sha: delivery.head_sha, findings: [], evidence: 'Rechecked fixture repair.' };
  writeFileSync(rereview.report, JSON.stringify(result));
  await expect(acceptReview(f.registered.run, 'a', f.reviewTransport)).rejects.toThrow('prior fix');
  result.findings = [{ id: 'F1', severity: 'major', category: 'in_scope', status: 'resolved',
    title: 'Fixture defect', evidence: 'sample.ts:1 updated and rechecked.' }];
  writeFileSync(rereview.report, JSON.stringify(result));
  await expect(acceptReview(f.registered.run, 'a', f.reviewTransport)).rejects.toThrow('prior');
  result.findings.push({ id: 'F2', severity: 'major', category: 'in_scope', status: 'open',
    title: 'Synthetic deferred fixture finding', evidence: 'The previous deferral remains open.' });
  writeFileSync(rereview.report, JSON.stringify(result));
  await acceptReview(f.registered.run, 'a', f.reviewTransport);
  writeFileSync(decision, JSON.stringify({ attempt_id: rereview.attempt_id, head_sha: delivery.head_sha,
    decisions: [{ id: 'F1', action: 'resolved', evidence: 'Independent reviewer verified the change.' }, data.decisions[1]] }));
  const passed = await recordTriage(f.registered.run, 'a', decision, f.reviewTransport);
  expect(passed.stage).toBe('task_passed');
  expect(passed.deferred.map((d: any) => d.id)).toEqual(['F2']);
  expect(JSON.parse(cli('status', f.registered.run).out).run.repair_count).toBe(1);
});

test('scope checks preserve leading whitespace in Git filenames', async () => {
  const f = dispatchFixture();
  const dispatched = await dispatchImplementation(f.registered.run, 'a', 'p1', 'test', f.transport);
  writeFileSync(join(f.root, ' sample.ts'), 'export const answer = 42;\n');
  f.commit();
  writeFileSync(dispatched.report, JSON.stringify({ attempt_id: dispatched.attempt_id,
    base_sha: f.registered.base_sha, head_sha: JSON.parse(cli('status', f.registered.run).out).observed_head,
    status: 'DONE', concerns: [], checks: [{ requirement: f.task.acceptance[0], status: 'PASS',
      evidence: { command: 'fixture assertion', result: 'passed' } }] }));
  await expect(acceptImplementation(f.registered.run, 'a', f.transport)).rejects.toThrow('outside allowed scope');
});
