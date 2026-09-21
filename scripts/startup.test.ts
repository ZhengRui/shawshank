import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { waitFor, HerdrError, startupError, startupBlocked } from './startup';
import { waitForShell, shellPane, ShellBusyError, UnsupportedShellError } from './feature-pane';
import { openCodeCLI, openCodeVersion, verifyOpenCodeInstallation } from './opencode';

const noWait = async () => {};

test('bounded wait retries only pending reads and propagates hard errors', async () => {
  let reads = 0;
  expect(await waitFor(async () => ++reads === 3 ? 'ready' : undefined, 'timeout', noWait)).toBe('ready');
  reads = 0;
  await expect(waitFor(async () => { reads++; return undefined; }, 'timeout', noWait, 3)).rejects.toThrow('timeout');
  expect(reads).toBe(3);
  const error = new Error('conflict');
  await expect(waitFor(async () => { throw error; }, 'timeout', noWait)).rejects.toBe(error);
});

test('structured startup failures preserve causes and codes without enabling legacy continuation', () => {
  const cause = new HerdrError('approval', 'agent_not_ready');
  expect(startupBlocked(cause)).toBe(true);
  for (const phase of ['prelaunch', 'session-create', 'session-start'] as const) {
    const error = startupError(cause, phase, 'ses_test');
    expect(error.code).toBe('agent_not_ready');
    expect(error.cause).toBe(cause);
    expect(error.phase).toBe(phase);
    expect(error.sessionID).toBe('ses_test');
    expect(startupBlocked(error)).toBe(false);
    expect(startupError(error, 'prelaunch')).toBe(error);
  }
});

function shellFixture(change?: 'terminal' | 'shell' | 'tab' | 'unsupported' | 'busy') {
  let reads = 0;
  return {
    get reads() { return reads; },
    raw: async (...args: string[]) => {
      if (args[1] === 'get') return { pane: { pane_id: 'pane', tab_id: change === 'tab' && reads ? 'other' : 'tab',
        terminal_id: change === 'terminal' && reads ? 'other' : 'terminal' } };
      reads++;
      const pid = change === 'shell' && reads > 1 ? 43 : 42;
      const busy = reads === 1 || change === 'busy';
      return { process_info: { pane_id: 'pane', shell_pid: pid, foreground_process_group_id: busy ? 99 : pid,
        foreground_processes: [{ pid: busy ? 99 : pid, argv0: change === 'unsupported' ? 'nu' : 'zsh', cwd: tmpdir() }] } };
    },
  };
}

test('shell readiness waits for rc activity, pins identity, and distinguishes unsupported shells', async () => {
  const f = shellFixture();
  expect((await waitForShell(f.raw, 'pane', 'tab', {}, noWait)).shell.pid).toBe(42);
  expect(f.reads).toBe(2);
  for (const change of ['terminal', 'shell', 'tab', 'unsupported', 'busy'] as const) {
    const f = shellFixture(change);
    const promise = waitForShell(f.raw, 'pane', 'tab', {}, noWait);
    if (change === 'unsupported') await expect(promise).rejects.toBeInstanceOf(UnsupportedShellError);
    else await expect(promise).rejects.toThrow();
    expect(f.reads).toBeLessThanOrEqual(change === 'busy' ? 30 : 2);
  }
});

test('shell observations pin fields independently and tolerate incomplete executable evidence', async () => {
  for (const conflict of [false, true]) {
    let reads = 0;
    const pin = {};
    const raw = async (...args: string[]) => {
      if (args[1] === 'get') return { pane: { pane_id: 'p', tab_id: 't', terminal_id: reads ? 'terminal' : undefined } };
      reads++;
      const pid = conflict && reads > 1 ? 43 : 42;
      return { process_info: { pane_id: 'p', shell_pid: reads === 2 && !conflict ? undefined : pid,
        foreground_process_group_id: pid, foreground_processes: [{ pid, argv0: reads < 4 ? undefined : 'zsh' }] } };
    };
    const result = waitForShell(raw, 'p', 't', pin, noWait);
    if (conflict) { await expect(result).rejects.toThrow('identity changed'); expect(reads).toBe(2); }
    else { await result; expect(reads).toBe(4); expect(pin).toEqual({ terminal_id: 'terminal', shell_pid: 42 }); }
  }
  for (const argv0 of [undefined, '', '-', 'nu']) {
    const raw = async (...args: string[]) => args[1] === 'get'
      ? { pane: { pane_id: 'p', tab_id: 't', terminal_id: 'terminal' } }
      : { process_info: { pane_id: 'p', shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42, argv0 }] } };
    await expect(shellPane(raw, 'p', 't')).rejects.toBeInstanceOf(argv0 === 'nu' ? UnsupportedShellError : ShellBusyError);
    await expect(shellPane(raw, 'p', 't', {})).rejects.toBeInstanceOf(argv0 === 'nu' ? UnsupportedShellError : ShellBusyError);
  }
});

test('probe receipt is retained only after sending was attempted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'probe-test-'));
  writeFileSync(join(directory, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = directory;
  try {
    for (const sent of [false, true]) {
      const before = new Set(readdirSync(tmpdir()).filter(n => n.startsWith('shawshank-opencode-probe-')));
      let reads = 0;
      const raw = async (...args: string[]) => {
        if (args[1] === 'get') return { pane: { pane_id: 'p', tab_id: 't', terminal_id: 'terminal' } };
        if (args[1] === 'run') throw new Error('delivery uncertain');
        if (++reads === 2 && !sent) throw new Error('pre-send failure');
        return { process_info: { pane_id: 'p', shell_pid: 42, foreground_process_group_id: 42,
          foreground_processes: [{ pid: 42, argv0: 'zsh', cwd: directory }] } };
      };
      try { await verifyOpenCodeInstallation(raw, ['--pane', 'p'], async () => '2.0.11', noWait); throw new Error('unexpected success'); }
      catch (error: any) { expect(error.message.includes('retained probe receipt')).toBe(sent); }
      const retained = readdirSync(tmpdir()).filter(n => n.startsWith('shawshank-opencode-probe-') && !before.has(n));
      expect(retained).toHaveLength(sent ? 1 : 0);
      for (const name of retained) { expect(existsSync(join(tmpdir(), name))).toBe(true); rmSync(join(tmpdir(), name), { recursive: true }); }
    }
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(directory, { recursive: true });
  }
});

test('probe waits beyond shell readiness budget and remains bounded without resending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'probe-budget-test-'));
  const executable = join(directory, 'opencode');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = directory;
  try {
    for (const completeAfter of [40, Infinity]) {
      let receipt = '', marker = '', waits = 0, sends = 0;
      const raw = async (...args: string[]) => {
        if (args[1] === 'get') return { pane: { pane_id: 'p', tab_id: 't', terminal_id: 'terminal' } };
        if (args[1] === 'run') {
          sends++;
          receipt = args[3].match(/> '([^']+)'/)![1];
          marker = args[3].match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)![0];
          return {};
        }
        return { process_info: { pane_id: 'p', shell_pid: 42, foreground_process_group_id: 42,
          foreground_processes: [{ pid: 42, argv0: 'zsh', cwd: directory }] } };
      };
      const wait = async (ms: number) => {
        expect(ms).toBe(100);
        if (++waits === completeAfter) writeFileSync(receipt, `${executable}\n2.0.11\n${marker}\n`);
      };
      const pending = verifyOpenCodeInstallation(raw, ['--pane', 'p'], async () => '2.0.11', wait);
      if (completeAfter === 40) {
        await pending;
        expect(waits).toBe(40);
        expect(existsSync(dirname(receipt))).toBe(false);
      } else {
        await expect(pending).rejects.toThrow('retained probe receipt');
        expect(waits).toBe(300);
        expect(existsSync(dirname(receipt))).toBe(true);
        rmSync(dirname(receipt), { recursive: true });
      }
      expect(sends).toBe(1);
    }
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(directory, { recursive: true });
  }
});

test('probe tolerates its own agent detection only until the bounded plain-shell confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'probe-detection-test-'));
  const executable = join(directory, 'opencode');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = directory;
  try {
    for (const scenario of ['transient', 'lingering', 'other-receipt', 'other-shell', 'terminal-receipt',
      'terminal-shell', 'tab-shell', 'pane-shell', 'pid-shell', 'preexisting']) {
      let sends = 0, observations = 0, waits = 0, receipt = '';
      const raw = async (...args: string[]) => {
        if (args[1] === 'get') {
          if (sends) observations++;
          const final = observations > 1;
          const pane: any = { pane_id: 'p', tab_id: 't', terminal_id: 'terminal' };
          if (scenario === 'preexisting' || (sends && (observations <= 3 || scenario === 'lingering'))) pane.agent = 'opencode';
          if ((scenario === 'other-receipt' && sends) || (scenario === 'other-shell' && final)) pane.agent = 'claude';
          if ((scenario === 'terminal-receipt' && sends) || (scenario === 'terminal-shell' && final)) pane.terminal_id = 'other';
          if (scenario === 'tab-shell' && final) pane.tab_id = 'other';
          if (scenario === 'pane-shell' && final) pane.pane_id = 'other';
          return { pane };
        }
        if (args[1] === 'run') {
          sends++;
          receipt = args[3].match(/> '([^']+)'/)![1];
          const marker = args[3].match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)![0];
          writeFileSync(receipt, `${executable}\n2.0.11\n${marker}\n`);
          return {};
        }
        const pid = sends && scenario === 'pid-shell' ? 43 : 42;
        return { process_info: { pane_id: 'p', shell_pid: pid, foreground_process_group_id: pid,
          foreground_processes: [{ pid, argv0: 'zsh', cwd: directory }] } };
      };
      try {
        const pending = verifyOpenCodeInstallation(raw, ['--pane', 'p'], async () => '2.0.11', async () => { waits++; });
        if (scenario === 'transient') {
          await pending;
          expect(observations).toBe(4);
          expect(waits).toBe(2);
        } else {
          await expect(pending).rejects.toThrow();
          if (scenario === 'lingering') { expect(observations).toBe(31); expect(waits).toBe(29); }
          else if (scenario !== 'pid-shell') expect(waits).toBe(0);
        }
        expect(sends).toBe(scenario === 'preexisting' ? 0 : 1);
      } finally {
        if (receipt && existsSync(dirname(receipt))) rmSync(dirname(receipt), { recursive: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(directory, { recursive: true });
  }
});

test('version parsing uses the last nonempty line, accepts prereleases, and fails closed with raw output', () => {
  for (const value of ['2.0.11', 'v2.0.11', 'notice\nopencode v2.0.11\n\n'])
    expect(openCodeVersion(value)).toEqual({ major: 2, version: '2.0.11' });
  expect(openCodeVersion('banner\n1.2.3-dev.4+build.5').major).toBe(1);
  for (const output of ['0.9.0', '3.0.0', 'dev', '2.0.11\nunrecognized footer', '2.x.y']) {
    try { openCodeVersion(output); throw new Error('accepted unsupported version'); }
    catch (error: any) { expect(error.message).toContain(output); expect(error.message).toContain('Unsupported'); }
  }
});

test('installation probe verifies the pane executable/version and pins subsequent CLI calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shawshank-install-test-'));
  const executable = join(directory, 'opencode');
  writeFileSync(executable, '#!/bin/sh\nprintf "opencode v2.0.11\\n"\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = directory;
  try {
    for (const scenario of ['same', 'real', 'path', 'version', 'alias', 'missing'] as const) {
      let submissions = 0;
      const invoked: (string | undefined)[] = [];
      const raw = async (...args: string[]) => {
        if (args[1] === 'get') return { pane: { pane_id: 'pane', tab_id: 'tab', terminal_id: 'terminal' } };
        if (args[1] === 'process-info') return { process_info: { pane_id: 'pane', shell_pid: 42, foreground_process_group_id: 42,
          foreground_processes: [{ pid: 42, argv0: 'zsh', cwd: directory }] } };
        expect(args.slice(0, 3)).toEqual(['pane', 'run', 'pane']);
        submissions++;
        if (scenario === 'real') {
          const child = Bun.spawn(['/bin/sh', '-c', args[3]], { env: { ...process.env, PATH: directory }, stdout: 'pipe', stderr: 'pipe' });
          expect(await child.exited).toBe(0);
          return {};
        }
        const receipt = args[3].match(/> '([^']+)'/)![1];
        const marker = args[3].match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)![0];
        const path = scenario === 'path' ? process.execPath : scenario === 'alias' ? 'opencode is an alias' : executable;
        writeFileSync(receipt, `${path}\n${scenario === 'version' ? '2.0.12' : 'opencode v2.0.11'}\n${marker}\n`);
        return {};
      };
      const cli = async (args: string[], cwd?: string, path?: string) => {
        invoked.push(path);
        return scenario === 'real' ? openCodeCLI(args, cwd, path) : 'opencode v2.0.11';
      };
      if (scenario === 'missing') process.env.PATH = '/nonexistent-shawshank-path';
      const promise = verifyOpenCodeInstallation(raw, ['agent', 'start', 'worker', '--pane', 'pane'], cli, noWait);
      if (scenario === 'same' || scenario === 'real') {
        const result = await promise;
        await result.cli(['api', 'session.get']);
        expect(invoked.map(p => realpathSync(p!))).toEqual([realpathSync(executable), realpathSync(executable)]);
      } else await expect(promise).rejects.toThrow();
      expect(submissions).toBe(scenario === 'missing' ? 0 : 1);
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(directory, { recursive: true });
  }
});
