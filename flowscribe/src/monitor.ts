import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { replay, type ReplayResult } from './replay.js';
import { loadSession } from './session.js';

export interface MonitorOptions {
  sessionDir: string;
  /** Time between runs in milliseconds. */
  intervalMs: number;
  /** POST a JSON report here when a run fails (or heals a selector). */
  webhook?: string;
  headless?: boolean;
  heal?: boolean;
  model?: string;
  /** Stop after this many runs (mainly for testing). 0 = run forever. */
  maxRuns?: number;
}

export interface MonitorRunReport {
  session: string;
  run: number;
  at: string;
  ok: boolean;
  passed: number;
  failed: number;
  healed: number;
  assertionsPassed: number;
  assertionsFailed: number;
  error?: string;
  failures?: Array<{ step: number; error: string }>;
}

/**
 * Synthetic monitoring: replay the recorded flow on an interval ("does
 * checkout still work?"). Every run is appended to monitor.log in the
 * session directory; failing runs (and self-healed ones) are POSTed to
 * the webhook if configured.
 */
export async function monitor(opts: MonitorOptions): Promise<void> {
  const sessionDir = path.resolve(opts.sessionDir);
  const session = await loadSession(sessionDir);
  const logFile = path.join(sessionDir, 'monitor.log');
  let run = 0;

  for (;;) {
    run++;
    const at = new Date().toISOString();
    let result: ReplayResult | null = null;
    let error: string | undefined;
    try {
      result = await replay({
        sessionDir,
        headless: opts.headless ?? true,
        slowMo: 0,
        heal: opts.heal,
        model: opts.model,
      });
    } catch (err) {
      error = (err as Error).message.split('\n')[0];
    }

    const report: MonitorRunReport = {
      session: session.name,
      run,
      at,
      ok: !error && result!.failed === 0 && result!.assertionsFailed === 0,
      passed: result?.passed ?? 0,
      failed: result?.failed ?? 0,
      healed: result?.healed ?? 0,
      assertionsPassed: result?.assertionsPassed ?? 0,
      assertionsFailed: result?.assertionsFailed ?? 0,
      error,
      failures: result?.failures.map((f) => ({
        step: f.step.index,
        error: f.error,
      })),
    };

    await appendFile(logFile, JSON.stringify(report) + '\n', 'utf8');
    console.log(
      `[${at}] run #${run}: ${report.ok ? '✔ OK' : '✘ FAILING'}` +
        ` (${report.passed} passed, ${report.failed} failed` +
        (report.healed ? `, ${report.healed} healed 🩹` : '') +
        `)${error ? ` — ${error}` : ''}`,
    );

    if (opts.webhook && (!report.ok || report.healed > 0)) {
      await postWebhook(opts.webhook, report);
    }

    if (opts.maxRuns && run >= opts.maxRuns) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

async function postWebhook(url: string, report: MonitorRunReport): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (!res.ok) console.warn(`Webhook responded ${res.status}.`);
  } catch (err) {
    console.warn(`Webhook failed: ${(err as Error).message}`);
  }
}

/** Parse "90s" / "15m" / "2h" (bare numbers = minutes) into milliseconds. */
export function parseInterval(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(value.trim());
  if (!m) throw new Error(`Cannot parse interval "${value}" — use e.g. 90s, 15m or 1h.`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return Math.max(1000, n * (unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000));
}
