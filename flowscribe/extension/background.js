/*
 * FlowScribe Recorder — background service worker.
 *
 * Collects events from the content script while recording, captures a
 * screenshot per click/hover/drag, and stores everything in
 * chrome.storage.local (service workers unload between events).
 * The popup exports the recording as a .flowscribe.json file that
 * `flowscribe import` turns into a normal session directory.
 */

const KIND_TO_TYPE = {
  click: 'click',
  fill: 'fill',
  select: 'select',
  check: 'check',
  press: 'press',
  hover: 'hover',
  drag: 'drag',
  upload: 'upload',
};

async function getState() {
  const { fs } = await chrome.storage.local.get('fs');
  return (
    fs || {
      recording: false,
      startedAt: 0,
      startUrl: '',
      appTitle: '',
      viewport: null,
      steps: [],
    }
  );
}

function setState(state) {
  return chrome.storage.local.set({ fs: state });
}

async function captureScreenshot(windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return dataUrl.replace(/^data:image\/png;base64,/, '');
  } catch (e) {
    return null; // rate-limited or restricted page — keep the step anyway
  }
}

async function handleEvent(payload, sender) {
  const state = await getState();
  if (!state.recording) return;
  const type = KIND_TO_TYPE[payload.kind];
  if (!type) return;

  const last = state.steps[state.steps.length - 1];

  // Same dedupe rules as the Playwright recorder (src/recorder.ts).
  if (type === 'fill' && last && last.type === 'fill' && last.selector === payload.selector) {
    last.value = payload.value;
    last.ts = payload.ts;
    await setState(state);
    return;
  }
  if (type === 'hover' && last && last.type === 'hover' && last.selector === payload.selector) return;
  if (type === 'click' && last && last.type === 'hover' && last.selector === payload.selector) {
    state.steps.pop();
  }
  if (type === 'drag' && last && last.type === 'click' && last.selector === payload.selector) {
    state.steps.pop();
  }

  const step = {
    type: type,
    ts: payload.ts || Date.now(),
    url: payload.url,
    selector: payload.selector || undefined,
    selectorCandidates: payload.selectorCandidates,
    tag: payload.tag,
    text: payload.text,
    value: payload.value,
    key: payload.key,
    checked: payload.checked,
    masked: payload.masked,
    coords: payload.x !== undefined ? { x: payload.x, y: payload.y } : undefined,
    targetSelector: payload.targetSelector || undefined,
    targetText: payload.targetText,
    files: payload.files,
  };
  if (!state.viewport && payload.viewport) state.viewport = payload.viewport;

  if ((type === 'click' || type === 'hover' || type === 'drag') && sender.tab) {
    step.screenshotData = await captureScreenshot(sender.tab.windowId);
  }

  state.steps.push(step);
  await setState(state);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'fs-event') {
      await handleEvent(msg.payload, sender);
      sendResponse({ ok: true });
    } else if (msg.type === 'fs-start') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await setState({
        recording: true,
        startedAt: Date.now(),
        startUrl: tab ? tab.url : '',
        appTitle: tab ? tab.title : '',
        viewport: null,
        steps: [
          { type: 'navigate', ts: Date.now(), url: tab ? tab.url : '' },
        ],
      });
      sendResponse({ ok: true });
    } else if (msg.type === 'fs-stop') {
      const state = await getState();
      state.recording = false;
      await setState(state);
      sendResponse({ ok: true, steps: state.steps.length });
    } else if (msg.type === 'fs-get') {
      sendResponse(await getState());
    } else if (msg.type === 'fs-clear') {
      await chrome.storage.local.remove('fs');
      sendResponse({ ok: true });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const state = await getState();
  if (!state.recording) return;
  const last = state.steps[state.steps.length - 1];
  if (last && last.type === 'navigate' && last.url === details.url) return;
  state.steps.push({ type: 'navigate', ts: Date.now(), url: details.url });
  await setState(state);
});
