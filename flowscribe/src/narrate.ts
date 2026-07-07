import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { geminiGenerate, parseJsonResponse } from './gemini.js';
import { languageName } from './generator.js';
import { loadSession, stepsAsText } from './session.js';

export interface NarrateOptions {
  sessionDir: string;
  lang: string;
  model?: string;
}

interface Cue {
  startMs: number;
  endMs: number;
  line: string;
}

/**
 * Generate a voiceover script (to read aloud while re-recording a how-to
 * video) plus an .srt subtitle file timed to the original recording.
 */
export async function narrate(opts: NarrateOptions): Promise<string[]> {
  const sessionDir = path.resolve(opts.sessionDir);
  const session = await loadSession(sessionDir);
  const langName = languageName(opts.lang);
  const durationMs =
    session.durationMs ??
    (session.steps.at(-1)?.timeOffsetMs ?? 10000) + 3000;

  const prompt = [
    `You are writing the voiceover for a screen-recorded tutorial video of a web application.`,
    '',
    `Application: ${session.appTitle ?? session.startUrl}`,
    `Video duration: ${(durationMs / 1000).toFixed(1)} seconds.`,
    '',
    'Actions in the video, with their timestamps:',
    stepsAsText(session),
    '',
    `Write the narration in ${langName}. Rules:`,
    '- Friendly, clear tutorial tone, addressed to the viewer ("you").',
    '- One cue per moment: start with a short intro cue at t=0, then one cue per action (or per small group of actions), timed to the action timestamps, and a short outro cue at the end.',
    '- Each cue must be comfortably readable aloud in its time window (max ~15 words per 5 seconds).',
    '- Never reveal passwords or masked values.',
    `- Cue start/end times must be within 0 and ${durationMs} milliseconds, in order, non-overlapping.`,
    '',
    'Return ONLY a JSON array of objects: [{"startMs": number, "endMs": number, "line": string}, ...]',
  ].join('\n');

  const response = await geminiGenerate({ prompt, json: true, model: opts.model });
  let cues = parseJsonResponse<Cue[]>(response)
    .filter((c) => typeof c.line === 'string' && c.line.trim().length > 0)
    .map((c) => ({
      startMs: Math.max(0, Math.round(c.startMs)),
      endMs: Math.min(durationMs + 5000, Math.round(c.endMs)),
      line: c.line.trim(),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  // Repair overlaps / inverted cues so the SRT is always valid.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (cue.endMs <= cue.startMs) cue.endMs = cue.startMs + 2500;
    const next = cues[i + 1];
    if (next && cue.endMs > next.startMs) cue.endMs = next.startMs;
  }
  cues = cues.filter((c) => c.endMs > c.startMs);
  if (cues.length === 0) throw new Error('Gemini returned no usable narration cues.');

  const outDir = path.join(sessionDir, 'narration');
  await mkdir(outDir, { recursive: true });

  const srt = cues
    .map(
      (c, i) =>
        `${i + 1}\n${msToSrt(c.startMs)} --> ${msToSrt(c.endMs)}\n${c.line}\n`,
    )
    .join('\n');
  const srtFile = path.join(outDir, `narration.${opts.lang}.srt`);
  await writeFile(srtFile, srt, 'utf8');

  const md = [
    `# Voiceover script (${langName})`,
    '',
    `Recorded flow: **${session.name}** — video length ~${Math.round(durationMs / 1000)}s.`,
    'Read each line when its timestamp comes up. The matching subtitles are in the .srt file.',
    '',
    ...cues.map((c) => `- **[${msToClock(c.startMs)}]** ${c.line}`),
    '',
  ].join('\n');
  const mdFile = path.join(outDir, `narration.${opts.lang}.md`);
  await writeFile(mdFile, md, 'utf8');

  return [mdFile, srtFile];
}

function msToSrt(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = Math.floor(ms % 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(frac, 3)}`;
}

function msToClock(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}
