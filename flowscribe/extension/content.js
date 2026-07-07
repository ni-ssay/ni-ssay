/*
 * FlowScribe Recorder — content script.
 *
 * Mirror of src/injected.ts (the Playwright-injected recorder), adapted for
 * a Chrome extension: events are sent to the background service worker via
 * chrome.runtime.sendMessage instead of a Playwright binding. Keep the two
 * in sync when changing capture behaviour.
 */
(() => {
  if (window.__fsInstalled) return;
  window.__fsInstalled = true;

  const emit = (payload) => {
    try {
      payload.ts = Date.now();
      payload.viewport = { width: window.innerWidth, height: window.innerHeight };
      chrome.runtime.sendMessage({ type: 'fs-event', payload });
    } catch (e) {
      /* extension may be reloading — best effort */
    }
  };

  const cssEscape = (v) =>
    window.CSS && window.CSS.escape
      ? window.CSS.escape(v)
      : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1');

  const isUnique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  };

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName,
        );
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = parent;
      if (node && isUnique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  };

  const selectorCandidates = (el) => {
    const out = [];
    const push = (sel) => {
      if (sel && isUnique(sel) && !out.includes(sel)) out.push(sel);
    };
    const testId =
      el.getAttribute('data-testid') ||
      el.getAttribute('data-test-id') ||
      el.getAttribute('data-test');
    if (testId) push('[data-testid="' + testId + '"]');
    if (el.id && !/\d{4,}/.test(el.id)) push('#' + cssEscape(el.id));
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) push(tag + '[name="' + name + '"]');
    const aria = el.getAttribute('aria-label');
    if (aria) push(tag + '[aria-label="' + aria + '"]');
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) push(tag + '[placeholder="' + placeholder + '"]');
    const title = el.getAttribute('title');
    if (title) push(tag + '[title="' + title + '"]');
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (
      text &&
      text.length <= 60 &&
      ['a', 'button', 'label', 'summary', 'option'].includes(tag)
    ) {
      out.push(tag + ':has-text("' + text.replace(/"/g, '\\"') + '")');
    }
    const path = cssPath(el);
    if (path) push(path);
    if (out.length === 0 && path) out.push(path);
    return out;
  };

  const describe = (el) => {
    const text =
      (el.textContent || '').trim().replace(/\s+/g, ' ') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.value ||
      el.getAttribute('alt') ||
      '';
    return String(text).slice(0, 80);
  };

  const interactiveTarget = (el) => {
    const found = el.closest(
      'a, button, input, select, textarea, summary, [role="button"], ' +
        '[role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], ' +
        '[role="radio"], [role="switch"], [role="option"], label, [onclick]',
    );
    return found || el;
  };

  const fieldLabel = (el) => {
    const clean = (t) => (t || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (el.id) {
      const l = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (l) return clean(l.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent);
    return '';
  };

  const clearHighlights = () => {
    document
      .querySelectorAll('[data-flowscribe="highlight"]')
      .forEach((n) => n.remove());
  };

  const addOverlay = (css) => {
    const node = document.createElement('div');
    node.setAttribute('data-flowscribe', 'highlight');
    node.style.cssText = css + ';pointer-events:none;z-index:2147483647;';
    document.documentElement.appendChild(node);
    setTimeout(() => node.remove(), 1600);
    return node;
  };

  const outlineElement = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return false;
      if (r.width * r.height > window.innerWidth * window.innerHeight * 0.6) return false;
      addOverlay(
        'position:fixed;left:' + (r.left - 5) + 'px;top:' + (r.top - 5) + 'px;' +
        'width:' + (r.width + 10) + 'px;height:' + (r.height + 10) + 'px;' +
        'border:3px solid #ff3b30;border-radius:10px;' +
        'box-shadow:0 0 0 3px rgba(255,59,48,0.25),0 0 16px rgba(255,59,48,0.5);' +
        'background:rgba(255,59,48,0.06)',
      );
      return true;
    } catch (e) {
      return false;
    }
  };

  const highlight = (x, y, el) => {
    try {
      clearHighlights();
      const boxed = el ? outlineElement(el) : false;
      if (boxed) {
        addOverlay(
          'position:fixed;left:' + (x - 7) + 'px;top:' + (y - 7) + 'px;' +
          'width:14px;height:14px;border-radius:50%;background:#ff3b30;' +
          'border:3px solid #fff;box-shadow:0 0 8px rgba(255,59,48,0.8)',
        );
      } else {
        const ring = addOverlay(
          'position:fixed;left:' + (x - 22) + 'px;top:' + (y - 22) + 'px;' +
          'width:44px;height:44px;border:4px solid #ff3b30;border-radius:50%;' +
          'box-shadow:0 0 0 4px rgba(255,59,48,0.35),0 0 18px rgba(255,59,48,0.6);' +
          'background:rgba(255,59,48,0.12)',
        );
        const dot = document.createElement('div');
        dot.style.cssText =
          'position:absolute;left:50%;top:50%;width:8px;height:8px;' +
          'margin:-4px 0 0 -4px;border-radius:50%;background:#ff3b30;';
        ring.appendChild(dot);
      }
    } catch (e) {
      /* ignore */
    }
  };

  const baseFor = (el, tag) => {
    const candidates = selectorCandidates(el);
    return {
      selector: candidates[0] || null,
      selectorCandidates: candidates,
      tag: tag,
      url: location.href,
    };
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      const raw = e.target;
      if (!raw || !(raw instanceof Element)) return;
      const el = interactiveTarget(raw);
      highlight(e.clientX, e.clientY, el);
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      const url = location.href;
      // Deferred out of the event path so the app's own click handling is
      // never delayed (kept in sync with src/injected.ts).
      setTimeout(() => {
        const candidates = selectorCandidates(el);
        emit({
          kind: 'click',
          selector: candidates[0] || null,
          selectorCandidates: candidates,
          tag: el.tagName.toLowerCase(),
          text:
            el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')
              ? fieldLabel(el) || describe(el)
              : describe(el) || fieldLabel(el),
          x: x,
          y: y,
          url: url,
        });
      }, 0);
    },
    { capture: true },
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!el || !(el instanceof Element)) return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && el.type === 'file') {
        const files = Array.from(el.files || []).map((f) => f.name);
        if (files.length === 0) return;
        setTimeout(() => {
          emit(Object.assign({}, baseFor(el, tag), {
            kind: 'upload',
            files: files,
            text: fieldLabel(el) || el.getAttribute('name') || '',
          }));
        }, 0);
        return;
      }
      if (!e.isTrusted) return;
      if (tag === 'select') {
        const value = el.value;
        const opt = el.selectedOptions && el.selectedOptions[0];
        const text = opt ? opt.textContent || value : value;
        setTimeout(() => {
          emit(Object.assign({}, baseFor(el, tag), {
            kind: 'select',
            value: value,
            text: text,
          }));
        }, 0);
      } else if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        const checked = el.checked;
        setTimeout(() => {
          emit(Object.assign({}, baseFor(el, tag), {
            kind: 'check',
            checked: checked,
            text: fieldLabel(el) || describe(el),
          }));
        }, 0);
      }
    },
    { capture: true },
  );

  document.addEventListener(
    'input',
    (e) => {
      if (!e.isTrusted) return;
      const el = e.target;
      if (!el || !(el instanceof Element)) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file')) return;
      setTimeout(() => {
        emit(Object.assign({}, baseFor(el, tag), {
          kind: 'fill',
          value: el.value,
          masked: el.type === 'password',
          text:
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            fieldLabel(el) ||
            el.getAttribute('name') ||
            '',
        }));
      }, 0);
    },
    { capture: true },
  );

  let dragSource = null;
  document.addEventListener(
    'dragstart',
    (e) => {
      if (!e.isTrusted) return;
      const raw = e.target;
      if (!raw || !(raw instanceof Element)) return;
      const el = raw.closest('[draggable="true"]') || raw;
      const candidates = selectorCandidates(el);
      dragSource = {
        selector: candidates[0] || null,
        selectorCandidates: candidates,
        tag: el.tagName.toLowerCase(),
        text: describe(el),
      };
    },
    { capture: true },
  );
  document.addEventListener(
    'drop',
    (e) => {
      if (!e.isTrusted || !dragSource) return;
      const raw = e.target;
      if (!raw || !(raw instanceof Element)) return;
      const targetCandidates = selectorCandidates(raw);
      emit({
        kind: 'drag',
        selector: dragSource.selector,
        selectorCandidates: dragSource.selectorCandidates,
        tag: dragSource.tag,
        text: dragSource.text,
        targetSelector: targetCandidates[0] || null,
        targetText: describe(raw),
        url: location.href,
      });
      dragSource = null;
    },
    { capture: true },
  );
  document.addEventListener('dragend', () => { dragSource = null; }, { capture: true });

  let hoverTimer = null;
  let hoverEl = null;
  let lastHoverEmitted = null;
  const hoverWorthy = (el) => {
    try {
      return el.matches('a, button, summary, [aria-haspopup], [role], [data-hover]');
    } catch (e) { return false; }
  };
  document.addEventListener(
    'mouseover',
    (e) => {
      if (!e.isTrusted) return;
      const raw = e.target;
      if (!raw || !(raw instanceof Element)) return;
      const el = interactiveTarget(raw);
      if (el === hoverEl) return;
      hoverEl = el;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = null;
      if (!hoverWorthy(el)) return;
      hoverTimer = setTimeout(() => {
        if (el === lastHoverEmitted) return;
        lastHoverEmitted = el;
        clearHighlights();
        outlineElement(el);
        const candidates = selectorCandidates(el);
        emit({
          kind: 'hover',
          selector: candidates[0] || null,
          selectorCandidates: candidates,
          tag: el.tagName.toLowerCase(),
          text: describe(el),
          url: location.href,
        });
      }, 800);
    },
    { capture: true },
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      if (!['Enter', 'Escape', 'Tab'].includes(e.key)) return;
      const el = document.activeElement;
      const key = e.key;
      const url = location.href;
      setTimeout(() => {
        const candidates = el && el !== document.body ? selectorCandidates(el) : [];
        emit({
          kind: 'press',
          key: key,
          selector: candidates[0] || null,
          selectorCandidates: candidates,
          url: url,
        });
      }, 0);
    },
    { capture: true },
  );
})();
