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
  /** Set when a replay repaired this step's selector via AI healing. */
  healed?: boolean;
}

/** A verification suggested by AI (or added by hand) for the recorded flow. */
export interface FlowAssertion {
  /** Check runs after the step with this index completes. */
  afterStep: number;
  /** Text expected to be visible on the page (substring match). */
  text: string;
  /** Why this assertion matters (shown as a comment in exported specs). */
  note?: string;
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
  /** Verifications for replay/export-test (see `flowscribe assert`). */
  assertions?: FlowAssertion[];
}

export const SESSION_FILE = 'session.json';
