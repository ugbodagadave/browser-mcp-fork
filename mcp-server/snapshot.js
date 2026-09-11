// Compact accessibility snapshot builder (server-side, no extension changes).
//
// Produces a Playwright-style text snapshot: one line per visible interactive
// element or heading, with a stable-per-call ref and a selector hint the agent
// can feed straight back into browser_click / browser_fill. Headings give
// structure; div/span/paragraph soup is omitted for token economy.

const SNAPSHOT_FN_SRC = `((opts) => {
  const maxNodes = opts.maxNodes, cap = opts.cap;
  const out = [];
  let count = 0, done = false;
  function name(el) {
    const a = el.getAttribute && el.getAttribute('aria-label');
    if (a && a.trim()) return a.trim().slice(0, cap);
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => l.innerText || '').join(' ').replace(/\\s+/g, ' ').trim();
      if (t) return t.slice(0, cap);
    }
    const t = ((el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
    if (t) return t.slice(0, cap);
    for (const k of ['value', 'placeholder', 'title', 'alt']) {
      const v = el.getAttribute && el.getAttribute(k);
      if (v && v.trim()) return v.trim().slice(0, cap);
    }
    return '';
  }
  function role(el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const t = (el.tagName || '').toLowerCase();
    if (t === 'input') {
      const ty = ((el.type || 'text') + '').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'submit' || ty === 'button' || ty === 'image') return 'button';
      return 'textbox';
    }
    const map = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', form: 'form', table: 'table', nav: 'navigation', header: 'banner', footer: 'contentinfo', main: 'main', ul: 'list', ol: 'list', li: 'listitem' };
    return map[t] || t;
  }
  function states(el) {
    const s = [];
    if (el.disabled) s.push('disabled');
    if (el.checked) s.push('checked');
    if (el.selected) s.push('selected');
    if (el.getAttribute) {
      if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
      if (el.getAttribute('aria-disabled') === 'true') s.push('disabled');
      if (el.getAttribute('aria-checked') === 'true') s.push('checked');
    }
    return s.length ? ' [' + s.join(',') + ']' : '';
  }
  function suggest(el) {
    if (el.id) return '#' + el.id;
    const tag = (el.tagName || '').toLowerCase();
    const t = ((el.innerText || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    if (t && (tag === 'a' || tag === 'button')) return 'text=' + t;
    return null;
  }
  function visible(el) {
    if (!el.getBoundingClientRect) return true;
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    } catch (e) { return true; }
  }
  function interesting(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (/^(a|button|input|select|textarea|form|img|h1|h2|h3|h4|h5|h6)$/.test(tag)) return true;
    return !!(el.getAttribute && el.getAttribute('role'));
  }
  function walk(root) {
    const kids = root.children || [];
    for (const el of kids) {
      if (done) return;
      if (count >= maxNodes) { done = true; return; }
      const tag = (el.tagName || '').toLowerCase();
      if (/^(script|style|noscript|meta|link|svg|path|circle)$/.test(tag)) continue;
      if (tag === 'input' && ((el.type || '') + '').toLowerCase() === 'hidden') continue;
      if (interesting(el) && visible(el)) {
        count++;
        const sg = suggest(el);
        out.push('[' + count + '] ' + role(el) + ' ' + JSON.stringify(name(el)) + states(el) + (sg ? ' -> ' + sg : ''));
      }
      walk(el);
    }
  }
  let root = document.body;
  if (opts.root) { try { const r = document.querySelector(opts.root); if (r) root = r; } catch (e) {} }
  walk(root);
  return { snapshot: out.join('\\n'), nodes: count, truncated: done, url: location.href, title: document.title };
})`;

export function buildSnapshotCode({ maxNodes = 250, root = null } = {}) {
  const safeNodes = Math.max(1, Math.min(maxNodes | 0, 1000));
  return `(${SNAPSHOT_FN_SRC})(${JSON.stringify({ maxNodes: safeNodes, cap: 80, root })})`;
}

export async function snapshotRun(call, args, partition) {
  const raw = await call('execute_script', { code: buildSnapshotCode({ maxNodes: args?.max_nodes, root: args?.root }) }, 20000, partition);
  const data = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
  const snap = typeof data === 'string' ? { snapshot: data, nodes: -1, truncated: false } : data;
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        url: snap.url,
        title: snap.title,
        nodes: snap.nodes,
        truncated: snap.truncated,
        chars: (snap.snapshot || '').length,
        hint: snap.truncated ? 'truncated: narrow with root selector or raise max_nodes' : 'refs are per-snapshot; use the -> selector hints with browser_click/browser_fill',
        snapshot: snap.snapshot,
      }, null, 2),
    }],
  };
}
