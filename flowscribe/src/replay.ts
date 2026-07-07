import { chromium } from 'playwright';
import path from 'node:path';
import { loadSession, describeStep } from './session.js';
import type { RecordedStep } from './types.js';

export interface ReplayOptions {
  sessionDir: string;
  headless?: boolean;
  /** Delay between actions in ms so a human can follow along. */
  slowMo?: number;
}

export interface ReplayResult {
  passed: number;
  failed: number;
  failures: Array<{ step: RecordedStep; error: string }>;
}

/**
 * Re-execute a recorded session with Playwright — the recorded flow
 * becomes an automated smoke test.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const session = await loadSession(path.resolve(opts.sessionDir));
  const result: ReplayResult = { passed: 0, failed: 0, failures: [] };

  const browser = await chromium.launch({
    headless: opts.headless ?? false,
    slowMo: opts.slowMo ?? 250,
    executablePath: process.env.FLOWSCRIBE_CHROMIUM || undefined,
  });
  const page = await browser.newPage({ viewport: session.viewport });

  try {
    await page.goto(session.startUrl, { waitUntil: 'domcontentloaded' });

    for (const step of session.steps) {
      const label = `step ${step.index}: ${describeStep(step)}`;
      try {
        await runStep(page, step);
        result.passed++;
        console.log(`  ✔ ${label}`);
      } catch (err) {
        result.failed++;
        const error = (err as Error).message.split('\n')[0];
        result.failures.push({ step, error });
        console.error(`  ✘ ${label}\n    ${error}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

async function runStep(
  page: import('playwright').Page,
  step: RecordedStep,
): Promise<void> {
  const timeout = 10000;
  const locator = () => {
    if (!step.selector) throw new Error('Step has no selector to replay.');
    return page.locator(step.selector).first();
  };

  switch (step.type) {
    case 'navigate':
      if (step.index === 1) return; // covered by the initial goto
      await page.waitForURL(step.url, { timeout }).catch(async () => {
        // The app may navigate differently between runs — try going directly.
        await page.goto(step.url, { waitUntil: 'domcontentloaded' });
      });
      return;
    case 'click':
      await tryCandidates(page, step, (loc) => loc.click({ timeout }));
      return;
    case 'fill':
      await tryCandidates(page, step, (loc) =>
        loc.fill(step.value ?? '', { timeout }),
      );
      return;
    case 'select':
      await tryCandidates(page, step, (loc) =>
        loc.selectOption(step.value ?? '', { timeout }).then(() => {}),
      );
      return;
    case 'check':
      await tryCandidates(page, step, (loc) =>
        step.checked ? loc.check({ timeout }) : loc.uncheck({ timeout }),
      );
      return;
    case 'press':
      if (step.selector) {
        await locator().press(step.key ?? 'Enter', { timeout });
      } else {
        await page.keyboard.press(step.key ?? 'Enter');
      }
      return;
  }
}

/** Try the primary selector, then fall back through recorded candidates. */
async function tryCandidates(
  page: import('playwright').Page,
  step: RecordedStep,
  action: (loc: import('playwright').Locator) => Promise<void>,
): Promise<void> {
  const candidates = [
    ...new Set(
      [step.selector, ...(step.selectorCandidates ?? [])].filter(
        (s): s is string => !!s,
      ),
    ),
  ];
  if (candidates.length === 0) throw new Error('Step has no selector to replay.');

  let lastError: Error | null = null;
  for (const sel of candidates) {
    try {
      await action(page.locator(sel).first());
      return;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error('All selector candidates failed.');
}
