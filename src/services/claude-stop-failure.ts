/**
 * Claude Code `StopFailure` hook: structured evidence that a turn ended on an
 * API error.
 *
 * When a turn hits a terminal API error — "API Error: Connection lost
 * mid-response.", a 5xx after Claude's own retries, an auth failure — Claude
 * Code ends it through a path that runs `StopFailure` hooks and never `Stop`
 * hooks. Verified on Claude Code 2.1.296 against a local API that drops the
 * stream after one complete content block: the TUI rendered the error,
 * `StopFailure` fired with `error:"server_error"`, `Stop` did not, and the
 * transcript gained the API-error record plus `system/turn_duration`.
 *
 * Botmux settles Claude turns from that transcript. When the bridge has lost
 * the running turn (it reads a transcript Claude no longer writes, or another
 * edge already closed the turn), the failure settles nothing: no automatic
 * continuation, no failure card, and the chat waits on a stopped task. The
 * hook closes that gap as a fallback only — the worker gives the transcript a
 * grace period to surface the failure; if it did not, the worker settles the
 * turn that was running (so the daemon continues or reports it like any other
 * failed turn), or, when no open turn is left to settle, posts a plain notice.
 *
 * `error` is the same field Claude writes on the transcript's API-error
 * record, so the outcome reuses the transcript classifier: both paths turn
 * one failure into the same terminal.
 *
 * Pure (no fs / IPC / timers).
 */
import { classifyClaudeTerminalEvent, type ClaudeTerminalOutcome } from './claude-transcript.js';

/** How long the transcript path gets to settle the failed turn before the
 *  hook settles it. Claude writes the API-error record before it runs the
 *  hook and `turn_duration` right after it; the watcher reads both within a
 *  poll tick or two, so this only delays the fallback case. */
export const CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS = 5_000;

export interface ClaudeStopFailureReport {
  /** Claude's machine error type: `server_error`, `overloaded`, `rate_limit`,
   *  `authentication_failed`, `invalid_request`, … */
  error: string;
  /** The rendered error line (`API Error: …`). */
  lastAssistantMessage?: string;
  errorDetails?: string;
  /** Claude-native session id of the CLI that ran the hook. */
  cliSessionId?: string;
  /** Transcript the CLI that ran the hook writes. */
  transcriptPath?: string;
  /** `CLAUDE_PID` of the CLI that ran the hook. */
  claudePid?: number;
}

const MAX_ERROR_LENGTH = 64;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 4_096;

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function buildReport(fields: {
  error: unknown;
  lastAssistantMessage: unknown;
  errorDetails: unknown;
  cliSessionId: unknown;
  transcriptPath: unknown;
  claudePid: unknown;
}): ClaudeStopFailureReport | undefined {
  const error = boundedString(fields.error, MAX_ERROR_LENGTH);
  if (!error) return undefined;
  const report: ClaudeStopFailureReport = { error };
  const lastAssistantMessage = boundedString(fields.lastAssistantMessage, MAX_TEXT_LENGTH);
  if (lastAssistantMessage) report.lastAssistantMessage = lastAssistantMessage;
  const errorDetails = boundedString(fields.errorDetails, MAX_TEXT_LENGTH);
  if (errorDetails) report.errorDetails = errorDetails;
  const cliSessionId = boundedString(fields.cliSessionId, MAX_ID_LENGTH);
  if (cliSessionId) report.cliSessionId = cliSessionId;
  const transcriptPath = boundedString(fields.transcriptPath, MAX_PATH_LENGTH);
  if (transcriptPath) report.transcriptPath = transcriptPath;
  const claudePid = positiveInt(fields.claudePid);
  if (claudePid !== undefined) report.claudePid = claudePid;
  return report;
}

/** Parse the JSON Claude writes to a `StopFailure` hook's stdin. `claudePid`
 *  is the hook's inherited `CLAUDE_PID`. Anything that is not a StopFailure
 *  payload with an error type yields undefined. */
export function parseClaudeStopFailureHookInput(
  payloadText: string,
  claudePid?: string,
): ClaudeStopFailureReport | undefined {
  let payload: unknown;
  try { payload = JSON.parse(payloadText); } catch { return undefined; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.hook_event_name !== undefined && p.hook_event_name !== 'StopFailure') return undefined;
  return buildReport({
    error: p.error,
    lastAssistantMessage: p.last_assistant_message,
    // Claude passes `error_details` through as-is; only its text form is kept.
    errorDetails: typeof p.error_details === 'string' ? p.error_details : undefined,
    cliSessionId: p.session_id,
    transcriptPath: p.transcript_path,
    claudePid,
  });
}

/** Re-validate a report that crossed the daemon IPC boundary. */
export function normalizeClaudeStopFailureReport(value: unknown): ClaudeStopFailureReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  return buildReport({
    error: v.error,
    lastAssistantMessage: v.lastAssistantMessage,
    errorDetails: v.errorDetails,
    cliSessionId: v.cliSessionId,
    transcriptPath: v.transcriptPath,
    claudePid: v.claudePid,
  });
}

/** The terminal the transcript path would derive from the same failure. */
export function classifyClaudeStopFailure(report: ClaudeStopFailureReport): ClaudeTerminalOutcome | undefined {
  return classifyClaudeTerminalEvent({
    type: 'assistant',
    isApiErrorMessage: true,
    error: report.error,
    // The transcript record of an overload carries HTTP 529; the hook payload
    // carries no status, only the error type.
    ...(report.error.toLowerCase() === 'overloaded' ? { apiErrorStatus: 529 } : {}),
    message: {
      role: 'assistant',
      content: report.lastAssistantMessage ? [{ type: 'text', text: report.lastAssistantMessage }] : [],
    },
  });
}

export interface ClaudeStopFailureOwner {
  /** PID of the Claude process this worker drives, when resolved. */
  cliPid?: number;
  /** Claude session ids known to belong to that process. */
  cliSessionIds: ReadonlySet<string>;
  /** Transcript the bridge reads. */
  transcriptPath?: string;
}

/**
 * Whether the report came from the Claude process this worker drives.
 *
 * A `claude -p` the agent runs from its own Bash tool inherits the session's
 * `BOTMUX_*` env and reads the same settings, so its API errors reach this
 * worker too. Its `CLAUDE_PID`, session id and transcript are all its own.
 * Any one matching identifier is accepted: a sandboxed CLI reports a
 * namespace-local pid, and the session id rotates on `/clear`.
 */
export function claudeStopFailureBelongsToOwner(
  report: ClaudeStopFailureReport,
  owner: ClaudeStopFailureOwner,
): boolean {
  if (report.claudePid !== undefined && report.claudePid === owner.cliPid) return true;
  if (report.cliSessionId !== undefined && owner.cliSessionIds.has(report.cliSessionId)) return true;
  return report.transcriptPath !== undefined && report.transcriptPath === owner.transcriptPath;
}

export type ClaudeStopFailureFallback =
  | {
    action: 'skip';
    /** `rate_limited`: usage limits stay with the structured limit path.
     *  `surfaced`: a failed terminal or failure notice went out around the
     *  report (normally the transcript path settling this turn). */
    reason: 'unclassified' | 'rate_limited' | 'surfaced';
  }
  /** The turn is still open: settle it, so the daemon continues or reports it. */
  | { action: 'emit'; status: 'failed' | 'ambiguous'; errorCode: string; retryable: boolean }
  /** No open turn to settle safely — the turn was already closed (e.g. as
   *  completed by an earlier edge while the CLI kept working), none was
   *  running, the claim named another turn, or the CLI already moved on to
   *  the next input. Tell the chat the work stopped. */
  | { action: 'notify'; errorCode: string };

/**
 * Decide, once the grace period is over, how the failure reaches the chat.
 *
 * The invariant is that every API error that ends a turn of the driven CLI
 * surfaces somewhere. The transcript path normally does it (a failed terminal,
 * or a local-turn notice), and then nothing more is sent.
 */
export function decideClaudeStopFailureFallback(input: {
  outcome: ClaudeTerminalOutcome | undefined;
  /** The open turn the failure may settle; undefined when there is none to settle. */
  turnId: string | undefined;
  /** That turn already has a terminal. */
  settled: boolean;
  /** The CLI is back at its prompt. When it is busy again, Claude has
   *  already started the next queued input, and the turn this worker calls
   *  active may be that one rather than the one that failed. */
  cliIdle: boolean;
  /** A failed terminal or failure notice went out around the report. */
  surfaced: boolean;
}): ClaudeStopFailureFallback {
  const { outcome } = input;
  if (!outcome || outcome.status === 'completed') return { action: 'skip', reason: 'unclassified' };
  if (outcome.status === 'rate_limited') return { action: 'skip', reason: 'rate_limited' };
  if (input.surfaced) return { action: 'skip', reason: 'surfaced' };
  if (input.turnId && !input.settled && input.cliIdle) {
    return { action: 'emit', status: outcome.status, errorCode: outcome.errorCode, retryable: outcome.retryable };
  }
  return { action: 'notify', errorCode: outcome.errorCode };
}

/** The worker state and effects one StopFailure report is handled against. */
export interface ClaudeStopFailureContext<TTimer = unknown> {
  owner: ClaudeStopFailureOwner;
  /** The turn this worker believes is running when the report arrives. */
  activeTurn: { turnId?: string; dispatchAttempt?: number };
  schedule: (delayMs: number, run: () => void) => TTimer;
  /** Read transcript bytes the watcher has not consumed yet; a transcript
   *  that is merely behind then settles the turn itself. */
  catchUp: () => void;
  isSettled: (turnId: string, dispatchAttempt?: number) => boolean;
  /** The CLI is back at its prompt. */
  cliIdle: () => boolean;
  /** When the worker last emitted a failed/ambiguous terminal or a failure
   *  notice. */
  lastFailureSurfacedAtMs: () => number | undefined;
  now: () => number;
  emit: (
    turnId: string,
    status: 'failed' | 'ambiguous',
    errorCode: string,
    dispatchAttempt: number | undefined,
    retryable: boolean,
  ) => void;
  /** Plain chat notice; `replyTurnId` picks the reply target. */
  notify: (errorCode: string, replyTurnId: string | undefined) => void;
  log: (line: string) => void;
}

/**
 * Handle one StopFailure report from the driven CLI: freeze the turn it ended,
 * and after the grace period settle that turn or tell the chat, unless the
 * transcript path already surfaced the failure.
 *
 * Claude does not wait for StopFailure hooks: it ends the turn, writes
 * `turn_duration` and may start the next queued input while the hook client
 * is still starting up. So the transcript can surface the failure on either
 * side of the report, and the turn the reporter (or this worker) calls active
 * may already be that next input. The turn is frozen on arrival; it is only
 * settled if it still has no terminal and the CLI is idle at the end of the
 * grace period, i.e. nothing started after the failure. `claimedTurn` is the
 * reporter's view (the active-turn marker it read); one that names another
 * turn than the worker's is never settled — the same exact-tuple rule as the
 * turn-idle report. Whatever cannot be settled safely is reported as a notice.
 */
export function handleClaudeStopFailureReport<TTimer>(
  report: ClaudeStopFailureReport,
  claimedTurn: { turnId?: string; dispatchAttempt?: number },
  ctx: ClaudeStopFailureContext<TTimer>,
): TTimer | undefined {
  if (!claudeStopFailureBelongsToOwner(report, ctx.owner)) {
    ctx.log(`Ignoring Claude StopFailure (${report.error}) from another Claude process `
      + `(pid=${report.claudePid ?? '?'} sid=${report.cliSessionId?.slice(0, 8) ?? '?'})`);
    return undefined;
  }
  const active = ctx.activeTurn;
  const claimMatches = claimedTurn.turnId === undefined
    || (claimedTurn.turnId === active.turnId && claimedTurn.dispatchAttempt === active.dispatchAttempt);
  if (!claimMatches) {
    ctx.log(`Claude StopFailure (${report.error}) claims turn ${claimedTurn.turnId!.slice(0, 12)} but `
      + `the active turn is ${active.turnId?.slice(0, 12) ?? 'none'}; it will not settle a turn`);
  }
  const turnId = claimMatches ? active.turnId : undefined;
  const { dispatchAttempt } = active;
  const replyTurnId = claimedTurn.turnId ?? active.turnId;
  // The transcript surfaces this failure within a second or two of it, on
  // either side of the report (see above).
  const surfacedSinceMs = ctx.now() - CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS;
  const outcome = classifyClaudeStopFailure(report);
  ctx.log(`Claude StopFailure (${report.error}) for turn ${turnId?.slice(0, 12) ?? '-'}; `
    + `waiting ${CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS}ms for the transcript to surface it`);
  return ctx.schedule(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS, () => {
    try {
      ctx.catchUp();
    } catch (err) {
      ctx.log(`Claude StopFailure catch-up read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const decision = decideClaudeStopFailureFallback({
      outcome,
      turnId,
      settled: !!turnId && ctx.isSettled(turnId, dispatchAttempt),
      cliIdle: ctx.cliIdle(),
      surfaced: (ctx.lastFailureSurfacedAtMs() ?? -Infinity) >= surfacedSinceMs,
    });
    switch (decision.action) {
      case 'skip':
        ctx.log(`Claude StopFailure (${report.error}) needs no fallback (${decision.reason})`);
        return;
      case 'emit':
        ctx.log(`Claude StopFailure fallback: the transcript never settled turn ${turnId!.slice(0, 12)}; `
          + `emitting ${decision.status}/${decision.errorCode}`);
        ctx.emit(turnId!, decision.status, decision.errorCode, dispatchAttempt, decision.retryable);
        return;
      case 'notify':
        ctx.log(`Claude StopFailure fallback: no open turn to settle and nothing surfaced the failure; `
          + `notifying (${decision.errorCode})`);
        ctx.notify(decision.errorCode, replyTurnId);
    }
  });
}
