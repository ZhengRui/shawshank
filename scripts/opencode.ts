import { realpathSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { HerdrCall } from './herdr';
import { waitForShell, ShellBusyError } from './feature-pane';
import { waitFor, startupError, type Wait } from './startup';

export type OpenCodeCLI = (args: string[], cwd?: string, executable?: string) => Promise<string>;

export function isOpenCodeSessionID(value: unknown): value is string {
  return typeof value === 'string' && /^ses\S+$/.test(value);
}

export const openCodeCLI: OpenCodeCLI = async (args, cwd, executable = 'opencode') => {
  const child = Bun.spawn([executable, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`OpenCode ${args[0]} failed: ${err || out}`);
  return out.trim();
};

export function openCodeVersion(output: string) {
  const line = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean).at(-1);
  const match = line?.match(/^(?:opencode\s+)?v?([12])\.(\d+)\.(\d+)((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (!match) throw new Error(`Unsupported OpenCode version (0.x and unknown builds are unsupported): ${output}`);
  return { major: Number(match[1]), version: `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}` };
}

export type InstallationProbe = (raw: HerdrCall, args: string[], cli: OpenCodeCLI, wait: Wait) =>
  Promise<{ version: string; cli: OpenCodeCLI }>;

export const verifyOpenCodeInstallation: InstallationProbe = async (raw, args, cli, wait) => {
  const executable = Bun.which('opencode', { PATH: process.env.PATH });
  if (!executable) throw new Error('OpenCode is absent from the controller PATH; cannot verify pane equivalence');
  const paneId = args[args.indexOf('--pane') + 1];
  const pane = (await raw('pane', 'get', paneId)).pane;
  const pin = { terminal_id: pane?.terminal_id };
  const before = await waitForShell(raw, paneId, pane?.tab_id, pin, wait);
  const cwd = realpathSync(before.shell.cwd);
  const version = await cli(['--version'], cwd, executable);
  const expected = openCodeVersion(version);
  const directory = mkdtempSync(join(tmpdir(), 'shawshank-opencode-probe-'));
  const receipt = join(directory, 'receipt');
  const marker = crypto.randomUUID();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  let complete = false;
  let sent = false;
  const checkProbePane = (value: any) => {
    if (value?.pane_id !== paneId || value.terminal_id !== pin.terminal_id || value.tab_id !== pane.tab_id ||
        (value.agent && value.agent !== 'opencode')) throw new Error('Pane identity changed during executable probe');
  };
  try {
    const current = await waitForShell(raw, paneId, pane.tab_id, pin, wait);
    if (realpathSync(current.shell.cwd) !== cwd) throw new Error('Shell directory changed before executable probe');
    // Run once in the actual interactive shell: detect aliases as well as PATH differences.
    sent = true;
    await raw('pane', 'run', paneId, `command -v opencode > ${quote(receipt)}; opencode --version >> ${quote(receipt)}; printf '\\n${marker}\\n' >> ${quote(receipt)}`);
    // 301 observations at 100 ms match the CLI's 30-second version budget.
    const output = await waitFor(async () => {
      checkProbePane((await raw('pane', 'get', paneId)).pane);
      let text: string;
      try { text = readFileSync(receipt, 'utf8'); }
      catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
      if (text.trimEnd().endsWith(marker)) { complete = true; return text.trimEnd().slice(0, -marker.length).trimEnd(); }
    }, `OpenCode pane probe unresolved; inspect ${receipt} before retry`, wait, 301);
    const after = await waitForShell(async (...args) => {
      const result = await raw(...args);
      if (args[0] === 'pane' && args[1] === 'get') {
        checkProbePane(result.pane);
        // Detection can outlive this probe's short-lived OpenCode process.
        if (result.pane.agent === 'opencode') throw new ShellBusyError('Probe agent detection has not cleared');
      }
      return result;
    }, paneId, pane.tab_id, pin, wait);
    if (realpathSync(after.shell.cwd) !== cwd) throw new Error('Shell directory changed during executable probe');
    const [path, ...lines] = output.split(/\r?\n/);
    if (!isAbsolute(path) || realpathSync(path) !== realpathSync(executable) ||
        openCodeVersion(lines.join('\n')).version !== expected.version)
      throw new Error(`Controller/pane OpenCode executable or version mismatch: controller=${executable}; pane=${output}`);
    return { version, cli: (args, directory) => cli(args, directory, executable) };
  } catch (error) {
    const failure = startupError(error, 'prelaunch');
    if (sent && !complete) failure.message += `; retained probe receipt: ${receipt}; inspect before retry`;
    throw failure;
  } finally {
    // A timed-out probe may still be writing; keep its receipt for reconciliation.
    if (!sent || complete) rmSync(directory, { recursive: true });
  }
};

// Selection flags form Shawshank's cross-version launch contract. V2 moved
// selection to sessions; permission flags are never synthesized.
export function v2Selection(args: string[]) {
  const values = new Map<string, string>();
  const native: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, ...suffix] = args[i].split('=');
    if (['-m', '--model', '--variant', '--agent'].includes(flag)) {
      const key = flag === '-m' ? '--model' : flag;
      const value = suffix.length ? suffix.join('=') : args[++i];
      if (!value || value.startsWith('-') || values.has(key)) throw new Error(`Invalid or duplicate ${key}`);
      values.set(key, value);
    } else if (args[i] === '--auto' && !native.includes('--auto')) native.push(args[i]);
    else throw new Error(`Unsupported OpenCode V2 launch argument: ${args[i]}. Use a fresh full TUI session.`);
  }
  const selector = values.get('--model');
  const match = selector?.match(/^([^/\s#]+)\/([^\s#]+)(?:#([^\s#]+))?$/);
  if (selector && !match) throw new Error('OpenCode model must be provider/model[#variant]');
  const variant = values.get('--variant') ?? match?.[3];
  if (variant && !match) throw new Error('OpenCode --variant requires an explicit model');
  if (match?.[3] && values.has('--variant') && match[3] !== variant) throw new Error('Conflicting OpenCode variants');
  return {
    native,
    agent: values.get('--agent'),
    model: match ? { providerID: match[1], id: match[2], ...(variant ? { variant } : {}) } : undefined,
  };
}

export async function prepareOpenCodeV2(raw: HerdrCall, args: string[], cli: OpenCodeCLI, wait?: Wait) {
  const separator = args.indexOf('--');
  if (separator < 0) throw new Error('Missing worker argument separator');
  const selection = v2Selection(args.slice(separator + 1));
  const paneId = args[args.indexOf('--pane') + 1];
  const initial = (await raw('pane', 'get', paneId)).pane;
  const { pane, shell } = await waitForShell(raw, paneId, initial?.tab_id, { terminal_id: initial?.terminal_id }, wait);
  const cwd = realpathSync(shell.cwd);
  let sessionID: string | undefined;
  const api = async (operation: string, ...options: string[]) =>
    JSON.parse(await cli(['api', operation, ...options], cwd)).data;
  const check = (session: any) => {
    if (!isOpenCodeSessionID(session?.id) || (sessionID && session.id !== sessionID) ||
        session.location?.directory !== cwd ||
        (selection.agent && session.agent !== selection.agent) ||
        (selection.model && (session.model?.providerID !== selection.model.providerID ||
          session.model?.id !== selection.model.id ||
          (selection.model.variant && session.model?.variant !== selection.model.variant))))
      throw new Error('OpenCode session location or selection mismatch');
  };
  try {
    const session = await api('session.create', '--data', JSON.stringify({
      title: `Shawshank ${args[2]}`, location: { directory: cwd },
      model: selection.model, agent: selection.agent,
    }));
    sessionID = session?.id;
    check(session);
    return {
      args: [...args.slice(0, separator + 1), ...selection.native, '--session', sessionID!],
      async verify(agent: any) {
        try {
          let current = agent;
          const ready = await waitFor(async () => {
            const observed = current;
            current = undefined;
            const value = observed ?? (await raw('agent', 'get', args[2])).agent;
            if (value?.name !== args[2] || value.agent !== 'opencode' || value.pane_id !== paneId ||
                value.tab_id !== pane.tab_id || value.terminal_id !== pane.terminal_id)
              throw new Error('OpenCode worker identity changed');
            const hook = value.agent_session;
            if (hook && ((hook.source !== undefined && hook.source !== 'herdr:opencode') ||
                (hook.kind !== undefined && hook.kind !== 'id') ||
                (hook.value !== undefined && hook.value !== sessionID))) throw new Error('OpenCode session identity changed');
            const missing = !hook?.source || !hook?.kind || !hook?.value || value.screen_detection_skipped !== true;
            if (['working', 'unknown'].includes(value.agent_status)) return;
            if (!['idle', 'done'].includes(value.agent_status)) throw new Error('OpenCode worker is not settled');
            if (missing) return;
            return value;
          }, 'OpenCode full-TUI lifecycle evidence or settled status did not arrive', wait);
          check(await api('session.get', '--param', `sessionID=${sessionID}`));
          return ready;
        } catch (error) { throw startupError(error, 'session-start', sessionID); }
      },
      sessionID,
    };
  } catch (error) {
    // No retry: an API timeout may already have created the session.
    throw startupError(error, 'session-create', sessionID);
  }
}
