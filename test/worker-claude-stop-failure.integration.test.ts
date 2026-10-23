/**
 * Claude `StopFailure` fallback against a REAL worker (tmux backend +
 * claude-code adapter + transcript bridge) and a fake Claude Code whose
 * `FAIL…` turns end the way Claude 2.1.296 ends a turn on "API Error:
 * Connection lost mid-response.": a thinking block, the API-error record
 * (`error:"server_error"`), then `system/turn_duration`.
 *
 * The test plays the daemon: it forwards the `claude_stop_failure` message
 * the `/api/claude-stop-failure` route sends when Claude runs the hook (the
 * hook client and the route have their own boundary tests).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';
import { CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS } from '../src/services/claude-stop-failure.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude as setup,
  type Generation,
  type Harness,
} from './helpers/claude-worker-harness.js';

// The workers run with locale zh; the expected notice comes from the same key.
setDefaultLocale('zh');
const UNSETTLED_NOTICE = t('worker.claude_stop_failure_unsettled', {
  cliName: lookupCliDisplayName('claude-code') ?? 'Claude Code',
  errorCode: 'provider_server_error',
});

afterEach(cleanUpClaudeHarnesses);

type Terminal = Extract<WorkerToDaemon, { type: 'turn_terminal' }>;
const terminalsOf = (g: Generation, turnId: string): Terminal[] =>
  g.messages.filter((m): m is Terminal => m.type === 'turn_terminal' && m.turnId === turnId);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** What the daemon forwards when the fake's Claude runs the StopFailure hook. */
function stopFailure(h: Harness, turnId: string): DaemonToWorker {
  return {
    type: 'claude_stop_failure',
    report: {
      error: 'server_error',
      lastAssistantMessage: 'API Error: Connection lost mid-response. The response above may be incomplete.',
      cliSessionId: h.sessionId,
      transcriptPath: h.transcript(h.sessionId),
    },
    turnId,
  };
}

describe.skipIf(!runnable)('Claude StopFailure fallback', () => {
  it('stays quiet when the transcript settles the failed turn itself', async () => {
    const h = setup({ turnMs: 1_000 });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    g.child.send({ type: 'message', content: 'FAIL right away', turnId: 'om_fail_now' } satisfies DaemonToWorker);
    await g.waitFor(() => terminalsOf(g, 'om_fail_now').length > 0, 'the transcript terminal');
    expect(terminalsOf(g, 'om_fail_now')).toEqual([expect.objectContaining({
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
    })]);

    g.child.send(stopFailure(h, 'om_fail_now'));
    await sleep(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS + 2_000);
    expect(terminalsOf(g, 'om_fail_now')).toHaveLength(1);
    expect(g.notices().map(n => n.message)).not.toContain(UNSETTLED_NOTICE);
  }, 90_000);

  it('reports a failure that lands after its turn was already closed', async () => {
    // The quiet screen mid-turn closes the turn as completed; the API error
    // that ends the real work afterwards has no turn left to fail.
    const h = setup({ turnMs: 1_000 });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    const prompt = 'FAIL_AFTER_QUIET long task';
    g.child.send({ type: 'message', content: prompt, turnId: 'om_long_task' } satisfies DaemonToWorker);
    await g.waitFor(() => h.failedAt(prompt) !== undefined, 'the turn to end on its API error', 60_000);
    await sleep(2_000);
    // Without the hook nothing tells the chat: the turn reads as completed.
    expect(terminalsOf(g, 'om_long_task').map(m => m.status)).toEqual(['completed']);
    expect(g.notices()).toEqual([]);

    g.child.send(stopFailure(h, 'om_long_task'));
    await g.waitFor(
      () => g.notices().some(n => n.message === UNSETTLED_NOTICE),
      'the StopFailure notice',
      CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS + 10_000,
    );
    expect(g.notices().find(n => n.message === UNSETTLED_NOTICE)?.turnId).toBe('om_long_task');
    expect(terminalsOf(g, 'om_long_task')).toHaveLength(1);
  }, 120_000);
});
