#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { record } from './recorder.js';
import { generateGuides } from './generator.js';
import { exportTest } from './exportTest.js';
import { replay } from './replay.js';
import { narrate } from './narrate.js';
import { suggestAssertions } from './assertions.js';
import { startEditor } from './editor.js';
import { monitor, parseInterval } from './monitor.js';
import { importSession } from './importSession.js';
import { startUi, openBrowser } from './ui.js';
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
  .option('--width <px>', 'fixed viewport width (default: full browser window)')
  .option('--height <px>', 'fixed viewport height (default: full browser window)')
  .option('--video', 'capture full-motion screencast video (makes the browser less fluid); default is a step video built from screenshots afterwards', false)
  .option('--trace', 'capture a Playwright trace.zip (adds interaction overhead)', false)
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
      video: !!o.video,
      trace: !!o.trace,
      viewport:
        o.width && o.height
          ? { width: Number(o.width), height: Number(o.height) }
          : undefined,
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
    if (o.trace) console.log(`  Trace:       ${path.resolve(o.out)}/trace.zip (open with: npx playwright show-trace)`);
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
  .option('--pdf', 'also render each guide as a PDF', false)
  .option('--docx', 'also render each guide as a Word document', false)
  .option('--model <model>', 'Gemini model (default: env GEMINI_MODEL or gemini-2.5-flash)')
  .action(async (o) => {
    const langs = String(o.langs).split(',').map((l: string) => l.trim()).filter(Boolean);
    const files = await generateGuides({
      sessionDir: o.session,
      langs,
      vision: !!o.vision,
      pdf: !!o.pdf,
      docx: !!o.docx,
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
  .description('Let Playwright re-execute the recorded flow by itself (smoke test). Broken selectors are self-healed via Gemini when GEMINI_API_KEY is set.')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('--headless', 'run headless', false)
  .option('--slow-mo <ms>', 'delay between actions in ms', '250')
  .option('--no-heal', 'disable AI self-healing of broken selectors')
  .option('--model <model>', 'Gemini model used for healing')
  .action(async (o) => {
    console.log('▶ Replaying recorded flow...\n');
    const result = await replay({
      sessionDir: o.session,
      headless: !!o.headless,
      slowMo: Number(o.slowMo),
      heal: o.heal,
      model: o.model,
    });
    const verdict = result.failed === 0 && result.assertionsFailed === 0 ? '✔' : '✘';
    console.log(
      `\n${verdict} Replay finished: ${result.passed} passed, ${result.failed} failed` +
        (result.healed ? `, ${result.healed} healed 🩹` : '') +
        (result.assertionsPassed + result.assertionsFailed > 0
          ? ` | assertions: ${result.assertionsPassed} passed, ${result.assertionsFailed} failed`
          : ''),
    );
    if (result.failed > 0 || result.assertionsFailed > 0) process.exitCode = 1;
  });

program
  .command('assert')
  .description('Let Gemini suggest verifications for the flow (stored in session.json; used by replay and export-test).')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('--no-vision', 'do not send screenshots to Gemini')
  .option('--model <model>', 'Gemini model (default: env GEMINI_MODEL or gemini-2.5-flash)')
  .action(async (o) => {
    const assertions = await suggestAssertions({
      sessionDir: o.session,
      vision: o.vision,
      model: o.model,
    });
    console.log(`\n✔ ${assertions.length} assertion(s) saved to session.json:`);
    for (const a of assertions) {
      console.log(`  after step ${a.afterStep}: expect "${a.text}" visible${a.note ? ` — ${a.note}` : ''}`);
    }
    console.log('\nThey will be checked on every replay and included in export-test specs.');
    console.log('Review or remove them anytime with: flowscribe edit -s ' + o.session);
  });

program
  .command('edit')
  .description('Open a local web editor to review/delete/reorder steps and redact values before generating.')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('-p, --port <port>', 'port to serve the editor on', '4173')
  .action(async (o) => {
    await startEditor({ sessionDir: o.session, port: Number(o.port) });
    console.log(`\n✎ Step editor running at http://localhost:${o.port}`);
    console.log('  Edit your recording, hit Save, then Ctrl+C here when done.');
  });

program
  .command('narrate')
  .description('Generate a voiceover script + .srt subtitles timed to the recording (Gemini).')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('-l, --lang <code>', 'language code (e.g. en, fr, ar)', 'en')
  .option('--tts', 'also synthesize the narration as audio (Gemini TTS)', false)
  .option('--voice <name>', 'Gemini TTS voice (Kore, Puck, Charon, Fenrir, Aoede, ...)')
  .option('--mux', 'mux the TTS audio onto the session video (implies --tts, needs ffmpeg)', false)
  .option('--model <model>', 'Gemini model (default: env GEMINI_MODEL or gemini-2.5-flash)')
  .action(async (o) => {
    const files = await narrate({
      sessionDir: o.session,
      lang: o.lang,
      model: o.model,
      tts: !!o.tts || !!o.mux,
      voice: o.voice,
      mux: !!o.mux,
    });
    console.log('\n✔ Narration generated:');
    for (const f of files) console.log(`  ${f}`);
    console.log('\nRead the script aloud while re-recording, or burn the .srt into your video.');
  });

program
  .command('monitor')
  .description('Replay the flow on an interval (synthetic monitoring); log every run, alert a webhook on failure.')
  .requiredOption('-s, --session <dir>', 'recorded session directory')
  .option('-i, --interval <duration>', 'time between runs (e.g. 90s, 15m, 1h)', '15m')
  .option('--webhook <url>', 'POST a JSON report here when a run fails or self-heals')
  .option('--headed', 'run with a visible browser', false)
  .option('--max-runs <n>', 'stop after N runs (default: run forever)', '0')
  .option('--no-heal', 'disable AI self-healing of broken selectors')
  .option('--model <model>', 'Gemini model used for healing')
  .action(async (o) => {
    const intervalMs = parseInterval(o.interval);
    console.log(`▶ Monitoring flow every ${o.interval} — results in <session>/monitor.log. Ctrl+C to stop.\n`);
    await monitor({
      sessionDir: o.session,
      intervalMs,
      webhook: o.webhook,
      headless: !o.headed,
      heal: o.heal,
      model: o.model,
      maxRuns: Number(o.maxRuns) || 0,
    });
  });

program
  .command('ui')
  .description('Open FlowScribe Studio — a local dashboard that drives everything with buttons.')
  .option('-p, --port <port>', 'port to serve the dashboard on', '4600')
  .option('--no-open', 'do not auto-open the browser')
  .action(async (o) => {
    await startUi({ port: Number(o.port) });
    const url = `http://localhost:${o.port}`;
    console.log(`\n🎛  FlowScribe Studio running at ${url}`);
    console.log('   Record, edit, generate guides, replay, narrate — all from the browser. Ctrl+C to quit.');
    if (o.open) openBrowser(url);
  });

program
  .command('import <file>')
  .description('Import a .flowscribe.json export from the Chrome extension into a session directory.')
  .requiredOption('-o, --out <dir>', 'session directory to create')
  .action(async (file, o) => {
    const session = await importSession({ file, out: o.out });
    console.log(`✔ Imported ${session.steps.length} steps into ${path.resolve(o.out)}`);
    console.log('  All commands now work on it: generate, edit, assert, replay, export-test, narrate, monitor.');
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
