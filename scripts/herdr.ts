// Explicit targets are required: the tool executor may not inherit pane context.
async function rawHerdr(...args: string[]): Promise<any> {
  const child = Bun.spawn(['herdr', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) {
    let errorCode: string | undefined;
    try { errorCode = JSON.parse(stderr || stdout).error?.code; } catch { /* Retain raw diagnostics. */ }
    throw new HerdrError(`Herdr ${args[0]} ${args[1]} failed: ${stderr || stdout}`, errorCode);
  }
  // pane run acknowledges delivery with exit status only; callers verify state.
  if (!stdout.trim() && args[0] === 'pane' && args[1] === 'run') return { type: 'ok' };
  const response = JSON.parse(stdout);
  if (!response.result || response.error) throw new Error(`Unexpected Herdr response: ${stdout}`);
  return response.result;
}

export class HerdrError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

export type HerdrCall = (...args: string[]) => Promise<any>;

// Only OpenCode needs a startup grace period after its input widget appears.
export function withOpenCodeStartupWait(raw: HerdrCall, wait = (ms: number) => Bun.sleep(ms)): HerdrCall {
  return async (...args) => {
    const result = await raw(...args);
    if (args[0] === 'agent' && args[1] === 'start' && args[args.indexOf('--kind') + 1] === 'opencode') {
      const before = result.agent;
      try {
        if (before?.name !== args[2] || before.agent !== 'opencode' ||
          before.pane_id !== args[args.indexOf('--pane') + 1]) throw new Error('Startup identity mismatch');
        await raw('pane', 'wait-output', before.pane_id, '--match', 'Ask anything',
          '--source', 'visible', '--lines', '200', '--timeout', '30000');
        await wait(3000);
        const after = (await raw('agent', 'get', args[2])).agent;
        if (!after || ['name', 'pane_id', 'tab_id', 'agent', 'terminal_id'].some(key => after[key] !== before[key]) ||
          !['idle', 'done'].includes(after.agent_status)) throw new Error('Worker changed or is not idle');
        return { ...result, agent: after };
      } catch (error) {
        throw new HerdrError(`OpenCode input UI not ready; no task prompt was sent: ${String(error)}`, 'agent_not_ready');
      }
    }
    return result;
  };
}

export const herdr: HerdrCall = withOpenCodeStartupWait(rawHerdr);
