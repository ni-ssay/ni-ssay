import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { geminiGenerate, parseJsonResponse, type GeminiImage } from './gemini.js';
import { loadSession, stepsAsText } from './session.js';
import { SESSION_FILE, type FlowAssertion } from './types.js';

export interface SuggestAssertionsOptions {
  sessionDir: string;
  /** Send the click screenshots to Gemini so it only asserts text it can see. */
  vision?: boolean;
  model?: string;
}

/**
 * Ask Gemini to propose verifications for the recorded flow ("after clicking
 * Sign in, the text 'Welcome back!' should be visible"). The suggestions are
 * stored in session.json and picked up automatically by `replay` and
 * `export-test`, upgrading the replay from "does it not crash" to a real
 * regression test.
 */
export async function suggestAssertions(
  opts: SuggestAssertionsOptions,
): Promise<FlowAssertion[]> {
  const sessionDir = path.resolve(opts.sessionDir);
  const session = await loadSession(sessionDir);
  if (session.steps.length === 0) {
    throw new Error('The recorded session has no steps — nothing to assert.');
  }

  let images: GeminiImage[] | undefined;
  if (opts.vision ?? true) {
    images = [];
    for (const step of session.steps.filter((s) => s.screenshot).slice(0, 12)) {
      const data = await readFile(path.join(sessionDir, step.screenshot!)).catch(
        () => null,
      );
      if (data) images.push({ mimeType: 'image/png', data: data.toString('base64') });
    }
    if (images.length === 0) images = undefined;
  }

  const maxStep = session.steps[session.steps.length - 1].index;
  const prompt = [
    'You are a QA engineer writing verifications for an automated regression test of a web flow.',
    '',
    `Application: ${session.appTitle ?? session.startUrl}`,
    'Recorded steps (chronological):',
    stepsAsText(session),
    '',
    'Propose 2 to 8 assertions of the form: after step N completes, the exact text T should be visible on the page.',
    'Rules:',
    '- Only assert text you are confident appears: text visible in the attached screenshots, or text the flow obviously produces (e.g. a value that was typed into a field is NOT visible text; a success message IS).',
    '- Prefer outcome-proving texts: success messages, headings of the page reached, labels that only appear after the action worked.',
    '- T must be short (under 60 characters), exact, and unique enough to find on the page.',
    `- N must be one of the step numbers above (1 to ${maxStep}).`,
    '- Fewer, reliable assertions beat many flaky ones.',
    '',
    'Return ONLY a JSON array: [{"afterStep": number, "text": string, "note": string}, ...]',
  ].join('\n');

  const response = await geminiGenerate({
    prompt,
    images,
    json: true,
    model: opts.model,
    temperature: 0,
  });

  const stepIndexes = new Set(session.steps.map((s) => s.index));
  const seen = new Set<string>();
  const assertions = parseJsonResponse<FlowAssertion[]>(response)
    .filter(
      (a) =>
        Number.isInteger(a.afterStep) &&
        stepIndexes.has(a.afterStep) &&
        typeof a.text === 'string' &&
        a.text.trim().length > 0 &&
        a.text.trim().length <= 80,
    )
    .map((a) => ({
      afterStep: a.afterStep,
      text: a.text.trim(),
      note: typeof a.note === 'string' ? a.note.trim().slice(0, 200) : undefined,
    }))
    .filter((a) => {
      const key = `${a.afterStep}|${a.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);

  if (assertions.length === 0) {
    throw new Error('Gemini returned no usable assertions.');
  }

  const sessionFile = path.join(sessionDir, SESSION_FILE);
  const backup = path.join(sessionDir, 'session.backup.json');
  if (!existsSync(backup)) await copyFile(sessionFile, backup);
  session.assertions = assertions;
  await writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8');
  return assertions;
}
