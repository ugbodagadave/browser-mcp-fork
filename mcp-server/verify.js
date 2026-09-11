// Effect verification for mutating tools (server-side, no extension changes).
//
// Philosophy: inputs get HARD verification (a read-back mismatch is definite
// proof the value did not land, so ok is downgraded). Clicks get ADVISORY
// verification (observed effect attached; ok is only downgraded when the
// extension itself reports the action did not land), because legitimate clicks
// (copy buttons, downloads) can have no visible effect.

const DESCRIBE_SRC = `((sel) => {
  function desc(el) {
    if (!el) return { found: false };
    const o = { found: true, tag: (el.tagName || '').toLowerCase() };
    if ('value' in el) { try { o.value = String(el.value); } catch (e) {} }
    if ((el.tagName || '') === 'SELECT') {
      try {
        o.values = [...el.selectedOptions].map((x) => x.value);
        o.text = [...el.selectedOptions].map((x) => (x.text || '').trim());
      } catch (e) {}
    }
    if (el.type === 'checkbox' || el.type === 'radio') o.checked = !!el.checked;
    const t = ((el.innerText || '') + '').replace(/\\s+/g, ' ').trim();
    if (t) o.textSingle = t.slice(0, 200);
    let sig = '';
    try {
      sig = [(o.value || ''), (o.checked || ''), (el.getAttribute && el.getAttribute('aria-checked')) || '', (el.getAttribute && el.getAttribute('aria-expanded')) || '', (el.outerHTML || '').length].join('|');
    } catch (e) {}
    o.sig = sig;
    return o;
  }
  let el = null;
  if (/^text=/.test(sel)) {
    const q = sel.slice(5).toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n; const cands = [];
    while ((n = walker.nextNode())) {
      const t = ((n.innerText || '') + '').trim();
      if (t && t.toLowerCase().indexOf(q) !== -1) cands.push(n);
      if (cands.length > 60) break;
    }
    el = cands.find((n) => /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(n.tagName)) || cands[0] || null;
    if (!el) {
      const all = [...document.querySelectorAll('input,textarea,select')];
      el = all.find((x) => (((x.getAttribute('aria-label') || '') + ' ' + (x.placeholder || '')) + '').toLowerCase().indexOf(q) !== -1) || null;
    }
  } else {
    try { el = document.querySelector(sel); }
    catch (e) { return { found: false, error: 'bad selector' }; }
  }
  return desc(el);
})`;

function describeCode(selector) {
  return `(${DESCRIBE_SRC})(${JSON.stringify(String(selector))})`;
}

function unwrap(raw) {
  if (raw && typeof raw === 'object' && 'result' in raw) return raw.result;
  return raw;
}

function expectedFor(name, rest) {
  if (name === 'browser_fill') return { kind: 'single', values: [String(rest.value)] };
  if (name === 'browser_select_option') return { kind: 'single', values: [String(rest.option)] };
  if (name === 'browser_set_date') return { kind: 'single', values: [String(rest.date)] };
  if (name === 'browser_set_combobox') {
    const vals = rest.values || (rest.value !== undefined ? [rest.value] : []);
    return { kind: 'multi', values: vals.map(String) };
  }
  return null;
}

function matchInput(exp, got) {
  if (!got || !got.found) return { ok: false, actual: '(target not found)' };
  if (exp.kind === 'multi') {
    const actual = (got.values || (got.value !== undefined ? [got.value] : [])).map(String);
    const missing = exp.values.filter((v) => !actual.includes(v));
    return missing.length
      ? { ok: false, actual: JSON.stringify(actual), missing }
      : { ok: true, actual: JSON.stringify(actual) };
  }
  const want = exp.values[0];
  const actual = got.value !== undefined ? String(got.value)
    : (got.text && got.text[0] !== undefined ? String(Array.isArray(got.text) ? got.text[0] : got.textSingle || '') : (got.textSingle || ''));
  if (actual === want) return { ok: true, actual: JSON.stringify(actual) };
  // select_option accepts a visible label as well as a value
  if (Array.isArray(got.text) && got.text.some((t) => String(t).includes(want))) {
    return { ok: true, actual: JSON.stringify(got.text) };
  }
  return { ok: false, actual: JSON.stringify(actual) };
}

export async function captureClickPre(call, rest, partition) {
  const tabs = await call('list_tabs', {}, 10000, partition);
  const list = tabs.tabs || [];
  const active = list.find((t) => t.active) || list[0] || {};
  let elSig = null;
  const sel = rest.selector || '';
  if (sel && !/^text=/.test(sel)) {
    try {
      const d = unwrap(await call('execute_script', { code: describeCode(sel) }, 8000, partition));
      if (d && d.found) elSig = d.sig;
    } catch {}
  }
  let body = null;
  try {
    body = unwrap(await call('execute_script', {
      code: '(()=>{const t=document.body?document.body.innerText:"";let h=5381;for(let i=0;i<t.length;i++)h=((h<<5)+h+t.charCodeAt(i))|0;return{len:t.length,hash:h};})()',
    }, 8000, partition));
  } catch {}
  return { url: active.url || '', tabCount: list.length, elSig, body };
}

async function clickSignals(rest, call, partition, pre) {
  const signals = [];
  const tabs = await call('list_tabs', {}, 10000, partition);
  const list = tabs.tabs || [];
  const active = list.find((t) => t.active) || list[0] || {};
  if (pre && active.url && pre.url && active.url !== pre.url) signals.push(`navigated to ${active.url}`);
  if (pre && list.length !== pre.tabCount) signals.push(`tab count ${pre.tabCount} -> ${list.length}`);
  const sel = rest.selector || '';
  if (sel && !/^text=/.test(sel)) {
    try {
      const d = unwrap(await call('execute_script', { code: describeCode(sel) }, 8000, partition));
      const sig = d && d.found ? d.sig : 'gone';
      if (pre && pre.elSig !== null && sig !== pre.elSig) signals.push('target element state changed');
      else if (pre && pre.elSig === null && sig !== null && sig !== 'gone') signals.push('target element appeared');
    } catch {}
  }
  try {
    const b = unwrap(await call('execute_script', {
      code: '(()=>{const t=document.body?document.body.innerText:"";let h=5381;for(let i=0;i<t.length;i++)h=((h<<5)+h+t.charCodeAt(i))|0;return{len:t.length,hash:h};})()',
    }, 8000, partition));
    if (pre && pre.body && b && (b.hash !== pre.body.hash || b.len !== pre.body.len)) {
      signals.push('page content changed');
    }
  } catch {}
  return { signals, url: active.url };
}

async function verifyInput(name, rest, result, call, partition) {
  const exp = expectedFor(name, rest);
  let got;
  try {
    got = unwrap(await call('execute_script', { code: describeCode(rest.selector) }, 8000, partition));
  } catch (e) {
    return { ...result, verified: false, verify_note: 'read-back failed: ' + e.message };
  }
  const m = matchInput(exp, got);
  if (m.ok) return { ...result, verified: true, effect: `field now ${m.actual}` };
  const hint = name === 'browser_select_option'
    ? 'the option did not take (React-controlled selects often ignore synthetic selection): snapshot the page and try clicking the option, or set via combobox'
    : 'the field did not take the value (append-instead-of-replace or framework-controlled input): snapshot the page, clear first, and re-target';
  return {
    ...result, ok: false, verified: false,
    effect: `field is ${m.actual}, wanted ${JSON.stringify(exp.values.length > 1 ? exp.values : exp.values[0])}${m.missing ? ` (missing ${JSON.stringify(m.missing)})` : ''}`,
    hint,
  };
}

async function verifyClick(rest, result, call, partition, pre) {
  const out = { ...result };
  // The extension's landing report is one witness, not the verdict: measured
  // live, clicks can fire their handler while landed:false (background tabs),
  // and landed:true says nothing about what the click did. Post-hoc signals
  // below decide; they override a miss report but never invent a success.
  try {
    const { signals, url } = await clickSignals(rest, call, partition, pre);
    void url;
    if (result && result.landed === false && signals.length === 0 && result.ok === false) {
      out.verified = false;
      out.effect = 'click did not land on the target and nothing changed';
      out.hint = 'element may be offscreen, covered, or detached: snapshot the page, scroll it into view, re-target';
      return out;
    }
    out.verified = signals.length > 0;
    out.effect = signals.length ? signals.join('; ') : 'no observable change (url, tabs, target, and page content unchanged)';
    if (result && result.landed === false && signals.length > 0) {
      out.ok = true;
      out.effect += ' (note: the extension reported a miss, but the effect above was observed)';
    } else if (!out.verified) {
      out.verify_note = 'advisory only: some real clicks (copy, download) have no visible effect';
    }
  } catch (e) {
    out.verified = false;
    out.verify_note = 'effect check failed: ' + e.message;
  }
  return out;
}

async function verifyNavigate(rest, result, call, partition) {
  const out = { ...result };
  try {
    const tabs = await call('list_tabs', {}, 10000, partition);
    const list = tabs.tabs || [];
    const active = list.find((t) => t.active) || list[0] || {};
    const want = String(rest.url || '');
    let wantOrigin = '';
    try { wantOrigin = new URL(want).origin; } catch {}
    let gotOrigin = '';
    try { gotOrigin = new URL(active.url || '').origin; } catch {}
    if (active.url === want) {
      out.verified = true;
      out.effect = `at ${active.url}`;
    } else if (wantOrigin && wantOrigin === gotOrigin) {
      out.verified = true;
      out.effect = `at ${active.url} (redirected within ${wantOrigin})`;
    } else if (want && active.url && active.url.startsWith(want)) {
      out.verified = true;
      out.effect = `at ${active.url}`;
    } else {
      out.verified = false;
      out.ok = false;
      out.effect = `navigation failed: still at ${active.url || '(unknown)'}, wanted ${want}`;
      out.hint = 'the URL may be blocked, wrong, or the tab stalled: list tabs and retry once before concluding';
    }
  } catch (e) {
    out.verified = false;
    out.verify_note = 'effect check failed: ' + e.message;
  }
  return out;
}

export async function verifyResult(name, rest, result, call, partition, pre) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  try {
    if (name === 'browser_navigate') return await verifyNavigate(rest, result, call, partition);
    if (['browser_fill', 'browser_select_option', 'browser_set_combobox', 'browser_set_date'].includes(name)) {
      return await verifyInput(name, rest, result, call, partition);
    }
    if (name === 'browser_click') return await verifyClick(rest, result, call, partition, pre);
  } catch (e) {
    return { ...result, verified: false, verify_note: 'verification crashed: ' + e.message };
  }
  return result;
}
