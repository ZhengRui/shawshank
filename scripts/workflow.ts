import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readlinkSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { herdr, HerdrError, startupBlocked, type HerdrCall } from './herdr';
import { isOpenCodeSessionID } from './opencode';
import { provenanceInstructions, validateProvenance, retainedRole } from './commit-provenance';
import { allocatePane, prepareShell, returnToShell, shellPane } from './feature-pane';

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return args.includes('-z') ? result.stdout.toString() : result.stdout.toString().trim();
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function strings(value: unknown, name: string, nonempty = false): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim()) ||
      (nonempty && !value.length)) throw new Error(`${name} must be a ${nonempty ? 'nonempty ' : ''}string array`);
  return value;
}

// OpenCode V2 asks for approval on nearly every access outside the worker tree;
// an unattended worker must carry its configured --auto. It is never injected.
function requireAuto(worker: any, name: string) {
  if (worker?.kind === 'opencode' && !(Array.isArray(worker.args) && worker.args.includes('--auto')))
    throw new Error(`${name} must include --auto for OpenCode workers`);
}

function launchArgs(worker: any, name: string): string[] {
  requireAuto(worker, name);
  return strings(worker.args, name);
}

function paths(worktree: string) {
  const common = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const checkout = dirname(common);
  const root = join(checkout, '.shawshank/runs');
  return { checkout, root, database: join(root, 'workflow.sqlite') };
}

function dirty(worktree: string): boolean {
  return Boolean(git(worktree, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'));
}

function initialize(database: string): Database {
  const db = new Database(database, { create: true });
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, task_path TEXT NOT NULL,
      stage TEXT NOT NULL, base_sha TEXT NOT NULL, accepted_head TEXT,
      controller_id TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('cheap','standard','capable')),
      repair_count INTEGER NOT NULL DEFAULT 0 CHECK(repair_count >= 0),
      config_json TEXT NOT NULL, decision_path TEXT, blocked_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_worktree
      ON runs(worktree_path) WHERE stage != 'task_passed';
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
      action TEXT NOT NULL CHECK(action IN ('implementation','review','repair')),
      status TEXT NOT NULL, worker_kind TEXT, model TEXT, worker_name TEXT, pane_id TEXT,
      dispatch_path TEXT NOT NULL, report_path TEXT NOT NULL,
      base_sha TEXT NOT NULL, head_sha TEXT,
      correction_count INTEGER NOT NULL DEFAULT 0 CHECK(correction_count >= 0),
      started_at TEXT NOT NULL, finished_at TEXT
    );`);
  cleanupSchema(db);
  try {
    finalSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, input_path TEXT NOT NULL,
      base_sha TEXT NOT NULL, controller_id TEXT NOT NULL,
      final_run_id TEXT UNIQUE REFERENCES runs(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_tasks (
      plan_id TEXT NOT NULL REFERENCES plans(id), task_key TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 0),
      run_id TEXT UNIQUE REFERENCES runs(id),
      PRIMARY KEY(plan_id, task_key), UNIQUE(plan_id, position)
    );`);
  } catch (error) { db.close(); throw error; }
  return db;
}

const terminalStages = "'task_passed','review_reported','final_passed'";

function finalSchema(db: Database) {
  db.transaction(() => {
    const columns = db.query('PRAGMA table_info(runs)').all() as any[];
    if (columns.some(c => c.name === 'kind')) return;
    const schema = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='attempts'").get() as any;
    const indexes = db.query("SELECT sql FROM sqlite_schema WHERE tbl_name='attempts' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as any[];
    const expanded = schema.sql.replace("'implementation','review','repair'", "'implementation','review','repair','final_review','verification'");
    if (expanded === schema.sql) throw new Error('Unrecognized attempts schema; migration stopped');
    db.exec(`ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','final_review'))`);
    db.exec(expanded.replace(/CREATE TABLE\s+"?attempts"?/i, 'CREATE TABLE attempts_final_migration'));
    // Preserve rowids: attempt ordering is part of the existing ledger contract.
    const names = (db.query('PRAGMA table_info(attempts)').all() as any[]).map(c => `"${c.name}"`).join(',');
    db.exec(`INSERT INTO attempts_final_migration(rowid,${names}) SELECT rowid,${names} FROM attempts`);
    db.exec('DROP TABLE attempts; ALTER TABLE attempts_final_migration RENAME TO attempts');
    for (const index of indexes) db.exec(index.sql);
    db.exec(`DROP INDEX one_active_run_per_worktree;
      CREATE UNIQUE INDEX one_active_run_per_worktree ON runs(worktree_path)
      WHERE stage NOT IN (${terminalStages})`);
    if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('Migration foreign-key check failed');
  }).immediate();
}

function availableWorktree(db: Database, worktree: string, owningPlan = '') {
  if (db.query(`SELECT p.id FROM plans p LEFT JOIN runs r ON r.id=p.final_run_id
    WHERE p.worktree_path=? AND p.id!=? AND (r.id IS NULL OR r.stage!='final_passed' OR EXISTS (
      SELECT 1 FROM attempts a WHERE a.run_id=r.id AND a.pane_id IS NOT NULL
      AND COALESCE(a.cleanup_state,'')!='closed')) LIMIT 1`).get(worktree, owningPlan))
    throw new Error('An unfinished plan already owns this worktree');
  if (db.query(`SELECT id FROM runs WHERE worktree_path=? AND stage NOT IN (${terminalStages})`).get(worktree))
    throw new Error('An unfinished run already owns this worktree');
  if (db.query(`SELECT a.id FROM attempts a JOIN runs r ON r.id=a.run_id
    WHERE r.worktree_path=? AND a.pane_id IS NOT NULL AND COALESCE(a.cleanup_state,'')!='closed' LIMIT 1`).get(worktree))
    throw new Error('Previous run still has pending worker cleanup');
}

function validateFinalInput(input: any) {
  const worktree = realpathSync(required(input.worktree, 'worktree'));
  if (realpathSync(git(worktree, 'rev-parse', '--show-toplevel')) !== worktree)
    throw new Error('worktree must name the Git working tree root');
  if (!['report_only', 'repair_loop'].includes(input.intent)) throw new Error('Invalid intent');
  if (!['standalone', 'completed_plan'].includes(input.entry)) throw new Error('Invalid entry');
  required(input.scope?.reference, 'scope.reference');
  required(input.scope?.description, 'scope.description');
  const allowed = strings(input.scope?.allowedPaths, 'scope.allowedPaths', input.intent === 'repair_loop');
  if (allowed.some(p => isAbsolute(p) || p.split(/[\\/]/).includes('..') || p === '.'))
    throw new Error('allowedPaths must stay within the worktree');
  strings(input.scope.nonGoals, 'scope.nonGoals');
  for (const key of ['requiredChecks', 'runtimeMissions', 'environmentConstraints']) strings(input[key], key);
  required(input.authorization?.source, 'authorization.source');
  if (input.authorization?.intent !== input.intent) throw new Error('Authorization intent must match');
  if (input.intent === 'repair_loop' && input.authorization?.localCommits !== true)
    throw new Error('Explicit local commit authorization is required');
  for (const key of ['base', 'reviewedHEAD']) {
    if (!/^[a-f0-9]{40}$/.test(input[key] ?? '') || git(worktree, 'rev-parse', `${input[key]}^{commit}`) !== input[key])
      throw new Error(`${key} must be a full commit SHA`);
  }
  git(worktree, 'merge-base', '--is-ancestor', input.base, input.reviewedHEAD);
  if (dirty(worktree) || git(worktree, 'rev-parse', 'HEAD') !== input.reviewedHEAD)
    throw new Error('Working tree must be clean at reviewedHEAD');
  if (!Array.isArray(input.taskEvidence) || (input.entry === 'completed_plan' && !input.taskEvidence.length))
    throw new Error('Completed-plan entry requires task evidence');
  const location = paths(worktree);
  if (Bun.spawnSync(['git', '-C', location.checkout, 'check-ignore', '-q', location.database]).exitCode !== 0)
    throw new Error('Ignore .shawshank/runs/ in the common checkout before registration');
  const config = projectConfig(worktree);
  const snapshot = { finalReviewStandard: 1, reviewer: projectRole(config.roles?.reviewer, 'roles.reviewer args'),
    verifier: { default: projectRole(config.roles?.verifier?.default, 'roles.verifier.default args'),
      hard: projectRole(config.roles?.verifier?.hard, 'roles.verifier.hard args') },
    implementerTiers: tierSnapshot(config), trailer: config.project?.commitTrailer,
    commitProvenance: config.project?.commitProvenance === true };
  if (!snapshot.reviewer) throw new Error('Final reviewer configuration required');
  if (input.intent === 'repair_loop' && !snapshot.verifier.default) throw new Error('Final verifier configuration required');
  return { worktree, location, snapshot };
}

function insertFinalRun(db: Database, input: any, controller: string,
  validated: ReturnType<typeof validateFinalInput>, id = randomUUID()) {
  const { worktree, location, snapshot } = validated;
  for (const evidence of input.taskEvidence) {
    if (evidence.kind === 'controller_provided') required(evidence.source, 'task evidence source');
    else if (evidence.kind === 'local_run') {
      const task = db.query('SELECT * FROM runs WHERE id=?').get(required(evidence.runId, 'task runId')) as any;
      if (!task || task.kind !== 'task' || task.stage !== 'task_passed' || !task.accepted_head)
        throw new Error('Task evidence must reference a passed local task');
      git(worktree, 'merge-base', '--is-ancestor', task.accepted_head, input.reviewedHEAD);
    } else throw new Error('Invalid task evidence kind');
  }
  const runPath = join(location.root, id), saved = join(runPath, 'input.json'), now = new Date().toISOString();
  mkdirSync(runPath, { recursive: true });
  writeFileSync(saved, JSON.stringify({ ...input, worktree }, null, 2), { flag: 'wx' });
  if (dirty(worktree) || git(worktree, 'rev-parse', 'HEAD') !== input.reviewedHEAD)
    throw new Error('Working tree changed during final registration');
  db.query(`INSERT INTO runs(id,kind,worktree_path,task_path,stage,base_sha,accepted_head,controller_id,tier,config_json,created_at,updated_at)
    VALUES (?,'final_review',?,?,'final_ready',?,?,?,'standard',?,?,?)`)
    .run(id, worktree, saved, input.base, input.reviewedHEAD, controller, JSON.stringify(snapshot), now, now);
  return { run: runPath, stage: 'final_ready', base_sha: input.base, reviewed_head: input.reviewedHEAD };
}

export function registerFinalReview(inputFile: string, controller: string) {
  required(controller, 'controller');
  const input = JSON.parse(readFileSync(realpathSync(inputFile), 'utf8'));
  const validated = validateFinalInput(input), { worktree, location } = validated;
  mkdirSync(location.root, { recursive: true });
  const db = initialize(location.database);
  try {
    return db.transaction(() => {
      availableWorktree(db, worktree);
      return insertFinalRun(db, input, controller, validated);
    }).immediate();
  } finally { db.close(); }
}

function cleanupSchema(db: Database) {
  // Additive upgrade for the already-running step 2/3 experiments.
  db.transaction(() => {
    const columns = db.query('PRAGMA table_info(attempts)').all() as any[];
    for (const name of ['cleanup_state', 'cleanup_error']) {
      if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE attempts ADD COLUMN ${name} TEXT`);
    }
  }).immediate();
}

function readTaskInput(taskFile: string) {
  const taskPath = realpathSync(taskFile);
  const task = JSON.parse(readFileSync(taskPath, 'utf8'));
  const worktree = realpathSync(required(task.worktree, 'worktree'));
  if (realpathSync(git(worktree, 'rev-parse', '--show-toplevel')) !== worktree)
    throw new Error('worktree must name the Git working tree root');
  required(task.goal, 'goal');
  const brief = resolve(dirname(taskPath), required(task.brief, 'brief'));
  required(readFileSync(brief, 'utf8'), 'brief content');
  const allowed = strings(task.allowedPaths, 'allowedPaths', true);
  if (allowed.some(p => isAbsolute(p) || p.split(/[\\/]/).includes('..') || p === '.'))
    throw new Error('allowedPaths must stay within the worktree');
  strings(task.nonGoals, 'nonGoals');
  strings(task.acceptance, 'acceptance', true);
  strings(task.dependencies, 'dependencies');
  required(task.authorization?.source, 'authorization.source');
  if (task.authorization?.localCommits !== true)
    throw new Error('Explicit local commit authorization is required');
  if (!['cheap', 'standard', 'capable'].includes(task.tier)) throw new Error('Invalid tier');
  return { taskPath, task, worktree, brief };
}

function insertTaskRun(db: Database, id: string, worktree: string, taskPath: string,
  base: string, controller: string, tier: string) {
  const now = new Date().toISOString();
  db.query(`INSERT INTO runs
    (id, worktree_path, task_path, stage, base_sha, controller_id, tier, config_json, created_at, updated_at)
    VALUES (?, ?, ?, 'registered', ?, ?, ?, '{}', ?, ?)`)
    .run(id, worktree, taskPath, base, controller, tier, now, now);
}

export function registerTask(taskFile: string, controller: string) {
  required(controller, 'controller');
  const { taskPath, task, worktree } = readTaskInput(taskFile);
  if (dirty(worktree)) throw new Error('Working tree is not clean');
  const base = git(worktree, 'rev-parse', 'HEAD');
  const location = paths(worktree);
  // Runtime storage belongs to the common checkout, including for linked trees.
  const ignored = Bun.spawnSync(['git', '-C', location.checkout, 'check-ignore', '-q', location.database]);
  if (ignored.exitCode !== 0)
    throw new Error('Ignore .shawshank/runs/ in the common checkout before registering a task');
  mkdirSync(location.root, { recursive: true });
  const db = initialize(location.database);
  try {
    const id = randomUUID();
    db.transaction(() => {
      availableWorktree(db, worktree);
      insertTaskRun(db, id, worktree, taskPath, base, controller, task.tier);
    }).immediate();
    return { run: join(location.root, id), stage: 'registered', base_sha: base };
  } finally { db.close(); }
}

export function registerPlan(inputFile: string, controller: string) {
  required(controller, 'controller');
  const source = realpathSync(inputFile), input = JSON.parse(readFileSync(source, 'utf8'));
  const worktree = realpathSync(required(input.worktree, 'worktree'));
  if (realpathSync(git(worktree, 'rev-parse', '--show-toplevel')) !== worktree)
    throw new Error('worktree must name the Git working tree root');
  required(input.authorization?.source, 'authorization.source');
  if (input.authorization?.intent !== 'repair_loop' || input.authorization?.localCommits !== true)
    throw new Error('Approved plan requires repair_loop and local commit authorization');
  const readReference = (file: unknown) => {
    const path = realpathSync(resolve(dirname(source), required(file, 'reference path')));
    return required(readFileSync(path, 'utf8'), 'reference content');
  };
  const planText = readReference(input.reference);
  if (!Array.isArray(input.tasks) || !input.tasks.length) throw new Error('Ordered tasks are required');
  const keys = new Set<string>();
  const tasks = input.tasks.map((entry: any) => {
    const key = required(entry.key, 'task key');
    if (keys.has(key)) throw new Error('Duplicate task key');
    keys.add(key);
    if ('input' in entry) throw new Error('Plan tasks use key/title, not prebuilt task inputs');
    return { key, title: required(entry.title, 'task title') };
  });
  const final = input.finalReview;
  if (!final || final.intent !== 'repair_loop' || final.entry !== 'completed_plan')
    throw new Error('Final review must be a completed_plan repair_loop');
  required(final.scope?.description, 'scope.description');
  const allowed = strings(final.scope?.allowedPaths, 'scope.allowedPaths', true);
  if (allowed.some(p => isAbsolute(p) || p.split(/[\\/]/).includes('..') || p === '.'))
    throw new Error('allowedPaths must stay within the worktree');
  strings(final.scope.nonGoals, 'scope.nonGoals');
  for (const key of ['requiredChecks', 'runtimeMissions', 'environmentConstraints']) strings(final[key], key);
  // Execution provenance is supplied only after the tasks have completed.
  for (const key of ['worktree', 'base', 'reviewedHEAD', 'taskEvidence', 'authorization'])
    if (key in final) throw new Error(`Final ${key} is derived from the plan, not a template field`);
  const scopeText = readReference(final.scope.reference);
  if (dirty(worktree)) throw new Error('Working tree is not clean');
  const base = git(worktree, 'rev-parse', 'HEAD'), location = paths(worktree);
  const targetBranch = required(final.targetBranch, 'finalReview.targetBranch');
  if (!/^refs\/(heads|remotes)\//.test(targetBranch)) throw new Error('targetBranch must be an explicit refs/heads/ or refs/remotes/ branch');
  const targetHead = git(worktree, 'rev-parse', '--verify', `${targetBranch}^{commit}`);
  const reviewBase = git(worktree, 'merge-base', '--all', targetHead, base);
  if (!/^[a-f0-9]{40}$/.test(reviewBase)) throw new Error('Whole-branch review requires one unambiguous merge base');
  if (Bun.spawnSync(['git', '-C', location.checkout, 'check-ignore', '-q', location.database]).exitCode !== 0)
    throw new Error('Ignore .shawshank/runs/ in the common checkout before registration');
  mkdirSync(location.root, { recursive: true });
  const db = initialize(location.database);
  try {
    const id = randomUUID(), path = join(location.root, id), saved = join(path, 'plan.json');
    db.transaction(() => {
      availableWorktree(db, worktree);
      if (dirty(worktree) || git(worktree, 'rev-parse', 'HEAD') !== base)
        throw new Error('Git state changed during plan registration');
      mkdirSync(path);
      const save = (name: string, content: string) => {
        const target = join(path, name);
        writeFileSync(target, content, { flag: 'wx' });
        return target;
      };
      const reference = save('approved-plan.md', planText);
      save('adjustments.md', '# Plan adjustments\n\n');
      const scope = save('final-scope.md', scopeText);
      save('plan.json', JSON.stringify({ ...input, worktree, reference,
        reviewBaseline: { targetBranch, targetHead, base: reviewBase },
        sourceReference: realpathSync(resolve(dirname(source), input.reference)), tasks,
        finalReview: { ...final, scope: { ...final.scope, reference: scope } } }, null, 2));
      db.query(`INSERT INTO plans(id,worktree_path,input_path,base_sha,controller_id,created_at)
        VALUES (?,?,?,?,?,?)`).run(id, worktree, saved, base, controller, new Date().toISOString());
      tasks.forEach((entry: any, position: number) => db.query(`INSERT INTO plan_tasks
        (plan_id,task_key,position) VALUES (?,?,?)`).run(id, entry.key, position));
    }).immediate();
    return { plan: path, base_sha: base, tasks: tasks.length, execution: 'run preparation only' };
  } finally { db.close(); }
}

export function planStatus(planPath: string) {
  const path = resolve(planPath), id = path.slice(path.lastIndexOf('/') + 1);
  const db = new Database(join(dirname(path), 'workflow.sqlite'), { readonly: true });
  try {
    const plan = db.query('SELECT * FROM plans WHERE id=?').get(id) as any;
    if (!plan) throw new Error('Plan not found');
    const tasks = db.query(`SELECT t.*, r.stage, r.accepted_head FROM plan_tasks t
      LEFT JOIN runs r ON r.id=t.run_id WHERE t.plan_id=? ORDER BY t.position`).all(id) as any[];
    for (const task of tasks) task.cleanup = task.run_id
      ? cleanupSummary(db, db.query('SELECT * FROM runs WHERE id=?').get(task.run_id)) : null;
    const final = plan.final_run_id ? db.query('SELECT * FROM runs WHERE id=?').get(plan.final_run_id) as any : null;
    const next = tasks.find(t => !t.run_id || t.stage !== 'task_passed' || t.cleanup?.state === 'pending');
    const finalCleanup = final ? cleanupSummary(db, final) : null;
    return { plan, tasks, recovery_fingerprint: planFingerprint(db, id), adjustments_path: join(path, 'adjustments.md'),
      final_run: final, final_cleanup: finalCleanup,
      next_action: next ? { task_key: next.task_key, action: !next.run_id ? 'prepare_task'
        : next.stage !== 'task_passed' ? 'resume_task' : 'cleanup_task' }
        : { action: !final ? 'prepare_final_review' : final.stage !== 'final_passed' ? 'resume_final_review'
          : finalCleanup?.state === 'pending' ? 'cleanup_final_review' : 'plan_complete' },
      execution: 'run preparation only', worker_observation: 'Not polled; saved state only' };
  } finally { db.close(); }
}

export async function amendPlanScope(planPath: string, controller: string, decisionFile: string, call: HerdrCall = herdr) {
  const path = realpathSync(planPath), id = path.slice(path.lastIndexOf('/') + 1);
  const db = new Database(join(dirname(path), 'workflow.sqlite'), { readwrite: true });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  try {
    const plan = db.query('SELECT * FROM plans WHERE id=?').get(id) as any;
    if (!plan || dirname(plan.input_path) !== path) throw new Error('Plan not found');
    if (plan.controller_id !== controller) throw new Error('Controller does not own this plan');
    if (plan.final_run_id) throw new Error('Scope amendment after final registration is not supported');
    const raw = readFileSync(decisionFile, 'utf8'), decision = JSON.parse(raw);
    const fingerprint = planFingerprint(db, id);
    if (decision.plan_id !== id || decision.plan_fingerprint !== fingerprint) throw new Error('Scope evidence is stale');
    required(decision.reason, 'reason');
    required(decision.authorization, 'existing plan authorization evidence');
    if (decision.within_approved_plan !== true) throw new Error('Only corrections within the approved plan are supported');
    const run = db.query(`SELECT r.* FROM runs r JOIN plan_tasks t ON t.run_id=r.id
      WHERE t.plan_id=? AND r.stage!='task_passed' ORDER BY t.position LIMIT 1`).get(id) as any;
    if (!run || run.id !== decision.run_id || run.stage !== 'repair_required' || run.controller_id !== controller)
      throw new Error('Scope amendment requires the owned current task at repair_required');
    cleanHead(run, decision.head_sha);
    if (decision.head_sha !== run.accepted_head) throw new Error('Scope HEAD is stale');
    const additions = strings(decision.add_paths, 'add_paths', true);
    for (const file of additions) {
      if (isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..') ||
          /[*?\[\]]/.test(file) || file.startsWith('.git/') || file === '.git')
        throw new Error('Scope corrections require explicit worktree files');
      const absolute = join(run.worktree_path, file);
      if (!lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute)
        throw new Error('Scope corrections require existing regular non-symlink files');
    }
    const attempts = db.query('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid DESC').all(run.id) as any[];
    const seen = new Set<string>();
    for (const attempt of attempts) {
      if (!attempt.pane_id || attempt.cleanup_state === 'closed' || seen.has(attempt.pane_id)) continue;
      seen.add(attempt.pane_id);
      if (attempt.status !== 'accepted') throw new Error('Unsettled attempt blocks scope amendment');
      const live = (await call('agent', 'get', attempt.worker_name)).agent;
      ready(live, attempt, JSON.parse(run.config_json).tab);
      if (live.cwd !== run.worktree_path || (live.foreground_cwd && live.foreground_cwd !== run.worktree_path))
        throw new Error('Worker worktree differs');
    }
    const planBytes = readFileSync(plan.input_path, 'utf8'), taskBytes = readFileSync(run.task_path, 'utf8');
    const savedPlan = JSON.parse(planBytes), task = JSON.parse(taskBytes);
    const added = additions.filter(p => !task.allowedPaths.includes(p) || !savedPlan.finalReview.scope.allowedPaths.includes(p));
    if (!added.length) throw new Error('No new scope paths');
    return db.transaction(() => {
      if (planFingerprint(db, id) !== fingerprint || readFileSync(decisionFile, 'utf8') !== raw ||
          readFileSync(plan.input_path, 'utf8') !== planBytes || readFileSync(run.task_path, 'utf8') !== taskBytes)
        throw new Error('Scope evidence changed; inspect again');
      cleanHead(run);
      const revision = randomUUID(), record = join(path, `scope-amendment-${revision}.json`);
      const newPlan = join(path, `plan-${revision}.json`);
      const newTask = join(dirname(run.task_path), `task-${revision}.json`);
      const newBrief = join(dirname(run.task_path), `brief-${revision}.md`);
      const briefText = readFileSync(resolve(dirname(run.task_path), task.brief), 'utf8');
      writeFileSync(newBrief, briefText + `\n\n## Authorized scope correction\n\n` +
        `The following existing files were omitted from the original allowed paths and are now included: ${additions.join(', ')}.\n` +
        `Reason: ${decision.reason}\nAuthorization: ${decision.authorization}\n` +
        `This correction supersedes only earlier path exclusions for these files; all other requirements remain unchanged.\n`, { flag: 'wx' });
      task.brief = newBrief;
      task.allowedPaths = [...new Set([...task.allowedPaths, ...additions])];
      savedPlan.finalReview.scope.allowedPaths = [...new Set([...savedPlan.finalReview.scope.allowedPaths, ...additions])];
      savedPlan.scopeAmendments = [...(savedPlan.scopeAmendments ?? []), record];
      task.scopeAmendments = [...(task.scopeAmendments ?? []), record];
      const save = (file: string, data: any) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
      save(record, { ...decision, controller, previous_plan: plan.input_path, previous_task: run.task_path,
        created_at: new Date().toISOString() });
      save(newPlan, savedPlan); save(newTask, task);
      db.query('UPDATE plans SET input_path=? WHERE id=?').run(newPlan, id);
      db.query('UPDATE runs SET task_path=?,updated_at=? WHERE id=?').run(newTask, new Date().toISOString(), run.id);
      return { plan: path, run: run.id, amendment: record, added_paths: additions, stage: run.stage };
    }).immediate();
  } finally { db.close(); }
}

function planFingerprint(db: Database, id: string) {
  return createHash('sha256').update(JSON.stringify({
    plan: db.query('SELECT * FROM plans WHERE id=?').get(id),
    tasks: db.query('SELECT * FROM plan_tasks WHERE plan_id=? ORDER BY position').all(id),
    runs: db.query('SELECT r.* FROM runs r JOIN plan_tasks t ON t.run_id=r.id WHERE t.plan_id=? ORDER BY t.position').all(id),
    attempts: db.query('SELECT a.* FROM attempts a JOIN plan_tasks t ON t.run_id=a.run_id WHERE t.plan_id=? ORDER BY t.position,a.rowid').all(id),
  })).digest('hex');
}

function planRecoveryDecision(db: Database, plan: any, decision: any) {
  if (plan.final_run_id) throw new Error('Plan takeover after final registration is not supported');
  if (decision.plan_id !== plan.id || decision.previous_controller !== plan.controller_id ||
      decision.plan_fingerprint !== planFingerprint(db, plan.id)) throw new Error('Plan recovery evidence is stale');
  if (decision.previous_command_stopped !== true) throw new Error('Establish that the previous command stopped before recovery');
  required(decision.evidence, 'previous command termination evidence');
  required(decision.session_evidence, 'same Herdr session evidence');
}

function transferPlanOwner(db: Database, plan: any, controller: string) {
  // Historical runs retain their reports and decisions; only coordination ownership changes.
  db.query('UPDATE runs SET controller_id=? WHERE id IN (SELECT run_id FROM plan_tasks WHERE plan_id=?)')
    .run(controller, plan.id);
  db.query('UPDATE plans SET controller_id=? WHERE id=?').run(controller, plan.id);
}

export async function takeOverPlan(planPath: string, controller: string, decisionFile: string, call: HerdrCall = herdr) {
  required(controller, 'new controller');
  const path = realpathSync(planPath), id = path.slice(path.lastIndexOf('/') + 1);
  const db = new Database(join(dirname(path), 'workflow.sqlite'), { readwrite: true });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  try {
    const plan = db.query('SELECT * FROM plans WHERE id=?').get(id) as any;
    if (!plan || dirname(plan.input_path) !== path) throw new Error('Plan not found');
    const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
    planRecoveryDecision(db, plan, decision);
    const tasks = db.query('SELECT * FROM plan_tasks WHERE plan_id=? ORDER BY position').all(id) as any[];
    const active = tasks.map(t => t.run_id ? db.query('SELECT * FROM runs WHERE id=?').get(t.run_id) as any : null)
      .find(r => r && (r.stage !== 'task_passed' || cleanupSummary(db, r).state === 'pending'));
    if (active) return await takeOver(join(dirname(path), active.id), controller, decisionFile, call);
    return db.transaction(() => {
      const current = db.query('SELECT * FROM plans WHERE id=?').get(id) as any;
      planRecoveryDecision(db, current, decision);
      if (JSON.stringify(JSON.parse(readFileSync(decisionFile, 'utf8'))) !== JSON.stringify(decision))
        throw new Error('Plan recovery decision changed');
      if (decision.stage !== 'between_tasks' || decision.attempt_id !== null || decision.resolution !== 'retain')
        throw new Error('Between-task takeover requires retain, between_tasks and null attempt_id');
      const head = passedPlanBoundary(db, current, tasks.filter(t => t.run_id), current.controller_id);
      availableWorktree(db, current.worktree_path, id);
      if (decision.head_sha !== head || dirty(current.worktree_path) || git(current.worktree_path, 'rev-parse', 'HEAD') !== head)
        throw new Error('Between-task Git boundary changed; preserve and inspect');
      writeFileSync(join(path, `takeover-${randomUUID()}.json`), JSON.stringify({ ...decision, new_controller: controller }, null, 2), { flag: 'wx' });
      transferPlanOwner(db, current, controller);
      return { plan: path, controller, stage: 'between_tasks', resolution: 'retain' };
    }).immediate();
  } finally { db.close(); }
}

function passedPlanBoundary(db: Database, plan: any, tasks: any[], controller: string) {
  let base = plan.base_sha;
  for (const entry of tasks) {
    const run = db.query('SELECT * FROM runs WHERE id=?').get(entry.run_id) as any;
    if (!run || run.kind !== 'task' || run.worktree_path !== plan.worktree_path ||
        run.controller_id !== controller || run.stage !== 'task_passed' || !run.accepted_head)
      throw new Error('Previous task must pass under the current controller');
    if (run.base_sha !== base) throw new Error('Previous task baseline does not match plan sequence');
    git(plan.worktree_path, 'merge-base', '--is-ancestor', base, run.accepted_head);
    base = run.accepted_head;
  }
  return base;
}

function taskReviewHandoff(db: Database, tasks: any[]) {
  return tasks.map(entry => {
    const run = db.query('SELECT * FROM runs WHERE id=?').get(entry.run_id) as any;
    const attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action='review' AND status='accepted' ORDER BY rowid DESC LIMIT 1")
      .get(run.id) as any;
    if (!attempt || !run.decision_path) throw new Error('Passed task is missing accepted review or triage evidence');
    const report = JSON.parse(readFileSync(attempt.report_path, 'utf8'));
    const decision = JSON.parse(readFileSync(run.decision_path, 'utf8'));
    if (report.attempt_id !== attempt.id || report.head_sha !== run.accepted_head ||
        decision.attempt_id !== attempt.id || decision.head_sha !== run.accepted_head ||
        !Array.isArray(report.findings) || !Array.isArray(decision.decisions) ||
        report.findings.length !== decision.decisions.length ||
        new Set(decision.decisions.map((d: any) => d.id)).size !== decision.decisions.length)
      throw new Error('Task review handoff has stale or incomplete evidence');
    const findings = report.findings.map((finding: any) => {
      const disposition = decision.decisions.find((d: any) => d.id === finding.id);
      if (!disposition || disposition.action === 'fix') throw new Error('Task review handoff has unresolved or missing decisions');
      required(disposition.evidence, 'task disposition evidence');
      if (disposition.action === 'deferred') required(disposition.user_authorization, 'task deferral authorization');
      return { finding, disposition };
    });
    return { task_key: entry.task_key, run_id: run.id, accepted_head: run.accepted_head,
      report_path: attempt.report_path, decision_path: run.decision_path, findings };
  });
}

export function preparePlanFinalReview(planPath: string, controller: string) {
  required(controller, 'controller');
  const path = realpathSync(planPath), id = path.slice(path.lastIndexOf('/') + 1);
  const database = join(dirname(path), 'workflow.sqlite');
  if (!existsSync(database)) throw new Error('Plan database not found');
  const db = new Database(database);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  try {
    return db.transaction(() => {
      const plan = db.query('SELECT * FROM plans WHERE id=?').get(id) as any;
      if (!plan || dirname(plan.input_path) !== path) throw new Error('Plan not found');
      if (plan.controller_id !== controller) throw new Error('Plan controller mismatch');
      if (plan.final_run_id) {
        const run = db.query('SELECT * FROM runs WHERE id=?').get(plan.final_run_id) as any;
        if (!run || run.kind !== 'final_review' || run.controller_id !== controller || run.worktree_path !== plan.worktree_path)
          throw new Error('Linked final ownership or identity mismatch');
        return { run: join(dirname(path), run.id), stage: run.stage, base_sha: run.base_sha,
          reviewed_head: JSON.parse(readFileSync(run.task_path, 'utf8')).reviewedHEAD, reused: true };
      }
      const tasks = db.query('SELECT * FROM plan_tasks WHERE plan_id=? ORDER BY position').all(id) as any[];
      if (!tasks.length || tasks.some(t => !t.run_id)) throw new Error('All plan tasks must be started and passed');
      const head = passedPlanBoundary(db, plan, tasks, controller);
      availableWorktree(db, plan.worktree_path, id);
      const saved = JSON.parse(readFileSync(plan.input_path, 'utf8'));
      const baseline = required(readFileSync(saved.reference, 'utf8'), 'approved plan baseline');
      const scope = required(readFileSync(saved.finalReview.scope.reference, 'utf8'), 'final scope');
      const adjustments = required(readFileSync(join(path, 'adjustments.md'), 'utf8'), 'plan adjustments');
      const amendments = (saved.scopeAmendments ?? []).map((file: string) => ({
        path: file, decision: JSON.parse(readFileSync(file, 'utf8')),
      }));
      const handoff = taskReviewHandoff(db, tasks);
      const reviewBase = required(saved.reviewBaseline?.base, 'registered whole-branch review baseline');
      const runId = randomUUID(), runPath = join(dirname(path), runId);
      const input = { ...saved.finalReview, worktree: plan.worktree_path, base: reviewBase,
        reviewedHEAD: head, entry: 'completed_plan', intent: 'repair_loop', authorization: saved.authorization,
        taskEvidence: tasks.map(t => ({ kind: 'local_run', runId: t.run_id })),
        scope: { ...saved.finalReview.scope, reference: join(runPath, 'review-scope.md') } };
      const validated = validateFinalInput(input);
      mkdirSync(runPath);
      writeFileSync(input.scope.reference, `# Whole-branch review\n\nReview every change from ${reviewBase} through ${head}, including changes predating plan registration.\n` +
        `Target: ${saved.reviewBaseline.targetBranch} pinned at ${saved.reviewBaseline.targetHead}.\nRepair authority remains limited to the approved allowed paths; request authority before expanding repairs.\n\n` +
        `# Approved plan\n\n${baseline}\n\n# Final scope\n\n${scope}\n\n# Recorded adjustments\n\n${adjustments}\n\n` +
        `# Authorized scope corrections\n\n${JSON.stringify(amendments, null, 2)}\n\n` +
        '# Task review handoff\n\nReassess deferred, wontfix, invalid and pre-existing findings in the whole-branch context. Preserve prior authorization and reasons; do not assume they are fixed or automatically require repair.\n\n' +
        JSON.stringify(handoff, null, 2) + '\n', { flag: 'wx' });
      const result = insertFinalRun(db, input, controller, validated, runId);
      db.query('UPDATE plans SET final_run_id=? WHERE id=? AND final_run_id IS NULL').run(runId, id);
      return { ...result, reused: false };
    }).immediate();
  } finally { db.close(); }
}

export function prepareNextRun(planPath: string, controller: string, taskKey: string, inputFile: string) {
  required(controller, 'controller');
  required(taskKey, 'task key');
  const path = realpathSync(planPath), id = path.slice(path.lastIndexOf('/') + 1);
  const database = join(dirname(path), 'workflow.sqlite');
  if (!existsSync(database)) throw new Error('Plan database not found');
  const db = new Database(database);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  try {
    return db.transaction(() => {
      const plan = db.query('SELECT * FROM plans WHERE id=?').get(id) as any;
      if (!plan || dirname(plan.input_path) !== path) throw new Error('Plan not found');
      if (plan.controller_id !== controller) throw new Error('Plan controller mismatch');
      const tasks = db.query('SELECT * FROM plan_tasks WHERE plan_id=? ORDER BY position').all(id) as any[];
      const target = tasks.find(t => t.task_key === taskKey);
      if (!target) throw new Error('Unknown plan task');
      // Bind retries to a named task, never silently advance to another one.
      if (target.run_id) {
        const run = db.query('SELECT * FROM runs WHERE id=?').get(target.run_id) as any;
        if (!run || run.controller_id !== controller || run.worktree_path !== plan.worktree_path || run.kind !== 'task')
          throw new Error('Linked task ownership or identity mismatch');
        return { run: join(dirname(path), run.id), task_key: taskKey, stage: run.stage,
          base_sha: run.base_sha, reused: true };
      }
      if (plan.final_run_id) throw new Error('Plan already has a final run');
      if (tasks.find(t => !t.run_id)?.task_key !== taskKey) throw new Error('Prepare tasks in registered order');
      const base = passedPlanBoundary(db, plan, tasks.filter(t => t.position < target.position), controller);
      availableWorktree(db, plan.worktree_path, id);
      if (dirty(plan.worktree_path) || git(plan.worktree_path, 'rev-parse', 'HEAD') !== base)
        throw new Error('Worktree differs from the accepted plan boundary');
      const item = readTaskInput(inputFile);
      if (item.worktree !== plan.worktree_path) throw new Error('Task worktree differs from plan');
      const savedPlan = JSON.parse(readFileSync(plan.input_path, 'utf8'));
      required(readFileSync(savedPlan.reference, 'utf8'), 'approved plan baseline');
      const adjustments = required(readFileSync(join(path, 'adjustments.md'), 'utf8'), 'plan adjustments');
      const briefText = readFileSync(item.brief, 'utf8');
      const runId = randomUUID(), runPath = join(dirname(path), runId);
      mkdirSync(runPath);
      const brief = join(runPath, 'brief.md'), saved = join(runPath, 'input.json');
      writeFileSync(join(runPath, 'adjustments-at-preparation.md'), adjustments, { flag: 'wx' });
      writeFileSync(brief, briefText, { flag: 'wx' });
      writeFileSync(saved, JSON.stringify({ ...item.task, worktree: item.worktree, brief }, null, 2), { flag: 'wx' });
      if (dirty(item.worktree) || git(item.worktree, 'rev-parse', 'HEAD') !== base)
        throw new Error('Worktree changed during task preparation');
      insertTaskRun(db, runId, item.worktree, saved, base, controller, item.task.tier);
      db.query('UPDATE plan_tasks SET run_id=? WHERE plan_id=? AND task_key=? AND run_id IS NULL')
        .run(runId, id, taskKey);
      return { run: runPath, task_key: taskKey, stage: 'registered', base_sha: base, reused: false };
    }).immediate();
  } finally { db.close(); }
}

export function status(runPath: string) {
  const path = resolve(runPath);
  const db = new Database(join(dirname(path), 'workflow.sqlite'), { readonly: true });
  try {
    const id = path.slice(path.lastIndexOf('/') + 1);
    const run = db.query('SELECT * FROM runs WHERE id = ?').get(id) as any;
    if (!run) throw new Error('Run not found');
    const discrepancies: string[] = [];
    let head: string | null = null;
    try {
      head = git(run.worktree_path, 'rev-parse', 'HEAD');
      if (!['implementing', 'final_repairing'].includes(run.stage) && head !== (run.accepted_head ?? run.base_sha)) discrepancies.push('HEAD differs from recorded baseline');
      if (!['implementing', 'final_repairing'].includes(run.stage) && dirty(run.worktree_path)) discrepancies.push('Working tree is dirty');
      JSON.parse(readFileSync(run.task_path, 'utf8'));
    } catch (error) { discrepancies.push(String(error)); }
    const attempts = db.query('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid').all(id);
    const cleanup = cleanupSummary(db, run);
    const next: Record<string, string> = { registered: 'dispatch-implementation',
      final_ready: 'dispatch-final-review',
      final_dispatching: 'reconcile final dispatch before further action',
      final_reviewing: 'observe final reviewer, then accept-final-review',
      final_triage: 'record-final-triage',
      final_repair_ready: 'dispatch-final-repair', final_repair_dispatching: 'reconcile final repair dispatch',
      final_repairing: 'observe implementer, then accept-final-repair',
      final_verification_ready: 'dispatch-verification', final_verification_dispatching: 'reconcile verifier dispatch',
      final_verifying: 'observe verifier, then accept-verification', final_completion_ready: 'complete-final-review',
      review_reported: 'report-only complete; findings are not necessarily resolved',
      final_passed: 'final review complete at recorded accepted HEAD',
      implementing: 'observe worker, then accept-implementation',
      implementation_accepted: 'dispatch-review', reviewing: 'observe reviewer, then accept-review',
      review_dispatching: 'reconcile review dispatch before further action',
      review_accepted: 'record-triage', repair_required: 'dispatch-repair',
      repair_dispatching: 'reconcile repair dispatch before further action',
      task_passed: 'task complete; final review requires a separate approved registration',
      dispatching: 'reconcile dispatch before further action' };
    return { run, attempts, observed_head: head, worktree_fingerprint: worktreeFingerprint(run.worktree_path), discrepancies, cleanup,
      next_action: discrepancies.length || run.blocked_reason ? 'resolve_discrepancies' :
        cleanup.pending.length ? 'cleanup-workers' : next[run.stage],
      worker_observation: 'Not polled by status; accept-implementation checks live identity and readiness' };
  } finally { db.close(); }
}

function worktreeFingerprint(worktree: string) {
  const hash = createHash('sha256');
  hash.update(git(worktree, 'rev-parse', 'HEAD'));
  hash.update(git(worktree, 'status', '--porcelain', '-z', '--untracked-files=all'));
  hash.update(git(worktree, 'diff', 'HEAD', '--binary', '--no-ext-diff'));
  hash.update(git(worktree, 'diff', '--cached', 'HEAD', '--binary', '--no-ext-diff'));
  for (const file of git(worktree, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    hash.update(file);
    const path = join(worktree,file);
    hash.update(lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
  }
  return hash.digest('hex');
}

function recoveryInput(file: string, run: any, allowRetainedEdits = false) {
  const decision = JSON.parse(readFileSync(file, 'utf8'));
  if (decision.previous_controller !== run.controller_id || decision.stage !== run.stage)
    throw new Error('Recovery decision is stale: controller or stage differs');
  if (decision.previous_command_stopped !== true)
    throw new Error('Establish that the previous command stopped before recovery');
  required(decision.evidence, 'previous command termination evidence');
  required(decision.session_evidence, 'same Herdr session evidence');
  // Retaining a worker transfers control, not acceptance of its moving worktree.
  if (!(allowRetainedEdits && decision.resolution === 'retain')) {
    if (decision.head_sha !== git(run.worktree_path, 'rev-parse', 'HEAD') ||
      decision.worktree_fingerprint !== worktreeFingerprint(run.worktree_path))
      throw new Error('Partial work differs from the recovery decision; preserve and inspect it');
    git(run.worktree_path, 'merge-base', '--is-ancestor', run.base_sha, decision.head_sha);
  }
  return decision;
}

function recoverySnapshot(db: Database, run: any) {
  return JSON.stringify({ run: db.query('SELECT * FROM runs WHERE id=?').get(run.id),
    attempts: db.query('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid').all(run.id) });
}

function replacementDecision(run: any) {
  const config = JSON.parse(run.config_json);
  return config.lastReplacementDecision ? JSON.parse(readFileSync(config.lastReplacementDecision,'utf8')) : null;
}

function startupWorktree(run: any, attempt: any) {
  const replacement = replacementDecision(run);
  if (replacement?.replacement_attempt_id === attempt.id) {
    if (replacement.head_sha !== git(run.worktree_path,'rev-parse','HEAD') ||
      replacement.worktree_fingerprint !== worktreeFingerprint(run.worktree_path))
      throw new Error('Partial work changed during replacement startup');
  } else cleanHead(run,attempt.action === 'implementation' ? run.base_sha : run.accepted_head);
}

function noLaunchWorktree(run: any, attempt: any) {
  if (replacementDecision(run)?.replacement_attempt_id === attempt.id)
    throw new Error('Replacement continuation requires replace-worker recovery, not no-launch rollback');
  cleanHead(run, attempt.action === 'implementation' ? run.base_sha : run.accepted_head);
}

async function recoveryAgent(run: any, attempt: any, call: HerdrCall) {
  const agent = (await call('agent', 'get', attempt.worker_name)).agent;
  if (agent?.name !== attempt.worker_name || agent.pane_id !== attempt.pane_id ||
    agent.agent !== attempt.worker_kind || agent.tab_id !== JSON.parse(run.config_json).tab ||
    !['idle', 'done', 'working', 'blocked'].includes(agent.agent_status) ||
    realpathSync(required(agent.cwd, 'worker cwd')) !== run.worktree_path ||
    realpathSync(required(agent.foreground_cwd, 'worker foreground cwd')) !== run.worktree_path)
    throw new Error('Recovery worker identity or state is unknown; do not replay');
  return agent;
}

// Recovery records operator evidence. It cannot infer prompt delivery or process
// death from idle state, nor fence arbitrary commands outside this program.
export async function resolveNoLaunch(runPath: string, controller: string, decisionFile: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath, 'either');
  try {
    owned(db, run.id, controller, run.stage, true);
    const stages: Record<string, string> = { dispatching: 'registered', review_dispatching: 'implementation_accepted',
      repair_dispatching: 'repair_required', final_dispatching: 'final_ready',
      final_repair_dispatching: 'final_repair_ready', final_verification_dispatching: 'final_verification_ready' };
    const stage = stages[run.stage];
    const attempt = db.query('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(run.id) as any;
    const decision = recoveryInput(decisionFile, run);
    if (!stage || attempt?.status !== 'prepared' || decision.attempt_id !== attempt.id || decision.resolution !== 'no_launch')
      throw new Error('No prepared dispatch matches the no-launch decision');
    noLaunchWorktree(run, attempt);
    if (decision.prompt_submitted !== false) throw new Error('Positive non-submission evidence required');
    required(decision.non_submission_evidence, 'positive non-submission evidence');
    const retained = attempt.pane_id && ['review', 'repair'].includes(attempt.action)
      ? db.query(`SELECT * FROM attempts WHERE run_id=? AND status='accepted'
          AND worker_name=? AND pane_id=? AND worker_kind=? AND model=?
          AND COALESCE(cleanup_state,'')!='closed' ORDER BY rowid DESC LIMIT 1`)
        .get(run.id, attempt.worker_name, attempt.pane_id, attempt.worker_kind, attempt.model) as any : null;
    if (retained) {
      if (decision.retained_attempt_id !== retained.id ||
          !(attempt.action === 'review' ? retained.action === 'review' : ['implementation', 'repair'].includes(retained.action)))
        throw new Error('Retained worker evidence must identify its accepted attempt');
      required(decision.retained_worker_evidence, 'retained worker identity and no remaining writers evidence');
      if (decision.no_session_created !== true) throw new Error('Retained dispatch must establish no new session created');
    } else {
      if (decision.retained_attempt_id != null) throw new Error('No matching accepted retained worker');
      required(decision.no_agent_evidence, 'no agent evidence');
    }
    required(decision.session_creation_evidence, 'session creation evidence');
    if (decision.no_session_created === true && (decision.session_id != null || decision.session_unused != null))
      throw new Error('Conflicting session creation evidence');
    if (decision.no_session_created !== true &&
        !(attempt.worker_kind === 'opencode' && isOpenCodeSessionID(decision.session_id) && decision.session_unused === true))
      throw new Error('Establish no session created or identify the unused session');
    const before = recoverySnapshot(db, run);
    const config = JSON.parse(run.config_json);
    if (retained) {
      ready(await recoveryAgent(run, attempt, call), attempt, config.tab);
    } else {
      try {
        await call('agent', 'get', attempt.worker_name);
        throw new Error('Worker still exists; no-launch recovery refused');
      } catch (error) {
        if (!(error instanceof HerdrError && error.code === 'agent_not_found')) throw error;
      }
      if (!attempt.pane_id) {
        if (decision.no_pane_created !== true) throw new Error('Missing pane receipt requires no_pane_created');
        required(decision.no_pane_evidence, 'no pane evidence');
      } else {
        try {
          const pane = (await call('pane', 'get', attempt.pane_id)).pane;
          if (pane?.pane_id !== attempt.pane_id || pane.tab_id !== config.tab || pane.agent)
            throw new Error('Pane identity or absence of agent is not confirmed');
          if (!config.reusePane || attempt.pane_id !== config.parentPane || attempt.pane_id === config.controllerPane)
            throw new Error('Close the confirmed unused split pane before releasing its attempt');
          const shell = await shellPane(call, attempt.pane_id, config.tab);
          if (realpathSync(shell.shell.cwd) !== run.worktree_path) throw new Error('Reusable shell directory changed');
        } catch (error) {
          if (!(error instanceof HerdrError && error.code === 'pane_not_found')) throw error;
        }
      }
    }
    db.transaction(() => {
      owned(db, run.id, controller, run.stage, true);
      if (recoverySnapshot(db, run) !== before || JSON.stringify(recoveryInput(decisionFile, run)) !== JSON.stringify(decision))
        throw new Error('Recovery evidence changed; re-inspect');
      noLaunchWorktree(run, attempt);
      mkdirSync(path, { recursive: true });
      const saved = join(path, `no-launch-${randomUUID()}.json`);
      writeFileSync(saved, JSON.stringify(decision, null, 2), { flag: 'wx' });
      config.lastNoLaunchDecision = saved;
      const repair = ['repair_dispatching', 'final_repair_dispatching'].includes(run.stage);
      const count = run.repair_count - (repair ? 1 : 0);
      const tier = run.stage === 'repair_dispatching' && count > 0 && count % 3 === 0
        ? ['cheap', 'standard', 'capable'][['cheap', 'standard', 'capable'].indexOf(run.tier) - 1] : run.tier;
      if (count < 0 || !tier) throw new Error('Invalid repair reservation');
      db.query("UPDATE attempts SET status='no_launch',cleanup_state='closed',finished_at=? WHERE id=?")
        .run(new Date().toISOString(), attempt.id);
      db.query('UPDATE runs SET stage=?,repair_count=?,tier=?,blocked_reason=NULL,config_json=?,updated_at=? WHERE id=?')
        .run(stage, count, tier, JSON.stringify(config), new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, stage, attempt_id: attempt.id, resolution: 'no_launch' };
  } finally { db.close(); }
}

export async function takeOver(runPath: string, controller: string, decisionFile: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath);
  try {
    required(controller, 'new controller');
    const decision = recoveryInput(decisionFile, run, true);
    const plan = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='plans'").get()
      ? db.query('SELECT p.* FROM plans p JOIN plan_tasks t ON t.plan_id=p.id WHERE t.run_id=?').get(run.id) as any : null;
    if (plan) {
      planRecoveryDecision(db, plan, decision);
      const active = db.query(`SELECT r.* FROM runs r JOIN plan_tasks t ON t.run_id=r.id
        WHERE t.plan_id=? ORDER BY t.position`).all(plan.id) as any[];
      const current = active.find(r => r.stage !== 'task_passed' || cleanupSummary(db, r).state === 'pending');
      if (current?.id !== run.id) throw new Error('Use take-over-plan for the current plan boundary');
    }
    const before = recoverySnapshot(db, run);
    const attempts = db.query('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid').all(run.id) as any[];
    const latest = attempts.at(-1);
    if ((decision.attempt_id ?? null) !== (latest?.id ?? null)) throw new Error('Recovery attempt differs');
    let stage = run.stage;
    let attemptStatus = latest?.status;
    let blocked = run.blocked_reason;
    const dispatching = ['dispatching', 'review_dispatching', 'repair_dispatching'].includes(stage);
    if (decision.resolution === 'submitted') {
      if (!(dispatching && ['prepared', 'prompting', 'startup_blocked'].includes(latest?.status)) &&
        !(latest?.status === 'correcting' && ['implementing','reviewing'].includes(stage)))
        throw new Error('No outstanding submission to reconcile');
      required(decision.submission_evidence, 'observed prompt delivery evidence');
      await recoveryAgent(run, latest, call);
      required(readFileSync(latest.dispatch_path, 'utf8'), 'retained dispatch');
      attemptStatus = 'submitted';
      stage = latest.action === 'review' ? 'reviewing' : 'implementing';
      blocked = null;
    } else if (decision.resolution === 'not_submitted') {
      const correction = latest?.status === 'correcting' && ['implementing','reviewing'].includes(stage);
      if (!(dispatching && ['prepared', 'startup_blocked', 'prompting'].includes(latest?.status)) && !correction)
        throw new Error('No outstanding dispatch to reconcile');
      required(decision.non_submission_evidence, 'positive non-submission evidence');
      const agent = await recoveryAgent(run, latest, call);
      ready(agent, latest, JSON.parse(run.config_json).tab);
      if (correction) cleanHead(run,latest.head_sha);
      else startupWorktree(run,latest);
      required(readFileSync(latest.dispatch_path, 'utf8'), 'retained dispatch');
      attemptStatus = correction ? 'correction_ready' : 'startup_blocked';
      blocked = null;
    } else if (decision.resolution === 'retain') {
      if (dispatching) throw new Error('Outstanding dispatch requires explicit reconciliation or unresolved');
      if (latest && !['submitted','accepted','replaced','no_launch','correction_ready'].includes(latest.status))
        throw new Error('Outstanding correction requires explicit reconciliation');
      for (const attempt of attempts.filter(a => a.status === 'submitted')) await recoveryAgent(run, attempt, call);
      if (latest?.status === 'correction_ready') {
        ready(await recoveryAgent(run,latest,call),latest,JSON.parse(run.config_json).tab);
        cleanHead(run,latest.head_sha);
        required(readFileSync(join(path,`${latest.id}-correction.md`),'utf8'),'retained correction prompt');
      }
      if (blocked?.startsWith('Unresolved attempt')) blocked = null;
    } else if (decision.resolution === 'unresolved') {
      blocked = `Unresolved attempt ${latest?.id ?? 'none'}: ${decision.evidence}`;
    } else throw new Error('Unknown recovery resolution');
    // A stopped close command may have closed its pane before saving its receipt.
    // Mark it pending, never closed; cleanup will re-observe and reconcile absence.
    const closing = attempts.filter(a => a.cleanup_state === 'closing');
    if (closing.length && decision.cleanup_command_stopped !== true)
      throw new Error('Confirm interrupted cleanup command stopped');
    db.transaction(() => {
      if (plan) planRecoveryDecision(db, db.query('SELECT * FROM plans WHERE id=?').get(plan.id), decision);
      if (recoverySnapshot(db, run) !== before) throw new Error('Run changed during recovery; re-inspect');
      if (JSON.stringify(recoveryInput(decisionFile, run, true)) !== JSON.stringify(decision))
        throw new Error('Recovery decision changed; re-inspect');
      mkdirSync(path, { recursive: true });
      const saved = join(path, `takeover-${randomUUID()}.json`);
      writeFileSync(saved, JSON.stringify(decision, null, 2), { flag: 'wx' });
      const config = JSON.parse(run.config_json);
      config.lastRecoveryDecision = saved;
      if (latest) db.query('UPDATE attempts SET status=? WHERE id=?').run(attemptStatus, latest.id);
      db.query("UPDATE attempts SET cleanup_state='pending',cleanup_error='Interrupted cleanup requires recheck' WHERE run_id=? AND cleanup_state='closing'").run(run.id);
      db.query('UPDATE runs SET controller_id=?,stage=?,blocked_reason=?,config_json=?,updated_at=? WHERE id=?')
        .run(controller, stage, blocked, JSON.stringify(config), new Date().toISOString(), run.id);
      if (plan) transferPlanOwner(db, plan, controller);
    }).immediate();
    return { run: path, controller, stage, attempt_id: latest?.id ?? null, resolution: decision.resolution };
  } finally { db.close(); }
}

function openRun(runPath: string, kind: 'task' | 'final_review' | 'either' = 'task') {
  const path = resolve(runPath);
  const db = new Database(join(dirname(path), 'workflow.sqlite'), { readwrite: true });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  cleanupSchema(db);
  const id = path.slice(path.lastIndexOf('/') + 1);
  const run = db.query('SELECT * FROM runs WHERE id = ?').get(id) as any;
  if (!run) { db.close(); throw new Error('Run not found'); }
  if (kind !== 'either' && (run.kind ?? 'task') !== kind) { db.close(); throw new Error('Wrong run kind; task commands cannot operate on final runs or vice versa'); }
  return { path, db, run };
}

function currentTaskInput(run: any, path: string) {
  // Plan inputs (including amendments) are immutable run-local revisions.
  // Legacy standalone runs retain a caller-owned task_path: after dispatch,
  // use their frozen task.json instead of rereading mutable caller input.
  const snapshot = join(path, 'task.json');
  const source = dirname(resolve(run.task_path)) !== path && existsSync(snapshot) ? snapshot : run.task_path;
  const task = JSON.parse(readFileSync(source, 'utf8'));
  task.brief = resolve(dirname(run.task_path), task.brief);
  return task;
}

function owned(db: Database, id: string, controller: string, stage: string, recovery = false) {
  const current = db.query('SELECT * FROM runs WHERE id = ?').get(id) as any;
  if (current.controller_id !== controller) throw new Error('Controller does not own this run');
  if (current.stage !== stage) throw new Error(`Expected ${stage}, found ${current.stage}`);
  if (!recovery && current.blocked_reason?.startsWith('Unresolved attempt')) throw new Error(current.blocked_reason);
  if (db.query("SELECT id FROM attempts WHERE run_id=? AND cleanup_state='closing' LIMIT 1").get(id))
    throw new Error('Worker cleanup is in progress; do not dispatch or change progress');
  return current;
}

function guardedTransport(db: Database, id: string, controller: string, call: HerdrCall): HerdrCall {
  const check = () => {
    const current = db.query('SELECT controller_id FROM runs WHERE id=?').get(id) as any;
    if (current?.controller_id !== controller) throw new Error('Controller does not own this run');
  };
  return async (...args) => { check(); const result = await call(...args); check(); return result; };
}

function saveAttempt(db: Database, run: any, controller: string, stage: string, sql: string, ...args: any[]) {
  db.transaction(() => { owned(db,run.id,controller,stage); db.query(sql).run(...args); }).immediate();
}

export async function replaceWorker(runPath: string, controller: string, decisionFile: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath, 'either');
  call = guardedTransport(db,run.id,controller,call);
  let claimed = false;
  try {
    owned(db, run.id, controller, run.stage,true);
    const decision = recoveryInput(decisionFile, run);
    if (decision.worker_stopped !== true) throw new Error('Previous worker must be stopped before replacement');
    required(decision.worker_stop_evidence, 'worker termination and no remaining writers evidence');
    required(decision.partial_work, 'partial work continuation decision');
    const previous = db.query('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(run.id) as any;
    const final = run.kind === 'final_review';
    const stages = final
      ? { final_review: ['final_dispatching', 'final_reviewing'], repair: ['final_repair_dispatching', 'final_repairing'],
          verification: ['final_verification_dispatching', 'final_verifying'] }
      : { implementation: ['dispatching', 'implementing'], review: ['review_dispatching', 'reviewing'],
          repair: ['repair_dispatching', 'implementing'] };
    const transitions = (stages as Record<string, string[]>)[previous?.action];
    if (!previous || previous.id !== decision.attempt_id || !['prepared','startup_blocked','prompting','submitted','replaced'].includes(previous.status) ||
      !transitions?.includes(run.stage))
      throw new Error('Replacement requires the outstanding attempt');
    const config = JSON.parse(run.config_json);
    const readOnly = ['review', 'final_review', 'verification'].includes(previous.action);
    const finalDecision = final && previous.action !== 'final_review' ? JSON.parse(readFileSync(run.decision_path, 'utf8')) : null;
    if (final) {
      if (existsSync(previous.report_path)) throw new Error('Final report exists; use delivery acceptance or correction, not replacement');
      if (decision.worker_index != null) throw new Error('Final replacement must preserve the selected role');
      if (readOnly) cleanHead(run, previous.head_sha);
    }
    const worker = final
      ? previous.action === 'final_review' ? config.reviewer : previous.action === 'verification'
        ? config.verifier?.[finalDecision.verifier_tier] : config.implementerTiers?.[finalDecision.implementer_tier]?.[0]
      : previous.action === 'review' ? config.reviewer : config.implementerTiers?.[run.tier]?.[decision.worker_index ?? 0];
    if (!worker || !['codex','opencode','claude'].includes(worker.kind)) throw new Error('Supported snapshotted replacement worker required');
    if (final && (worker.kind !== previous.worker_kind || worker.model !== previous.model))
      throw new Error('Final replacement role differs from the interrupted attempt');
    launchArgs(worker, 'replacement args');
    required(worker.model, 'replacement model');
    const parent = (await call('pane', 'get', config.parentPane)).pane;
    if (parent?.pane_id !== config.parentPane || parent.tab_id !== config.tab) throw new Error('Replacement parent identity differs');
    const original = required(readFileSync(previous.dispatch_path, 'utf8'), 'previous dispatch');
    const correctionPath = join(path, `${previous.id}-correction.md`);
    // Corrected replacements already carry a report-only dispatch. Preserve
    // references verbatim: old reports and schemas are evidence, not new outputs.
    const correctionContext = existsSync(correctionPath) ? correctionPath : previous.dispatch_path;
    if (previous.correction_count) required(readFileSync(correctionContext, 'utf8'), 'correction context');
    if (previous.correction_count && readFileSync(correctionContext, 'utf8').startsWith('# One commit-message correction\n'))
      throw new Error('Interrupted commit-message correction requires user judgment, not worker replacement');
    const before = recoverySnapshot(db, run);
    if (!previous.pane_id) {
      // Missing launch receipt is ambiguous, not evidence that launch never ran.
      if (decision.no_pane_created !== true) throw new Error('Missing pane receipt: establish that no pane was created');
      required(decision.no_pane_evidence, 'positive no-launch evidence');
    } else if (previous.cleanup_state !== 'closed') {
      if (previous.pane_id === config.parentPane && !config.reusePane) throw new Error('Cannot replace the parent pane');
      let absent = false;
      try {
        const observed = (await call('pane', 'get', previous.pane_id)).pane;
        if (observed?.pane_id !== previous.pane_id || observed.tab_id !== config.tab) throw new Error('Replacement pane identity differs');
      } catch (error) {
        if (error instanceof HerdrError && error.code === 'pane_not_found') absent = true;
        else throw error;
      }
      if (!absent) {
        const observed = (await call('pane', 'get', previous.pane_id)).pane;
        if (config.reusePane && previous.pane_id === config.parentPane && !observed?.agent)
          await shellPane(call, previous.pane_id, config.tab);
        else ready(await recoveryAgent(run, previous, call), previous, config.tab);
      }
      db.transaction(() => {
        owned(db, run.id, controller, run.stage,true);
        if (recoverySnapshot(db, run) !== before) throw new Error('Run changed during replacement');
        recoveryInput(decisionFile, run);
        db.query("UPDATE attempts SET cleanup_state='closing' WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed'").run(run.id, previous.pane_id);
      }).immediate();
      claimed = true;
      if (!absent) {
        if (config.reusePane && previous.pane_id === config.parentPane) {
          await returnToShell(call, previous, config);
        } else {
          const result = await call('pane', 'close', previous.pane_id);
          if (result.type !== 'ok') throw new Error('Unconfirmed replacement close');
          try { await call('pane','get',previous.pane_id); }
          catch (error) {
            if (error instanceof HerdrError && error.code === 'pane_not_found') absent = true;
            else throw error;
          }
          if (!absent) throw new Error('Old pane is still present; no replacement started');
        }
      }
      db.transaction(() => {
        const current = db.query('SELECT * FROM runs WHERE id=?').get(run.id) as any;
        if (current.controller_id !== controller || current.stage !== run.stage) throw new Error('Replacement ownership changed');
        db.query("UPDATE attempts SET cleanup_state='closed',cleanup_error=NULL WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed'").run(run.id, previous.pane_id);
      }).immediate();
      claimed = false;
    }
    const id = randomUUID();
    const name = `aw-${id.slice(0,20)}`;
    const dispatch = join(path, `${id}-dispatch.md`);
    const report = join(path, `${id}-report.json`);
    const [stage, submitted] = transitions;
    db.transaction(() => {
      owned(db, run.id, controller, run.stage,true);
      recoveryInput(decisionFile, run);
      if (final && existsSync(previous.report_path)) throw new Error('Final report appeared during replacement; inspect delivery');
      if (final && readOnly) cleanHead(run, previous.head_sha);
      const latest = db.query('SELECT id FROM attempts WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(run.id) as any;
      if (latest.id !== previous.id) throw new Error('Replacement already claimed');
      const saved = join(path, `replacement-${randomUUID()}.json`);
      writeFileSync(saved, JSON.stringify({...decision,replacement_attempt_id:id}, null, 2), {flag:'wx'});
      config.lastRecoveryDecision = saved;
      config.lastReplacementDecision = saved;
      if (!readOnly && !final) config.worker = roleSnapshot(worker);
      writeFileSync(dispatch, `# Explicit continuation after worker replacement\n\n` +
        (readOnly || previous.correction_count ? '' :
          provenanceInstructions(config.commitProvenance, roleSnapshot(worker), decision.head_sha)) +
        `Preserve existing commits and dirty files. Do not reset or discard partial work.\n` +
        `Continuation decision: ${decision.partial_work}\nObserved HEAD: ${decision.head_sha}\n` +
        `Worktree fingerprint: ${decision.worktree_fingerprint}\nOriginal contract follows:\n\n` +
        (previous.correction_count ?
          `Do not modify code, commit, or change Git HEAD ${previous.head_sha}. Do not operate panes or delegate.\n` +
          `This remains report-only correction; no additional correction budget is granted.\n` +
          `Read ${correctionContext} for the retained validation failure, original schema and evidence references.\n` +
          `Those references are context only, not authorization to implement or commit.\n` +
          `Override prior output instructions: write JSON only to ${report}, with attempt_id ${id}.\n` +
          `Preserve original reports. Do not invent evidence or substitute unverified SHAs.\n` :
          original.replaceAll(previous.report_path, report).replaceAll(previous.id, id)), {flag:'wx'});
      db.query("UPDATE attempts SET status='replaced',cleanup_state='closed',finished_at=? WHERE id=?")
        .run(new Date().toISOString(), previous.id);
      db.query(`INSERT INTO attempts (id,run_id,action,status,worker_kind,model,worker_name,dispatch_path,report_path,base_sha,head_sha,correction_count,started_at)
        VALUES (?,?,?,'prepared',?,?,?,?,?,?,?,?,?)`).run(id,run.id,previous.action,worker.kind,worker.model,name,dispatch,report,
          previous.base_sha,previous.head_sha,previous.correction_count,new Date().toISOString());
      db.query('UPDATE runs SET stage=?,config_json=?,blocked_reason=NULL,updated_at=? WHERE id=?')
        .run(stage,JSON.stringify(config),new Date().toISOString(),run.id);
    }).immediate();
    const attempt = {id,worker_name:name,worker_kind:worker.kind,pane_id:null as string|null};
    // Intent is durable before any new external operation. A lost receipt stays
    // prepared/prompting for explicit reconciliation, never automatic replay.
    const pane = await allocatePane(call, config, run.worktree_path, 'right');
    if (!pane?.pane_id || pane.tab_id !== config.tab || (!config.reusePane && (pane.pane_id === config.parentPane || pane.pane_id === previous.pane_id)))
      throw new Error('Unexpected replacement pane');
    db.transaction(() => { owned(db,run.id,controller,stage); db.query('UPDATE attempts SET pane_id=? WHERE id=?').run(pane.pane_id,id); }).immediate();
    attempt.pane_id = pane.pane_id;
    try {
      ready((await call('agent','start',name,'--kind',worker.kind,'--pane',pane.pane_id,'--timeout','30000','--',...worker.args)).agent,attempt,config.tab);
    } catch (error) {
      if (startupBlocked(error)) db.transaction(() => {
        owned(db,run.id,controller,stage); db.query("UPDATE attempts SET status='startup_blocked' WHERE id=?").run(id);
      }).immediate();
      throw error;
    }
    db.transaction(() => { owned(db,run.id,controller,stage); db.query("UPDATE attempts SET status='prompting' WHERE id=?").run(id); }).immediate();
    await call('agent','prompt',name,`Read ${dispatch} and follow it exactly.`);
    db.transaction(() => {
      owned(db,run.id,controller,stage);
      db.query("UPDATE attempts SET status='submitted' WHERE id=?").run(id);
      db.query('UPDATE runs SET stage=?,blocked_reason=NULL WHERE id=?').run(submitted,run.id);
    }).immediate();
    return {run:path,attempt_id:id,worker:name,pane:pane.pane_id,report,repair_count:run.repair_count};
  } catch (error) {
    if (claimed) db.query("UPDATE attempts SET cleanup_state='pending',cleanup_error=? WHERE run_id=? AND cleanup_state='closing' AND EXISTS (SELECT 1 FROM runs WHERE id=? AND controller_id=?)")
      .run(String(error),run.id,run.id,controller);
    throw error;
  } finally { db.close(); }
}

function cleanupTargets(db: Database, run: any) {
  const attempts = db.query('SELECT rowid AS sequence,* FROM attempts WHERE run_id=? AND pane_id IS NOT NULL ORDER BY rowid')
    .all(run.id) as any[];
  const panes = new Map<string, any>();
  for (const a of attempts) {
    if (['task_passed', 'final_passed'].includes(run.stage) || (run.kind === 'final_review' && ['final_review', 'verification'].includes(a.action) && a.status === 'accepted') ||
      a.cleanup_state === 'pending' || a.cleanup_state === 'closing') {
      if (!panes.has(a.pane_id) || a.cleanup_state !== 'closed') panes.set(a.pane_id, a);
    }
  }
  return [...panes.values()];
}

function cleanupSummary(db: Database, run: any) {
  const targets = cleanupTargets(db, run);
  const pending = targets.filter(a => a.cleanup_state !== 'closed').map(a => ({
    pane: a.pane_id, worker: a.worker_name, state: a.cleanup_state ?? 'pending', error: a.cleanup_error ?? null,
  }));
  return { state: pending.length ? 'pending' : targets.length ? 'complete' : 'not_due', pending };
}

async function closeWorker(db: Database, run: any, controller: string, attempt: any, call: HerdrCall) {
  const pane = attempt.pane_id;
  let claimed = false;
  try {
    db.transaction(() => {
      owned(db, run.id, controller, run.stage);
      const group = db.query("SELECT * FROM attempts WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed'").all(run.id, pane) as any[];
      if (!group.length) return;
      const config = JSON.parse(run.config_json);
      if (!pane || (pane === config.parentPane && !config.reusePane) || pane === config.controllerPane || group.some(a => a.status !== 'accepted' ||
        a.worker_name !== attempt.worker_name || a.worker_kind !== attempt.worker_kind))
        throw new Error('Pane ownership or accepted delivery is not confirmed');
      cleanHead(run);
      db.query("UPDATE attempts SET cleanup_state='closing',cleanup_error=NULL WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed'").run(run.id, pane);
      claimed = true;
    }).immediate();
    if (!claimed) return;
    let absent = false;
    try {
      const observed = (await call('pane', 'get', pane)).pane;
      if (observed?.pane_id !== pane || observed.tab_id !== JSON.parse(run.config_json).tab)
        throw new Error('Pane identity changed; preserve it');
    } catch (error) {
      if (error instanceof HerdrError && error.code === 'pane_not_found') absent = true;
      else throw error;
    }
    if (!absent) {
      const saved = JSON.parse(run.config_json);
      const reusable = saved.reusePane && pane === saved.parentPane;
      const alreadyShell = reusable && !(await call('pane', 'get', pane)).pane?.agent;
      if (!alreadyShell) {
        const agent = (await call('agent', 'get', attempt.worker_name)).agent;
        ready(agent, attempt, saved.tab);
        if (realpathSync(required(agent.cwd, 'worker cwd')) !== run.worktree_path ||
          realpathSync(required(agent.foreground_cwd, 'worker foreground cwd')) !== run.worktree_path)
          throw new Error('Worker directory changed; preserve it');
      }
      // Checked CLI operations, not server-side compare-and-close. Other actors
      // must not concurrently repurpose this owned pane.
      cleanHead(run);
      if (reusable) {
        await returnToShell(call, attempt, saved);
      } else {
        const result = await call('pane', 'close', pane);
        if (result.type !== 'ok') throw new Error('Unconfirmed pane close response');
        try {
          await call('pane', 'get', pane);
        } catch (error) {
          if (error instanceof HerdrError && error.code === 'pane_not_found') absent = true;
          else throw error;
        }
        if (!absent) throw new Error('Pane is still present after close');
      }
    }
    db.transaction(() => {
      const current = db.query('SELECT * FROM runs WHERE id=?').get(run.id) as any;
      if (current.controller_id !== controller || current.stage !== run.stage) throw new Error('Cleanup ownership changed');
      db.query("UPDATE attempts SET cleanup_state='closed',cleanup_error=NULL WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed'").run(run.id, pane);
    }).immediate();
  } catch (error) {
    if (claimed) db.query("UPDATE attempts SET cleanup_state='pending',cleanup_error=? WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed' AND EXISTS (SELECT 1 FROM runs WHERE id=? AND controller_id=?)")
      .run(String(error), run.id, pane,run.id,controller);
    throw error;
  }
}

export async function cleanupWorkers(runPath: string, controller: string, call: HerdrCall = herdr) {
  const { db, run } = openRun(runPath, 'either');
  call = guardedTransport(db,run.id,controller,call);
  try {
    owned(db, run.id, controller, run.stage);
    for (const attempt of cleanupTargets(db, run)) {
      if (attempt.cleanup_state === 'closed') continue;
      try { await closeWorker(db, run, controller, attempt, call); }
      catch (error) {
        // Keep task success separate from terminal cleanup, including failures
        // before the close claim (dirty files or unaccepted worker output).
        const current = db.query('SELECT cleanup_state FROM attempts WHERE id=?').get(attempt.id) as any;
        if (current.cleanup_state !== 'closing' && current.cleanup_state !== 'closed')
          db.query("UPDATE attempts SET cleanup_state='pending',cleanup_error=? WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed' AND EXISTS (SELECT 1 FROM runs WHERE id=? AND controller_id=?)")
            .run(String(error), run.id, attempt.pane_id,run.id,controller);
      }
    }
    return cleanupSummary(db, run);
  } finally { db.close(); }
}

function merge(a: any, b: any): any {
  for (const [key, value] of Object.entries(b)) {
    a[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(a[key] && typeof a[key] === 'object' ? a[key] : {}, value) : value;
  }
  return a;
}

function projectConfig(worktree: string) {
  const checkout = paths(worktree).checkout;
  const config = JSON.parse(readFileSync(join(checkout, '.shawshank/config.json'), 'utf8'));
  const local = join(checkout, '.shawshank/config.local.json');
  return existsSync(local) ? merge(config, JSON.parse(readFileSync(local, 'utf8'))) : config;
}

function roleSnapshot(worker: any) {
  return worker ? { kind: worker.kind, model: worker.model, args: worker.args,
    provider: worker.provider, effort: worker.effort } : undefined;
}

function validateDispatchedProvenance(message: string, commit: string, run: any, attempt: any) {
  const enabled = JSON.parse(run.config_json).commitProvenance;
  if (!enabled) return;
  // The first marker belongs to this dispatch; replacements embed older prompts.
  const marker = readFileSync(attempt.dispatch_path, 'utf8').match(/^Commit attribution: (.+)$/m);
  const contract = marker ? JSON.parse(marker[1]) : undefined;
  // Preserve pre-dispatch commits, including another worker's partial delivery.
  const inherited = contract && Bun.spawnSync(['git', '-C', run.worktree_path,
    'merge-base', '--is-ancestor', commit, contract.base]).exitCode === 0;
  validateProvenance(message, enabled, contract && !inherited ? contract.values : undefined);
}

// Roles read from project configuration are checked when snapshotted; a later
// stage must not meet a saved role that can no longer be corrected.
function projectRole(worker: any, name: string) {
  requireAuto(worker, name);
  return roleSnapshot(worker);
}

function tierSnapshot(config: any) {
  return Object.fromEntries(['cheap', 'standard', 'capable'].map(tier =>
    [tier, (config.roles?.implementer?.[tier] ?? []).map((worker: any) => projectRole(worker, `roles.implementer.${tier} args`))]));
}

function cleanHead(run: any, head = run.accepted_head) {
  if (!head || dirty(run.worktree_path) || git(run.worktree_path, 'rev-parse', 'HEAD') !== head)
    throw new Error('Git state differs from the accepted clean HEAD; preserve and inspect changes');
}

function ready(agent: any, attempt: any, tab: string) {
  if (agent?.name !== attempt.worker_name || agent.pane_id !== attempt.pane_id ||
    agent.tab_id !== tab || agent.agent !== attempt.worker_kind ||
    !['idle', 'done'].includes(agent.agent_status)) throw new Error('Worker identity/readiness is not confirmed');
}

function latestReview(db: Database, run: any) {
  const attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action='review' AND status='accepted' ORDER BY rowid DESC LIMIT 1")
    .get(run.id) as any;
  if (!attempt || attempt.head_sha !== run.accepted_head) throw new Error('No accepted review for current HEAD');
  return attempt;
}

function reviewReport(attempt: any, run: any) {
  const report = JSON.parse(readFileSync(attempt.report_path, 'utf8'));
  if (report.attempt_id !== attempt.id || report.base_sha !== run.base_sha || report.head_sha !== attempt.head_sha)
    throw new Error('Review provenance does not match attempt and accepted HEAD');
  required(report.evidence, 'review evidence');
  if (!Array.isArray(report.findings)) throw new Error('Review findings must be an array');
  const ids = new Set<string>();
  for (const finding of report.findings) {
    const id = required(finding?.id, 'finding id');
    if (ids.has(id)) throw new Error('Duplicate finding id');
    ids.add(id);
    if (!['critical', 'major', 'minor'].includes(finding.severity) ||
      !['in_scope', 'pre_existing'].includes(finding.category) ||
      !['open', 'resolved'].includes(finding.status)) throw new Error('Invalid finding classification');
    required(finding.title, 'finding title');
    required(finding.evidence, 'finding evidence');
  }
  return report;
}

function finalAttempt(db: Database, run: any, action: string) {
  const attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action=? AND status='accepted' ORDER BY rowid DESC LIMIT 1").get(run.id, action) as any;
  if (!attempt) throw new Error(`No accepted ${action}`);
  return { attempt, report: JSON.parse(readFileSync(attempt.report_path, 'utf8')) };
}

function finalFindings(db: Database, run: any): any[] {
  const { report } = finalAttempt(db, run, 'final_review');
  const findings = report.findings.map((f: any) => ({ ...f }));
  for (const row of db.query("SELECT report_path FROM attempts WHERE run_id=? AND action='verification' AND status='accepted' ORDER BY rowid").all(run.id) as any[]) {
    const verification = JSON.parse(readFileSync(row.report_path, 'utf8'));
    for (const result of verification.results) {
      const finding = findings.find((f: any) => f.id === result.id);
      if (!finding) throw new Error('Broken finding continuity');
      finding.status = result.status;
    }
    findings.push(...verification.regressions);
  }
  if (run.decision_path) {
    const decision = JSON.parse(readFileSync(run.decision_path, 'utf8'));
    for (const item of decision.decisions ?? []) {
      const finding = findings.find((f: any) => f.id === item.id);
      if (finding && ['invalid', 'wontfix', 'deferred'].includes(item.action)) finding.status = item.action;
    }
  }
  return findings;
}

function finalWorkPrompt(db: Database, run: any, attempt: any, action: string, input: any, decision: any) {
  const review = finalAttempt(db, run, 'final_review');
  const repair = action === 'verification' ? finalAttempt(db, run, 'repair') : null;
  const common = { attempt_id: attempt.id, review_id: review.attempt.id, round: run.repair_count + (repair ? 0 : 1),
    base_sha: run.accepted_head, head_sha: repair ? run.accepted_head : '<new committed HEAD>', evidence: '<concrete evidence>' };
  const schema = repair ? { ...common, repair_id: repair.attempt.id,
    results: repair.report.addressed_ids.map((id: string) => ({ id, status: 'PASS|FAIL|PARTIAL', evidence: '<verification evidence>' })), regressions: [] } :
    { ...common, status: 'DONE', addressed_ids: decision.decisions.filter((d: any) => d.action === 'fix').map((d: any) => d.id),
      checks: input.requiredChecks.map((requirement: string) => ({ requirement, status: 'PASS', evidence: '<command and result>' })) };
  if (repair && modernFinal(run)) Object.assign(schema, { coverage: coverageExample(input) });
  return `# ${repair ? 'Independent scoped finding verification' : 'Authorized final-review repair'}\n\n` +
    finalInstructions(run, repair ? 'final-verifier.md' : 'implementer.md') +
    `Repository: ${run.worktree_path}\nApproved input: ${run.task_path}\n${JSON.stringify(input, null, 2)}\n` +
    `Original review: ${review.attempt.report_path}\nDecision: ${run.decision_path}\n${JSON.stringify(decision, null, 2)}\n` +
    `Current findings: ${JSON.stringify(finalFindings(db, run), null, 2)}\n` +
    `Prior accepted repair/verification artifacts: ${JSON.stringify(db.query("SELECT action,report_path FROM attempts WHERE run_id=? AND action IN ('repair','verification') AND status='accepted' ORDER BY rowid").all(run.id))}\n` +
    (repair ? `Repair report: ${repair.attempt.report_path}\nInspect ${repair.attempt.base_sha}..${repair.attempt.head_sha}, fixed findings and directly introduced regressions only. This is NOT a new general review. Do not modify code or commit. Preserve other finding dispositions. New directly introduced regressions require distinct IDs, severity critical/major/minor, category code/security/ux/runtime, status open, description and concrete evidence.\n` :
      `Fix only the selected findings within scope.allowedPaths. Run required checks, commit fixes and leave a clean worktree. Commit trailer: ${required(JSON.parse(run.config_json).trailer, 'commit trailer')}\n` +
      provenanceInstructions(JSON.parse(run.config_json).commitProvenance,
        JSON.parse(run.config_json).implementerTiers?.[decision.implementer_tier]?.[0], run.accepted_head)) +
    `Do not push, delegate, operate panes, change scope, or start services. Preserve original artifacts. Missing runtime evidence must be reported honestly.\n` +
    (repair && modernFinal(run) ? `Record covering checks and relevant runtime missions in coverage, including NOT_RUN gaps; do not repeat unrelated whole-review missions. New regressions also require location, expected, actual and reproduction (or why reproduction is inapplicable).\n` : '') +
    `Write JSON only to ${attempt.report_path}:\n${JSON.stringify(schema, null, 2)}\n`;
}

// Pin the report contract on new runs; historical artifacts retain their schema.
function modernFinal(run: any) { return JSON.parse(run.config_json).finalReviewStandard === 1; }

function finalInstructions(run: any, role: string) {
  if (!modernFinal(run)) return '';
  const path = resolve(import.meta.dir, '../references', role);
  required(readFileSync(path, 'utf8'), 'internal role instructions');
  const checklist = resolve(import.meta.dir, '../references/interaction-checklist.md');
  required(readFileSync(checklist, 'utf8'), 'interaction checklist');
  return `Read and follow ${path} before work. For interaction-heavy changes, also read ${checklist}. These are internal instructions; do not invoke another review skill.\n`;
}

function coverageExample(input: any) {
  return [...new Set([...input.requiredChecks, ...input.runtimeMissions, '<additional promised behavior or necessary mission>'])]
    .map(requirement => ({ requirement, status: 'PASS|FAIL|NOT_RUN|NOT_APPLICABLE', evidence: '<actions/results or concrete limitation/applicability reason>' }));
}

function coverageRecords(value: any) {
  if (!Array.isArray(value) || !value.length) throw new Error('Coverage records required');
  const names = new Set<string>();
  for (const item of value) {
    const name = required(item?.requirement, 'coverage requirement');
    if (names.has(name) || !['PASS', 'FAIL', 'NOT_RUN', 'NOT_APPLICABLE'].includes(item.status)) throw new Error('Invalid or duplicate coverage record');
    names.add(name); required(item.evidence, 'coverage evidence or limitation');
  }
  return value as any[];
}

function findingDetails(finding: any) {
  for (const key of ['location', 'expected', 'actual', 'reproduction']) required(finding[key], `finding ${key}`);
}

function finalCoverage(run: any, input: any, report: any) {
  const coverage = coverageRecords(report.coverage);
  for (const requirement of [...input.requiredChecks, ...input.runtimeMissions]) {
    if (!coverage.some(item => item.requirement === requirement)) throw new Error('Missing declared check/runtime coverage');
  }
  const files = strings(report.scope?.primary_files, 'scope.primary_files');
  const changed = git(run.worktree_path, 'diff', '--name-only', '--no-renames', '-z', `${run.base_sha}..${run.accepted_head}`).split('\0').filter(Boolean);
  if (new Set(files).size !== files.length || changed.some(file => !files.includes(file))) throw new Error('Primary coverage must list every changed file exactly once');
  strings(report.scope.extended, 'scope.extended'); strings(report.scope.excluded, 'scope.excluded');
  strings(report.observations, 'observations'); required(report.cleanup, 'test data cleanup or inapplicability');
  for (const finding of report.findings) findingDetails(finding);
}

export function recordFinalTriage(runPath: string, controller: string, decisionFile: string) {
  const { path, db, run } = openRun(runPath, 'final_review');
  try {
    owned(db, run.id, controller, 'final_triage'); cleanHead(run);
    const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
    const review = finalAttempt(db, run, 'final_review');
    const last = db.query("SELECT id FROM attempts WHERE run_id=? AND action='verification' AND status='accepted' ORDER BY rowid DESC LIMIT 1").get(run.id) as any;
    if (decision.review_id !== review.attempt.id || decision.head_sha !== run.accepted_head ||
      (decision.verification_id ?? null) !== (last?.id ?? null)) throw new Error('Stale final triage provenance');
    const findings = finalFindings(db, run);
    if (!Array.isArray(decision.decisions) || decision.decisions.length !== findings.length ||
      new Set(decision.decisions.map((d: any) => d?.id)).size !== findings.length) throw new Error('Triage must cover every finding exactly once');
    for (const finding of findings) {
      const item = decision.decisions.find((d: any) => d.id === finding.id);
      if (!item) throw new Error('Missing finding disposition');
      required(item.evidence, 'triage evidence');
      if (!['fix', 'invalid', 'wontfix', 'deferred', 'keep'].includes(item.action)) throw new Error('Invalid final triage action');
      if (item.action === 'keep' && !['PASS', 'invalid', 'wontfix', 'deferred'].includes(finding.status)) throw new Error('Cannot keep unresolved finding');
      if (item.action === 'wontfix' && finding.severity !== 'minor') throw new Error('Major or critical finding requires repair or explicit user decision');
      if (item.action === 'deferred') required(item.authorization_source, 'explicit user deferral authorization');
      if (item.action === 'keep' && finding.status !== 'PASS') {
        const prior = JSON.parse(readFileSync(run.decision_path, 'utf8')).decisions.find((d: any) => d.id === item.id);
        item.action = prior.action; item.authorization_source = prior.authorization_source;
      }
    }
    decision.implementer_tier ??= 'standard'; decision.verifier_tier ??= 'default';
    if (!['cheap', 'standard', 'capable'].includes(decision.implementer_tier) || !['default', 'hard'].includes(decision.verifier_tier)) throw new Error('Invalid role tier');
    const needsRepair = decision.decisions.some((d: any) => d.action === 'fix');
    if (needsRepair && run.repair_count >= 3) throw new Error('Final repair budget exhausted; user judgment required');
    const stage = needsRepair ? 'final_repair_ready' : 'final_completion_ready';
    db.transaction(() => {
      owned(db, run.id, controller, 'final_triage'); cleanHead(run);
      const saved = join(path, `final-triage-${randomUUID()}.json`);
      writeFileSync(saved, JSON.stringify({ ...decision, previous_decision: run.decision_path }, null, 2), { flag: 'wx' });
      db.query('UPDATE runs SET stage=?,decision_path=?,updated_at=? WHERE id=?').run(stage, saved, new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, stage };
  } finally { db.close(); }
}

function finalChecks(input: any, evidence: any, includeRuntime = false, inapplicable: string[] = []) {
  const requirements = [...input.requiredChecks, ...(includeRuntime ? input.runtimeMissions : [])];
  if (!Array.isArray(evidence) || requirements.some(requirement => !evidence.some((e: any) =>
    e?.requirement === requirement && (e.status === 'PASS' || (includeRuntime && e.status === 'NOT_APPLICABLE' &&
      (inapplicable.includes(requirement) || typeof e.authorization_source === 'string' && e.authorization_source.trim()))) && typeof e.evidence === 'string' && e.evidence.trim())))
    throw new Error('Required check/runtime evidence missing or not PASS');
}

export async function acceptFinalWork(runPath: string, controller: string, action: 'repair' | 'verification', call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath, 'final_review');
  try {
    const repair = action === 'repair', stage = repair ? 'final_repairing' : 'final_verifying';
    owned(db, run.id, controller, stage);
    const attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action=? AND status='submitted'").get(run.id, action) as any;
    if (!attempt) throw new Error('No submitted final delivery');
    const agent = (await call('agent', 'get', attempt.worker_name)).agent;
    ready(agent, attempt, JSON.parse(run.config_json).tab);
    if (realpathSync(required(agent.cwd, 'worker cwd')) !== run.worktree_path || realpathSync(required(agent.foreground_cwd, 'worker foreground cwd')) !== run.worktree_path) throw new Error('Worker directory differs');
    const head = git(run.worktree_path, 'rev-parse', 'HEAD'); cleanHead(run, repair ? head : run.accepted_head);
    const report = JSON.parse(readFileSync(attempt.report_path, 'utf8'));
    const review = finalAttempt(db, run, 'final_review');
    if (report.attempt_id !== attempt.id || report.review_id !== review.attempt.id || report.round !== run.repair_count ||
      report.base_sha !== attempt.base_sha || report.head_sha !== head) throw new Error('Final delivery provenance mismatch');
    checkCorrectionHead(path, run, attempt, head);
    required(report.evidence, 'delivery evidence');
    const input = JSON.parse(readFileSync(run.task_path, 'utf8'));
    const decision = JSON.parse(readFileSync(run.decision_path, 'utf8'));
    let next: string;
    if (repair) {
      if (report.status !== 'DONE') throw new Error('Repair not complete');
      const ids = decision.decisions.filter((d: any) => d.action === 'fix').map((d: any) => d.id).sort();
      if (JSON.stringify(strings(report.addressed_ids, 'addressed_ids').slice().sort()) !== JSON.stringify(ids)) throw new Error('Repair must address exactly the selected findings');
      git(run.worktree_path, 'merge-base', '--is-ancestor', attempt.base_sha, head);
      const commits = git(run.worktree_path, 'rev-list', `${attempt.base_sha}..${head}`).split('\n').filter(Boolean);
      if (!commits.length) throw new Error('Repair has no new commit');
      const trailer = required(JSON.parse(run.config_json).trailer, 'commit trailer');
      for (const commit of commits) {
        const files = git(run.worktree_path, 'diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit).split('\0').filter(Boolean);
        if (files.some(file => !input.scope.allowedPaths.some((p: string) => file === p.replace(/\/$/, '') || file.startsWith(p.replace(/\/$/, '') + '/')))) throw new Error('Repair changed files outside allowed scope');
        const message = git(run.worktree_path, 'show', '-s', '--format=%B', commit);
        validateDispatchedProvenance(message, commit, run, attempt);
        if (!(trailer.includes('<agent display name>') ? /^Co-Authored-By: .+ <noreply@[^\s<>]+>$/m.test(message) : message.split('\n').includes(trailer))) throw new Error('Missing required commit trailer');
      }
      finalChecks(input, report.checks);
      next = 'final_verification_ready';
    } else {
      const prior = finalAttempt(db, run, 'repair');
      if (report.repair_id !== prior.attempt.id || prior.attempt.head_sha !== head) throw new Error('Verification repair provenance mismatch');
      if (!Array.isArray(report.results) || JSON.stringify(report.results.map((r: any) => r.id).sort()) !== JSON.stringify([...prior.report.addressed_ids].sort())) throw new Error('Verification must cover every repaired finding exactly once');
      for (const result of report.results) {
        if (!['PASS', 'FAIL', 'PARTIAL'].includes(result.status)) throw new Error('Invalid verification result');
        required(result.evidence, 'verification evidence');
      }
      const known = new Set(finalFindings(db, run).map(f => f.id));
      if (!Array.isArray(report.regressions)) throw new Error('Regressions array required');
      for (const finding of report.regressions) {
        required(finding.id, 'regression id'); required(finding.description, 'regression description'); required(finding.evidence, 'regression evidence');
        if (known.has(finding.id) || !['critical', 'major', 'minor'].includes(finding.severity) || !['code', 'security', 'ux', 'runtime'].includes(finding.category) || finding.status !== 'open') throw new Error('Invalid or duplicate regression');
        known.add(finding.id);
        if (modernFinal(run)) findingDetails(finding);
      }
      if (modernFinal(run)) coverageRecords(report.coverage);
      next = report.results.every((r: any) => r.status === 'PASS') && !report.regressions.length ? 'final_completion_ready' : 'final_triage';
    }
    db.transaction(() => {
      owned(db, run.id, controller, stage); cleanHead(run, head);
      const saved = join(path, `${attempt.id}-accepted-${randomUUID()}.json`), now = new Date().toISOString();
      writeFileSync(saved, JSON.stringify(report, null, 2), { flag: 'wx' });
      db.query('UPDATE attempts SET status=\'accepted\',head_sha=?,report_path=?,finished_at=?,cleanup_state=? WHERE id=?').run(head, saved, now, repair ? null : 'pending', attempt.id);
      db.query('UPDATE runs SET stage=?,accepted_head=?,blocked_reason=NULL,updated_at=? WHERE id=?').run(next, head, now, run.id);
    }).immediate();
    return { run: path, stage: next, head, cleanup: repair ? null : await cleanupWorkers(path, controller, call) };
  } finally { db.close(); }
}

export async function completeFinalReview(runPath: string, controller: string, evidenceFile: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath, 'final_review');
  try {
    owned(db, run.id, controller, 'final_completion_ready'); cleanHead(run);
    const input = JSON.parse(readFileSync(run.task_path, 'utf8'));
    if (input.intent !== 'repair_loop') throw new Error('Report-only run cannot complete a repair loop');
    const findings = finalFindings(db, run);
    if (findings.some(f => !['PASS', 'invalid', 'wontfix', 'deferred'].includes(f.status))) throw new Error('Unresolved final findings');
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    if (evidence.head_sha !== run.accepted_head) throw new Error('Stale completion HEAD');
    finalChecks(input, evidence.checks, true);
    const deferred = findings.filter(f => f.status === 'deferred' || f.status === 'wontfix').map(f => f.id).sort();
    if (JSON.stringify(strings(evidence.deferred_ids, 'deferred_ids').slice().sort()) !== JSON.stringify(deferred)) throw new Error('Deferred findings must be disclosed');
    const review = finalAttempt(db, run, 'final_review');
    if (modernFinal(run)) {
      // Include reviewer-discovered missions and later verifier gaps, not just
      // the controller's original list. Evidence is bound to completion HEAD.
      const coverage = [...review.report.coverage];
      for (const row of db.query("SELECT report_path FROM attempts WHERE run_id=? AND action='verification' AND status='accepted' ORDER BY rowid").all(run.id) as any[])
        coverage.push(...JSON.parse(readFileSync(row.report_path, 'utf8')).coverage);
      coverage.push(...coverageRecords(evidence.checks));
      const requirements = [...new Set<string>(coverage.map(item => item.requirement))];
      // Additional, consistently inapplicable checks need a scope reason, not
      // a user waiver. Declared checks and previously applicable work still do.
      const inapplicable = requirements.filter(requirement =>
        ![...input.requiredChecks, ...input.runtimeMissions].includes(requirement) &&
        coverage.filter(item => item.requirement === requirement).every(item => item.status === 'NOT_APPLICABLE'));
      finalChecks({ requiredChecks: requirements, runtimeMissions: [] }, evidence.checks, true, inapplicable);
      required(evidence.coverage_assessment, 'controller coverage assessment');
    }
    db.transaction(() => {
      owned(db, run.id, controller, 'final_completion_ready'); cleanHead(run);
      const saved = join(path, `final-completion-${randomUUID()}.json`);
      writeFileSync(saved, JSON.stringify({ ...evidence, review_id: review.attempt.id, reviewedHEAD: input.reviewedHEAD,
        decision_path: run.decision_path, verification_reports: db.query("SELECT report_path FROM attempts WHERE run_id=? AND action='verification' AND status='accepted' ORDER BY rowid").all(run.id),
        dispositions: findings.map(f => ({ id: f.id, status: f.status })) }, null, 2), { flag: 'wx' });
      const config = JSON.parse(run.config_json); config.completion_path = saved;
      db.query("UPDATE runs SET stage='final_passed',config_json=?,updated_at=? WHERE id=?").run(JSON.stringify(config), new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, stage: 'final_passed', head: run.accepted_head, deferred_ids: deferred, cleanup: await cleanupWorkers(path, controller, call) };
  } finally { db.close(); }
}

export async function dispatchFinalReview(runPath: string, controller: string,
  parentPane: string, tab: string, call: HerdrCall = herdr, reusePane = false) {
  return dispatchFinalAttempt(runPath, controller, 'final_review', parentPane, tab, call, reusePane);
}

export async function dispatchFinalWork(runPath: string, controller: string,
  action: 'repair' | 'verification', call: HerdrCall = herdr) {
  const { db, run } = openRun(runPath, 'final_review');
  const config = JSON.parse(run.config_json);
  db.close();
  return dispatchFinalAttempt(runPath, controller, action, config.parentPane, config.tab, call);
}

async function dispatchFinalAttempt(runPath: string, controller: string,
  action: 'final_review' | 'repair' | 'verification', parentPane: string, tab: string, call: HerdrCall, reusePane = false) {
  const { path, db, run } = openRun(runPath, 'final_review');
  call = guardedTransport(db, run.id, controller, call);
  let claimed = false;
  try {
    const config = JSON.parse(run.config_json);
    const initial = action === 'final_review';
    if (initial && run.stage === 'final_ready' && reusePane) {
      config.reusePane = true;
      config.controllerPane = required(process.env.HERDR_PANE_ID, 'verified controller pane');
      await prepareShell(call, parentPane, tab, run.worktree_path, config.controllerPane);
    }
    const repair = action === 'repair';
    const from = initial ? 'final_ready' : repair ? 'final_repair_ready' : 'final_verification_ready';
    const dispatching = initial ? 'final_dispatching' : repair ? 'final_repair_dispatching' : 'final_verification_dispatching';
    const submitted = initial ? 'final_reviewing' : repair ? 'final_repairing' : 'final_verifying';
    let attempt: any;
    if (run.stage === dispatching) {
      owned(db, run.id, controller, dispatching);
      if (config.parentPane !== parentPane || config.tab !== tab) throw new Error('Dispatch target changed');
      attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action=? AND status='startup_blocked'").get(run.id, action);
      if (!attempt) throw new Error('Final dispatch unresolved; replay is forbidden');
      startupWorktree(run, attempt);
      ready((await call('agent', 'get', attempt.worker_name)).agent, attempt, tab);
      db.transaction(() => {
        owned(db, run.id, controller, dispatching);
        if (db.query("UPDATE attempts SET status='prompting' WHERE id=? AND status='startup_blocked'").run(attempt.id).changes !== 1)
          throw new Error('Startup already claimed');
      }).immediate();
      claimed = true;
    } else {
      owned(db, run.id, controller, from);
      cleanHead(run);
      const decision = initial ? null : JSON.parse(readFileSync(run.decision_path, 'utf8'));
      if (repair && run.repair_count >= 3) throw new Error('Final repair budget exhausted; user judgment required');
      if (repair) required(config.trailer, 'commit trailer');
      const prior = repair ? db.query("SELECT * FROM attempts WHERE run_id=? AND action='repair' AND status='accepted' ORDER BY rowid DESC LIMIT 1").get(run.id) as any : null;
      const retained = prior && prior.cleanup_state !== 'closed';
      const worker = initial ? config.reviewer : repair ? config.implementerTiers?.[decision.implementer_tier]?.[0] : config.verifier?.[decision.verifier_tier];
      if (!['codex', 'claude', 'opencode'].includes(worker?.kind)) throw new Error('Unsupported final reviewer');
      required(worker.model, 'reviewer.model'); strings(worker.args, 'reviewer.args');
      // A retained implementer is prompted, not launched; its saved args are unused.
      if (!retained) requireAuto(worker, 'reviewer.args');
      if (!initial && (await cleanupWorkers(path, controller, call)).pending.length) throw new Error('Pending worker cleanup');
      if (retained && (prior.worker_kind !== worker.kind || prior.model !== worker.model)) throw new Error('Retained implementer configuration changed');
      if (retained) ready((await call('agent', 'get', prior.worker_name)).agent, prior, tab);
      const parent = (await call('pane', 'get', required(parentPane, 'parent pane'))).pane;
      if (parent?.pane_id !== parentPane || parent.tab_id !== required(tab, 'tab')) throw new Error('Parent identity mismatch');
      const input = JSON.parse(readFileSync(run.task_path, 'utf8'));
      const instructions = finalInstructions(run, initial ? 'final-reviewer.md' : repair ? 'implementer.md' : 'final-verifier.md');
      const id = randomUUID();
      attempt = { id, worker_name: `aw-${id.slice(0, 20)}`, worker_kind: worker.kind,
        dispatch_path: join(path, `${id}-dispatch.md`), report_path: join(path, `${id}-report.json`) };
      if (retained) { attempt.worker_name = prior.worker_name; attempt.pane_id = prior.pane_id; }
      db.transaction(() => {
        owned(db, run.id, controller, from); cleanHead(run);
        const now = new Date().toISOString();
        db.query(`INSERT INTO attempts(id,run_id,action,status,worker_kind,model,worker_name,dispatch_path,report_path,base_sha,head_sha,started_at)
          VALUES (?,?,?,'prepared',?,?,?,?,?,?,?,?)`)
          .run(id, run.id, action, worker.kind, worker.model, attempt.worker_name, attempt.dispatch_path, attempt.report_path,
            initial ? run.base_sha : run.accepted_head, run.accepted_head, now);
        if (retained) db.query('UPDATE attempts SET pane_id=? WHERE id=?').run(prior.pane_id, id);
        db.query('UPDATE runs SET stage=?,config_json=?,repair_count=repair_count+?,updated_at=? WHERE id=?')
          .run(dispatching, JSON.stringify({ ...config, parentPane, tab }), repair ? 1 : 0, now, run.id);
      }).immediate();
      claimed = true;
      writeFileSync(attempt.dispatch_path, initial ? `# Independent final review\n\n` +
        instructions +
        `Review ${run.worktree_path}, full range ${run.base_sha}..${run.accepted_head}.\n` +
        `Read the approved scope/plan and inspect affected callers and shared state. Review code, security, UX and runtime where applicable.\n` +
        `Do not modify code, commit, push, operate panes, delegate or start services. Preserve unexpected changes and stop.\n` +
        `Run required safe checks and runtime missions within the supplied constraints. Clearly report NOT RUN and limitations; do not invent evidence.\n` +
        `Unrelated pre-existing issues are observations, not blocking findings. Each finding needs concrete file/line evidence and reproduction where applicable.\n` +
        `Approved input:\n${JSON.stringify(input, null, 2)}\n` +
        `Finding severity: critical|major|minor; category: code|security|ux|runtime (test-code issues use code); status: open.\n` +
        `Write JSON only to ${attempt.report_path}:\n${JSON.stringify({ attempt_id: id, base_sha: run.base_sha,
          head_sha: run.accepted_head, evidence: '<review and check evidence, including limitations>',
          ...(modernFinal(run) ? { scope: { primary_files: git(run.worktree_path, 'diff', '--name-only', '--no-renames', '-z', `${run.base_sha}..${run.accepted_head}`).split('\0').filter(Boolean), extended: [], excluded: [] },
            coverage: coverageExample(input), observations: [], cleanup: '<test data and cleanup, or why inapplicable>' } : {}),
          findings: [{ id: 'FR-001', severity: 'major', category: 'code', status: 'open',
            description: '<problem and expected behavior>', evidence: '<file:line and reproduction>',
            ...(modernFinal(run) ? { location: '<file:line or concrete runtime location>', expected: '<required behavior>', actual: '<observed behavior>', reproduction: '<steps or why inapplicable>' } : {}) }] }, null, 2)}\n` +
        `Use findings: [] if no issues exist. This is report-only delivery, not authorization to repair.\n` :
        finalWorkPrompt(db, run, attempt, action, input, decision), { flag: 'wx' });
      if (!retained) {
      const pane = await allocatePane(call, { ...config, parentPane, tab }, run.worktree_path, 'down');
      if (!pane?.pane_id || pane.tab_id !== tab || (pane.pane_id === parentPane && !config.reusePane) ||
        db.query("SELECT id FROM attempts WHERE run_id=? AND pane_id=? AND COALESCE(cleanup_state,'')!='closed'").get(run.id, pane.pane_id)) throw new Error('Independent reviewer pane required');
      attempt.pane_id = pane.pane_id;
      saveAttempt(db, run, controller, dispatching, 'UPDATE attempts SET pane_id=? WHERE id=?', pane.pane_id, id);
      try {
        ready((await call('agent', 'start', attempt.worker_name, '--kind', worker.kind, '--pane', pane.pane_id,
          '--timeout', '30000', '--', ...worker.args)).agent, attempt, tab);
      } catch (error) {
        if (startupBlocked(error))
          saveAttempt(db, run, controller, dispatching, "UPDATE attempts SET status='startup_blocked' WHERE id=?", id);
        throw error;
      }
      }
      saveAttempt(db, run, controller, dispatching, "UPDATE attempts SET status='prompting' WHERE id=?", id);
    }
    await call('agent', 'prompt', attempt.worker_name, `Read ${attempt.dispatch_path} and follow it exactly.`);
    db.transaction(() => {
      owned(db, run.id, controller, dispatching);
      db.query("UPDATE attempts SET status='submitted' WHERE id=?").run(attempt.id);
      db.query('UPDATE runs SET stage=?,blocked_reason=NULL,updated_at=? WHERE id=?').run(submitted, new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, attempt_id: attempt.id, worker: attempt.worker_name, pane: attempt.pane_id, report: attempt.report_path };
  } catch (error) {
    if (claimed) db.query('UPDATE runs SET blocked_reason=? WHERE id=? AND controller_id=?')
      .run(`Final dispatch unresolved: ${String(error)}`, run.id, controller);
    throw error;
  } finally { db.close(); }
}

export async function acceptFinalReview(runPath: string, controller: string, call: HerdrCall = herdr, recoveryDecision?: string) {
  if (recoveryDecision !== undefined) required(recoveryDecision, 'recovery decision file');
  const { path, db, run } = openRun(runPath, 'final_review');
  try {
    owned(db, run.id, controller, 'final_reviewing');
    const attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action='final_review' AND status='submitted'").get(run.id) as any;
    if (!attempt) throw new Error('No submitted final review');
    const before = recoveryDecision ? recoverySnapshot(db, run) : undefined;
    const decisionBytes = recoveryDecision ? readFileSync(recoveryDecision) : undefined;
    const validateRecovery = () => {
      if (!recoveryDecision) return;
      if (!readFileSync(recoveryDecision).equals(decisionBytes!)) throw new Error('Recovery decision changed');
      const decision = recoveryInput(recoveryDecision, run);
      if (decision.run_id !== run.id || decision.attempt_id !== attempt.id)
        throw new Error('Recovery run or attempt differs');
      if (decision.worker_stopped !== true) throw new Error('Establish that the worker and background writers stopped');
      required(decision.worker_stop_evidence, 'worker and background writer termination evidence');
      if (decision.report_sha256 !== createHash('sha256').update(readFileSync(attempt.report_path)).digest('hex'))
        throw new Error('Recovery report digest differs');
    };
    if (recoveryDecision) {
      if (run.blocked_reason) throw new Error('Resolve blocked final execution before report recovery');
      required(attempt.worker_name, 'saved worker identity'); required(attempt.pane_id, 'saved pane identity');
      required(attempt.worker_kind, 'saved worker kind');
      const config = JSON.parse(run.config_json);
      required(config.tab, 'saved worker tab'); required(config.parentPane, 'saved parent pane');
      const reusable = config.reusePane && attempt.pane_id === config.parentPane;
      if (attempt.pane_id === config.parentPane && !reusable) throw new Error('Reviewer cannot own the parent pane');
      if (reusable && (attempt.pane_id === config.controllerPane || attempt.pane_id === process.env.HERDR_PANE_ID))
        throw new Error('Cannot recover from the controller pane');
      validateRecovery();
      for (const [kind, target, absent] of [['agent', attempt.worker_name, 'agent_not_found'], ['pane', attempt.pane_id, 'pane_not_found']]) {
        if (kind === 'pane' && reusable) {
          const observed = await shellPane(call, target, config.tab);
          if (realpathSync(observed.shell.cwd) !== run.worktree_path) throw new Error('Recovery shell directory differs');
          continue;
        }
        try { await call(kind, 'get', target); }
        catch (error) {
          if (error instanceof HerdrError && error.code === absent) continue;
          throw error;
        }
        throw new Error(`Recovery requires the saved ${kind} to be absent`);
      }
    } else {
      const agent = (await call('agent', 'get', attempt.worker_name)).agent;
      ready(agent, attempt, JSON.parse(run.config_json).tab);
      if (realpathSync(required(agent.cwd, 'worker cwd')) !== run.worktree_path ||
        realpathSync(required(agent.foreground_cwd, 'worker foreground cwd')) !== run.worktree_path)
        throw new Error('Reviewer directory differs');
    }
    cleanHead(run);
    const reportBytes = readFileSync(attempt.report_path);
    const report = JSON.parse(reportBytes.toString('utf8'));
    if (report.attempt_id !== attempt.id || report.base_sha !== run.base_sha || report.head_sha !== run.accepted_head)
      throw new Error('Final review provenance mismatch');
    required(report.evidence, 'review evidence');
    if (!Array.isArray(report.findings) || new Set(report.findings.map((f: any) => f?.id)).size !== report.findings.length)
      throw new Error('Invalid final findings');
    for (const finding of report.findings) {
      required(finding.id, 'finding id'); required(finding.description, 'finding description'); required(finding.evidence, 'finding evidence');
      if (!['critical', 'major', 'minor'].includes(finding.severity) || !['code', 'security', 'ux', 'runtime'].includes(finding.category) || finding.status !== 'open')
        throw new Error('Invalid final finding classification');
    }
    const input = JSON.parse(readFileSync(run.task_path, 'utf8'));
    if (modernFinal(run)) finalCoverage(run, input, report);
    const stage = input.intent === 'report_only' ? 'review_reported' : 'final_triage';
    db.transaction(() => {
      owned(db, run.id, controller, 'final_reviewing'); cleanHead(run);
      if (recoveryDecision) {
        if (before !== recoverySnapshot(db, run)) throw new Error('Final recovery state changed');
        validateRecovery();
        if (!readFileSync(attempt.report_path).equals(reportBytes)) throw new Error('Recovery report changed');
      }
      const snapshot = join(path, `${attempt.id}-accepted-${randomUUID()}.json`), now = new Date().toISOString();
      if (recoveryDecision) {
        const evidence = join(path, `${attempt.id}-recovery-${randomUUID()}.json`);
        writeFileSync(evidence, decisionBytes!, { flag: 'wx' });
        db.query('UPDATE runs SET config_json=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(run.config_json), finalReportRecoveryDecision: evidence }), run.id);
      }
      writeFileSync(snapshot, recoveryDecision ? reportBytes : JSON.stringify(report, null, 2), { flag: 'wx' });
      db.query("UPDATE attempts SET status='accepted',report_path=?,finished_at=?,cleanup_state='pending' WHERE id=?").run(snapshot, now, attempt.id);
      db.query('UPDATE runs SET stage=?,blocked_reason=NULL,updated_at=? WHERE id=?').run(stage, now, run.id);
    }).immediate();
    return { run: path, stage, findings: report.findings.length, cleanup: await cleanupWorkers(path, controller, call) };
  } finally { db.close(); }
}

export async function dispatchReview(runPath: string, controller: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath);
  call = guardedTransport(db,run.id,controller,call);
  let claimed = false;
  try {
    const config = JSON.parse(run.config_json);
    let attempt: any;
    if (run.stage === 'review_dispatching') {
      owned(db, run.id, controller, 'review_dispatching');
      attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action='review' AND status='startup_blocked'")
        .get(run.id);
      if (!attempt) throw new Error('Review dispatch unresolved; replay is forbidden');
      startupWorktree(run,attempt);
      ready((await call('agent', 'get', attempt.worker_name)).agent, attempt, config.tab);
      db.transaction(() => {
        owned(db, run.id, controller, 'review_dispatching');
        if (db.query("UPDATE attempts SET status='prompting' WHERE id=? AND status='startup_blocked'")
          .run(attempt.id).changes !== 1) throw new Error('Review startup already claimed');
      }).immediate();
      claimed = true;
    } else {
      owned(db, run.id, controller, 'implementation_accepted');
      cleanHead(run);
      const worker = config.reviewer ?? projectConfig(run.worktree_path).roles?.taskReviewer;
      if (!worker || !['codex', 'opencode', 'claude'].includes(worker.kind)) throw new Error('Supported reviewer configuration is required');
      strings(worker.args, 'reviewer.args');
      required(worker.model, 'reviewer.model');
      // Snapshot only the selected executable configuration, never project credentials.
      config.reviewer = roleSnapshot(worker);
      const id = randomUUID();
      attempt = { id, worker_name: `aw-${id.slice(0, 20)}`, worker_kind: worker.kind,
        dispatch_path: join(path, `${id}-dispatch.md`), report_path: join(path, `${id}-report.json`) };
      const input = currentTaskInput(run, path);
      const task = JSON.stringify(input, null, 2);
      const brief = readFileSync(resolve(dirname(run.task_path), input.brief), 'utf8');
      const previous = run.repair_count > 0 && run.decision_path ? readFileSync(run.decision_path, 'utf8') : null;
      const priorReview = previous ? db.query("SELECT * FROM attempts WHERE id=? AND run_id=? AND action='review' AND status='accepted'")
        .get(JSON.parse(previous).attempt_id, run.id) as any : null;
      if (previous && !priorReview) throw new Error('Prior triage has no accepted review');
      const priorReport = priorReview ? readFileSync(priorReview.report_path, 'utf8') : 'None';
      // Previously closed reviewers (including older runs) need a new session.
      // Otherwise retain identity; any live mismatch requires explicit recovery.
      const retained = priorReview && priorReview.cleanup_state !== 'closed';
      if (retained) {
        attempt.worker_name = priorReview.worker_name;
        attempt.pane_id = priorReview.pane_id;
      } else {
        // A retained reviewer is prompted in its own pane, never launched, so its
        // saved args and the parent pane a new split would need are both unused.
        requireAuto(worker, 'reviewer.args');
        const parent = (await call('pane', 'get', config.parentPane)).pane;
        if (parent?.pane_id !== config.parentPane || parent.tab_id !== config.tab) throw new Error('Review parent identity mismatch');
      }
      db.transaction(() => {
        owned(db, run.id, controller, 'implementation_accepted');
        cleanHead(run);
        const now = new Date().toISOString();
        db.query(`INSERT INTO attempts (id,run_id,action,status,worker_kind,model,worker_name,
          dispatch_path,report_path,base_sha,head_sha,started_at) VALUES (?,?,'review','prepared',?,?,?,?,?,?,?,?)`)
          .run(id, run.id, worker.kind, worker.model, attempt.worker_name, attempt.dispatch_path,
            attempt.report_path, run.base_sha, run.accepted_head, now);
        if (retained) db.query('UPDATE attempts SET pane_id=? WHERE id=?').run(attempt.pane_id, id);
        db.query('UPDATE runs SET stage=?,config_json=?,updated_at=? WHERE id=?')
          .run('review_dispatching', JSON.stringify(config), now, run.id);
      }).immediate();
      claimed = true;
      writeFileSync(attempt.dispatch_path, `# Independent task review\n\n` +
        `Inspect ${run.worktree_path}, range ${priorReview?.head_sha ?? run.base_sha}..${run.accepted_head}.\n` +
        (priorReview ? `This is a scoped re-review, not a new full-task review. Verify prior findings and regressions caused by the fix, inspecting affected callers as needed. Do not reopen unrelated unchanged code; record incidental observations in evidence, not new blocking findings.\n` : '') +
        `Do not modify code, commit, push, operate panes, delegate, or start services. Run required safe local checks.\n` +
        `Review the task contract and regressions. Findings need file/line and concrete evidence.\n` +
        `Task:\n${task}\nApproved brief:\n${brief}\nPrior triage (if any):\n${previous ?? 'None'}\n` +
        `Prior independent review:\n${priorReport}\n` +
        `Carry every prior finding id, including deferred findings, as open or resolved with fresh evidence.\n` +
        `Write JSON only to ${attempt.report_path}:\n` + JSON.stringify({ attempt_id: id,
          base_sha: run.base_sha, head_sha: run.accepted_head, evidence: '<review and check evidence>',
          findings: [{ id: 'F1', severity: 'major', category: 'in_scope', status: 'open',
            title: '<specific problem>', evidence: '<file:line and reproduction>' }] }, null, 2) +
        '\nUse findings: [] when no issues exist. Do not fabricate findings to exercise a repair.\n', { flag: 'wx' });
      if (retained) {
        // No prompt has been sent. Reuse the existing readiness continuation
        // if this session is temporarily busy or awaiting approval.
        saveAttempt(db,run,controller,'review_dispatching',"UPDATE attempts SET status='startup_blocked' WHERE id=?",id);
        ready((await call('agent', 'get', attempt.worker_name)).agent, attempt, config.tab);
      } else {
      const pane = (await call('pane', 'split', '--pane', config.parentPane, '--direction', 'down',
        '--cwd', run.worktree_path, '--no-focus')).pane;
      if (!pane?.pane_id || pane.tab_id !== config.tab || db.query(
        "SELECT id FROM attempts WHERE run_id=? AND action IN ('implementation','repair') AND pane_id=?")
        .get(run.id, pane.pane_id)) throw new Error('Reviewer must use a new independent pane');
      attempt.pane_id = pane.pane_id;
      saveAttempt(db,run,controller,'review_dispatching','UPDATE attempts SET pane_id=? WHERE id=?',pane.pane_id,id);
      try {
        ready((await call('agent', 'start', attempt.worker_name, '--kind', worker.kind, '--pane', pane.pane_id,
          '--timeout', '30000', '--', ...worker.args)).agent, attempt, config.tab);
      } catch (error) {
        if (startupBlocked(error))
          saveAttempt(db,run,controller,'review_dispatching',"UPDATE attempts SET status='startup_blocked' WHERE id=?",id);
        throw error;
      }
      }
      saveAttempt(db,run,controller,'review_dispatching',"UPDATE attempts SET status='prompting' WHERE id=?",id);
    }
    await call('agent', 'prompt', attempt.worker_name, `Read ${attempt.dispatch_path} and follow it exactly.`);
    db.transaction(() => {
      owned(db, run.id, controller, 'review_dispatching');
      db.query("UPDATE attempts SET status='submitted' WHERE id=?").run(attempt.id);
      db.query("UPDATE runs SET stage='reviewing',blocked_reason=NULL,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, attempt_id: attempt.id, worker: attempt.worker_name, pane: attempt.pane_id, report: attempt.report_path };
  } catch (error) {
    if (claimed) db.query('UPDATE runs SET blocked_reason=? WHERE id=? AND controller_id=?')
      .run(`Review dispatch unresolved: ${String(error)}`, run.id, controller);
    throw error;
  } finally { db.close(); }
}

export async function acceptReview(runPath: string, controller: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath);
  try {
    owned(db, run.id, controller, 'reviewing');
    const attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action='review' AND status='submitted'")
      .get(run.id) as any;
    if (!attempt) throw new Error('No submitted review');
    ready((await call('agent', 'get', attempt.worker_name)).agent, attempt, JSON.parse(run.config_json).tab);
    cleanHead(run);
    const report = reviewReport(attempt, run);
    if (run.repair_count > 0 && run.decision_path) {
      const prior = JSON.parse(readFileSync(run.decision_path, 'utf8'));
      for (const item of prior.decisions) {
        if (!report.findings.some((f: any) => f.id === item.id))
          throw new Error('Review must cover every prior finding, including prior fix and deferred decisions');
      }
    }
    db.transaction(() => {
      owned(db, run.id, controller, 'reviewing');
      cleanHead(run);
      const snapshot = join(path, `${attempt.id}-accepted-${randomUUID()}.json`);
      writeFileSync(snapshot, JSON.stringify(report, null, 2), { flag: 'wx' });
      const now = new Date().toISOString();
      db.query("UPDATE attempts SET status='accepted',report_path=?,finished_at=? WHERE id=?")
        .run(snapshot, now, attempt.id);
      db.query("UPDATE runs SET stage='review_accepted',blocked_reason=NULL,updated_at=? WHERE id=?").run(now, run.id);
    }).immediate();
    return { run: path, stage: 'review_accepted', findings: report.findings.length };
  } finally { db.close(); }
}

export async function recordTriage(runPath: string, controller: string, decisionFile: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath);
  try {
    owned(db, run.id, controller, 'review_accepted');
    cleanHead(run);
    const attempt = latestReview(db, run);
    const report = reviewReport(attempt, run);
    const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
    if (decision.attempt_id !== attempt.id || decision.head_sha !== run.accepted_head)
      throw new Error('Triage provenance does not match current review');
    if (!Array.isArray(decision.decisions) || decision.decisions.length !== report.findings.length ||
      new Set(decision.decisions.map((d: any) => d?.id)).size !== report.findings.length)
      throw new Error('Triage must cover every finding exactly once');
    for (const finding of report.findings) {
      const item = decision.decisions.find((d: any) => d.id === finding.id);
      if (!item) throw new Error('Triage must cover every finding exactly once');
      required(item.evidence, 'triage evidence');
      if (!['fix', 'invalid', 'pre_existing', 'wontfix', 'resolved', 'deferred'].includes(item.action))
        throw new Error('Invalid triage action');
      if (item.action === 'resolved' && finding.status !== 'resolved') throw new Error('Reviewer has not verified resolution');
      if (item.action === 'pre_existing' && finding.category !== 'pre_existing') throw new Error('Reviewer has not classified this as pre-existing');
      if (item.action === 'wontfix' && finding.severity !== 'minor') throw new Error('Major/critical deferral requires explicit user evidence');
      if (item.action === 'deferred') required(item.user_authorization, 'user authorization for deferral');
      if (item.action === 'fix' && finding.category === 'pre_existing') throw new Error('Pre-existing findings are outside this repair scope');
    }
    const stage = decision.decisions.some((d: any) => d.action === 'fix') ? 'repair_required' : 'task_passed';
    db.transaction(() => {
      owned(db, run.id, controller, 'review_accepted');
      cleanHead(run);
      const snapshot = join(path, `triage-${randomUUID()}.json`);
      writeFileSync(snapshot, JSON.stringify(decision, null, 2), { flag: 'wx' });
      db.query('UPDATE runs SET stage=?,decision_path=?,updated_at=? WHERE id=?')
        .run(stage, snapshot, new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, stage, deferred: decision.decisions.filter((d: any) => d.action === 'deferred'),
      cleanup: await cleanupWorkers(path, controller, call) };
  } finally { db.close(); }
}

export async function dispatchRepair(runPath: string, controller: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath);
  call = guardedTransport(db,run.id,controller,call);
  let claimed = false;
  try {
    const config = JSON.parse(run.config_json);
    if (run.stage === 'repair_dispatching') {
      owned(db, run.id, controller, 'repair_dispatching');
      const pending = db.query("SELECT * FROM attempts WHERE run_id=? AND action='repair' AND status='startup_blocked'").get(run.id) as any;
      if (!pending) throw new Error('Repair dispatch unresolved; replay is forbidden');
      startupWorktree(run,pending);
      ready((await call('agent', 'get', pending.worker_name)).agent, pending, config.tab);
      db.transaction(() => {
        owned(db, run.id, controller, 'repair_dispatching');
        if (db.query("UPDATE attempts SET status='prompting' WHERE id=? AND status='startup_blocked'").run(pending.id).changes !== 1)
          throw new Error('Repair startup already claimed');
      }).immediate();
      claimed = true;
      await call('agent', 'prompt', pending.worker_name, `Read ${pending.dispatch_path} and follow it exactly.`);
      db.transaction(() => {
        owned(db, run.id, controller, 'repair_dispatching');
        db.query("UPDATE attempts SET status='submitted' WHERE id=?").run(pending.id);
        db.query("UPDATE runs SET stage='implementing',blocked_reason=NULL,updated_at=? WHERE id=?")
          .run(new Date().toISOString(), run.id);
      }).immediate();
      return { run: path, attempt_id: pending.id, worker: pending.worker_name, pane: pending.pane_id,
        report: pending.report_path, repair_count: run.repair_count };
    }
    owned(db, run.id, controller, 'repair_required');
    cleanHead(run);
    if ((await cleanupWorkers(path, controller, call)).pending.length)
      throw new Error('Reviewer cleanup is pending; resolve it before repair dispatch');
    owned(db, run.id, controller, 'repair_required');
    const escalate = run.repair_count > 0 && run.repair_count % 3 === 0;
    const tier = escalate ? ['cheap', 'standard', 'capable'][['cheap', 'standard', 'capable'].indexOf(run.tier) + 1] : run.tier;
    if (!tier) throw new Error('Repair budget exhausted at highest tier; user judgment required');
    const previous = db.query("SELECT * FROM attempts WHERE run_id=? AND action IN ('implementation','repair') AND status='accepted' ORDER BY rowid DESC LIMIT 1")
      .get(run.id) as any;
    if (!previous) throw new Error('No accepted implementer to reuse');
    if (!(escalate && previous.cleanup_state === 'closed'))
      ready((await call('agent', 'get', previous.worker_name)).agent, previous, config.tab);
    config.implementerTiers ??= tierSnapshot(projectConfig(run.worktree_path));
    const worker = escalate ? config.implementerTiers[tier]?.[0] : retainedRole(config.worker, previous);
    if (!worker || !['codex', 'opencode', 'claude'].includes(worker.kind)) throw new Error('Supported escalation worker required');
    config.worker = roleSnapshot(worker);
    if (escalate) {
      launchArgs(worker, 'escalation worker args');
      required(worker.model, 'escalation worker model');
      const parent = (await call('pane', 'get', config.parentPane)).pane;
      if (parent?.pane_id !== config.parentPane || parent.tab_id !== config.tab) throw new Error('Repair parent identity mismatch');
    }
    const review = latestReview(db, run);
    const findings = reviewReport(review, run);
    const decision = JSON.parse(readFileSync(run.decision_path, 'utf8'));
    if (decision.attempt_id !== review.id || decision.head_sha !== run.accepted_head ||
      !decision.decisions.some((d: any) => d.action === 'fix')) throw new Error('Repair decision does not match current review');
    const task = currentTaskInput(run, path);
    if (escalate) await closeWorker(db, run, controller, previous, call);
    const id = randomUUID();
    const name = escalate ? `aw-${id.slice(0, 20)}` : previous.worker_name;
    let paneId = escalate ? null : previous.pane_id;
    const dispatch = join(path, `${id}-dispatch.md`);
    const report = join(path, `${id}-report.json`);
    db.transaction(() => {
      owned(db, run.id, controller, 'repair_required');
      cleanHead(run);
      const now = new Date().toISOString();
      db.query(`INSERT INTO attempts (id,run_id,action,status,worker_kind,model,worker_name,pane_id,
        dispatch_path,report_path,base_sha,started_at) VALUES (?,?,'repair','prepared',?,?,?,?,?,?,?,?)`)
        .run(id, run.id, worker.kind, worker.model, name, paneId,
          dispatch, report, run.accepted_head, now);
      db.query("UPDATE runs SET stage='repair_dispatching',repair_count=repair_count+1,tier=?,config_json=?,updated_at=? WHERE id=?")
        .run(tier, JSON.stringify(config), now, run.id);
    }).immediate();
    claimed = true;
    writeFileSync(dispatch, `# Repair the approved task\n\nWork only in ${run.worktree_path}.\n` +
      `Original baseline: ${run.base_sha}. Repair starts at ${run.accepted_head}.\n` +
      `Fix only findings whose triage action is fix. No delegation, review, pane control, push, or unrelated edits.\n` +
      `Task: ${JSON.stringify(task)}\nReview: ${JSON.stringify(findings)}\nTriage: ${JSON.stringify(decision)}\n` +
      `Approved brief: ${resolve(dirname(run.task_path), task.brief)}\nRead it before making repairs.\n` +
      `Run required checks, commit scope-limited repairs, and leave a clean worktree. Trailer: ${config.trailer}\n` +
      provenanceInstructions(config.commitProvenance, worker, run.accepted_head) +
      `Write JSON only to ${report}:\n` + JSON.stringify({ attempt_id: id, base_sha: run.base_sha,
        head_sha: '<full resulting SHA>', status: 'DONE', concerns: [],
        checks: task.acceptance.map((requirement: string) => ({ requirement, status: 'PASS',
          evidence: { command: '<executed command>', result: '<observed result>' } })) }, null, 2) + '\n', { flag: 'wx' });
    if (escalate) {
      const pane = await allocatePane(call, config, run.worktree_path, 'right');
      if (!pane?.pane_id || pane.tab_id !== config.tab || (!config.reusePane && pane.pane_id === previous.pane_id))
        throw new Error('Unexpected escalation pane identity');
      paneId = pane.pane_id;
      saveAttempt(db,run,controller,'repair_dispatching','UPDATE attempts SET pane_id=? WHERE id=?',paneId,id);
      try {
        ready((await call('agent', 'start', name, '--kind', worker.kind, '--pane', paneId!,
          '--timeout', '30000', '--', ...worker.args)).agent,
        { worker_name: name, pane_id: paneId, worker_kind: worker.kind }, config.tab);
      } catch (error) {
        if (startupBlocked(error))
          saveAttempt(db,run,controller,'repair_dispatching',"UPDATE attempts SET status='startup_blocked' WHERE id=?",id);
        throw error;
      }
    }
    saveAttempt(db,run,controller,'repair_dispatching',"UPDATE attempts SET status='prompting' WHERE id=?",id);
    await call('agent', 'prompt', name, `Read ${dispatch} and follow it exactly.`);
    db.transaction(() => {
      owned(db, run.id, controller, 'repair_dispatching');
      db.query("UPDATE attempts SET status='submitted' WHERE id=?").run(id);
      db.query("UPDATE runs SET stage='implementing',blocked_reason=NULL,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, attempt_id: id, worker: name, pane: paneId,
      report, repair_count: run.repair_count + 1 };
  } catch (error) {
    if (claimed) db.query('UPDATE runs SET blocked_reason=? WHERE id=? AND controller_id=?')
      .run(`Repair dispatch unresolved: ${String(error)}`, run.id, controller);
    throw error;
  } finally { db.close(); }
}

function checkCorrectionHead(path: string, run: any, attempt: any, head: string) {
  if (!attempt.correction_count) return;
  const file = join(path, `${attempt.id}-correction.md`);
  const prompt = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (prompt.startsWith('# One commit-message correction\n')) {
    const identity = (sha: string) => git(run.worktree_path, 'show', '-s', '--format=%T%n%P%n%an%n%ae%n%aI', sha);
    if (head === attempt.head_sha || identity(head) !== identity(attempt.head_sha))
      throw new Error('Commit-message correction must amend only the message, preserving tree, parents and author');
    const original = JSON.parse(required(prompt.match(/^Original report snapshot: (.+)$/m)?.[1], 'original report snapshot'));
    const corrected = JSON.parse(readFileSync(attempt.report_path, 'utf8'));
    if (!isDeepStrictEqual({ ...original, head_sha: head }, corrected))
      throw new Error('Commit-message correction may change only report head_sha');
  } else if (attempt.head_sha !== head) {
    throw new Error('Report-only correction changed Git HEAD; preserve commits for user judgment');
  }
}

export async function correctReport(runPath: string, controller: string, action: string,
  decisionFile: string, call: HerdrCall = herdr, commitMessage = false) {
  if (commitMessage && !['implementation', 'repair', 'final_repair'].includes(action))
    throw new Error('Only implementers can correct commit messages');
  const final = ['final_review', 'final_repair', 'verification'].includes(action);
  if (action === 'final_repair') action = 'repair';
  const { path, db, run } = openRun(runPath, final ? 'final_review' : 'task');
  call = guardedTransport(db,run.id,controller,call);
  let claimed = false;
  try {
    const stage = final ? action === 'repair' ? 'final_repairing' : action === 'verification' ? 'final_verifying' : 'final_reviewing' : action === 'review' ? 'reviewing' : 'implementing';
    owned(db, run.id, controller, stage);
    const pending = db.query("SELECT * FROM attempts WHERE run_id=? AND action=? AND status='correction_ready'").get(run.id,action) as any;
    if (pending) {
      const decision = JSON.parse(readFileSync(decisionFile,'utf8'));
      if (decision.attempt_id !== pending.id) throw new Error('Correction decision names a different attempt');
      required(decision.evidence,'correction continuation evidence');
      cleanHead(run,pending.head_sha);
      ready((await call('agent','get',pending.worker_name)).agent,pending,JSON.parse(run.config_json).tab);
      const prompt = join(path,`${pending.id}-correction.md`);
      required(readFileSync(prompt,'utf8'),'retained correction prompt');
      if (readFileSync(prompt, 'utf8').startsWith('# One commit-message correction\n') !== commitMessage)
        throw new Error('Use the original correction mode');
      db.transaction(() => {
        owned(db,run.id,controller,stage);
        if (db.query("UPDATE attempts SET status='correcting' WHERE id=? AND status='correction_ready'").run(pending.id).changes !== 1)
          throw new Error('Correction continuation already claimed');
      }).immediate();
      claimed = true;
      await call('agent','prompt',pending.worker_name,`Read ${prompt} and follow it exactly.`);
      saveAttempt(db,run,controller,stage,"UPDATE attempts SET status='submitted' WHERE id=?",pending.id);
      return {run:path,attempt_id:pending.id,report:pending.report_path,correction_count:pending.correction_count};
    }
    const attempt = db.query("SELECT * FROM attempts WHERE run_id=? AND action=? AND status='submitted'")
      .get(run.id, action) as any;
    if (!attempt || attempt.correction_count !== 0) throw new Error('No report correction available; user judgment required');
    const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
    if (decision.attempt_id !== attempt.id) throw new Error('Correction decision names a different attempt');
    required(decision.evidence, 'report validation failure evidence');
    const head = git(run.worktree_path, 'rev-parse', 'HEAD');
    if (dirty(run.worktree_path)) throw new Error('Report-only correction requires a clean worktree');
    if (commitMessage) {
      if (decision.head_sha !== head || decision.unpushed !== true)
        throw new Error('Commit correction requires current head_sha and unpushed evidence');
      required(decision.unpushed_evidence, 'unpushed evidence');
      const marker = readFileSync(attempt.dispatch_path, 'utf8').match(/^Commit attribution: (.+)$/m);
      const base = marker ? JSON.parse(marker[1]).base : attempt.base_sha;
      git(run.worktree_path, 'merge-base', '--is-ancestor', base, head);
      if (head === base || head === run.accepted_head ||
          git(run.worktree_path, 'for-each-ref', '--format=%(refname)', `--contains=${head}`, 'refs/remotes'))
        throw new Error('Cannot amend inherited, accepted or published HEAD');
      const message = git(run.worktree_path, 'show', '-s', '--format=%B', head);
      const trailer = JSON.parse(run.config_json).trailer;
      let invalid = false;
      try { validateDispatchedProvenance(message, head, run, attempt); } catch { invalid = true; }
      if (!(trailer.includes('<agent display name>') ? /^Co-Authored-By: .+ <noreply@[^\s<>]+>$/m.test(message) : message.split('\n').includes(trailer))) invalid = true;
      if (!invalid) throw new Error('Current HEAD has no commit attribution failure');
    }
    if (action === 'review' || action === 'final_review' || action === 'verification') cleanHead(run);
    ready((await call('agent', 'get', attempt.worker_name)).agent, attempt, JSON.parse(run.config_json).tab);
    const report = join(path, `${attempt.id}-correction-report.json`);
    const prompt = join(path, `${attempt.id}-correction.md`);
    const originalReport = commitMessage ? JSON.parse(readFileSync(attempt.report_path, 'utf8')) : undefined;
    if (commitMessage && (originalReport.attempt_id !== attempt.id || originalReport.head_sha !== head))
      throw new Error('Commit correction requires the original report for current HEAD');
    db.transaction(() => {
      owned(db, run.id, controller, stage);
      cleanHead(run, head);
      if (db.query("UPDATE attempts SET status='correcting',correction_count=1,report_path=?,head_sha=? WHERE id=? AND status='submitted' AND correction_count=0")
        .run(report, head, attempt.id).changes !== 1) throw new Error('Report correction already claimed');
    }).immediate();
    claimed = true;
    writeFileSync(prompt, (commitMessage ? `# One commit-message correction\n\n` +
      `Amend only the message of unaccepted, unpushed HEAD ${head}. Preserve its tree, parents and author.\n` +
      `Do not edit files, stage changes, rebase, push or rewrite other commits. Follow the original attribution contract.\n` +
      `Update only head_sha in the copied report after amendment; preserve checks and other evidence.\n` :
      `# One report-only correction\n\nDo not modify code, commit, or change Git HEAD ${head}.\n`) +
      `Do not operate panes or delegate.\n` +
      (commitMessage ? `Unpublished evidence: ${decision.unpushed_evidence}\n` : '') +
      `Original dispatch: ${attempt.dispatch_path}\nOriginal report: ${attempt.report_path}\n` +
      (commitMessage ? `Original report snapshot: ${JSON.stringify(originalReport)}\n` : '') +
      `Validation failure: ${decision.evidence}\nCorrect the report using the original schema,\n` +
      `but write JSON only to ${report}. Do not overwrite the original report.\n` +
      `Do not invent evidence or substitute SHAs for a review/check you did not perform.\n`, { flag: 'wx' });
    await call('agent', 'prompt', attempt.worker_name, `Read ${prompt} and follow it exactly.`);
    db.transaction(() => {
      owned(db, run.id, controller, stage);
      db.query("UPDATE attempts SET status='submitted' WHERE id=? AND status='correcting'").run(attempt.id);
    }).immediate();
    return { run: path, attempt_id: attempt.id, report, correction_count: 1 };
  } catch (error) {
    if (claimed) db.query('UPDATE runs SET blocked_reason=? WHERE id=? AND controller_id=?')
      .run(`Report correction unresolved: ${String(error)}`, run.id, controller);
    throw error;
  } finally { db.close(); }
}

export async function dispatchImplementation(runPath: string, controller: string,
  parentPane: string, tab: string, call: HerdrCall = herdr, startupDecision?: string, reusePane = false) {
  const { path, db, run } = openRun(runPath);
  call = guardedTransport(db,run.id,controller,call);
  let attempted = false;
  try {
    // A known startup approval happens before prompt submission. Resume only
    // that recorded case; uncertain prompt submission must not be replayed.
    if (run.stage === 'dispatching') {
      owned(db, run.id, controller, 'dispatching');
      const pending = db.query("SELECT * FROM attempts WHERE run_id=? AND status IN ('startup_blocked','prepared')")
        .get(run.id) as any;
      if (!pending) throw new Error('Dispatch unresolved; automatic replay is forbidden');
      if (pending.status === 'prepared') {
        // An operator can reconcile an older, coarse startup record explicitly.
        // Never infer delivery from an idle worker alone.
        if (!startupDecision) throw new Error('Prepared attempt requires an explicit startup decision');
        const decision = JSON.parse(readFileSync(startupDecision, 'utf8'));
        if (decision.attempt_id !== pending.id || decision.prompt_submitted !== false)
          throw new Error('Startup decision must confirm this attempt was not submitted');
        required(decision.evidence, 'startup decision evidence');
      }
      const saved = JSON.parse(run.config_json);
      if (saved.parentPane !== parentPane || saved.tab !== tab) throw new Error('Dispatch target changed');
      startupWorktree(run,pending);
      const agent = (await call('agent', 'get', pending.worker_name)).agent;
      if (agent?.name !== pending.worker_name || agent.pane_id !== pending.pane_id ||
        agent.tab_id !== tab || agent.agent !== pending.worker_kind ||
        !['idle', 'done'].includes(agent.agent_status)) throw new Error('Original worker is not ready');
      db.transaction(() => {
        owned(db, run.id, controller, 'dispatching');
        const claimed = db.query('UPDATE attempts SET status=? WHERE id=? AND status=?')
          .run('prompting', pending.id, pending.status);
        if (claimed.changes !== 1) throw new Error('Startup continuation already claimed');
        if (startupDecision) db.query('UPDATE runs SET decision_path=? WHERE id=?').run(realpathSync(startupDecision), run.id);
      }).immediate();
      attempted = true;
      await call('agent', 'prompt', pending.worker_name, `Read ${pending.dispatch_path} and follow it exactly.`);
      db.transaction(() => {
        owned(db, run.id, controller, 'dispatching');
        db.query('UPDATE attempts SET status=? WHERE id=?').run('submitted', pending.id);
        db.query('UPDATE runs SET stage=?,blocked_reason=NULL,updated_at=? WHERE id=?')
          .run('implementing', new Date().toISOString(), run.id);
      }).immediate();
      return { run: path, attempt_id: pending.id, worker: pending.worker_name, pane: pending.pane_id, report: pending.report_path };
    }
    owned(db, run.id, controller, 'registered');
    if (dirty(run.worktree_path) || git(run.worktree_path, 'rev-parse', 'HEAD') !== run.base_sha)
      throw new Error('Worktree changed since registration');
    const task = JSON.parse(readFileSync(run.task_path, 'utf8'));
    const taskSnapshot = join(path, 'task.json');
    const checkTaskSnapshot = () => {
      if (existsSync(taskSnapshot) && !isDeepStrictEqual(JSON.parse(readFileSync(taskSnapshot, 'utf8')), task))
        throw new Error('Retained task input changed');
    };
    checkTaskSnapshot();
    const brief = readFileSync(resolve(dirname(run.task_path), task.brief), 'utf8');
    const config = projectConfig(run.worktree_path);
    const placement = reusePane ? { reusePane: true, controllerPane: required(process.env.HERDR_PANE_ID, 'verified controller pane') } : {};
    if (reusePane) await prepareShell(call, parentPane, tab, run.worktree_path, placement.controllerPane!);
    const worker = config.roles?.implementer?.[run.tier]?.[0];
    if (!worker || !['codex', 'opencode', 'claude'].includes(worker.kind))
      throw new Error('Explicit codex/opencode/claude implementer configuration required');
    launchArgs(worker, 'worker.args');
    required(worker.model, 'worker.model');
    const reviewer = projectRole(config.roles?.taskReviewer, 'roles.taskReviewer args'), implementerTiers = tierSnapshot(config);
    const trailer = required(config.project?.commitTrailer, 'project.commitTrailer');
    const parent = (await call('pane', 'get', parentPane)).pane;
    if (parent?.pane_id !== parentPane || parent.tab_id !== tab)
      throw new Error('Parent pane does not belong to the explicitly allowed tab');
    const id = randomUUID();
    const name = `aw-${id.slice(0, 20)}`;
    const dispatch = join(path, `${id}-dispatch.md`);
    const report = join(path, `${id}-report.json`);
    db.transaction(() => {
      owned(db, run.id, controller, 'registered');
      checkTaskSnapshot();
      const now = new Date().toISOString();
      db.query(`INSERT INTO attempts (id,run_id,action,status,worker_kind,model,worker_name,
        dispatch_path,report_path,base_sha,started_at) VALUES (?,?,'implementation','prepared',?,?,?,?,?,?,?)`)
        .run(id, run.id, worker.kind, worker.model, name, dispatch, report, run.base_sha, now);
      db.query('UPDATE runs SET stage=?,config_json=?,updated_at=? WHERE id=?')
        .run('dispatching', JSON.stringify({ lastNoLaunchDecision: JSON.parse(run.config_json).lastNoLaunchDecision,
          ...placement, worker: roleSnapshot(worker), trailer, parentPane, tab,
          commitProvenance: config.project?.commitProvenance === true,
          reviewer, implementerTiers }), now, run.id);
    }).immediate();
    attempted = true;
    mkdirSync(path, { recursive: true });
    if (!existsSync(taskSnapshot)) writeFileSync(taskSnapshot, JSON.stringify(task, null, 2), { flag: 'wx' });
    writeFileSync(dispatch, `# Implement one approved task\n\nWork only in ${run.worktree_path}.\n` +
      `No subagents, review, push, pane control, or unrelated changes. Implement, test, and commit.\n` +
      `Commit trailer: ${trailer}\nTask input:\n\n${JSON.stringify(task, null, 2)}\n\nBrief:\n${brief}\n\n` +
      provenanceInstructions(config.project?.commitProvenance === true, roleSnapshot(worker), run.base_sha) +
      `Write JSON only to ${report}, using this contract:\n` +
      JSON.stringify({ attempt_id: id, base_sha: run.base_sha, head_sha: '<full resulting SHA>',
        status: 'DONE', checks: task.acceptance.map((requirement: string) =>
          ({ requirement, status: 'PASS', evidence: { command: '<executed command>', result: '<observed result>' } })), concerns: [] }, null, 2) +
      '\nUse DONE_WITH_CONCERNS when applicable. Never report PASS for a check not run. Leave a clean worktree.\n', { flag: 'wx' });
    const pane = await allocatePane(call, { ...placement, parentPane, tab }, run.worktree_path, 'right');
    if (!pane?.pane_id || pane.tab_id !== tab) throw new Error('Unexpected created pane identity');
    saveAttempt(db,run,controller,'dispatching','UPDATE attempts SET pane_id=? WHERE id=?',pane.pane_id,id);
    let started;
    try {
      started = (await call('agent', 'start', name, '--kind', worker.kind, '--pane', pane.pane_id,
        '--timeout', '30000', '--', ...worker.args)).agent;
    } catch (error) {
      if (startupBlocked(error))
        saveAttempt(db,run,controller,'dispatching','UPDATE attempts SET status=? WHERE id=?','startup_blocked',id);
      throw error;
    }
    if (started?.name !== name || started.pane_id !== pane.pane_id ||
      started.tab_id !== tab || started.agent !== worker.kind ||
      !['idle', 'done'].includes(started.agent_status))
      throw new Error('Worker identity/readiness mismatch after start');
    saveAttempt(db,run,controller,'dispatching','UPDATE attempts SET status=? WHERE id=?','prompting',id);
    await call('agent', 'prompt', name, `Read ${dispatch} and follow it exactly.`);
    db.transaction(() => {
      owned(db, run.id, controller, 'dispatching');
      db.query('UPDATE attempts SET status=? WHERE id=?').run('submitted', id);
      db.query('UPDATE runs SET stage=?,updated_at=? WHERE id=?')
        .run('implementing', new Date().toISOString(), run.id);
    }).immediate();
    return { run: path, attempt_id: id, worker: name, pane: pane.pane_id, report };
  } catch (error) {
    if (attempted) db.query('UPDATE runs SET blocked_reason=? WHERE id=? AND controller_id=?')
      .run(`Dispatch unresolved; inspect before retry: ${String(error)}`, run.id,controller);
    throw error;
  } finally { db.close(); }
}

export async function acceptImplementation(runPath: string, controller: string, call: HerdrCall = herdr) {
  const { path, db, run } = openRun(runPath);
  try {
    owned(db, run.id, controller, 'implementing');
    const attempt = db.query('SELECT * FROM attempts WHERE run_id=? AND status=?').get(run.id, 'submitted') as any;
    if (!attempt) throw new Error('No submitted implementation');
    const config = JSON.parse(run.config_json);
    const agent = (await call('agent', 'get', attempt.worker_name)).agent;
    if (agent?.name !== attempt.worker_name || agent.pane_id !== attempt.pane_id ||
      agent.tab_id !== config.tab || agent.agent !== attempt.worker_kind ||
      !['done', 'idle'].includes(agent.agent_status)) throw new Error('Worker identity/readiness is not confirmed');
    if (dirty(run.worktree_path)) throw new Error('Working tree is not clean');
    const head = git(run.worktree_path, 'rev-parse', 'HEAD');
    checkCorrectionHead(path, run, attempt, head);
    const report = JSON.parse(readFileSync(attempt.report_path, 'utf8'));
    if (report.attempt_id !== attempt.id || report.base_sha !== run.base_sha || report.head_sha !== head)
      throw new Error('Report provenance does not match attempt and Git HEAD');
    if (!['DONE', 'DONE_WITH_CONCERNS'].includes(report.status)) throw new Error('Implementation not complete');
    strings(report.concerns, 'report.concerns');
    git(run.worktree_path, 'merge-base', '--is-ancestor', run.base_sha, head);
    if (attempt.action === 'repair') {
      git(run.worktree_path, 'merge-base', '--is-ancestor', attempt.base_sha, head);
      if (head === attempt.base_sha) throw new Error('Repair has no new commit');
    }
    const commits = git(run.worktree_path, 'rev-list', `${run.base_sha}..${head}`).split('\n').filter(Boolean);
    if (!commits.length) throw new Error('Implementation has no commits');
    const task = currentTaskInput(run, path);
    const allowed = (file: string) => task.allowedPaths.some((p: string) =>
      file === p.replace(/\/$/, '') || file.startsWith(p.replace(/\/$/, '') + '/'));
    for (const commit of commits) {
      const files = git(run.worktree_path, 'diff-tree', '--root', '-m', '--no-commit-id', '--name-only',
        '--no-renames', '-r', '-z', commit).split('\0').filter(Boolean);
      if (files.some(file => !allowed(file))) throw new Error('Commit changes files outside allowed scope');
      const message = git(run.worktree_path, 'show', '-s', '--format=%B', commit);
      validateDispatchedProvenance(message, commit, run, attempt);
      const validTrailer = config.trailer.includes('<agent display name>')
        ? /^Co-Authored-By: .+ <noreply@[^\s<>]+>$/m.test(message) : message.split('\n').includes(config.trailer);
      if (!validTrailer) throw new Error('Missing required commit trailer');
    }
    if (!Array.isArray(report.checks) || task.acceptance.some((r: string) =>
      !report.checks.some((c: any) => c?.requirement === r && c.status === 'PASS' &&
        typeof c.evidence?.command === 'string' && c.evidence.command.trim() &&
        typeof c.evidence?.result === 'string' && c.evidence.result.trim())))
      throw new Error('Required acceptance evidence is missing or not PASS');
    db.transaction(() => {
      owned(db, run.id, controller, 'implementing');
      if (dirty(run.worktree_path) || git(run.worktree_path, 'rev-parse', 'HEAD') !== head)
        throw new Error('Git state changed during acceptance');
      const now = new Date().toISOString();
      db.query('UPDATE attempts SET status=?,head_sha=?,finished_at=? WHERE id=?').run('accepted', head, now, attempt.id);
      db.query('UPDATE runs SET stage=?,accepted_head=?,updated_at=? WHERE id=?')
        .run('implementation_accepted', head, now, run.id);
    }).immediate();
    return { run: path, stage: 'implementation_accepted', head, commits, concerns: report.concerns };
  } finally { db.close(); }
}

if (import.meta.main) {
  try {
    const [command, path, flag, controller, ...extra] = process.argv.slice(2);
    if (command === 'register-plan' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(registerPlan(path, controller), null, 2));
    else if (command === 'amend-plan-scope' && path && flag === '--controller' && controller && extra.length === 2 && extra[0] === '--decision')
      console.log(JSON.stringify(await amendPlanScope(path, controller, extra[1]), null, 2));
    else if (command === 'plan-status' && path && !flag)
      console.log(JSON.stringify(planStatus(path), null, 2));
    else if (command === 'prepare-plan-final-review' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(preparePlanFinalReview(path, controller), null, 2));
    else if (command === 'take-over-plan' && path && flag === '--controller' && controller && extra.length === 2 && extra[0] === '--decision')
      console.log(JSON.stringify(await takeOverPlan(path, controller, extra[1]), null, 2));
    else if (command === 'prepare-next-run' && path && flag === '--controller' && controller &&
      extra.length === 4 && extra[0] === '--task' && extra[2] === '--input')
      console.log(JSON.stringify(prepareNextRun(path, controller, extra[1], extra[3]), null, 2));
    else if (command === 'register-task' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(registerTask(path, controller), null, 2));
    else if (command === 'register-final-review' && path === '--input' && flag && controller === '--controller' && extra.length === 1)
      console.log(JSON.stringify(registerFinalReview(flag, extra[0]), null, 2));
    else if (command === 'dispatch-final-review' && path && flag === '--controller' && controller &&
      (extra.length === 4 || (extra.length === 5 && extra[4] === '--reuse-pane')) && extra[0] === '--pane' && extra[2] === '--tab')
      console.log(JSON.stringify(await dispatchFinalReview(path, controller, extra[1], extra[3], herdr, extra[4] === '--reuse-pane'), null, 2));
    else if (command === 'dispatch-final-review' && path && flag === '--controller' && controller && extra.length === 2 && extra[0] === '--correct-report')
      console.log(JSON.stringify(await correctReport(path, controller, 'final_review', extra[1]), null, 2));
    else if (command === 'accept-final-review' && path && flag === '--controller' && controller &&
      (!extra.length || (extra.length === 2 && extra[0] === '--recovery-decision')))
      console.log(JSON.stringify(await acceptFinalReview(path, controller, herdr, extra[1]), null, 2));
    else if (['record-final-triage', 'complete-final-review'].includes(command!) && path && flag === '--controller' && controller && extra.length === 2 && extra[0] === '--decision')
      console.log(JSON.stringify(await (command === 'record-final-triage' ? recordFinalTriage : completeFinalReview)(path, controller, extra[1]), null, 2));
    else if (['dispatch-final-repair', 'dispatch-verification'].includes(command!) && path && flag === '--controller' && controller && extra.length === 2 && ['--correct-report', '--correct-commit'].includes(extra[0]))
      console.log(JSON.stringify(await correctReport(path, controller, command === 'dispatch-final-repair' ? 'final_repair' : 'verification', extra[1], herdr, extra[0] === '--correct-commit'), null, 2));
    else if (['dispatch-final-repair', 'dispatch-verification', 'accept-final-repair', 'accept-verification'].includes(command!) && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(await (command.startsWith('dispatch') ? dispatchFinalWork : acceptFinalWork)(path, controller, command.endsWith('repair') ? 'repair' : 'verification'), null, 2));
    else if (command === 'status' && path && !flag)
      console.log(JSON.stringify(status(path), null, 2));
    else if (command === 'resolve-no-launch' && path && flag === '--controller' && controller && extra.length === 2 && extra[0] === '--decision')
      console.log(JSON.stringify(await resolveNoLaunch(path, controller, extra[1]), null, 2));
    else if (['take-over','replace-worker'].includes(command!) && path && flag === '--controller' && controller &&
      extra.length === 2 && extra[0] === '--decision')
      console.log(JSON.stringify(await (command === 'take-over' ? takeOver : replaceWorker)(path,controller,extra[1]),null,2));
    else if (['dispatch-implementation', 'dispatch-review', 'dispatch-repair'].includes(command!) && path &&
      flag === '--controller' && controller && extra.length === 2 && ['--correct-report', '--correct-commit'].includes(extra[0]))
      console.log(JSON.stringify(await correctReport(path, controller,
        command === 'dispatch-review' ? 'review' : command === 'dispatch-repair' ? 'repair' : 'implementation', extra[1], herdr, extra[0] === '--correct-commit'), null, 2));
    else if (command === 'dispatch-implementation' && path && flag === '--controller' && controller &&
      (extra.length === 4 || (extra.length === 5 && extra[4] === '--reuse-pane') || (extra.length === 6 && extra[4] === '--startup-decision')) && extra[0] === '--pane' && extra[2] === '--tab')
      console.log(JSON.stringify(await dispatchImplementation(path, controller, extra[1], extra[3], herdr, extra[5], extra[4] === '--reuse-pane'), null, 2));
    else if (command === 'accept-implementation' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(await acceptImplementation(path, controller), null, 2));
    else if (command === 'dispatch-review' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(await dispatchReview(path, controller), null, 2));
    else if (command === 'accept-review' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(await acceptReview(path, controller), null, 2));
    else if (command === 'record-triage' && path && flag === '--controller' && controller && extra.length === 2 && extra[0] === '--decision')
      console.log(JSON.stringify(await recordTriage(path, controller, extra[1]), null, 2));
    else if (command === 'cleanup-workers' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(await cleanupWorkers(path, controller), null, 2));
    else if (command === 'dispatch-repair' && path && flag === '--controller' && controller && !extra.length)
      console.log(JSON.stringify(await dispatchRepair(path, controller), null, 2));
    else throw new Error('Usage: register-plan <plan.json> --controller <id> | plan-status <plan-path> | prepare-next-run <plan> --controller <id> --task <key> --input <task.json> | register-task <task.json> --controller <id> | status <run-path> | dispatch-implementation <run> --controller <id> --pane <id> --tab <id> | accept-implementation <run> --controller <id>');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
