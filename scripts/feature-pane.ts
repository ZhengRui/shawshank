import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { HerdrCall } from './herdr';
import { waitFor, type Wait } from './startup';

export class ShellBusyError extends Error {}
export class UnsupportedShellError extends Error {}
export type ShellPin = { terminal_id?: string; shell_pid?: number };

// A reusable pane is explicitly assigned, never discovered by scanning user shells.
export async function shellPane(call: HerdrCall, paneId: string, tab: string, pin?: ShellPin) {
  const pane = (await call('pane', 'get', paneId)).pane;
  if (pane?.pane_id !== paneId || pane.tab_id !== tab) throw new Error('Reusable pane identity changed');
  if (pane.agent) throw new Error('Reusable pane is not an available shell');
  const info = (await call('pane', 'process-info', '--pane', paneId)).process_info;
  const processes = info?.foreground_processes;
  if (pin) {
    if ((pane.terminal_id && pin.terminal_id && pin.terminal_id !== pane.terminal_id) ||
        (info?.shell_pid && pin.shell_pid && pin.shell_pid !== info.shell_pid)) throw new Error('Shell identity changed');
    if (pane.terminal_id) pin.terminal_id = pane.terminal_id;
    if (info?.shell_pid) pin.shell_pid = info.shell_pid;
    if (!pane.terminal_id || !info?.shell_pid) throw new ShellBusyError('Shell identity is incomplete');
  }
  if (info?.pane_id !== paneId || !info.shell_pid || !Array.isArray(processes) || processes.length !== 1 ||
      processes[0].pid !== info.shell_pid || info.foreground_process_group_id !== info.shell_pid)
    throw new ShellBusyError('Reusable pane has a foreground command');
  const argv0 = processes[0].argv0;
  if (typeof argv0 !== 'string' || !argv0.trim() || !basename(argv0).replace(/^-/, ''))
    throw new ShellBusyError('Shell executable is incomplete');
  if (!['zsh', 'bash', 'sh', 'fish'].includes(basename(argv0).replace(/^-/, '')))
    throw new UnsupportedShellError(`Expected zsh/bash/sh/fish; observed ${argv0}`);
  return { pane, shell: processes[0] };
}

export function waitForShell(call: HerdrCall, paneId: string, tab: string, pin: ShellPin, wait?: Wait) {
  return waitFor(async () => {
    try { return await shellPane(call, paneId, tab, pin); }
    catch (error) { if (!(error instanceof ShellBusyError)) throw error; }
  }, 'Shell did not become ready; no worker started', wait);
}

export async function prepareShell(call: HerdrCall, paneId: string, tab: string, cwd: string,
  controllerPane: string, wait = (ms: number) => Bun.sleep(ms)) {
  if (!controllerPane || paneId === controllerPane) throw new Error('Cannot reuse the controller pane');
  const before = await shellPane(call, paneId, tab);
  const target = realpathSync(cwd);
  if (realpathSync(before.shell.cwd) === target) return before.pane;
  const quoted = `'${target.replaceAll("'", "'\\''")}'`;
  await call('pane', 'run', paneId, `cd -- ${quoted}`);
  for (let i = 0; i < 30; i++) {
    await wait(100);
    let current;
    try { current = await shellPane(call, paneId, tab); }
    catch (error) {
      // Directory-change hooks can briefly own the foreground. Do not resend cd.
      if (error instanceof ShellBusyError || error instanceof UnsupportedShellError) continue;
      throw error;
    }
    if (current.pane.terminal_id !== before.pane.terminal_id || current.shell.pid !== before.shell.pid)
      throw new Error('Shell identity changed while switching directory');
    if (realpathSync(current.shell.cwd) === target) return current.pane;
  }
  throw new Error('Reusable shell did not enter the target worktree; no worker started');
}

export async function allocatePane(call: HerdrCall, config: any, cwd: string, direction: string) {
  if (config.reusePane) {
    if (!config.controllerPane || config.parentPane === config.controllerPane || config.parentPane === process.env.HERDR_PANE_ID)
      throw new Error('Cannot reuse the controller pane');
    const pane = (await call('pane', 'get', config.parentPane)).pane;
    if (pane?.pane_id !== config.parentPane || pane.tab_id !== config.tab)
      throw new Error('Reusable pane identity changed');
    if (!pane?.agent) return prepareShell(call, config.parentPane, config.tab, cwd, config.controllerPane);
  }
  return (await call('pane', 'split', '--pane', config.parentPane, '--direction', direction,
    '--cwd', cwd, '--no-focus')).pane;
}

export async function returnToShell(call: HerdrCall, attempt: any, config: any,
  wait = (ms: number) => Bun.sleep(ms)) {
  if (!config.reusePane || attempt.pane_id !== config.parentPane ||
      attempt.pane_id === config.controllerPane || attempt.pane_id === process.env.HERDR_PANE_ID)
    throw new Error('Pane is not an authorized reusable worker pane');
  const pane = (await call('pane', 'get', attempt.pane_id)).pane;
  if (pane?.pane_id !== attempt.pane_id || pane.tab_id !== config.tab)
    throw new Error('Reusable pane identity changed');
  if (!pane?.agent) { await shellPane(call, attempt.pane_id, config.tab); return; }
  const agent = (await call('agent', 'get', attempt.worker_name)).agent;
  if (agent?.name !== attempt.worker_name || agent.pane_id !== attempt.pane_id ||
      agent.tab_id !== config.tab || agent.terminal_id !== pane.terminal_id ||
      agent.agent !== attempt.worker_kind || !['idle', 'done'].includes(agent.agent_status))
    throw new Error('Worker identity/readiness changed before exit');
  // Exit is retryable only after rechecking this settled named agent. Never send
  // raw pane input: an already-exited worker must not turn /exit into shell input.
  await call('agent', 'prompt', attempt.worker_name, '/exit');
  for (let i = 0; i < 60; i++) {
    await wait(250);
    const current = (await call('pane', 'get', attempt.pane_id)).pane;
    if (current?.pane_id !== attempt.pane_id || current?.terminal_id !== pane.terminal_id || current?.tab_id !== config.tab)
      throw new Error('Reusable pane changed during exit');
    if (!current.agent) {
      try {
        const settled = await shellPane(call, attempt.pane_id, config.tab);
        if (settled.pane.terminal_id !== pane.terminal_id) throw new Error('Reusable pane changed during exit');
        return;
      } catch (error) {
        // Agent detection can clear before process teardown or prompt hooks end.
        // Spend the existing bounded wait budget, without sending more input.
        if (!(error instanceof ShellBusyError || error instanceof UnsupportedShellError)) throw error;
      }
    }
  }
  throw new Error('Worker exit not confirmed; preserve pane and inspect before retry');
}
