function terminalKey(sessionId: string, turnId: string, dispatchAttempt?: number): string {
  return `${sessionId}:${turnId}:${dispatchAttempt ?? 'generic'}`;
}

/** Bounded worker-local exactly-once gate for terminal IPC emission. */
export class TurnTerminalDeduper {
  private readonly emitted = new Set<string>();

  constructor(private readonly maxEntries = 4_096) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
  }

  /**
   * Claim one `(session, logical turn, dispatch attempt)` terminal. The first
   * caller wins regardless of status; transcript-final, submit-failure and CLI
   * exit races therefore emit one IPC message, never contradictory duplicates.
   */
  claim(sessionId: string, turnId: string, dispatchAttempt?: number): boolean {
    if (!sessionId || !turnId) return false;
    const key = terminalKey(sessionId, turnId, dispatchAttempt);
    if (this.emitted.has(key)) return false;
    this.emitted.add(key);
    if (this.emitted.size > this.maxEntries) {
      const oldest = this.emitted.values().next().value;
      if (oldest !== undefined) this.emitted.delete(oldest);
    }
    return true;
  }

  /** Whether this terminal was already claimed, without claiming it. */
  has(sessionId: string, turnId: string, dispatchAttempt?: number): boolean {
    return !!sessionId && !!turnId && this.emitted.has(terminalKey(sessionId, turnId, dispatchAttempt));
  }

  size(): number {
    return this.emitted.size;
  }
}
