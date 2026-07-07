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

- **🖱 Zero-AI recording** — pure Playwright. Clicks, typed text, selects, checkboxes, key presses, and navigations are captured with robust selectors (`data-testid` → `id` → `name`/`aria-label`/`placeholder` → text → CSS path).
- **📸 Click highlighting** — a red ripple is drawn *in the page* at the click position the instant you click, so every screenshot shows exactly where to click. No image post-processing needed.
- **🎞 Video export** — the session is recorded as `.webm` via Playwright's built-in video recorder, plus a full Playwright **trace** (`trace.zip`) you can open with `npx playwright show-trace`.
- **🤖 Gemini-powered guides** — `generate` sends the step list (and optionally the screenshots, with `--vision`) to Gemini and writes a clean step-by-step guide as **Markdown and styled HTML**, with the annotated screenshots embedded — in **as many languages as you want at once** (`--langs en,fr,es,ar`). RTL languages (Arabic, Hebrew, …) get proper `dir="rtl"` HTML.
- **🧪 Flow → test** — `export-test` converts the recording into a runnable `@playwright/test` spec (navigations become URL assertions), and `replay` re-executes the flow live with selector-fallback so Playwright can "do it himself" as a smoke test.
- **🎙 How-to video narration** — `narrate` asks Gemini for a voiceover script timed to your recording's real timestamps, and writes both a read-aloud script and an **`.srt` subtitle file** — record your video and just read along.
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

### 3. Let Playwright redo the flow itself

```bash
npm run replay -- -s sessions/checkout            # watch it live
npm run export-test -- -s sessions/checkout       # or get a .spec.ts for CI
npx playwright test sessions/checkout/flow.spec.ts
```

### 4. Narrated how-to video

```bash
npm run narrate -- -s sessions/checkout --lang en
```

Writes `narration/narration.en.md` (read-aloud script with timestamps) and `narration/narration.en.srt` (subtitles you can burn into the exported video with ffmpeg):

```bash
ffmpeg -i sessions/checkout/video/*.webm -vf subtitles=sessions/checkout/narration/narration.en.srt howto.mp4
```

### Inspect a session

```bash
npm run cli -- info -s sessions/checkout
```

## Privacy & safety

- Recording is **100% local** — nothing leaves your machine until you explicitly run `generate` or `narrate`.
- Password fields are flagged `masked` and shown as `••••••••` to Gemini and in guides. (They *are* stored in `session.json` locally so `replay` can log in — treat session folders like secrets.)

## Roadmap

- [ ] Hover / drag / file-upload capture
- [ ] Interactive step editor before generation
- [ ] Gemini-suggested assertions in exported tests
- [ ] Voice synthesis (TTS) of the narration script
- [ ] PDF / DOCX guide export
