import { chromium } from 'playwright';
import { copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { healSelector } from './heal.js';
import { loadSession, describeStep } from './session.js';
import { SESSION_FILE, type RecordedStep } from './types.js';

export interface ReplayOptions {
  sessionDir: string;
  headless?: boolean;
  /** Delay between actions in ms so a human can follow along. */
  slowMo?: number;
  /** Repair broken selectors with Gemini when a step fails (needs GEMINI_API_KEY). */
  heal?: boolean;
  model?: string;
}

export interface ReplayResult {
  passed: number;
  failed: number;
  healed: number;
  assertionsPassed: number;
  assertionsFailed: number;
  failures: Array<{ step: RecordedStep; error: string }>;
}

/**
 * Re-execute a recorded session with Playwright — the recorded flow
 * becomes an automated smoke test. With healing enabled, steps whose
 * selectors no longer match are repaired via Gemini and the fixed
 * selectors are written back to session.json.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const sessionDir = path.resolve(opts.sessionDir);
  const session = await loadSession(sessionDir);
  const heal = (opts.heal ?? true) && !!process.env.GEMINI_API_KEY;
  const result: ReplayResult = {
    passed: 0,
    failed: 0,
    healed: 0,
    assertionsPassed: 0,
    assertionsFailed: 0,
    failures: [],
  };

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
        const healedSelector = heal
          ? await tryHeal(page, step, err as Error, opts.model)
          : null;
        if (healedSelector) {
          result.passed++;
          result.healed++;
          // Persist the repair: new selector first, old one kept as fallback.
          step.selectorCandidates = [
            healedSelector,
            ...new Set(
              [step.selector, ...(step.selectorCandidates ?? [])].filter(
                (s): s is string => !!s && s !== healedSelector,
              ),
            ),
          ];
          step.selector = healedSelector;
          step.healed = true;
          console.log(`  🩹 ${label}\n    healed with selector: ${healedSelector}`);
        } else {
          result.failed++;
          const error = (err as Error).message.split('\n')[0];
          result.failures.push({ step, error });
          console.error(`  ✘ ${label}\n    ${error}`);
        }
      }

      for (const assertion of session.assertions ?? []) {
        if (assertion.afterStep !== step.index) continue;
        const aLabel = `assert after step ${step.index}: "${assertion.text}" visible`;
        try {
          await page
            .getByText(assertion.text)
            .first()
            .waitFor({ state: 'visible', timeout: 7000 });
          result.assertionsPassed++;
          console.log(`  ✔ ${aLabel}`);
        } catch {
          result.assertionsFailed++;
          console.error(`  ✘ ${aLabel}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (result.healed > 0) {
    const sessionFile = path.join(sessionDir, SESSION_FILE);
    const backup = path.join(sessionDir, 'session.backup.json');
    if (!existsSync(backup)) await copyFile(sessionFile, backup);
    await writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8');
    console.log(
      `\n🩹 ${result.healed} selector(s) healed and saved to session.json` +
        ` (original kept in session.backup.json).`,
    );
  }
  return result;
}

async function tryHeal(
  page: import('playwright').Page,
  step: RecordedStep,
  error: Error,
  model?: string,
): Promise<string | null> {
  // Only selector-based steps can be healed.
  if (!step.selector || step.type === 'navigate') return null;
  console.log(`    selector failed — asking Gemini for a repair...`);
  const selector = await healSelector(page, step, model);
  if (!selector) return null;
  try {
    await runStep(page, { ...step, selector, selectorCandidates: [] });
    return selector;
  } catch {
    return null;
  }
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
