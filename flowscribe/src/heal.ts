import type { Page } from 'playwright';
import { geminiGenerate, parseJsonResponse } from './gemini.js';
import { describeStep } from './session.js';
import type { RecordedStep } from './types.js';

/**
 * Self-healing: when a replay step fails because the UI changed, digest the
 * live page's interactive elements and ask Gemini which one the recorded
 * step was really targeting. Returns a working selector or null.
 */

export interface DigestEntry {
  selector: string;
  tag: string;
  text: string;
}

/* Kept as a raw JS string so no transpiler can inject helpers that don't
   exist inside the browser page (same reason as src/injected.ts). */
const DIGEST_SCRIPT = String.raw`(limit) => {
  const cssEscape = (v) =>
    window.CSS && window.CSS.escape
      ? window.CSS.escape(v)
      : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  const isUnique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; }
    catch (e) { return false; }
  };
  const selectorFor = (el) => {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (testId && isUnique('[data-testid="' + testId + '"]')) return '[data-testid="' + testId + '"]';
    if (el.id && isUnique('#' + cssEscape(el.id))) return '#' + cssEscape(el.id);
    const tag = el.tagName.toLowerCase();
    for (const attr of ['name', 'aria-label', 'placeholder', 'title']) {
      const v = el.getAttribute(attr);
      if (v && isUnique(tag + '[' + attr + '="' + v + '"]')) return tag + '[' + attr + '="' + v + '"]';
    }
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (text && text.length <= 60 && ['a', 'button', 'label', 'summary'].includes(tag)) {
      return tag + ':has-text("' + text.replace(/"/g, '\\"') + '")';
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      if (node && isUnique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  };

  const out = [];
  const seen = new Set();
  const nodes = document.querySelectorAll(
    'a, button, input, select, textarea, summary, label, [role], [onclick], [contenteditable]',
  );
  for (const el of nodes) {
    if (out.length >= limit) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const selector = selectorFor(el);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    const text =
      (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      '';
    out.push({ selector: selector, tag: el.tagName.toLowerCase(), text: text });
  }
  return out;
}`;

export async function domDigest(page: Page, limit = 150): Promise<DigestEntry[]> {
  return (await page.evaluate(`(${DIGEST_SCRIPT})(${limit})`)) as DigestEntry[];
}

/**
 * Ask Gemini which element on the current page matches the failed step.
 * Returns a selector to retry with, or null if nothing fits.
 */
export async function healSelector(
  page: Page,
  step: RecordedStep,
  model?: string,
): Promise<string | null> {
  const digest = await domDigest(page).catch(() => [] as DigestEntry[]);
  if (digest.length === 0) return null;

  const prompt = [
    'A recorded browser-automation step failed to replay because the page UI changed.',
    '',
    `Failed step: ${describeStep(step)}`,
    `Old selector (no longer works): ${step.selector ?? '(none)'}`,
    step.text ? `Original element text/label: "${step.text}"` : '',
    '',
    'Interactive elements currently on the page:',
    ...digest.map((d, i) => `${i}. <${d.tag}> "${d.text}" — ${d.selector}`),
    '',
    'Which element is the one the step should target now?',
    'Answer with ONLY JSON: {"index": <number>} — the element index above,',
    'or {"index": -1} if no element plausibly matches.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await geminiGenerate({ prompt, json: true, model, temperature: 0 });
    const { index } = parseJsonResponse<{ index: number }>(res);
    if (!Number.isInteger(index) || index < 0 || index >= digest.length) return null;
    return digest[index].selector;
  } catch {
    return null;
  }
}
