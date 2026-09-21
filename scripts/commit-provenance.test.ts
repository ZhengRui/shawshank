import { expect, test } from 'bun:test';
import { launchAttribution, provenanceInstructions, validateProvenance, retainedRole } from './commit-provenance';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchImplementation, acceptImplementation, replaceWorker, correctReport } from './workflow';
import { HerdrError } from './herdr';

const trailers = 'Agent-Provider: deepseek\nAgent-Model: deepseek-flash\n' +
  'Agent-Reasoning-Effort: unknown\nAgent-Harness: opencode\n' +
  'Co-Authored-By: DeepSeek deepseek-flash <noreply@deepseek.com>';
const compact = 'Agent: provider=deepseek; model=deepseek/deepseek-flash; effort=unknown; harness=opencode\n' +
  'Co-Authored-By: DeepSeek deepseek-flash <noreply@deepseek.com>';

test('C1 separated attribution is rejected and contiguous trailers agree with Git', () => {
  const [agent, author] = compact.split('\n');
  for (const ending of [`${author}\n\n${agent}`, `${agent}\n\n${author}`]) {
    expect(() => validateProvenance(`Implement labels\n\n${ending}`, true)).toThrow('commit provenance');
  }
  for (const ending of [`${author}\n${agent}`, `${agent}\n${author}`]) {
    const message = `Implement labels\n\n${ending}`;
    expect(() => validateProvenance(message, true)).not.toThrow();
    const parsed = Bun.spawnSync(['git', 'interpret-trailers', '--parse'], { stdin: Buffer.from(message) });
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.toString()).toContain(author);
    expect(parsed.stdout.toString()).toContain(agent);
  }
});

test('launch values prefer CLI selections and preserve unknown defaults', () => {
  expect(launchAttribution({ kind: 'opencode', args: ['-m', 'vendor/model#high'] }))
    .toEqual({ provider: 'vendor', model: 'vendor/model#high', effort: 'unknown', harness: 'opencode' });
  expect(launchAttribution({ kind: 'codex', provider: 'openai', model: 'old', effort: 'low',
    args: ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="medium"'] })).toEqual({
      provider: 'openai', model: 'gpt-6-astra', effort: 'medium', harness: 'codex' });
  expect(launchAttribution({ kind: 'opencode', model: 'deepseek/deepseek-flash',
    effort: "high (opencode's remembered variant)", args: [] }).effort).toBe('unknown');
  expect(launchAttribution({ kind: 'claude', args: ['--model=opus', '--effort', 'high'] }))
    .toEqual({ provider: 'unknown', model: 'opus', effort: 'high', harness: 'claude' });
});

test('pre-version attribution preserves hash selectors and prefers explicit variant evidence', () => {
  for (const selector of ['vendor/model#high', 'vendor/model#high#extra']) {
    for (const role of [{ model: selector }, { args: ['-m', selector] }]) {
      const values = launchAttribution({ kind: 'opencode', ...role });
      expect(values.model).toBe(selector);
      expect(values.effort).toBe('unknown');
    }
  }
  const values = launchAttribution({ kind: 'opencode', args: ['-m', 'vendor/model#high', '--variant', 'high'] });
  expect(values.effort).toBe('high');
  expect(() => validateProvenance(compact.replace('model=deepseek/deepseek-flash', 'model=vendor/model#high'), true)).not.toThrow();
});

test('known launch values cannot be discarded but runtime alias resolution remains allowed', () => {
  const expected = launchAttribution({ kind: 'opencode', model: 'deepseek/deepseek-flash', args: ['--variant', 'high'] });
  expect(() => validateProvenance(compact, true, expected)).toThrow('known effort');
  expect(() => validateProvenance(compact.replace('effort=unknown', 'effort=high'), true, expected)).not.toThrow();
  expect(() => validateProvenance(trailers, true, expected)).toThrow('known effort');
  expect(() => validateProvenance(compact, true)).not.toThrow();
});

test('compact attribution accepts configured selectors and rejects malformed or mixed metadata', () => {
  expect(() => validateProvenance('Implement feature\n\n' + compact, true)).not.toThrow();
  for (const message of [compact.replace('; effort=unknown', ''),
    compact.replace('model=deepseek/deepseek-flash', 'model=<model>'),
    compact + '\n' + compact, compact + '\n' + trailers,
    compact + '\n\nBody text']) {
    expect(() => validateProvenance(message, true)).toThrow('commit provenance');
  }
});

test('retained attribution preserves launch settings and never borrows mismatched history', () => {
  const role = { kind: 'codex', model: 'fixture', provider: 'openai', effort: 'medium',
    args: ['-c', 'model_reasoning_effort=medium'] };
  const previous = { worker_kind: 'codex', model: 'fixture' };
  expect(retainedRole(role, previous)).toEqual(role);
  expect(retainedRole(undefined, previous)).toEqual({ kind: 'codex', model: 'fixture' });
  expect(retainedRole(role, { worker_kind: 'claude', model: 'opus' })).toEqual({ kind: 'claude', model: 'opus' });
});

test('provenance supports exact models and honest uncertainty without changing historical contracts', () => {
  expect(() => validateProvenance('fix: example\n\n' + trailers, true)).not.toThrow();
  expect(() => validateProvenance(trailers.replace('deepseek-flash', 'alias:opus'), true)).not.toThrow();
  expect(() => validateProvenance('legacy message', false)).not.toThrow();
  expect(provenanceInstructions(false, {})).toBe('');
  expect(provenanceInstructions(true, { model: 'gpt-6-astra', effort: 'medium' })).toContain('gpt-6-astra');
});

test('provenance rejects missing, duplicate, placeholder and prose-only fields', () => {
  for (const message of ['fix: missing', trailers.replace('Agent-Model: deepseek-flash\n', ''),
    trailers + '\nAgent-Model: other', trailers.replace('deepseek-flash', '<model>'),
    trailers + '\n\nThis is prose, not trailers.']) {
    expect(() => validateProvenance(message, true)).toThrow('commit provenance');
  }
});

for (const replacement of [false, true]) test(`known attribution gates new commits and preserves inherited history (replacement=${replacement})`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-provenance-')));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', root, ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = (message: string) => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message);
  };
  git('init', '-q');
  mkdirSync(join(root, '.shawshank'));
  writeFileSync(join(root, '.gitignore'), '.shawshank/runs/\n');
  writeFileSync(join(root, '.shawshank/config.json'), JSON.stringify({
    project: { commitProvenance: true, commitTrailer: 'Co-Authored-By: <agent display name> <noreply@<provider domain>>' },
    roles: { implementer: { standard: [{ kind: 'opencode', model: 'deepseek/deepseek-flash', args: ['--variant', 'high'] }] } },
  }));
  writeFileSync(join(root, 'brief.md'), 'Synthetic attribution fixture');
  writeFileSync(join(root, 'task.json'), JSON.stringify({ worktree: root, goal: 'Fixture', brief: 'brief.md',
    allowedPaths: ['sample.ts'], nonGoals: [], acceptance: ['fixture check'], dependencies: [],
    authorization: { source: 'Synthetic test', localCommits: true }, tier: 'standard' }));
  commit('Initialize fixture');
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'workflow.ts'), 'register-task',
    join(root, 'task.json'), '--controller', 'fixture']);
  expect(result.exitCode).toBe(0);
  const registered = JSON.parse(result.stdout.toString());
  let name = '';
  let pane = '';
  const closed = new Set<string>();
  const transport = async (...args: string[]): Promise<any> => {
    if (args[0] === 'pane') {
      if (args[1] === 'close') { closed.add(args[2]); return { type: 'ok' }; }
      if (args[1] === 'get' && closed.has(args[2])) throw new HerdrError('Absent fixture pane', 'pane_not_found');
      if (args[1] === 'split') pane = `worker-${closed.size}`;
      return { pane: { pane_id: args[1] === 'get' ? args[2] : pane, tab_id: 'test' } };
    }
    if (args[1] === 'start') name = args[2];
    return { agent: { name, pane_id: pane, tab_id: 'test', agent: 'opencode', agent_status: 'idle', cwd: root, foreground_cwd: root } };
  };
  let attempt = await dispatchImplementation(registered.run, 'fixture', 'parent', 'test', transport);
  const dispatch = readFileSync(join(registered.run, `${attempt.attempt_id}-dispatch.md`), 'utf8');
  expect(dispatch).toContain('Agent: provider=');
  expect(dispatch).toContain('deepseek/deepseek-flash');
  writeFileSync(join(root, 'sample.ts'), 'export const value = 1;\n');
  commit('Implement fixture\n\nCo-Authored-By: Fixture <noreply@example.invalid>');
  const report = () => writeFileSync(attempt.report, JSON.stringify({ attempt_id: attempt.attempt_id,
    base_sha: registered.base_sha, head_sha: git('rev-parse', 'HEAD'), status: 'DONE', concerns: [],
    checks: [{ requirement: 'fixture check', status: 'PASS', evidence: { command: 'synthetic', result: 'pass' } }] }));
  report();
  await expect(acceptImplementation(registered.run, 'fixture', transport)).rejects.toThrow('commit provenance');
  const [agent, author] = compact.replace('effort=unknown', 'effort=high').split('\n');
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--amend', '-qm', `Implement fixture\n\n${author}\n\n${agent}`);
  report();
  await expect(acceptImplementation(registered.run, 'fixture', transport)).rejects.toThrow('final trailer block');
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--amend', '-qm', 'Implement fixture\n\n' + compact);
  report();
  await expect(acceptImplementation(registered.run, 'fixture', transport)).rejects.toThrow('known effort');
  if (replacement) {
    const state = JSON.parse(Bun.spawnSync([process.execPath, join(import.meta.dir, 'workflow.ts'),
      'status', registered.run]).stdout.toString());
    const decision = join(registered.run, 'replacement.json');
    writeFileSync(decision, JSON.stringify({ previous_controller: 'fixture', stage: state.run.stage,
      attempt_id: attempt.attempt_id, head_sha: state.observed_head, worktree_fingerprint: state.worktree_fingerprint,
      previous_command_stopped: true, evidence: 'Fixture call returned', session_evidence: 'Same fixture transport',
      resolution: 'retain', worker_stopped: true, worker_stop_evidence: 'Idle fixture without background writers',
      partial_work: 'Preserve existing commit and its original unknown effort.' }));
    await replaceWorker(registered.run, 'fixture', decision, transport);
    const current = JSON.parse(Bun.spawnSync([process.execPath, join(import.meta.dir, 'workflow.ts'),
      'status', registered.run]).stdout.toString()).attempts.at(-1);
    attempt = { ...attempt, attempt_id: current.id, report: current.report_path };
    writeFileSync(join(root, 'sample.ts'), 'export const value = 2;\n');
    commit('Continue fixture\n\n' + compact);
    report();
    await expect(acceptImplementation(registered.run, 'fixture', transport)).rejects.toThrow('known effort');
  }
  if (!replacement) {
    const originalReport = attempt.report;
    const oldHead = git('rev-parse', 'HEAD');
    const decision = join(registered.run, 'commit-correction.json');
    writeFileSync(decision, JSON.stringify({ attempt_id: attempt.attempt_id, head_sha: oldHead,
      evidence: 'Acceptance rejected known effort', unpushed: true,
      unpushed_evidence: 'Disposable local fixture with no remote or push' }));
    git('update-ref', 'refs/remotes/fixture/main', oldHead);
    await expect(correctReport(registered.run, 'fixture', 'implementation', decision, transport, true)).rejects.toThrow('published');
    git('update-ref', '-d', 'refs/remotes/fixture/main');
    const correction = await correctReport(registered.run, 'fixture', 'implementation', decision, transport, true);
    attempt.report = correction.report;
    expect(readFileSync(originalReport, 'utf8')).toContain(oldHead);
    await expect(correctReport(registered.run, 'fixture', 'implementation', decision, transport, true)).rejects.toThrow('No report correction');
    writeFileSync(join(root, 'sample.ts'), 'export const value = 999;\n');
    git('add', 'sample.ts');
    git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
      'commit', '--amend', '-qm', 'Implement fixture\n\n' + compact.replace('effort=unknown', 'effort=high'));
    report();
    await expect(acceptImplementation(registered.run, 'fixture', transport)).rejects.toThrow('preserving tree');
    writeFileSync(join(root, 'sample.ts'), 'export const value = 1;\n');
    git('add', 'sample.ts');
  }
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--amend', '-qm', 'Implement fixture\n\n' + compact.replace('effort=unknown', 'effort=high'));
  report();
  expect((await acceptImplementation(registered.run, 'fixture', transport)).stage).toBe('implementation_accepted');
});
