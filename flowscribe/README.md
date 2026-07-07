# 🎥 FlowScribe

**Record a browser flow once — get a multilingual user guide, an automated Playwright test, a video, and a narrated tutorial script out of it.**

FlowScribe opens a real browser with [Playwright](https://playwright.dev) and silently records everything you do: clicks, typing, dropdowns, navigation. Every click is captured as a screenshot with a **red highlight ring exactly where you clicked**, and the whole session is recorded as **video**. No AI touches anything during recording.

Only when *you* decide, the recording is handed to **Gemini** to produce polished documentation — in **any language you want**.

```
                        ┌──────────────────────────────────────────┐
                        │              flowscribe record           │
   you give a URL  ───▶ │  real browser · you click around · done  │
                        └───────────────────┬──────────────────────┘
                                            │  session.json + 📸 highlighted
                                            │  screenshots + 🎞 video + trace
              ┌────────────────┬────────────┴─────────────┬────────────────┐
              ▼                ▼                          ▼                ▼
        generate          export-test                  replay           narrate
   🤖 Gemini writes a   ⚙️ deterministic          🔁 Playwright     🤖 Gemini writes a
   step-by-step guide   Playwright .spec.ts       re-executes       voiceover script
   (MD + HTML) in       file — plug it into       your flow by      + .srt subtitles
   en, fr, ar, …        your CI                   itself            timed to the video
```

## Features

- **🖱 Zero-AI recording** — pure Playwright. Clicks, typed text, selects, checkboxes, key presses, navigations, **hovers** (dwell ≥ 800 ms — captures opened menus), **drag & drop**, and **file uploads** are captured with robust selectors (`data-testid` → `id` → `name`/`aria-label`/`placeholder` → text → CSS path).
- **📸 Click highlighting** — a red ripple is drawn *in the page* at the click position the instant you click, so every screenshot shows exactly where to click. No image post-processing needed.
- **🎞 Video export** — the session is recorded as `.webm` via Playwright's built-in video recorder, plus a full Playwright **trace** (`trace.zip`) you can open with `npx playwright show-trace`.
- **🤖 Gemini-powered guides** — `generate` sends the step list (and optionally the screenshots, with `--vision`) to Gemini and writes a clean step-by-step guide as **Markdown and styled HTML** (add `--pdf` for a print-ready **PDF**), with the annotated screenshots embedded — in **as many languages as you want at once** (`--langs en,fr,es,ar`). RTL languages (Arabic, Hebrew, …) get proper `dir="rtl"` HTML.
- **🧪 Flow → test** — `export-test` converts the recording into a runnable `@playwright/test` spec (navigations become URL assertions), and `replay` re-executes the flow live with selector-fallback so Playwright can "do it himself" as a smoke test.
- **🩹 Self-healing replays** — when the app's UI changes and a selector breaks, `replay` digests the live page's interactive elements, asks Gemini which one the step really targeted, retries, and **writes the repaired selector back** to `session.json` (original backed up). Your recorded tests fix themselves.
- **✅ AI-suggested assertions** — `assert` has Gemini propose outcome-proving checks ("after clicking Sign in, 'Welcome back!' is visible"), grounded in the screenshots so it only asserts what it can see. They run on every `replay` and are baked into `export-test` specs — turning replays into real regression tests.
- **✎ Step editor** — `edit` serves a local web UI (zero dependencies, no AI) to review the recording with its screenshots: delete misclicks, reorder steps, fix labels, redact values, prune assertions — then save before generating anything.
- **🎙 How-to video narration** — `narrate` asks Gemini for a voiceover script timed to your recording's real timestamps, and writes both a read-aloud script and an **`.srt` subtitle file** — record your video and just read along. Add `--tts` for a **synthesized voiceover** (Gemini TTS → `.wav`) and `--mux` to lay it over the session video with ffmpeg: a finished, narrated how-to video with zero human recording.
- **📡 Monitoring mode** — `monitor` replays the flow on an interval ("does checkout still work?"), logs every run to `monitor.log`, and POSTs a JSON report to your webhook (Slack, n8n, anything) when a run fails or self-heals.
- **🔐 Access handling** — pass `--user/--pass` for HTTP basic auth; form logins are simply recorded like any other steps (passwords are masked in guides and narration, never sent to the AI).

## Install

```bash
npm install
npx playwright install chromium   # once, if Chromium isn't already installed
export GEMINI_API_KEY=your-key    # only needed for generate / narrate
```

Get a free Gemini API key at <https://aistudio.google.com/apikey>. Model defaults to `gemini-2.5-flash` (override with `GEMINI_MODEL` or `--model`).

## Usage

### 1. Record (no AI)

```bash
npm run record -- --url https://your-app.com --out sessions/checkout
# with HTTP basic auth:
npm run record -- --url https://staging.your-app.com --user demo --pass secret --out sessions/checkout
```

A browser opens. Do the flow you want to document. **Close the browser to stop.** You get:

```
sessions/checkout/
├── session.json          # every step: selector, text, value, coords, timestamps
├── screenshots/          # step-001.png … with the red click highlight baked in
├── video/                # .webm screen recording of the session
└── trace.zip             # full Playwright trace (show-trace compatible)
```

### 2. Generate the user guide (Gemini)

```bash
npm run generate -- -s sessions/checkout --langs en,fr,ar --vision
```

Writes `guide/guide.en.md`, `guide.en.html`, `guide.fr.md`, … with screenshots embedded and click positions highlighted.

### 3. Clean up the recording (optional, no AI)

```bash
npm run cli -- edit -s sessions/checkout
# open http://localhost:4173 — delete misclicks, reorder, redact, save
```

### 4. Let Playwright redo the flow itself — with AI assertions and self-healing

```bash
npm run cli -- assert -s sessions/checkout        # Gemini proposes verifications
npm run replay -- -s sessions/checkout            # watch it live; checks assertions;
                                                  # broken selectors are healed via Gemini
npm run export-test -- -s sessions/checkout       # .spec.ts for CI (assertions included)
npx playwright test sessions/checkout/flow.spec.ts
```

When a replay heals a selector, the fix is saved back to `session.json` (the original is kept in `session.backup.json`). Disable with `--no-heal`.

### 5. Narrated how-to video

```bash
npm run narrate -- -s sessions/checkout --lang en                 # script + .srt
npm run narrate -- -s sessions/checkout --lang en --mux --voice Kore
```

Writes `narration/narration.en.md` (read-aloud script with timestamps) and `narration/narration.en.srt`. With `--tts` you also get `narration.en.wav` (Gemini TTS voiceover), and `--mux` lays that audio over the session video into `howto.en.webm` (requires an ffmpeg with audio encoders on your PATH or `FFMPEG_PATH`). Burn subtitles in with:

```bash
ffmpeg -i sessions/checkout/narration/howto.en.webm -vf subtitles=sessions/checkout/narration/narration.en.srt howto.mp4
```

### 6. Keep watching it (synthetic monitoring)

```bash
npm run cli -- monitor -s sessions/checkout --interval 15m --webhook https://hooks.example.com/alerts
```

Replays the flow every 15 minutes headless, appends every run to `sessions/checkout/monitor.log`, and POSTs a JSON report to the webhook whenever a run fails — or silently self-heals a broken selector.

### Inspect a session

```bash
npm run cli -- info -s sessions/checkout
```

## Privacy & safety

- Recording is **100% local** — nothing leaves your machine until you explicitly run `generate` or `narrate`.
- Password fields are flagged `masked` and shown as `••••••••` to Gemini and in guides. (They *are* stored in `session.json` locally so `replay` can log in — treat session folders like secrets.)

## Roadmap

- [x] Interactive step editor before generation (`flowscribe edit`)
- [x] Gemini-suggested assertions in exported tests (`flowscribe assert`)
- [x] Self-healing replays (broken selectors repaired by Gemini)
- [x] Hover / drag / file-upload capture
- [x] Voice synthesis (TTS) of the narration script (`narrate --tts/--mux`)
- [x] PDF guide export (`generate --pdf`)
- [x] Monitoring mode (`flowscribe monitor` — interval replays + webhook alerts)
- [ ] DOCX guide export
- [ ] Per-cue TTS timing (align audio precisely to each subtitle cue)
- [ ] Chrome extension recorder (record in your own logged-in browser)
