import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { geminiGenerate, geminiTtsPcm, parseJsonResponse, pcmToWav } from './gemini.js';
import { languageName } from './generator.js';
import { loadSession, stepsAsText } from './session.js';

export interface NarrateOptions {
  sessionDir: string;
  lang: string;
  model?: string;
  /** Also synthesize the narration as audio (Gemini TTS → .wav). */
  tts?: boolean;
  /** Prebuilt Gemini voice name for TTS. */
  voice?: string;
  /** Mux the TTS audio onto the recorded session video (needs ffmpeg). */
  mux?: boolean;
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
  const outputs = [mdFile, srtFile];

  if (opts.tts || opts.mux) {
    // Per-cue synthesis so each spoken line lands exactly at its timestamp.
    const pcms: Buffer[] = [];
    let rate = 24000;
    for (let i = 0; i < cues.length; i++) {
      console.log(`Synthesizing cue ${i + 1}/${cues.length} with Gemini TTS...`);
      const res = await geminiTtsPcm({
        text:
          'Read this single tutorial narration line in a clear, friendly voice: ' +
          cues[i].line,
        voice: opts.voice,
      });
      pcms.push(res.pcm);
      rate = res.rate;
    }
    const { pcm, placements } = assembleAlignedPcm(
      cues.map((c, i) => ({ startMs: c.startMs, pcm: pcms[i] })),
      rate,
    );
    const wavFile = path.join(outDir, `narration.${opts.lang}.wav`);
    await writeFile(wavFile, pcmToWav(pcm, rate));
    outputs.push(wavFile);

    // Re-time the subtitles to the actual audio placement so the .srt
    // matches the synthesized voice exactly.
    const srtAligned = cues
      .map(
        (c, i) =>
          `${i + 1}\n${msToSrt(placements[i].startMs)} --> ${msToSrt(placements[i].endMs)}\n${c.line}\n`,
      )
      .join('\n');
    await writeFile(srtFile, srtAligned, 'utf8');

    if (opts.mux) {
      const video = session.videos[0]
        ? path.join(sessionDir, session.videos[0])
        : null;
      if (!video || !existsSync(video)) {
        console.warn('No session video found — skipping mux.');
      } else {
        const muxFile = path.join(outDir, `howto.${opts.lang}.webm`);
        const muxed = await muxAudio(video, wavFile, srtFile, muxFile);
        if (muxed) outputs.push(muxFile);
      }
    }
  }

  return outputs;
}

/**
 * Lay per-cue PCM clips onto a single silent-padded track so each clip
 * starts at (or as close as possible after) its cue's timestamp.
 * Returns the combined PCM and where each cue actually landed.
 */
export function assembleAlignedPcm(
  cues: Array<{ startMs: number; pcm: Buffer }>,
  rate: number,
): { pcm: Buffer; placements: Array<{ startMs: number; endMs: number }> } {
  const bytesPerMs = (rate * 2) / 1000; // 16-bit mono
  const chunks: Buffer[] = [];
  const placements: Array<{ startMs: number; endMs: number }> = [];
  let cursorBytes = 0;

  for (const cue of cues) {
    const cursorMs = cursorBytes / bytesPerMs;
    const gapMs = cue.startMs - cursorMs;
    if (gapMs > 0) {
      // Round to a whole sample so the stream stays 16-bit aligned.
      const gapBytes = 2 * Math.round((gapMs * bytesPerMs) / 2);
      chunks.push(Buffer.alloc(gapBytes));
      cursorBytes += gapBytes;
    }
    const startMs = cursorBytes / bytesPerMs;
    chunks.push(cue.pcm);
    cursorBytes += cue.pcm.length;
    placements.push({
      startMs: Math.round(startMs),
      endMs: Math.round(cursorBytes / bytesPerMs),
    });
  }
  return { pcm: Buffer.concat(chunks), placements };
}

/**
 * Mux the narration audio (and soft subtitles when the container allows)
 * onto the session video using ffmpeg. Playwright's bundled ffmpeg has no
 * audio encoders, so a real ffmpeg is required (FFMPEG_PATH or on PATH);
 * otherwise the exact command is printed for the user to run elsewhere.
 */
async function muxAudio(
  video: string,
  wav: string,
  srt: string,
  out: string,
): Promise<boolean> {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const args = [
    '-y',
    '-i', video,
    '-i', wav,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'libopus',
    '-shortest',
    out,
  ];
  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (code !== 0) console.warn(stderr.split('\n').slice(-4).join('\n'));
      resolve(code === 0);
    });
  });
  if (!ok) {
    console.warn(
      '\nffmpeg with audio support not found (or mux failed). Run this yourself:\n' +
        `  ffmpeg -i "${video}" -i "${wav}" -map 0:v -map 1:a -c:v copy -shortest "${out}"\n` +
        `  # burn subtitles too: add  -vf "subtitles=${srt}"  (re-encodes video)`,
    );
  }
  return ok;
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
