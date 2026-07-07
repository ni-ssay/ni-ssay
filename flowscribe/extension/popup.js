/* FlowScribe Recorder — popup UI. */

const send = (type) => chrome.runtime.sendMessage({ type });

async function refresh() {
  const state = await send('fs-get');
  const el = document.getElementById('status');
  const steps = state && state.steps ? state.steps.length : 0;
  if (state && state.recording) {
    el.textContent = `● Recording — ${steps} step${steps === 1 ? '' : 's'} captured`;
    el.className = 'rec';
  } else {
    el.textContent = steps ? `${steps} steps recorded (stopped)` : 'Not recording';
    el.className = '';
  }
  document.getElementById('start').disabled = !!(state && state.recording);
  document.getElementById('stop').disabled = !(state && state.recording);
  document.getElementById('export').disabled = steps === 0 || !!(state && state.recording);
  document.getElementById('clear').disabled = steps === 0;
}

document.getElementById('start').addEventListener('click', async () => {
  await send('fs-start');
  refresh();
});

document.getElementById('stop').addEventListener('click', async () => {
  await send('fs-stop');
  refresh();
});

document.getElementById('export').addEventListener('click', async () => {
  const state = await send('fs-get');
  if (!state || !state.steps || state.steps.length === 0) return;
  const name = 'ext-' + new Date(state.startedAt).toISOString().replace(/[:.]/g, '-');
  const exportData = {
    version: 1,
    source: 'flowscribe-extension',
    name: name,
    startUrl: state.startUrl,
    appTitle: state.appTitle,
    startedAt: new Date(state.startedAt).toISOString(),
    startedAtTs: state.startedAt,
    viewport: state.viewport || { width: 1280, height: 720 },
    steps: state.steps,
  };
  const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url: url,
    filename: name + '.flowscribe.json',
    saveAs: true,
  });
});

document.getElementById('clear').addEventListener('click', async () => {
  await send('fs-clear');
  refresh();
});

refresh();
setInterval(refresh, 1500);
