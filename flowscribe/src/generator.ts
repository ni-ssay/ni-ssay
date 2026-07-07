import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';
import { geminiGenerate, type GeminiImage } from './gemini.js';
import { loadSession, stepsAsText } from './session.js';

export interface GenerateOptions {
  sessionDir: string;
  /** ISO language codes, e.g. ['en', 'fr', 'ar']. */
  langs: string[];
  /** Also send the click screenshots to Gemini for richer descriptions. */
  vision?: boolean;
  model?: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ar: 'Arabic',
  he: 'Hebrew',
  tr: 'Turkish',
  ru: 'Russian',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  ur: 'Urdu',
  fa: 'Persian',
  pl: 'Polish',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  cs: 'Czech',
  el: 'Greek',
  id: 'Indonesian',
  th: 'Thai',
  vi: 'Vietnamese',
};

const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code;
}

/** Generate a user guide (Markdown + HTML) for each requested language. */
export async function generateGuides(opts: GenerateOptions): Promise<string[]> {
  const sessionDir = path.resolve(opts.sessionDir);
  const session = await loadSession(sessionDir);
  if (session.steps.length === 0) {
    throw new Error('The recorded session has no steps — nothing to document.');
  }

  const guideDir = path.join(sessionDir, 'guide');
  await mkdir(guideDir, { recursive: true });

  const screenshotSteps = session.steps.filter((s) => s.screenshot);
  let images: GeminiImage[] | undefined;
  if (opts.vision) {
    images = [];
    // Cap inline images to keep the request within API limits.
    for (const step of screenshotSteps.slice(0, 12)) {
      const data = await readFile(path.join(sessionDir, step.screenshot!)).catch(
        () => null,
      );
      if (data) images.push({ mimeType: 'image/png', data: data.toString('base64') });
    }
  }

  const written: string[] = [];
  for (const lang of opts.langs) {
    const langName = languageName(lang);
    console.log(`Generating ${langName} guide...`);

    const prompt = [
      `You are a professional technical writer. Write a step-by-step end-user guide in ${langName} for the workflow below, which was recorded in a web application.`,
      '',
      `Application: ${session.appTitle ?? session.startUrl}`,
      `Starting URL: ${session.startUrl}`,
      '',
      'Recorded steps (chronological):',
      stepsAsText(session),
      '',
      'Requirements:',
      `- Write the ENTIRE guide in ${langName} (headings included). Keep product/UI label texts (button names, field names) in their original language, quoted.`,
      '- Output clean Markdown: a title, a one-paragraph introduction explaining what the reader will accomplish, then numbered steps, then a short closing note.',
      '- Group trivial consecutive actions into a single step when it reads better (e.g. filling a form).',
      '- Where a step has "[screenshot N]", insert the marker {{screenshot:N}} on its own line right after that step. Use each marker at most once and do not invent markers.',
      '- Never reveal passwords or masked values; refer to them as "your password".',
      '- Do not wrap the output in a code fence.',
      images?.length
        ? '- Screenshots of the clicks are attached in step order; use them to describe the UI accurately (the red circle marks where the user clicked).'
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const markdownRaw = await geminiGenerate({ prompt, images, model: opts.model });

    // Replace {{screenshot:N}} markers with the actual annotated images.
    const markdown = markdownRaw.replace(
      /\{\{\s*screenshot:(\d+)\s*\}\}/g,
      (_m, n: string) => {
        const step = session.steps.find(
          (s) => s.index === Number(n) && s.screenshot,
        );
        return step ? `![Step ${n}](../${step.screenshot})` : '';
      },
    );

    const mdFile = path.join(guideDir, `guide.${lang}.md`);
    await writeFile(mdFile, markdown, 'utf8');
    written.push(mdFile);

    const htmlFile = path.join(guideDir, `guide.${lang}.html`);
    await writeFile(htmlFile, await renderHtml(markdown, lang), 'utf8');
    written.push(htmlFile);
  }
  return written;
}

async function renderHtml(markdown: string, lang: string): Promise<string> {
  const body = await marked.parse(markdown);
  const dir = RTL_LANGS.has(lang.toLowerCase()) ? 'rtl' : 'ltr';
  const title = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? 'User Guide').trim();
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.7;
         max-width: 860px; margin: 0 auto; padding: 2rem 1.25rem; color: #1c1c1e; background: #fff; }
  h1 { border-bottom: 3px solid #ff3b30; padding-bottom: .4rem; }
  h2, h3 { margin-top: 2rem; }
  img { max-width: 100%; border: 1px solid #d1d1d6; border-radius: 10px;
        box-shadow: 0 2px 10px rgba(0,0,0,.08); margin: .75rem 0; }
  ol li, ul li { margin: .5rem 0; }
  code { background: #f2f2f7; border-radius: 4px; padding: .1rem .35rem; }
  blockquote { border-inline-start: 4px solid #ff3b30; margin: 1rem 0; padding: .25rem 1rem; color: #48484a; background: #fff5f5; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eaeaea; }
    img { border-color: #333; }
    code { background: #222; }
    blockquote { background: #1d1416; color: #c7c7cc; }
  }
</style>
</head>
<body>
${body}
<hr>
<p style="color:#8e8e93;font-size:.85rem">Generated by FlowScribe — recorded with Playwright, written by Gemini.</p>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
