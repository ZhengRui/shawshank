export type Wait = (ms: number) => Promise<unknown>;

// Readiness defaults to 30 observations, 100 ms apart; observation time is additional.
export async function waitFor<T>(read: () => Promise<T | undefined>, message: string,
  wait: Wait = ms => Bun.sleep(ms), attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    const result = await read();
    if (result !== undefined) return result;
    if (i + 1 < attempts) await wait(100);
  }
  throw new Error(message);
}

export class HerdrError extends Error {
  startupBlockedSafe = true;
  phase?: 'prelaunch' | 'session-create' | 'session-start';
  sessionID?: string;
  constructor(message: string, public code?: string, options?: ErrorOptions) { super(message, options); }
}

export function startupError(error: unknown, phase: NonNullable<HerdrError['phase']>, sessionID?: string) {
  if (error instanceof HerdrError && error.phase) return error;
  const label = phase === 'prelaunch' ? 'OpenCode pre-launch rejected' :
    `OpenCode ${phase} unresolved (${sessionID ?? 'ID unknown'})`;
  const wrapped = new HerdrError(`${label}; no task prompt was sent: ${String(error)}`,
    error instanceof HerdrError ? error.code : undefined, { cause: error });
  // Existing startup_blocked continuation does not revalidate V2 sessions.
  wrapped.startupBlockedSafe = false;
  wrapped.phase = phase;
  wrapped.sessionID = sessionID;
  return wrapped;
}

export function startupBlocked(error: unknown) {
  return error instanceof HerdrError && error.code === 'agent_not_ready' && error.startupBlockedSafe;
}
