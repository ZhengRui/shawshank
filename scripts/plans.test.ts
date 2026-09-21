import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { amendPlanScope, dispatchImplementation, takeOverPlan, acceptImplementation,
  dispatchReview, acceptReview, recordTriage, dispatchRepair, preparePlanFinalReview, resolveNoLaunch } from './workflow';
import { HerdrError } from './herdr';

const script = join(import.meta.dir, 'workflow.ts');
function cli(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, script, ...args]);
  return { code: r.exitCode, out: r.stdout.toString(), error: r.stderr.toString() };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-plan-')));
  const inputs = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-plan-inputs-')));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', root, ...args]);
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '.shawshank/runs/\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initialize');
  git('branch', 'review-target');
  writeFileSync(join(inputs, 'approved.md'), 'Approved two-task plan and final acceptance.');
  writeFileSync(join(inputs, 'brief.md'), 'Original brief');
  const task = { worktree: root, goal: 'Implement fixture', brief: 'brief.md', allowedPaths: ['a.ts'],
    nonGoals: [], acceptance: ['bun test'], dependencies: [], tier: 'standard',
    authorization: { source: 'Synthetic approved fixture', localCommits: true } };
  const taskPath = join(inputs, 'task.json');
  writeFileSync(taskPath, JSON.stringify(task));
  const input = { worktree: root, reference: 'approved.md',
    tasks: [{ key: 'first', title: 'Implement fixture' }, { key: 'second', title: 'Integrate fixture' }],
    authorization: { source: 'Synthetic approved fixture', localCommits: true, intent: 'repair_loop' },
    finalReview: { entry: 'completed_plan', intent: 'repair_loop', targetBranch: 'refs/heads/review-target',
      scope: { reference: 'approved.md', description: 'Whole feature', allowedPaths: ['a.ts'], nonGoals: [] },
      requiredChecks: ['bun test'], runtimeMissions: [], environmentConstraints: [] } };
  const path = join(inputs, 'plan.json');
  const save = () => writeFileSync(path, JSON.stringify(input));
  save();
  return { root, inputs, taskPath, task, input, path, save, git,
    database: join(root, '.shawshank/runs/workflow.sqlite'),
    register: () => cli('register-plan', path, '--controller', 'controller') };
}

test('plan CLI registers a task list without task inputs, briefs, runs or attempts', () => {
  const f = fixture();
  unlinkSync(f.taskPath);
  unlinkSync(join(f.inputs, 'brief.md'));
  const result = f.register();
  expect(result.code).toBe(0);
  const registered = JSON.parse(result.out);
  const before = readFileSync(f.database);
  const status = JSON.parse(cli('plan-status', registered.plan).out);
  expect(readFileSync(f.database).equals(before)).toBe(true);
  expect(status.tasks.map((t: any) => [t.task_key, t.position, t.run_id])).toEqual([
    ['first', 0, null], ['second', 1, null],
  ]);
  expect(status.plan.base_sha).toBe(f.git('rev-parse', 'HEAD'));
  expect(status.execution).toBe('run preparation only');
  expect(status.final_run).toBeNull();
  writeFileSync(join(f.inputs, 'approved.md'), 'Changed approval text');
  f.input.tasks.reverse(); f.save();
  const snapshot = JSON.parse(readFileSync(status.plan.input_path, 'utf8'));
  expect(readFileSync(snapshot.reference, 'utf8')).toBe('Approved two-task plan and final acceptance.');
  expect(snapshot.tasks[0].key).toBe('first');
  expect(snapshot.tasks[0]).toEqual({ key: 'first', title: 'Implement fixture' });
  expect(snapshot.sourceReference).toBe(join(f.inputs, 'approved.md'));
  expect(readFileSync(snapshot.sourceReference, 'utf8')).toBe('Changed approval text');
  expect(readdirSync(registered.plan).sort()).toEqual(['adjustments.md', 'approved-plan.md', 'final-scope.md', 'plan.json']);
  const db = new Database(f.database, { readonly: true });
  expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
  expect(db.query('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
  db.close();
  expect(f.git('status', '--porcelain')).toBe('');
});

function prepare(f: ReturnType<typeof fixture>, plan: string, key = 'first', controller = 'controller') {
  return cli('prepare-next-run', plan, '--controller', controller, '--task', key, '--input', f.taskPath);
}

function takeoverDecision(f: ReturnType<typeof fixture>, plan: string, run?: string) {
  const state = JSON.parse(cli('plan-status', plan).out);
  const task = run ? JSON.parse(cli('status', run).out) : null;
  const decision = { plan_id: state.plan.id, plan_fingerprint: state.recovery_fingerprint,
    previous_controller: state.plan.controller_id, stage: task?.run.stage ?? 'between_tasks',
    attempt_id: task?.attempts.at(-1)?.id ?? null, resolution: 'retain',
    previous_command_stopped: true, evidence: 'Synthetic old command stopped', session_evidence: 'Synthetic verified session',
    head_sha: f.git('rev-parse', 'HEAD') };
  const file = join(f.inputs, 'takeover.json');
  writeFileSync(file, JSON.stringify(decision));
  return { file, decision };
}

function amendmentFixture() {
  const f = fixture();
  writeFileSync(join(f.root, 'existing.test.ts'), '// Existing approved test');
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Test fixture');
  const plan = JSON.parse(f.register().out).plan;
  const run = JSON.parse(prepare(f, plan).out).run;
  const db = new Database(f.database);
  db.query("UPDATE runs SET stage='repair_required',accepted_head=?,repair_count=2 WHERE id=?")
    .run(f.git('rev-parse', 'HEAD'), run.split('/').at(-1));
  db.close();
  const state = JSON.parse(cli('plan-status', plan).out);
  const decision = { plan_id: state.plan.id, run_id: run.split('/').at(-1), plan_fingerprint: state.recovery_fingerprint,
    head_sha: f.git('rev-parse', 'HEAD'), reason: 'Synthetic omitted test', authorization: 'Approved fixture test scope',
    within_approved_plan: true, add_paths: ['existing.test.ts'] };
  const file = join(f.inputs, 'amend.json');
  const save = () => writeFileSync(file, JSON.stringify(decision)); save();
  return { f, plan, run, decision, file, save, state };
}

for (const mode of ['normal', 'paused', 'no-launch']) test(`amended scope flows through repair, acceptance, re-review and final preparation (${mode})`, async () => {
  const f = fixture();
  const role = { kind: 'codex', model: 'fixture', args: [] };
  mkdirSync(join(f.root, '.shawshank'), { recursive: true });
  writeFileSync(join(f.root, '.shawshank/config.json'), JSON.stringify({ project: { commitTrailer: 'Co-Authored-By: Fixture <noreply@example.invalid>' },
    roles: { implementer: { standard: [role] }, taskReviewer: role, reviewer: role, verifier: { default: role } } }));
  writeFileSync(join(f.root, 'existing.test.ts'), '// baseline test\n');
  const commit = () => { f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture change\n\nCo-Authored-By: Fixture <noreply@example.invalid>'); };
  commit();
  f.input.tasks = [f.input.tasks[0]]; f.save();
  const plan = JSON.parse(f.register().out).plan, run = JSON.parse(prepare(f, plan).out).run;
  const agents = new Map<string, any>(), closed = new Set<string>(), calls: string[][] = [];
  let paneCount = 0;
  const call = async (...args: string[]): Promise<any> => {
    calls.push(args);
    if (args[0] === 'pane') {
      if (args[1] === 'split') return { pane: { pane_id: `p${++paneCount}`, tab_id: 'test-tab' } };
      if (args[1] === 'close') { closed.add(args[2]); return { type: 'ok' }; }
      if (closed.has(args[2])) throw new HerdrError('Fixture closed', 'pane_not_found');
      return { pane: { pane_id: args[2], tab_id: 'test-tab' } };
    }
    if (args[1] === 'start') agents.set(args[2], { name: args[2], pane_id: args[args.indexOf('--pane') + 1],
      tab_id: 'test-tab', agent: 'codex', agent_status: 'idle', cwd: f.root, foreground_cwd: f.root });
    const agent = agents.get(args[2]);
    if (!agent || closed.has(agent.pane_id)) throw new HerdrError('Fixture absent', 'agent_not_found');
    return { agent };
  };
  const state = () => JSON.parse(cli('status', run).out);
  const report = (attempt: any) => writeFileSync(attempt.report, JSON.stringify({ attempt_id: attempt.attempt_id,
    base_sha: state().run.base_sha, head_sha: f.git('rev-parse', 'HEAD'), status: 'DONE', concerns: [],
    checks: [{ requirement: 'bun test', status: 'PASS', evidence: { command: 'synthetic fixture', result: 'synthetic pass, not live acceptance' } }] }));
  const first = await dispatchImplementation(run, 'controller', 'parent', 'test-tab', call);
  writeFileSync(join(f.root, 'a.ts'), 'export const a = 1;\n'); commit(); report(first);
  await acceptImplementation(run, 'controller', call);
  const review = await dispatchReview(run, 'controller', call);
  const reviewReport = (attempt: any, resolved: boolean) => writeFileSync(attempt.report, JSON.stringify({
    attempt_id: attempt.attempt_id, base_sha: state().run.base_sha, head_sha: f.git('rev-parse', 'HEAD'),
    evidence: 'Synthetic integration test', findings: [{ id: 'F1', severity: 'major', category: 'in_scope',
      status: resolved ? 'resolved' : 'open', title: 'Synthetic omitted test update', evidence: 'existing.test.ts:1 fixture only' }] }));
  reviewReport(review, false); await acceptReview(run, 'controller', call);
  const decisionFile = join(f.inputs, 'triage.json');
  const triage = (attempt: any, action: string) => writeFileSync(decisionFile, JSON.stringify({ attempt_id: attempt.attempt_id,
    head_sha: f.git('rev-parse', 'HEAD'), decisions: [{ id: 'F1', action, evidence: 'Synthetic fixture decision' }] }));
  triage(review, 'fix'); await recordTriage(run, 'controller', decisionFile, call);
  if (mode === 'no-launch') {
    const db = new Database(f.database);
    db.exec(`CREATE TRIGGER fixture_crash BEFORE UPDATE OF status ON attempts
      WHEN NEW.status='prompting' BEGIN SELECT RAISE(ABORT,'fixture pre-prompt crash'); END`);
    await expect(dispatchRepair(run, 'controller', call)).rejects.toThrow('fixture pre-prompt crash');
    db.exec('DROP TRIGGER fixture_crash'); db.close();
    const pending = state(), recoveryFile = join(f.inputs, 'no-launch.json');
    expect(pending.attempts.at(-1).status).toBe('prepared');
    expect(pending.attempts.at(-1).pane_id).toBe(first.pane);
    writeFileSync(recoveryFile, JSON.stringify({ previous_controller: 'controller', stage: pending.run.stage,
      attempt_id: pending.attempts.at(-1).id, head_sha: pending.observed_head,
      worktree_fingerprint: pending.worktree_fingerprint, previous_command_stopped: true,
      evidence: 'Synthetic dispatch returned after database failure.', session_evidence: 'Same fixture transport.',
      resolution: 'no_launch', prompt_submitted: false,
      non_submission_evidence: 'Database rejected the pre-prompt update; no prompt was sent for this attempt.',
      retained_attempt_id: first.attempt_id, retained_worker_evidence: 'Same accepted fixture worker; no active writers.',
      no_session_created: true, session_creation_evidence: 'Retained session; no launch occurred.' }));
    await resolveNoLaunch(run, 'controller', recoveryFile, call);
    expect(state().run.stage).toBe('repair_required');
    expect(state().run.repair_count).toBe(0);
    expect(state().attempts.at(-1)).toMatchObject({ status: 'no_launch', cleanup_state: 'closed', pane_id: first.pane });
  }
  const oldTask = readFileSync(join(run, 'task.json'), 'utf8');
  const planState = JSON.parse(cli('plan-status', plan).out), amendFile = join(f.inputs, 'scope.json');
  writeFileSync(amendFile, JSON.stringify({ plan_id: planState.plan.id, run_id: state().run.id,
    plan_fingerprint: planState.recovery_fingerprint, head_sha: f.git('rev-parse', 'HEAD'),
    add_paths: ['existing.test.ts'], reason: 'Omitted existing test', authorization: 'Synthetic approved test scope', within_approved_plan: true }));
  if (mode === 'no-launch') {
    const before = state(), planBefore = JSON.parse(cli('plan-status', plan).out);
    const original = { ...agents.get(first.worker) };
    for (const invalid of [{ agent_status: 'working' }, { agent_status: 'blocked' },
      { cwd: f.inputs }, { foreground_cwd: f.inputs }, null]) {
      if (invalid) agents.set(first.worker, { ...original, ...invalid });
      else agents.delete(first.worker);
      const offset = calls.length;
      await expect(amendPlanScope(plan, 'controller', amendFile, call)).rejects.toThrow();
      expect(calls.slice(offset)).toContainEqual(['agent', 'get', first.worker]);
      expect(state().run).toEqual(before.run);
      expect(state().attempts).toEqual(before.attempts);
      expect(JSON.parse(cli('plan-status', plan).out).recovery_fingerprint).toBe(planBefore.recovery_fingerprint);
    }
    agents.set(first.worker, original);
  }
  await amendPlanScope(plan, 'controller', amendFile, call);
  const repair = await dispatchRepair(run, 'controller', call);
  const repairState = state(), prompt = readFileSync(repairState.attempts.at(-1).dispatch_path, 'utf8');
  expect(prompt).toContain('existing.test.ts');
  const current = JSON.parse(readFileSync(repairState.run.task_path, 'utf8'));
  const localBrief = prompt.match(/^Approved brief: (.+)$/m)![1];
  expect(localBrief.startsWith(join(f.root, '.shawshank/inputs/'))).toBe(true);
  expect(readFileSync(localBrief, 'utf8')).toBe(readFileSync(current.brief, 'utf8'));
  expect(readFileSync(current.brief, 'utf8')).toContain('Authorized scope correction');
  expect(repair.worker).toBe(first.worker);
  if (mode === 'paused') {
    // Reproduce the historical bad dispatch without rewriting it during recovery.
    const dispatch = repairState.attempts.at(-1).dispatch_path;
    writeFileSync(dispatch, '# Synthetic legacy stale dispatch\n' + oldTask);
    const originalDispatch = readFileSync(dispatch, 'utf8');
    writeFileSync(join(f.root, 'existing.test.ts'), '// retained partial repair\n');
    const before = state();
    const note = join(run, 'confirmed-continuation.md');
    writeFileSync(note, `Synthetic acknowledged pause; continue attempt ${repair.attempt_id}.\n` +
      `Use current input ${before.run.task_path} and brief ${current.brief}.\n` +
      `Only the old allowed paths are superseded. Preserve partial files, F1 and report ${repair.report}.\n`);
    await call('agent', 'prompt', repair.worker, `Read ${note}; continue the same acknowledged paused attempt.`);
    const after = state();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.run).toEqual(before.run);
    expect(readFileSync(join(f.root, 'existing.test.ts'), 'utf8')).toBe('// retained partial repair\n');
    expect(readFileSync(dispatch, 'utf8')).toBe(originalDispatch);
  }
  writeFileSync(join(f.root, 'existing.test.ts'), '// repaired fixture\n'); commit(); report(repair);
  expect((await acceptImplementation(run, 'controller', call)).stage).toBe('implementation_accepted');
  const rereview = await dispatchReview(run, 'controller', call);
  expect(rereview.worker).toBe(review.worker);
  expect(readFileSync(state().attempts.at(-1).dispatch_path, 'utf8')).toContain('existing.test.ts');
  expect(readFileSync(state().attempts.at(-1).dispatch_path, 'utf8')).toContain('Authorized scope correction');
  reviewReport(rereview, true); await acceptReview(run, 'controller', call);
  triage(rereview, 'resolved');
  expect((await recordTriage(run, 'controller', decisionFile, call)).stage).toBe('task_passed');
  expect(state().run.repair_count).toBe(1);
  expect(state().cleanup.state).toBe('complete');
  expect(readFileSync(join(run, 'task.json'), 'utf8')).toBe(oldTask);
  expect(calls.filter(c => c[1] === 'start')).toHaveLength(2);
  const final = preparePlanFinalReview(plan, 'controller');
  const finalState = JSON.parse(cli('status', final.run).out);
  const finalInput = JSON.parse(readFileSync(finalState.run.task_path, 'utf8'));
  expect(finalInput.scope.allowedPaths).toContain('existing.test.ts');
  expect(readFileSync(finalInput.scope.reference, 'utf8')).toContain('Synthetic approved test scope');
}, 15000);

test('scope correction versions both contracts without changing history or budgets; stale retry fails', async () => {
  const x = amendmentFixture();
  const db = new Database(x.f.database);
  const before = db.query('SELECT * FROM runs WHERE id=?').get(x.decision.run_id) as any;
  const original = readFileSync(before.task_path, 'utf8');
  await amendPlanScope(x.plan, 'controller', x.file);
  const after = db.query('SELECT * FROM runs WHERE id=?').get(x.decision.run_id) as any;
  expect(after.repair_count).toBe(2); expect(after.stage).toBe('repair_required');
  expect(after.accepted_head).toBe(before.accepted_head);
  expect(after.decision_path).toBe(before.decision_path);
  expect(readFileSync(before.task_path, 'utf8')).toBe(original);
  expect(JSON.parse(readFileSync(after.task_path, 'utf8')).allowedPaths).toEqual(['a.ts', 'existing.test.ts']);
  const state = JSON.parse(cli('plan-status', x.plan).out);
  expect(JSON.parse(readFileSync(state.plan.input_path, 'utf8')).finalReview.scope.allowedPaths).toEqual(['a.ts', 'existing.test.ts']);
  expect(state.recovery_fingerprint).not.toBe(x.state.recovery_fingerprint);
  await expect(amendPlanScope(x.plan, 'controller', x.file)).rejects.toThrow('stale');
  db.close();
});

test('scope correction rejects missing authority, wrong owner, unsafe paths, dirty tree and final registration', async () => {
  const x = amendmentFixture();
  await expect(amendPlanScope(x.plan, 'other', x.file)).rejects.toThrow('own');
  x.decision.within_approved_plan = false; x.save();
  await expect(amendPlanScope(x.plan, 'controller', x.file)).rejects.toThrow('approved');
  x.decision.within_approved_plan = true;
  for (const file of ['../outside', '.', 'frontend/', '*', '/tmp/file']) {
    x.decision.add_paths = [file]; x.save();
    await expect(amendPlanScope(x.plan, 'controller', x.file)).rejects.toThrow();
  }
  x.decision.add_paths = ['existing.test.ts']; x.save();
  writeFileSync(join(x.f.root, 'dirty'), 'dirty');
  await expect(amendPlanScope(x.plan, 'controller', x.file)).rejects.toThrow('Git state');
  unlinkSync(join(x.f.root, 'dirty'));
  const db = new Database(x.f.database);
  db.query('UPDATE plans SET final_run_id=? WHERE id=?').run(x.decision.run_id, x.decision.plan_id); db.close();
  await expect(amendPlanScope(x.plan, 'controller', x.file)).rejects.toThrow('final registration');
});

test('scope correction atomically rolls back both pointers on failure', async () => {
  const x = amendmentFixture(), db = new Database(x.f.database);
  const before = db.query('SELECT task_path FROM runs WHERE id=?').get(x.decision.run_id);
  db.exec("CREATE TRIGGER fail_scope BEFORE UPDATE OF task_path ON runs BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await expect(amendPlanScope(x.plan, 'controller', x.file)).rejects.toThrow('synthetic failure');
  expect(db.query('SELECT task_path FROM runs WHERE id=?').get(x.decision.run_id)).toEqual(before);
  expect((db.query('SELECT input_path FROM plans WHERE id=?').get(x.decision.plan_id) as any).input_path).toBe(x.state.plan.input_path);
  db.close();
});

test('scope correction checks retained workers and rejects concurrent ownership changes', async () => {
  const x = amendmentFixture(), db = new Database(x.f.database);
  db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify({ tab: 'test-tab' }), x.decision.run_id);
  db.query(`INSERT INTO attempts(id,run_id,action,status,worker_kind,worker_name,pane_id,
    dispatch_path,report_path,base_sha,started_at) VALUES ('retained',?,'review','accepted','claude','reviewer','pane','dispatch','report',?,'now')`)
    .run(x.decision.run_id, x.decision.head_sha);
  x.decision.plan_fingerprint = JSON.parse(cli('plan-status', x.plan).out).recovery_fingerprint; x.save();
  const live = { name: 'reviewer', pane_id: 'pane', tab_id: 'test-tab', agent: 'claude', cwd: x.f.root, agent_status: 'working' };
  await expect(amendPlanScope(x.plan, 'controller', x.file, async () => ({ agent: live }))).rejects.toThrow('readiness');
  live.agent_status = 'idle';
  await expect(amendPlanScope(x.plan, 'controller', x.file, async () => {
    db.query("UPDATE runs SET controller_id='competitor' WHERE id=?").run(x.decision.run_id);
    return { agent: live };
  })).rejects.toThrow('changed');
  expect((db.query('SELECT input_path FROM plans WHERE id=?').get(x.decision.plan_id) as any).input_path).toBe(x.state.plan.input_path);
  db.close();
});

test('plan takeover before tasks and between tasks retains progress and rejects old owner', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  let d = takeoverDecision(f, plan);
  expect(cli('take-over-plan', plan, '--controller', 'new', '--decision', d.file).code).toBe(0);
  expect(prepare(f, plan).error).toContain('controller mismatch');
  const first = JSON.parse(prepare(f, plan, 'first', 'new').out).run;
  passTask(f, first);
  d = takeoverDecision(f, plan);
  expect(cli('take-over-plan', plan, '--controller', 'third', '--decision', d.file).code).toBe(0);
  const state = JSON.parse(cli('plan-status', plan).out);
  expect(state.tasks[0].run_id).toBe(first.split('/').at(-1));
  expect(state.tasks[0].stage).toBe('task_passed');
  expect(state.next_action).toEqual({ task_key: 'second', action: 'prepare_task' });
  expect(prepare(f, plan, 'second', 'third').code).toBe(0);
  expect(cli('take-over-plan', plan, '--controller', 'stale', '--decision', d.file).code).toBe(1);
});

test('task takeover atomically transfers the plan too; incomplete plan evidence cannot bypass it', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const run = JSON.parse(prepare(f, plan).out).run;
  const d = takeoverDecision(f, plan, run);
  const incomplete = { ...d.decision, plan_fingerprint: undefined };
  writeFileSync(d.file, JSON.stringify(incomplete));
  expect(cli('take-over', run, '--controller', 'new', '--decision', d.file).code).toBe(1);
  writeFileSync(d.file, JSON.stringify(d.decision));
  expect(cli('take-over-plan', plan, '--controller', 'new', '--decision', d.file).code).toBe(0);
  expect(JSON.parse(cli('status', run).out).run.controller_id).toBe('new');
  expect(JSON.parse(cli('plan-status', plan).out).plan.controller_id).toBe('new');
  expect(JSON.parse(prepare(f, plan, 'first', 'new').out).run).toBe(run);
});

test('working worker survives plan takeover with moving files and no prompt or restart', async () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const run = JSON.parse(prepare(f, plan).out).run, id = run.split('/').at(-1);
  const db = new Database(f.database);
  db.query("UPDATE runs SET stage='implementing',repair_count=2,config_json=? WHERE id=?").run(JSON.stringify({ tab: 'test-tab' }), id);
  db.query(`INSERT INTO attempts(id,run_id,action,status,worker_kind,worker_name,pane_id,dispatch_path,report_path,base_sha,started_at)
    VALUES ('live-fixture',?,'implementation','submitted','codex','worker','pane','dispatch','report',?,'fixture')`).run(id, f.git('rev-parse', 'HEAD'));
  const d = takeoverDecision(f, plan, run), calls: string[][] = [];
  await takeOverPlan(plan, 'new', d.file, async (...args) => {
    calls.push(args);
    writeFileSync(join(f.root, 'partial.ts'), 'Worker still writing');
    return { agent: { name: 'worker', pane_id: 'pane', tab_id: 'test-tab', agent: 'codex', agent_status: 'working',
      cwd: f.root, foreground_cwd: f.root } };
  });
  expect(calls).toEqual([['agent', 'get', 'worker']]);
  expect(readFileSync(join(f.root, 'partial.ts'), 'utf8')).toBe('Worker still writing');
  expect(db.query('SELECT controller_id,stage,repair_count FROM runs WHERE id=?').get(id)).toEqual({ controller_id: 'new', stage: 'implementing', repair_count: 2 });
  expect(db.query('SELECT controller_id FROM plans').get()).toEqual({ controller_id: 'new' });
  expect(db.query('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
  db.close();
});

test('plan transfer rollback never leaves task and plan with different owners', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const run = JSON.parse(prepare(f, plan).out).run, d = takeoverDecision(f, plan, run);
  const db = new Database(f.database);
  db.exec(`CREATE TRIGGER fail_owner BEFORE UPDATE OF controller_id ON plans
    BEGIN SELECT RAISE(ABORT,'Synthetic owner transfer failure'); END;`);
  expect(cli('take-over-plan', plan, '--controller', 'new', '--decision', d.file).error).toContain('Synthetic owner transfer failure');
  expect(db.query('SELECT controller_id FROM plans').get()).toEqual({ controller_id: 'controller' });
  expect(db.query('SELECT controller_id FROM runs').get()).toEqual({ controller_id: 'controller' });
  db.close();
});

test('concurrent between-task takeovers yield one new owner', async () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan, d = takeoverDecision(f, plan);
  const children = ['a', 'b'].map(owner => Bun.spawn([process.execPath, script, 'take-over-plan', plan,
    '--controller', owner, '--decision', d.file], { stdout: 'pipe', stderr: 'pipe' }));
  expect((await Promise.all(children.map(c => c.exited))).sort()).toEqual([0, 1]);
  expect(['a', 'b']).toContain(JSON.parse(cli('plan-status', plan).out).plan.controller_id);
});

test('plan changes during live worker inspection reject takeover without partial transfer', async () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const run = JSON.parse(prepare(f, plan).out).run, id = run.split('/').at(-1);
  const db = new Database(f.database);
  db.query("UPDATE runs SET stage='implementing',config_json=? WHERE id=?").run(JSON.stringify({ tab: 'test-tab' }), id);
  db.query(`INSERT INTO attempts(id,run_id,action,status,worker_kind,worker_name,pane_id,dispatch_path,report_path,base_sha,started_at)
    VALUES ('race-fixture',?,'implementation','submitted','codex','worker','pane','dispatch','report',?,'fixture')`).run(id, f.git('rev-parse', 'HEAD'));
  const d = takeoverDecision(f, plan, run);
  await expect(takeOverPlan(plan, 'new', d.file, async () => {
    db.exec("UPDATE plans SET controller_id='competing-owner'");
    return { agent: { name: 'worker', pane_id: 'pane', tab_id: 'test-tab', agent: 'codex', agent_status: 'working',
      cwd: f.root, foreground_cwd: f.root } };
  })).rejects.toThrow('Plan recovery evidence is stale');
  expect(db.query('SELECT controller_id FROM runs').get()).toEqual({ controller_id: 'controller' });
  expect(db.query('SELECT controller_id FROM plans').get()).toEqual({ controller_id: 'competing-owner' });
  db.close();
});

test('between-task recovery rejects missing stop evidence and dirty work; final takeover remains unsupported', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan, d = takeoverDecision(f, plan);
  writeFileSync(d.file, JSON.stringify({ ...d.decision, previous_command_stopped: false }));
  expect(cli('take-over-plan', plan, '--controller', 'new', '--decision', d.file).code).toBe(1);
  writeFileSync(d.file, JSON.stringify(d.decision));
  writeFileSync(join(f.root, 'unexpected'), 'preserve');
  expect(cli('take-over-plan', plan, '--controller', 'new', '--decision', d.file).code).toBe(1);
  const final = planFinalFixture(); expect(final.final().code).toBe(0);
  const fd = takeoverDecision(final, final.plan);
  expect(cli('take-over-plan', final.plan, '--controller', 'new', '--decision', fd.file).error).toContain('not supported');
});

test('adjustments work with tracked and ignored original plans without changing Git boundaries', () => {
  for (const tracked of [true, false]) {
    const f = fixture(), original = join(f.root, 'approved.md');
    writeFileSync(original, 'Approved original plan');
    if (!tracked) writeFileSync(join(f.root, '.gitignore'), '.shawshank/runs/\napproved.md\n');
    f.git('add', '.');
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Prepare plan fixture');
    expect(Boolean(f.git('ls-files', '--', 'approved.md'))).toBe(tracked);
    f.input.reference = original; f.input.finalReview.scope.reference = original; f.save();
    const plan = JSON.parse(f.register().out).plan, head = f.git('rev-parse', 'HEAD');
    const status = JSON.parse(cli('plan-status', plan).out);
    const adjustment = '# Plan adjustments\n\nfirst: reuse existing helper; behavior and acceptance unchanged.\n';
    writeFileSync(status.adjustments_path, adjustment);
    writeFileSync(join(f.inputs, 'brief.md'), 'Reuse the existing helper.');
    const result = prepare(f, plan);
    expect(result.code).toBe(0);
    const run = JSON.parse(result.out).run;
    expect(readFileSync(join(run, 'adjustments-at-preparation.md'), 'utf8')).toBe(adjustment);
    expect(readFileSync(join(run, 'brief.md'), 'utf8')).toBe('Reuse the existing helper.');
    expect(readFileSync(original, 'utf8')).toBe('Approved original plan');
    expect(f.git('status', '--porcelain')).toBe('');
    expect(f.git('rev-parse', 'HEAD')).toBe(head);
  }
});

// Synthetic task completion for sequencing tests; no worker or review was run.
function passTask(f: ReturnType<typeof fixture>, run: string) {
  const db = new Database(f.database);
  db.query("UPDATE runs SET stage='task_passed',accepted_head=? WHERE id=?")
    .run(f.git('rev-parse', 'HEAD'), run.split('/').at(-1));
  db.close();
}

function planFinalFixture() {
  const f = fixture(), role = { kind: 'codex', model: 'fixture-only', args: [] };
  mkdirSync(join(f.root, '.shawshank'), { recursive: true });
  writeFileSync(join(f.root, '.shawshank/config.json'), JSON.stringify({ roles: {
    reviewer: role, verifier: { default: role }, implementer: { standard: [role] } } }));
  writeFileSync(join(f.root, 'before-plan.ts'), 'export const beforePlan = true;\n');
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Configure final fixture');
  const base = f.git('rev-parse', 'HEAD'), plan = JSON.parse(f.register().out).plan;
  const runs: string[] = [];
  for (const key of ['first', 'second']) {
    const run = JSON.parse(prepare(f, plan, key).out).run;
    writeFileSync(join(f.root, 'a.ts'), `export const currentTask = '${key}';\n`);
    f.git('add', 'a.ts');
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', `Synthetic ${key} completion`);
    passTask(f, run); // Sequencing fixture, not actual implementation/review evidence.
    const runId = run.split('/').at(-1)!, attempt = `${runId}-review`, head = f.git('rev-parse', 'HEAD');
    const reportPath = join(run, 'synthetic-review.json'), decisionPath = join(run, 'synthetic-triage.json');
    writeFileSync(reportPath, JSON.stringify({ attempt_id: attempt, head_sha: head, findings: [] }));
    writeFileSync(decisionPath, JSON.stringify({ attempt_id: attempt, head_sha: head, decisions: [] }));
    const db = new Database(f.database);
    db.query(`INSERT INTO attempts(id,run_id,action,status,dispatch_path,report_path,base_sha,started_at)
      VALUES (?,?,'review','accepted','synthetic',?,?,'fixture')`).run(attempt, runId, reportPath, base);
    db.query('UPDATE runs SET decision_path=? WHERE id=?').run(decisionPath, runId);
    db.close();
    runs.push(run);
  }
  return { ...f, plan, runs, base, head: f.git('rev-parse', 'HEAD'),
    final: () => cli('prepare-plan-final-review', plan, '--controller', 'controller') };
}

test('plan final derives the whole range and exact task evidence and snapshots adjustments', () => {
  const f = planFinalFixture();
  writeFileSync(join(f.plan, 'adjustments.md'), '# Adjustments\n\nsecond: reuse the approved helper.');
  const result = f.final();
  expect(result.code).toBe(0);
  const final = JSON.parse(result.out), input = JSON.parse(readFileSync(join(final.run, 'input.json'), 'utf8'));
  expect(input.base).toBe(f.git('rev-parse', 'refs/heads/review-target'));
  expect(input.base).not.toBe(f.base);
  expect(f.git('diff', '--name-only', `${input.base}..${input.reviewedHEAD}`)).toContain('before-plan.ts');
  expect(input.reviewedHEAD).toBe(f.head);
  expect(input.taskEvidence).toEqual(f.runs.map(run => ({ kind: 'local_run', runId: run.split('/').at(-1) })));
  expect(input.authorization).toEqual(f.input.authorization);
  expect(input.entry).toBe('completed_plan');
  expect(readFileSync(input.scope.reference, 'utf8')).toContain('reuse the approved helper');
  const before = readFileSync(input.scope.reference);
  writeFileSync(join(f.plan, 'adjustments.md'), '# Later adjustment');
  expect(JSON.parse(f.final().out)).toMatchObject({ run: final.run, reused: true, stage: 'final_ready' });
  expect(readFileSync(input.scope.reference).equals(before)).toBe(true);
  const status = JSON.parse(cli('plan-status', f.plan).out);
  expect(status.next_action.action).toBe('resume_final_review');
  expect(status.final_run.id).toBe(final.run.split('/').at(-1));
  const db = new Database(f.database, { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM attempts WHERE action='final_review'").get()).toEqual({ n: 0 });
  db.close();
});

test('final handoff carries task findings, dispositions and user authority as a retained snapshot', () => {
  const f = planFinalFixture(), run = f.runs[0];
  const reportPath = join(run, 'synthetic-review.json'), decisionPath = join(run, 'synthetic-triage.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  const actions = ['deferred', 'wontfix', 'invalid', 'pre_existing', 'resolved'];
  report.findings = actions.map((action, i) => ({ id: `F${i}`, title: `${action} fixture`, severity: 'minor',
    status: action === 'resolved' ? 'resolved' : 'open', evidence: 'Synthetic reviewer evidence' }));
  decision.decisions = actions.map((action, i) => ({ id: `F${i}`, action, evidence: `Reason for ${action}`,
    ...(action === 'deferred' ? { user_authorization: 'Synthetic explicit user deferral' } : {}) }));
  writeFileSync(reportPath, JSON.stringify(report)); writeFileSync(decisionPath, JSON.stringify(decision));
  const result = f.final(); expect(result.code).toBe(0);
  const input = JSON.parse(readFileSync(join(JSON.parse(result.out).run, 'input.json'), 'utf8'));
  const scope = readFileSync(input.scope.reference, 'utf8');
  for (const action of actions) expect(scope).toContain(`Reason for ${action}`);
  expect(scope).toContain('Synthetic explicit user deferral');
  expect(scope).toContain(reportPath);
  expect(scope).toContain(decisionPath);
  writeFileSync(decisionPath, '{}');
  expect(readFileSync(input.scope.reference, 'utf8')).toBe(scope);
});

test('missing or stale task review handoff blocks final registration', () => {
  for (const kind of ['missing', 'stale', 'decision', 'authorization']) {
    const f = planFinalFixture(), decisionPath = join(f.runs[0], 'synthetic-triage.json');
    const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
    if (kind === 'missing') unlinkSync(decisionPath);
    if (kind === 'stale') { decision.head_sha = f.base; writeFileSync(decisionPath, JSON.stringify(decision)); }
    if (kind === 'decision' || kind === 'authorization') {
      const reportPath = join(f.runs[0], 'synthetic-review.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      report.findings = [{ id: 'F', title: 'Synthetic issue' }];
      writeFileSync(reportPath, JSON.stringify(report));
      if (kind === 'authorization') {
        decision.decisions = [{ id: 'F', action: 'deferred', evidence: 'Synthetic reason without authorization' }];
        writeFileSync(decisionPath, JSON.stringify(decision));
      }
    }
    expect(f.final().code).toBe(1);
    const db = new Database(f.database, { readonly: true });
    expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='final_review'").get()).toEqual({ n: 0 });
    db.close();
  }
});

test('whole-branch review requires an explicit target and pins it despite later ref movement', () => {
  for (const target of ['', 'main', 'refs/heads/missing']) {
    const f = fixture(); f.input.finalReview.targetBranch = target; f.save();
    expect(f.register().code).toBe(1);
    expect(existsSync(f.database)).toBe(false);
  }
  const f = planFinalFixture(), original = f.git('rev-parse', 'refs/heads/review-target');
  f.git('branch', '-f', 'review-target', 'HEAD');
  const result = f.final(); expect(result.code).toBe(0);
  expect(JSON.parse(result.out).base_sha).toBe(original);
});

test('plan final gates unfinished tasks, owner, cleanup and unexpected Git changes', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  expect(cli('prepare-plan-final-review', plan, '--controller', 'controller').error).toContain('All plan tasks');
  for (const kind of ['owner', 'task', 'cleanup', 'dirty', 'head']) {
    const f = planFinalFixture(), db = new Database(f.database);
    if (kind === 'owner') db.exec("UPDATE plans SET controller_id='another'");
    if (kind === 'task') db.exec("UPDATE runs SET stage='review_accepted' WHERE id=(SELECT run_id FROM plan_tasks WHERE position=1)");
    if (kind === 'cleanup') db.query(`INSERT INTO attempts(id,run_id,action,status,pane_id,dispatch_path,report_path,base_sha,started_at)
      VALUES ('pending',?,'review','accepted','fixture-pane','none','none',?,'fixture')`).run(f.runs[1].split('/').at(-1), f.head);
    if (kind === 'dirty') writeFileSync(join(f.root, 'unexpected'), 'preserve');
    if (kind === 'head') f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Unexpected commit');
    expect(f.final().code).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='final_review'").get()).toEqual({ n: 0 });
    expect(db.query('SELECT final_run_id FROM plans').get()).toEqual({ final_run_id: null });
    db.close();
  }
});

test('concurrent plan final preparation links one run; failed link rolls back', async () => {
  const f = planFinalFixture(), db = new Database(f.database);
  db.exec(`CREATE TRIGGER fail_final BEFORE UPDATE OF final_run_id ON plans
    BEGIN SELECT RAISE(ABORT, 'Synthetic final link failure'); END;`);
  expect(f.final().error).toContain('Synthetic final link failure');
  expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='final_review'").get()).toEqual({ n: 0 });
  expect(db.query('SELECT final_run_id FROM plans').get()).toEqual({ final_run_id: null });
  db.exec('DROP TRIGGER fail_final');
  const children = [1, 2].map(() => Bun.spawn([process.execPath, script, 'prepare-plan-final-review', f.plan,
    '--controller', 'controller'], { stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async c => ({ code: await c.exited, out: await new Response(c.stdout).text() })));
  expect(results.map(r => r.code)).toEqual([0, 0]);
  expect(new Set(results.map(r => JSON.parse(r.out).run)).size).toBe(1);
  expect(db.query("SELECT count(*) AS n FROM runs WHERE kind='final_review'").get()).toEqual({ n: 1 });
  db.close();
});

test('plan completion requires final_passed and cleanup before releasing the worktree', () => {
  const f = planFinalFixture(), final = JSON.parse(f.final().out);
  const db = new Database(f.database), id = final.run.split('/').at(-1);
  // Synthetic terminal states test release gates, not real final acceptance.
  db.query("UPDATE runs SET stage='review_reported' WHERE id=?").run(id);
  expect(JSON.parse(cli('plan-status', f.plan).out).next_action.action).toBe('resume_final_review');
  expect(cli('register-task', f.taskPath, '--controller', 'other').code).toBe(1);
  db.query("UPDATE runs SET stage='final_passed' WHERE id=?").run(id);
  db.query(`INSERT INTO attempts(id,run_id,action,status,pane_id,worker_name,dispatch_path,report_path,base_sha,started_at)
    VALUES ('pending',?,'final_review','accepted','fixture-pane','fixture-worker','none','none',?,'fixture')`).run(id, f.head);
  expect(JSON.parse(cli('plan-status', f.plan).out).next_action.action).toBe('cleanup_final_review');
  expect(cli('register-task', f.taskPath, '--controller', 'other').code).toBe(1);
  db.exec("UPDATE attempts SET cleanup_state='closed'");
  expect(JSON.parse(cli('plan-status', f.plan).out).next_action.action).toBe('plan_complete');
  expect(cli('register-task', f.taskPath, '--controller', 'other').code).toBe(0);
  db.close();
});

test('prepare snapshots only the current task and retries reuse its run even after completion', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  writeFileSync(join(plan, 'adjustments.md'), '# Plan adjustments\n\nFirst task: reuse the existing helper; behavior and acceptance unchanged.');
  unlinkSync(join(f.inputs, 'approved.md'));
  writeFileSync(join(f.inputs, 'brief.md'), 'Use the existing helper.');
  const prepared = prepare(f, plan);
  expect(prepared.code).toBe(0);
  const first = JSON.parse(prepared.out);
  expect(first.reused).toBe(false);
  const db = new Database(f.database, { readonly: true });
  const row = db.query('SELECT * FROM runs').get() as any;
  const saved = JSON.parse(readFileSync(row.task_path, 'utf8'));
  expect(readFileSync(saved.brief, 'utf8')).toBe('Use the existing helper.');
  expect(readFileSync(join(first.run, 'adjustments-at-preparation.md'), 'utf8')).toContain('existing helper');
  expect(db.query('SELECT run_id FROM plan_tasks WHERE position=1').get()).toEqual({ run_id: null });
  expect(db.query('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
  const state = JSON.parse(cli('plan-status', plan).out);
  expect(state.next_action).toEqual({ task_key: 'first', action: 'resume_task' });
  unlinkSync(f.taskPath);
  writeFileSync(join(f.inputs, 'brief.md'), 'Later edit must not replace the dispatched requirements');
  writeFileSync(join(plan, 'adjustments.md'), '# Plan adjustments\n\nLater correction.');
  expect(JSON.parse(prepare(f, plan).out).run).toBe(first.run);
  passTask(f, first.run);
  expect(JSON.parse(prepare(f, plan).out)).toMatchObject({ run: first.run, reused: true, stage: 'task_passed' });
  expect(readFileSync(saved.brief, 'utf8')).toBe('Use the existing helper.');
  expect(readFileSync(join(first.run, 'adjustments-at-preparation.md'), 'utf8')).toContain('existing helper');
  expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  db.close();
});

test('prepare enforces order, controller identity, accepted HEAD and a clean worktree', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  expect(prepare(f, plan, 'second').error).toContain('registered order');
  expect(prepare(f, plan, 'first', 'intruder').error).toContain('controller mismatch');
  expect(prepare(f, plan, 'unknown').error).toContain('Unknown plan task');
  writeFileSync(join(f.root, 'unexpected'), 'preserve');
  expect(prepare(f, plan).error).toContain('accepted plan boundary');
  unlinkSync(join(f.root, 'unexpected'));
  const first = JSON.parse(prepare(f, plan).out);
  expect(prepare(f, plan, 'second').error).toContain('Previous task must pass');
  writeFileSync(join(f.root, 'a.ts'), 'export const value = 1;');
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic task result');
  passTask(f, first.run);
  const accepted = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.inputs, 'brief.md'), 'Integrate the helper produced by task one');
  const second = JSON.parse(prepare(f, plan, 'second').out);
  expect(second.base_sha).toBe(accepted);
  expect(readFileSync(join(second.run, 'brief.md'), 'utf8')).toBe('Integrate the helper produced by task one');
  expect(second.run).not.toBe(first.run);
  passTask(f, second.run);
  expect(JSON.parse(cli('plan-status', plan).out).next_action.action).toBe('prepare_final_review');
});

test('unexpected committed work cannot become the next task baseline', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const first = JSON.parse(prepare(f, plan).out);
  passTask(f, first.run);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Unexpected extra commit');
  expect(prepare(f, plan, 'second').error).toContain('accepted plan boundary');
  const db = new Database(f.database, { readonly: true });
  expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(db.query('SELECT run_id FROM plan_tasks WHERE position=1').get()).toEqual({ run_id: null });
  db.close();
});

test('pending worker cleanup blocks next task and appears in plan status', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const first = JSON.parse(prepare(f, plan).out);
  passTask(f, first.run);
  const db = new Database(f.database);
  db.query(`INSERT INTO attempts(id,run_id,action,status,pane_id,worker_name,dispatch_path,report_path,base_sha,started_at)
    VALUES ('synthetic',?,'implementation','accepted','fixture-pane','fixture-worker','none','none',?,'fixture')`)
    .run(first.run.split('/').at(-1), first.base_sha);
  expect(prepare(f, plan, 'second').error).toContain('pending worker cleanup');
  expect(JSON.parse(cli('plan-status', plan).out).next_action).toEqual({ task_key: 'first', action: 'cleanup_task' });
  db.exec("UPDATE attempts SET cleanup_state='closed'");
  expect(prepare(f, plan, 'second').code).toBe(0);
  db.close();
});

test('concurrent preparations create and associate exactly one run', async () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const children = [1, 2].map(() => Bun.spawn([process.execPath, script, 'prepare-next-run', plan,
    '--controller', 'controller', '--task', 'first', '--input', f.taskPath], { stdout: 'pipe', stderr: 'pipe' }));
  const outputs = await Promise.all(children.map(async c => ({ code: await c.exited, out: await new Response(c.stdout).text() })));
  expect(outputs.map(o => o.code)).toEqual([0, 0]);
  expect(new Set(outputs.map(o => JSON.parse(o.out).run)).size).toBe(1);
  const db = new Database(f.database, { readonly: true });
  expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  expect(db.query('SELECT count(*) AS n FROM plan_tasks WHERE run_id IS NOT NULL').get()).toEqual({ n: 1 });
  db.close();
});

test('association failure rolls back the new run and permits a clean retry', () => {
  const f = fixture(), plan = JSON.parse(f.register().out).plan;
  const db = new Database(f.database);
  db.exec(`CREATE TRIGGER fail_link BEFORE UPDATE OF run_id ON plan_tasks
    BEGIN SELECT RAISE(ABORT, 'Synthetic link failure'); END;`);
  expect(prepare(f, plan).error).toContain('Synthetic link failure');
  expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
  expect(db.query('SELECT count(*) AS n FROM plan_tasks WHERE run_id IS NOT NULL').get()).toEqual({ n: 0 });
  db.exec('DROP TRIGGER fail_link');
  expect(prepare(f, plan).code).toBe(0);
  db.close();
});

test('prepared task uses existing dispatch unchanged with mocked transport', async () => {
  const f = fixture();
  const role = { kind: 'codex', model: 'fixture-only', args: [] };
  // Commit configuration before capturing the approved plan baseline.
  mkdirSync(join(f.root, '.shawshank'), { recursive: true });
  writeFileSync(join(f.root, '.shawshank/config.json'), JSON.stringify({ project: { commitTrailer: 'Fixture trailer' },
    roles: { implementer: { standard: [role] }, taskReviewer: role } }));
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Configure fixture');
  const plan = JSON.parse(f.register().out).plan;
  const run = JSON.parse(prepare(f, plan).out).run;
  let agent: any;
  const calls: string[][] = [];
  await dispatchImplementation(run, 'controller', 'parent', 'test-tab', async (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'pane') return { pane: { pane_id: args[1] === 'split' ? 'worker-pane' : args[2], tab_id: 'test-tab' } };
    if (args[1] === 'start') agent = { name: args[2], pane_id: 'worker-pane', tab_id: 'test-tab', agent: 'codex',
      agent_status: 'idle', cwd: f.root, foreground_cwd: f.root };
    return { agent };
  });
  expect(calls.filter(c => c[0] === 'agent' && c[1] === 'prompt')).toHaveLength(1);
  expect(JSON.parse(cli('status', run).out).run.stage).toBe('implementing');
  const task = JSON.parse(readFileSync(join(run, 'task.json'), 'utf8'));
  expect(readFileSync(task.brief, 'utf8')).toBe('Original brief');
  const repeated = JSON.parse(prepare(f, plan).out);
  expect(repeated).toMatchObject({ run, reused: true, stage: 'implementing' });
});

test('missing retained inputs, invalid task and wrong repository never create a run', () => {
  for (const kind of ['plan', 'adjustments', 'brief', 'scope', 'repository']) {
    const f = fixture(), plan = JSON.parse(f.register().out).plan;
    if (kind === 'plan') unlinkSync(join(plan, 'approved-plan.md'));
    if (kind === 'adjustments') unlinkSync(join(plan, 'adjustments.md'));
    if (kind === 'brief') unlinkSync(join(f.inputs, 'brief.md'));
    if (kind === 'scope') f.task.allowedPaths = ['../escape'];
    if (kind === 'repository') f.task.worktree = fixture().root;
    writeFileSync(f.taskPath, JSON.stringify(f.task));
    expect(prepare(f, plan).code).toBe(1);
    const db = new Database(f.database, { readonly: true });
    expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(db.query('SELECT run_id FROM plan_tasks WHERE position=0').get()).toEqual({ run_id: null });
    db.close();
  }
});

test('active plan rejects duplicate registration and unrelated task registration', () => {
  const f = fixture();
  expect(f.register().code).toBe(0);
  expect(f.register().error).toContain('unfinished plan');
  expect(cli('register-task', f.taskPath, '--controller', 'other').error).toContain('unfinished plan');
});

test('invalid approval, tasks, final template and dirty work do not register', () => {
  for (const kind of ['approval', 'duplicate', 'empty', 'title', 'legacy-input', 'scope', 'provenance', 'dirty']) {
    const f = fixture();
    if (kind === 'approval') f.input.authorization.localCommits = false;
    if (kind === 'duplicate') f.input.tasks[1].key = 'first';
    if (kind === 'empty') f.input.tasks = [];
    if (kind === 'title') f.input.tasks[0].title = '';
    if (kind === 'legacy-input') (f.input.tasks[0] as any).input = 'task.json';
    if (kind === 'scope') f.input.finalReview.scope.allowedPaths = ['../escape'];
    if (kind === 'provenance') (f.input.finalReview as any).reviewedHEAD = 'stale';
    if (kind === 'dirty') writeFileSync(join(f.root, 'unexpected'), 'preserve');
    f.save();
    expect(f.register().code).toBe(1);
    expect(existsSync(f.database)).toBe(false);
  }
});

test('additive plan schema preserves existing run rows; read-only status never migrates', () => {
  const f = fixture();
  const old = JSON.parse(cli('register-task', f.taskPath, '--controller', 'old').out);
  const db = new Database(f.database);
  const row = db.query('SELECT * FROM runs').get();
  db.exec('DROP TABLE plan_tasks; DROP TABLE plans');
  db.close();
  const before = readFileSync(f.database);
  expect(cli('plan-status', old.run).code).toBe(1);
  expect(readFileSync(f.database).equals(before)).toBe(true);
  expect(f.register().error).toContain('unfinished run');
  const after = new Database(f.database, { readonly: true });
  expect(after.query('SELECT * FROM runs').get()).toEqual(row);
  expect(after.query('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 0 });
  after.close();
});

test('status of missing storage does not create a database', () => {
  const f = fixture();
  expect(cli('plan-status', join(f.root, '.shawshank/runs/missing')).code).toBe(1);
  expect(existsSync(f.database)).toBe(false);
});

test('concurrent plan registrations yield exactly one owner', async () => {
  const f = fixture();
  // Initialize shared schema first, then simulate a historical completed task.
  cli('register-task', f.taskPath, '--controller', 'fixture');
  const db = new Database(f.database);
  db.exec("UPDATE runs SET stage='task_passed'");
  db.close();
  const children = [1, 2].map(i => Bun.spawn([process.execPath, script, 'register-plan', f.path,
    '--controller', `controller-${i}`], { stdout: 'pipe', stderr: 'pipe' }));
  const codes = await Promise.all(children.map(c => c.exited));
  expect(codes.sort()).toEqual([0, 1]);
  const saved = new Database(f.database, { readonly: true });
  expect(saved.query('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 1 });
  expect(saved.query('SELECT count(*) AS n FROM plan_tasks').get()).toEqual({ n: 2 });
  saved.close();
});

test('failed association insert rolls back the whole plan registration', () => {
  const f = fixture();
  cli('register-task', f.taskPath, '--controller', 'fixture');
  const db = new Database(f.database);
  db.exec(`UPDATE runs SET stage='task_passed';
    CREATE TRIGGER fail_second_task BEFORE INSERT ON plan_tasks WHEN NEW.position=1
    BEGIN SELECT RAISE(ABORT, 'Synthetic association failure'); END;`);
  const result = f.register();
  expect(result.error).toContain('Synthetic association failure');
  expect(db.query('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 0 });
  expect(db.query('SELECT count(*) AS n FROM plan_tasks').get()).toEqual({ n: 0 });
  expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  db.exec('DROP TRIGGER fail_second_task');
  db.close();
  expect(f.register().code).toBe(0);
});

test('plan status derives linked progress from runs without copying it', () => {
  const f = fixture();
  const run = JSON.parse(cli('register-task', f.taskPath, '--controller', 'fixture').out).run;
  const db = new Database(f.database);
  // Synthetic lifecycle/association fixture, not a completed live task.
  db.exec("UPDATE runs SET stage='task_passed'");
  const plan = JSON.parse(f.register().out).plan;
  const runId = run.split('/').at(-1), planId = plan.split('/').at(-1);
  db.query('UPDATE plan_tasks SET run_id=? WHERE plan_id=? AND position=0').run(runId, planId);
  expect(JSON.parse(cli('plan-status', plan).out).tasks[0].stage).toBe('task_passed');
  db.exec("UPDATE runs SET stage='review_accepted'");
  const before = readFileSync(f.database);
  expect(JSON.parse(cli('plan-status', plan).out).tasks[0].stage).toBe('review_accepted');
  expect(readFileSync(f.database).equals(before)).toBe(true);
  expect(db.query('PRAGMA table_info(plan_tasks)').all().some((c: any) => c.name === 'stage')).toBe(false);
  db.close();
});
