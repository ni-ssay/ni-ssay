import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SESSION_FILE, type RecordedStep, type SessionData } from './types.js';

export async function loadSession(sessionDir: string): Promise<SessionData> {
  const file = path.join(path.resolve(sessionDir), SESSION_FILE);
  const raw = await readFile(file, 'utf8').catch(() => {
    throw new Error(
      `No ${SESSION_FILE} found in ${sessionDir}. Record a session first: flowscribe record --url <url>`,
    );
  });
  return JSON.parse(raw) as SessionData;
}

/** Human-readable, English description of a step (input for Gemini and specs). */
export function describeStep(step: RecordedStep): string {
  const label = step.text ? `"${step.text.slice(0, 60)}"` : step.selector ?? '';
  switch (step.type) {
    case 'navigate':
      return `Navigate to ${step.url}`;
    case 'click': {
      const kind =
        step.tag === 'a' ? 'link' : step.tag === 'button' ? 'button' : 'element';
      return label ? `Click the ${label} ${kind}` : `Click on ${step.selector}`;
    }
    case 'fill': {
      const value = step.masked ? '••••••••' : `"${step.value ?? ''}"`;
      return step.text
        ? `Type ${value} into the "${step.text}" field`
        : `Type ${value} into ${step.selector}`;
    }
    case 'select':
      return `Select "${step.text ?? step.value}" from the dropdown menu`;
    case 'check':
      return `${step.checked ? 'Check' : 'Uncheck'} the ${label || 'checkbox'}`;
    case 'press':
      return `Press the ${step.key} key`;
  }
}

/** Compact plain-text listing of all steps, used inside AI prompts. */
export function stepsAsText(session: SessionData): string {
  return session.steps
    .map((s) => {
      const t = (s.timeOffsetMs / 1000).toFixed(1);
      const shot = s.screenshot ? ` [screenshot ${s.index}]` : '';
      return `${s.index}. [t=${t}s] ${describeStep(s)}${shot}`;
    })
    .join('\n');
}
