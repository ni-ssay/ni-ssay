/** A single user action captured during a recording session. */
export type StepType =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'press';

export interface RecordedStep {
  index: number;
  type: StepType;
  /** Milliseconds since the recording started. */
  timeOffsetMs: number;
  /** URL of the page at the moment of the action. */
  url: string;
  /** Best selector for replaying this step. */
  selector?: string;
  /** Alternative selectors, most specific first. */
  selectorCandidates?: string[];
  /** Value typed / option selected. */
  value?: string;
  /** Key pressed (for `press` steps). */
  key?: string;
  /** Visible text / label of the target element. */
  text?: string;
  /** Tag name of the target element (lowercase). */
  tag?: string;
  /** Checkbox / radio state (for `check` steps). */
  checked?: boolean;
  /** Viewport coordinates of the click. */
  coords?: { x: number; y: number };
  /** Screenshot filename (relative to the session directory). */
  screenshot?: string;
  /** True for sensitive inputs (passwords) — mask when generating guides. */
  masked?: boolean;
}

export interface SessionData {
  version: 1;
  name: string;
  startUrl: string;
  /** Document title of the app, captured on first load. */
  appTitle?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  viewport: { width: number; height: number };
  steps: RecordedStep[];
  /** Video files (relative to the session directory). */
  videos: string[];
}

export const SESSION_FILE = 'session.json';
