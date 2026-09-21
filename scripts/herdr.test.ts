import { test, expect } from 'bun:test';
import { withOpenCodeStartupWait, HerdrError } from './herdr';

function fixture(kind = 'opencode', failUI = false, changed = false) {
  const calls: (string[] | number)[] = [];
  const agent = { name: 'worker', pane_id: 'pane', tab_id: 'tab', terminal_id: 'terminal', agent: kind, agent_status: 'idle' };
  const transport = withOpenCodeStartupWait(async (...args) => {
    calls.push(args);
    if (args[1] === 'wait-output' && failUI) throw new HerdrError('UI absent', 'timeout');
    return { agent: { ...agent, ...(changed && args[1] === 'get' ? { terminal_id: 'replacement' } : {}) } };
  }, async ms => { calls.push(ms); }, async () => '1.0.0',
  async (_raw, _args, cli) => ({ version: await cli(['--version']), cli }));
  return { calls, transport, start: ['agent', 'start', 'worker', '--kind', kind, '--pane', 'pane', '--'] };
}

test('OpenCode shows its input UI, waits three seconds, then returns for first task input', async () => {
  const f = fixture();
  await f.transport(...f.start);
  expect(f.calls).toEqual([
    f.start,
    ['pane', 'wait-output', 'pane', '--match', 'Ask anything', '--source', 'visible', '--lines', '200', '--timeout', '30000'],
    3000,
    ['agent', 'get', 'worker'],
  ]);
  const prompt = ['agent', 'prompt', 'worker', 'First task'];
  await f.transport(...prompt);
  expect(f.calls.at(-1)).toEqual(prompt);
  expect(f.calls.filter(c => Array.isArray(c) && c[1] === 'prompt')).toHaveLength(1);
});

test('missing input UI stops without waiting extra or sending a message', async () => {
  const f = fixture('opencode', true);
  await expect(f.transport(...f.start)).rejects.toThrow('no task prompt was sent');
  expect(f.calls).toHaveLength(2);
});

test('identity change during the grace period rejects startup', async () => {
  const f = fixture('opencode', false, true);
  await expect(f.transport(...f.start)).rejects.toThrow('Worker changed');
});

test('other worker kinds retain their original startup and prompt behavior', async () => {
  for (const kind of ['claude', 'codex']) {
    const f = fixture(kind);
    await f.transport(...f.start);
    const prompt = ['agent', 'prompt', 'worker', 'Task'];
    await f.transport(...prompt);
    expect(f.calls).toEqual([f.start, prompt]);
  }
});
