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
              dir: path.relative(root, full),
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
    const out: Array<{ path: string; size: number }> = [];
    const walk = async (d: string, depth: number) => {
      if (depth > 3) return;
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else {
          const { statSync } = await import('node:fs');
          out.push({ path: path.relative(root, full), size: statSync(full).size });
        }
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
            ? { url: recording.url, out: path.relative(root, recording.out) }
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
        return send(200, { ok: true, out: path.relative(root, out) });
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
              return [path.relative(root, f)];
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
              return files.map((f) => path.relative(root, f));
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
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f2f2f7; color: #1c1c1e; }
  @media (prefers-color-scheme: dark) {
    body { background: #101014; color: #ececf1; }
    .card, header, .job { background: #1b1b21 !important; }
    input, select { background: #2a2a31; color: #ececf1; border-color: #3a3a44 !important; }
    button { background: #33333c; color: #ececf1; }
  }
  header { position: sticky; top: 0; z-index: 10; background: #fff; padding: .8rem 1.4rem;
           display: flex; align-items: center; gap: 1rem; box-shadow: 0 1px 8px rgba(0,0,0,.12); }
  header h1 { font-size: 1.15rem; margin: 0; } header h1 span { color: #ff3b30; }
  #keyState { margin-left: auto; font-size: .8rem; display: flex; align-items: center; gap: .5rem; }
  main { max-width: 1020px; margin: 0 auto; padding: 1.2rem; display: grid; gap: 1rem; }
  .card { background: #fff; border-radius: 14px; padding: 1.1rem 1.3rem; box-shadow: 0 1px 5px rgba(0,0,0,.07); }
  h2 { font-size: 1rem; margin: 0 0 .7rem; }
  input[type=text], input[type=password], select {
    font: inherit; border: 1px solid #d1d1d6; border-radius: 8px; padding: .45rem .6rem; }
  button { font: inherit; border: 0; border-radius: 9px; padding: .5rem .95rem; cursor: pointer; background: #e8e8ed; }
  button:hover { filter: brightness(.96); }
  button.primary { background: #ff3b30; color: #fff; font-weight: 600; }
  button.small { padding: .32rem .7rem; font-size: .82rem; }
  button:disabled { opacity: .45; cursor: default; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: .35rem 0; }
  .row label { font-size: .82rem; display: flex; align-items: center; gap: .3rem; }
  #recBanner { display: none; background: #ff3b30; color: #fff; border-radius: 12px;
               padding: .9rem 1.2rem; align-items: center; gap: 1rem; font-weight: 600; }
  #recBanner .pulse { width: 12px; height: 12px; border-radius: 50%; background: #fff; animation: pulse 1.1s infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .session { border-top: 1px solid rgba(128,128,128,.18); padding: .85rem 0; }
  .session:first-of-type { border-top: 0; }
  .s-head { display: flex; align-items: baseline; gap: .7rem; flex-wrap: wrap; }
  .s-head b { font-size: .98rem; }
  .meta { font-size: .78rem; opacity: .65; }
  .badge { font-size: .68rem; font-weight: 700; padding: .12rem .5rem; border-radius: 999px; background: #e8e8ed; }
  @media (prefers-color-scheme: dark) { .badge { background: #33333c; } }
  .actions { display: flex; gap: .45rem; flex-wrap: wrap; margin-top: .55rem; align-items: center; }
  .opt { display: none; gap: .5rem; align-items: center; flex-wrap: wrap; margin-top: .5rem;
         padding: .6rem; border-radius: 10px; background: rgba(128,128,128,.09); font-size: .85rem; }
  .opt.show { display: flex; }
  .opt input[type=text] { width: 7.5rem; padding: .3rem .5rem; }
  .files { display: none; margin-top: .5rem; font-size: .84rem; }
  .files.show { display: block; }
  .files a { display: inline-block; margin: .15rem .6rem .15rem 0; }
  .job { background: #fff; border-radius: 10px; padding: .6rem .9rem; margin-top: .5rem; font-size: .84rem; }
  .job .st { font-weight: 700; }
  .job .st.running { color: #ff9500; } .job .st.done { color: #34c759; } .job .st.error { color: #ff3b30; }
  .job pre { margin: .4rem 0 0; max-height: 150px; overflow: auto; font-size: .75rem;
             background: rgba(128,128,128,.1); padding: .5rem; border-radius: 8px; white-space: pre-wrap; }
  .job a { margin-right: .6rem; }
  .empty { opacity: .6; font-size: .88rem; }
</style>
</head>
<body>
<header>
  <h1>Flow<span>Scribe</span> Studio</h1>
  <div id="keyState"></div>
</header>
<main>
  <div id="recBanner">
    <div class="pulse"></div>
    <div style="flex:1">Recording — interact with the opened browser window, then stop here (or just close that browser).</div>
    <button onclick="stopRec()" style="background:#fff;color:#ff3b30">⏹ Stop recording</button>
  </div>

  <div class="card" id="recCard">
    <h2>🎬 New recording</h2>
    <div class="row">
      <input type="text" id="recUrl" placeholder="https://your-app.com" style="flex:1;min-width:16rem">
      <input type="text" id="recName" placeholder="session name (optional)" style="width:12rem">
      <button class="primary" onclick="startRec()">⏺ Start recording</button>
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
let state = { sessions: [], jobs: [], recording: null, hasKey: false };
const openOpts = {};

async function api(pathname, body) {
  const res = await fetch(pathname, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || ('Request failed: ' + res.status)); throw new Error(data.error || res.status); }
  return data;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function refresh() {
  try { state = await (await fetch('/api/state')).json(); } catch (e) { return; }
  renderKey(); renderRec(); renderSessions(); renderJobs();
}

function renderKey() {
  const el = document.getElementById('keyState');
  el.innerHTML = state.hasKey
    ? '<span>🔑 Gemini key set</span>'
    : '<input type="password" id="keyInput" placeholder="GEMINI_API_KEY (for AI features)" style="width:15rem">' +
      '<button class="small" onclick="saveKey()">Save</button>';
}
async function saveKey() {
  const v = document.getElementById('keyInput').value;
  if (!v) return;
  await api('/api/key', { key: v });
  refresh();
}

function renderRec() {
  document.getElementById('recBanner').style.display = state.recording ? 'flex' : 'none';
  document.getElementById('recCard').style.display = state.recording ? 'none' : 'block';
}
async function startRec() {
  const url = document.getElementById('recUrl').value.trim();
  if (!url) { alert('Enter the URL of the app to record.'); return; }
  await api('/api/record/start', {
    url: /^https?:/.test(url) ? url : 'https://' + url,
    name: document.getElementById('recName').value.trim(),
    user: document.getElementById('recUser').value.trim(),
    pass: document.getElementById('recPass').value,
  });
  refresh();
}
async function stopRec() { await api('/api/record/stop', {}); refresh(); }

function toggleOpt(id) {
  openOpts[id] = !openOpts[id];
  document.getElementById(id).classList.toggle('show', openOpts[id]);
}

function renderSessions() {
  const host = document.getElementById('sessions');
  if (!state.sessions.length) {
    host.innerHTML = '<p class="empty">No sessions yet — record one above.</p>';
    return;
  }
  host.innerHTML = state.sessions.map((s, i) => {
    const gid = 'g' + i, nid = 'n' + i, fid = 'f' + i;
    const dur = s.durationMs ? Math.round(s.durationMs / 1000) + 's' : '';
    return '<div class="session">' +
      '<div class="s-head"><b>' + esc(s.name) + '</b>' +
      '<span class="meta">' + esc((s.startedAt || '').replace('T', ' ').slice(0, 19)) + ' · ' + s.steps + ' steps · ' + dur + '</span>' +
      (s.videos ? '<span class="badge">🎞 video</span>' : '') +
      (s.assertions ? '<span class="badge">✅ ' + s.assertions + ' assertions</span>' : '') +
      (s.healed ? '<span class="badge">🩹 healed</span>' : '') +
      (s.hasGuide ? '<span class="badge">📘 guide</span>' : '') +
      '</div>' +
      '<div class="actions">' +
      '<button class="small" onclick="editSession(\\'' + esc(s.dir) + '\\')">✎ Edit steps</button>' +
      '<button class="small" onclick="toggleOpt(\\'' + gid + '\\')">📘 Guide…</button>' +
      '<button class="small" onclick="job(\\'assert\\', \\'' + esc(s.dir) + '\\')" ' + (state.hasKey ? '' : 'disabled title="Set your Gemini key first"') + '>✅ Suggest assertions</button>' +
      '<button class="small" onclick="job(\\'replay\\', \\'' + esc(s.dir) + '\\', { headed: true })">▶ Replay (watch)</button>' +
      '<button class="small" onclick="job(\\'replay\\', \\'' + esc(s.dir) + '\\', {})">🤖 Replay (headless)</button>' +
      '<button class="small" onclick="job(\\'export-test\\', \\'' + esc(s.dir) + '\\')">🧪 Export test</button>' +
      '<button class="small" onclick="toggleOpt(\\'' + nid + '\\')">🎙 Narrate…</button>' +
      '<button class="small" onclick="showFiles(\\'' + esc(s.dir) + '\\', \\'' + fid + '\\')">📂 Files</button>' +
      '</div>' +
      '<div class="opt' + (openOpts[gid] ? ' show' : '') + '" id="' + gid + '">' +
      'Languages <input type="text" id="' + gid + 'l" value="en" title="comma-separated: en,fr,ar">' +
      '<label><input type="checkbox" id="' + gid + 'v" checked> vision</label>' +
      '<label><input type="checkbox" id="' + gid + 'p"> PDF</label>' +
      '<label><input type="checkbox" id="' + gid + 'd"> DOCX</label>' +
      '<button class="small primary" onclick="genGuide(\\'' + esc(s.dir) + '\\', \\'' + gid + '\\')" ' + (state.hasKey ? '' : 'disabled title="Set your Gemini key first"') + '>Generate</button>' +
      '</div>' +
      '<div class="opt' + (openOpts[nid] ? ' show' : '') + '" id="' + nid + '">' +
      'Language <input type="text" id="' + nid + 'l" value="en">' +
      '<label><input type="checkbox" id="' + nid + 't"> TTS voiceover</label>' +
      '<label><input type="checkbox" id="' + nid + 'm"> mux onto video</label>' +
      '<button class="small primary" onclick="narrateS(\\'' + esc(s.dir) + '\\', \\'' + nid + '\\')" ' + (state.hasKey ? '' : 'disabled title="Set your Gemini key first"') + '>Narrate</button>' +
      '</div>' +
      '<div class="files' + (openOpts[fid] ? ' show' : '') + '" id="' + fid + '"></div>' +
      '</div>';
  }).join('');
}

async function editSession(dir) {
  const { url } = await api('/api/editor', { dir: dir });
  window.open(url, '_blank');
}
async function job(cmd, dir, opts) {
  await api('/api/job', { cmd: cmd, dir: dir, opts: opts || {} });
  refresh();
}
function genGuide(dir, gid) {
  job('generate', dir, {
    langs: document.getElementById(gid + 'l').value,
    vision: document.getElementById(gid + 'v').checked,
    pdf: document.getElementById(gid + 'p').checked,
    docx: document.getElementById(gid + 'd').checked,
  });
}
function narrateS(dir, nid) {
  job('narrate', dir, {
    lang: document.getElementById(nid + 'l').value || 'en',
    tts: document.getElementById(nid + 't').checked,
    mux: document.getElementById(nid + 'm').checked,
  });
}
async function showFiles(dir, fid) {
  openOpts[fid] = !openOpts[fid];
  const el = document.getElementById(fid);
  el.classList.toggle('show', openOpts[fid]);
  if (!openOpts[fid]) return;
  const files = await api('/api/files?dir=' + encodeURIComponent(dir));
  el.innerHTML = files.length
    ? files.map((f) =>
        '<a href="/file?path=' + encodeURIComponent(f.path) + '" target="_blank">' +
        esc(f.path.split('/').slice(-2).join('/')) + '</a>').join('')
    : '<span class="empty">No files.</span>';
}

function renderJobs() {
  const host = document.getElementById('jobs');
  if (!state.jobs.length) { host.innerHTML = '<p class="empty">Nothing running.</p>'; return; }
  host.innerHTML = state.jobs.map((j) =>
    '<div class="job">' +
    '<span class="st ' + j.status + '">' + (j.status === 'running' ? '⏳' : j.status === 'done' ? '✔' : j.status === 'error' ? '✘' : '·') + ' ' + j.status + '</span> ' +
    esc(j.label) +
    (j.outputs && j.outputs.length
      ? '<div>' + j.outputs.map((o) =>
          '<a href="/file?path=' + encodeURIComponent(o) + '" target="_blank">' + esc(o.split('/').pop()) + '</a>').join('') + '</div>'
      : '') +
    (j.log && j.log.length ? '<pre>' + esc(j.log.join('\\n')) + '</pre>' : '') +
    '</div>').join('');
}

refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>`;
