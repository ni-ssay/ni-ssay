import { chromium } from 'playwright';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { startUi } from '../src/ui.js';

rmSync('sessions/swiss', { recursive: true, force: true });
mkdirSync('sessions', { recursive: true });
cpSync('test/.smoke-session', 'sessions/swiss', { recursive: true });

const server = await startUi({ port: 4615 });
const browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
// System dark, user forces LIGHT via the toggle — light must win.
const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, colorScheme: 'dark' });
await page.goto('http://localhost:4615/');
await page.waitForSelector('.session');
await page.click('#themeBtn'); // auto -> light
const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await page.screenshot({ path: 'test/.theme-light.png' });
await page.click('#themeBtn'); // light -> dark
const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
console.log('forced light bg:', bg1, '| forced dark bg:', bg2);
if (bg1 === bg2) throw new Error('theme toggle has no effect');
// persisted?
await page.reload();
await page.waitForSelector('.session');
const label = await page.textContent('#themeBtn');
console.log('after reload, theme button:', label);
await browser.close();
server.close();
rmSync('sessions/swiss', { recursive: true, force: true });
console.log('THEME CHECK OK');
process.exit(0);
