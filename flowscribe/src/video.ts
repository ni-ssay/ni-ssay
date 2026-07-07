import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionData } from './types.js';

/**
 * Post-recording video synthesis.
 *
 * Live screencast recording makes the browser feel laggy (the page renders
 * through an emulation + frame-capture pipeline), so by default FlowScribe
 * records nothing during the session and builds a step-by-step video
 * afterwards from the click screenshots — each frame held for as long as
 * the step really took. Uses Playwright's bundled ffmpeg (JPEG in, VP8 out).
 */

export function findFfmpeg(): string | null {
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);

  const roots: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const home = os.homedir();
  if (process.platform === 'win32') {
    roots.push(
      path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright'),
    );
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  } else {
    roots.push(path.join(home, '.cache', 'ms-playwright'));
  }

  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of entries) {
      if (!dir.isDirectory() || !dir.name.startsWith('ffmpeg')) continue;
      try {
        const inner = readdirSync(path.join(root, dir.name));
        const exe = inner.find((f) => f.startsWith('ffmpeg'));
        if (exe) candidates.push(path.join(root, dir.name, exe));
      } catch {
        /* skip */
      }
    }
  }
  candidates.push('ffmpeg'); // system install, last resort

  for (const c of candidates) {
    try {
      if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) return c;
    } catch {
      /* not runnable */
    }
  }
  return null;
}

const FPS = 4;

/**
 * Build video/recording.webm from the session's step screenshots.
 * Returns the session-relative path, or null when it can't be built.
 */
export async function slideshowFromScreenshots(
  sessionDir: string,
  session: SessionData,
): Promise<string | null> {
  const shots = session.steps.filter((s) => s.screenshot);
  if (shots.length === 0) return null;

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.warn('ffmpeg not found — skipping step video (set FFMPEG_PATH to enable).');
    return null;
  }

  const outRel = path.join('video', 'recording.webm');
  const out = path.join(sessionDir, outRel);
  const args = [
    '-y',
    '-f', 'image2pipe',
    // Playwright's minimal ffmpeg build can't probe the pipe's codec —
    // declare the JPEG input explicitly or it sees "Video: none".
    '-c:v', 'mjpeg',
    '-framerate', String(FPS),
    '-i', 'pipe:0',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libvpx',
    '-b:v', '1M',
    '-pix_fmt', 'yuv420p',
    out,
  ];

  const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  // Never let a wedged encoder hang the recorder's stop().
  const killer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
  const done = new Promise<number>((resolve) => {
    proc.on('error', () => resolve(-1));
    proc.on('close', (code) => resolve(code ?? -1));
  }).finally(() => clearTimeout(killer));

  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (proc.stdin.write(chunk)) resolve();
      else {
        proc.stdin.once('drain', resolve);
        proc.stdin.once('error', reject);
      }
    });

  try {
    for (let i = 0; i < shots.length; i++) {
      const buf = await readFile(path.join(sessionDir, shots[i].screenshot!));
      // Hold each frame for as long as the step really took (clamped).
      const nextMs = shots[i + 1]?.timeOffsetMs ?? shots[i].timeOffsetMs + 3000;
      const seconds = Math.min(6, Math.max(1, (nextMs - shots[i].timeOffsetMs) / 1000));
      const repeats = Math.max(1, Math.round(seconds * FPS));
      for (let r = 0; r < repeats; r++) await write(buf);
    }
    proc.stdin.end();
  } catch {
    proc.kill();
  }

  const code = await done;
  if (code !== 0) {
    console.warn('Step video synthesis failed:\n' + stderr.split('\n').slice(-3).join('\n'));
    return null;
  }
  return outRel.split(path.sep).join('/');
}
