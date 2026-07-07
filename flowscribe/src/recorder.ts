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
  /**
   * Fixed viewport. When omitted (the default), the browser opens maximized
   * and the page fills the whole window — no letterboxing around the app.
   */
  viewport?: { width: number; height: number };
  /**
   * Capture a full-motion screencast video while recording. This routes the
   * page through Playwright's emulation + frame-capture pipeline, which
   * makes interaction noticeably less fluid — so it is OFF by default and a
   * step-by-step video is synthesized from the screenshots after the fact.
   */
  video?: boolean;
  /**
   * Capture a Playwright trace (trace.zip). Adds instrumentation overhead
   * to every interaction, so it is off by default.
   */
  trace?: boolean;
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
 * Prefer the user's real installed Chrome/Edge for headed recording — the
 * Playwright-bundled Chromium is a stripped build that can run without full
 * GPU acceleration (noticeably laggy on Windows). Falls back to the bundled
 * browser. FLOWSCRIBE_CHROMIUM forces a specific executable.
 */
async function launchBrowser(opts: {
  headless: boolean;
  args: string[];
}): Promise<Browser> {
  const base = {
    headless: opts.headless,
    args: opts.args,
    // Drop the --enable-automation infobar: it throttles some page features
    // and its banner resizes the page mid-session.
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (process.env.FLOWSCRIBE_CHROMIUM) {
    return chromium.launch({ ...base, executablePath: process.env.FLOWSCRIBE_CHROMIUM });
  }
  const channels: Array<string | undefined> = opts.headless
    ? [undefined]
    : ['chrome', 'msedge', undefined];
  let lastError: Error | null = null;
  for (const channel of channels) {
    try {
      return await chromium.launch({ ...base, channel });
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error('No Chromium-based browser found.');
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

  const browser = await launchBrowser({
    headless: opts.headless ?? false,
    // Without a user-fixed viewport the window opens maximized and we match
    // the page to it exactly (see the probe below).
    args: opts.viewport ? [] : ['--start-maximized'],
  });

  // Default mode: NO viewport emulation and NO screencast. The page is a
  // completely native browser window — fluid, correct DPI, full-size. A
  // step video is synthesized from the screenshots after recording ends.
  //
  // Screencast mode (opts.video / fixed viewport): Playwright's recordVideo
  // requires an emulated viewport; probe the real maximized window size AND
  // devicePixelRatio first so the page still fills the window on high-DPI
  // displays instead of letterboxing.
  const screencast = !!opts.video || !!opts.viewport;
  let viewport = opts.viewport ?? null;
  let deviceScaleFactor: number | undefined;
  if (screencast && !viewport) {
    const probe = await browser.newContext({ viewport: null });
    try {
      const p = await probe.newPage();
      const m = (await p.evaluate(
        '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
      )) as { width: number; height: number; dpr: number } | null;
      if (m && m.width >= 320 && m.height >= 240) {
        viewport = { width: m.width, height: m.height };
        if (m.dpr && Math.abs(m.dpr - 1) > 0.01) deviceScaleFactor = m.dpr;
      }
    } catch {
      /* fall back to Playwright defaults */
    } finally {
      await probe.close().catch(() => {});
    }
  }

  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  const videoScale = viewport ? Math.min(1, 1280 / viewport.width) : 1;
  const videoSize = viewport
    ? { width: even(viewport.width * videoScale), height: even(viewport.height * videoScale) }
    : { width: 1280, height: 720 };

  const context = await browser.newContext({
    viewport: screencast ? viewport : null,
    ...(screencast && viewport && deviceScaleFactor ? { deviceScaleFactor } : {}),
    ...(screencast ? { recordVideo: { dir: videoDir, size: videoSize } } : {}),
    httpCredentials:
      opts.user && opts.pass
        ? { username: opts.user, password: opts.pass }
        : undefined,
  });
  // Tracing instruments every interaction (and its screenshots use the
  // screencast pipeline) — only pay for it when explicitly requested.
  if (opts.trace) {
    await context.tracing.start({ screenshots: false, snapshots: true });
  }

  const startedAtMs = Date.now();
  const session: SessionData = {
    version: 1,
    name: opts.name ?? `session-${new Date(startedAtMs).toISOString().replace(/[:.]/g, '-')}`,
    startUrl: opts.url,
    startedAt: new Date(startedAtMs).toISOString(),
    viewport: viewport ?? { width: 1280, height: 720 },
    steps: [],
    videos: [],
  };

  const pages: Page[] = [];
  const cdpSessions = new Map<Page, Promise<import('playwright').CDPSession | null>>();
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
    // JPEG rather than PNG: visually identical for guides, much smaller,
    // and decodable by Playwright's bundled ffmpeg for the step video.
    const file = `step-${String(step.index).padStart(3, '0')}.jpg`;
    // Serialize screenshots so rapid clicks don't interleave.
    screenshotChain = screenshotChain.then(async () => {
      try {
        // Raw CDP capture: a single fast readback, none of page.screenshot's
        // stabilization (font waits, rAF roundtrips, caret handling) that
        // hitches the page right at click time.
        const cdp = await cdpSessions.get(page);
        if (!cdp) return;
        const shot = (await Promise.race([
          cdp.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 85,
            optimizeForSpeed: true,
          } as never),
          new Promise((r) => setTimeout(() => r(null), 4000)),
        ])) as { data: string } | null;
        if (!shot?.data) return;
        await writeFile(path.join(shotsDir, file), Buffer.from(shot.data, 'base64'));
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
    cdpSessions.set(page, context.newCDPSession(page).catch(() => null));
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
      if (!opts.viewport && pages.length === 1) {
        // Record the real full-window size so replays match what was seen.
        const size = await page
          .evaluate('({ width: window.innerWidth, height: window.innerHeight })')
          .catch(() => null);
        if (size) session.viewport = size as { width: number; height: number };
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
    if (opts.trace) {
      await context.tracing
        .stop({ path: path.join(outDir, 'trace.zip') })
        .catch(() => {});
    }
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

    // Fluid (non-screencast) recordings get their video synthesized now,
    // from the step screenshots, so nothing slowed the live session down.
    if (session.videos.length === 0) {
      const { slideshowFromScreenshots } = await import('./video.js');
      const rel = await slideshowFromScreenshots(outDir, session).catch(() => null);
      if (rel) session.videos.push(rel);
    }

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
