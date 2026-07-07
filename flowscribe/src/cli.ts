#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { record } from './recorder.js';
import { generateGuides } from './generator.js';
import { exportTest } from './exportTest.js';
import { replay } from './replay.js';
import { narrate } from './narrate.js';
import { loadSession, describeStep } from './session.js';

const program = new Command();

program
  .name('flowscribe')
  .description(
    'Record browser flows with Playwright, generate multilingual user guides with Gemini,\n' +
      'replay flows as automated tests, and export narrated how-to videos with subtitles.',
  )
  .version('0.1.0');

program
  .command('record')
  .description('Open a browser and record everything you do (no AI involved). Close the browser to stop.')
  .requiredOption('-u, --url <url>', 'URL of the app to record')
  .option('-o, --out <dir>', 'session output directory', defaultSessionDir())
  .option('-n, --name <name>', 'session name')
  .option('--user <username>', 'HTTP basic-auth username (if the site requires it)')
  .option('--pass <password>', 'HTTP basic-auth password')
  .option('--width <px>', 'viewport width', '1280')
  .option('--height <px>', 'viewport height', '720')
  .option('--headless', 'run headless (for scripted/CI use)', false)
  .action(async (o) => {
    console.log(`\n▶ Recording ${o.url}`);
    console.log(`  Session directory: ${path.resolve(o.out)}`);
    console.log('  Interact with the page normally — clicks, typing, navigation are captured,');
    console.log('  screenshots are annotated with a red ring where you click, and video is recorded.');
    console.log('  ⏹ Close the browser window (or press Ctrl+C here) to stop.\n');

    const handle = await record({
      url: o.url,
      out: o.out,
      name: o.name,
      user: o.user,
      pass: o.pass,
      headless: !!o.headless,
      viewport: { width: Number(o.width), height: Number(o.height) },
    });

    process.on('SIGINT', () => {
      console.log('\nStopping recording...');
      void handle.stop();
    });

    const session = await handle.done;
    console.log(`\n✔ Recorded ${session.steps.length} steps in ${((session.durationMs ?? 0) / 1000).toFixed(1)}s`);
    console.log(`  Session:     ${path.resolve(o.out)}/session.json`);
    console.log(`  Screenshots: ${path.resolve(o.out)}/screenshots/ (click highlights included)`);
    if (session.videos.length > 0)
      console.log(`  Video:       ${session.videos.map((v) => path.resolve(o.out, v)).join(', ')}`);
    console.log(`  Trace:       ${path.resolve(o.out)}/trace.zip (open with: npx playwright show-trace)`);
    console.log('\nNext steps:');
    console.log(`  flowscribe generate    -s ${o.out} --langs en,fr     # AI user guide`);
    console.log(`  flowscribe export-test -s ${o.out}                   # Playwright test`);
    console.log(`  flowscribe replay      -s ${o.out}                   # watch Playwright redo it`);
    console.log(`  flowscribe narrate     -s ${o.out} --lang en         # voiceover script + subtitles`);
  });

program
  .command('generate')
  .description('Generate a step-by-step user guide with Gemini (Markdown + HTML, any languages).')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('-l, --langs <codes>', 'comma-separated language codes (e.g. en,fr,ar)', 'en')
  .option('--vision', 'also send click screenshots to Gemini for richer descriptions', false)
  .option('--model <model>', 'Gemini model (default: env GEMINI_MODEL or gemini-2.5-flash)')
  .action(async (o) => {
    const langs = String(o.langs).split(',').map((l: string) => l.trim()).filter(Boolean);
    const files = await generateGuides({
      sessionDir: o.session,
      langs,
      vision: !!o.vision,
      model: o.model,
    });
    console.log('\n✔ Guide generated:');
    for (const f of files) console.log(`  ${f}`);
  });

program
  .command('export-test')
  .description('Convert the recording into a runnable Playwright test file (no AI).')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('-o, --out <file>', 'output .spec.ts path')
  .action(async (o) => {
    const file = await exportTest({ sessionDir: o.session, out: o.out });
    console.log(`✔ Playwright test written to ${file}`);
    console.log('  Run it with: npx playwright test ' + path.relative(process.cwd(), file));
  });

program
  .command('replay')
  .description('Let Playwright re-execute the recorded flow by itself (smoke test).')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('--headless', 'run headless', false)
  .option('--slow-mo <ms>', 'delay between actions in ms', '250')
  .action(async (o) => {
    console.log('▶ Replaying recorded flow...\n');
    const result = await replay({
      sessionDir: o.session,
      headless: !!o.headless,
      slowMo: Number(o.slowMo),
    });
    console.log(`\n${result.failed === 0 ? '✔' : '✘'} Replay finished: ${result.passed} passed, ${result.failed} failed.`);
    if (result.failed > 0) process.exitCode = 1;
  });

program
  .command('narrate')
  .description('Generate a voiceover script + .srt subtitles timed to the recording (Gemini).')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('-l, --lang <code>', 'language code (e.g. en, fr, ar)', 'en')
  .option('--model <model>', 'Gemini model (default: env GEMINI_MODEL or gemini-2.5-flash)')
  .action(async (o) => {
    const files = await narrate({ sessionDir: o.session, lang: o.lang, model: o.model });
    console.log('\n✔ Narration generated:');
    for (const f of files) console.log(`  ${f}`);
    console.log('\nRead the script aloud while re-recording, or burn the .srt into your video.');
  });

program
  .command('info')
  .description('Show a summary of a recorded session.')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .action(async (o) => {
    const session = await loadSession(o.session);
    console.log(`Session:  ${session.name}`);
    console.log(`App:      ${session.appTitle ?? session.startUrl}`);
    console.log(`Recorded: ${session.startedAt} (${((session.durationMs ?? 0) / 1000).toFixed(1)}s)`);
    console.log(`Steps:    ${session.steps.length}`);
    for (const s of session.steps) {
      console.log(`  ${String(s.index).padStart(3)}. ${describeStep(s)}${s.screenshot ? '  📸' : ''}`);
    }
    if (session.videos.length) console.log(`Videos:   ${session.videos.join(', ')}`);
  });

function defaultSessionDir(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return path.join('sessions', stamp);
}

program.parseAsync().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exit(1);
});
