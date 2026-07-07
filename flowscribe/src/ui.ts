import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { record, type RecordingHandle } from './recorder.js';
import { generateGuides } from './generator.js';
import { suggestAssertions } from './assertions.js';
import { replay } from './replay.js';
import { exportTest } from './exportTest.js';
import { narrate } from './narrate.js';
import { startEditor } from './editor.js';
import { SESSION_FILE, type SessionData } from './types.js';

/**
 * FlowScribe Studio — a local web dashboard that drives everything:
 * record, edit, generate guides (any language/format), suggest assertions,
 * replay with self-healing, export tests, narrate, and browse artifacts.
 * Zero extra dependencies; runs with `npm start`.
 */

export interface UiOptions {
  port?: number;
  /** Root folder where sessions live / are created. */
  sessionsRoot?: string;
}

interface Job {
  id: number;
  label: string;
  status: 'queued' | 'running' | 'done' | 'error';
  log: string[];
  outputs: string[];
  startedAt: string;
  endedAt?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.srt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.ts': 'text/plain; charset=utf-8',
};

export async function startUi(opts: UiOptions = {}): Promise<http.Server> {
  const root = process.cwd();
  const sessionsRoot = path.resolve(opts.sessionsRoot ?? 'sessions');
  await loadDotEnv(path.join(root, '.env'));

  // Always hand paths to the client with forward slashes — Windows
  // backslashes get mangled the moment they touch JS string handling.
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');

  let recording: { handle: RecordingHandle; url: string; out: string } | null = null;
  const editors = new Map<string, string>(); // session dir -> editor url
  const jobs: Job[] = [];
  let jobSeq = 0;
  let jobChain: Promise<void> = Promise.resolve();

  const pushJob = (label: string, fn: (log: (s: string) => void) => Promise<string[]>): Job => {
    const job: Job = {
      id: ++jobSeq,
      label,
      status: 'queued',
      log: [],
      outputs: [],
      startedAt: new Date().toISOString(),
    };
    jobs.unshift(job);
    if (jobs.length > 30) jobs.pop();
    jobChain = jobChain.then(async () => {
      job.status = 'running';
      const log = (s: string) => job.log.push(s);
      const orig = { log: console.log, error: console.error, warn: console.warn };
      console.log = (...a: unknown[]) => log(a.map(String).join(' '));
      console.error = (...a: unknown[]) => log(a.map(String).join(' '));
      console.warn = (...a: unknown[]) => log(a.map(String).join(' '));
      try {
        job.outputs = await fn(log);
        job.status = 'done';
      } catch (err) {
        job.log.push(`Error: ${(err as Error).message}`);
        job.status = 'error';
      } finally {
        Object.assign(console, orig);
        job.endedAt = new Date().toISOString();
      }
    });
    return job;
  };

  const listSessions = async () => {
    const out: Array<Record<string, unknown>> = [];
    const scan = async (dir: string, depth: number) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (existsSync(path.join(full, SESSION_FILE))) {
          try {
            const s = JSON.parse(
              await readFile(path.join(full, SESSION_FILE), 'utf8'),
            ) as SessionData;
            out.push({
              dir: rel(full),
              name: s.name,
              startedAt: s.startedAt,
              steps: s.steps.length,
              durationMs: s.durationMs ?? 0,
              videos: s.videos.length,
              assertions: s.assertions?.length ?? 0,
              healed: s.steps.filter((st) => st.healed).length,
              hasGuide: existsSync(path.join(full, 'guide')),
              hasNarration: existsSync(path.join(full, 'narration')),
            });
          } catch {
            /* unreadable session — skip */
          }
        } else if (depth < 2) {
          await scan(full, depth + 1);
        }
      }
    };
    await scan(sessionsRoot, 0);
    out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return out;
  };

  const listFiles = async (dir: string) => {
    const { statSync } = await import('node:fs');
    const out: Array<{ path: string; size: number }> = [];
    const walk = async (d: string, depth: number) => {
      if (depth > 3) return;
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else out.push({ path: rel(full), size: statSync(full).size });
      }
    };
    await walk(dir, 0);
    return out;
  };

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = url.searchParams;

      if (req.method === 'GET' && url.pathname === '/') {
        return send(200, UI_HTML, 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(200, {
          recording: recording
            ? { url: recording.url, out: rel(recording.out) }
            : null,
          hasKey: !!process.env.GEMINI_API_KEY,
          sessions: await listSessions(),
          jobs: jobs.map((j) => ({ ...j, log: j.log.slice(-40) })),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/key') {
        const { key } = JSON.parse(await readBody(req)) as { key: string };
        if (key && key.trim()) {
          process.env.GEMINI_API_KEY = key.trim();
          // Persist for next time (.env is gitignored).
          const envFile = path.join(root, '.env');
          const existing = existsSync(envFile) ? await readFile(envFile, 'utf8') : '';
          if (!/^GEMINI_API_KEY=/m.test(existing)) {
            await appendFile(envFile, `\nGEMINI_API_KEY=${key.trim()}\n`);
          } else {
            await writeFile(
              envFile,
              existing.replace(/^GEMINI_API_KEY=.*$/m, `GEMINI_API_KEY=${key.trim()}`),
            );
          }
        }
        return send(200, { ok: true, hasKey: !!process.env.GEMINI_API_KEY });
      }

      if (req.method === 'POST' && url.pathname === '/api/record/start') {
        if (recording) return send(409, { error: 'Already recording.' });
        const body = JSON.parse(await readBody(req)) as {
          url: string; name?: string; user?: string; pass?: string;
        };
        if (!body.url) return send(400, { error: 'URL is required.' });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const out = path.join(sessionsRoot, body.name?.trim() || stamp);
        const handle = await record({
          url: body.url,
          out,
          name: body.name?.trim() || undefined,
          user: body.user || undefined,
          pass: body.pass || undefined,
        });
        recording = { handle, url: body.url, out };
        void handle.done.then(() => { recording = null; });
        return send(200, { ok: true, out: rel(out) });
      }

      if (req.method === 'POST' && url.pathname === '/api/record/stop') {
        if (!recording) return send(200, { ok: true });
        const session = await recording.handle.stop();
        recording = null;
        return send(200, { ok: true, steps: session.steps.length });
      }

      if (req.method === 'POST' && url.pathname === '/api/editor') {
        const { dir } = JSON.parse(await readBody(req)) as { dir: string };
        const full = safePath(root, dir);
        let editorUrl = editors.get(full);
        if (!editorUrl) {
          const editor = await startEditor({ sessionDir: full, port: 0 });
          const addr = editor.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          editorUrl = `http://localhost:${port}/`;
          editors.set(full, editorUrl);
        }
        return send(200, { url: editorUrl });
      }

      if (req.method === 'POST' && url.pathname === '/api/job') {
        const body = JSON.parse(await readBody(req)) as {
          cmd: string; dir: string; opts?: Record<string, unknown>;
        };
        const dir = safePath(root, body.dir);
        const o = body.opts ?? {};
        const name = path.basename(dir);
        let job: Job;
        switch (body.cmd) {
          case 'generate':
            job = pushJob(`Generate guide — ${name}`, () =>
              generateGuides({
                sessionDir: dir,
                langs: String(o.langs || 'en').split(',').map((l) => l.trim()).filter(Boolean),
                vision: !!o.vision,
                pdf: !!o.pdf,
                docx: !!o.docx,
              }),
            );
            break;
          case 'assert':
            job = pushJob(`Suggest assertions — ${name}`, async (log) => {
              const a = await suggestAssertions({ sessionDir: dir, vision: true });
              a.forEach((x) => log(`after step ${x.afterStep}: expect "${x.text}" visible`));
              return [];
            });
            break;
          case 'replay':
            job = pushJob(`Replay — ${name}`, async () => {
              const r = await replay({
                sessionDir: dir,
                headless: !o.headed,
                slowMo: o.headed ? 250 : 0,
              });
              if (r.failed > 0 || r.assertionsFailed > 0) {
                throw new Error(`${r.failed} step(s) / ${r.assertionsFailed} assertion(s) failed.`);
              }
              return [];
            });
            break;
          case 'export-test':
            job = pushJob(`Export Playwright test — ${name}`, async () => {
              const f = await exportTest({ sessionDir: dir });
              return [rel(f)];
            });
            break;
          case 'narrate':
            job = pushJob(`Narrate (${o.lang || 'en'}) — ${name}`, async () => {
              const files = await narrate({
                sessionDir: dir,
                lang: String(o.lang || 'en'),
                tts: !!o.tts || !!o.mux,
                mux: !!o.mux,
                voice: o.voice ? String(o.voice) : undefined,
              });
              return files.map((f) => rel(f));
            });
            break;
          default:
            return send(400, { error: `Unknown command ${body.cmd}` });
        }
        return send(200, { id: job.id });
      }

      if (req.method === 'GET' && url.pathname === '/api/files') {
        const dir = safePath(root, q.get('dir') ?? '');
        return send(200, await listFiles(dir));
      }

      if (req.method === 'GET' && url.pathname === '/file') {
        const file = safePath(root, q.get('path') ?? '');
        if (!existsSync(file)) return send(404, { error: 'Not found' });
        const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        res.end(await readFile(file));
        return;
      }

      return send(404, { error: 'Not found' });
    } catch (err) {
      return send(500, { error: (err as Error).message });
    }
  });

  const port = opts.port ?? 4600;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

/** Resolve a user-supplied path and refuse anything outside the project. */
function safePath(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Path outside the project is not allowed.');
  }
  return full;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Tiny .env loader (KEY=value lines) so the API key survives restarts. */
async function loadDotEnv(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

/** Try to open the dashboard in the default browser (best effort). */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? { bin: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { bin: 'open', args: [url] }
        : { bin: 'xdg-open', args: [url] };
  try {
    spawn(cmd.bin, cmd.args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* user opens it manually */
  }
}

const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowScribe Studio</title>
<style>
  /* Theme tokens — every color goes through these, so light and dark are
     always consistent (the old sheet had dark overrides losing specificity
     against later base rules → invisible button labels). */
  :root {
    color-scheme: light dark;
    --bg: #f3f4f6;
    --card: #ffffff;
    --text: #17181c;
    --muted: #6b7280;
    --border: #e2e4e9;
    --border-strong: #cdd0d7;
    --btn: #ffffff;
    --btn-hover: #f4f5f7;
    --field: #ffffff;
    --panel: #f6f7f9;
    --accent: #ff3b30;
    --accent-soft: #ffe9e7;
    --ok: #1f9d55;
    --warn: #d97706;
    --shadow: 0 1px 3px rgba(16,18,24,.08), 0 4px 14px rgba(16,18,24,.05);
    --link: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e0f13;
      --card: #17181e;
      --text: #e9eaee;
      --muted: #9298a3;
      --border: #262832;
      --border-strong: #363945;
      --btn: #1f2129;
      --btn-hover: #272a34;
      --field: #1c1e26;
      --panel: #1c1e25;
      --accent: #ff453a;
      --accent-soft: #3a1512;
      --ok: #34c759;
      --warn: #ffb340;
      --shadow: 0 1px 3px rgba(0,0,0,.5);
      --link: #7aa2ff;
    }
  }

  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         background: var(--bg); color: var(--text); font-size: 15px; line-height: 1.5; }
  a { color: var(--link); }

  header { position: sticky; top: 0; z-index: 10; background: var(--card);
           border-bottom: 1px solid var(--border);
           padding: .75rem 1.4rem; display: flex; align-items: center; gap: 1rem; }
  header h1 { font-size: 1.1rem; margin: 0; letter-spacing: -.01em; }
  header h1 span { color: var(--accent); }
  header .sub { font-size: .78rem; color: var(--muted); margin-top: -2px; }
  #keyState { margin-left: auto; font-size: .82rem; display: flex; align-items: center; gap: .5rem; }
  .keychip { display: inline-flex; align-items: center; gap: .4rem; font-weight: 600;
             color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent);
             border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent);
             padding: .3rem .7rem; border-radius: 999px; }

  main { max-width: 980px; margin: 0 auto; padding: 1.3rem 1.2rem 3rem; display: grid; gap: 1.1rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px;
          padding: 1.15rem 1.35rem; box-shadow: var(--shadow); }
  h2 { font-size: .82rem; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
       color: var(--muted); margin: 0 0 .85rem; }

  input[type=text], input[type=password], select {
    font: inherit; color: var(--text); background: var(--field);
    border: 1px solid var(--border-strong); border-radius: 9px; padding: .5rem .65rem; }
  input::placeholder { color: var(--muted); }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  button { font: inherit; font-size: .86rem; color: var(--text); cursor: pointer;
           background: var(--btn); border: 1px solid var(--border-strong);
           border-radius: 9px; padding: .48rem .9rem;
           transition: background .12s, border-color .12s, transform .05s; }
  button:hover:not(:disabled) { background: var(--btn-hover); border-color: var(--accent); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 88%, black); }
  button.small { padding: .34rem .7rem; font-size: .8rem; }
  button:disabled { opacity: .4; cursor: not-allowed; }

  .row { display: flex; gap: .55rem; align-items: center; flex-wrap: wrap; margin: .4rem 0; }
  .row label { font-size: .82rem; display: flex; align-items: center; gap: .3rem; }
  .hint { font-size: .8rem; color: var(--muted); margin-top: .5rem; }

  #recBanner { display: none; background: linear-gradient(100deg, var(--accent), #d92c22);
               color: #fff; border-radius: 16px; padding: 1rem 1.3rem;
               align-items: center; gap: 1rem; font-weight: 600; box-shadow: var(--shadow); }
  #recBanner .pulse { width: 12px; height: 12px; border-radius: 50%; background: #fff;
                      animation: pulse 1.1s infinite; flex: none; }
  #recBanner button { background: #fff; border-color: #fff; color: var(--accent); font-weight: 700; }
  @keyframes pulse { 50% { opacity: .25; } }

  .session { border: 1px solid var(--border); border-radius: 13px;
             padding: .95rem 1.05rem; margin-bottom: .8rem; background: var(--card); }
  .session:last-child { margin-bottom: 0; }
  .s-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .15rem; }
  .s-head b { font-size: 1.02rem; letter-spacing: -.01em; }
  .meta { font-size: .78rem; color: var(--muted); }
  .badge { font-size: .68rem; font-weight: 700; padding: .14rem .55rem; border-radius: 999px;
           background: var(--panel); border: 1px solid var(--border); color: var(--muted); }

  .actions { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .6rem; align-items: center; }
  .opt { display: none; gap: .6rem; align-items: center; flex-wrap: wrap; margin-top: .6rem;
         padding: .65rem .8rem; border-radius: 10px; background: var(--panel);
         border: 1px solid var(--border); font-size: .85rem; }
  .opt.show { display: flex; }
  .opt input[type=text] { width: 7.5rem; padding: .32rem .55rem; }

  .files { display: none; margin-top: .6rem; font-size: .83rem; padding: .65rem .8rem;
           border-radius: 10px; background: var(--panel); border: 1px solid var(--border); }
  .files.show { display: block; }
  .files a { display: inline-block; margin: .14rem .7rem .14rem 0; }

  .job { border: 1px solid var(--border); background: var(--card); border-radius: 12px;
         padding: .65rem .95rem; margin-bottom: .55rem; font-size: .85rem; }
  .job:last-child { margin-bottom: 0; }
  .job .st { font-weight: 700; margin-right: .35rem; }
  .job .st.running { color: var(--warn); } .job .st.done { color: var(--ok); }
  .job .st.error { color: var(--accent); } .job .st.queued { color: var(--muted); }
  .job pre { margin: .45rem 0 0; max-height: 150px; overflow: auto; font-size: .74rem;
             font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
             background: var(--panel); border: 1px solid var(--border);
             padding: .55rem .65rem; border-radius: 8px; white-space: pre-wrap; color: var(--muted); }
  .job a { margin-right: .7rem; }

  .empty { color: var(--muted); font-size: .87rem; border: 1px dashed var(--border-strong);
           border-radius: 10px; padding: .8rem 1rem; margin: 0; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Flow<span>Scribe</span> Studio</h1>
    <div class="sub">record → guide → test → video, all local</div>
  </div>
  <div id="keyState"></div>
</header>
<main>
  <div id="recBanner">
    <div class="pulse"></div>
    <div style="flex:1">Recording — interact with the opened browser window, then stop here (or just close that browser).</div>
    <button id="stopBtn" style="background:#fff;color:#ff3b30">⏹ Stop recording</button>
  </div>

  <div class="card" id="recCard">
    <h2>🎬 New recording</h2>
    <div class="row">
      <input type="text" id="recUrl" placeholder="https://your-app.com" style="flex:1;min-width:16rem">
      <input type="text" id="recName" placeholder="session name (optional)" style="width:12rem">
      <button class="primary" id="startBtn">⏺ Start recording</button>
    </div>
    <div class="row">
      <input type="text" id="recUser" placeholder="basic-auth user (optional)" style="width:14rem">
      <input type="password" id="recPass" placeholder="basic-auth password" style="width:14rem">
    </div>
    <div class="meta">A real browser opens. Everything you do is captured — clicks get a red highlight ring, plus video and screenshots. No AI during recording.</div>
  </div>

  <div class="card">
    <h2>📼 Sessions</h2>
    <div id="sessions"><p class="empty">No sessions yet — record one above.</p></div>
  </div>

  <div class="card">
    <h2>⚙️ Jobs</h2>
    <div id="jobs"><p class="empty">Nothing running.</p></div>
  </div>
</main>
<script>
// All rendering is DOM-built with real event listeners — no data is ever
// interpolated into HTML/onclick strings (Windows paths contain backslashes
// that string-injection would destroy). Sections only re-render when their
// data actually changed, so typing in inputs is never wiped by the poll.
let state = { sessions: [], jobs: [], recording: null, hasKey: false };
const ui = { openPanels: {}, lastSessions: '', lastJobs: '', lastKey: null, lastRec: null };

async function api(pathname, body) {
  const res = await fetch(pathname, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || ('Request failed: ' + res.status)); throw new Error(data.error || res.status); }
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function btn(label, className, onClick, disabledTitle) {
  const b = el('button', className, label);
  b.addEventListener('click', onClick);
  if (disabledTitle) { b.disabled = true; b.title = disabledTitle; }
  return b;
}

async function refresh() {
  try { state = await (await fetch('/api/state')).json(); } catch (e) { return; }
  renderKey(); renderRec(); renderSessions(); renderJobs();
}

function renderKey() {
  if (ui.lastKey === state.hasKey) return;
  ui.lastKey = state.hasKey;
  const host = document.getElementById('keyState');
  host.innerHTML = '';
  if (state.hasKey) {
    host.appendChild(el('span', 'keychip', '🔑 Gemini connected'));
    return;
  }
  const input = el('input');
  input.type = 'password';
  input.placeholder = 'GEMINI_API_KEY (for AI features)';
  input.style.width = '15rem';
  const save = btn('Save', 'small', async () => {
    if (!input.value.trim()) return;
    await api('/api/key', { key: input.value.trim() });
    ui.lastKey = null; ui.lastSessions = '';
    refresh();
  });
  host.appendChild(input); host.appendChild(save);
}

function renderRec() {
  const active = !!state.recording;
  if (ui.lastRec === active) return;
  ui.lastRec = active;
  document.getElementById('recBanner').style.display = active ? 'flex' : 'none';
  document.getElementById('recCard').style.display = active ? 'none' : 'block';
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const url = document.getElementById('recUrl').value.trim();
  if (!url) { alert('Enter the URL of the app to record.'); return; }
  await api('/api/record/start', {
    url: /^https?:/.test(url) ? url : 'https://' + url,
    name: document.getElementById('recName').value.trim(),
    user: document.getElementById('recUser').value.trim(),
    pass: document.getElementById('recPass').value,
  });
  refresh();
});
document.getElementById('stopBtn').addEventListener('click', async () => {
  await api('/api/record/stop', {});
  ui.lastSessions = '';
  refresh();
});
document.getElementById('recUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('startBtn').click();
});

function renderSessions() {
  const snapshot = JSON.stringify([state.sessions, state.hasKey]);
  if (snapshot === ui.lastSessions) return;
  ui.lastSessions = snapshot;

  const host = document.getElementById('sessions');
  host.innerHTML = '';
  if (!state.sessions.length) {
    host.appendChild(el('p', 'empty', 'No sessions yet — record one above.'));
    return;
  }
  const needKey = state.hasKey ? null : 'Set your Gemini key first (top right)';

  state.sessions.forEach((s) => {
    const card = el('div', 'session');
    const head = el('div', 's-head');
    head.appendChild(el('b', '', s.name));
    const dur = s.durationMs ? Math.round(s.durationMs / 1000) + 's' : '';
    head.appendChild(el('span', 'meta',
      (s.startedAt || '').replace('T', ' ').slice(0, 19) + ' · ' + s.steps + ' steps' + (dur ? ' · ' + dur : '')));
    if (s.videos) head.appendChild(el('span', 'badge', '🎞 video'));
    if (s.assertions) head.appendChild(el('span', 'badge', '✅ ' + s.assertions + ' assertions'));
    if (s.healed) head.appendChild(el('span', 'badge', '🩹 healed'));
    if (s.hasGuide) head.appendChild(el('span', 'badge', '📘 guide'));
    card.appendChild(head);

    // --- option panels (persist open/closed across refresh by dir) ---
    const panelKey = (kind) => kind + ':' + s.dir;
    const panel = (kind) => {
      const p = el('div', 'opt' + (ui.openPanels[panelKey(kind)] ? ' show' : ''));
      p.dataset.panel = panelKey(kind);
      return p;
    };
    const toggle = (p) => {
      const key = p.dataset.panel;
      ui.openPanels[key] = !ui.openPanels[key];
      p.classList.toggle('show', ui.openPanels[key]);
    };

    const guidePanel = panel('guide');
    const gLangs = el('input'); gLangs.type = 'text'; gLangs.value = 'en'; gLangs.title = 'comma-separated: en,fr,ar';
    const gVision = el('input'); gVision.type = 'checkbox'; gVision.checked = true;
    const gPdf = el('input'); gPdf.type = 'checkbox';
    const gDocx = el('input'); gDocx.type = 'checkbox';
    guidePanel.append('Languages ', gLangs,
      labelWrap(gVision, 'vision'), labelWrap(gPdf, 'PDF'), labelWrap(gDocx, 'DOCX'),
      btn('Generate', 'small primary', () => job('generate', s.dir, {
        langs: gLangs.value, vision: gVision.checked, pdf: gPdf.checked, docx: gDocx.checked,
      }), needKey));

    const narratePanel = panel('narrate');
    const nLang = el('input'); nLang.type = 'text'; nLang.value = 'en';
    const nTts = el('input'); nTts.type = 'checkbox';
    const nMux = el('input'); nMux.type = 'checkbox';
    narratePanel.append('Language ', nLang,
      labelWrap(nTts, 'TTS voiceover'), labelWrap(nMux, 'mux onto video'),
      btn('Narrate', 'small primary', () => job('narrate', s.dir, {
        lang: nLang.value || 'en', tts: nTts.checked, mux: nMux.checked,
      }), needKey));

    const filesPanel = el('div', 'files' + (ui.openPanels[panelKey('files')] ? ' show' : ''));
    filesPanel.dataset.panel = panelKey('files');
    const loadFiles = async () => {
      const files = await api('/api/files?dir=' + encodeURIComponent(s.dir));
      filesPanel.innerHTML = '';
      if (!files.length) { filesPanel.appendChild(el('span', 'empty', 'No files.')); return; }
      files.forEach((f) => {
        const a = el('a', '', f.path.split('/').slice(-2).join('/'));
        a.href = '/file?path=' + encodeURIComponent(f.path);
        a.target = '_blank';
        filesPanel.appendChild(a);
      });
    };
    if (ui.openPanels[panelKey('files')]) loadFiles();

    // --- actions row ---
    const actions = el('div', 'actions');
    actions.append(
      btn('✎ Edit steps', 'small', async () => {
        const r = await api('/api/editor', { dir: s.dir });
        window.open(r.url, '_blank');
      }),
      btn('📘 Guide…', 'small', () => toggle(guidePanel)),
      btn('✅ Suggest assertions', 'small', () => job('assert', s.dir, {}), needKey),
      btn('▶ Replay (watch)', 'small', () => job('replay', s.dir, { headed: true })),
      btn('🤖 Replay (headless)', 'small', () => job('replay', s.dir, {})),
      btn('🧪 Export test', 'small', () => job('export-test', s.dir, {})),
      btn('🎙 Narrate…', 'small', () => toggle(narratePanel)),
      btn('📂 Files', 'small', () => { toggle(filesPanel); if (ui.openPanels[panelKey('files')]) loadFiles(); }),
    );
    card.appendChild(actions);
    card.appendChild(guidePanel);
    card.appendChild(narratePanel);
    card.appendChild(filesPanel);
    host.appendChild(card);
  });
}

function labelWrap(input, text) {
  const l = el('label');
  l.appendChild(input);
  l.append(' ' + text);
  return l;
}

async function job(cmd, dir, opts) {
  await api('/api/job', { cmd: cmd, dir: dir, opts: opts || {} });
  ui.lastJobs = '';
  refresh();
}

function renderJobs() {
  const snapshot = JSON.stringify(state.jobs);
  if (snapshot === ui.lastJobs) return;
  ui.lastJobs = snapshot;

  const host = document.getElementById('jobs');
  host.innerHTML = '';
  if (!state.jobs.length) {
    host.appendChild(el('p', 'empty', 'Nothing running.'));
    return;
  }
  state.jobs.forEach((j) => {
    const card = el('div', 'job');
    const icon = j.status === 'running' ? '⏳' : j.status === 'done' ? '✔' : j.status === 'error' ? '✘' : '·';
    card.appendChild(el('span', 'st ' + j.status, icon + ' ' + j.status));
    card.append(' ' + j.label);
    if (j.outputs && j.outputs.length) {
      const links = el('div');
      j.outputs.forEach((o) => {
        const a = el('a', '', o.split('/').pop());
        a.href = '/file?path=' + encodeURIComponent(o);
        a.target = '_blank';
        links.appendChild(a);
      });
      card.appendChild(links);
    }
    if (j.log && j.log.length) card.appendChild(el('pre', '', j.log.join('\\n')));
    host.appendChild(card);
  });
}

refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>`;
