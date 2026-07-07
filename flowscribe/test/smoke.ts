/**
 * End-to-end smoke test of the offline pipeline (no Gemini key needed):
 *   1. record a scripted flow on a local fixture page (headless)
 *   2. verify session.json, click-highlight screenshots and video exist
 *   3. export the session as a Playwright spec (with assertions baked in)
 *   4. replay the session headless — steps AND assertions must pass
 *   5. exercise the step editor's HTTP API (load, edit, save, backup)
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

console.log('1/4 Recording scripted flow (headless)...');
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

console.log('2/4 Checking artifacts...');
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

console.log('3/5 Exporting Playwright spec...');
const specFile = await exportTest({ sessionDir: outDir });
const spec = readFileSync(specFile, 'utf8');
assert.ok(spec.includes("import { test, expect } from '@playwright/test'"));
assert.ok(spec.includes('[data-testid=\\"login-button\\"]') || spec.includes('data-testid'), 'spec missing login-button selector');
assert.ok(spec.includes(".fill(\"yassine\")"), 'spec missing fill value');
assert.ok(spec.includes('getByText("Welcome back!")'), 'spec missing generated assertion');

console.log('4/5 Replaying the flow headless (steps + assertions)...');
const result = await replay({ sessionDir: outDir, headless: true, slowMo: 0, heal: false });
assert.strictEqual(result.failed, 0, `replay failures: ${JSON.stringify(result.failures, null, 2)}`);
assert.strictEqual(result.assertionsPassed, 1, 'assertion did not pass during replay');
assert.strictEqual(result.assertionsFailed, 0, 'assertion failed during replay');

console.log('5/5 Exercising the step editor API...');
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

console.log('\n✔ Smoke test passed: record → artifacts → export-test (with assertions) → replay → editor all work.');
