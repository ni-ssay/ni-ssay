/**
 * End-to-end smoke test of the offline pipeline (no Gemini key needed):
 *   1. record a scripted flow on a local fixture page (headless)
 *   2. verify session.json, click-highlight screenshots and video exist
 *   3. export the session as a Playwright spec (with assertions baked in)
 *   4. replay the session headless — steps AND assertions must pass
 *   5. exercise the step editor's HTTP API (load, edit, save, backup)
 *   6. render a PDF and a DOCX guide with no AI
 *   7. verify per-cue TTS audio alignment math
 *   8. drive the Chrome extension content script in a real page (chrome
 *      stub), export like the popup does, `import` it, and replay it
 *
 * Run with: npm run smoke
 */
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { record } from '../src/recorder.js';
import { exportTest } from '../src/exportTest.js';
import { replay } from '../src/replay.js';
import { startEditor } from '../src/editor.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixtureUrl = pathToFileURL(path.join(here, 'fixture.html')).href;
const outDir = path.join(here, '.smoke-session');
rmSync(outDir, { recursive: true, force: true });

console.log('1/8 Recording scripted flow (headless)...');
const handle = await record({ url: fixtureUrl, out: outDir, headless: true, name: 'smoke' });
const { page } = handle;

// Real input events via CDP are `isTrusted: true`, so the injected
// recorder sees them exactly like human interactions.
await page.click('input[name="username"]');
await page.fill('input[name="username"]', 'yassine');
await page.fill('input[name="password"]', 'hunter2');
// selectOption() dispatches a synthetic change event which the recorder
// rightly ignores (isTrusted=false); pick the option with the keyboard
// like a real user would.
await page.focus('select[name="role"]');
await page.keyboard.press('ArrowDown');
await page.check('#remember');
await page.click('[data-testid="login-button"]');
await page.waitForTimeout(300);

// Hover (dwell >= 800ms opens the menu), then click inside it.
await page.hover('#menu-button');
await page.waitForTimeout(1100);
await page.click('#menu-item-docs');

// HTML5 drag & drop and a file upload.
await page.dragAndDrop('#drag-me', '#drop-zone');
await page.setInputFiles('#attachment', {
  name: 'report.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4 placeholder'),
});
await page.waitForTimeout(400);

const session = await handle.stop();

console.log(`    recorded ${session.steps.length} steps`);
assert.ok(session.steps.length >= 5, 'expected at least 5 recorded steps');

const types = session.steps.map((s) => s.type);
assert.ok(types.includes('click'), 'missing click step');
assert.ok(types.includes('fill'), 'missing fill step');
assert.ok(types.includes('select'), 'missing select step');
assert.ok(types.includes('check'), 'missing check step');

const fill = session.steps.find((s) => s.type === 'fill' && !s.masked);
assert.strictEqual(fill?.value, 'yassine', 'fill value not captured');
const pw = session.steps.find((s) => s.type === 'fill' && s.masked);
assert.strictEqual(pw?.masked, true, 'password not flagged as masked');

const loginClick = session.steps.find(
  (s) => s.type === 'click' && s.selector === '[data-testid="login-button"]',
);
assert.ok(loginClick, 'data-testid selector not preferred for the login button');

const hover = session.steps.find((s) => s.type === 'hover');
assert.strictEqual(hover?.selector, '#menu-button', 'hover step not captured');
const drag = session.steps.find((s) => s.type === 'drag');
assert.strictEqual(drag?.selector, '#drag-me', 'drag source not captured');
assert.strictEqual(drag?.targetSelector, '#drop-zone', 'drop target not captured');
const upload = session.steps.find((s) => s.type === 'upload');
assert.deepStrictEqual(upload?.files, ['report.pdf'], 'upload files not captured');

console.log('2/8 Checking artifacts...');
assert.ok(existsSync(path.join(outDir, 'session.json')), 'session.json missing');
const shots = session.steps.filter((s) => s.screenshot);
assert.ok(shots.length >= 1, 'no click screenshots captured');
for (const s of shots) {
  assert.ok(existsSync(path.join(outDir, s.screenshot!)), `${s.screenshot} missing`);
}
assert.ok(session.videos.length >= 1, 'no video recorded');
assert.ok(existsSync(path.join(outDir, session.videos[0])), 'video file missing');
assert.ok(existsSync(path.join(outDir, 'trace.zip')), 'trace.zip missing');
console.log(`    ${shots.length} screenshots, ${session.videos.length} video(s), trace.zip ✓`);

// Add an assertion by hand (what `flowscribe assert` would do via Gemini):
// the fixture shows "Welcome back!" after clicking Sign in.
const lastIndex = session.steps[session.steps.length - 1].index;
session.assertions = [
  { afterStep: lastIndex, text: 'Welcome back!', note: 'login succeeded' },
];
writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(session, null, 2));

console.log('3/8 Exporting Playwright spec...');
const specFile = await exportTest({ sessionDir: outDir });
const spec = readFileSync(specFile, 'utf8');
assert.ok(spec.includes("import { test, expect } from '@playwright/test'"));
assert.ok(spec.includes('[data-testid=\\"login-button\\"]') || spec.includes('data-testid'), 'spec missing login-button selector');
assert.ok(spec.includes(".fill(\"yassine\")"), 'spec missing fill value');
assert.ok(spec.includes('getByText("Welcome back!")'), 'spec missing generated assertion');

console.log('4/8 Replaying the flow headless (steps + assertions)...');
const result = await replay({ sessionDir: outDir, headless: true, slowMo: 0, heal: false });
assert.strictEqual(result.failed, 0, `replay failures: ${JSON.stringify(result.failures, null, 2)}`);
assert.strictEqual(result.assertionsPassed, 1, 'assertion did not pass during replay');
assert.strictEqual(result.assertionsFailed, 0, 'assertion failed during replay');

console.log('5/8 Exercising the step editor API...');
const editor = await startEditor({ sessionDir: outDir, port: 0 });
const address = editor.address();
const port = typeof address === 'object' && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

const page1 = await (await fetch(base + '/')).text();
assert.ok(page1.includes('Step Editor'), 'editor page did not render');
const loaded = await (await fetch(base + '/api/session')).json();
assert.strictEqual(loaded.steps.length, session.steps.length, 'editor did not load all steps');

// Simulate the user deleting step 2 (the first click) and saving.
const edited = loaded.steps.filter((s: { index: number }) => s.index !== 2);
const saveRes = await (
  await fetch(base + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: edited, assertions: loaded.assertions ?? [] }),
  })
).json();
assert.strictEqual(saveRes.ok, true, 'editor save failed');
editor.close();

const saved = JSON.parse(readFileSync(path.join(outDir, 'session.json'), 'utf8'));
assert.strictEqual(saved.steps.length, session.steps.length - 1, 'step not deleted');
assert.deepStrictEqual(
  saved.steps.map((s: { index: number }) => s.index),
  saved.steps.map((_: unknown, i: number) => i + 1),
  'steps not renumbered after edit',
);
assert.strictEqual(
  saved.assertions[0].afterStep,
  saved.steps.length,
  'assertion afterStep not remapped after deletion',
);
assert.ok(existsSync(path.join(outDir, 'session.backup.json')), 'editor backup missing');

console.log('6/8 Rendering PDF and DOCX guides...');
const { renderPdf } = await import('../src/generator.js');
const htmlFile = path.join(outDir, 'pdf-check.html');
writeFileSync(htmlFile, '<!doctype html><html><body><h1>FlowScribe PDF check</h1></body></html>');
const pdfFile = path.join(outDir, 'pdf-check.pdf');
await renderPdf(htmlFile, pdfFile);
assert.ok(readFileSync(pdfFile).subarray(0, 5).toString() === '%PDF-', 'PDF not rendered');

const { renderDocx } = await import('../src/docx.js');
const sampleShot = saved.steps.find((s: { screenshot?: string }) => s.screenshot)?.screenshot;
const sampleMd = [
  '# Guide check',
  '',
  'A **bold** step with a [link](https://example.com) and `code`.',
  '',
  '1. First step',
  '2. Second step',
  '',
  sampleShot ? `![Step](${sampleShot})` : '',
].join('\n');
const docxFile = path.join(outDir, 'docx-check.docx');
await renderDocx(sampleMd, outDir, docxFile);
const docxBuf = readFileSync(docxFile);
assert.ok(docxBuf.subarray(0, 2).toString() === 'PK', 'DOCX is not a zip');
assert.ok(docxBuf.includes('word/document.xml'), 'DOCX missing document.xml');

console.log('7/8 Verifying TTS cue alignment math...');
const { assembleAlignedPcm } = await import('../src/narrate.js');
const rate = 8000; // 16 bytes per ms at 16-bit mono
const clip = (ms: number) => Buffer.alloc(ms * (rate / 1000) * 2, 1);
const { pcm, placements } = assembleAlignedPcm(
  [
    { startMs: 0, pcm: clip(100) },
    { startMs: 500, pcm: clip(200) }, // needs 400ms of silence padding
    { startMs: 600, pcm: clip(50) }, // previous clip overruns to 700 — no gap
  ],
  rate,
);
assert.deepStrictEqual(
  placements,
  [
    { startMs: 0, endMs: 100 },
    { startMs: 500, endMs: 700 },
    { startMs: 700, endMs: 750 },
  ],
  'cue placements wrong',
);
assert.strictEqual(pcm.length, 750 * 16, 'assembled PCM length wrong');

console.log('8/8 Driving the extension content script → export → import → replay...');
const { chromium } = await import('playwright');
const extBrowser = await chromium.launch({
  headless: true,
  executablePath: process.env.FLOWSCRIBE_CHROMIUM || undefined,
});
const extContext = await extBrowser.newContext();
const extEvents: Array<Record<string, unknown>> = [];
await extContext.exposeBinding('__extSend', (_src, msg: { payload: Record<string, unknown> }) => {
  extEvents.push(msg.payload);
});
// Stub just enough of the chrome extension API for content.js to run.
await extContext.addInitScript({
  content: `window.chrome = window.chrome || {};
    window.chrome.runtime = { sendMessage: (msg) => window.__extSend(msg) };`,
});
await extContext.addInitScript({
  path: path.join(here, '..', 'extension', 'content.js'),
});
const extPage = await extContext.newPage();
const extStart = Date.now();
await extPage.goto(fixtureUrl);
await extPage.click('input[name="username"]');
await extPage.fill('input[name="username"]', 'ext-user');
await extPage.click('[data-testid="login-button"]');
await extPage.waitForTimeout(300);
await extBrowser.close();

assert.ok(
  extEvents.some((e) => e.kind === 'click' && e.selector === '[data-testid="login-button"]'),
  'extension content script did not capture the click',
);
assert.ok(
  extEvents.some((e) => e.kind === 'fill' && e.value === 'ext-user'),
  'extension content script did not capture the fill',
);

// Build the export the way popup.js does (steps as background.js stores them).
const extExport = {
  version: 1,
  source: 'flowscribe-extension',
  name: 'ext-smoke',
  startUrl: fixtureUrl,
  appTitle: 'FlowScribe Demo App',
  startedAt: new Date(extStart).toISOString(),
  startedAtTs: extStart,
  viewport: { width: 1280, height: 720 },
  steps: [
    { type: 'navigate', ts: extStart, url: fixtureUrl },
    ...extEvents
      .filter((e) => ['click', 'fill'].includes(String(e.kind)))
      .map((e) => ({ ...e, type: e.kind, ts: e.ts ?? Date.now() })),
  ],
};
const exportFile = path.join(outDir, 'ext-smoke.flowscribe.json');
writeFileSync(exportFile, JSON.stringify(extExport));

const { importSession } = await import('../src/importSession.js');
const importedDir = path.join(outDir, 'imported');
const imported = await importSession({ file: exportFile, out: importedDir });
assert.ok(imported.steps.length >= 3, 'imported session too small');

const importedReplay = await replay({ sessionDir: importedDir, headless: true, slowMo: 0, heal: false });
assert.strictEqual(
  importedReplay.failed,
  0,
  `imported replay failures: ${JSON.stringify(importedReplay.failures, null, 2)}`,
);

console.log(
  '\n✔ Smoke test passed: record (hover/drag/upload) → export-test → replay → editor → PDF/DOCX → TTS alignment → extension import all work.',
);
