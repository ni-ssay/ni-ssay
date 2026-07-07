import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SESSION_FILE, type RecordedStep, type SessionData, type StepType } from './types.js';

/**
 * Import a .flowscribe.json export (from the Chrome extension recorder)
 * into a standard session directory, so every other command — generate,
 * edit, assert, replay, export-test, narrate, monitor — works on it.
 */

interface ExtensionStep {
  type: StepType;
  ts: number;
  url: string;
  selector?: string;
  selectorCandidates?: string[];
  tag?: string;
  text?: string;
  value?: string;
  key?: string;
  checked?: boolean;
  masked?: boolean;
  coords?: { x: number; y: number };
  targetSelector?: string;
  targetText?: string;
  files?: string[];
  /** Base64 PNG captured by the extension. */
  screenshotData?: string | null;
}

interface ExtensionExport {
  version: number;
  source?: string;
  name: string;
  startUrl: string;
  appTitle?: string;
  startedAt: string;
  startedAtTs?: number;
  viewport?: { width: number; height: number };
  steps: ExtensionStep[];
}

export interface ImportOptions {
  file: string;
  out: string;
}

export async function importSession(opts: ImportOptions): Promise<SessionData> {
  const raw = JSON.parse(await readFile(path.resolve(opts.file), 'utf8')) as ExtensionExport;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('The export contains no steps.');
  }
  if (!raw.startUrl) throw new Error('The export has no startUrl.');

  const outDir = path.resolve(opts.out);
  const shotsDir = path.join(outDir, 'screenshots');
  await mkdir(shotsDir, { recursive: true });

  const startTs = raw.startedAtTs ?? raw.steps[0].ts;
  const steps: RecordedStep[] = [];
  for (const [i, s] of raw.steps.entries()) {
    const step: RecordedStep = {
      index: i + 1,
      type: s.type,
      timeOffsetMs: Math.max(0, (s.ts ?? startTs) - startTs),
      url: s.url,
      selector: s.selector,
      selectorCandidates: s.selectorCandidates,
      tag: s.tag,
      text: s.text,
      value: s.value,
      key: s.key,
      checked: s.checked,
      masked: s.masked,
      coords: s.coords,
      targetSelector: s.targetSelector,
      targetText: s.targetText,
      files: s.files,
    };
    if (s.screenshotData) {
      const file = `step-${String(step.index).padStart(3, '0')}.png`;
      await writeFile(path.join(shotsDir, file), Buffer.from(s.screenshotData, 'base64'));
      step.screenshot = `screenshots/${file}`;
    }
    steps.push(step);
  }

  const lastTs = raw.steps[raw.steps.length - 1].ts ?? startTs;
  const session: SessionData = {
    version: 1,
    name: raw.name || `imported-${new Date(startTs).toISOString().replace(/[:.]/g, '-')}`,
    startUrl: raw.startUrl,
    appTitle: raw.appTitle || undefined,
    startedAt: raw.startedAt || new Date(startTs).toISOString(),
    endedAt: new Date(lastTs).toISOString(),
    durationMs: Math.max(0, lastTs - startTs),
    viewport: raw.viewport ?? { width: 1280, height: 720 },
    steps,
    videos: [],
  };

  await writeFile(path.join(outDir, SESSION_FILE), JSON.stringify(session, null, 2), 'utf8');
  return session;
}
