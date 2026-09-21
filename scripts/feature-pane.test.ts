import { test, expect } from 'bun:test';
import { realpathSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareShell, allocatePane, returnToShell } from './feature-pane';

function fixture() {
  const calls: string[][] = [];
  let cwd = realpathSync(tmpdir());
  let agent: string | undefined;
  let busy = false;
  const call = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') return { pane: { pane_id: 'root', tab_id: 'tab', terminal_id: 'terminal', agent } };
    if (args[1] === 'process-info') return { process_info: { pane_id: 'root', shell_pid: 42, foreground_process_group_id: busy ? 99 : 42,
      foreground_processes: [{ pid: busy ? 99 : 42, argv0: busy ? 'vim' : 'zsh', cwd }] } };
    if (args[1] === 'run') { cwd = realpathSync('.'); return { type: 'ok' }; }
    if (args[1] === 'split') return { pane: { pane_id: 'split', tab_id: 'tab' } };
    if (args[0] === 'agent' && args[1] === 'get') return { agent: { name: 'worker', pane_id: 'root', tab_id: 'tab', terminal_id: 'terminal', agent, agent_status: 'idle' } };
    if (args[1] === 'prompt' && args[3] === '/exit') { agent = undefined; return { type: 'ok' }; }
    throw new Error('Unexpected fixture call');
  };
  return { calls, call, agent: (value?: string) => { agent = value; }, busy: () => { busy = true; } };
}

test('reusable shell changes directory, while protected and busy panes reject without input', async () => {
  const f = fixture();
  await expect(prepareShell(f.call, 'root', 'tab', '.', 'root', async () => {})).rejects.toThrow('controller');
  expect(f.calls).toHaveLength(0);
  await prepareShell(f.call, 'root', 'tab', '.', 'controller', async () => {});
  expect(f.calls.filter(c => c[1] === 'run')).toHaveLength(1);
  f.busy();
  await expect(prepareShell(f.call, 'root', 'tab', '.', 'controller', async () => {})).rejects.toThrow('foreground');
  expect(f.calls.filter(c => c[1] === 'run')).toHaveLength(1);
});

test('occupied reusable pane splits; exiting its worker restores the same shell', async () => {
  const f = fixture();
  const config = { reusePane: true, parentPane: 'root', controllerPane: 'controller', tab: 'tab' };
  const attempt = { pane_id: 'root', worker_name: 'worker', worker_kind: 'opencode',
    dispatch_path: join(mkdtempSync(join(tmpdir(), 'shawshank-exit-')), 'dispatch.md') };
  f.agent('opencode');
  expect((await allocatePane(f.call, config, '.', 'right')).pane_id).toBe('split');
  await returnToShell(f.call, attempt, config, async () => {});
  expect(f.calls.filter(c => c[1] === 'prompt')).toHaveLength(1);
  expect(f.calls.some(c => c[1] === 'close')).toBe(false);
  await returnToShell(f.call, attempt, config, async () => {});
  expect(f.calls.filter(c => c[1] === 'prompt')).toHaveLength(1);
});

test('failed exit can retry after fresh identity checks; a lost receipt reconciles without input', async () => {
  for (const delivered of [false, true]) {
    const f = fixture(); f.agent('opencode');
    const attempt = { pane_id: 'root', worker_name: 'worker', worker_kind: 'opencode' };
    const config = { reusePane: true, parentPane: 'root', controllerPane: 'controller', tab: 'tab' };
    let prompts = 0;
    const call = async (...args: string[]) => {
      if (args[1] === 'prompt') {
        prompts++;
        if (prompts === 1) {
          if (delivered) await f.call(...args);
          throw new Error('Interrupted exit');
        }
      }
      return f.call(...args);
    };
    await expect(returnToShell(call, attempt, config, async () => {})).rejects.toThrow('Interrupted');
    await returnToShell(call, attempt, config, async () => {});
    expect(prompts).toBe(delivered ? 1 : 2);
  }
});

test('exit refuses a working or changed worker without sending input', async () => {
  for (const change of [{agent_status: 'working'}, {name: 'other'}, {terminal_id: 'other'}]) {
    const f = fixture(); f.agent('opencode');
    const call = async (...args: string[]) => {
      const result = await f.call(...args);
      return args[0] === 'agent' && args[1] === 'get' ? {agent: {...result.agent, ...change}} : result;
    };
    await expect(returnToShell(call, {pane_id:'root',worker_name:'worker',worker_kind:'opencode'},
      {reusePane:true,parentPane:'root',controllerPane:'controller',tab:'tab'}, async () => {})).rejects.toThrow('identity/readiness');
    expect(f.calls.some(c => c[1] === 'prompt')).toBe(false);
  }
});

test('directory hooks may finish before shell verification without repeating cd', async () => {
  const f = fixture();
  let hookRunning = false;
  const call = async (...args: string[]) => {
    if (args[1] === 'process-info' && hookRunning) {
      hookRunning = false;
      return { process_info: { pane_id: 'root', shell_pid: 42, foreground_process_group_id: 99,
        foreground_processes: [{ pid: 99, argv0: 'git', cwd: '.' }] } };
    }
    const result = await f.call(...args);
    if (args[1] === 'run') hookRunning = true;
    return result;
  };
  await prepareShell(call, 'root', 'tab', '.', 'controller', async () => {});
  expect(f.calls.filter(c => c[1] === 'run')).toHaveLength(1);
});

test('prepareShell retries an unlisted shell observation after cd without resending', async () => {
  const f = fixture();
  let afterCd = false, observations = 0;
  const call = async (...args: string[]) => {
    const result = await f.call(...args);
    if (args[1] === 'run') afterCd = true;
    if (args[1] === 'process-info' && afterCd && ++observations === 1)
      result.process_info.foreground_processes[0].argv0 = 'nu';
    return result;
  };
  await prepareShell(call, 'root', 'tab', '.', 'controller', async () => {});
  expect(observations).toBe(2);
  expect(f.calls.filter(c => c[1] === 'run')).toHaveLength(1);
});

test('exit waits for transient shell work but remains bounded without resending', async () => {
  for (const busyPolls of [2, 100]) {
    const f = fixture(); f.agent('opencode');
    let polls = 0, waits = 0;
    const call = async (...args: string[]) => {
      if (args[1] === 'process-info' && ++polls <= busyPolls)
        return {process_info:{pane_id:'root',shell_pid:42,foreground_process_group_id:99,
          foreground_processes:[{pid:99,argv0:'git'}]}};
      return f.call(...args);
    };
    const pending = returnToShell(call, {pane_id:'root',worker_name:'worker',worker_kind:'opencode'},
      {reusePane:true,parentPane:'root',controllerPane:'controller',tab:'tab'}, async () => { waits++; });
    if (busyPolls === 2) { await pending; expect(waits).toBe(3); }
    else { await expect(pending).rejects.toThrow('exit not confirmed'); expect(waits).toBe(60); }
    expect(f.calls.filter(c => c[1] === 'prompt')).toHaveLength(1);
    expect(f.calls.some(c => c[1] === 'close' || c[1] === 'run')).toBe(false);
  }
});

test('exit stops immediately when the pane changes during its wait', async () => {
  const f = fixture(); f.agent('opencode');
  let changed = false;
  const call = async (...args: string[]) => {
    const result = await f.call(...args);
    if (args[1] === 'prompt') changed = true;
    if (changed && args[0] === 'pane' && args[1] === 'get') result.pane.terminal_id = 'replacement';
    return result;
  };
  await expect(returnToShell(call,{pane_id:'root',worker_name:'worker',worker_kind:'opencode'},
    {reusePane:true,parentPane:'root',controllerPane:'controller',tab:'tab'},async()=>{})).rejects.toThrow('changed during exit');
  expect(f.calls.filter(c=>c[1]==='prompt')).toHaveLength(1);
});

test('non-OpenCode cleanup retries incomplete or unlisted argv0 without resending exit', async () => {
  for (const argv0 of [undefined, '', '-', 'nu']) {
    const f = fixture(); f.agent('codex');
    let reads = 0;
    const call = async (...args: string[]) => {
      const result = await f.call(...args);
      if (args[1] === 'process-info' && ++reads === 1) result.process_info.foreground_processes[0].argv0 = argv0;
      return result;
    };
    await returnToShell(call, { pane_id: 'root', worker_name: 'worker', worker_kind: 'codex' },
      { reusePane: true, parentPane: 'root', controllerPane: 'controller', tab: 'tab' }, async () => {});
    expect(reads).toBe(2);
    expect(f.calls.filter(c => c[1] === 'prompt')).toHaveLength(1);
  }
});
