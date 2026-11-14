import { randomUUID } from 'node:crypto'
import { BrowserWindow, session, type Session, type WebContents } from 'electron'
import { isLoopbackHost } from './agent/loopback'
import { blockFileChoosers, hardenUntrustedSession } from './hardenedSession'
import { attachCdp, cdpFullPage, cdpScreenshot, emulateViewport, type Cdp } from './cdp'
import { setBrowserBackend, type BrowserBackend, type BrowserPage, type NetworkEntry } from './agent/browserSession'
import {
  REF_ATTRIBUTE,
  setCaptureBackend,
  VIEWPORT,
  type CaptureDeps,
  type CaptureEmulation,
  type CaptureStep,
  type ConsoleEntry,
  type PressKey,
  type Rect
} from './agent/viewlocalhost'
import { markHelperWindow } from './helperWindows'

/**
 * Electron-backed `open` factory for the `view_localhost` agent tool — the real
 * offscreen BrowserWindow behind the pure orchestration in `agent/viewlocalhost.ts`.
 *
 * This lives in the shell (not under `agent/`) so the engine's dependency graph
 * stays free of `electron`: the engine imports the orchestration + the
 * `setCaptureBackend` seam; this module supplies the runtime capability and is
 * wired once at startup via {@link wireLocalhostCapture}.
 */

/** Give the offscreen compositor a beat to paint after load before capturing. */
const PAINT_SETTLE_MS = 350
/** Longest a click, double click, or key press waits for the navigation it started (a form post, a link). */
const CLICK_NAV_TIMEOUT_MS = 15_000
/** Poll interval while waiting on navigation, a `wait_for` selector, or an `expect_text` condition. */
const POLL_MS = 100
/** Most page text read back over IPC; formatPageText cuts it much shorter. */
const RAW_PAGE_TEXT_CHARS = 50_000
/** What a fill step's script returns instead of 'ok' when it typed into a password field. */
const FILLED_PASSWORD = 'ok:password'

/**
 * Prepended to every step script. The capture window disables native dialogs
 * (see openElectronWindow), so an unguarded confirm would answer cancel. A step is
 * the agent choosing to click whatever asked, so answer confirm with OK instead and
 * record each message on the console (the model sees it). Idempotent per document.
 */
const DIALOG_GUARD = `if (!window.__houstonDialogs) {
  window.__houstonDialogs = true;
  window.alert = (m) => console.log('[alert] ' + String(m));
  window.confirm = (m) => { console.log('[confirm] ' + String(m) + ' (answered OK)'); return true; };
  window.prompt = (m) => { console.log('[prompt] ' + String(m) + ' (answered cancel)'); return null; };
}`

/**
 * The step error for a selector the page can't parse. Models reach for
 * non-standard pseudo-classes from other selector engines, so say what works.
 */
export const INVALID_SELECTOR =
  'invalid CSS selector (only standard CSS works; :contains() and :has-text() are not supported)'

/**
 * Electron `sendInputEvent` key codes for each `press` key, and whether the key
 * also types a character. A real keyboard sends that `char` event for Enter and
 * Space only, and Chromium needs it: it is what submits a form on Enter and
 * activates a focused button.
 */
export const PRESS_INPUT: Record<PressKey, { keyCode: string; char: boolean }> = {
  Enter: { keyCode: 'Enter', char: true },
  Escape: { keyCode: 'Escape', char: false },
  Tab: { keyCode: 'Tab', char: false },
  Backspace: { keyCode: 'Backspace', char: false },
  Delete: { keyCode: 'Delete', char: false },
  Space: { keyCode: 'Space', char: true },
  ArrowUp: { keyCode: 'Up', char: false },
  ArrowDown: { keyCode: 'Down', char: false },
  ArrowLeft: { keyCode: 'Left', char: false },
  ArrowRight: { keyCode: 'Right', char: false },
  Home: { keyCode: 'Home', char: false },
  End: { keyCode: 'End', char: false },
  PageUp: { keyCode: 'PageUp', char: false },
  PageDown: { keyCode: 'PageDown', char: false }
}

/** A focused file input opens the OS file chooser on Enter or Space; never let a step reach it. */
const FOCUSED_FILE_INPUT = `document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'file'`

/**
 * The page-side script for a fill, click, or dblclick step, or the setup before
 * a press (focus the target; the key itself is sent as real input afterwards).
 * The selector and value are embedded as JSON string literals so they can't
 * break out of the expression. Returns 'ok' (FILLED_PASSWORD for a fill into a
 * password field, so the value can be scrubbed from what the capture reports) or
 * a reason the step could not run.
 */
export function stepScript(step: Extract<CaptureStep, { action: 'fill' | 'click' | 'dblclick' | 'press' }>): string {
  if (step.action === 'press' && step.selector === undefined) {
    return `(() => { ${DIALOG_GUARD}
    if (${FOCUSED_FILE_INPUT}) return 'file inputs are not supported';
    return 'ok';
  })()`
  }
  const sel = JSON.stringify(step.selector)
  const find = `let el;
    try { el = document.querySelector(${sel}); } catch { return ${JSON.stringify(INVALID_SELECTOR)}; }
    if (!el) return 'no element matches the selector';
    if (el instanceof HTMLInputElement && el.type === 'file') return 'file inputs are not supported';`
  if (step.action === 'press') {
    return `(() => { ${DIALOG_GUARD}
    ${find}
    el.scrollIntoView({ block: 'center' });
    if (typeof el.focus === 'function') el.focus();
    if (document.activeElement !== el) return 'the element cannot take keyboard focus';
    return 'ok';
  })()`
  }
  if (step.action === 'dblclick') {
    // The full event sequence a real double click produces: two clicks, then dblclick.
    return `(() => { ${DIALOG_GUARD}
    ${find}
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    for (const detail of [1, 2]) {
      for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { ...at, detail }));
    }
    el.dispatchEvent(new MouseEvent('dblclick', { ...at, detail: 2 }));
    return 'ok';
  })()`
  }
  if (step.action === 'click') {
    return `(() => { ${DIALOG_GUARD}
    ${find}
    el.scrollIntoView({ block: 'center' });
    if (el instanceof HTMLElement) el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`
  }
  return `(() => { ${DIALOG_GUARD}
    ${find}
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      return 'the element is not an input, textarea, or select';
    }
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, ${JSON.stringify(step.value)});
    else el.value = ${JSON.stringify(step.value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el instanceof HTMLInputElement && el.type === 'password' ? ${JSON.stringify(FILLED_PASSWORD)} : 'ok';
  })()`
}

/**
 * Page-side check for an `expect_text` step. It matches rendered text
 * (`innerText`, so hidden elements and form field values don't count), with runs
 * of whitespace collapsed and case ignored, since CSS `text-transform` changes
 * the case `innerText` reports. With a selector, any visible matching element
 * counts. Returns 'found', 'missing', 'none' (no visible element to look in), or
 * 'invalid' for a selector the page can't parse.
 */
export function textScript(step: Extract<CaptureStep, { action: 'expect_text' }>): string {
  const scope =
    step.selector === undefined
      ? 'const els = document.body ? [document.body] : [];'
      : `let els;
    try { els = Array.from(document.querySelectorAll(${JSON.stringify(step.selector)})); } catch { return 'invalid'; }`
  return `(() => {
    const norm = (s) => String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
    const want = norm(${JSON.stringify(step.text)});
    ${scope}
    const shown = els.filter((el) => el.checkVisibility({ visibilityProperty: true }));
    if (!shown.length) return 'none';
    return shown.some((el) => norm(el.innerText || '').includes(want)) ? 'found' : 'missing';
  })()`
}

/** Why an `expect_text` step failed, from the last result its page check returned. */
export function expectTextError(step: Extract<CaptureStep, { action: 'expect_text' }>, last: unknown): string {
  if (last === 'none') {
    return step.selector === undefined ? 'the page has no visible body' : 'no visible element matches the selector'
  }
  return step.absent
    ? `the text is still visible after ${step.timeoutMs}ms`
    : `the text is not visible within ${step.timeoutMs}ms`
}

/**
 * The page's rendered text, capped in the page so a huge document can't flood
 * IPC; `formatPageText` trims it to the returned size. A body that isn't rendered
 * reports nothing, since `innerText` would fall back to its raw `textContent`.
 */
export const PAGE_TEXT_SCRIPT = `(() => {
  const b = document.body;
  return b && b.getClientRects().length ? b.innerText.slice(0, ${RAW_PAGE_TEXT_CHARS}) : '';
})()`

/** Most nodes one accessibility snapshot lists; the rest are summarized in one line. */
export const MAX_SNAPSHOT_NODES = 600

/**
 * Page-side accessibility snapshot for browser_session: the visible page as an
 * indented tree of roles and accessible names (landmarks, headings, lists, controls,
 * images, and the text between them), one line per node. Each element listed gets a
 * stable ref (`e12`), kept in the {@link REF_ATTRIBUTE} attribute so the same element
 * keeps its ref across snapshots and a later step can target it. A password field's
 * value is never read; it shows only whether it is filled. Run without a user gesture.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const ATTR = ${JSON.stringify(REF_ATTRIBUTE)};
  const MAX_NODES = ${MAX_SNAPSHOT_NODES};
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '...' : s);
  const used = new Set();
  let next = 0;
  for (const el of document.querySelectorAll('[' + ATTR + ']')) {
    const m = /^e(\\d+)$/.exec(el.getAttribute(ATTR) || '');
    if (m) next = Math.max(next, Number(m[1]));
  }
  const refFor = (el) => {
    let r = el.getAttribute(ATTR);
    if (!r || !/^e\\d+$/.test(r) || used.has(r)) {
      r = 'e' + (++next);
      el.setAttribute(ATTR, r);
    }
    used.add(r);
    return r;
  };
  const INPUT_ROLE = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox',
    radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', color: 'button', file: 'button' };
  const TAG_ROLE = { BUTTON: 'button', SUMMARY: 'button', TEXTAREA: 'textbox', NAV: 'navigation', MAIN: 'main',
    HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog',
    TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', UL: 'list', OL: 'list', LI: 'listitem',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' };
  const LEAF = new Set(['button', 'link', 'heading', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox',
    'radio', 'slider', 'spinbutton', 'switch', 'img', 'tab', 'menuitem', 'option', 'progressbar']);
  const FROM_CONTENT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'checkbox', 'radio',
    'switch', 'treeitem', 'tooltip', 'cell', 'columnheader']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'OPTION']);
  const roleOf = (el) => {
    const explicit = norm(el.getAttribute('role')).split(' ')[0];
    if (explicit && explicit !== 'none' && explicit !== 'presentation' && explicit !== 'generic') return explicit;
    if (explicit) return '';
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'INPUT') return INPUT_ROLE[el.type] || 'textbox';
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'IMG') return el.getAttribute('alt') === '' ? '' : 'img';
    if (tag === 'svg') return el.getAttribute('aria-label') ? 'img' : '';
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return TAG_ROLE[tag] || '';
  };
  const textOf = (el) => norm(el.innerText || el.textContent);
  const nameOf = (el, role) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = norm(by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' '));
      if (t) return t;
    }
    const label = norm(el.getAttribute('aria-label'));
    if (label) return label;
    if (el.labels && el.labels.length) {
      const t = norm(Array.from(el.labels).map(textOf).join(' '));
      if (t) return t;
    }
    if (el.tagName === 'IMG' || (el.tagName === 'INPUT' && el.type === 'image')) return norm(el.getAttribute('alt'));
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
      return norm(el.value) || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '');
    }
    if (FROM_CONTENT.has(role)) {
      const t = textOf(el);
      if (t) return t;
    }
    return norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
  };
  const attrsOf = (el, role) => {
    const a = [];
    const aria = (n) => el.getAttribute('aria-' + n);
    if (role === 'heading') {
      const lvl = aria('level') || (/^H[1-6]$/.test(el.tagName) ? el.tagName.slice(1) : '');
      if (lvl) a.push('level=' + lvl);
    }
    if (el.disabled === true || aria('disabled') === 'true') a.push('disabled');
    if ((role === 'checkbox' || role === 'radio' || role === 'switch') && el.tagName === 'INPUT') {
      if (el.checked) a.push('checked');
    } else if (aria('checked') === 'true') a.push('checked');
    if (aria('pressed') === 'true') a.push('pressed');
    if (aria('selected') === 'true') a.push('selected');
    const expanded = aria('expanded');
    if (expanded === 'true' || expanded === 'false') a.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.required === true || aria('required') === 'true') a.push('required');
    if (el.tagName === 'INPUT' && el.type === 'password') {
      if (el.value) a.push('filled');
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (!INPUT_ROLE[el.type] || role === 'slider' || role === 'spinbutton') {
        if (el.value) a.push('value=' + JSON.stringify(cut(String(el.value), 100)));
      }
    } else if (el.tagName === 'SELECT') {
      const picked = Array.from(el.selectedOptions || []).map((o) => norm(o.textContent)).filter(Boolean);
      if (picked.length) a.push('value=' + JSON.stringify(cut(picked.join(', '), 100)));
    } else if (role === 'textbox' && el.isContentEditable) {
      const t = textOf(el);
      if (t) a.push('value=' + JSON.stringify(cut(t, 100)));
    }
    if (role === 'link') {
      const href = el.getAttribute('href');
      if (href) a.push('url=' + JSON.stringify(cut(href, 100)));
    }
    return a;
  };
  const shown = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return 'no';
    if (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true })) return 'yes';
    // An element with no box of its own (display: contents) still shows its children.
    return getComputedStyle(el).display === 'contents' ? 'children' : 'no';
  };
  const lines = [];
  let more = 0;
  const emit = (depth, text) => {
    if (lines.length >= MAX_NODES) { more++; return; }
    lines.push('  '.repeat(depth) + '- ' + text);
  };
  const walk = (node, depth) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = norm(child.textContent);
        if (t) emit(depth, 'text ' + JSON.stringify(cut(t, 200)));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      if (SKIP.has(el.tagName) || (el.tagName === 'INPUT' && el.type === 'hidden')) continue;
      const vis = shown(el);
      if (vis === 'no') continue;
      const role = vis === 'yes' ? roleOf(el) : '';
      let inner = depth;
      if (role) {
        const name = nameOf(el, role);
        const attrs = attrsOf(el, role);
        emit(depth, role + (name ? ' ' + JSON.stringify(cut(name, 100)) : '') +
          (attrs.length ? ' [' + attrs.join(', ') + ']' : '') + ' [ref=' + refFor(el) + ']');
        if (LEAF.has(role)) continue;
        inner = depth + 1;
      }
      if (el.tagName !== 'svg') walk(el, inner);
      if (el.shadowRoot) walk(el.shadowRoot, inner);
    }
  };
  if (document.body) walk(document.body, 0);
  if (more) lines.push('- ... ' + more + ' more node(s) not shown');
  return lines.join('\\n');
})()`

/**
 * Page-side check for a `wait_for` step: does the selector match a visible
 * element? Returns 'invalid' for a selector the page can't parse, so the step
 * fails at once instead of polling until its timeout.
 */
export function visibleScript(selector: string): string {
  return `(() => {
    let el;
    try { el = document.querySelector(${JSON.stringify(selector)}); } catch { return 'invalid'; }
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  })()`
}

/**
 * The console line for a dialog the capture window dismissed, from DevTools'
 * `Page.javascriptDialogOpening` params. With dialogs disabled an alert returns at
 * once, a confirm answers cancel, and a beforeunload prompt keeps the page (the
 * navigation a step started doesn't happen).
 */
export function dialogConsoleEntry(params: unknown): ConsoleEntry {
  const p = (params ?? {}) as { type?: unknown; message?: unknown }
  const type = typeof p.type === 'string' ? p.type : 'dialog'
  const message = typeof p.message === 'string' ? p.message : ''
  const answer =
    type === 'alert' ? '' : type === 'beforeunload' ? '(answered stay: navigation cancelled)' : '(answered cancel)'
  return { level: 'info', text: [`[${type}]`, message, answer].filter(Boolean).join(' ') }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const TIMED_OUT = Symbol('timed out')

/** `work`'s result, or TIMED_OUT once `ms` passes first (the abandoned call is left to settle unobserved). */
function withinMs<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<typeof TIMED_OUT>((r) => {
    timer = setTimeout(() => r(TIMED_OUT), ms)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

/**
 * Evaluate `script` every POLL_MS until `settled` accepts its result or
 * `timeoutMs` passes, and return the last result (undefined if it never
 * evaluated). Evaluation can fail transiently mid-navigation, so a throw only
 * means "not yet".
 */
async function pollPage(
  wc: WebContents,
  script: string,
  timeoutMs: number,
  settled: (result: unknown) => boolean
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      // A blocked main thread never answers, so each evaluation gets only the time left.
      const result = await withinMs(wc.executeJavaScript(script, true), Math.max(0, deadline - Date.now()))
      if (result !== TIMED_OUT) {
        last = result
        if (settled(last)) return last
      }
    } catch {
      // Keep polling until the deadline.
    }
    if (Date.now() >= deadline) return last
    await sleep(POLL_MS)
  }
}

/** Normalize a console-message level (number in old Electron, string in new) to a name. */
function consoleLevelName(level: unknown): string {
  if (typeof level === 'string') return level
  switch (level) {
    case 0:
      return 'debug'
    case 1:
      return 'info'
    case 2:
      return 'warning'
    case 3:
      return 'error'
    default:
      return 'log'
  }
}

/** A self-contained expression returning the selector's bounding rect, or null. */
function selectorRectScript(selector: string): string {
  // The selector is embedded as a JSON string literal so it can't break out of the expression.
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`
}

/** Round a rect to integer pixels and clamp it inside the viewport for capturePage. */
function roundRect(rect: Rect, viewport: { width: number; height: number } = VIEWPORT): Rect {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.ceil(rect.width), viewport.width - x)),
    height: Math.max(1, Math.min(Math.ceil(rect.height), viewport.height - y))
  }
}

/**
 * In-memory session (isolated from the app's default session, so it can't touch
 * app cookies/cache and its request filter doesn't affect the main window) whose
 * web requests are blocked from reaching private/LAN/metadata hosts. Installed
 * once and reused across captures — the filter is stateless.
 */
const CAPTURE_PARTITION = 'view-localhost-capture'
let captureFilterInstalled = false

function captureSession(): Session {
  // No HTTP cache: a capture loads a page once and closes, so a cache only grew in the
  // network process for the life of the app, and could hand a later capture a stale
  // asset from a dev server that had since rebuilt it.
  const ses = session.fromPartition(CAPTURE_PARTITION, { cache: false })
  if (!captureFilterInstalled) {
    // Subresource egress filter + download block + permission denial. Steps can
    // click links and buttons, so a page must never save a file to the user's disk
    // or gain camera/microphone/location/notifications. Shared with the interactive
    // Preview dock so both untrusted-page surfaces stay locked down identically.
    hardenUntrustedSession(ses)
    captureFilterInstalled = true
  }
  return ses
}

/** Most console lines a browser_session page keeps; older ones are dropped as new ones arrive. */
export const SESSION_CONSOLE_LIMIT = 1_000
/** Most requests a browser_session page's network log keeps. */
export const SESSION_NETWORK_LIMIT = 500

async function openElectronWindow(opts: {
  width: number
  height: number
  emulate?: CaptureEmulation
  /**
   * A browser_session page's own session, already hardened with the same guards as
   * the capture session (see openBrowserPage). Absent for a view_localhost capture.
   */
  ses?: Session
  /** Keep at most this many console lines (a page that stays open). Absent: keep all. */
  consoleLimit?: number
}): Promise<BrowserPage> {
  const win = new BrowserWindow({
    show: false,
    width: opts.width,
    height: opts.height,
    webPreferences: {
      // Offscreen rendering so the window never flashes on screen; the page is
      // untrusted, so it's sandboxed, isolated, has no Node integration, and runs
      // in a private session whose requests can't reach private/LAN/metadata hosts.
      session: opts.ses ?? captureSession(),
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      // A native alert/confirm raised outside a step's DIALOG_GUARD (during load,
      // after a navigation, or through a fresh iframe's window) would block the page
      // with no one to answer it, and Electron would show it on the user's screen
      // and un-hide this window behind it. Return at once instead: alert returns,
      // confirm answers cancel. Each one is still reported to the model (below).
      disableDialogs: true
    }
  })
  markHelperWindow(win)
  const wc = win.webContents
  // Offscreen windows only paint into their bitmap when given a frame rate.
  wc.setFrameRate(30)

  // Keep the main frame pinned to loopback. BrowserWindow follows redirects
  // internally, so without this a localhost page could 302 the top-level
  // navigation to a public or internal host (e.g. cloud metadata) and we'd
  // screenshot/report that — the same SSRF that webfetch guards per redirect hop.
  // (Subresources are filtered separately by the capture session above: internal
  // hosts blocked, public CDNs allowed so pages still render.)
  const blockOffHost = (event: { preventDefault: () => void }, navUrl: string): void => {
    let host = ''
    try {
      host = new URL(navUrl).hostname
    } catch {
      /* malformed → treat as off-host and block */
    }
    if (!isLoopbackHost(host)) event.preventDefault()
  }
  wc.on('will-navigate', (e, navUrl) => blockOffHost(e, navUrl))
  wc.on('will-redirect', (e, navUrl) => blockOffHost(e, navUrl))
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  const entries: ConsoleEntry[] = []
  const typedSecrets: string[] = []
  // The `console-message` payload shape changed across Electron majors — accept both.
  wc.on('console-message', (eventOrLevel: unknown, level?: unknown, message?: unknown) => {
    const e = eventOrLevel as { level?: unknown; message?: unknown } | undefined
    const lvl = level ?? e?.level
    const txt = message ?? e?.message ?? ''
    entries.push({ level: consoleLevelName(lvl), text: String(txt) })
    if (opts.consoleLimit !== undefined && entries.length > opts.consoleLimit) {
      entries.splice(0, entries.length - opts.consoleLimit)
    }
  })
  // A renderer that crashed leaves a window that answers nothing: the session reopens.
  let gone = false
  wc.on('render-process-gone', () => {
    gone = true
  })

  // Every capture gets a DevTools client, attached on a blank page before the real
  // one loads (see cdp.ts). It cancels any file picker the page opens: steps run
  // with user activation, so a click on a file input's label (or a button that
  // calls input.click()) would otherwise open the OS picker on the user's screen.
  // A variant also forces its color scheme (a plain capture follows the OS theme)
  // and device type through it, so the first paint already uses them.
  let cdp: Cdp | undefined
  let fileChoosersBlocked: boolean
  try {
    await win.loadURL('about:blank')
    cdp = attachCdp(wc)
    fileChoosersBlocked = await blockFileChoosers(cdp, () =>
      entries.push({ level: 'warning', text: '[file chooser] cancelled: view_localhost cannot choose files' })
    )
    // With the Page domain on (blockFileChoosers enabled it), the client still sees
    // every dialog disableDialogs dismissed, so the model reads what it said.
    cdp.on((method, params) => {
      if (method === 'Page.javascriptDialogOpening') entries.push(dialogConsoleEntry(params))
    })
    if (opts.emulate) await emulateViewport(cdp, { width: opts.width, height: opts.height, ...opts.emulate })
  } catch (err) {
    // The caller only closes a session it got back, so don't leave the window behind.
    cdp?.detach()
    if (!win.isDestroyed()) win.destroy()
    throw err
  }

  return {
    load(url) {
      return new Promise((resolve, reject) => {
        let done = false
        const settle = (r: { loadError?: string }): void => {
          if (done) return
          done = true
          setTimeout(() => resolve(r), PAINT_SETTLE_MS)
        }
        wc.once('did-finish-load', () => settle({}))
        wc.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
          // Only the main frame's failure means the page itself didn't load.
          if (isMainFrame) settle({ loadError: `${errorDescription || 'load failed'} (${errorCode})` })
        })
        win.loadURL(url).catch((err) => {
          if (!done) {
            done = true
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
    },
    title: () => win.getTitle(),
    url: () => wc.getURL(),
    async rectForSelector(selector) {
      try {
        // No user gesture: measuring an element must not give the page activation to spend.
        const rect = (await wc.executeJavaScript(selectorRectScript(selector), false)) as Rect | null
        return rect && rect.width > 0 && rect.height > 0 ? rect : null
      } catch {
        return null
      }
    },
    async screenshot(rect) {
      // An emulated page must be captured through the protocol, which renders it at
      // the emulated size; capturePage would grab the window's own bitmap.
      if (opts.emulate) {
        if (!rect) return cdpScreenshot(cdp)
        // The protocol clips in page coordinates; the rect is relative to the
        // viewport, which a step may have scrolled (scrollIntoView before a click).
        const scroll = (await wc.executeJavaScript('({ x: window.scrollX, y: window.scrollY })', false)) as {
          x: number
          y: number
        }
        const r = roundRect(rect, opts)
        return cdpScreenshot(cdp, { ...r, x: r.x + scroll.x, y: r.y + scroll.y })
      }
      const image = rect ? await wc.capturePage(roundRect(rect, opts)) : await wc.capturePage()
      return image.toPNG()
    },
    async screenshotFullPage(maxHeight) {
      return cdpFullPage(cdp, opts.width, opts.height, maxHeight)
    },
    consoleEntries: () => entries,
    async runStep(step) {
      // Every step hands the page user activation, which is all it needs to open
      // a file picker. Run none unless pickers are being cancelled.
      if (!fileChoosersBlocked) {
        return { ok: false, error: 'steps are unavailable: file pickers could not be blocked in this page' }
      }
      try {
        if (step.action === 'wait') {
          await sleep(step.ms)
          return { ok: true }
        }
        if (step.action === 'wait_for') {
          const seen = await pollPage(
            wc,
            visibleScript(step.selector),
            step.timeoutMs,
            (r) => r === true || r === 'invalid'
          )
          if (seen === 'invalid') return { ok: false, error: INVALID_SELECTOR }
          if (seen === true) return { ok: true }
          return { ok: false, error: `no visible element matched within ${step.timeoutMs}ms` }
        }
        if (step.action === 'expect_text') {
          const pass = step.absent ? 'missing' : 'found'
          const last = await pollPage(wc, textScript(step), step.timeoutMs, (r) => r === pass || r === 'invalid')
          if (last === 'invalid') return { ok: false, error: INVALID_SELECTOR }
          if (last === pass) return { ok: true }
          return { ok: false, error: expectTextError(step, last) }
        }
        const result = (await wc.executeJavaScript(stepScript(step), true)) as string
        if (result === FILLED_PASSWORD && step.action === 'fill') typedSecrets.push(step.value)
        else if (result !== 'ok') return { ok: false, error: result }
        if (step.action === 'press') {
          // Real input, not a synthetic KeyboardEvent: only a trusted key press
          // submits a form on Enter or activates a focused button.
          const { keyCode, char } = PRESS_INPUT[step.key]
          wc.sendInputEvent({ type: 'keyDown', keyCode })
          if (char) wc.sendInputEvent({ type: 'char', keyCode })
          wc.sendInputEvent({ type: 'keyUp', keyCode })
        }
        if (step.action !== 'fill') {
          // Give a navigation (form post, link) a moment to start, then let it finish.
          await sleep(POLL_MS)
          const deadline = Date.now() + CLICK_NAV_TIMEOUT_MS
          while (wc.isLoading() && Date.now() < deadline) await sleep(POLL_MS)
        }
        await sleep(PAINT_SETTLE_MS)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    async pageText() {
      try {
        const text: unknown = await wc.executeJavaScript(PAGE_TEXT_SCRIPT, false)
        return typeof text === 'string' ? text : null
      } catch {
        return null
      }
    },
    typedSecrets: () => typedSecrets,
    async snapshot() {
      try {
        // No user gesture: reading the tree must not give the page activation to spend.
        const tree: unknown = await wc.executeJavaScript(SNAPSHOT_SCRIPT, false)
        return typeof tree === 'string' ? tree : null
      } catch {
        return null
      }
    },
    networkEntries: () => [],
    isClosed: () => gone || win.isDestroyed(),
    close: () => {
      cdp.detach()
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

const electronCaptureDeps: CaptureDeps = { open: openElectronWindow }

/** Request details the network log reads (a slice of Electron's webRequest details). */
interface RequestDetails {
  id: number
  url: string
  method: string
  timestamp: number
  resourceType?: string
  statusCode?: number
  error?: string
}

/**
 * Open a browser_session page: the same offscreen window a view_localhost capture
 * uses (same loopback pin, dialog and file-picker suppression), in a session of its
 * own so its cookies outlive one call but are never shared with another run, a
 * capture, or the app. The session gets exactly the capture session's guards
 * ({@link hardenUntrustedSession}); the network log only observes requests the guard
 * already let through or cancelled, through listeners that cannot change them.
 */
async function openBrowserPage(opts: { width: number; height: number }): Promise<BrowserPage> {
  // In memory (no `persist:` prefix) and without an HTTP cache, like the capture session.
  const ses = session.fromPartition(`browser-session-${randomUUID()}`, { cache: false })
  hardenUntrustedSession(ses)
  const log: NetworkEntry[] = []
  const started = new Map<number, number>()
  const record = (d: RequestDetails): void => {
    const start = started.get(d.id)
    started.delete(d.id)
    log.push({
      method: d.method,
      url: d.url,
      ...(d.statusCode !== undefined && !d.error ? { status: d.statusCode } : {}),
      ...(d.error ? { error: d.error } : {}),
      ...(start !== undefined ? { durationMs: Math.max(0, d.timestamp - start) } : {}),
      ...(d.resourceType ? { resourceType: d.resourceType } : {})
    })
    if (log.length > SESSION_NETWORK_LIMIT) log.splice(0, log.length - SESSION_NETWORK_LIMIT)
  }
  ses.webRequest.onSendHeaders((d: RequestDetails) => {
    if (started.size < SESSION_NETWORK_LIMIT * 4) started.set(d.id, d.timestamp)
  })
  ses.webRequest.onCompleted((d: RequestDetails) => record(d))
  ses.webRequest.onErrorOccurred((d: RequestDetails) => record(d))
  const page = await openElectronWindow({ ...opts, ses, consoleLimit: SESSION_CONSOLE_LIMIT }).catch((err) => {
    void ses.clearStorageData().catch(() => {})
    throw err
  })
  return {
    ...page,
    networkEntries: () => log,
    close: () => {
      page.close()
      // Nothing the page stored outlives the session.
      void ses.clearStorageData().catch(() => {})
    }
  }
}

const electronBrowserBackend: BrowserBackend = { open: openBrowserPage }

/**
 * Bind the agent's `view_localhost` and `browser_session` tools to the real Electron
 * backends. Call once at startup.
 */
export function wireLocalhostCapture(): void {
  setCaptureBackend(electronCaptureDeps)
  setBrowserBackend(electronBrowserBackend)
}
