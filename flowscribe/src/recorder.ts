import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { INJECTED_RECORDER_SOURCE } from './injected.js';
import { SESSION_FILE, type RecordedStep, type SessionData, type StepType } from './types.js';

export interface RecordOptions {
  url: string;
  /** Output directory for the session (created if missing). */
  out: string;
  name?: string;
  /** HTTP basic-auth credentials, if the site needs them. */
  user?: string;
  pass?: string;
  viewport?: { width: number; height: number };
  /** Headless mode — mainly for automated tests of FlowScribe itself. */
  headless?: boolean;
}

export interface RecordingHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Resolves with the saved session once the browser is closed. */
  done: Promise<SessionData>;
  /** Stop recording programmatically (same as closing the browser). */
  stop: () => Promise<SessionData>;
}

interface EmitPayload {
  kind: string;
  selector?: string | null;
  selectorCandidates?: string[];
  tag?: string;
  text?: string;
  value?: string;
  key?: string;
  checked?: boolean;
  masked?: boolean;
  x?: number;
  y?: number;
  targetSelector?: string | null;
  targetText?: string;
  files?: string[];
  url: string;
}

/**
 * Launch a browser and record every user interaction until it is closed.
 * No AI is involved here — recording is 100% local Playwright.
 */
export async function record(opts: RecordOptions): Promise<RecordingHandle> {
  const outDir = path.resolve(opts.out);
  const shotsDir = path.join(outDir, 'screenshots');
  const videoDir = path.join(outDir, 'video');
  await mkdir(shotsDir, { recursive: true });
  await mkdir(videoDir, { recursive: true });

  const viewport = opts.viewport ?? { width: 1280, height: 720 };

  const browser = await chromium.launch({
    headless: opts.headless ?? false,
    executablePath: process.env.FLOWSCRIBE_CHROMIUM || undefined,
  });
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
    httpCredentials:
      opts.user && opts.pass
        ? { username: opts.user, password: opts.pass }
        : undefined,
  });
  await context.tracing.start({ screenshots: true, snapshots: true });

  const startedAtMs = Date.now();
  const session: SessionData = {
    version: 1,
    name: opts.name ?? `session-${new Date(startedAtMs).toISOString().replace(/[:.]/g, '-')}`,
    startUrl: opts.url,
    startedAt: new Date(startedAtMs).toISOString(),
    viewport,
    steps: [],
    videos: [],
  };

  const pages: Page[] = [];
  let stepIndex = 0;
  let screenshotChain: Promise<void> = Promise.resolve();

  const addStep = (step: Omit<RecordedStep, 'index' | 'timeOffsetMs'>): RecordedStep => {
    const full: RecordedStep = {
      ...step,
      index: ++stepIndex,
      timeOffsetMs: Date.now() - startedAtMs,
    };
    session.steps.push(full);
    return full;
  };

  const captureScreenshot = (page: Page, step: RecordedStep) => {
    const file = `step-${String(step.index).padStart(3, '0')}.png`;
    // Serialize screenshots so rapid clicks don't interleave.
    screenshotChain = screenshotChain.then(async () => {
      try {
        await page.screenshot({
          path: path.join(shotsDir, file),
          timeout: 4000,
          // Don't touch the page: caret manipulation and animation freezing
          // force style flushes that users perceive as a click "glitch".
          caret: 'initial',
          animations: 'allow',
          scale: 'css',
        });
        step.screenshot = `screenshots/${file}`;
      } catch {
        /* page may be navigating — skip the screenshot, keep the step */
      }
    });
  };

  const onEmit = (page: Page, p: EmitPayload) => {
    const kindToType: Record<string, StepType> = {
      click: 'click',
      fill: 'fill',
      select: 'select',
      check: 'check',
      press: 'press',
      hover: 'hover',
      drag: 'drag',
      upload: 'upload',
    };
    const type = kindToType[p.kind];
    if (!type) return;

    const last = session.steps[session.steps.length - 1];

    // Collapse repeated fills on the same field: keep only the final value.
    if (type === 'fill') {
      if (last && last.type === 'fill' && last.selector === p.selector) {
        last.value = p.value;
        last.timeOffsetMs = Date.now() - startedAtMs;
        return;
      }
    }
    // Consecutive hovers on the same element are one hover.
    if (type === 'hover' && last?.type === 'hover' && last.selector === p.selector) {
      return;
    }
    // "Hover X" immediately followed by "click X" is just the click.
    if (type === 'click' && last?.type === 'hover' && last.selector === p.selector) {
      session.steps.pop();
      stepIndex--;
    }
    // A drag's mouse-down registers as a click on the source — drop it.
    if (type === 'drag' && last?.type === 'click' && last.selector === p.selector) {
      session.steps.pop();
      stepIndex--;
    }

    const step = addStep({
      type,
      url: p.url,
      selector: p.selector ?? undefined,
      selectorCandidates: p.selectorCandidates,
      tag: p.tag,
      text: p.text,
      value: p.value,
      key: p.key,
      checked: p.checked,
      masked: p.masked,
      coords: p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : undefined,
      targetSelector: p.targetSelector ?? undefined,
      targetText: p.targetText,
      files: p.files,
    });

    if (type === 'click' || type === 'hover' || type === 'drag') {
      // Clicks show the in-page ripple (drawn synchronously on pointerdown);
      // hover shots capture opened menus, drag shots the dropped state.
      captureScreenshot(page, step);
    }
  };

  const wirePage = (page: Page) => {
    pages.push(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url === 'about:blank') return;
      const last = session.steps[session.steps.length - 1];
      // Skip navigations caused by the click we just recorded on the same URL.
      if (last && last.type === 'navigate' && last.url === url) return;
      addStep({ type: 'navigate', url });
    });
    page.once('domcontentloaded', async () => {
      if (!session.appTitle) {
        session.appTitle = await page.title().catch(() => undefined);
      }
    });
  };

  await context.exposeBinding('__fsEmit', ({ page }, payload: EmitPayload) => {
    onEmit(page, payload);
  });
  await context.addInitScript({ content: INJECTED_RECORDER_SOURCE });
  context.on('page', wirePage);

  const page = await context.newPage();
  await page.goto(opts.url, { waitUntil: 'domcontentloaded' }).catch((err) => {
    console.error(`Could not open ${opts.url}: ${err.message}`);
  });

  let finishPromise: Promise<SessionData> | null = null;
  const finish = (): Promise<SessionData> => {
    if (finishPromise) return finishPromise;
    finishPromise = doFinish();
    return finishPromise;
  };
  const doFinish = async (): Promise<SessionData> => {

    await screenshotChain.catch(() => {});
    await context.tracing
      .stop({ path: path.join(outDir, 'trace.zip') })
      .catch(() => {});
    await context.close().catch(() => {});

    for (const p of pages) {
      const video = p.video();
      if (!video) continue;
      try {
        const videoPath = await video.path();
        session.videos.push(path.relative(outDir, videoPath));
      } catch {
        /* video may be unavailable if the page never rendered */
      }
    }
    await browser.close().catch(() => {});

    const endedAtMs = Date.now();
    session.endedAt = new Date(endedAtMs).toISOString();
    session.durationMs = endedAtMs - startedAtMs;
    await writeFile(
      path.join(outDir, SESSION_FILE),
      JSON.stringify(session, null, 2),
      'utf8',
    );
    return session;
  };

  const done = new Promise<SessionData>((resolve) => {
    context.on('close', () => {
      finish().then(resolve);
    });
  });

  return { browser, context, page, done, stop: finish };
}
