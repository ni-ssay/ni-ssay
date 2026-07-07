import http from 'node:http';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadSession } from './session.js';
import { SESSION_FILE, type FlowAssertion, type RecordedStep } from './types.js';

export interface EditorOptions {
  sessionDir: string;
  port?: number;
}

/**
 * Serve a local step editor: review the recording with its screenshots,
 * delete misclicks, reorder steps, fix labels/values, redact secrets and
 * prune assertions — then save back to session.json (a one-time backup is
 * written to session.backup.json). Zero external dependencies, no AI.
 */
export async function startEditor(opts: EditorOptions): Promise<http.Server> {
  const sessionDir = path.resolve(opts.sessionDir);
  await loadSession(sessionDir); // fail fast if there is no session here
  const sessionFile = path.join(sessionDir, SESSION_FILE);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(EDITOR_HTML);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(await readFile(sessionFile, 'utf8'));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await readBody(req);
        const payload = JSON.parse(body) as {
          steps: RecordedStep[];
          assertions: FlowAssertion[];
        };
        const session = await loadSession(sessionDir);

        // Renumber steps and remap assertions from old to new indexes.
        const indexMap = new Map<number, number>();
        payload.steps.forEach((step, i) => {
          indexMap.set(step.index, i + 1);
          step.index = i + 1;
        });
        session.steps = payload.steps;
        session.assertions = payload.assertions
          .map((a) => ({ ...a, afterStep: indexMap.get(a.afterStep) ?? -1 }))
          .filter((a) => a.afterStep > 0);

        const backup = path.join(sessionDir, 'session.backup.json');
        if (!existsSync(backup)) await copyFile(sessionFile, backup);
        await writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, steps: session.steps.length }));
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/screenshots/')) {
        const file = path.join(
          sessionDir,
          'screenshots',
          path.basename(url.pathname),
        );
        if (!existsSync(file)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg',
        });
        res.end(await readFile(file));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  const port = opts.port ?? 4173;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const EDITOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowScribe — Step Editor</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f2f2f7; color: #1c1c1e; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .card, header { background: #1c1c1e !important; } input, select { background: #2c2c2e; color: #eee; border-color: #444 !important; } }
  header { position: sticky; top: 0; z-index: 10; background: #fff; padding: .8rem 1.2rem; display: flex; align-items: center; gap: 1rem; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
  header h1 { font-size: 1.05rem; margin: 0; } header h1 span { color: #ff3b30; }
  #meta { font-size: .8rem; opacity: .7; flex: 1; }
  button { font: inherit; border: 0; border-radius: 8px; padding: .45rem .9rem; cursor: pointer; background: #e5e5ea; }
  @media (prefers-color-scheme: dark) { button { background: #3a3a3c; color: #eee; } }
  button.primary { background: #ff3b30; color: #fff; font-weight: 600; }
  button.icon { padding: .3rem .55rem; }
  main { max-width: 900px; margin: 0 auto; padding: 1rem; }
  .card { background: #fff; border-radius: 12px; padding: .9rem 1rem; margin-bottom: .8rem; box-shadow: 0 1px 4px rgba(0,0,0,.07); display: flex; gap: 1rem; }
  .card.dragging { opacity: .4; }
  .num { font-weight: 700; color: #ff3b30; min-width: 2rem; }
  .body { flex: 1; min-width: 0; }
  .type { display: inline-block; font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: .15rem .5rem; border-radius: 999px; background: #e5e5ea; margin-bottom: .35rem; }
  @media (prefers-color-scheme: dark) { .type { background: #3a3a3c; } }
  .type.click { background: #ffd6d3; color: #8e1810; } .type.fill { background: #d8e7ff; color: #1240a0; }
  .type.navigate { background: #dff5df; color: #1a6b1a; } .type.select, .type.check { background: #f3e3ff; color: #6a1cab; }
  .row { display: flex; gap: .5rem; margin: .3rem 0; align-items: center; flex-wrap: wrap; }
  .row label { font-size: .75rem; opacity: .65; min-width: 4.2rem; }
  input[type=text] { flex: 1; min-width: 8rem; font: inherit; border: 1px solid #d1d1d6; border-radius: 6px; padding: .3rem .5rem; }
  .sel { font-size: .72rem; font-family: ui-monospace, monospace; opacity: .6; word-break: break-all; }
  img.shot { max-width: 230px; border-radius: 8px; border: 1px solid #d1d1d6; cursor: zoom-in; align-self: flex-start; }
  img.shot.zoom { max-width: 100%; cursor: zoom-out; }
  .btns { display: flex; flex-direction: column; gap: .3rem; }
  h2 { font-size: .95rem; margin: 1.6rem 0 .6rem; }
  .assert { display: flex; gap: .6rem; align-items: center; background: #fff; border-radius: 10px; padding: .6rem .9rem; margin-bottom: .5rem; box-shadow: 0 1px 4px rgba(0,0,0,.07); }
  @media (prefers-color-scheme: dark) { .assert { background: #1c1c1e; } }
  .assert .t { flex: 1; font-size: .88rem; }
  #toast { position: fixed; bottom: 1.2rem; left: 50%; transform: translateX(-50%); background: #1c1c1e; color: #fff; padding: .6rem 1.2rem; border-radius: 999px; opacity: 0; transition: opacity .25s; pointer-events: none; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>Flow<span>Scribe</span> Step Editor</h1>
  <div id="meta"></div>
  <button class="primary" onclick="save()">💾 Save</button>
</header>
<main>
  <div id="steps"></div>
  <h2>Assertions (checked during replay / exported tests)</h2>
  <div id="asserts"></div>
</main>
<div id="toast"></div>
<script>
let session = null;

async function load() {
  session = await (await fetch('/api/session')).json();
  document.getElementById('meta').textContent =
    session.name + ' — ' + session.startUrl + ' — ' + session.steps.length + ' steps';
  render();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render() {
  const host = document.getElementById('steps');
  host.innerHTML = '';
  session.steps.forEach((step, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="num">' + (i + 1) + '</div>' +
      '<div class="body">' +
        '<span class="type ' + esc(step.type) + '">' + esc(step.type) + '</span>' +
        (step.type === 'navigate'
          ? '<div class="row"><label>URL</label><input type="text" data-f="url" value="' + esc(step.url) + '"></div>'
          : '<div class="row"><label>Label</label><input type="text" data-f="text" value="' + esc(step.text || '') + '"></div>') +
        (step.type === 'fill' || step.type === 'select'
          ? '<div class="row"><label>Value</label><input type="text" data-f="value" value="' + esc(step.value || '') + '">' +
            '<label style="min-width:auto"><input type="checkbox" data-f="masked"' + (step.masked ? ' checked' : '') + '> mask</label></div>'
          : '') +
        (step.selector ? '<div class="sel">' + esc(step.selector) + '</div>' : '') +
      '</div>' +
      (step.screenshot
        ? '<img class="shot" src="/' + esc(step.screenshot) + '" onclick="this.classList.toggle(\\'zoom\\')">'
        : '') +
      '<div class="btns">' +
        '<button class="icon" title="Move up" onclick="move(' + i + ',-1)">↑</button>' +
        '<button class="icon" title="Move down" onclick="move(' + i + ',1)">↓</button>' +
        '<button class="icon" title="Delete step" onclick="del(' + i + ')">🗑</button>' +
      '</div>';
    card.querySelectorAll('[data-f]').forEach((input) => {
      input.addEventListener('input', () => {
        const f = input.getAttribute('data-f');
        step[f] = input.type === 'checkbox' ? input.checked : input.value;
      });
    });
    host.appendChild(card);
  });

  const ah = document.getElementById('asserts');
  const asserts = session.assertions || [];
  ah.innerHTML = asserts.length ? '' : '<p style="opacity:.6;font-size:.85rem">None yet — run <code>flowscribe assert</code> to let Gemini suggest verifications.</p>';
  asserts.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'assert';
    row.innerHTML =
      '<div class="t">after step <b>' + a.afterStep + '</b>: expect <b>“' + esc(a.text) + '”</b> visible' +
      (a.note ? '<br><span style="opacity:.6;font-size:.78rem">' + esc(a.note) + '</span>' : '') + '</div>' +
      '<button class="icon" onclick="delAssert(' + i + ')">🗑</button>';
    ah.appendChild(row);
  });
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= session.steps.length) return;
  const [s] = session.steps.splice(i, 1);
  session.steps.splice(j, 0, s);
  render();
}
function del(i) { session.steps.splice(i, 1); render(); }
function delAssert(i) { session.assertions.splice(i, 1); render(); }

async function save() {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: session.steps, assertions: session.assertions || [] }),
  });
  const out = await res.json();
  toast(out.ok ? '✔ Saved (' + out.steps + ' steps)' : '✘ ' + (out.error || 'Save failed'));
  if (out.ok) load();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

load();
</script>
</body>
</html>`;
