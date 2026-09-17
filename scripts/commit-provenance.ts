// Commit metadata is worker-reported evidence, not authenticated model telemetry.
export function retainedRole(snapshot: any, previous: { worker_kind: string; model: string }) {
  // Never infer a historical worker's effort from today's tier configuration.
  return snapshot?.kind === previous.worker_kind && snapshot?.model === previous.model
    ? snapshot : { kind: previous.worker_kind, model: previous.model };
}

export function launchAttribution(worker: any = {}) {
  const args: string[] = worker.args ?? [];
  const option = (...names: string[]) => {
    let value: string | undefined;
    args.forEach((arg, index) => {
      if (names.includes(arg)) value = args[index + 1];
      for (const name of names) if (arg.startsWith(name + '=')) value = arg.slice(name.length + 1);
    });
    return value;
  };
  const model = option('-m', '--model') ?? worker.model ?? 'unknown';
  const configuredEffort = typeof worker.effort === 'string' && /^[a-z-]+$/.test(worker.effort)
    ? worker.effort : 'unknown';
  const codexEffort = args.flatMap((arg, index) => {
    const config = ['-c', '--config'].includes(arg) ? args[index + 1] :
      arg.startsWith('--config=') ? arg.slice(9) : '';
    const match = config?.match(/^model_reasoning_effort\s*=\s*["']?([a-z-]+)["']?$/);
    return match ? [match[1]] : [];
  }).at(-1);
  return {
    provider: worker.provider ?? (worker.kind === 'opencode' && model.includes('/') ? model.split('/')[0] : 'unknown'),
    model,
    effort: (worker.kind === 'codex' ? codexEffort : option('--effort', '--variant')) ?? configuredEffort,
    harness: worker.kind ?? 'unknown',
  };
}

export function provenanceInstructions(enabled: boolean, worker: unknown, base?: string): string {
  if (!enabled) return '';
  const values = launchAttribution(worker);
  return '\nEnd every new code commit with Agent and Co-Authored-By in one contiguous trailer block; no blank line between them:\n' +
    `Agent: provider=${values.provider}; model=${values.model}; effort=${values.effort}; harness=${values.harness}\n` +
    (base ? `Commit attribution: ${JSON.stringify({ base, values })}\n` : '') +
    'Use these launch values (explicit CLI selections take precedence), updated only by ' +
    'session evidence of a model switch or alias resolution. Use unknown only for unspecified ' +
    'values, never inferred defaults or remembered effort; not-applicable means no effort control. ' +
    'OpenCode is a harness, not a provider. Identify the executing worker in both trailers, ' +
    'not the Controller, and preserve existing commit attribution. This is attribution evidence, ' +
    'not authenticated runtime telemetry. ' +
    `Launch role: ${JSON.stringify(worker)}\n`;
}

export function validateProvenance(message: string, enabled: boolean, expected?: ReturnType<typeof launchAttribution>) {
  if (!enabled) return;
  // Require a trailing Git-trailer block rather than mentions in the prose body.
  const block = message.trim().split(/\n\s*\n/).at(-1)!;
  if (!/^Co-Authored-By: .+ <noreply@[^\s<>]+>$/m.test(block))
    throw new Error('Missing or invalid commit provenance: Co-Authored-By must share the final trailer block');
  const compact = block.split('\n').filter(line => line.startsWith('Agent:'));
  if (compact.length) {
    const value = '[A-Za-z0-9][A-Za-z0-9._/:+() -]*';
    if (compact.length !== 1 || /^Agent-(Provider|Model|Reasoning-Effort|Harness):/m.test(block) ||
        !new RegExp(`^Agent: provider=${value}; model=${value}; effort=${value}; harness=${value}$`).test(compact[0]))
      throw new Error('Missing or invalid commit provenance: Agent');
  } else {
    // Existing commits and in-flight dispatches may still use the original format.
    for (const key of ['Agent-Provider', 'Agent-Model', 'Agent-Reasoning-Effort', 'Agent-Harness']) {
      const entries = block.split('\n').filter(line => line.startsWith(`${key}:`));
      if (entries.length !== 1 || !new RegExp(`^${key}: [A-Za-z0-9][A-Za-z0-9._/:+() -]*$`).test(entries[0]))
        throw new Error(`Missing or invalid commit provenance: ${key}`);
    }
  }
  if (expected) {
    const keys = { provider: 'Agent-Provider', model: 'Agent-Model', effort: 'Agent-Reasoning-Effort', harness: 'Agent-Harness' };
    for (const key of Object.keys(keys) as (keyof typeof keys)[]) {
      const actual = compact.length ? compact[0].match(new RegExp(`${key}=([^;]+)`))?.[1] :
        block.match(new RegExp(`^${keys[key]}: (.+)$`, 'm'))?.[1];
      if (expected[key] !== 'unknown' && actual?.trim() === 'unknown')
        throw new Error(`Missing or invalid commit provenance: known ${key} recorded as unknown`);
    }
  }
}
