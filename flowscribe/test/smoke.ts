/**
 * End-to-end smoke test of the offline pipeline (no Gemini key needed):
 *   1. record a scripted flow on a local fixture page (headless)
 *   2. verify session.json, click-highlight screenshots and video exist
 *   3. export the session as a Playwright spec
 *   4. replay the session headless and require all steps to pass
 *
 * Run with: npm run smoke
 */
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { record } from '../src/recorder.js';
import { exportTest } from '../src/exportTest.js';
import { replay } from '../src/replay.js';

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

console.log('3/4 Exporting Playwright spec...');
const specFile = await exportTest({ sessionDir: outDir });
const spec = readFileSync(specFile, 'utf8');
assert.ok(spec.includes("import { test, expect } from '@playwright/test'"));
assert.ok(spec.includes('[data-testid=\\"login-button\\"]') || spec.includes('data-testid'), 'spec missing login-button selector');
assert.ok(spec.includes(".fill(\"yassine\")"), 'spec missing fill value');

console.log('4/4 Replaying the flow headless...');
const result = await replay({ sessionDir: outDir, headless: true, slowMo: 0 });
assert.strictEqual(result.failed, 0, `replay failures: ${JSON.stringify(result.failures, null, 2)}`);

console.log('\n✔ Smoke test passed: record → artifacts → export-test → replay all work.');
