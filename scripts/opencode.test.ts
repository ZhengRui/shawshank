import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { withOpenCodeStartupWait, HerdrError, startupBlocked } from './herdr';
import { v2Selection } from './opencode';

const cwd = realpathSync(import.meta.dir);
function fixture(options: { version?: string; badModel?: boolean; badHook?: boolean; busy?: boolean; apiFailure?: boolean; startFailure?: boolean;
  agentPatch?: any; readbackPatch?: any; missingHookReads?: number; unsettledReads?: number; pendingStatus?: string; missingTerminal?: boolean; startError?: Error; paneError?: Error } = {}) {
  const calls: string[][] = [];
  const api: string[][] = [];
  const pane = { pane_id: 'pane', tab_id: 'tab', terminal_id: 'terminal' };
  let session: any;
  let agentReads = 0;
  let paneReads = 0;
  const transport = withOpenCodeStartupWait(async (...args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') {
      if (options.paneError) throw options.paneError;
      return { pane: options.missingTerminal && ++paneReads <= 2 ? { ...pane, terminal_id: undefined } : pane };
    }
    if (args[1] === 'process-info') return { process_info: { pane_id: 'pane', shell_pid: 42,
      foreground_process_group_id: 42, foreground_processes: [{ pid: options.busy ? 43 : 42, argv0: 'zsh', cwd }] } };
    if (options.startFailure) throw new Error('startup timed out');
    if (options.startError) throw options.startError;
    agentReads++;
    return { agent: { ...pane, name: 'worker', agent: 'opencode', agent_status: 'idle', screen_detection_skipped: true,
      agent_session: { source: options.badHook ? 'screen' : 'herdr:opencode', kind: 'id', value: session.id },
      ...(agentReads <= (options.missingHookReads ?? 0) ? { agent_session: undefined, screen_detection_skipped: false,
        agent_status: options.pendingStatus ?? 'idle' } : {}),
      ...(agentReads <= (options.unsettledReads ?? 0) ? { agent_status: options.pendingStatus ?? 'working' } : {}),
      ...options.agentPatch } };
  }, async () => {}, async (args, directory) => {
    api.push(args);
    if (args[0] === '--version') return options.version ?? 'opencode v2.0.11';
    expect(directory).toBe(cwd);
    if (options.apiFailure) throw new Error('API timed out');
    if (args[1] === 'session.create') {
      const body = JSON.parse(args[3]);
      session = { id: 'ses_test', ...body };
    }
    return JSON.stringify({ data: options.badModel ? { ...session, model: { id: 'wrong' } } :
      { ...session, ...(args[1] === 'session.get' ? options.readbackPatch : {}) } });
  }, async (_raw, _args, cli) => ({ version: await cli(['--version']), cli }));
  return { calls, api, transport, start: ['agent', 'start', 'worker', '--kind', 'opencode', '--pane', 'pane', '--', '-m', 'vendor/model', '--variant', 'high'] };
}

test('V2 creates a selected session in the worker directory and starts full TUI without a prompt', async () => {
  const f = fixture();
  await f.transport(...f.start, '--auto');
  expect(f.calls.at(-1)).toEqual([...f.start.slice(0, 8), '--auto', '--session', 'ses_test']);
  const body = JSON.parse(f.api[1][3]);
  expect(body.model).toEqual({ providerID: 'vendor', id: 'model', variant: 'high' });
  expect(body.location).toEqual({ directory: cwd });
  expect(body.permissions).toBeUndefined();
  expect(f.api.at(-1)).toEqual(['api', 'session.get', '--param', 'sessionID=ses_test']);
  expect(f.calls.some(a => a[1] === 'prompt')).toBe(false);
});

test('V2 preserves defaults without claiming a fixed variant or adding permission flags', async () => {
  const f = fixture();
  await f.transport(...f.start.slice(0, 8));
  expect(JSON.parse(f.api[1][3]).model).toBeUndefined();
  expect(f.calls.at(-1)).toEqual([...f.start.slice(0, 8), '--session', 'ses_test']);
  expect(v2Selection(['-m', 'vendor/family/model']).model).toEqual({ providerID: 'vendor', id: 'family/model' });
  expect(v2Selection(['--model=vendor/model#high', '--agent', 'build']).model?.variant).toBe('high');
});

test('V2 rejects ambiguous arguments instead of falling back to Mini or another session', () => {
  for (const args of [['mini'], ['run'], ['--session', 'ses_old'], ['--continue'], ['--prompt', 'task'],
    ['--standalone'], ['--server', 'remote'], ['--variant', 'high'], ['-m'], ['-m', 'bare-model'],
    ['-m', 'v/m', '--model', 'v/n'], ['-m', 'v/m#low', '--variant', 'high'], ['-m', 'v/m#high#extra']]) {
    expect(() => v2Selection(args)).toThrow();
  }
});

test('missing hooks get bounded read-only polls; conflict never polls, relaunches or prompts', async () => {
  const delayed = fixture({ missingHookReads: 2 });
  const result = await delayed.transport(...delayed.start);
  expect(result.agent.agent_session.value).toBe('ses_test');
  expect(delayed.calls.filter(a => a[0] === 'agent' && a[1] === 'get')).toHaveLength(2);
  for (const options of [{ missingHookReads: Infinity }, { badHook: true }, { agentPatch: { terminal_id: 'other' } }]) {
    const f = fixture(options);
    await expect(f.transport(...f.start)).rejects.toThrow();
    expect(f.calls.filter(a => a[1] === 'start')).toHaveLength(1);
    expect(f.calls.filter(a => a[1] === 'prompt')).toHaveLength(0);
    expect(f.calls.filter(a => a[0] === 'agent' && a[1] === 'get')).toHaveLength(options.missingHookReads ? 29 : 0);
  }
});

test('transient statuses poll with missing or complete hooks but blocked and conflicts stop immediately', async () => {
  const identity = fixture({ missingTerminal: true });
  expect((await identity.transport(...identity.start)).agent.terminal_id).toBe('terminal');
  for (const pendingStatus of ['working', 'unknown']) {
    const f = fixture({ missingHookReads: 2, pendingStatus });
    await f.transport(...f.start);
    expect(f.calls.filter(a => a[1] === 'get' && a[0] === 'agent')).toHaveLength(2);
    const complete = fixture({ unsettledReads: 2, pendingStatus });
    expect((await complete.transport(...complete.start)).agent.agent_status).toBe('idle');
    expect(complete.calls.filter(a => a[1] === 'get' && a[0] === 'agent')).toHaveLength(2);
    expect(complete.calls.filter(a => a[1] === 'start')).toHaveLength(1);
    expect(complete.calls.filter(a => a[1] === 'prompt')).toHaveLength(0);
    expect(complete.api.filter(a => a[1] === 'session.get')).toHaveLength(1);
    const stuck = fixture({ agentPatch: { agent_status: pendingStatus } });
    await expect(stuck.transport(...stuck.start)).rejects.toThrow('settled status did not arrive');
    expect(stuck.calls.filter(a => a[1] === 'get' && a[0] === 'agent')).toHaveLength(29);
    expect(stuck.calls.filter(a => a[1] === 'start')).toHaveLength(1);
    expect(stuck.calls.filter(a => a[1] === 'prompt')).toHaveLength(0);
    expect(stuck.api.filter(a => a[1] === 'session.get')).toHaveLength(0);
  }
  for (const agentPatch of [{ agent_status: 'blocked' }, { agent_status: 'unexpected' }, { terminal_id: 'other' },
    { agent_session: { value: 'ses_other' } }]) {
    for (const missingHookReads of [0, 2]) {
      const f = fixture({ missingHookReads, unsettledReads: 2, pendingStatus: 'working', agentPatch });
      await expect(f.transport(...f.start)).rejects.toThrow();
      expect(f.calls.filter(a => a[1] === 'get' && a[0] === 'agent')).toHaveLength(0);
    }
  }
  const drift = fixture({ unsettledReads: 2, readbackPatch: { id: 'ses_other' } });
  await expect(drift.transport(...drift.start)).rejects.toThrow('session location or selection mismatch');
  expect(drift.api.filter(a => a[1] === 'session.get')).toHaveLength(1);
  expect(drift.calls.some(a => a[1] === 'prompt')).toBe(false);
});

test('transport errors retain code/cause and distinguish prelaunch, creation and startup', async () => {
  const original = new HerdrError('blocked', 'agent_not_ready');
  for (const [options, phase] of [[{ paneError: original }, 'prelaunch'], [{ apiFailure: true }, 'session-create'],
    [{ startError: original }, 'session-start']] as const) {
    const f = fixture(options);
    try { await f.transport(...f.start); throw new Error('accepted failure'); }
    catch (error: any) {
      expect(error.phase).toBe(phase);
      expect(startupBlocked(error)).toBe(false);
      if (phase !== 'session-create') { expect(error.code).toBe('agent_not_ready'); expect(error.cause).toBe(original); }
    }
  }
  const invalid = fixture();
  try { await invalid.transport(...invalid.start, '--continue'); throw new Error('accepted failure'); }
  catch (error: any) { expect(error.phase).toBe('prelaunch'); }
  expect(invalid.api.some(a => a[1] === 'session.create')).toBe(false);
});

test('V2 failures never submit a prompt or retry a session creation', async () => {
  for (const options of [{ badModel: true }, { badHook: true }, { busy: true }, { apiFailure: true }, { startFailure: true }, { version: '3.0.0' }]) {
    const f = fixture(options);
    await expect(f.transport(...f.start)).rejects.toThrow();
    expect(f.calls.some(a => a[1] === 'prompt')).toBe(false);
    expect(f.api.filter(a => a[1] === 'session.create').length).toBeLessThanOrEqual(1);
    if (options.badModel || options.busy || options.apiFailure || options.version)
      expect(f.calls.some(a => a[1] === 'start')).toBe(false);
  }
});

test('V2 rejects identity, readiness and selection drift after launch', async () => {
  const cases = [
    { agentPatch: { name: 'other' } }, { agentPatch: { agent: 'claude' } },
    { agentPatch: { pane_id: 'other' } }, { agentPatch: { tab_id: 'other' } },
    { agentPatch: { terminal_id: 'other' } }, { agentPatch: { agent_status: 'blocked' } },
    { agentPatch: { agent_session: { source: 'herdr:opencode', kind: 'id', value: 'ses_other' } } },
    { agentPatch: { screen_detection_skipped: false } },
    { readbackPatch: { id: 'ses_other' } }, { readbackPatch: { location: { directory: '/other' } } },
    { readbackPatch: { model: { providerID: 'vendor', id: 'model', variant: 'low' } } },
    { readbackPatch: { model: { providerID: 'other', id: 'model', variant: 'high' } } },
    { readbackPatch: { agent: 'other' } },
  ];
  for (const options of cases) {
    const f = fixture(options);
    await expect(f.transport(...f.start, '--agent', 'build')).rejects.toThrow();
    expect(f.calls.some(a => a[1] === 'prompt')).toBe(false);
    expect(f.api.filter(a => a[1] === 'session.create')).toHaveLength(1);
  }
});
