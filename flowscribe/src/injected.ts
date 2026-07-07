/**
 * Script injected into every page/frame during recording.
 *
 * It is kept as a raw JavaScript string (not a TS function) so that no
 * transpiler (tsx/esbuild inject `__name` helpers, tsc may downlevel) can
 * alter the code that ends up serialized inside the browser page.
 *
 * It listens for trusted user interactions, draws a visual highlight ripple
 * where the user clicks (so screenshots show exactly where to click),
 * computes a robust selector for the target element, and reports everything
 * back to Node through the `__fsEmit` binding exposed by the recorder.
 */
export const INJECTED_RECORDER_SOURCE = String.raw`(() => {
  if (window.__fsInstalled) return;
  window.__fsInstalled = true;

  const emit = (payload) => {
    try {
      if (typeof window.__fsEmit === 'function') window.__fsEmit(payload);
    } catch (e) {
      /* page might be navigating away — best effort */
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

  /* Short CSS path built from tag + :nth-of-type, as a last resort. */
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

  /* Ranked selector candidates for the element, most reliable first. */
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

    /* Playwright text selector for interactive elements with short text. */
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

  /* Human-readable label for the element (used in the generated guide). */
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

  /* Nearest interactive ancestor — clicking a <span> inside a button
     should be recorded as a click on the button. */
  const interactiveTarget = (el) => {
    const found = el.closest(
      'a, button, input, select, textarea, summary, [role="button"], ' +
        '[role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], ' +
        '[role="radio"], [role="switch"], [role="option"], label, [onclick]',
    );
    return found || el;
  };

  /* Only one highlight at a time — otherwise fast consecutive clicks
     bleed into the next step's screenshot. */
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

  /* Outline the target element itself (rounded box hugging its bounds).
     Returns false when the element is unsuitable (invisible or covering
     most of the viewport, e.g. a click on the page background). */
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

  /* Highlight a click: outline the element itself; fall back to the
     classic ripple ring only when no box fits. */
  const highlight = (x, y, el) => {
    try {
      clearHighlights();
      const boxed = el ? outlineElement(el) : false;
      if (!boxed) {
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

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      const raw = e.target;
      if (!raw || !(raw instanceof Element)) return;
      const el = interactiveTarget(raw);
      /* Draw the highlight synchronously so the screenshot taken from Node
         (a few ms later) captures it. */
      highlight(e.clientX, e.clientY, el);
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      const url = location.href;
      /* Selector computation walks the DOM — defer it out of the event
         path so the app's own click handling is never delayed (heavy
         pages felt glitchy when this ran synchronously). */
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

  /* Label text associated with a form control (label[for=…] or wrapping label). */
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

  const baseFor = (el, tag) => {
    const candidates = selectorCandidates(el);
    return {
      selector: candidates[0] || null,
      selectorCandidates: candidates,
      tag: tag,
      url: location.href,
    };
  };

  /* Selects, checkboxes/radios and file inputs fire discrete 'change' events.
     Work is deferred out of the event path (see pointerdown). */
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!el || !(el instanceof Element)) return;
      const tag = el.tagName.toLowerCase();
      /* File inputs: accept even synthetic events — apps often proxy uploads
         through hidden inputs, and automation (setInputFiles) is synthetic. */
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
      } else if (
        tag === 'input' &&
        (el.type === 'checkbox' || el.type === 'radio')
      ) {
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

  /* Text typing is recorded per keystroke via 'input' (so steps stay in
     the order they really happened); the Node side collapses consecutive
     fills on the same field into one step with the final value. */
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

  /* HTML5 drag & drop: remember the source at dragstart, emit on drop. */
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
  document.addEventListener(
    'dragend',
    () => { dragSource = null; },
    { capture: true },
  );

  /* Hover: only when the pointer dwells >=800ms on a hover-worthy element
     (menus, tooltips). Fleeting mouse travel is ignored. */
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
        /* Outline the hovered element so the screenshot shows what opened
           the menu/tooltip. */
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
        const candidates =
          el && el !== document.body ? selectorCandidates(el) : [];
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
})();`;
